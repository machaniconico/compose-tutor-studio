// Project -> scheduled-event extraction.
//
// Pure translation of a Project into a flat list of beat-stamped note and drum
// events. Shared by the live playback layer (playback.ts) and the offline WAV
// render (wav.ts) so both play exactly the same thing. The drum step -> beat
// conversion lives here and is unit tested.

import {
  beatsPerBar as beatsPerBarForTimeSignature,
  assertScheduleEventBudget,
  buildClipIndex,
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  MAX_RUNTIME_SCHEDULE_EVENTS,
  realizeChordTrack,
  resolveClipContent,
  RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
  visitMidiClipNoteOccurrences,
  type DrumLane,
  type Project,
} from '@cts/project-model';
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
  clipId: string;
  eventId: string;
  lane: DrumLane;
  velocity: number;
  sourceStepIndex: number;
  clipEndBeat: number;
  stepsPerBar: number;
  beatsPerBar: number;
  probability: number;
  swing: number;
  humanizeVelocity: number;
  seed: number;
  /** Set by resolveDrumOccurrence; absent on raw persisted-project events. */
  voiceSeed?: number;
};

/** Discriminated payload carried by a ScheduledEvent. */
export type SchedulePayload = NoteScheduleEvent | DrumScheduleEvent;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function safeStepsPerBar(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : DEFAULT_STEPS_PER_BAR;
}

function safeBeatsPerBar(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 4;
}

function safeSeed(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : 1;
}

function safeClipEndBeat(startBeat: number, lengthBeats: number): number {
  const endBeat = startBeat + lengthBeats;
  return Number.isFinite(endBeat) && endBeat > startBeat
    ? endBeat
    : Number.POSITIVE_INFINITY;
}

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
  const beatsPerBar = safeBeatsPerBar(beatsPerBarForTimeSignature(project.timeSignature));
  const clipIndex = buildClipIndex(project);
  assertScheduleEventBudget(project, {
    limit: MAX_RUNTIME_SCHEDULE_EVENTS,
    projection: 'audible',
    clipIndex,
    density: {
      windowBeats: RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
      maxEventsPerWindow: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
    },
  });
  const events: ScheduledEvent[] = [];
  const realizedChords = realizeChordTrack(project);

  for (const track of project.tracks) {
    if (track.type === 'master') continue;

    const preset = track.instrument?.preset ?? 'warmPad';

    // Chord Track events are project-level harmony metadata rather than clip
    // notes. Realize them onto the dedicated Chords instrument so live playback
    // and the shared WAV path hear the same harmony. The domain helper returns
    // null when that track already contains authored notes, preventing doubling.
    if (realizedChords?.track.id === track.id) {
      for (const note of realizedChords.notes) {
        events.push({
          beat: note.startBeat,
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

    for (const clip of track.clips) {
      const effectiveClip = resolveClipContent(project, clip, clipIndex);
      if (!effectiveClip) continue;
      // Instrument note clips. The shared domain projector expands the clip's
      // natural MIDI pattern and clips a final partial note at its end.
      if (
        effectiveClip.type === 'midi'
        && effectiveClip.notes
        && effectiveClip.notes.length > 0
      ) {
        visitMidiClipNoteOccurrences(
          effectiveClip,
          MAX_RUNTIME_SCHEDULE_EVENTS,
          (occurrence) => {
            const { note } = occurrence;
            events.push({
              beat: effectiveClip.startBeat + occurrence.localStartBeat,
              payload: {
                kind: 'note',
                trackId: track.id,
                preset,
                pitch: note.pitch,
                durationBeats: occurrence.durationBeats,
                velocity: note.velocity,
              } satisfies NoteScheduleEvent,
            });
          },
        );
      }

      // Drum clips.
      if (effectiveClip.drumEvents && effectiveClip.drumEvents.length > 0) {
        const stepsPerBar = safeStepsPerBar(effectiveClip.stepsPerBar);
        const groove = effectiveClip.drumGroove;
        const swing = clamp(groove?.swing ?? 0, 0, 1);
        const clipProbability = clamp(groove?.probability ?? 1, 0, 1);
        const humanizeVelocity = Math.round(clamp(groove?.humanizeVelocity ?? 0, 0, 127));
        const seed = safeSeed(groove?.seed);
        for (const drum of effectiveClip.drumEvents) {
          events.push({
            beat: drumStepToBeat(
              drum.stepIndex,
              stepsPerBar,
              beatsPerBar,
              effectiveClip.startBeat,
            ),
            payload: {
              kind: 'drum',
              trackId: track.id,
              clipId: clip.id,
              eventId: drum.id,
              lane: drum.lane,
              velocity: drum.velocity,
              sourceStepIndex: drum.stepIndex,
              clipEndBeat: safeClipEndBeat(
                effectiveClip.startBeat,
                effectiveClip.lengthBeats,
              ),
              stepsPerBar,
              beatsPerBar,
              probability: clamp(drum.probability ?? clipProbability, 0, 1),
              swing,
              humanizeVelocity,
              seed,
            } satisfies DrumScheduleEvent,
          });
        }
      }
    }
  }

  return events;
}
