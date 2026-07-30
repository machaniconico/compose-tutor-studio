import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  addAutomationPoint,
  createEmptyProject,
  decodeProject,
  encodeProjectJson,
  migrateProject,
  removeAutomationPoint,
  setAutomationLaneBypassed,
  updateAutomationPoint,
  type AutomationMutationErrorCode,
  type AutomationMutationResult,
  type Project,
} from '../src/index';

const clock = () => new Date('2026-07-29T12:00:00.000Z');

function expectSuccess(result: AutomationMutationResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function expectFailure(
  result: AutomationMutationResult,
  code: AutomationMutationErrorCode,
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected automation mutation failure');
  expect(result.error.code).toBe(code);
  return result;
}

function projectWithLane(): Project {
  const project = createEmptyProject({ clock, lengthBars: 2 });
  const track = project.tracks.find((candidate) => candidate.type !== 'master');
  if (track === undefined) throw new Error('automation fixture track is missing');
  return expectSuccess(addAutomationPoint(
    project,
    {
      target: { type: 'track-volume', trackId: track.id },
      beat: 1,
      value: 0.75,
      interpolation: 'linear',
    },
    { laneId: 'schema-v6-lane', pointId: 'schema-v6-point-a' },
  )).project;
}

function legacyRecord(project: Project, schemaVersion: 1 | 2 | 3 | 4 | 5) {
  const legacy = structuredClone(project) as unknown as Record<string, unknown>;
  legacy.schemaVersion = schemaVersion;
  delete legacy.automationReadState;

  if (schemaVersion < 5) delete legacy.audioTakeFolders;
  if (schemaVersion < 4) delete legacy.audioRouting;
  if (schemaVersion < 3) {
    delete legacy.lengthBeats;
    delete legacy.tempoMap;
    delete legacy.timeSignatureMap;
    delete legacy.audioAssets;
    delete legacy.automationLanes;
    for (const track of legacy.tracks as Array<Record<string, unknown>>) {
      delete track.role;
      for (const clip of track.clips as Array<Record<string, unknown>>) {
        delete clip.sourceStartFrame;
        delete clip.sourceFrameCount;
        delete clip.fadeInFrames;
        delete clip.fadeOutFrames;
        delete clip.gainDb;
      }
    }
  } else {
    for (const lane of legacy.automationLanes as Array<Record<string, unknown>>) {
      delete lane.bypassed;
    }
  }

  return legacy;
}

function expectIssue(
  input: unknown,
  path: string,
  code: 'required' | 'invalid-type' | 'unknown-key',
) {
  const result = decodeProject(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected project decode failure');
  expect(result.error.issues).toContainEqual(expect.objectContaining({ path, code }));
}

describe('schema-v6 Automation lane bypass', () => {
  it('keeps schema-v6 lane bypass in the current schema and creates every new lane active', () => {
    const project = projectWithLane();

    expect(CURRENT_SCHEMA_VERSION).toBe(8);
    expect(project.schemaVersion).toBe(8);
    expect(project.automationLanes).toEqual([{
      id: 'schema-v6-lane',
      bypassed: false,
      target: {
        type: 'track-volume',
        trackId: project.automationLanes[0]!.target.trackId,
      },
      points: [{
        id: 'schema-v6-point-a',
        beat: 1,
        value: 0.75,
        interpolation: 'linear',
      }],
    }]);
  });

  it('migrates v5 by adding false to each lane and changing no other value', () => {
    const current = projectWithLane();
    const legacy = legacyRecord(current, 5);
    const before = structuredClone(legacy);
    const expected = structuredClone(legacy);
    expected.schemaVersion = 8;
    expected.automationReadState = { globalEnabled: true, disabledTrackIds: [] };
    expected.automationLanes = (
      expected.automationLanes as Array<Record<string, unknown>>
    ).map((lane) => ({ ...lane, bypassed: false }));

    const migrated = migrateProject(legacy);

    expect(legacy).toEqual(before);
    expect(migrated).toEqual(expected);
    const decoded = decodeProject(legacy);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded).toMatchObject({ sourceSchemaVersion: 5, migrated: true });
    expect(decoded.project).toEqual(expected);
  });

  it('migrates the full v1 to v6 chain without adding audible automation', () => {
    const legacy = legacyRecord(createEmptyProject({ clock }), 1);
    const decoded = decodeProject(legacy);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded).toMatchObject({ sourceSchemaVersion: 1, migrated: true });
    expect(decoded.project.schemaVersion).toBe(8);
    expect(decoded.project.automationLanes).toEqual([]);
    expect(decoded.project.automationReadState).toEqual({
      globalEnabled: true,
      disabledTrackIds: [],
    });
    expect(decoded.project.audioTakeFolders).toEqual([]);
  });

  it('round-trips exact current bypass state', () => {
    const project = projectWithLane();
    project.automationLanes[0]!.bypassed = true;

    const encoded = encodeProjectJson(project);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeProject(JSON.parse(encoded.json) as unknown);
    expect(decoded.ok && decoded.project).toEqual(project);
  });

  it('requires a boolean bypassed field and rejects unknown lane fields in v6', () => {
    const project = projectWithLane();
    const missing = structuredClone(project) as unknown as {
      automationLanes: Array<Record<string, unknown>>;
    };
    delete missing.automationLanes[0]!.bypassed;
    expectIssue(missing, 'automationLanes[0].bypassed', 'required');

    for (const invalid of [null, 'false', 0, {}]) {
      const wrong = structuredClone(project) as unknown as {
        automationLanes: Array<Record<string, unknown>>;
      };
      wrong.automationLanes[0]!.bypassed = invalid;
      expectIssue(wrong, 'automationLanes[0].bypassed', 'invalid-type');
    }

    const unknown = structuredClone(project) as unknown as {
      automationLanes: Array<Record<string, unknown>>;
    };
    unknown.automationLanes[0]!.readMode = 'read';
    expectIssue(unknown, 'automationLanes[0].readMode', 'unknown-key');
  });

  it('inspects every legacy shape exactly and rejects bypassed smuggling', () => {
    const current = projectWithLane();

    for (const schemaVersion of [1, 2] as const) {
      const legacy = legacyRecord(current, schemaVersion);
      legacy.automationLanes = [];
      expectIssue(legacy, 'automationLanes', 'unknown-key');
    }

    for (const schemaVersion of [3, 4, 5] as const) {
      const legacy = legacyRecord(current, schemaVersion);
      const lanes = legacy.automationLanes as Array<Record<string, unknown>>;
      lanes[0]!.bypassed = true;
      expectIssue(legacy, 'automationLanes[0].bypassed', 'unknown-key');
    }

    const missingV5Collection = legacyRecord(current, 5);
    delete missingV5Collection.audioTakeFolders;
    expectIssue(missingV5Collection, 'audioTakeFolders', 'required');
  });
});

