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
  NoteEvent,
  Project,
  Track,
  TrackRole,
} from '@cts/project-model';
import type { ParsedMidi } from '@cts/midi-io';
import {
  beatsPerBar as beatsPerBarOf,
  drumBeatToStep,
  setLengthBars as setProjectLengthBars,
  setTimeSignature as setProjectTimeSignature,
} from '@cts/project-model';
import {
  analyzeChord,
  parseChord,
  realizeDegrees,
  generateBassLine,
  generateScaleMelody,
  getProgressionTemplate,
  realizeProgression,
  type BassMode,
  type GeneratedNote,
  type ChordEventInput,
  type HarmonicFunction,
} from '@cts/theory-engine';
import { getScalePitchClasses } from '@cts/theory-engine';
import { roleForTrackName } from '@cts/tutorial-engine';
import { useStore } from './store';
import { uid } from './ids';
import { publishAppEvent } from './appEvents';
import { quantizeStart } from '../features/pianoRoll/gridMath';

/** Bar index (0-based) for a beat offset under the project's time signature. */
function barOf(project: Project, startBeat: number): number {
  const bpb = projectBeatsPerBar(project);
  return bpb > 0 ? Math.floor(startBeat / bpb) : 0;
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
  return mapTracks(project, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)),
  }));
}

/** Find a clip across all tracks (read-only). */
export function findClip(project: Project, clipId: string | null): Clip | null {
  if (!clipId) return null;
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

/** Find a track by name (case-insensitive) — used to target Bass/Melody. */
export function findTrackByName(project: Project, name: string): Track | null {
  const lower = name.toLowerCase();
  return project.tracks.find((t) => t.name.toLowerCase() === lower) ?? null;
}

/** Find the first track with the given role (the stable identity; names are free text). */
export function findTrackByRole(project: Project, role: TrackRole): Track | null {
  return project.tracks.find((t) => t.role === role) ?? null;
}

/**
 * The first MIDI clip of a track, if any. A conventional name ('Bass', 'Melody', ...)
 * is resolved by role first, so renamed tracks are still found; other names match by name.
 */
export function firstMidiClipOfTrack(project: Project, name: string): Clip | null {
  const role = roleForTrackName(name);
  const track = (role ? findTrackByRole(project, role) : null) ?? findTrackByName(project, name);
  if (!track) return null;
  return track.clips.find((c) => c.type === 'midi') ?? track.clips[0] ?? null;
}

/** Beats per bar for the project's time signature. */
export function projectBeatsPerBar(project: Project): number {
  return beatsPerBarOf(project.timeSignature);
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
    const bpb = projectBeatsPerBar(project);
    const startBeat = last ? last.startBeat + last.durationBeats : 0;
    const event = buildChordEvent(project, symbol, startBeat, bpb);
    captured.push({ project, event });
    return { ...project, chordTrack: [...project.chordTrack, event] };
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
    const bpb = projectBeatsPerBar(project);
    const chords: ChordEvent[] = [];
    for (let bar = 0; bar < project.lengthBars; bar += 1) {
      const symbol = symbols[bar % symbols.length];
      if (symbol === undefined) continue;
      chords.push(buildChordEvent(project, symbol, bar * bpb, bpb));
    }
    captured.push({ project, chords });
    return { ...project, chordTrack: chords };
  });
  const first = captured[0];
  if (first) {
    for (const chord of first.chords) emitChordAdded(first.project, chord);
  }
}

/**
 * 指定の beat 位置からプログレッションテンプレートを挿入する。
 * 挿入範囲と重複する既存コードのみ置換し、それ以外の後続コードは保持する。
 * 各コードは1小節幅で配置する。
 */
