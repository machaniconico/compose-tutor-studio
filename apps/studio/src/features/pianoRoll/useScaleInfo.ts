// Shared scale / chord context derived from the project for the piano roll.
//
// Wraps theory-engine so components get a memoized set of in-scale pitch
// classes and a helper to find the chord active at a given beat.

import { useMemo } from 'react';
import type { ChordEvent, Project } from '@cts/project-model';
import { getScalePitchClasses } from '@cts/theory-engine';

export type ScaleInfo = {
  /** Pitch classes (0-11) that belong to the project key/scale. */
  scalePcs: ReadonlySet<number>;
  /**
   * Find the chord event sounding at an absolute song beat. A note's startBeat
   * is clip-relative: pass `clip.startBeat + note.startBeat`.
   */
  chordAtBeat: (beat: number) => ChordEvent | undefined;
  /** Pitch classes of the chord active at an absolute song beat (chord tones). */
  chordTonesAtBeat: (beat: number) => ReadonlySet<number>;
};

/** Chord lookup by absolute song beat (the chord track is absolute). */
export function chordFinder(chordTrack: readonly ChordEvent[]): (beat: number) => ChordEvent | undefined {
  const sorted = [...chordTrack].sort((a, b) => a.startBeat - b.startBeat);
  return (beat) =>
    sorted.find((c) => beat >= c.startBeat - 1e-6 && beat < c.startBeat + c.durationBeats - 1e-6);
}

export function useScaleInfo(project: Project): ScaleInfo {
  return useMemo(() => {
    let pcs: number[] = [];
    try {
      pcs = getScalePitchClasses(project.key, project.scale);
    } catch {
      pcs = [];
    }
    const scalePcs = new Set(pcs);
    const chordAtBeat = chordFinder(project.chordTrack);

    const chordTonesAtBeat = (beat: number): ReadonlySet<number> => {
      const chord = chordAtBeat(beat);
      if (!chord) return new Set();
      return new Set(chord.notes.map((n) => ((n % 12) + 12) % 12));
    };

    return { scalePcs, chordAtBeat, chordTonesAtBeat };
  }, [project.key, project.scale, project.chordTrack]);
}
