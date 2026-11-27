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
  InstrumentMacros,
  NoteEvent,
  Project,
  Track,
  TrackRole,
} from '@cts/project-model';
import type { ParsedMidi } from '@cts/midi-io';
import {
  addClip,
  beatsPerBar as beatsPerBarOf,
  beatTick,
  clipEditSpan,
  clipTickSpan,
  createDrumClip,
  createMidiClip,
  drumStepsPerBar,
  duplicateClip,
  findProjectSoundingLimitProblem,
  humanize,
  type HumanizeOptions,
  MAX_CLIP_END_BEATS,
  MAX_SOUNDING_EVENTS,
  MAX_SWING_PERCENT,
  moveClip,
  removeClip,
  quantizeClipNotes,
  splitClip,
  setTrackInstrumentMacros,
  setTrackInstrumentPreset,
  deleteSection,
  duplicateSection,
  moveSection,
  type SectionEditResult,
  drumBeatToStep,
  firstPassBeatAt,
  inClipDomain,
  placedNoteTicks,
  PPQ,
  resolveEditTarget,
  songEndBeat,
  resolveLinkSource,
  setLengthBars as setProjectLengthBars,
  setTimeSignature as setProjectTimeSignature,
  SECTION_EDIT_FAILURE_MESSAGES,
  soundingEvents,
  resampleDrumSteps,
  DEFAULT_STEPS_PER_BAR,
  tickSpansOverlap,
  towardGrid,
  TRANSPOSE_FAILURE_MESSAGES,
  validHumanizeOptions,
  transposeProject,
  type MusicalKey,
  type ScaleName,
} from '@cts/project-model';
import {
  analyzeChord,
  DRUM_PATTERNS,
  type DrumPatternId,
  generateAccompaniment,
  type AccompanimentOptions,
  type AccompanimentPart,
  type AccompanimentResult,
  compingNoteCount,
  compingPattern,
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
  type CompingPattern,
  type HarmonicFunction,
} from '@cts/theory-engine';
import {
  createPrng,
  getScalePitchClasses,
  nearestScalePitch,
  keyShiftSemitones,
  transposeByDegree,
  transposeChordSymbol,
  transposeKeyName,
} from '@cts/theory-engine';
import { roleForTrackName } from '@cts/tutorial-engine';
import { fitClipToNotes, useStore, type ClipboardNote, type NoteEditOptions } from './store';
import { uid } from './ids';
import { publishAppEvent } from './appEvents';
import { upsertEffect, type SupportedEffectType } from '../audio/effects';
import { findChannelPreset } from '../features/mixer/channelPresets';
import { withSongLength } from '../features/arranger/arrangeMath';
import { addGridSteps } from '../features/pianoRoll/gridMath';
import { pushToast } from './tutorialBridge';

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
  if (clipId === null) return null;
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