export function insertProgressionAtBeat(templateId: string, startBeat: number): void {
  const captured: { project: Project; chords: ChordEvent[] }[] = [];
  useStore.getState().applyProjectChange((project) => {
    const symbols = realizeProgression(templateId, project.key, project.scale);
    if (symbols.length === 0) return project;
    const bpb = projectBeatsPerBar(project);
    const insertedChords: ChordEvent[] = symbols.map((symbol, i) =>
      buildChordEvent(project, symbol, startBeat + i * bpb, bpb),
    );
    const insertEnd = startBeat + symbols.length * bpb;
    // Keep chords that do not overlap with the inserted range.
    const kept = project.chordTrack.filter(
      (c) => c.startBeat + c.durationBeats <= startBeat || c.startBeat >= insertEnd,
    );
    const newTrack = [...kept, ...insertedChords].sort((a, b) => a.startBeat - b.startBeat);
    captured.push({ project, chords: insertedChords });
    return { ...project, chordTrack: newTrack };
  });
  const first = captured[0];
  if (first) {
    for (const chord of first.chords) emitChordAdded(first.project, chord);
  }
}

// ---------------------------------------------------------------------------
// Note edits (piano roll).
// ---------------------------------------------------------------------------

/** Quantize the start of the given notes (within a clip) to a grid snap. */
export function quantizeNotes(clipId: string, noteIds: readonly string[], snap: number): void {
  const ids = new Set(noteIds);
  useStore.getState().applyProjectChange((project) =>
    mapClip(project, clipId, (c) => ({
      ...c,
      notes: (c.notes ?? []).map((n) =>
        ids.has(n.id) ? { ...n, startBeat: quantizeStart(n.startBeat, snap) } : n,
      ),
    })),
  );
}

/**
 * Duplicate the given notes within a clip, offset by `offsetBeats`.
 * Returns the new note ids (so callers can re-select the duplicates).
 */
export function duplicateNotes(
  clipId: string,
  noteIds: readonly string[],
  offsetBeats: number,
): string[] {
  const ids = new Set(noteIds);
  const newIds: string[] = [];
  const dupesByCall: { project: Project; dupes: NoteEvent[] }[] = [];
  useStore.getState().applyProjectChange((project) =>
    mapClip(project, clipId, (c) => {
      const source = (c.notes ?? []).filter((n) => ids.has(n.id));
      const dupes: NoteEvent[] = source.map((n) => {
        const id = uid('note');
        newIds.push(id);
        return {
          id,
          pitch: n.pitch,
          startBeat: Math.max(0, n.startBeat + offsetBeats),
          durationBeats: n.durationBeats,
          velocity: n.velocity,
        };
      });
      dupesByCall.push({ project, dupes });
      return { ...c, notes: [...(c.notes ?? []), ...dupes] };
    }),
  );
  emitNotesAdded(clipId, dupesByCall[0]);
  return newIds;
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
  useStore.getState().applyProjectChange((project) =>
    mapClip(project, clipId, (c) => ({
      ...c,
      notes: (c.notes ?? []).map((n) => (ids.has(n.id) ? { ...n, velocity: v } : n)),
    })),
  );
}

/** Remove the given notes from a clip. */
export function removeNotes(clipId: string, noteIds: readonly string[]): void {
  const ids = new Set(noteIds);
  useStore.getState().applyProjectChange((project) =>
    mapClip(project, clipId, (c) => ({
      ...c,
      notes: (c.notes ?? []).filter((n) => !ids.has(n.id)),
    })),
  );
}

