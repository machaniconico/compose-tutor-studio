import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  createEmptyProject,
  decodeProject,
  migrateProject,
} from '../src/index';

const clock = () => new Date('2026-07-30T00:00:00.000Z');

function projectWithCompatibilityMaster() {
  const project = createEmptyProject({ clock });
  const effectiveMaster = project.tracks.find((track) => track.type === 'master')!;
  const compatibilityMaster = {
    ...structuredClone(effectiveMaster),
    id: 'compatibility-master',
    name: 'Compatibility Master',
  };
  return {
    project: { ...project, tracks: [...project.tracks, compatibilityMaster] },
    effectiveMaster,
    compatibilityMaster,
  };
}

function lane(trackId: string, type: 'track-volume' | 'track-pan' = 'track-volume') {
  return {
    id: `lane-${type}-${trackId}`,
    bypassed: false,
    target: { type, trackId },
    points: [
      { id: `point-${type}-${trackId}`, beat: 0, value: 0.75, interpolation: 'linear' },
    ],
  } as const;
}

function expectRejected(input: unknown, path: string): void {
  const decoded = decodeProject(input);
  expect(decoded.ok).toBe(false);
  if (decoded.ok) return;
  expect(decoded.error.issues).toEqual(
    expect.arrayContaining([expect.objectContaining({ path })]),
  );
}

describe('schema-v8 effective-Master volume automation', () => {
  it('migrates v7 by changing only schemaVersion', () => {
    const { project } = projectWithCompatibilityMaster();
    const v7 = { ...structuredClone(project), schemaVersion: 7 };
    const migrated = migrateProject(v7);
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
    expect(migrated).toEqual({ ...v7, schemaVersion: 9 });
  });

  it('rejects every Master automation lane and Read id during legacy-v7 inspection', () => {
    const { project, effectiveMaster, compatibilityMaster } = projectWithCompatibilityMaster();
    for (const master of [effectiveMaster, compatibilityMaster]) {
      expectRejected({
        ...structuredClone(project),
        schemaVersion: 7,
        automationLanes: [lane(master.id)],
      }, 'automationLanes[0].target.trackId');
      expectRejected({
        ...structuredClone(project),
        schemaVersion: 7,
        automationReadState: { globalEnabled: true, disabledTrackIds: [master.id] },
      }, 'automationReadState.disabledTrackIds[0]');
    }
  });

  it('accepts only effective-Master volume and its canonical Read gate in v8', () => {
    const { project, effectiveMaster, compatibilityMaster } = projectWithCompatibilityMaster();
    const canonical = {
      ...project,
      schemaVersion: 8,
      automationLanes: [lane(effectiveMaster.id)],
      automationReadState: {
        globalEnabled: true,
        disabledTrackIds: [effectiveMaster.id],
      },
    };
    const decoded = decodeProject(canonical);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.project.tracks.map((track) => track.id)).toEqual(
        canonical.tracks.map((track) => track.id),
      );
      expect(decoded.project.automationLanes).toEqual(canonical.automationLanes);
      expect(decoded.project.automationReadState).toEqual(canonical.automationReadState);
    }

    expectRejected({
      ...canonical,
      automationLanes: [lane(effectiveMaster.id, 'track-pan')],
    }, 'automationLanes[0].target.trackId');
    expectRejected({
      ...canonical,
      automationLanes: [lane(compatibilityMaster.id)],
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    }, 'automationLanes[0].target.trackId');
    expectRejected({
      ...canonical,
      automationLanes: [],
      automationReadState: {
        globalEnabled: true,
        disabledTrackIds: [compatibilityMaster.id],
      },
    }, 'automationReadState.disabledTrackIds[0]');
  });
});
