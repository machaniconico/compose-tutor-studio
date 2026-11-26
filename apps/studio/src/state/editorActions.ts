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
  CLIP_EDGE_TOLERANCE_BEATS,
  clipFirstPassEnd,
  drumBeatToStep,
  resolveEditTarget,
  resolveLinkSource,
  setLengthBars as setProjectLengthBars,
  setTimeSignature as setProjectTimeSignature,
  startsBeforeClipEnd,
} from '@cts/project-model';
import {
  analyzeChord,
  parseChord,
  realizeDegrees,
  generateBassLine,
  generateScaleMelody,
  getProgressionTemplate,
  realizeProgression,
  voiceChord,
  voiceLead,
  type VoicingStyle,
  type BassMode,
  type GeneratedNote,
  type ChordEventInput,
  type HarmonicFunction,
} from '@cts/theory-engine';
import { getScalePitchClasses } from '@cts/theory-engine';
import { roleForTrackName } from '@cts/tutorial-engine';
import { fitClipToNotes, useStore, type NoteEditOptions } from './store';
import { uid } from './ids';
import { publishAppEvent } from './appEvents';
import { quantizeStart } from '../features/pianoRoll/gridMath';
import { upsertEffect, type SupportedEffectType } from '../audio/effects';
import { findChannelPreset } from '../features/mixer/channelPresets';

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
 * The first MIDI clip of an instrument track, if any. A conventional name ('Bass',
 * 'Melody', ...) is resolved by role first, so renamed tracks are still found;
 * other names match by name. Drum tracks are skipped: their clips cannot sound notes.
 */
export function firstMidiClipOfTrack(project: Project, name: string): Clip | null {
  const role = roleForTrackName(name);
  const instruments: Project = {
    ...project,
    tracks: project.tracks.filter((t) => t.type === 'instrument'),
  };
  const track =
    (role ? findTrackByRole(instruments, role) : null) ?? findTrackByName(instruments, name);
  return track?.clips.find((c) => c.type === 'midi') ?? null;
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
    mapClip(project, clipId, (c) =>
      fitClipToNotes({
        ...c,
        notes: (c.notes ?? []).map((n) =>
          ids.has(n.id) ? { ...n, startBeat: quantizeStart(n.startBeat, snap) } : n,
        ),
      }),
    ),
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
  options?: NoteEditOptions,
): string[] {
  const ids = new Set(noteIds);
  const newIds: string[] = [];
  const dupesByCall: { project: Project; dupes: NoteEvent[] }[] = [];
  const committed = useStore.getState().applyProjectChange((project) =>
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
      return fitClipToNotes({ ...c, notes: [...(c.notes ?? []), ...dupes] }, options);
    }),
  );
  if (!committed) return [];
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

/**
 * Replace all notes in one undo step. By default, a non-looping clip extends
 * to the last note. Returns whether the store applied the replacement.
 */
