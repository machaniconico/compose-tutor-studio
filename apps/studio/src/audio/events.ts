// Map sounding events onto the shared Web Audio schedule.
import type { DrumLane, Project } from '@cts/project-model';
import { DEFAULT_STEPS_PER_BAR, soundingEvents } from '@cts/project-model';
import type { ScheduledEvent } from './scheduler';

export { DEFAULT_STEPS_PER_BAR };

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

export function buildScheduleEvents(project: Project): ScheduledEvent[] {
  const presets = new Map(project.tracks.map((track) => [track.id, track.instrument?.preset ?? 'warmPad']));
  return soundingEvents(project).events.map((event): ScheduledEvent => {
    const { trackId, startBeat: beat, velocity } = event;
    const payload: SchedulePayload = event.kind === 'note'
      ? {
          kind: 'note', trackId, velocity, preset: presets.get(trackId) ?? 'warmPad',
          pitch: event.pitch, durationBeats: event.durationBeats, ...(event.cut ? { cut: event.cut } : {}),
        }
      : { kind: 'drum', trackId, velocity, lane: event.lane };
    return { beat, payload };
  });
}
