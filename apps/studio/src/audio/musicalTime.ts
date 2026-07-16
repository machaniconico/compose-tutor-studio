import {
  beatToSecondsAt,
  compileMusicalTime,
  secondsBetweenBeats,
  secondsToBeatAt,
  type MusicalTimeIndex,
  type Project,
} from '@cts/project-model';
import type { BeatTimeMapping } from './scheduler';

export type ProjectMusicalTime = Readonly<{
  index: MusicalTimeIndex;
  tempo: BeatTimeMapping;
}>;

/** Compile the schema-v3 beat timeline once for live or offline audio work. */
export function createProjectMusicalTime(
  project: Pick<Project, 'lengthBeats' | 'tempoMap' | 'timeSignatureMap'>,
): ProjectMusicalTime {
  const index = compileMusicalTime(project);
  const tempo: BeatTimeMapping = Object.freeze({
    beatToSeconds: (beat: number) => beatToSecondsAt(index, beat),
    secondsToBeat: (seconds: number) => secondsToBeatAt(index, seconds),
  });
  return Object.freeze({ index, tempo });
}

/** Map a beat-domain duration through every tempo change it crosses. */
export function beatDurationSeconds(
  index: MusicalTimeIndex,
  startBeat: number,
  durationBeats: number,
): number {
  return secondsBetweenBeats(index, startBeat, startBeat + durationBeats);
}

/** Map a duration on an unwrapped transport axis (including repeated loops). */
export function mappedBeatDurationSeconds(
  mapping: BeatTimeMapping,
  startBeat: number,
  durationBeats: number,
): number {
  return mapping.beatToSeconds(startBeat + durationBeats)
    - mapping.beatToSeconds(startBeat);
}