/** Replace ALL notes of a clip with the provided ones. */
export function replaceClipNotes(clipId: string, notes: NoteEvent[]): void {
  useStore.getState().applyProjectChange((project) =>
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
// MIDI import.
// ---------------------------------------------------------------------------

const MIDI_IMPORT_COLORS = ['#6f9bd8', '#5bb0a8', '#c75b86', '#d98a4b', '#8b75d7'];

export type MidiImportResult = {
  importedTrackCount: number;
  importedNoteCount: number;
  /** Beginner-facing notes (Japanese) from adopting the file's meter, if any. */
  warnings: string[];
};

/**
 * Add parsed SMF note tracks as new instrument tracks in the current project.
 * The file's tempo and meter are adopted: the meter goes through the shared
 * `setTimeSignature` so existing drum clips are regridded and sections are
 * converted by beat, and the song only ever grows (through `setLengthBars`) to
 * hold the imported notes. All of it is one undo step.
 */
export function importMidiTracks(parsed: ParsedMidi): MidiImportResult {
  const sourceTracks = parsed.tracks.filter((track) => track.notes.length > 0);
  if (sourceTracks.length === 0) {
    throw new Error('MIDIの中に読み込めるノートが見つかりませんでした。');
  }

  let firstTrackId: string | null = null;
  let firstClipId: string | null = null;
  let warnings: string[] = [];
  const importedNoteCount = sourceTracks.reduce((sum, track) => sum + track.notes.length, 0);

  useStore.getState().applyProjectChange((current) => {
    const sameMeter =
      current.timeSignature[0] === parsed.timeSignature[0] &&
      current.timeSignature[1] === parsed.timeSignature[1];
    const meterChange = sameMeter
      ? { project: current, warnings: [] }
      : setProjectTimeSignature(current, parsed.timeSignature);
    warnings = meterChange.warnings;

    const nextBeatsPerBar = Math.max(1, projectBeatsPerBar(meterChange.project));
    const importedEndBeat = sourceTracks.reduce((max, track) => {
      const trackEnd = track.notes.reduce(
        (noteMax, note) => Math.max(noteMax, note.startBeat + note.durationBeats),
        0,
      );
      return Math.max(max, trackEnd);
    }, 0);
    const importedBars = Math.max(1, Math.ceil(importedEndBeat / nextBeatsPerBar));
    const project =
      importedBars > meterChange.project.lengthBars
        ? setProjectLengthBars(meterChange.project, importedBars)
        : meterChange.project;

    const takenRoles = new Set(project.tracks.map((t) => t.role));
    const importedTracks: Track[] = sourceTracks.map((track, index) => {
      const trackId = uid('track');
      const clipId = uid('clip');
      if (firstTrackId === null) firstTrackId = trackId;
      if (firstClipId === null) firstClipId = clipId;

      const notes: NoteEvent[] = track.notes.map((note) => ({
        id: uid('note'),
        pitch: clampNumber(Math.round(note.pitch), 0, 127),
        startBeat: Math.max(0, note.startBeat),
        durationBeats: Math.max(1 / 64, note.durationBeats),
        velocity: clampNumber(Math.round(note.velocity), 1, 127),
      }));
      const trackEndBeat = notes.reduce(
        (max, note) => Math.max(max, note.startBeat + note.durationBeats),
        0,
      );
      const clip: Clip = {
        id: clipId,
        trackId,
        type: 'midi',
        startBeat: 0,
        lengthBeats: Math.max(nextBeatsPerBar, trackEndBeat),
        loop: false,
        notes,
      };
      const name = track.name?.trim() || `MIDI ${index + 1}`;
      const nameRole = roleForTrackName(name);
      const role = nameRole && !takenRoles.has(nameRole) ? nameRole : undefined;
      if (role) takenRoles.add(role);
      return {
        id: trackId,
        name,
        type: 'instrument',
        ...(role ? { role } : {}),
        color: MIDI_IMPORT_COLORS[index % MIDI_IMPORT_COLORS.length],
        clips: [clip],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'piano' },
        effects: [],
      };
    });

    const masterIndex = project.tracks.findIndex((track) => track.type === 'master');
    const tracks =
      masterIndex >= 0
        ? [
            ...project.tracks.slice(0, masterIndex),
            ...importedTracks,
            ...project.tracks.slice(masterIndex),
          ]
        : [...project.tracks, ...importedTracks];

    return {
      ...project,
      bpm: Math.round(parsed.bpm),
      tracks,
    };
  });

  const store = useStore.getState();
  store.selectTrack(firstTrackId);
  store.selectClip(firstClipId);
  store.selectNotes([]);
  store.setActiveView('pianoRoll');

  return {
    importedTrackCount: sourceTracks.length,
    importedNoteCount,
    warnings,
  };
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
 * replacing its notes. Returns the per-note reasons for UI display.
 */
export function generateBassIntoClip(clipId: string, mode: BassMode): GeneratedNote[] {
  const project = useStore.getState().project;
  const chords = chordTrackInputs(project);
  const generated = generateBassLine(chords, {
    mode,
    key: project.key,
    scale: project.scale,
    beatsPerBar: projectBeatsPerBar(project),
  });
  const events = generatedToNoteEvents(generated);
  replaceClipNotes(clipId, events);
  emitNotesAdded(clipId, { project: useStore.getState().project, dupes: events });
  return generated;
}

/**
 * Generate a scale melody from the chord track and write it into the given
 * clip, replacing its notes. The seed makes repeat clicks vary deterministically
 * when the caller passes an incrementing seed. Returns the generated notes.
 */
export function generateMelodyIntoClip(clipId: string, seed: number): GeneratedNote[] {
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
  replaceClipNotes(clipId, events);
  emitNotesAdded(clipId, { project: useStore.getState().project, dupes: events });
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
  /**
   * lane -> beat offsets within one bar that are ON (0 = 1st beat, 0.5 = its
   * off-beat). Written for a 4-beat bar; in a shorter bar (3/4) the hits past
   * the bar end are dropped.
   */
  beats: Partial<Record<DrumLane, number[]>>;
};

/**
 * One-bar drum pattern presets. Original beginner-friendly patterns;
 * not copied from any product's factory content.
 */
export const DRUM_PATTERNS: DrumPattern[] = [
  {
    id: 'fourOnFloor',
    name: 'Four on the floor',
    beats: {
      kick: [0, 1, 2, 3],
      closedHat: [0.5, 1.5, 2.5, 3.5],
      clap: [1, 3],
    },
  },
  {
    id: 'eightBeat',
    name: '8ビート',
    beats: {
      kick: [0, 2],
      snare: [1, 3],
      closedHat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    },
  },
  {
    id: 'hiphop',
    name: 'ヒップホップ',
    beats: {
      kick: [0, 1.5, 2.5],
      snare: [1, 3],
      closedHat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
      openHat: [3.5],
    },
  },
  {
    id: 'gameLoop',
    name: 'ゲームループ',
    beats: {
      kick: [0, 2],
      snare: [1, 3],
      closedHat: [0, 0.75, 1.5, 2.25, 3, 3.75],
      perc: [0.5, 2.5],
    },
  },
  {
    id: 'lofi',
    name: 'ローファイ',
    beats: {
      kick: [0, 2.5],
      snare: [1, 3],
      closedHat: [0, 1, 2, 3],
      perc: [1.75],
    },
  },
];

/**
 * Apply a drum pattern to a drum clip, replacing its events. The pattern's
 * one-bar beat map is converted to the clip's step grid with `drumBeatToStep`
 * (the same rounding the lesson checker uses, so a grid that does not divide
 * the bar evenly still satisfies the lesson) and tiled across every bar the
 * clip spans; in a partial last bar only the hits before the clip end are
 * written.
 */
export function applyDrumPattern(clipId: string, patternId: DrumPatternId): void {
  const pattern = DRUM_PATTERNS.find((p) => p.id === patternId);
  if (!pattern) return;
  useStore.getState().applyProjectChange((project) => {
    const bpb = projectBeatsPerBar(project);
    return mapClip(project, clipId, (clip) => {
      const stepsPerBar = clip.stepsPerBar ?? 16;
      const bars = Math.max(1, Math.ceil(clip.lengthBeats / bpb - 1e-9));
      const events: DrumEvent[] = [];
      for (let bar = 0; bar < bars; bar += 1) {
        const barOffset = bar * stepsPerBar;
        for (const [lane, beats] of Object.entries(pattern.beats)) {
          for (const beat of beats ?? []) {
            if (beat >= bpb || bar * bpb + beat >= clip.lengthBeats) continue;
            events.push({
              id: uid('drum'),
              lane: lane as DrumLane,
              stepIndex: barOffset + drumBeatToStep(beat, stepsPerBar, bpb),
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
): void {
  useStore.getState().applyProjectChange((project) =>
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
}
