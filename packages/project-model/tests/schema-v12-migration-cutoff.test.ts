import { describe, expect, it } from 'vitest';
import {
  createEmptyProject,
  createTrack,
  decodeProject,
  migrateProject,
  ProjectMigrationError,
} from '../src';

function v11WithCutoffLane(): Record<string, unknown> {
  const project = createEmptyProject({ clock: () => new Date('2026-01-01T00:00:00.000Z') });
  const track = createTrack('Lead', 'instrument');
  const input = JSON.parse(JSON.stringify({
    ...project,
    tracks: [...project.tracks, track],
    automationLanes: [{
      id: 'lane',
      bypassed: false,
      target: { type: 'track-filter-cutoff', trackId: track.id },
      points: [{ id: 'p', beat: 0, value: 1 }],
    }],
  })) as Record<string, unknown>;
  input.schemaVersion = 11;
  return input;
}

describe('migrateProject rejects cutoff lanes before v12', () => {
  it('control: the v11 input is rejected by the codec', () => {
    expect(decodeProject(v11WithCutoffLane()).ok).toBe(false);
  });

  it('does not promote a v11 project with a track-filter-cutoff lane', () => {
    expect(() => migrateProject(v11WithCutoffLane())).toThrow(ProjectMigrationError);
  });

  it('does not promote an older project with a track-filter-cutoff lane', () => {
    const input = v11WithCutoffLane();
    input.schemaVersion = 8;
    expect(() => migrateProject(input)).toThrow(ProjectMigrationError);
  });
});
