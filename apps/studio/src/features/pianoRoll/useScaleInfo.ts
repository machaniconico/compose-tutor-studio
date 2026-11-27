// Shared scale / chord context derived from the project for the piano roll.
//
// Wraps theory-engine so components get a memoized set of in-scale pitch
// classes and a helper to find the chord active at a given beat.

import { useMemo } from 'react';
import { beatTick, type ChordEvent, type Project } from '@cts/project-model';
import { getScalePitchClasses } from '@cts/theory-engine';

export type ScaleInfo = {
  /** Pitch classes (0-11) that belong to the project key/scale. */
  scalePcs: ReadonlySet<number>;
  /** Find the chord event sounding at a given beat. */
  chordAtBeat: (beat: number) => ChordEvent | undefined;
  /** Pitch classes of the chord active at a beat (chord tones). */
  chordTonesAtBeat: (beat: number) => ReadonlySet<number>;
};

/**
 * 再生と同じ整数 tick(480 PPQ・Math.round)で、開始を含み終了を含まない範囲のコードを引く。
 * `chords` は startBeat 昇順。
 */
export function findChordAtBeat(chords: readonly ChordEvent[], beat: number): ChordEvent | undefined {
  if (!Number.isFinite(beat) || beat < 0) return undefined;
  const tick = beatTick(beat);
  return chords.find(
    (c) => tick >= beatTick(c.startBeat) && tick < beatTick(c.startBeat + c.durationBeats),
  );
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
    const sorted = [...project.chordTrack].sort((a, b) => a.startBeat - b.startBeat);

    const chordAtBeat = (beat: number): ChordEvent | undefined => findChordAtBeat(sorted, beat);

    const chordTonesAtBeat = (beat: number): ReadonlySet<number> => {
      const chord = chordAtBeat(beat);
      if (!chord) return new Set();
      return new Set(chord.notes.map((n) => ((n % 12) + 12) % 12));
    };

    return { scalePcs, chordAtBeat, chordTonesAtBeat };
  }, [project.key, project.scale, project.chordTrack]);
}
