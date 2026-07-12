// Deterministic chord-track realization shared by live/offline audio and MIDI
// export. ChordEvent.notes is normally stored as pitch classes (0..11), while
// older/imported projects may contain absolute MIDI pitches; both forms are
// accepted without mutating the project.

import { chordPitchClasses, pitchClassNumber } from './theory';
import type { ChordEvent, PitchClassName, Project, Track } from './types';

/** Default C anchor for close-position chord voicings (MIDI 48 = C3). */
export const CHORD_VOICING_BASE_C = 48;

/** Gentle backing velocity that leaves headroom for melody and drums. */
export const CHORD_VOICING_VELOCITY = 80;

/** Names used by the built-in project factories for the dedicated chord track. */
const CHORD_TRACK_NAMES = new Set(['chord', 'chords', 'コード']);

export type RealizedChordNote = {
  /** Source chord id, useful for deterministic tracing and tests. */
  chordId: string;
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
};

export type RealizedChordTrack = {
  /** The existing dedicated instrument track that should sound the notes. */
  track: Track;
  notes: RealizedChordNote[];
};

export type RealizedChordPitchVisitor = (chord: ChordEvent, pitch: number) => void;

/** Find the dedicated chord-backing instrument track, if the project has one. */
export function findChordTrack(project: Project): Track | null {
  return (
    project.tracks.find(
      (track) =>
        track.type === 'instrument' &&
        CHORD_TRACK_NAMES.has(track.name.trim().toLocaleLowerCase('en-US')),
    ) ?? null
  );
}

/** Whether the dedicated track already contains authored notes. */
export function chordTrackHasExplicitNotes(track: Track): boolean {
  return track.clips.some((clip) => (clip.notes?.length ?? 0) > 0);
}

/** Map common legacy/parser quality spellings onto project-model qualities. */
function normalizeQuality(quality: string): string {
  const normalized = quality.trim().toLowerCase();
  const aliases: Record<string, string> = {
    '': 'major',
    maj: 'major',
    min: 'minor',
    m: 'minor',
    dim: 'diminished',
    aug: 'augmented',
    maj7: 'major7',
    min7: 'minor7',
    m7: 'minor7',
    '7': 'dominant7',
    m7b5: 'minor7b5',
    'm7♭5': 'minor7b5',
  };
  return aliases[normalized] ?? normalized;
}

/** Return finite, in-range integer pitches without duplicates. */
function validUniqueNotes(notes: readonly number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of notes) {
    if (!Number.isFinite(value)) continue;
    const note = Math.trunc(value);
    if (note < 0 || note > 127 || seen.has(note)) continue;
    seen.add(note);
    result.push(note);
  }
  return result;
}

/** Resolve stored/derived chord tones before applying a playable register. */
function chordTones(chord: ChordEvent): number[] {
  const stored = validUniqueNotes(chord.notes);
  if (stored.length > 0) return stored;

  try {
    return chordPitchClasses(
      chord.root as PitchClassName,
      normalizeQuality(chord.quality),
    );
  } catch {
    // Invalid/unknown legacy chords remain visible as markers but are silent.
    return [];
  }
}

/**
 * Voice pitch classes upward from the chord root around C3. Absolute MIDI
 * pitches from legacy/imported projects are retained (sorted for determinism).
 */
function playablePitches(chord: ChordEvent): number[] {
  const tones = chordTones(chord);
  if (tones.length === 0) return [];

  // Any value above 11 identifies the absolute-MIDI representation.
  if (tones.some((tone) => tone > 11)) {
    return [...tones].sort((a, b) => a - b);
  }

  const pitchClasses = tones.map((tone) => ((tone % 12) + 12) % 12);
  let rootPc = pitchClasses[0] ?? 0;
  try {
    rootPc = pitchClassNumber(chord.root);
  } catch {
    // Fall back to the first stored pitch class for unknown legacy root names.
  }

  // Ordering by interval produces a root-position, close voicing even when the
  // stored pitch-class array arrived in another order.
  const ordered = [...new Set(pitchClasses)].sort(
    (a, b) => ((a - rootPc + 12) % 12) - ((b - rootPc + 12) % 12),
  );
  const rootPitch = CHORD_VOICING_BASE_C + rootPc;
  return ordered.map((pc) => rootPitch + ((pc - rootPc + 12) % 12));
}

/**
 * Realize project chord events onto its dedicated chord instrument track.
 *
 * Returns null when there is no dedicated track or when that track already has
 * explicit notes. The latter is the no-doubling contract shared by every
 * consumer. An empty chord track returns a realization with an empty note list.
 */
export function visitRealizedChordPitches(
  project: Project,
  visit: RealizedChordPitchVisitor,
): Track | null {
  const track = findChordTrack(project);
  if (!track || chordTrackHasExplicitNotes(track)) return null;

  for (const chord of project.chordTrack) {
    if (
      !Number.isFinite(chord.startBeat) ||
      chord.startBeat < 0 ||
      !Number.isFinite(chord.durationBeats) ||
      chord.durationBeats <= 0
    ) {
      continue;
    }

    for (const pitch of playablePitches(chord)) {
      visit(chord, pitch);
    }
  }

  return track;
}

/** Count generated chord notes without allocating the realized note array. */
export function countRealizedChordNotes(project: Project): number {
  let count = 0;
  visitRealizedChordPitches(project, () => {
    count = count >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : count + 1;
  });
  return count;
}

export function realizeChordTrack(project: Project): RealizedChordTrack | null {
  const notes: RealizedChordNote[] = [];
  const track = visitRealizedChordPitches(project, (chord, pitch) => {
    notes.push({
      chordId: chord.id,
      pitch,
      startBeat: chord.startBeat,
      durationBeats: chord.durationBeats,
      velocity: CHORD_VOICING_VELOCITY,
    });
  });
  if (!track) return null;

  return { track, notes };
}
