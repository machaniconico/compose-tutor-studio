// Project -> scheduled-event extraction.
//
// Pure translation of a Project into a flat list of beat-stamped note and drum
// events. Shared by the live playback layer (playback.ts) and the offline WAV
// render (wav.ts) so both play exactly the same thing. The drum step -> beat
// conversion lives here and is unit tested.

import type { DrumLane, Project } from '@cts/project-model';
import type { ScheduledEvent } from './scheduler';

/** Default steps per bar for a drum clip when not specified. */
export const DEFAULT_STEPS_PER_BAR = 16;

/** A note to be played on an instrument track. */
export type NoteScheduleEvent = {
  kind: 'note';
  trackId: string;
  preset: string;
  pitch: number;
  durationBeats: number;
  velocity: number;
};

/** A drum hit to be played on a drum track. */
export type DrumScheduleEvent = {
  kind: 'drum';
  trackId: string;
  lane: DrumLane;
  velocity: number;
};

/** Discriminated payload carried by a ScheduledEvent. */
export type SchedulePayload = NoteScheduleEvent | DrumScheduleEvent;

/**
 * Convert a drum step index to an absolute beat.
 *
 * A drum clip divides each bar into `stepsPerBar` equal steps. Step `i` sits at
 * `i * (beatsPerBar / stepsPerBar)` beats from the clip start; the clip start is
 * `clipStartBeat` on the project timeline. Pure + unit tested.
 */
export function drumStepToBeat(
  stepIndex: number,
  stepsPerBar: number,
  beatsPerBar: number,
  clipStartBeat: number,
): number {
  const steps = stepsPerBar > 0 ? stepsPerBar : DEFAULT_STEPS_PER_BAR;
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const beatsPerStep = bpb / steps;
  return clipStartBeat + stepIndex * beatsPerStep;
}

/**
 * Flatten a project into beat-stamped scheduled events.
 *
 * Instrument tracks: every note of every clip becomes a note event at
 * `clip.startBeat + note.startBeat`, tagged with the track preset.
 * Drum tracks: every drum event becomes a hit at the step's beat.
 *
 * The result is unsorted; the scheduler sorts by resolved time. Pure.
 */
export function buildScheduleEvents(project: Project): ScheduledEvent[] {
  const beatsPerBar = project.timeSignature[0] > 0 ? project.timeSignature[0] : 4;
  const events: ScheduledEvent[] = [];

  for (const track of project.tracks) {
    if (track.type === 'master') continue;

    const preset = track.instrument?.preset ?? 'warmPad';

    for (const clip of track.clips) {
      // Instrument note clips.
      if (clip.notes && clip.notes.length > 0) {
        for (const note of clip.notes) {
          events.push({
            beat: clip.startBeat + note.startBeat,
            payload: {
              kind: 'note',
              trackId: track.id,
              preset,
              pitch: note.pitch,
              durationBeats: note.durationBeats,
              velocity: note.velocity,
            } satisfies NoteScheduleEvent,
          });
        }
      }

      // Drum clips.
      if (clip.drumEvents && clip.drumEvents.length > 0) {
        const stepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
        for (const drum of clip.drumEvents) {
          events.push({
            beat: drumStepToBeat(drum.stepIndex, stepsPerBar, beatsPerBar, clip.startBeat),
            payload: {
              kind: 'drum',
              trackId: track.id,
              lane: drum.lane,
              velocity: drum.velocity,
            } satisfies DrumScheduleEvent,
          });
        }
      }
    }
  }

  return events;
}
