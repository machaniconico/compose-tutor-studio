// Project -> scheduled-event extraction.
//
// Pure translation of a Project into a flat list of beat-stamped note and drum
// events. Shared by the live playback layer (playback.ts) and the offline WAV
// render (wav.ts) so both play exactly the same thing. The drum step -> beat
// conversion lives here and is unit tested.

import {
  assertScheduleEventBudget,
  buildClipIndex,
  compileDrumStepProjector,
  compileMusicalTime,
  createDrumScheduleEvent,
  finalizeGrooveTrackDrums,
  GROOVE_RESOLVER_PPQ,
  isGrooveResolvedMode,
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  MAX_RUNTIME_SCHEDULE_EVENTS,
  realizeChordTrack,
  resolveClipContent,
  projectDrumStep,
  RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
  resolveGrooveDrumEvent,
  resolveGrooveNoteSpan,
  visitMidiClipNoteOccurrences,
  type DrumScheduleOccurrence,
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

export type { DrumScheduleEvent } from '@cts/project-model';
import type { DrumScheduleEvent } from '@cts/project-model';

/** Discriminated payload carried by a ScheduledEvent. */
export type SchedulePayload = NoteScheduleEvent | DrumScheduleEvent;

function safeStepsPerBar(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : DEFAULT_STEPS_PER_BAR;
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
 *
 * Legacy mode (`swing === 0 && !hiHatChoke`) is main's v10 projection. In
 * resolved mode every onset, drop and end comes from the shared 480 PPQ groove
 * resolver in `@cts/project-model`, so WAV and MIDI hear the same events.
 */
export function buildScheduleEvents(project: Project): ScheduledEvent[] {
  const musicalTime = compileMusicalTime(project);
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
  const resolved = isGrooveResolvedMode(project);

  for (const track of project.tracks) {
    if (track.type === 'master') continue;

    const preset = track.instrument?.preset ?? 'warmPad';
    const trackDrums: DrumScheduleOccurrence[] = [];

    // Chord Track events are project-level harmony metadata rather than clip
    // notes. Realize them onto the dedicated Chords instrument so live playback
    // and the shared WAV path hear the same harmony. The domain helper returns
    // null when that track already contains authored notes, preventing doubling.
    if (realizedChords?.track.id === track.id) {
      for (const note of realizedChords.notes) {
        let beat = note.startBeat;
        let durationBeats = note.durationBeats;
        if (resolved) {
          const span = resolveGrooveNoteSpan(
            project, note.startBeat, note.durationBeats, note.startBeat + note.durationBeats,
          );
          if (!span) continue;
          beat = span.onsetTick / GROOVE_RESOLVER_PPQ;
          durationBeats = (span.endTick - span.onsetTick) / GROOVE_RESOLVER_PPQ;
        }
        events.push({
          beat,
          payload: {
            kind: 'note',
            trackId: track.id,
            preset,
            pitch: note.pitch,
            durationBeats,
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
            let beat = effectiveClip.startBeat + occurrence.localStartBeat;
            let durationBeats = occurrence.durationBeats;
            if (resolved) {
              const span = resolveGrooveNoteSpan(
                project,
                beat,
                durationBeats,
                effectiveClip.startBeat + effectiveClip.lengthBeats,
              );
              if (!span) return;
              beat = span.onsetTick / GROOVE_RESOLVER_PPQ;
              durationBeats = (span.endTick - span.onsetTick) / GROOVE_RESOLVER_PPQ;
            }
            events.push({
              beat,
              payload: {
                kind: 'note',
                trackId: track.id,
                preset,
                pitch: note.pitch,
                durationBeats,
                velocity: note.velocity,
              } satisfies NoteScheduleEvent,
            });
          },
        );
      }

      // Drum clips.
      if (effectiveClip.drumEvents && effectiveClip.drumEvents.length > 0) {
        const stepsPerBar = safeStepsPerBar(effectiveClip.stepsPerBar);
        const drumProjector = compileDrumStepProjector(
          stepsPerBar,
          effectiveClip.startBeat,
          musicalTime,
        );
        for (const drum of effectiveClip.drumEvents) {
          const timing = projectDrumStep(drumProjector, drum.stepIndex);
          const event = createDrumScheduleEvent(
            track.id,
            clip.id,
            effectiveClip,
            drum,
            timing.beat,
            stepsPerBar,
            timing.beatsPerBar,
          );
          if (!resolved) {
            events.push(event);
            continue;
          }
          const resolvedEvent = resolveGrooveDrumEvent(project, event);
          if (resolvedEvent) trackDrums.push(resolvedEvent);
        }
      }
    }
    if (trackDrums.length > 0) events.push(...finalizeGrooveTrackDrums(project, trackDrums));
  }

  return events;
}