describe('setAutomationLaneBypassed', () => {
  it('returns one immutable lane-only change and preserves every unrelated value', () => {
    const project = projectWithLane();
    const before = structuredClone(project);
    const lane = project.automationLanes[0]!;
    const point = lane.points[0]!;

    const result = expectSuccess(setAutomationLaneBypassed(project, lane.id, true));

    expect(result).toMatchObject({
      changed: true,
      laneId: lane.id,
      trackId: lane.target.trackId,
    });
    expect(result.project).toEqual({
      ...project,
      automationLanes: [{ ...lane, bypassed: true }],
    });
    expect(result.project).not.toBe(project);
    expect(result.project.automationLanes).not.toBe(project.automationLanes);
    expect(result.project.automationLanes[0]).not.toBe(lane);
    expect(result.project.automationLanes[0]!.points).toBe(lane.points);
    expect(result.project.automationLanes[0]!.points[0]).toBe(point);
    expect(project).toEqual(before);
  });

  it('returns the exact Project reference for an equal value', () => {
    const project = projectWithLane();
    const lane = project.automationLanes[0]!;

    const result = expectSuccess(setAutomationLaneBypassed(project, lane.id, false));

    expect(result.changed).toBe(false);
    expect(result.project).toBe(project);
  });

  it('returns typed failures for a missing lane and invalid runtime input', () => {
    const project = projectWithLane();
    const laneId = project.automationLanes[0]!.id;

    expectFailure(
      setAutomationLaneBypassed(project, 'missing-lane', true),
      'lane-not-found',
    );
    expectFailure(
      setAutomationLaneBypassed(project, laneId, 'true' as never),
      'invalid-bypassed',
    );
    expectFailure(
      setAutomationLaneBypassed(project, laneId, null as never),
      'invalid-bypassed',
    );
  });

  it('preserves bypass while editing points and defaults a different new lane to Read', () => {
    const project = projectWithLane();
    const firstLane = project.automationLanes[0]!;
    const bypassed = expectSuccess(
      setAutomationLaneBypassed(project, firstLane.id, true),
    );
    const added = expectSuccess(addAutomationPoint(
      bypassed.project,
      {
        target: firstLane.target,
        beat: 3,
        value: 1.25,
        interpolation: 'hold',
      },
      { pointId: 'schema-v6-point-b' },
    ));
    const updated = expectSuccess(updateAutomationPoint(
      added.project,
      firstLane.id,
      'schema-v6-point-b',
      { beat: 4, value: 1.5 },
    ));
    const removed = expectSuccess(removeAutomationPoint(
      updated.project,
      firstLane.id,
      'schema-v6-point-a',
    ));
    const secondLane = expectSuccess(addAutomationPoint(
      removed.project,
      {
        target: {
          type: 'track-pan',
          trackId: firstLane.target.trackId,
        },
        beat: 0,
        value: 0,
        interpolation: 'hold',
      },
      { laneId: 'schema-v6-pan-lane', pointId: 'schema-v6-pan-point' },
    ));

    expect(added.project.automationLanes[0]!.bypassed).toBe(true);
    expect(updated.project.automationLanes[0]!.bypassed).toBe(true);
    expect(removed.project.automationLanes[0]!.bypassed).toBe(true);
    expect(removed.project.automationLanes[0]!.points).toEqual([{
      id: 'schema-v6-point-b',
      beat: 4,
      value: 1.5,
      interpolation: 'hold',
    }]);
    expect(secondLane.project.automationLanes[1]!.bypassed).toBe(false);
  });
});
