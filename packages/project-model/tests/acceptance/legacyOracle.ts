// FROZEN ORACLE: the pre-US-007 live scheduling path (apps/studio/src/audio/events.ts at commit
// fe97208), copied verbatim in logic. It ignores lengthBeats, loop, aliasOf and track type: every
// note and drum hit of every clip of every non-master track sounds exactly once.
// Never edit this file to follow production changes (D1: the old live/WAV sound is the truth).

const DEFAULT_STEPS_PER_BAR = 16;

export type OracleEvent =
  | { beat: number; kind: 'note'; trackId: string; pitch: number; durationBeats: number; velocity: number }
  | { beat: number; kind: 'drum'; trackId: string; lane: string; velocity: number };

type Raw = Record<string, any>;

function beatsPerBarOf(ts: [number, number]): number {
  return ts[0] * (4 / ts[1]);
}

function drumStepToBeat(stepIndex: number, stepsPerBar: number, beatsPerBar: number, clipStartBeat: number): number {
  const steps = stepsPerBar > 0 ? stepsPerBar : DEFAULT_STEPS_PER_BAR;
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  return clipStartBeat + stepIndex * (bpb / steps);
}

/** `file` is a raw v1/v2 project object (as read from disk, before any migration). */
export function legacyLiveEvents(file: Raw): OracleEvent[] {
  const bpb0 = beatsPerBarOf(file.timeSignature);
  const beatsPerBar = bpb0 > 0 ? bpb0 : 4;
  const events: OracleEvent[] = [];
  for (const track of file.tracks as Raw[]) {
    if (track.type === 'master') continue;
    for (const clip of track.clips as Raw[]) {
      if (clip.notes && clip.notes.length > 0) {
        for (const note of clip.notes as Raw[]) {
          events.push({ beat: clip.startBeat + note.startBeat, kind: 'note', trackId: track.id, pitch: note.pitch, durationBeats: note.durationBeats, velocity: note.velocity });
        }
      }
      if (clip.drumEvents && clip.drumEvents.length > 0) {
        const stepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
        for (const drum of clip.drumEvents as Raw[]) {
          events.push({ beat: drumStepToBeat(drum.stepIndex, stepsPerBar, beatsPerBar, clip.startBeat), kind: 'drum', trackId: track.id, lane: drum.lane, velocity: drum.velocity });
        }
      }
    }
  }
  return events;
}
