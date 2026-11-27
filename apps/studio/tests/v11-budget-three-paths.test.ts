// P20 round 3: in resolved mode the density budget refuses alike on live, WAV and MIDI.
import { projectToMidiResult } from '@cts/midi-io';
import {
  createDrumClip,
  createEmptyProject,
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  ScheduleEventLimitError,
  type Project,
} from '@cts/project-model';
import { describe, expect, it } from 'vitest';
import { buildScheduleEvents } from '../src/audio/events';
import { buildWavScheduleEvents } from '../src/audio/wav';

function denseProject(hiHatChoke: boolean): Project {
  const project = Object.assign(
    createEmptyProject({ clock: () => new Date('2026-01-01T00:00:00.000Z') }),
    { swing: 0, hiHatChoke },
  ) as Project;
  const drums = project.tracks.find((t) => t.type === 'drum')!;
  drums.clips = Array.from({ length: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW + 1 }, (_, i) => {
    const clip = createDrumClip(drums.id, 0, 4);
    clip.drumEvents = [{ id: `kick-${i}`, lane: 'kick', stepIndex: 0, velocity: 100 }];
    return clip;
  });
  return project;
}

function caught(run: () => unknown): ScheduleEventLimitError {
  try {
    run();
  } catch (error) {
    if (error instanceof ScheduleEventLimitError) return error;
    throw error;
  }
  throw new Error('expected a schedule limit error');
}

describe('P20 resolved-mode density budget', () => {
  it('resolved_257KicksAtTickZero_allThreePathsReportTheSameLimit', () => {
    const project = denseProject(true);
    const live = caught(() => buildScheduleEvents(project));
    const wav = caught(() => buildWavScheduleEvents(project));
    const midi = projectToMidiResult(project);
    expect(live).toMatchObject({ reason: 'density', limit: 256, observed: 257 });
    expect(wav).toMatchObject({ reason: 'density', limit: live.limit, observed: live.observed });
    expect(midi.ok).toBe(false);
    if (midi.ok) return;
    expect(midi.error).toMatchObject({
      code: 'event-limit-exceeded',
      limit: live.limit,
      observed: live.observed,
      message: live.message,
    });
  });
});
