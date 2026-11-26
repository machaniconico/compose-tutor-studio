// Project -> scheduled-event extraction.
//
// Pure translation of a Project into a flat list of beat-stamped note and drum
// events. Shared by the live playback layer (playback.ts) and the offline WAV
// render (wav.ts) so both play exactly the same thing. The drum step -> beat
// conversion lives here and is unit tested.

import type { DrumLane, Project } from '@cts/project-model';
import { beatsPerBar as beatsPerBarOf, expandClip } from '@cts/project-model';
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
  /** Set when the clip end cut the note short (the synth then releases at its end). */
  cut?: true;
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
 * Every clip goes through `expandClip`, so clip length, loop and links sound
 * the same here, in the WAV render (which reads these events) and in MIDI
 * export. Instrument notes are tagged with the track preset; drum hits keep
 * their lane.
 *
 * The result is unsorted; the scheduler sorts by resolved time. Pure.
 */
export function buildScheduleEvents(project: Project): ScheduledEvent[] {
  const bpb = beatsPerBarOf(project.timeSignature);
  const beatsPerBar = bpb > 0 ? bpb : 4;
  const allClips = project.tracks.flatMap((track) => track.clips);
  const events: ScheduledEvent[] = [];

  for (const track of project.tracks) {
    if (track.type === 'master') continue;

    const preset = track.instrument?.preset ?? 'warmPad';

    for (const clip of track.clips) {
      const { notes, drumHits } = expandClip(clip, allClips, beatsPerBar, track.type);

      for (const note of notes) {
        events.push({
          beat: note.startBeat,
          payload: {
            kind: 'note',
            trackId: track.id,
            preset,
            pitch: note.pitch,
            durationBeats: note.durationBeats,
            velocity: note.velocity,
            ...(note.cut ? { cut: true as const } : {}),
          } satisfies NoteScheduleEvent,
        });
      }

      for (const hit of drumHits) {
        events.push({
          beat: hit.beat,
          payload: {
            kind: 'drum',
            trackId: track.id,
            lane: hit.lane,
            velocity: hit.velocity,
          } satisfies DrumScheduleEvent,
        });
      }
    }
  }

  return events;
}
