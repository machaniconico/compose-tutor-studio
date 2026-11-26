// Guards that existing projects keep their sound: the schedule events of every
// template, the default project and the sample song (after the file migration
// round trip, also when saved as a v1 or v2 file) must stay identical to the
// snapshot recorded before playback started honoring clip length, loop and
// links (US-007).

import { describe, expect, it } from 'vitest';
import {
  PROJECT_TEMPLATES,
  deserializeProject,
  instantiateTemplate,
  type Project,
  type TemplateId,
} from '@cts/project-model';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { createDefaultProject } from '../src/state/defaultProject';
import { createSampleProject } from '../src/state/sampleProject';

/**
 * Ids are generated per run, so tracks are named by position and name instead.
 * With `savedAs`, the project is loaded as a file saved by that older schema
 * version, so the migration of that version runs before scheduling.
 */
function scheduleSnapshot(project: Project, savedAs?: number): unknown[] {
  const saved = savedAs === undefined ? project : { ...project, schemaVersion: savedAs };
  const migrated = deserializeProject(JSON.stringify(saved));
  const trackLabel = new Map(migrated.tracks.map((track, index) => [track.id, `${index}:${track.name}`]));
  return buildScheduleEvents(migrated).map((event) => {
    const payload = event.payload as SchedulePayload;
    return { ...event, payload: { ...payload, trackId: trackLabel.get(payload.trackId) ?? '?' } };
  });
}

/** The snapshot, and the same events when the song was saved as a v1 or v2 file. */
function expectSameSoundInEveryVersion(project: Project): void {
  const current = scheduleSnapshot(project);
  expect(current).toMatchSnapshot();
  expect(scheduleSnapshot(project, 1)).toEqual(current);
  expect(scheduleSnapshot(project, 2)).toEqual(current);
}

describe('schedule event snapshots (existing projects keep their sound)', () => {
  const templateIds = Object.keys(PROJECT_TEMPLATES) as TemplateId[];

  it('covers all 8 templates', () => {
    expect(templateIds).toHaveLength(8);
  });

  for (const templateId of templateIds) {
    it(`template ${templateId}`, () => {
      expectSameSoundInEveryVersion(instantiateTemplate(templateId));
    });
  }

  it('default project', () => {
    expectSameSoundInEveryVersion(createDefaultProject());
  });

  it('sample song', () => {
    expectSameSoundInEveryVersion(createSampleProject());
  });
});