export function replaceClipNotes(clipId: string, notes: NoteEvent[], options?: NoteEditOptions): boolean {
  const store = useStore.getState();
  if (!findClip(store.project, clipId)) return false;
  return store.applyProjectChange((project) =>
    mapClip(project, clipId, (c) => fitClipToNotes({ ...c, notes }, options)),
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
// Chord track -> notes.
// ---------------------------------------------------------------------------

/** Base note (C4) for chord voicings written by chordsToNotes and chord previews. */
export const CHORD_VOICING_REGISTER = 60;

const CHORD_NOTE_VELOCITY = 90;

/**
 * Default track for "コードをノートにする": the instrument track with role 'chords',
 * else the selected track when it is an instrument track, else none.
 */
export function chordNotesTargetTrackId(project: Project, selectedTrackId: string | null): string | null {
  const chords = project.tracks.find((t) => t.role === 'chords' && t.type === 'instrument');
  if (chords) return chords.id;
  const selected = project.tracks.find((t) => t.id === selectedTrackId);
  return selected?.type === 'instrument' ? selected.id : null;
}

type ChordNotesSpan = Pick<Clip, 'startBeat' | 'lengthBeats'>;

function chordNotesDestination(project: Project, track: Track) {
  const existing = track.clips.find((c) => c.type === 'midi');
  const span: ChordNotesSpan = existing ?? {
    startBeat: 0,
    lengthBeats: project.lengthBars * projectBeatsPerBar(project),
  };
  return { existing, span };
}

function chordNoteTiming(chord: ChordEvent, clip: ChordNotesSpan) {
  const start = Math.max(chord.startBeat, clip.startBeat);
  const startBeat = start - clip.startBeat;
  if (!startsBeforeClipEnd(startBeat, clip.lengthBeats)) return undefined;

  const end = Math.min(chord.startBeat + chord.durationBeats, clip.startBeat + clip.lengthBeats);
  if (end <= start) return undefined;
  return { startBeat, durationBeats: end - start };
}

export function hasChordsInNotesTarget(project: Project, track: Track): boolean {
  const { span } = chordNotesDestination(project, track);
  return project.chordTrack.some((chord) => chordNoteTiming(chord, span) !== undefined);
}

/**
 * Voice the chord track into clip-relative notes for `clip`. Chords outside the
 * clip are skipped; a chord that crosses a clip edge keeps only the part inside
 * the clip (what actually sounds there). Unreadable symbols write nothing.
 */
function chordTrackNotes(
  project: Project,
  clip: ChordNotesSpan,
  opts: { style: VoicingStyle; voiceLeading: boolean },
): NoteEvent[] {
  const notes: NoteEvent[] = [];
  let prev: number[] = [];
  for (const c of [...project.chordTrack].sort((a, b) => a.startBeat - b.startBeat)) {
    const timing = chordNoteTiming(c, clip);
    if (!timing) continue;
    let pitches: number[];
    try {
      const voicing = { style: opts.style, register: CHORD_VOICING_REGISTER };
      pitches = opts.voiceLeading ? voiceLead(prev, c.symbol, voicing) : voiceChord(c.symbol, voicing);
    } catch {
      continue; // An unreadable symbol has no notes to write.
    }
    prev = pitches;
    for (const pitch of pitches) {
      notes.push({
        id: uid('note'),
        pitch,
        ...timing,
        velocity: CHORD_NOTE_VELOCITY,
      });
    }
  }
  return notes;
}

/**
 * Write the whole chord track as notes into the target track's first MIDI clip
 * (one undo step). Without a MIDI clip, one spanning the whole song is created.
 * Notes are clip-relative: chords outside the clip are skipped and chords that
 * run past either clip edge are cut there. The written clip stops looping and
 * stops being a linked copy, so the new notes are what plays and what the piano
 * roll edits. Existing notes are replaced only after `confirm` agrees. When no
 * chord falls inside the clip nothing changes. Returns whether the clip was written.
 */
export function chordsToNotes(
  targetTrackId: string,
  opts: { style: VoicingStyle; voiceLeading: boolean },
  confirm: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  const project = useStore.getState().project;
  const track = project.tracks.find((t) => t.id === targetTrackId);
  if (!track || track.type !== 'instrument') return false;
  const { existing, span } = chordNotesDestination(project, track);
  const notes = chordTrackNotes(project, span, opts);
  if (notes.length === 0) return false;

  const source = existing?.aliasOf !== undefined
    ? resolveLinkSource(existing, project.tracks.flatMap((t) => t.clips))
    : undefined;
  const localNoteCount = existing?.notes?.length ?? 0;
  const sourceNoteCount = typeof source === 'string' ? 0 : source?.notes?.length ?? 0;
  const changes: string[] = [];
  if (localNoteCount > 0) {
    changes.push(`このクリップに保存されている ${localNoteCount} 個のノートを置き換えます。`);
  }
  if (existing?.aliasOf !== undefined) changes.push('リンク（元のクリップとの連動）を外します。');
  if (sourceNoteCount > 0) {
    changes.push(`リンク元の ${sourceNoteCount} 個のノートに代えて、このクリップでコードから作ったノートを鳴らします。`);
  }
  if (existing?.loop) changes.push('ループを止めます。');
  if (
    (localNoteCount > 0 || sourceNoteCount > 0) &&
    !confirm(
      `「${track.name}」のクリップに、コードから作ったノートを書き込みます。${changes.join('')}よろしいですか？（「元に戻す」で戻せます）`,
    )
  ) {
    return false;
  }

  return useStore.getState().applyProjectChange((current) => {
    const target = current.tracks.find((t) => t.id === targetTrackId);
    if (!target) return current;
    const clip = target.clips.find((c) => c.type === 'midi');
    const written: Clip = clip
      ? { ...withoutLinkOrLoop(clip), notes }
      : {
          id: uid('clip'),
          trackId: target.id,
          type: 'midi',
          startBeat: span.startBeat,
          lengthBeats: span.lengthBeats,
          loop: false,
          notes,
        };
    return mapTracks(current, (t) =>
      t.id !== target.id
        ? t
        : {
            ...t,
            clips: clip ? t.clips.map((c) => (c.id === clip.id ? written : c)) : [...t.clips, written],
          },
    );
  });
}

/** The clip as an independent, non-looping clip (its own notes play once). */
function withoutLinkOrLoop(clip: Clip): Clip {
  const out: Clip = { ...clip, loop: false };
  delete out.aliasOf;
  return out;
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
  /**
   * Japanese question when adopting the file's meter would merge drum hits on
   * the new grid and the import was not `confirmed`; nothing was imported.
   * Null once the import is applied.
   */
  confirm: string | null;
};

/**
 * Add parsed SMF note tracks as new instrument tracks in the current project.
 * The file's tempo and meter are adopted: the meter goes through the shared
 * `setTimeSignature` so existing drum clips are regridded and sections are
 * converted by beat, and the song only ever grows (through `setLengthBars`) to
 * hold the imported notes. All of it is one undo step. Like the transport's
 * meter change, it asks first (`confirm`) when drum hits would be merged.
 */
export function importMidiTracks(parsed: ParsedMidi, confirmed = false): MidiImportResult {
  const sourceTracks = parsed.tracks.filter((track) => track.notes.length > 0);
  if (sourceTracks.length === 0) {
    throw new Error('MIDIの中に読み込めるノートが見つかりませんでした。');
  }
  const sameMeter = (current: Project): boolean =>
    current.timeSignature[0] === parsed.timeSignature[0] &&
    current.timeSignature[1] === parsed.timeSignature[1];
  if (!confirmed) {
    const current = useStore.getState().project;
    const droppedHits = sameMeter(current)
      ? 0
      : setProjectTimeSignature(current, parsed.timeSignature).droppedHits;
    if (droppedHits > 0) {
      const [num, den] = parsed.timeSignature;
      return {
        importedTrackCount: 0,
        importedNoteCount: 0,
        warnings: [],
        confirm: `このMIDIは ${num}/${den} 拍子です。曲の拍子を ${num}/${den} にすると、ドラムの ${droppedHits} 個の音が別の音と重なるか、曲やクリップの終わり、ループの区切りにかかります。音が削除されたり、鳴らなくなる場所が出たりします。読み込んでもよいですか？(「元に戻す」で戻せます)`,
      };
    }
  }

  let firstTrackId: string | null = null;
  let firstClipId: string | null = null;
  let warnings: string[] = [];
  const importedNoteCount = sourceTracks.reduce((sum, track) => sum + track.notes.length, 0);

  const committed = useStore.getState().applyProjectChange((current) => {
    const meterChange = sameMeter(current)
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

  if (!committed) {
    return { importedTrackCount: 0, importedNoteCount: 0, warnings: [], confirm: null };
  }

  const store = useStore.getState();
  store.selectTrack(firstTrackId);
  store.selectClip(firstClipId);
  store.selectNotes([]);
  store.setActiveView('pianoRoll');

  return {
    importedTrackCount: sourceTracks.length,
    importedNoteCount,
    warnings,
    confirm: null,
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
 * The chords that sound inside `clip`, at clip-relative beats (what generated
 * notes for that clip are measured in). A chord crossing a clip edge keeps only
 * the part inside the clip.
 */
export function clipChordInputs(project: Project, clip: ChordNotesSpan): ChordEventInput[] {
  const inputs: ChordEventInput[] = [];
  for (const c of [...project.chordTrack].sort((a, b) => a.startBeat - b.startBeat)) {
    const timing = chordNoteTiming(c, clip);
    if (timing) inputs.push({ symbol: c.symbol, ...timing });
  }
  return inputs;
}

export type ClipGenerationFailure = 'missingTarget' | 'noChords' | 'noNotes' | 'loopRange' | 'eventLimit';

/** Generate at the selected clip's position and write to its content owner. */
function generateIntoClip(
  clipId: string,
  generate: (project: Project, chords: ChordEventInput[], clip: Clip) => GeneratedNote[],
  onFailure?: (reason: ClipGenerationFailure) => void,
): GeneratedNote[] {
  const fail = (reason: ClipGenerationFailure): GeneratedNote[] => {
    onFailure?.(reason);
    return [];
  };
  const project = useStore.getState().project;
  const clip = findClip(project, clipId);
  const owner = clip ? resolveEditTarget(project, clipId) : undefined;
  if (!clip || !owner) return fail('missingTarget');
  const chords = clipChordInputs(project, clip);
  if (chords.length === 0) return fail('noChords');
  const generated: GeneratedNote[] = [];
  for (const note of generate(project, chords, clip)) {
    if (!startsBeforeClipEnd(note.startBeat, clip.lengthBeats)) continue;
    const durationBeats = Math.min(note.durationBeats, clip.lengthBeats - note.startBeat);
    generated.push(durationBeats === note.durationBeats ? note : { ...note, durationBeats });
  }
  if (generated.length === 0) return fail('noNotes');
  const firstPassEnd = clipFirstPassEnd(clip);
  const firstPassTolerance = CLIP_EDGE_TOLERANCE_BEATS * Math.min(1, firstPassEnd);
  if (
    firstPassEnd < clip.lengthBeats &&
    generated.some((note) =>
      !startsBeforeClipEnd(note.startBeat, firstPassEnd) ||
      note.startBeat + note.durationBeats > firstPassEnd + firstPassTolerance,
    )
  ) {
    return fail('loopRange');
  }
  const events = generatedToNoteEvents(generated);
  if (!replaceClipNotes(owner.id, events, { extendClip: false })) return fail('eventLimit');
  emitNotesAdded(owner.id, { project: useStore.getState().project, dupes: events });
  return generated;
}

/**
 * Generate a bass line from the chords inside the given clip and write it into
 * the clip (clip-relative), replacing its notes. Returns the per-note reasons
 * for UI display. Reports failed generation through `onFailure`.
 */
export function generateBassIntoClip(
  clipId: string,
  mode: BassMode,
  onFailure?: (reason: ClipGenerationFailure) => void,
): GeneratedNote[] {
  return generateIntoClip(
    clipId,
    (project, chords) => generateBassLine(chords, {
      mode,
      key: project.key,
      scale: project.scale,
      beatsPerBar: projectBeatsPerBar(project),
    }),
    onFailure,
  );
}

/**
 * Generate a scale melody from the chords inside the given clip and write it
 * into the clip (clip-relative), replacing its notes. The seed makes repeat
 * clicks vary deterministically when the caller passes an incrementing seed.
 * Returns the generated notes. Reports failed generation through `onFailure`.
 */
export function generateMelodyIntoClip(
  clipId: string,
  seed: number,
  onFailure?: (reason: ClipGenerationFailure) => void,
): GeneratedNote[] {
  return generateIntoClip(
    clipId,
    (project, chords, clip) => generateScaleMelody({
      key: project.key,
      scale: project.scale,
      chords,
      seed,
      beatsPerBar: projectBeatsPerBar(project),
      originBeat: clip.startBeat,
    }),
    onFailure,
  );
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
   * lane -> beat offsets within one bar of `bpb` beats that are ON (0 = 1st
   * beat, 0.5 = its off-beat). Hits at or past the bar end are dropped.
   */
  beats: (bpb: number) => Partial<Record<DrumLane, number[]>>;
};

/** Whole beats of a bar (0, 1, ...), as many as fit before `bpb`. */
function barBeats(bpb: number): number[] {
  return Array.from({ length: Math.ceil(bpb) }, (_, i) => i).filter((beat) => beat < bpb);
}

/** Every 8th note of a bar (0, 0.5, 1, ...). */
function barEighths(bpb: number): number[] {
  return Array.from({ length: Math.ceil(bpb * 2) }, (_, i) => i / 2).filter((beat) => beat < bpb);
}

/**
 * One-bar drum pattern presets. Original beginner-friendly patterns;
 * not copied from any product's factory content.
 */
export const DRUM_PATTERNS: DrumPattern[] = [
  {
    id: 'fourOnFloor',
    name: 'Four on the floor',
    // Kick on every beat of the bar, hi-hat on each off-beat, clap on beats 2, 4, ...
    beats: (bpb) => ({
      kick: barBeats(bpb),
      closedHat: barBeats(bpb).map((beat) => beat + 0.5),
      clap: barBeats(bpb).filter((beat) => beat % 2 === 1),
    }),
  },
  {
    id: 'eightBeat',
    name: '8ビート',
    // Hi-hat on every 8th, kick on beats 1, 3, ..., snare on beats 2, 4, ...
    beats: (bpb) => ({
      kick: barBeats(bpb).filter((beat) => beat % 2 === 0),
      snare: barBeats(bpb).filter((beat) => beat % 2 === 1),
      closedHat: barEighths(bpb),
    }),
  },
  {
    id: 'hiphop',
    name: 'ヒップホップ',
    beats: () => ({
      kick: [0, 1.5, 2.5],
      snare: [1, 3],
      closedHat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
      openHat: [3.5],
    }),
  },
  {
    id: 'gameLoop',
    name: 'ゲームループ',
    beats: () => ({
      kick: [0, 2],
      snare: [1, 3],
      closedHat: [0, 0.75, 1.5, 2.25, 3, 3.75],
      perc: [0.5, 2.5],
    }),
  },
  {
    id: 'lofi',
    name: 'ローファイ',
    beats: () => ({
      kick: [0, 2.5],
      snare: [1, 3],
      closedHat: [0, 1, 2, 3],
      perc: [1.75],
    }),
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
        for (const [lane, beats] of Object.entries(pattern.beats(bpb))) {
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

/**
 * Apply a channel preset (EQ / compressor / filter values) to one track as a
 * single undo step. The preset's effects are switched on; others are untouched.
 */
export function applyChannelPreset(trackId: string, presetId: string): void {
  const preset = findChannelPreset(presetId);
  const state = useStore.getState();
  if (!preset || !state.project.tracks.some((t) => t.id === trackId)) return;
  // A preset is its own undo step, apart from an open (tap tempo) transaction.
  state.commitTransaction();
  state.applyProjectChange((project) => ({
    ...project,
    tracks: project.tracks.map((track) => {
      if (track.id !== trackId) return track;
      let effects = track.effects;
      for (const [type, params] of Object.entries(preset.effects)) {
        effects = upsertEffect(effects, type as SupportedEffectType, (effect) => ({
          ...effect,
          enabled: true,
          params: { ...effect.params, ...params },
        }));
      }
      return { ...track, effects };
    }),
  }));
}
