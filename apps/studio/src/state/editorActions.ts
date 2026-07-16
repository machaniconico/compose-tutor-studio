// Composite project mutations used by the wave-2 editor UIs.
//
// These build on the store's `applyProjectChange(fn)` escape hatch and the
// theory-engine so that complex, multi-field edits (quantize, duplicate,
// chord analysis, generation, template application) live in one tested place
// rather than inside React components.
//
// IMPORTANT: every chord we add/replace stores the FULL analysis fields
// (root / quality / notes / degree / function) so the inspector and other
// theory features always have data to work with — the wave-1 default project
// may have chords lacking degree/function, but anything WE write is complete.

import type {
  ChordEvent,
  Clip,
  DrumEvent,
  DrumLane,
  EffectConfig,
  NoteEvent,
  Project,
  Track,
} from '@cts/project-model';
import {
  MAX_EVENTS_PER_CLIP,
  MAX_PROJECT_LENGTH_BARS,
  MAX_PROJECT_TIMELINE_BEATS,
  MIN_EVENT_DURATION_BEATS,
  barToBeatAt,
  beatToBarPosition,
  beatsPerBar as beatsPerBarOf,
  clipContentOwnerId,
  compileDrumStepProjector,
  compileMusicalTime,
  findLearningTrack,
  normalizeLearningTrackName,
  projectDrumStep,
  resolveClipContent,
  timeSignatureAtBeat,
} from '@cts/project-model';
import {
  analyzeChord,
  parseChord,
  realizeDegrees,
  generateBassLine,
  generateScaleMelody,
  getProgressionTemplate,
  type BassMode,
  type GeneratedNote,
  type ChordEventInput,
  type HarmonicFunction,
} from '@cts/theory-engine';
import { getScalePitchClasses } from '@cts/theory-engine';
import { useStore } from './store';
import { uid } from './ids';
import { publishAppEvent } from './appEvents';
import {
  quantizeStart,
  snapPitchToPitchClasses,
} from '../features/pianoRoll/gridMath';
import {
  createDefaultEffectConfig,
  isInsertEffectType,
  normalizeEffectConfig,
  type InsertEffectType,
} from '../audio/effects';

/** Bar index (0-based) for a beat offset under the project's time signature. */
function barOf(project: Project, startBeat: number): number {
  return beatToBarPosition(compileMusicalTime(project), startBeat).bar;
}

/** Whether a MIDI pitch belongs to the project's key/scale. */
function pitchInScale(project: Project, pitch: number): boolean {
  try {
    const pcs = getScalePitchClasses(project.key, project.scale);
    const pc = ((pitch % 12) + 12) % 12;
    return pcs.includes(pc);
  } catch {
    return false;
  }
}