/** Apply confirmed, non-overlapping clip-relative choices in one history entry. */
export function applyDetectedChords(
  project: Project,
  clipStartBeat: number,
  choices: readonly ChordEventInput[],
): boolean {
  const store = useStore.getState();
  if (store.project !== project || store.transactionBase || choices.length === 0) return false;

  const clipStartTick = beatTick(clipStartBeat);
  const spans = choices.map(({ symbol, startBeat, durationBeats }) => ({
    symbol,
    start: clipStartTick + beatTick(startBeat),
    end: clipStartTick + beatTick(startBeat + durationBeats),
  })).sort((a, b) => a.start - b.start);
  if (spans.some(({ start, end }, i) =>
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end ||
    (i > 0 && spans[i - 1]!.end > start)
  )) return false;

  const orderedTrack = [...project.chordTrack].sort((a, b) => a.startBeat - b.startBeat);
  const kept = orderedTrack.flatMap((chord) => {
    const start = beatTick(chord.startBeat);
    const end = beatTick(chord.startBeat + chord.durationBeats);
    const fragments: ChordEvent[] = [];
    let cursor = start;
    let overlapped = false;
    const keepFragment = (left: number, right: number) => {
      fragments.push({
        ...chord,
        id: fragments.length === 0 ? chord.id : uid('chord'),
        startBeat: left / PPQ,
        durationBeats: (right - left) / PPQ,
      });
    };
    for (const span of spans) {
      if (span.start >= end) break;
      if (span.end <= cursor) continue;
      overlapped = true;
      if (cursor < span.start) keepFragment(cursor, span.start);
      cursor = span.end;
    }
    if (!overlapped) return [chord];
    if (cursor < end) keepFragment(cursor, end);
    return fragments;
  });
  const inserted = spans.map(({ symbol, start, end }) =>
    buildChordEvent(project, symbol, start / PPQ, (end - start) / PPQ),
  );
  const chordTrack = [...kept, ...inserted].sort((a, b) => a.startBeat - b.startBeat);
  const applied = store.applyProjectChange(() => ({ ...project, chordTrack }));
  if (applied) for (const event of inserted) emitChordAdded(project, event);
  return applied;
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

/**
 * Quantize the start of the given notes (within a clip) to a grid snap, moving
 * each `strength`% (0..100) of the way to where quantizeClipNotes (D2) puts it:
 * 100 is that position, 50 the midpoint. A note keeps its original start if
 * the exact target fails the first-pass or playback checks. If all attempted
 * moves fail, show a toast. One undo step; returns whether it changed.
 */
export function quantizeNotes(clipId: string, noteIds: readonly string[], snap: number, strength = 100): boolean {
  if (!Number.isFinite(snap) || !(snap > 0) || !Number.isFinite(strength) || strength < 0 || strength > 100) return false;
  const { project } = useStore.getState();
  const gridded = quantizeClipNotes(project, clipId, noteIds, snap);
  if (gridded === project) return false;
  const scope = noteEditScope(project, clipId, noteIds, false);
  if (!scope) return false;
  const gridStart = new Map((resolveEditTarget(gridded, clipId)?.notes ?? []).map((n) => [n.id, n.startBeat]));
  const changed = new Map<string, NoteEvent>();
  let attempted = false;
  for (const n of scope.notes) {
    const startBeat = towardGrid(n.startBeat, gridStart.get(n.id) ?? n.startBeat, strength);
    if (startBeat === n.startBeat) continue;
    attempted = true;
    const result = { ...n, startBeat };
    if (fitsFirstPass(project, scope.clips, result)) changed.set(n.id, result);
  }
  if (changed.size > 0) {
    const target = { ...scope.target, notes: scope.target.notes!.map((n) => changed.get(n.id) ?? n) };
    const candidate = mapClip(project, target.id, () => target);
    const movedIds = new Set(changed.keys());
    const before = notePlayback(project, scope.target, movedIds);
    const after = notePlayback(candidate, target, movedIds);
    for (const id of shortenedOrMissingNotes(before, after)) changed.delete(id);
  }
  if (changed.size === 0) return attempted && refuseSoundChange();
  if (refuseInScope(project, scope, changed.values())) return false;
  return commitNotes(scope, changed, { mayIncreaseEvents: true, check: keepsSoundingAndLength });
}

/**
 * Humanize: shift the selected notes' starts by up to ±`timingBeats` and their
 * velocities by up to ±`velocity` (1..127) from the seed-fixed PRNG, drawn in
 * beat order (groove.humanize). Pitches, lengths and the clip never change.
 * Each drawn start is fitted within ±`timingBeats` using first-pass ticks;
 * when no candidate fits, the note keeps its start. The result
 * is checked on playback like quantizeNotes; refused edits change nothing and
 * show a toast. `timingBeats` / `velocity` must be finite numbers >= 0 and
 * `seed` a safe integer. One undo step; returns whether it changed.
 */
export function humanizeNotes(clipId: string, noteIds: readonly string[], opts: HumanizeOptions): boolean {
  if (!validHumanizeOptions(opts)) return false;
  const { project } = useStore.getState();
  const scope = noteEditScope(project, clipId, noteIds, opts.timingBeats > 0);
  if (!scope) return false;
  const sorted = byStart(scope.notes);
  const changed = new Map<string, NoteEvent>();
  humanize(sorted, opts).forEach((n, i) => {
    const before = sorted[i]!;
    const startBeat = opts.timingBeats > 0
      ? fitFirstPass(project, scope.clips, before, n.startBeat, opts.timingBeats)
      : before.startBeat;
    if (startBeat !== before.startBeat || n.velocity !== before.velocity) changed.set(n.id, { ...n, startBeat });
  });
  if (changed.size === 0 || refuseInScope(project, scope, changed.values())) return false;
  return commitNotes(scope, changed, { mayIncreaseEvents: true, check: keepsSoundingAndLength });
}

function insideFirstPass(ticks: ReturnType<typeof placedNoteTicks>): boolean {
  return ticks.startTick < ticks.passEndTick && ticks.naturalEndTick <= ticks.passEndTick;
}

function fitsFirstPass(project: Project, placements: readonly Clip[], note: NoteEvent): boolean {
  return placements.every((clip) => insideFirstPass(placedTicks(project, clip, note)));
}

/** Try the drawn start and the range boundaries, including nearby tick positions. */
function fitFirstPass(
  project: Project,
  placements: readonly Clip[],
  original: NoteEvent,
  startBeat: number,
  width: number,
): number {
  const before = placements.map((clip) => ({ clip, ticks: placedTicks(project, clip, original) }));
  const fits = (start: number) => start >= 0 && start !== original.startBeat &&
    Math.abs(start - original.startBeat) <= width && before.every(({ clip, ticks }) => {
      const now = placedTicks(project, clip, { ...original, startBeat: start });
      return insideFirstPass(now) &&
        Math.max(1, now.endTick - now.startTick) >= Math.max(1, ticks.endTick - ticks.startTick);
    });

  const lo = Math.max(0, original.startBeat - width);
  const hi = original.startBeat + width;
  // Project each rounded pass end back to a candidate start before swing.
  // This is only a search anchor. A fractional start on either side can fit.
  const last = before.reduce((end, { clip, ticks }) => {
    return Math.min(end, ticks.passEndTick / PPQ - clip.startBeat - original.durationBeats);
  }, hi);
  const anchors = [startBeat, Math.max(lo, last), lo, hi];
  for (const anchor of anchors) {
    if (fits(anchor)) return anchor;
    const tick = beatTick(anchor);
    for (const offset of [0, -1, 1, -2, 2]) {
      const candidate = (tick + offset) / PPQ;
      if (fits(candidate)) return candidate;
    }
  }
  return original.startBeat;
}

/** Notes that lose a sounding pass or any ticks of its played length. */
function shortenedOrMissingNotes(before: NotePlayback, after: NotePlayback): Set<string> {
  const rejected = new Set<string>();
  for (const [key, pass] of before) {
    const result = after.get(key);
    for (const [id, sound] of pass) {
      const now = result?.get(id);
      if (!now || now.end - now.start < sound.end - sound.start) rejected.add(id);
    }
  }
  return rejected;
}

function keepsSoundingAndLength(before: NotePlayback, after: NotePlayback): boolean {
  return shortenedOrMissingNotes(before, after).size === 0;
}

/** Project swing (0..60%), applied on playback by soundingEvents. Other values are ignored. */
export function setSwing(percent: number): boolean {
  if (!Number.isFinite(percent) || percent < 0 || percent > MAX_SWING_PERCENT) return false;
  const store = useStore.getState();
  if ((store.project.swing ?? 0) === percent) return false;
  return store.applyProjectChange((p) => {
    const { swing: _previous, ...rest } = p;
    return percent === 0 ? rest : { ...rest, swing: percent };
  });
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

// ---------------------------------------------------------------------------
// Clipboard, transposition and fitting to the scale (piano roll, US-014).
// Every edit writes to resolveEditTarget (a link's source), keeps note beats
// clip-relative, never changes clip lengths, and is one undo step. A refused
// edit leaves the project (and history) untouched.
// ---------------------------------------------------------------------------

/** Beginner-friendly reasons shown as toasts by the note edits below. */
export const NOTE_EDIT_MESSAGES = {
  tooHigh: 'これ以上高くできません(音の高さは MIDI 0〜127 の範囲です)。',
  tooLow: 'これ以上低くできません(音の高さは MIDI 0〜127 の範囲です)。',
  missingTarget: '元のクリップが見つからないため、この音は編集できません。',
  outsideDomain: 'このクリップは長さか位置が編集できる範囲の外にあるため、貼り付けられません。',
  emptyClipboard: 'コピーした音がありません。先に音を選んでコピーしてください。',
  pasteNothing: 'クリップの終わりを超えるため、貼り付けられる音がありません。',
  pastePartial: 'クリップの終わりを超える部分は貼り付けていません(クリップの長さは変わりません)。',
  alreadyInScale: '選んだ音はすべてスケールの音です。',
  unknownScale: 'キーとスケールを読み取れないため、スケールに沿って動かせません。',
  outsideFirstPass: 'クリップの範囲(ループするクリップは繰り返しの 1 回分)の外には動かせません。',
  outsideDomainEdit: 'このクリップは長さか位置が編集できる範囲の外にあるため、音の位置や長さを変えられません。',
  tooShort: 'これ以上短くできません(短すぎて鳴らなくなる音があります)。',
  nothingToJoin: 'つなげられる音がありません。同じ高さで隣り合う音を 2 つ以上選んでください。',
  splitNothing: '再生ヘッドの位置にかかる選んだ音がありません。再生ヘッドを音の途中に置いてください。',
  velocityRange: 'ベロシティ(音の強さ)は 1〜127 の範囲になるように指定してください。',
  soundChanged: SECTION_EDIT_FAILURE_MESSAGES.soundChanged,
} as const;

/** The selected notes of the clip an edit of `clipId` writes to, or null (with a toast) when it has none. */
function selectedEditNotes(project: Project, clipId: string, noteIds: readonly string[]) {
  if (noteIds.length === 0) return null;
  const target = resolveEditTarget(project, clipId);
  if (!target) {
    pushToast(NOTE_EDIT_MESSAGES.missingTarget, 'error');
    return null;
  }
  const ids = new Set(noteIds);
  const notes = (target.notes ?? []).filter((n) => ids.has(n.id));
  return notes.length > 0 ? { target, ids, notes } : null;
}

/** Every placement that sounds `target`'s notes: the target and each link that resolves to it. */
function sharingPlacements(project: Project, target: Clip): Clip[] {
  return project.tracks
    .flatMap((t) => t.clips)
    .filter((c) => c === target || (c.aliasOf !== undefined && resolveEditTarget(project, c.id) === target));
}

/**
 * Raw ticks of a note in the first pass of a placement, exactly as playback
 * places it (placedNoteTicks, before the one-tick minimum). Editors never add
 * clip and note beats themselves: the order of the sums changes the rounding.
 */
function placedTicks(project: Project, clip: Clip, n: Pick<NoteEvent, 'startBeat' | 'durationBeats'>) {
  return placedNoteTicks(clip, n, { swing: project.swing, songEnd: songEndBeat(project) });
}

/** Tick a note starting at clip-relative `localBeat` starts on in a placement. */
function startTickAt(project: Project, clip: Clip, localBeat: number): number {
  return placedTicks(project, clip, { startBeat: localBeat, durationBeats: 0 }).startTick;
}

function firstPassEndTick(project: Project, clip: Clip): number {
  return placedTicks(project, clip, { startBeat: 0, durationBeats: 0 }).passEndTick;
}

type NoteFields = Pick<NoteEvent, 'pitch' | 'startBeat' | 'durationBeats' | 'velocity'>;

/**
 * Why edited notes cannot be written (the toast message), or null. Every note
 * needs an integer pitch 0..127, an integer velocity 1..127, a finite start >= 0
 * and a finite length > 0. `ticks` also asks for at least one tick and
 * `firstPass` for an end inside the first pass, both on the absolute ticks of
 * every placement that sounds the notes (see sharingPlacements).
 */
function noteResultProblem(
  project: Project,
  placements: readonly Clip[],
  notes: Iterable<NoteFields>,
  checks: { ticks?: boolean; firstPass?: boolean } = {},
): string | null {
  for (const n of notes) {
    if (!Number.isInteger(n.pitch) || n.pitch < 0 || n.pitch > 127) {
      return n.pitch > 127 ? NOTE_EDIT_MESSAGES.tooHigh : NOTE_EDIT_MESSAGES.tooLow;
    }
    if (!Number.isInteger(n.velocity) || n.velocity < 1 || n.velocity > 127) return NOTE_EDIT_MESSAGES.velocityRange;
    if (!Number.isFinite(n.startBeat) || n.startBeat < 0) return NOTE_EDIT_MESSAGES.outsideFirstPass;
    if (!Number.isFinite(n.durationBeats) || !(n.durationBeats > 0)) return NOTE_EDIT_MESSAGES.tooShort;
    for (const c of placements) {
      const t = placedTicks(project, c, n);
      // A note starting at or past this pass's end does not sound here, so it has no length here.
      if (checks.ticks && t.startTick < t.passEndTick && !(t.endTick - t.startTick >= 1)) return NOTE_EDIT_MESSAGES.tooShort;
      if (checks.firstPass && !(t.naturalEndTick <= t.passEndTick)) return NOTE_EDIT_MESSAGES.outsideFirstPass;
    }
  }
  return null;
}

/** noteResultProblem, shown as an error toast; true when the edit must be refused. */
function refuseNoteResults(...args: Parameters<typeof noteResultProblem>): boolean {
  const problem = noteResultProblem(...args);
  if (problem) pushToast(problem, 'error');
  return problem !== null;
}

/**
 * Copy the given notes (of the clip `clipId` edits) to the in-memory clipboard,
 * with beats counted from the first one. The project does not change.
 * Returns how many notes were copied.
 */
export function copyNotes(clipId: string, noteIds: readonly string[]): number {
  const store = useStore.getState();
  const picked = selectedEditNotes(store.project, clipId, noteIds);
  if (!picked) return 0;
  const origin = Math.min(...picked.notes.map((n) => n.startBeat));
  const copied: ClipboardNote[] = [...picked.notes]
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
    .map((n) => ({ pitch: n.pitch, startBeat: n.startBeat - origin, durationBeats: n.durationBeats, velocity: n.velocity }));
  store.setNoteClipboard(copied);
  return copied.length;
}

/** Copy the given notes, then remove them in one undo step. Returns whether anything was cut. */
export function cutNotes(clipId: string, noteIds: readonly string[]): boolean {
  const store = useStore.getState();
  const picked = selectedEditNotes(store.project, clipId, noteIds);
  if (!picked) return false;
  copyNotes(clipId, noteIds);
  const committed = store.applyProjectChange((project) =>
    mapClip(project, picked.target.id, (c) => ({ ...c, notes: (c.notes ?? []).filter((n) => !picked.ids.has(n.id)) })),
  );
  if (committed) store.selectNotes([]);
  return committed;
}

/**
 * Paste the clipboard into the clip `clipId` edits. The first copied note lands
 * on the playhead when it is inside the clip (a looping clip maps it onto the
 * first pass), otherwise on the clip start. Notes past the editable first pass
 * (and the song end) are not pasted and long ones are cut there; the clip never
 * grows. Returns the new note ids (selected), or [] when nothing was pasted.
 */
export function pasteNotes(clipId: string): string[] {
  const store = useStore.getState();
  const { project, noteClipboard } = store;
  if (noteClipboard.length === 0) {
    pushToast(NOTE_EDIT_MESSAGES.emptyClipboard, 'info');
    return [];
  }
  const placement = findClip(project, clipId);
  const target = resolveEditTarget(project, clipId);
  if (!placement || !target) {
    pushToast(NOTE_EDIT_MESSAGES.missingTarget, 'error');
    return [];
  }
  // A link sounds its source's notes: keep them inside every sharing placement's first pass.
  const clips = sharingPlacements(project, target);
  if (!clips.every(inClipDomain)) {
    pushToast(NOTE_EDIT_MESSAGES.outsideDomain, 'error');
    return [];
  }
  // Inside / outside is decided on absolute ticks (each edge rounded on its own),
  // as playback does; the pasted position itself is the exact clip-relative beat.
  const firstEnd = (clip: Clip) => clip.startBeat + clipEditSpan(project, clip).firstPassLength;
  const position = store.transport.positionBeat;
  const playheadTick = beatTick(position);
  const inside = playheadTick >= beatTick(placement.startBeat) &&
    playheadTick < beatTick(placement.startBeat + clipEditSpan(project, placement).length);
  // The playhead may share the clip's start tick while sitting a sub-tick before it: never go below 0.
  const anchor = inside ? Math.max(0, firstPassBeatAt(placement, position - placement.startBeat)) : 0;
  const limit = Math.min(...clips.map((c) => firstEnd(c) - c.startBeat));
  const pasted: NoteEvent[] = [];
  let clipped = false;
  for (const n of noteClipboard) {
    const startBeat = anchor + n.startBeat;
    if (clips.some((c) => startTickAt(project, c, startBeat) >= firstPassEndTick(project, c))) {
      clipped = true;
      continue;
    }
    const durationBeats = Math.min(n.durationBeats, limit - startBeat);
    if (durationBeats < n.durationBeats) clipped = true;
    const piece = { id: uid('note'), pitch: n.pitch, startBeat, durationBeats, velocity: n.velocity };
    // A piece cut under one tick, or ending a sub-tick past some placement's first pass: leave it out.
    const problem = noteResultProblem(project, clips, [piece], { ticks: true, firstPass: true });
    if (problem === NOTE_EDIT_MESSAGES.tooShort || problem === NOTE_EDIT_MESSAGES.outsideFirstPass) {
      clipped = true;
      continue;
    }
    pasted.push(piece);
  }
  if (pasted.length === 0) {
    pushToast(NOTE_EDIT_MESSAGES.pasteNothing, 'info');
    return [];
  }
  if (refuseNoteResults(project, clips, pasted, { ticks: true, firstPass: true })) return [];
  const committed = store.applyProjectChange((p) =>
    mapClip(p, target.id, (c) => ({ ...c, notes: [...(c.notes ?? []), ...pasted] })),
  );
  if (!committed) return [];
  if (clipped) pushToast(NOTE_EDIT_MESSAGES.pastePartial, 'info');
  emitNotesAdded(target.id, { project, dupes: pasted });
  const ids = pasted.map((n) => n.id);
  store.selectNotes(ids);
  return ids;
}

/**
 * Write new pitches for the selected notes in one undo step. The whole edit is
 * refused (with a toast) when any pitch would leave MIDI 0..127; nothing is
 * written when no pitch changes.
 */
function applyPitches(
  clipId: string,
  noteIds: readonly string[],
  pitchOf: (pitch: number, project: Project) => number,
): boolean {
  const store = useStore.getState();
  const picked = selectedEditNotes(store.project, clipId, noteIds);
  if (!picked) return false;
  const next = new Map<string, number>();
  try {
    for (const n of picked.notes) next.set(n.id, pitchOf(n.pitch, store.project));
  } catch {
    pushToast(NOTE_EDIT_MESSAGES.unknownScale, 'error');
    return false;
  }
  const results = picked.notes.map((n) => ({ ...n, pitch: next.get(n.id)! }));
  if (refuseNoteResults(store.project, sharingPlacements(store.project, picked.target), results)) return false;
  const changed = results.filter((n, i) => n.pitch !== picked.notes[i]!.pitch);
  return changed.length > 0 && commitNotes(picked, new Map(changed.map((n) => [n.id, n])));
}

/**
 * Transpose the selected notes by semitones, or by scale degrees along the
 * project's key and scale (an off-scale note is first rounded down to the
 * scale; see transposeByDegree). `semitones` / `degrees` must be finite
 * integers. Returns whether the project changed.
 */
export function transposeSelected(
  clipId: string,
  noteIds: readonly string[],
  by: { semitones: number } | { degrees: number },
): boolean {
  // Only finite whole amounts; anything else (NaN, Infinity, fractions) changes nothing.
  const amount = 'semitones' in by ? by.semitones : by.degrees;
  if (!Number.isInteger(amount)) return false;
  if ('semitones' in by) {
    return applyPitches(clipId, noteIds, (pitch) => pitch + by.semitones);
  }
  return applyPitches(clipId, noteIds, (pitch, project) =>
    transposeByDegree(pitch, by.degrees, project.key, project.scale),
  );
}

/**
 * A chord event moved by `semitones` into `key` (US-016): the symbol is
 * respelled for the new key's signature (transposeChordSymbol) and `root`
 * follows the symbol. `notes` are pitch classes (every writer stores 0..11 and
 * every reader takes them mod 12; validation allows 0..127), so each one's
 * pitch class moves mod 12 and its whole-octave part (a multiple of 12) stays:
 * moving back always restores the stored numbers. A result above 127 refuses
 * the move. Degree, function and tags are relative to the key, which moves
 * with the chords, so they stay. Returns the Japanese reason instead when the
 * chord cannot move.
 */
function transposedChord(chord: ChordEvent, semitones: number, key: MusicalKey, scale: ScaleName): ChordEvent | string {
  let symbol: string;
  try {
    symbol = transposeChordSymbol(chord.symbol, semitones, `${key} ${scale}`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const shift = ((semitones % 12) + 12) % 12;
  const notes = chord.notes.map((n) => n - (n % 12) + (((n % 12) + shift) % 12));
  if (notes.some((n) => !(n >= 0 && n <= 127))) return TRANSPOSE_FAILURE_MESSAGES.chordNotesRange;
  return { ...chord, symbol, root: symbol.match(/^[A-G][#b]?/)![0], notes };
}

/** theory-engine's key-name reader, handed to transposeProject (♯/♭ read like #/b). */
const KEY_NAMES = { shift: keyShiftSemitones, name: transposeKeyName };

/**
 * Move the whole song by `semitones` as one undo step: every instrument-track
 * note (muted tracks too, drum tracks never), every chord and the key
 * (`key`, or the usual spelling for the scale, see transposeKeyName).
 * `semitones` must be a safe integer. Refused with an error toast, changing
 * nothing, when the key cannot be read or is not the old key + semitones
 * (mod 12), a note would leave MIDI 0..127, a chord cannot be read, or the
 * sound would change in more than pitch (see transposeProject). Returns
 * whether the project changed.
 */
export function transposeSong(semitones: number, key?: MusicalKey): boolean {
  const project = useStore.getState().project;
  const result = transposeProject(project, semitones, {
    ...(key !== undefined ? { key } : {}),
    keyNames: KEY_NAMES,
    transposeChord: (chord, keyAfter) => transposedChord(chord, semitones, keyAfter, project.scale),
  });
  if (!result.ok) {
    pushToast(result.reason, 'error');
    return false;
  }
  return result.project !== project && useStore.getState().applyProjectChange(() => result.project);
}

/**
 * Change the song's key from the "曲全体を移調" dialog. With `moveNotesAndChords`
 * (the default) the song moves the nearer way (-5..+6 semitones, see
 * transposeSong); without it only the key changes. One undo step either way;
 * choosing the current key changes nothing. An unreadable key is refused with
 * a toast. Returns whether the project changed.
 */
export function transposeSongToKey(key: MusicalKey, moveNotesAndChords = true): boolean {
  const project = useStore.getState().project;
  if (key === project.key) return false;
  if (!moveNotesAndChords) {
    useStore.getState().setKey(key);
    return true;
  }
  let semitones: number;
  try {
    semitones = keyShiftSemitones(project.key, key);
  } catch {
    pushToast(TRANSPOSE_FAILURE_MESSAGES.unreadableKey(project.key), 'error');
    return false;
  }
  return transposeSong(semitones, key);
}

/**
 * Move the selected off-scale notes to the nearest scale note (the lower one
 * when both are as near). Notes already in the scale stay. Returns whether
 * the project changed.
 */
export function fitSelectedToScale(clipId: string, noteIds: readonly string[]): boolean {
  const store = useStore.getState();
  const picked = selectedEditNotes(store.project, clipId, noteIds);
  if (!picked) return false;
  if (picked.notes.every((n) => pitchInScale(store.project, n.pitch))) {
    pushToast(NOTE_EDIT_MESSAGES.alreadyInScale, 'info');
    return false;
  }
  return applyPitches(clipId, noteIds, (pitch, project) =>
    nearestScalePitch(pitch, project.key, project.scale, 'down'),
  );
}

// ---------------------------------------------------------------------------
// Note tools (piano roll, US-015): legato, staccato, join, split at the playhead,
// arrow-key nudges and velocity ramps / randomization. Same rules as above:
// edits go to resolveEditTarget, beats stay clip-relative, clip lengths never
// change, one undo step, and a refused edit leaves the project untouched.
// Edges are compared on absolute ticks of every clip the notes sound in (the
// placement and, for a link, its source), as playback rounds each on its own.
// ---------------------------------------------------------------------------

type NoteEditScope = NonNullable<ReturnType<typeof selectedEditNotes>> & { placement: Clip; clips: Clip[] };

/**
 * Selected notes plus every placement that sounds them (sharingPlacements), or
 * null. `timing` edits also need all of those placements in the edit domain.
 */
function noteEditScope(project: Project, clipId: string, noteIds: readonly string[], timing: boolean): NoteEditScope | null {
  const picked = selectedEditNotes(project, clipId, noteIds);
  const placement = picked && findClip(project, clipId);
  if (!picked || !placement) return null;
  const clips = sharingPlacements(project, picked.target);
  if (timing && !clips.every(inClipDomain)) {
    pushToast(NOTE_EDIT_MESSAGES.outsideDomainEdit, 'error');
    return null;
  }
  return { ...picked, placement, clips };
}

/** Refuse (with a toast) edited notes that fail noteResultProblem in the scope's placements. */
function refuseInScope(project: Project, scope: NoteEditScope, notes: Iterable<NoteFields>, checks: { ticks?: boolean; firstPass?: boolean } = {}): boolean {
  return refuseNoteResults(project, scope.clips, notes, checks);
}

type NoteSound = { id: string; startBeat: number; start: number; end: number };
type SoundingPass = ReadonlyMap<string, NoteSound>;
type NotePlayback = ReadonlyMap<string, SoundingPass>;
type CheckPlayback = (before: NotePlayback, after: NotePlayback) => boolean;

/** Index actual playback by placement, repeat and stored note id. */
function notePlayback(project: Project, target: Clip, ids: ReadonlySet<string>): NotePlayback {
  const passes = new Map<string, Map<string, NoteSound>>();
  for (const event of soundingEvents(project, { sourceClipId: target.id, includeMuted: true }).events) {
    if (event.kind !== 'note') continue;
    const id = target.notes![event.sourceIndex]!.id;
    if (!ids.has(id)) continue;
    const key = `${event.clipId}:${event.repeat}`;
    const pass = passes.get(key) ?? new Map<string, NoteSound>();
    pass.set(id, {
      id,
      startBeat: event.startBeat,
      start: beatTick(event.startBeat),
      end: beatTick(event.startBeat + event.durationBeats),
    });
    passes.set(key, pass);
  }
  return passes;
}

function keepsSounding(before: NotePlayback, after: NotePlayback): boolean {
  for (const [key, pass] of before) {
    const result = after.get(key);
    for (const id of pass.keys()) {
      if (!result?.has(id)) return false;
    }
  }
  return true;
}

function refuseSoundChange(): false {
  pushToast(NOTE_EDIT_MESSAGES.soundChanged, 'error');
  return false;
}

/** Write changed / removed / added notes into the scope's target in one undo step. */
function commitNotes(
  scope: Pick<NoteEditScope, 'target' | 'ids'>,
  changed: ReadonlyMap<string, NoteEvent>,
  options: {
    removed?: ReadonlySet<string>;
    added?: readonly NoteEvent[];
    before?: NotePlayback;
    check?: CheckPlayback;
    mayIncreaseEvents?: boolean;
  } = {},
): boolean {
  const store = useStore.getState();
  const { removed, added = [], check = keepsSounding } = options;
  const target = {
    ...scope.target,
    notes: [
      ...(scope.target.notes ?? []).flatMap((n) => (removed?.has(n.id) ? [] : [changed.get(n.id) ?? n])),
      ...added,
    ],
  };
  const candidate = mapClip(store.project, target.id, () => target);
  if (added.length > 0 || options.mayIncreaseEvents) {
    const problem = findProjectSoundingLimitProblem(candidate);
    if (problem) {
      pushToast(problem, 'error');
      return false;
    }
  }
  const before = options.before ?? notePlayback(store.project, scope.target, scope.ids);
  const after = notePlayback(candidate, target, new Set([...scope.ids, ...added.map((n) => n.id)]));
  if (!check(before, after)) return refuseSoundChange();
  return store.applyProjectChange(() => candidate);
}

/** Notes sorted by start (then pitch, then id), independent of their stored order. */
function byStart(notes: readonly NoteEvent[]): NoteEvent[] {
  return [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** For each note in a pass, find the next strictly later onset (chords share it). */
function* legatoEnds(pass: SoundingPass): Iterable<[NoteSound, NoteSound]> {
  const sorted = [...pass.values()].sort((a, b) => b.start - a.start);
  let previous: NoteSound | undefined;
  let next: NoteSound | undefined;
  for (const note of sorted) {
    if (previous && note.start < previous.start) next = previous;
    if (next) yield [note, next];
    previous = note;
  }
}

/**
 * Legato: end each selected note where the next selected note (one starting on
 * a later tick) starts, longer or shorter. The last one keeps its length.
 * Refused (with a toast) when a note would end past the first pass.
 */
export function legato(clipId: string, noteIds: readonly string[]): boolean {
  const { project } = useStore.getState();
  const scope = noteEditScope(project, clipId, noteIds, true);
  if (!scope) return false;
  // Preserve the first-pass boundary when the selection extends past it.
  for (const clip of scope.clips) {
    const end = firstPassEndTick(project, clip);
    const starts = scope.notes.map((n) => startTickAt(project, clip, n.startBeat));
    if (starts.some((start) => start < end) && starts.some((start) => start > end)) {
      pushToast(NOTE_EDIT_MESSAGES.outsideFirstPass, 'error');
      return false;
    }
  }
  const before = notePlayback(project, scope.target, scope.ids);
  const ends = new Map<string, {
    preferred: number;
    min: number;
    max: number;
    aligned: boolean;
    preferredFits: boolean;
  }>();
  const byId = new Map(scope.notes.map((n) => [n.id, n]));
  for (const pass of before.values()) {
    for (const [note, next] of legatoEnds(pass)) {
      const limits = ends.get(note.id) ?? {
        preferred: byId.get(next.id)!.startBeat - byId.get(note.id)!.startBeat,
        min: 0, max: Infinity, aligned: true, preferredFits: true,
      };
      // Intersect the durations that round to the next onset in each pass.
      const center = (next.start - note.start) / PPQ + (note.start / PPQ - note.startBeat);
      limits.min = Math.max(limits.min, center - 0.5 / PPQ);
      limits.max = Math.min(limits.max, center + 0.5 / PPQ);
      limits.aligned &&= note.end === next.start;
      limits.preferredFits &&= beatTick(note.startBeat + limits.preferred) === next.start;
      ends.set(note.id, limits);
    }
  }
  const changed = new Map<string, NoteEvent>();
  for (const n of scope.notes) {
    const limits = ends.get(n.id);
    if (!limits || limits.aligned) continue;
    if (!limits.preferredFits && limits.min > limits.max) return refuseSoundChange();
    const durationBeats = limits.preferredFits ? limits.preferred : (limits.min + limits.max) / 2;
    changed.set(n.id, { ...n, durationBeats });
  }
  if (changed.size === 0) return false;
  if (refuseInScope(project, scope, changed.values(), { ticks: true, firstPass: true })) return false;
  return commitNotes(scope, changed, {
    before,
    check: (previous, after) => {
      if (!keepsSounding(previous, after)) return false;
      for (const pass of after.values()) {
        for (const [note, next] of legatoEnds(pass)) {
          if (note.end !== next.start) return false;
        }
      }
      return true;
    },
  });
}

/** Staccato: halve the selected notes' lengths. Refused (with a toast) when one would last under a tick. */
export function staccato(clipId: string, noteIds: readonly string[]): boolean {
  const { project } = useStore.getState();
  const scope = noteEditScope(project, clipId, noteIds, false);
  if (!scope) return false;
  const changed = new Map(scope.notes.map((n) => [n.id, { ...n, durationBeats: n.durationBeats / 2 }]));
  if (refuseInScope(project, scope, changed.values(), { ticks: true })) return false;
  return commitNotes(scope, changed, {
    check: (before, after) => {
      for (const [key, pass] of before) {
        const result = after.get(key);
        for (const [id, original] of pass) {
          const note = result?.get(id);
          if (!note || note.end - note.start < 1 || note.end - note.start >= original.end - original.start) return false;
        }
      }
      return true;
    },
  });
}

/** Each merged note must cover exactly the old intervals, including any overlaps. */
function keepsJoinedIntervals(before: NotePlayback, after: NotePlayback, heads: ReadonlyMap<string, string>): boolean {
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const result = after.get(key);
    const groups = new Map<string, NoteSound[]>();
    for (const [id, note] of before.get(key) ?? []) {
      const head = heads.get(id);
      if (head === undefined) {
        if (!result?.has(id)) return false;
        continue;
      }
      const intervals = groups.get(head) ?? [];
      intervals.push(note);
      groups.set(head, intervals);
    }
    for (const [head, intervals] of groups) {
      intervals.sort((a, b) => a.start - b.start);
      const start = intervals[0]!.start;
      let end = start;
      for (const interval of intervals) {
        if (interval.start > end) return false;
        end = Math.max(end, interval.end);
      }
      const joined = result?.get(head);
      if (joined?.start !== start || joined.end !== end) return false;
    }
    for (const id of result?.keys() ?? []) {
      if (heads.has(id) && !groups.has(id)) return false;
    }
  }
  return true;
}

/**
 * Join selected notes of the same pitch that touch or overlap (the next one
 * starts on or before the tick the previous one ends) into one note from the
 * first start to the latest end. The first note keeps its id and velocity.
 */
export function joinNotes(clipId: string, noteIds: readonly string[]): boolean {
  const store = useStore.getState();
  const scope = noteEditScope(store.project, clipId, noteIds, true);
  if (!scope) return false;
  const sorted = byStart(scope.notes).sort((a, b) => a.pitch - b.pitch);
  const changed = new Map<string, NoteEvent>();
  const removed = new Set<string>();
  const heads = new Map<string, string>();
  let head: NoteEvent | null = null;
  let end = 0;
  const flush = () => {
    if (head && end - head.startBeat !== head.durationBeats) changed.set(head.id, { ...head, durationBeats: end - head.startBeat });
  };
  for (const n of sorted) {
    const touches = head !== null && head.pitch === n.pitch &&
      scope.clips.every((c) =>
        startTickAt(store.project, c, n.startBeat) <=
          placedTicks(store.project, c, { startBeat: head!.startBeat, durationBeats: end - head!.startBeat }).naturalEndTick);
    if (touches) {
      removed.add(n.id);
      heads.set(head!.id, head!.id);
      heads.set(n.id, head!.id);
      end = Math.max(end, n.startBeat + n.durationBeats);
      continue;
    }
    flush();
    head = n;
    end = n.startBeat + n.durationBeats;
  }
  flush();
  if (removed.size === 0) {
    pushToast(NOTE_EDIT_MESSAGES.nothingToJoin, 'info');
    return false;
  }
  if (refuseInScope(store.project, scope, changed.values(), { ticks: true, firstPass: true })) return false;
  const committed = commitNotes(scope, changed, {
    removed,
    check: (before, after) => keepsJoinedIntervals(before, after, heads),
  });
  if (committed) store.selectNotes(noteIds.filter((id) => !removed.has(id)));
  return committed;
}

/**
 * Split each selected note the playhead crosses into two at the playhead (a
 * looping clip maps a later pass onto the first one). A playhead on a note's
 * start or end tick, or outside the clip, splits nothing. Both halves are selected.
 */
export function splitNoteAtPlayhead(clipId: string, noteIds: readonly string[]): boolean {
  const store = useStore.getState();
  const { project } = store;
  const scope = noteEditScope(project, clipId, noteIds, true);
  if (!scope) return false;
  const { placement } = scope;
  const position = store.transport.positionBeat;
  const playheadTick = beatTick(position);
  const inside = Number.isFinite(position) && playheadTick >= beatTick(placement.startBeat) &&
    playheadTick < beatTick(placement.startBeat + clipEditSpan(project, placement).length);
  const at = inside ? Math.max(0, firstPassBeatAt(placement, position - placement.startBeat)) : 0;
  const changed = new Map<string, NoteEvent>();
  const added: NoteEvent[] = [];
  const secondIds = new Map<string, string>();
  for (const n of inside ? scope.notes : []) {
    const crosses = scope.clips.every((c) => {
      const t = placedTicks(project, c, n);
      const atTick = startTickAt(project, c, at);
      return t.startTick < atTick && atTick < t.naturalEndTick && atTick < t.passEndTick;
    });
    if (!crosses) continue;
    changed.set(n.id, { ...n, durationBeats: at - n.startBeat });
    const secondId = uid('note');
    added.push({ ...n, id: secondId, startBeat: at, durationBeats: n.startBeat + n.durationBeats - at });
    secondIds.set(n.id, secondId);
  }
  if (added.length === 0) {
    pushToast(NOTE_EDIT_MESSAGES.splitNothing, 'info');
    return false;
  }
  if (refuseInScope(project, scope, [...changed.values(), ...added], { ticks: true })) return false;
  const committed = commitNotes(scope, changed, {
    added,
    check: (before, after) => {
      if (!keepsSounding(before, after)) return false;
      for (const [key, pass] of before) {
        for (const id of pass.keys()) {
          const second = secondIds.get(id);
          if (second !== undefined && !after.get(key)?.has(second)) return false;
        }
      }
      return true;
    },
  });
  if (committed) store.selectNotes([...noteIds, ...added.map((n) => n.id)]);
  return committed;
}

/**
 * Arrow-key nudge. `semitones` moves pitch (the same edit as transposeSelected:
 * ↑/↓ one semitone, Shift+↑/↓ an octave). `gridSteps` moves start by that many
 * grid lines of `snap` beats (←/→), without float drift on triplet grids; refused
 * (with a toast) when a note would leave the first pass. `gridSteps` must be a
 * non-zero finite integer and `snap` a finite positive number.
 */
export function nudge(
  clipId: string,
  noteIds: readonly string[],
  by: { semitones: number } | { gridSteps: number; snap: number },
): boolean {
  if ('semitones' in by) return transposeSelected(clipId, noteIds, { semitones: by.semitones });
  const { gridSteps, snap } = by;
  if (!Number.isInteger(gridSteps) || gridSteps === 0 || !Number.isFinite(snap) || !(snap > 0)) return false;
  const { project } = useStore.getState();
  const scope = noteEditScope(project, clipId, noteIds, true);
  if (!scope) return false;
  const changed = new Map(scope.notes.map((n) => [n.id, { ...n, startBeat: addGridSteps(n.startBeat, snap, gridSteps) }]));
  if (refuseInScope(project, scope, changed.values(), { ticks: true, firstPass: true })) return false;
  return commitNotes(scope, changed, { mayIncreaseEvents: true });
}

/**
 * Write velocities computed per note; nothing is written when none changes.
 * Every result is checked first (a finite integer 1..127, see noteResultProblem).
 */
function applyVelocities(scope: NoteEditScope, velocityOf: Map<string, number>): boolean {
  const results = scope.notes.map((n) => ({ ...n, velocity: velocityOf.get(n.id) ?? n.velocity }));
  if (refuseInScope(useStore.getState().project, scope, results)) return false;
  const changed = new Map(results.filter((n, i) => n.velocity !== scope.notes[i]!.velocity).map((n) => [n.id, n]));
  return changed.size > 0 && commitNotes(scope, changed);
}

/**
 * Velocity ramp: from `from` at the earliest selected note to `to` at the
 * latest, linear in the notes' beat positions (notes on one beat get the same
 * value). Both ends must be integers; outside 1..127 is refused with a toast.
 */
export function rampVelocity(clipId: string, noteIds: readonly string[], from: number, to: number): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if ([from, to].some((v) => v < 1 || v > 127)) {
    pushToast(NOTE_EDIT_MESSAGES.velocityRange, 'error');
    return false;
  }
  const scope = noteEditScope(useStore.getState().project, clipId, noteIds, false);
  if (!scope) return false;
  const sorted = byStart(scope.notes);
  const first = sorted[0]!.startBeat;
  const span = sorted.at(-1)!.startBeat - first;
  return applyVelocities(scope, new Map(sorted.map((n) => [
    n.id,
    // The fraction first, so huge beats (1e307) cannot overflow the product.
    span > 0 ? Math.round(from + (to - from) * ((n.startBeat - first) / span)) : from,
  ])));
}

/**
 * Random velocities `center` ± `width` from the seed-fixed PRNG, drawn in beat
 * order (the same seed and selection give the same result). `center` and
 * `seed` must be integers and `width` a finite number >= 0; a range reaching
 * outside 1..127 is refused with a toast.
 */
export function randomizeVelocity(
  clipId: string,
  noteIds: readonly string[],
  opts: { center: number; width: number; seed: number },
): boolean {
  const { center, width, seed } = opts;
  if (!Number.isInteger(center) || !Number.isFinite(width) || width < 0 || !Number.isInteger(seed)) return false;
  if (center - width < 1 || center + width > 127) {
    pushToast(NOTE_EDIT_MESSAGES.velocityRange, 'error');
    return false;
  }
  const scope = noteEditScope(useStore.getState().project, clipId, noteIds, false);
  if (!scope) return false;
  const rng = createPrng(seed);
  return applyVelocities(scope, new Map(byStart(scope.notes).map((n) => [
    n.id,
    Math.round(center + (rng() * 2 - 1) * width),
  ])));
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
const confirmChordNotes = (message: string) => window.confirm(message);

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

function wholeSongChordNotesSpan(project: Project): ChordNotesSpan {
  return { startBeat: 0, lengthBeats: project.lengthBars * projectBeatsPerBar(project) };
}

function chordNotesDestination(project: Project, track: Track) {
  const existing = track.clips.find((c) => c.type === 'midi');
  const span = existing ?? wholeSongChordNotesSpan(project);
  return { existing, span };
}

function chordNoteTiming(chord: ChordEvent, clip: ChordNotesSpan, clipEnd = clip.startBeat + clip.lengthBeats) {
  const start = Math.max(chord.startBeat, clip.startBeat);
  const startBeat = start - clip.startBeat;
  if (beatTick(start) >= beatTick(clipEnd)) return undefined;

  const end = Math.min(chord.startBeat + chord.durationBeats, clipEnd);
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
  confirm = confirmChordNotes,
): boolean {
  const project = useStore.getState().project;
  const track = project.tracks.find((t) => t.id === targetTrackId);
  if (!track || track.type !== 'instrument') return false;
  const { existing, span } = chordNotesDestination(project, track);
  const notes = chordTrackNotes(project, span, opts);
  return writeChordNotes(project, track, existing, notes, confirm);
}

/** Apply a pattern to the requested MIDI clip, regardless of its position on the track. */
export function applyCompingToClip(
  clipId: string,
  pattern: CompingPattern,
  confirm = confirmChordNotes,
): boolean {
  const project = useStore.getState().project;
  const track = project.tracks.find((t) => t.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((c) => c.id === clipId && c.type === 'midi');
  if (track?.type !== 'instrument' || !clip) return false;
  return writeComping(project, track, clip, pattern, confirm);
}

/** Toolbar entry point, which also handles instrument tracks without a MIDI clip. */
export function applyCompingToTrack(targetTrackId: string, pattern: CompingPattern): boolean {
  const project = useStore.getState().project;
  const track = project.tracks.find((t) => t.id === targetTrackId);
  if (track?.type !== 'instrument') return false;
  const { existing } = chordNotesDestination(project, track);
  return writeComping(project, track, existing, pattern, confirmChordNotes);
}

function writeComping(
  project: Project,
  track: Track,
  clip: Clip | undefined,
  pattern: CompingPattern,
  confirm: typeof confirmChordNotes,
): boolean {
  const span = clip ?? wholeSongChordNotesSpan(project);
  const end = accompanimentClipEnd(project, span);
  if (end === undefined) {
    pushToast(ACCOMPANIMENT_CLIP_LIMIT, 'error');
    return false;
  }
  const chords: ChordEventInput[] = [];
  let noteCount = 0;
  for (const chord of project.chordTrack) {
    const timing = chordNoteTiming(chord, span, end);
    if (!timing) continue;
    const input = { symbol: chord.symbol, ...timing };
    const count = compingNoteCount(input, pattern);
    if (count === 0) continue;
    noteCount += count;
    if (noteCount > MAX_SOUNDING_EVENTS) {
      pushToast(`伴奏の音の数が上限（${MAX_SOUNDING_EVENTS} 個）を超えます。クリップを短くするか、別の伴奏パターンを選んでください。`, 'error');
      return false;
    }
    chords.push(input);
  }
  const notes = compingPattern(chords, pattern, { register: CHORD_VOICING_REGISTER, voiceLeading: true })
    .map((note) => ({ id: uid('note'), ...note }));
  return writeChordNotes(project, track, clip, notes, confirm, true);
}

function compingSoundsInsideClip(project: Project, clip: Clip, notes: readonly NoteEvent[]): boolean {
  const { events, problems } = soundingEvents(project, { clipId: clip.id, includeMuted: true });
  const end = Math.min(clip.startBeat + clip.lengthBeats, songEndBeat(project));
  const epsilon = 1e-9; // Floating-point slack for adding clip offsets and note lengths.
  return problems.length === 0 && events.length === notes.length && events.every((event) =>
    event.kind === 'note' &&
    event.startBeat >= clip.startBeat - epsilon &&
    event.startBeat + event.durationBeats <= end + epsilon &&
    Math.abs(event.durationBeats - (notes[event.sourceIndex]?.durationBeats ?? Infinity)) <= epsilon,
  );
}

function writeChordNotes(
  project: Project,
  track: Track,
  existing: Clip | undefined,
  notes: NoteEvent[],
  confirm: typeof confirmChordNotes,
  checkPlayback = false,
): boolean {
  if (notes.length === 0) return false;

  const written: Clip = existing
    ? { ...withoutLinkOrLoop(existing), notes }
    : {
        id: uid('clip'),
        trackId: track.id,
        type: 'midi',
        ...wholeSongChordNotesSpan(project),
        loop: false,
        notes,
      };
  const candidate = mapTracks(project, (t) => t.id !== track.id ? t : {
    ...t,
    clips: existing ? t.clips.map((c) => c.id === existing.id ? written : c) : [...t.clips, written],
  });
  if (checkPlayback && !compingSoundsInsideClip(candidate, written, notes)) {
    pushToast('伴奏の音がクリップの範囲に収まらないため、書き込めません。', 'error');
    return false;
  }

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

  const store = useStore.getState();
  return store.project === project && store.applyProjectChange(() => candidate);
}

/** The clip as an independent, non-looping clip (its own notes play once). */
function withoutLinkOrLoop(clip: Clip): Clip {
  const out: Clip = { ...clip, loop: false };
  delete out.aliasOf;
  return out;
}

const ACCOMPANIMENT_CLIP_LIMIT = `クリップの終わりが上限（${MAX_CLIP_END_BEATS} 拍）を超えています。クリップを短くするか、曲の先頭に近づけてください。`;

function accompanimentClipEnd(project: Project, span: ChordNotesSpan): number | undefined {
  const clipEnd = span.startBeat + span.lengthBeats;
  if (Number.isFinite(clipEnd) && clipEnd <= MAX_CLIP_END_BEATS) {
    return Math.min(clipEnd, songEndBeat(project));
  }
}

const ACCOMPANIMENT_TARGETS = [
  { role: 'drums', label: 'ドラム', trackType: 'drum', clipType: 'drum' },
  { role: 'bass', label: 'ベース', trackType: 'instrument', clipType: 'midi' },
  { role: 'chords', label: '和音', trackType: 'instrument', clipType: 'midi' },
] as const;

type WrittenAccompaniment = Extract<AccompanimentResult, { ok: true }>;
type GeneratedAccompanimentNote = WrittenAccompaniment[AccompanimentPart][number];
export type WriteAccompanimentResult = { ok: true } | { ok: false; reason: string };

function accompanimentSoundsAsWritten(
  project: Project, clip: Clip, notes: readonly GeneratedAccompanimentNote[],
): boolean {
  const { events, problems } = soundingEvents(project, { clipId: clip.id, includeMuted: true });
  // The non-looping clip renders its saved events once, in array order.
  return problems.length === 0 && events.length === notes.length && events.every((event, index) => {
    const note = notes[index]!;
    if (event.sourceIndex !== index || event.repeat !== 0 || event.velocity !== note.velocity ||
        beatTick(event.startBeat) !== beatTick(clip.startBeat + note.startBeat) ||
        Math.abs(event.startBeat - event.unswungStartBeat) > 1e-9) return false;
    if ('lane' in note) return event.kind === 'drum' && event.lane === note.lane;
    return event.kind === 'note' && event.pitch === note.pitch &&
      Math.abs(event.durationBeats - note.durationBeats) <= 1e-9;
  });
}

/** Generate and apply all three roles as one undoable change. */
export function writeAccompaniment(
  options: Pick<AccompanimentOptions, 'seed' | 'mood' | 'complexity' | 'intensity'>,
  confirm = confirmChordNotes,
): WriteAccompanimentResult {
  const { project } = useStore.getState();
  const missing: string[] = [];
  const targets = ACCOMPANIMENT_TARGETS.flatMap(({ role, label, trackType, clipType }) => {
    const track = project.tracks.find((t) => t.role === role && t.type === trackType);
    if (!track) {
      missing.push(label);
      return [];
    }
    const existing = track.clips.find((clip) => clip.type === clipType);
    return [{ role, label, track, existing, clipType, span: existing ?? wholeSongChordNotesSpan(project) }];
  });
  if (missing.length > 0) {
    return { ok: false, reason: `伴奏を作るには「${missing.join('」「')}」の役割を持つトラックが必要です。トラックを追加するか、役割を設定してください。` };
  }

  const windows: NonNullable<AccompanimentOptions['windows']> = {};
  for (const { role, label, track, existing, span } of targets) {
    const endBeat = accompanimentClipEnd(project, span);
    if (endBeat === undefined) return { ok: false, reason: ACCOMPANIMENT_CLIP_LIMIT };
    if (!existing && track.clips.some((clip) => tickSpansOverlap(
      clipTickSpan(clip.startBeat, clip.lengthBeats), clipTickSpan(span.startBeat, span.lengthBeats),
    ))) {
      return { ok: false, reason: `「${label}」に書き込めるクリップがありません。空いている範囲にクリップを用意してください。` };
    }
    windows[role] = { startBeat: span.startBeat, endBeat };
  }
  const drumClip = targets.find(({ role }) => role === 'drums')?.existing;
  const drumSteps = drumClip
    ? drumClip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR
    : Math.min(DRUM_STEPS_DOMAIN.maxStepsPerBar, drumStepsPerBar(project.timeSignature));
  const generated = generateAccompaniment(project.chordTrack, {
    ...options,
    windows,
    beatsPerBar: projectBeatsPerBar(project),
    drumStepsPerBar: drumSteps,
  });
  if (!generated.ok) return generated;

  for (const { role, label } of targets) {
    if (generated[role].length === 0) {
      return { ok: false, reason: `「${label}」に書き込める音がありません。コードがある位置にクリップを置くか、音が入るように範囲を広げてください。` };
    }
  }

  const allClips = project.tracks.flatMap((track) => track.clips);
  const written = targets.map(({ role, track, existing, span, clipType }) => {
    const clip: Clip = existing ? withoutLinkOrLoop(existing) : {
      id: uid('clip'), trackId: track.id, type: clipType, ...span, loop: false,
    };
    if (role === 'drums') {
      clip.stepsPerBar = drumSteps;
      clip.drumEvents = generated.drums.map(({ lane, stepIndex, velocity }) => ({
        id: uid('drum'), lane, stepIndex, velocity,
      }));
    } else {
      clip.notes = generated[role].map((note) => ({ id: uid('note'), ...note }));
    }
    return { role, track, existing, clip };
  });
  const candidate = mapTracks(project, (track) => {
    const target = written.find((part) => part.track === track);
    if (!target) return track;
    const { clip, existing } = target;
    return { ...track, clips: existing ? track.clips.map((c) => c === existing ? clip : c) : [...track.clips, clip] };
  });
  const limit = findProjectSoundingLimitProblem(candidate);
  if (limit) return { ok: false, reason: limit };
  if (written.some(({ role, clip }) => !accompanimentSoundsAsWritten(candidate, clip, generated[role]))) {
    return { ok: false, reason: '作った音が予定の位置や長さで鳴りません。クリップの範囲やスウィングの設定を見直してください。' };
  }

  const changes: string[] = [];
  let replacesNotes = false;
  for (const { track, existing } of written) {
    if (!existing) continue;
    const source = existing.aliasOf !== undefined ? resolveLinkSource(existing, allClips) : existing;
    const hasNotes = (clip: Clip) => Boolean(clip.notes?.length || clip.drumEvents?.length);
    const replaces = hasNotes(existing) || (typeof source !== 'string' && hasNotes(source));
    replacesNotes ||= replaces;
    if (replaces) changes.push(`「${track.name}」で今使っている音を置き換えます。`);
    if (existing.aliasOf !== undefined) changes.push(`「${track.name}」のクリップのリンクを外します。`);
    if (existing.loop) changes.push(`「${track.name}」のクリップの繰り返しを止めます。`);
  }
  if (replacesNotes && !confirm(`${changes.join('')}伴奏を書き込みますか？「元に戻す」で戻せます。`)) {
    return { ok: false, reason: '伴奏の書き込みを取り消しました。' };
  }

  const store = useStore.getState();
  if (store.project !== project) {
    return { ok: false, reason: '確認中に曲が変更されました。もう一度、伴奏を作ってください。' };
  }
  store.commitTransaction();
  if (!store.applyProjectChange(() => candidate)) {
    return { ok: false, reason: '伴奏を書き込めませんでした。' };
  }
  return { ok: true };
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
  const { length, firstPassLength } = clipEditSpan(project, clip);
  for (const note of generate(project, chords, clip)) {
    if (beatTick(note.startBeat) >= beatTick(length)) continue;
    const durationBeats = Math.min(note.durationBeats, length - note.startBeat);
    generated.push(durationBeats === note.durationBeats ? note : { ...note, durationBeats });
  }
  if (generated.length === 0) return fail('noNotes');
  if (
    firstPassLength < length &&
    generated.some((note) =>
      beatTick(note.startBeat) >= beatTick(firstPassLength) ||
      beatTick(note.startBeat + note.durationBeats) > beatTick(firstPassLength),
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

export { DRUM_PATTERNS, type DrumPattern, type DrumPatternId } from '@cts/theory-engine';

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
 * Where a step-count switch is offered (US-019, like the clip-operation domain of
 * US-011a): both grids are finite and within 1〜192 steps per bar, and every hit's
 * stepIndex is an integer in 0 ≤ stepIndex < 2^31. Outside it nothing changes.
 */
export const DRUM_STEPS_DOMAIN = { minStepsPerBar: 1, maxStepsPerBar: 192, stepIndexLimit: 2 ** 31 } as const;

export const DRUM_STEPS_FAILURE_MESSAGES = {
  outsideDomain: 'このクリップは細かさの設定が特殊なため、マス数を切り替えられません。',
  outOfRange: 'とても遠い位置にある打点があり、新しいマスの位置を計算できないため、マスの数を切り替えませんでした。その打点を消してから、もう一度切り替えてください。',
  noPosition: 'マスの数を切り替えると鳴らなくなる打点があり、手前のマスにも移せないため、切り替えませんでした。',
} as const;

export type DrumStepsPlan =
  | { ok: true; project: Project; moved: number; merged: number }
  | { ok: false; reason: string };

/**
 * Switch the step grid of a drum clip's pattern (US-019): the link source's
 * `stepsPerBar` and hits, so every clip sharing it follows. Each hit goes to the
 * nearest step of the new grid (`resampleDrumSteps`). A hit that would sound
 * fewer times there in some placement (past the clip end or a loop period, also
 * after swing, at any clip that shares it) goes to the nearest earlier step where
 * it sounds no fewer times. Hits that land on one lane and step are merged.
 * `moved` counts hits whose step position (the unswung tick at the source clip)
 * changed, `merged` the hits removed. Hits are matched to their sounds by array
 * index, never by joined id strings.
 * Refused (`ok: false`, nothing applied) outside {@link DRUM_STEPS_DOMAIN}, when a new step is not a finite
 * non-negative integer, when a hit has no earlier step that keeps it sounding,
 * or when the result exceeds the sounding limit. Null when the clip is missing,
 * not a drum clip, has a broken link, or already uses `to`.
 */
export function planDrumStepsChange(project: Project, clipId: string, to: number): DrumStepsPlan | null {
  const allClips = project.tracks.flatMap((track) => track.clips);
  const clip = allClips.find((candidate) => candidate.id === clipId);
  if (!clip || clip.type !== 'drum') return null;
  const source = resolveLinkSource(clip, allClips);
  if (typeof source === 'string') return null;
  const from = source.stepsPerBar !== undefined && source.stepsPerBar > 0 ? source.stepsPerBar : DEFAULT_STEPS_PER_BAR;
  if (from === to) return null;
  const saved = source.drumEvents ?? [];
  const { minStepsPerBar, maxStepsPerBar, stepIndexLimit } = DRUM_STEPS_DOMAIN;
  const inGrid = (steps: number) => Number.isFinite(steps) && steps >= minStepsPerBar && steps <= maxStepsPerBar;
  if (
    !inGrid(from) || !inGrid(to) || !Number.isInteger(to) ||
    saved.some((event) => !Number.isInteger(event.stepIndex) || event.stepIndex < 0 || event.stepIndex >= stepIndexLimit)
  ) {
    return { ok: false, reason: DRUM_STEPS_FAILURE_MESSAGES.outsideDomain };
  }
  const grid = { beatsPerBar: beatsPerBarOf(project.timeSignature), clipStartBeat: source.startBeat };
  if (resampleDrumSteps(saved, from, to, grid).outOfRange > 0) {
    return { ok: false, reason: DRUM_STEPS_FAILURE_MESSAGES.outOfRange };
  }
  // Hits already on one lane and step sound as one: merge them first (the
  // louder, then the earlier stored one stays), so trials never expand them.
  const firstAt = new Map<DrumLane, Map<number, number>>();
  const keep: number[] = [];
  saved.forEach((event, index) => {
    const lane = firstAt.get(event.lane) ?? new Map<number, number>();
    firstAt.set(event.lane, lane);
    const at = lane.get(event.stepIndex);
    if (at === undefined) {
      lane.set(event.stepIndex, keep.length);
      keep.push(index);
    } else if (event.velocity > saved[keep[at]!]!.velocity) {
      keep[at] = index;
    }
  });
  const events = keep.sort((a, b) => a - b).map((index) => saved[index]!);
  const premerged = saved.length - events.length;
  const withSteps = (drumEvents: DrumEvent[], stepsPerBar: number) =>
    mapClip(project, source.id, (c) => ({ ...c, stepsPerBar, drumEvents }));
  const withGrid = (drumEvents: DrumEvent[]) => withSteps(drumEvents, to);
  // soundingEvents materializes every repeat: estimate first (counts only), refuse past the limit.
  const overLimit = (candidate: Project) => findProjectSoundingLimitProblem(candidate);
  // Per clip, how often each saved hit (by index) sounds; muted clips too, notes never.
  const placements = (candidate: Project) => {
    const counts = new Map<string, Map<number, number>>();
    for (const event of soundingEvents(candidate, { sourceClipId: source.id, includeMuted: true }).events) {
      if (event.kind !== 'drum') continue;
      const perClip = counts.get(event.clipId) ?? new Map<number, number>();
      perClip.set(event.sourceIndex, (perClip.get(event.sourceIndex) ?? 0) + 1);
      counts.set(event.clipId, perClip);
    }
    return counts;
  };
  const merged0 = withSteps(events, from);
  const limitBefore = overLimit(merged0);
  if (limitBefore) return { ok: false, reason: limitBefore };
  const before = placements(merged0);
  const beforeEntries = [...before];
  const loses = (counts: Map<string, Map<number, number>>, index: number) =>
    beforeEntries.some(([id, perClip]) => (counts.get(id)?.get(index) ?? 0) < (perClip.get(index) ?? 0));
  // stepsBack per hit: 0 = nearest, k ≥ 1 = k - 1 steps before the step at or before it.
  const back = events.map(() => 0);
  const placeOne = (index: number, k: number) =>
    resampleDrumSteps([events[index]!], from, to, { ...grid, stepsBack: () => k }).events[0];
  let pending = new Set(events.map((_, index) => index).filter((index) => beforeEntries.some(([, m]) => m.has(index))));
  for (let k = 0; pending.size > 0; k++) {
    // Each hit on its own (no merging), so a trial position never changes another hit's sounds.
    const trial: DrumEvent[] = [];
    let missing = false;
    events.forEach((_, index) => {
      const event = placeOne(index, pending.has(index) ? k : back[index]!);
      if (event === undefined) missing = true;
      else trial.push(event);
    });
    if (missing || k > to + 1) return { ok: false, reason: DRUM_STEPS_FAILURE_MESSAGES.noPosition };
    const trialProject = withGrid(trial);
    const limit = overLimit(trialProject);
    if (limit) return { ok: false, reason: limit };
    const counts = placements(trialProject);
    pending = new Set([...pending].filter((index) => {
      if (!loses(counts, index)) {
        back[index] = k;
        return false;
      }
      return true;
    }));
  }
  const result = resampleDrumSteps(events, from, to, { ...grid, stepsBack: (_, index) => back[index]! });
  const next = withGrid(result.events);
  const limit = overLimit(next);
  if (limit) return { ok: false, reason: limit };
  return { ok: true, project: next, moved: result.moved, merged: premerged + result.merged };
}

/**
 * Apply {@link planDrumStepsChange} as one undo step. Returns the counts, or
 * null when nothing was applied (a refusal shows its reason as a toast).
 */
export function setDrumStepsPerBar(clipId: string, to: number): { moved: number; merged: number } | null {
  const state = useStore.getState();
  const plan = planDrumStepsChange(state.project, clipId, to);
  if (!plan) return null;
  if (!plan.ok) {
    pushToast(plan.reason, 'error');
    return null;
  }
  state.commitTransaction();
  if (!state.applyProjectChange(() => plan.project)) return null;
  return { moved: plan.moved, merged: plan.merged };
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

/**
 * Switch a synth track to another sound preset as its own undo step (apart
 * from an open slider transaction). Returns whether the project changed.
 */
export function changeInstrumentPreset(trackId: string, preset: string): boolean {
  const state = useStore.getState();
  state.commitTransaction();
  const next = setTrackInstrumentPreset(state.project, trackId, preset);
  if (next === state.project) return false;
  return state.applyProjectChange(() => next);
}

/**
 * Set or (with `undefined`) clear a synth track's sound macros. Like the mixer
 * faders, a slider drag spread with `sliderUndoProps` is one undo step; outside
 * a transaction each call is its own step. Returns whether the project changed.
 */
export function changeInstrumentMacros(trackId: string, macros: InstrumentMacros | undefined): boolean {
  const state = useStore.getState();
  const next = setTrackInstrumentMacros(state.project, trackId, macros);
  if (next === state.project) return false;
  return state.applyProjectChange(() => next);
}

// --- Song overview (ArrangeView) clip operations ---
// Each one is a single undo step; selecting a clip is UI state and adds none.
// Each first closes an open transaction (a clip drag), so a key pressed during
// a drag is its own undo step.

function clipIds(project: Project): Set<string> {
  return new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
}

/** The first clip of `after` whose id is not in `before`. */
function createdClip(before: Project, after: Project): Clip | null {
  const known = clipIds(before);
  return after.tracks.flatMap((t) => t.clips).find((c) => !known.has(c.id)) ?? null;
}

function selectTrackClip(clip: Clip): void {
  const store = useStore.getState();
  store.selectTrack(clip.trackId);
  store.selectClip(clip.id);
  store.selectNotes([]);
}

/** Toast shown when a clip would end past the longest song length. */
function songLimitMessage(maxBars: number): string {
  return `曲の長さは ${maxBars} 小節までなので、その先にはクリップを置けません。`;
}

/**
 * Duplicate a clip right after itself (or the nearest free spot), as a copy
 * with its own content or as a link that plays the same content. The song
 * grows to cover the new clip (never shrinks); a duplicate that would end past
 * `maxBars` and the current length is refused. Selects and returns the new
 * clip's id, or null when nothing changed.
 */
export function duplicateClipInSong(clipId: string, mode: 'copy' | 'link', maxBars: number): string | null {
  const store = useStore.getState();
  store.commitTransaction();
  const before = store.project;
  const duplicated = duplicateClip(before, clipId, { mode });
  const created = createdClip(before, duplicated);
  if (!created) return null;
  const next = withSongLength(duplicated, created.startBeat + created.lengthBeats, maxBars);
  if (!next) {
    pushToast(songLimitMessage(maxBars), 'error');
    return null;
  }
  if (!store.applyProjectChange(() => next)) return null;
  selectTrackClip(created);
  return created.id;
}

/** Remove a clip; clips linked to it keep sounding (see removeClip). */
export function removeClipFromSong(clipId: string): void {
  const store = useStore.getState();
  store.commitTransaction();
  if (!findClip(store.project, clipId)) return;
  if (!store.applyProjectChange((project) => removeClip(project, clipId))) return;
  if (useStore.getState().editor.selectedClipId === clipId) {
    store.selectClip(null);
    store.selectNotes([]);
  }
}

/** Split a clip at the song beat `atBeat` into two clips. Returns whether it split. */
export function splitClipAtBeat(clipId: string, atBeat: number): boolean {
  const store = useStore.getState();
  store.commitTransaction();
  const result = splitClip(store.project, clipId, atBeat);
  if (!result.ok) {
    pushToast(result.reason, 'error');
    return false;
  }
  return store.applyProjectChange(() => result.project);
}

/**
 * Add an empty 1-bar clip on a track at `startBeat` (moved to the nearest free
 * spot), a drum clip on a drum track and a MIDI clip otherwise. The song grows
 * to cover it as duplicateClipInSong does. Selects and returns the new clip's
 * id; null for tracks that hold no notes (audio, bus) or past the limit.
 */
export function addEmptyClipAt(trackId: string, startBeat: number, maxBars: number): string | null {
  const store = useStore.getState();
  store.commitTransaction();
  const before = store.project;
  const track = before.tracks.find((t) => t.id === trackId);
  if (!track || (track.type !== 'drum' && track.type !== 'instrument')) return null;
  const bpb = beatsPerBarOf(before.timeSignature);
  const clip =
    track.type === 'drum'
      ? createDrumClip(trackId, startBeat, bpb, drumStepsPerBar(before.timeSignature))
      : createMidiClip(trackId, startBeat, bpb);
  const added = addClip(before, trackId, clip);
  const created = createdClip(before, added);
  if (!created) return null;
  const moved = moveClip(added, created.id, startBeat);
  const placedClip = findClip(moved, created.id);
  if (!placedClip) return null;
  // moveClip leaves the clip where it was added when the track has no free spot for it.
  const placedSpan = clipTickSpan(placedClip.startBeat, placedClip.lengthBeats);
  const blocked = moved.tracks.find((t) => t.id === trackId)?.clips.some((c) =>
    c.id !== placedClip.id && tickSpansOverlap(placedSpan, clipTickSpan(c.startBeat, c.lengthBeats)));
  if (blocked) {
    pushToast(NO_ROOM_FOR_CLIP_MESSAGE, 'error');
    return null;
  }
  const placed = withSongLength(moved, placedClip.startBeat + placedClip.lengthBeats, maxBars);
  if (!placed) {
    pushToast(songLimitMessage(maxBars), 'error');
    return null;
  }
  if (!store.applyProjectChange(() => placed)) return null;
  selectTrackClip(placedClip);
  return created.id;
}

/** Shown when a new clip has nowhere to go on its track. */
export const NO_ROOM_FOR_CLIP_MESSAGE = 'ここには置ける場所がありません。';

/** Open a clip in the editor for its kind (drum grid or piano roll) and select it. */
export function openClipInEditor(clipId: string): void {
  const clip = findClip(useStore.getState().project, clipId);
  if (!clip) return;
  selectTrackClip(clip);
  if (clip.type === 'drum') useStore.getState().setActiveView('drums');
  else if (clip.type === 'midi') useStore.getState().setActiveView('pianoRoll');
}

/**
 * Apply a section edit as one undo step, or explain why it failed. Clears the
 * clip selection when the selected clip is gone (deleted or split).
 */
function applySectionEdit(edit: (project: Project) => SectionEditResult): boolean {
  const store = useStore.getState();
  store.commitTransaction();
  const before = store.project;
  const result = edit(before);
  if (!result.ok) {
    pushToast(result.reason, 'error');
    return false;
  }
  if (!store.applyProjectChange(() => result.project)) return false;
  if (!findClip(result.project, useStore.getState().editor.selectedClipId)) {
    store.selectClip(null);
    store.selectNotes([]);
  }
  return true;
}

/** Duplicate a section with its clips and chords right after itself (the song grows). */
export function duplicateSectionInSong(sectionId: string): boolean {
  return applySectionEdit((project) => duplicateSection(project, sectionId));
}

/** Swap a section with the one before (-1) or after (1) it, with their clips and chords. */
export function moveSectionInSong(sectionId: string, direction: -1 | 1): boolean {
  return applySectionEdit((project) => moveSection(project, sectionId, direction));
}

/** Delete a section with its clips and chords; later bars move forward. */
export function deleteSectionFromSong(sectionId: string): boolean {
  return applySectionEdit((project) => deleteSection(project, sectionId));
}

/** Loop the bars of a section (within the song) and turn loop on. */
export function loopSection(sectionId: string): void {
  const store = useStore.getState();
  const { project } = store;
  const section = project.sections.find((s) => s.id === sectionId);
  if (!section) return;
  const bpb = beatsPerBarOf(project.timeSignature);
  const startBeat = section.startBar * bpb;
  const endBeat = Math.min(section.startBar + section.lengthBars, project.lengthBars) * bpb;
  if (endBeat <= startBeat) return;
  store.loopRangeOn({ startBeat, endBeat });
}
