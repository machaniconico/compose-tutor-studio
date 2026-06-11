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
} from '@cts/project-model';
import { beatsPerBar as beatsPerBarOf } from '@cts/project-model';
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
import { useStore } from './store';
import { uid } from './ids';
import { quantizeStart } from '../features/pianoRoll/gridMath';

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

/** The first MIDI clip of a named track, if any. */
export function firstMidiClipOfTrack(project: Project, name: string): Clip | null {
  const track = findTrackByName(project, name);
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
  useStore.getState().applyProjectChange((project) => {
    const event = buildChordEvent(project, symbol, startBeat, durationBeats);
    return { ...project, chordTrack: [...project.chordTrack, event] };
  });
}

/** Update a chord's symbol and re-derive its full analysis fields. */
export function updateChordSymbol(chordId: string, symbol: string): void {
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
    return {
      ...project,
      chordTrack: project.chordTrack.map((c) => (c.id === chordId ? rebuilt : c)),
    };
  });
}

/** Append a chord right after the last chord event (used by suggestions). */
export function appendChordAfterLast(symbol: string): void {
  useStore.getState().applyProjectChange((project) => {
    const sorted = [...project.chordTrack].sort((a, b) => a.startBeat - b.startBeat);
    const last = sorted[sorted.length - 1];
    const bpb = projectBeatsPerBar(project);
    const startBeat = last ? last.startBeat + last.durationBeats : 0;
    const event = buildChordEvent(project, symbol, startBeat, bpb);
    return { ...project, chordTrack: [...project.chordTrack, event] };
  });
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
    return { ...project, chordTrack: chords };
  });
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
      return { ...c, notes: [...(c.notes ?? []), ...dupes] };
    }),
  );
  return newIds;
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
  replaceClipNotes(clipId, generatedToNoteEvents(generated));
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
  replaceClipNotes(clipId, generatedToNoteEvents(generated));
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
export function applyDrumPattern(clipId: string, patternId: DrumPatternId): void {
  const pattern = DRUM_PATTERNS.find((p) => p.id === patternId);
  if (!pattern) return;
  useStore.getState().applyProjectChange((project) => {
    const bpb = projectBeatsPerBar(project);
    return mapClip(project, clipId, (clip) => {
      const stepsPerBar = clip.stepsPerBar ?? 16;
      const bars = Math.max(1, Math.round(clip.lengthBeats / bpb));
      const events: DrumEvent[] = [];
      for (let bar = 0; bar < bars; bar += 1) {
        const barOffset = bar * stepsPerBar;
        for (const [lane, indices] of Object.entries(pattern.steps)) {
          for (const idx of indices ?? []) {
            events.push({
              id: uid('drum'),
              lane: lane as DrumLane,
              stepIndex: barOffset + idx,
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