/** Publish a chord.added app event for a freshly written chord. */
function emitChordAdded(project: Project, event: ChordEvent): void {
  publishAppEvent({
    type: 'chord.added',
    payload: {
      bar: barOf(project, event.startBeat),
      chordSymbol: event.symbol,
      ...(event.degree !== undefined ? { degree: event.degree } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Small immutable helpers (mirrors store's private mapTracks).
// ---------------------------------------------------------------------------

function mapTracks(project: Project, fn: (t: Track) => Track): Project {
  return { ...project, tracks: project.tracks.map(fn) };
}

function mapClip(project: Project, clipId: string, fn: (c: Clip) => Clip): Project {
  const ownerId = clipContentOwnerId(project, clipId);
  if (!ownerId) return project;
  return mapTracks(project, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === ownerId ? fn(c) : c)),
  }));
}

// ---------------------------------------------------------------------------
// Track insert effects.
// ---------------------------------------------------------------------------

/** Add a filter/delay/reverb insert effect to a non-master track. */
export function addTrackEffect(trackId: string, type: InsertEffectType): string | null {
  if (!isInsertEffectType(type)) return null;
  const target = useStore.getState().project.tracks.find(
    (track) => track.id === trackId && track.type !== 'master',
  );
  if (!target) return null;
  const id = uid('fx');
  const effect = createDefaultEffectConfig(type, id);
  const committed = useStore.getState().applyProjectChange((project) =>
    mapTracks(project, (track) => {
      if (track.id !== trackId || track.type === 'master') return track;
      return { ...track, effects: [...track.effects, effect] };
    }),
  );
  if (!committed) return null;
  const adoptedTrack = useStore.getState().project.tracks.find(
    (track) => track.id === trackId && track.effects.some((candidate) => candidate.id === id),
  );
  if (!adoptedTrack) return null;
  publishAppEvent({
    type: 'effect.added',
    payload: { trackId, trackName: adoptedTrack.name, effectType: type },
  });
  return id;
}

/** Remove one insert effect from a track. */
export function removeTrackEffect(trackId: string, effectId: string): void {
  useStore.getState().applyProjectChange((project) =>
    mapTracks(project, (track) =>
      track.id === trackId
        ? { ...track, effects: track.effects.filter((effect) => effect.id !== effectId) }
        : track,
    ),
  );
}

/** Update one numeric effect parameter, clamping it into the safe normalized range. */
export function updateTrackEffectParam(
  trackId: string,
  effectId: string,
  param: string,
  value: number,
): void {
  useStore.getState().applyProjectChange((project) =>
    mapTracks(project, (track) => {
      if (track.id !== trackId) return track;
      const effects: EffectConfig[] = track.effects.map((effect) =>
        effect.id === effectId
          ? normalizeEffectConfig({
              ...effect,
              params: { ...effect.params, [param]: value },
            })
          : effect,
      );
      return { ...track, effects };
    }),
  );
}

/** Find a clip across all tracks (read-only). */
export function findClip(project: Project, clipId: string | null): Clip | null {
  if (!clipId) return null;
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return resolveClipContent(project, clip);
  }
  return null;
}

/** Resolve a public learning-name alias to its persisted schema-v3 role owner. */
export function findTrackByName(project: Project, name: string): Track | null {
  const role = normalizeLearningTrackName(name);
  return role ? (findLearningTrack(project, role) ?? null) : null;
}

/** The first MIDI clip of a named track, if any. */
export function firstMidiClipOfTrack(project: Project, name: string): Clip | null {
  const track = findTrackByName(project, name);
  if (!track) return null;
  const instance = track.clips.find((c) => c.type === 'midi') ?? track.clips[0];
  return instance ? resolveClipContent(project, instance) : null;
}

/** Beats per bar for the project's time signature. */
export function projectBeatsPerBar(project: Project): number {
  return projectBeatsPerBarAt(project, 0);
}

/** Beats in the bar whose signature is active at an absolute beat. */
export function projectBeatsPerBarAt(project: Project, beat: number): number {
  const musicalTime = compileMusicalTime(project);
  return beatsPerBarOf(timeSignatureAtBeat(musicalTime, beat));
}

// ---------------------------------------------------------------------------
// Chord analysis → full ChordEvent fields.
// ---------------------------------------------------------------------------

/**
 * Build a complete ChordEvent (all theory fields filled) from a symbol.
 * Uses parseChord for reliable pitch-classes and analyzeChord for the
 * key-relative degree/function. Falls back gracefully on unknown symbols.
 */
export function buildChordEvent(
  project: Project,
  symbol: string,
  startBeat: number,
  durationBeats: number,
  id?: string,
): ChordEvent {
  const trimmed = symbol.trim();
  let root = trimmed;
  let quality = 'major';
  let notes: number[] = [];
  try {
    const parsed = parseChord(trimmed, project.key);
    root = parsed.root;
    quality = parsed.quality;
    notes = [...parsed.pitchClasses];
  } catch {
    // keep fallbacks; analyzeChord below may still add a degree/function
  }

  let degree: string | undefined;
  let fn: HarmonicFunction | undefined;
  let tags: string[] | undefined;
  try {
    const analysis = analyzeChord({ symbol: trimmed, key: project.key, scale: project.scale });
    if (analysis.degree) degree = analysis.degree;
    if (analysis.function) fn = analysis.function;
    if (analysis.tags && analysis.tags.length > 0) tags = analysis.tags;
  } catch {
    // analysis is best-effort
  }

  const event: ChordEvent = {
    id: id ?? uid('chord'),
    startBeat,
    durationBeats,
    symbol: trimmed,
    root,
    quality,
    notes,
  };
  if (degree !== undefined) event.degree = degree;
  if (fn !== undefined) event.function = fn;
  if (tags !== undefined) event.tags = tags;
  return event;
}

/** Add a chord with full analysis fields at the given position. */
export function addChordWithAnalysis(
  symbol: string,
  startBeat: number,
  durationBeats: number,
): void {
  const captured: { project: Project; event: ChordEvent }[] = [];
  useStore.getState().applyProjectChange((project) => {
    const event = buildChordEvent(project, symbol, startBeat, durationBeats);
    captured.push({ project, event });
    return { ...project, chordTrack: [...project.chordTrack, event] };
  });
  const first = captured[0];
  if (first) emitChordAdded(first.project, first.event);
}

/** Update a chord's symbol and re-derive its full analysis fields. */
export function updateChordSymbol(chordId: string, symbol: string): void {
  const captured: { project: Project; event: ChordEvent; previous: string }[] = [];
  useStore.getState().applyProjectChange((project) => {
    const existing = project.chordTrack.find((c) => c.id === chordId);
    if (!existing) return project;
    const rebuilt = buildChordEvent(
      project,
      symbol,
      existing.startBeat,
      existing.durationBeats,
      existing.id,
    );
    captured.push({ project, event: rebuilt, previous: existing.symbol });
    return {
      ...project,
      chordTrack: project.chordTrack.map((c) => (c.id === chordId ? rebuilt : c)),
    };
  });
  const first = captured[0];
  if (first) {
    publishAppEvent({
      type: 'chord.changed',
      payload: {
        bar: barOf(first.project, first.event.startBeat),
        chordSymbol: first.event.symbol,
        previousSymbol: first.previous,
      },
    });
  }
}

/** Append a chord right after the last chord event (used by suggestions). */
export function appendChordAfterLast(symbol: string): void {
  const captured: { project: Project; event: ChordEvent }[] = [];
  useStore.getState().applyProjectChange((project) => {
    const sorted = [...project.chordTrack].sort((a, b) => a.startBeat - b.startBeat);
    const last = sorted[sorted.length - 1];
    const startBeat = last ? last.startBeat + last.durationBeats : 0;
    const musicalTime = compileMusicalTime(project);
    const startBar = beatToBarPosition(musicalTime, startBeat).bar;
    const requiredLengthBars = startBar + 1;
    if (requiredLengthBars > MAX_PROJECT_LENGTH_BARS) return project;
    const chordEndBeat = barToBeatAt(musicalTime, requiredLengthBars);
    if (chordEndBeat > MAX_PROJECT_TIMELINE_BEATS) return project;
    const event = buildChordEvent(project, symbol, startBeat, chordEndBeat - startBeat);
    captured.push({ project, event });
    return {
      ...project,
      lengthBars: Math.max(project.lengthBars, requiredLengthBars),
      lengthBeats: Math.max(project.lengthBeats, chordEndBeat),
      chordTrack: [...project.chordTrack, event],
    };
  });
  const first = captured[0];
  if (first) emitChordAdded(first.project, first.event);
}

/** Replace the entire chord track with a fresh set of chords. */
export function replaceChordTrack(chords: ChordEvent[]): void {
  useStore.getState().applyProjectChange((project) => ({ ...project, chordTrack: chords }));
}

/**
 * Apply a progression template across the project's bars, replacing the
 * whole chord track. Each chord spans one bar; the degree pattern repeats to
 * fill `lengthBars`.
 */
export function applyProgressionTemplate(templateId: string): void {
  const captured: { project: Project; chords: ChordEvent[] }[] = [];
  useStore.getState().applyProjectChange((project) => {
    const template = getProgressionTemplate(templateId);
    if (!template) return project;
    const symbols = realizeDegrees(template.degrees, project.key, project.scale);
    if (symbols.length === 0) return project;
    const musicalTime = compileMusicalTime(project);
    const chords: ChordEvent[] = [];
    for (let bar = 0; bar < project.lengthBars; bar += 1) {
      const symbol = symbols[bar % symbols.length];
      if (symbol === undefined) continue;
      const startBeat = barToBeatAt(musicalTime, bar);
      const endBeat = barToBeatAt(musicalTime, bar + 1);
      chords.push(buildChordEvent(project, symbol, startBeat, endBeat - startBeat));
    }
    captured.push({ project, chords });
    return { ...project, chordTrack: chords };
  });
  const first = captured[0];
  if (first) {
    for (const chord of first.chords) emitChordAdded(first.project, chord);
  }
}

// ---------------------------------------------------------------------------
// Note edits (piano roll).
// ---------------------------------------------------------------------------

export type NoteUpdatePatch = Readonly<
  Partial<Pick<NoteEvent, 'pitch' | 'startBeat' | 'durationBeats' | 'velocity'>>
>;

export type NoteUpdate = Readonly<{
  id: string;
  patch: NoteUpdatePatch;
}>;

export type NoteDuplicatePlacement = Readonly<{
  sourceId: string;
  startBeat: number;
  pitch: number;
}>;

function noteValuesEqual(left: NoteEvent, right: NoteEvent): boolean {
  return (
    left.pitch === right.pitch &&
    left.startBeat === right.startBeat &&
    left.durationBeats === right.durationBeats &&
    left.velocity === right.velocity
  );
}

function isValidNoteForClip(note: NoteEvent, clip: Clip): boolean {
  return (
    clip.type === 'midi' &&
    Number.isInteger(note.pitch) &&
    note.pitch >= 0 &&
    note.pitch <= 127 &&
    Number.isFinite(note.startBeat) &&
    note.startBeat >= 0 &&
    Number.isFinite(note.durationBeats) &&
    note.durationBeats >= MIN_EVENT_DURATION_BEATS &&
    note.durationBeats <= MAX_PROJECT_TIMELINE_BEATS &&
    note.startBeat + note.durationBeats <= clip.lengthBeats &&
    Number.isInteger(note.velocity) &&
    note.velocity >= 1 &&
    note.velocity <= 127
  );
}

/**
 * Commit the final values from one piano-roll gesture as one transaction.
 *
 * Duplicate ids, missing notes, or any invalid candidate reject the whole
 * batch. No-op entries are ignored; if every entry is a no-op there is no
 * history/revision/save write. Returns only notes that were actually changed.
 */
export function commitNoteUpdates(
  clipId: string,
  updates: readonly NoteUpdate[],
): NoteEvent[] {
  if (updates.length === 0) return [];

  const state = useStore.getState();
  const track = state.project.tracks.find((candidate) =>
    candidate.clips.some((clip) => clip.id === clipId),
  );
  const clip = findClip(state.project, clipId);
  if (!track || !clip || clip.type !== 'midi') return [];

  const currentById = new Map((clip.notes ?? []).map((note) => [note.id, note]));
  const seen = new Set<string>();
  const changed: Array<{ before: NoteEvent; after: NoteEvent }> = [];

  for (const update of updates) {
    if (seen.has(update.id)) return [];
    seen.add(update.id);

    const current = currentById.get(update.id);
    if (!current) return [];
    const candidate: NoteEvent = {
      id: current.id,
      pitch: update.patch.pitch ?? current.pitch,
      startBeat: update.patch.startBeat ?? current.startBeat,
      durationBeats: update.patch.durationBeats ?? current.durationBeats,
      velocity: update.patch.velocity ?? current.velocity,
    };
    if (!isValidNoteForClip(candidate, clip)) return [];
    if (!noteValuesEqual(current, candidate)) {
      changed.push({ before: current, after: candidate });
    }
  }

  if (changed.length === 0) return [];
  const changedById = new Map(changed.map(({ after }) => [after.id, after]));
  const committed = state.applyProjectChange((project) =>
    mapClip(project, clipId, (candidate) => ({
      ...candidate,
      notes: (candidate.notes ?? []).map((note) => changedById.get(note.id) ?? note),
    })),
  );
  if (!committed) return [];

  const committedProject = useStore.getState().project;
  const committedClip = findClip(committedProject, clipId);
  const committedById = new Map((committedClip?.notes ?? []).map((note) => [note.id, note]));
  const committedNotes = changed
    .map(({ after }) => committedById.get(after.id))
    .filter((note): note is NoteEvent => note !== undefined);

  for (const { before, after } of changed) {
    if (before.pitch === after.pitch && before.startBeat === after.startBeat) continue;
    const committedNote = committedById.get(after.id);
    if (!committedNote) continue;
    publishAppEvent({
      type: 'note.moved',
      payload: {
        pitch: committedNote.pitch,
        startBeat: committedNote.startBeat,
        trackId: track.id,
        trackName: track.name,
      },
    });
  }
  return committedNotes;
}

/**
 * Duplicate notes at their final gesture positions in one transaction.
 * IDs are allocated only after every source and placement has been validated.
 */
export function duplicateNotesAt(
  clipId: string,
  placements: readonly NoteDuplicatePlacement[],
): NoteEvent[] {
  if (placements.length === 0) return [];

  const state = useStore.getState();
  const clip = findClip(state.project, clipId);
  if (!clip || clip.type !== 'midi') return [];
  if ((clip.notes?.length ?? 0) + placements.length > MAX_EVENTS_PER_CLIP) return [];

  const sourceById = new Map((clip.notes ?? []).map((note) => [note.id, note]));
  const seen = new Set<string>();
  const validated: Array<Omit<NoteEvent, 'id'>> = [];
  for (const placement of placements) {
    if (seen.has(placement.sourceId)) return [];
    seen.add(placement.sourceId);

    const source = sourceById.get(placement.sourceId);
    if (!source) return [];
    const candidate: NoteEvent = {
      id: source.id,
      pitch: placement.pitch,
      startBeat: placement.startBeat,
      durationBeats: source.durationBeats,
      velocity: source.velocity,
    };
    if (!isValidNoteForClip(candidate, clip)) return [];
    validated.push({
      pitch: candidate.pitch,
      startBeat: candidate.startBeat,
      durationBeats: candidate.durationBeats,
      velocity: candidate.velocity,
    });
  }

  const duplicates: NoteEvent[] = validated.map((note) => ({ ...note, id: uid('note') }));
  const committed = state.applyProjectChange((project) =>
    mapClip(project, clipId, (candidate) => ({
      ...candidate,
      notes: [...(candidate.notes ?? []), ...duplicates],
    })),
  );
  if (!committed) return [];

  const committedProject = useStore.getState().project;
  const committedClip = findClip(committedProject, clipId);
  const committedById = new Map((committedClip?.notes ?? []).map((note) => [note.id, note]));
  const committedDuplicates = duplicates
    .map((note) => committedById.get(note.id))
    .filter((note): note is NoteEvent => note !== undefined);
  emitNotesAdded(clipId, { project: committedProject, dupes: committedDuplicates });
  return committedDuplicates;
}

/** Quantize the start of the given notes (within a clip) to a grid snap. */
export function quantizeNotes(
  clipId: string,
  noteIds: readonly string[],
  snap: number,
): NoteEvent[] {
  const ids = new Set(noteIds);
  const state = useStore.getState();
  const clip = findClip(state.project, clipId);
  if (!clip || clip.type !== 'midi') return [];
  const quantizedStart = (note: NoteEvent): number => {
    const maximumStart = Math.max(0, clip.lengthBeats - note.durationBeats);
    const nearest = quantizeStart(note.startBeat, snap);
    if (nearest <= maximumStart || snap <= 0) return Math.min(nearest, maximumStart);
    // The nearest grid line can lie beyond the clip for a long final note.
    // Prefer the latest valid grid line to rejecting the user's whole batch.
    const latestGrid = Math.floor((maximumStart + snap * 1e-9) / snap) * snap;
    return Math.max(0, Math.min(maximumStart, latestGrid));
  };
  return commitNoteUpdates(
    clipId,
    (clip.notes ?? [])
      .filter((note) => ids.has(note.id))
      .map((note) => ({
        id: note.id,
        patch: { startBeat: quantizedStart(note) },
      })),
  );
}

/**
 * Duplicate the given notes within a clip, offset by `offsetBeats`.
 * Returns only the committed copies so callers can select and drag their
 * final pitch/position. Rejected candidates return an empty array.
 */
export function duplicateNotes(
  clipId: string,
  noteIds: readonly string[],
  offsetBeats: number,
): NoteEvent[] {
  const ids = new Set(noteIds);
  const state = useStore.getState();
  const sourceClip = findClip(state.project, clipId);
  const source = (sourceClip?.notes ?? []).filter((note) => ids.has(note.id));
  if (source.length === 0) return [];

  let scalePcs: ReadonlySet<number> = new Set();
  if (state.editor.scaleSnap) {
    try {
      scalePcs = new Set(getScalePitchClasses(state.project.key, state.project.scale));
    } catch {
      scalePcs = new Set();
    }
  }
  const placements: NoteDuplicatePlacement[] = source.map((note) => ({
    sourceId: note.id,
    pitch: state.editor.scaleSnap
      ? snapPitchToPitchClasses(note.pitch, scalePcs)
      : note.pitch,
    startBeat: Math.max(0, note.startBeat + offsetBeats),
  }));
  return duplicateNotesAt(clipId, placements);
}

/** Emit a note.added event per note for a clip-targeted batch write. */
function emitNotesAdded(
  clipId: string,
  batch: { project: Project; dupes: NoteEvent[] } | undefined,
): void {
  if (!batch) return;
  const track = batch.project.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  for (const note of batch.dupes) {
    publishAppEvent({
      type: 'note.added',
      payload: {
        pitch: note.pitch,
        startBeat: note.startBeat,
        durationBeats: note.durationBeats,
        trackId: track?.id ?? '',
        trackName: track?.name ?? '',
        inScale: pitchInScale(batch.project, note.pitch),
      },
    });
  }
}

/** Set the velocity of the given notes within a clip (clamped 1..127). */
export function setNoteVelocity(
  clipId: string,
  noteIds: readonly string[],
  velocity: number,
): void {
  const v = Math.max(1, Math.min(127, Math.round(velocity)));
  const ids = new Set(noteIds);
  const state = useStore.getState();
  const clip = findClip(state.project, clipId);
  const changedIds = new Set(
    (clip?.notes ?? [])
      .filter((note) => ids.has(note.id) && note.velocity !== v)
      .map((note) => note.id),
  );
  if (changedIds.size === 0) return;
  state.applyProjectChange((project) =>
    mapClip(project, clipId, (c) => ({
      ...c,
      notes: (c.notes ?? []).map((n) =>
        changedIds.has(n.id) ? { ...n, velocity: v } : n,
      ),
    })),
  );
}

/** Remove the given notes from a clip. */
export function removeNotes(clipId: string, noteIds: readonly string[]): void {
  const ids = new Set(noteIds);
  const state = useStore.getState();
  const clip = findClip(state.project, clipId);
  if (!(clip?.notes ?? []).some((note) => ids.has(note.id))) return;
  state.applyProjectChange((project) =>
    mapClip(project, clipId, (c) => ({
      ...c,
      notes: (c.notes ?? []).filter((n) => !ids.has(n.id)),
    })),
  );
}

/** Replace ALL notes of a clip. False means the candidate was not adopted. */
export function replaceClipNotes(clipId: string, notes: NoteEvent[]): boolean {
  const state = useStore.getState();
  const clip = findClip(state.project, clipId);
  if (!clip || clip.type !== 'midi') return false;
  return state.applyProjectChange((project) =>
    mapClip(project, clipId, (c) => ({ ...c, notes })),
  );
}

/** Convert theory-engine GeneratedNotes into NoteEvents (fresh ids). */
export function generatedToNoteEvents(generated: readonly GeneratedNote[]): NoteEvent[] {
  return generated.map((g) => ({
    id: uid('note'),
    pitch: g.pitch,
    startBeat: g.startBeat,
    durationBeats: g.durationBeats,
    velocity: g.velocity,
  }));
}

// ---------------------------------------------------------------------------
// Generation (bass / melody) — writes into a target clip.
// ---------------------------------------------------------------------------

/** Map the chord track into the theory-engine ChordEventInput shape. */
export function chordTrackInputs(project: Project): ChordEventInput[] {
  return [...project.chordTrack]
    .sort((a, b) => a.startBeat - b.startBeat)
    .map((c) => ({ symbol: c.symbol, startBeat: c.startBeat, durationBeats: c.durationBeats }));
}

/**
 * Generate a bass line from the chord track and write it into the given clip,
 * replacing its notes. Returns the per-note reasons only after a committed
 * write; null means the candidate was rejected.
 */
export function generateBassIntoClip(
  clipId: string,
  mode: BassMode,
): GeneratedNote[] | null {
  const project = useStore.getState().project;
  const chords = chordTrackInputs(project);
  const generated = generateBassLine(chords, {
    mode,
    key: project.key,
    scale: project.scale,
    beatsPerBar: projectBeatsPerBar(project),
  });
  const events = generatedToNoteEvents(generated);
  if (!replaceClipNotes(clipId, events)) return null;
  const committedProject = useStore.getState().project;
  const committedClip = findClip(committedProject, clipId);
  const committedById = new Map((committedClip?.notes ?? []).map((note) => [note.id, note]));
  const committedEvents = events
    .map((note) => committedById.get(note.id))
    .filter((note): note is NoteEvent => note !== undefined);
  emitNotesAdded(clipId, { project: committedProject, dupes: committedEvents });
  return generated;
}

/**
 * Generate a scale melody from the chord track and write it into the given
 * clip, replacing its notes. The seed makes repeat clicks vary deterministically
 * when the caller passes an incrementing seed. Returns the generated notes
 * only after a committed write; null means the candidate was rejected.
 */
export function generateMelodyIntoClip(
  clipId: string,
  seed: number,
): GeneratedNote[] | null {
  const project = useStore.getState().project;
  const chords = chordTrackInputs(project);
  const generated = generateScaleMelody({
    key: project.key,
    scale: project.scale,
    chords,
    seed,
    beatsPerBar: projectBeatsPerBar(project),
  });
  const events = generatedToNoteEvents(generated);
  if (!replaceClipNotes(clipId, events)) return null;
  const committedProject = useStore.getState().project;
  const committedClip = findClip(committedProject, clipId);
  const committedById = new Map((committedClip?.notes ?? []).map((note) => [note.id, note]));
  const committedEvents = events
    .map((note) => committedById.get(note.id))
    .filter((note): note is NoteEvent => note !== undefined);
  emitNotesAdded(clipId, { project: committedProject, dupes: committedEvents });
  return generated;
}

// ---------------------------------------------------------------------------
// Drums — pattern templates.
// ---------------------------------------------------------------------------

export type DrumPatternId =
  | 'fourOnFloor'
  | 'eightBeat'
  | 'hiphop'
  | 'gameLoop'
  | 'lofi';

export type DrumPattern = {
  id: DrumPatternId;
  name: string;
  /** lane -> step indices that are ON (within one bar of stepsPerBar steps). */
  steps: Partial<Record<DrumLane, number[]>>;
};

/**
 * One-bar (16-step) drum pattern presets. Original beginner-friendly patterns;
 * not copied from any product's factory content.
 */
export const DRUM_PATTERNS: DrumPattern[] = [
  {
    id: 'fourOnFloor',
    name: 'Four on the floor',
    steps: {
      kick: [0, 4, 8, 12],
      closedHat: [2, 6, 10, 14],
      clap: [4, 12],
    },
  },
  {
    id: 'eightBeat',
    name: '8ビート',
    steps: {
      kick: [0, 8],
      snare: [4, 12],
      closedHat: [0, 2, 4, 6, 8, 10, 12, 14],
    },
  },
  {
    id: 'hiphop',
    name: 'ヒップホップ',
    steps: {
      kick: [0, 6, 10],
      snare: [4, 12],
      closedHat: [0, 2, 4, 6, 8, 10, 12, 14],
      openHat: [14],
    },
  },
  {
    id: 'gameLoop',
    name: 'ゲームループ',
    steps: {
      kick: [0, 8],
      snare: [4, 12],
      closedHat: [0, 3, 6, 9, 12, 15],
      perc: [2, 10],
    },
  },
  {
    id: 'lofi',
    name: 'ローファイ',
    steps: {
      kick: [0, 10],
      snare: [4, 12],
      closedHat: [0, 4, 8, 12],
      perc: [7],
    },
  },
];

/**
 * Apply a drum pattern to a drum clip, replacing its events. The pattern's
 * one-bar step map is tiled across every bar the clip spans.
 */
export function applyDrumPattern(clipId: string, patternId: DrumPatternId): boolean {
  const pattern = DRUM_PATTERNS.find((p) => p.id === patternId);
  if (!pattern) return false;
  const state = useStore.getState();
  const clip = findClip(state.project, clipId);
  if (!clip || clip.type !== 'drum') return false;
  return state.applyProjectChange((project) => {
    const musicalTime = compileMusicalTime(project);
    return mapClip(project, clipId, (clip) => {
      const stepsPerBar = clip.stepsPerBar ?? 16;
      const drumProjector = compileDrumStepProjector(
        stepsPerBar,
        clip.startBeat,
        musicalTime,
      );
      const clipEndBeat = clip.startBeat + clip.lengthBeats;
      const events: DrumEvent[] = [];
      for (let bar = 0; ; bar += 1) {
        const barOffset = bar * stepsPerBar;
        if (!Number.isSafeInteger(barOffset)) break;
        const barStart = projectDrumStep(drumProjector, barOffset).beat;
        if (!Number.isFinite(barStart) || barStart >= clipEndBeat) break;
        for (const [lane, indices] of Object.entries(pattern.steps)) {
          for (const idx of indices ?? []) {
            const stepIndex = barOffset + idx;
            const beat = projectDrumStep(drumProjector, stepIndex).beat;
            if (!Number.isFinite(beat) || beat >= clipEndBeat) continue;
            events.push({
              id: uid('drum'),
              lane: lane as DrumLane,
              stepIndex,
              velocity: 100,
            });
          }
        }
      }
      return { ...clip, drumEvents: events };
    });
  });
}

/**
 * Set a drum step to an explicit velocity (or remove it when velocity <= 0).
 * Used by the 3-level velocity cycling in the drum grid.
 */
export function setDrumStepVelocity(
  clipId: string,
  lane: DrumLane,
  stepIndex: number,
  velocity: number,
): boolean {
  const state = useStore.getState();
  const clip = findClip(state.project, clipId);
  if (!clip || clip.type !== 'drum') return false;
  const existing = (clip.drumEvents ?? []).find(
    (event) => event.lane === lane && event.stepIndex === stepIndex,
  );
  if ((velocity <= 0 && !existing) || (existing && velocity === existing.velocity)) {
    return false;
  }
  const track = state.project.tracks.find((candidate) =>
    candidate.clips.some((candidateClip) => candidateClip.id === clipId),
  );
  if (!track) return false;
  const committed = state.applyProjectChange((project) =>
    mapClip(project, clipId, (clip) => {
      const events = clip.drumEvents ?? [];
      const existing = events.find((e) => e.lane === lane && e.stepIndex === stepIndex);
      if (velocity <= 0) {
        return { ...clip, drumEvents: events.filter((e) => e !== existing) };
      }
      if (existing) {
        return {
          ...clip,
          drumEvents: events.map((e) => (e === existing ? { ...e, velocity } : e)),
        };
      }
      const created: DrumEvent = { id: uid('drum'), lane, stepIndex, velocity };
      return { ...clip, drumEvents: [...events, created] };
    }),
  );
  if (!committed) return false;
  publishAppEvent({
    type: 'drum.stepToggled',
    payload: { lane, stepIndex, active: velocity > 0, trackId: track.id },
  });
  return true;
}
