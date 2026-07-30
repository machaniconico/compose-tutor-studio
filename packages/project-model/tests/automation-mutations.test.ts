import { describe, expect, it } from 'vitest';
import {
  addAutomationPoint,
  clearAutomationLane,
  createEmptyProject,
  MAX_AUTOMATION_POINTS_PER_LANE,
  removeAutomationPoint,
  updateAutomationPoint,
  type AddAutomationPointInput,
  type AutomationMutationErrorCode,
  type AutomationMutationResult,
  type Project,
} from '../src/index';

const clock = () => new Date('2026-07-28T00:00:00.000Z');

function fixture(): Readonly<{
  project: Project;
  trackId: string;
  masterTrackId: string;
}> {
  const project = createEmptyProject({ clock, lengthBars: 2 });
  const track = project.tracks.find((candidate) => candidate.type !== 'master');
  const master = project.tracks.find((candidate) => candidate.type === 'master');
  if (track === undefined || master === undefined) throw new Error('invalid fixture');
  return { project, trackId: track.id, masterTrackId: master.id };
}

function input(
  trackId: string,
  overrides: Partial<AddAutomationPointInput> = {},
): AddAutomationPointInput {
  return {
    target: { type: 'track-volume', trackId },
    beat: 1,
    value: 1,
    interpolation: 'linear',
    ...overrides,
  };
}

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

describe('automation mutations', () => {
  it('lazily creates a target lane with globally stable injected ids', () => {
    const { project, trackId } = fixture();
    const before = structuredClone(project);
    const kinds: string[] = [];

    const result = expectSuccess(addAutomationPoint(
      project,
      input(trackId),
      {
        idFactory: (kind) => {
          kinds.push(kind);
          return kind === 'lane' ? 'automation-lane-a' : 'automation-point-a';
        },
      },
    ));

    expect(result).toMatchObject({
      changed: true,
      trackId,
      laneId: 'automation-lane-a',
      pointId: 'automation-point-a',
    });
    expect(result.project).not.toBe(project);
    expect(result.project.automationLanes).toEqual([{
      id: 'automation-lane-a',
      bypassed: false,
      target: { type: 'track-volume', trackId },
      points: [{
        id: 'automation-point-a',
        beat: 1,
        value: 1,
        interpolation: 'linear',
      }],
    }]);
    expect(kinds).toEqual(['lane', 'point']);
    expect(project).toEqual(before);
  });

  it('reuses target lanes and keeps added points strictly beat-sorted', () => {
    const { project, trackId } = fixture();
    const first = expectSuccess(addAutomationPoint(
      project,
      input(trackId, { beat: 6, value: 2, interpolation: 'hold' }),
      { laneId: 'lane-a', pointId: 'point-late' },
    ));
    const second = expectSuccess(addAutomationPoint(
      first.project,
      input(trackId, { beat: 0, value: 0 }),
      { pointId: 'point-early', idFactory: () => 'must-not-create-another-lane' },
    ));

    expect(second.laneId).toBe(first.laneId);
    expect(second.project.automationLanes).toHaveLength(1);
    expect(second.project.automationLanes[0]?.points.map((point) => point.id)).toEqual([
      'point-early',
      'point-late',
    ]);
    expect(second.project.automationLanes[0]?.points.map((point) => point.beat)).toEqual([0, 6]);
    expect(first.project.automationLanes[0]?.points).toEqual([{
      id: 'point-late',
      beat: 6,
      value: 2,
      interpolation: 'hold',
    }]);
  });

  it('supports inclusive volume and pan boundaries in independent lanes', () => {
    const { project, trackId } = fixture();
    const volumeZero = expectSuccess(addAutomationPoint(
      project,
      input(trackId, { beat: 0, value: 0 }),
      { laneId: 'volume-lane', pointId: 'volume-zero' },
    ));
    const volumeTwo = expectSuccess(addAutomationPoint(
      volumeZero.project,
      input(trackId, { beat: volumeZero.project.lengthBeats, value: 2 }),
      { pointId: 'volume-two' },
    ));
    const panLeft = expectSuccess(addAutomationPoint(
      volumeTwo.project,
      input(trackId, {
        target: { type: 'track-pan', trackId },
        beat: 0,
        value: -1,
        interpolation: 'hold',
      }),
      { laneId: 'pan-lane', pointId: 'pan-left' },
    ));
    const panRight = expectSuccess(addAutomationPoint(
      panLeft.project,
      input(trackId, {
        target: { type: 'track-pan', trackId },
        beat: panLeft.project.lengthBeats,
        value: 1,
      }),
      { pointId: 'pan-right' },
    ));

    expect(panRight.project.automationLanes).toHaveLength(2);
    expect(panRight.project.automationLanes.map((lane) => lane.target.type)).toEqual([
      'track-volume',
      'track-pan',
    ]);
  });

  it('updates and reorders a point without changing its stable id or source objects', () => {
    const { project, trackId } = fixture();
    const first = expectSuccess(addAutomationPoint(
      project,
      input(trackId, { beat: 1 }),
      { laneId: 'lane-a', pointId: 'point-a' },
    ));
    const second = expectSuccess(addAutomationPoint(
      first.project,
      input(trackId, { beat: 4 }),
      { pointId: 'point-b' },
    ));
    const before = structuredClone(second.project);

    const updated = expectSuccess(updateAutomationPoint(
      second.project,
      'lane-a',
      'point-b',
      { beat: 0, value: 1.5, interpolation: 'hold' },
    ));

    expect(updated.pointId).toBe('point-b');
    expect(updated.project.automationLanes[0]?.points).toEqual([
      { id: 'point-b', beat: 0, value: 1.5, interpolation: 'hold' },
      { id: 'point-a', beat: 1, value: 1, interpolation: 'linear' },
    ]);
    expect(second.project).toEqual(before);
  });

  it('returns the exact Project reference for semantic update no-ops', () => {
    const { project, trackId } = fixture();
    const added = expectSuccess(addAutomationPoint(
      project,
      input(trackId),
      { laneId: 'lane-a', pointId: 'point-a' },
    ));

    const emptyPatch = expectSuccess(updateAutomationPoint(
      added.project,
      'lane-a',
      'point-a',
      {},
    ));
    const exactPatch = expectSuccess(updateAutomationPoint(
      added.project,
      'lane-a',
      'point-a',
      { beat: 1, value: 1, interpolation: 'linear' },
    ));

    expect(emptyPatch.changed).toBe(false);
    expect(emptyPatch.project).toBe(added.project);
    expect(exactPatch.changed).toBe(false);
    expect(exactPatch.project).toBe(added.project);
  });

  it('rejects exact add and move collisions atomically', () => {
    const { project, trackId } = fixture();
    const first = expectSuccess(addAutomationPoint(
      project,
      input(trackId, { beat: 1 }),
      { laneId: 'lane-a', pointId: 'point-a' },
    ));
    const second = expectSuccess(addAutomationPoint(
      first.project,
      input(trackId, { beat: 2 }),
      { pointId: 'point-b' },
    ));
    const before = structuredClone(second.project);

    expectFailure(addAutomationPoint(
      second.project,
      input(trackId, { beat: 2, value: 0.5 }),
      { pointId: 'point-c' },
    ), 'point-beat-conflict');
    expectFailure(updateAutomationPoint(
      second.project,
      'lane-a',
      'point-b',
      { beat: 1 },
    ), 'point-beat-conflict');
    expect(second.project).toEqual(before);
  });

  it('removes points immutably and prunes a lane after its final point', () => {
    const { project, trackId } = fixture();
    const first = expectSuccess(addAutomationPoint(
      project,
      input(trackId, { beat: 1 }),
      { laneId: 'lane-a', pointId: 'point-a' },
    ));
    const second = expectSuccess(addAutomationPoint(
      first.project,
      input(trackId, { beat: 2 }),
      { pointId: 'point-b' },
    ));

    const removedOne = expectSuccess(removeAutomationPoint(
      second.project,
      'lane-a',
      'point-a',
    ));
    expect(removedOne.project.automationLanes[0]?.points.map((point) => point.id)).toEqual([
      'point-b',
    ]);
    expect(second.project.automationLanes[0]?.points).toHaveLength(2);

    const removedFinal = expectSuccess(removeAutomationPoint(
      removedOne.project,
      'lane-a',
      'point-b',
    ));
    expect(removedFinal.project.automationLanes).toEqual([]);
    expect(removedFinal).toMatchObject({
      trackId,
      laneId: 'lane-a',
      pointId: 'point-b',
      changed: true,
    });
  });

  it('clears a whole lane while leaving other targets unchanged', () => {
    const { project, trackId } = fixture();
    const volume = expectSuccess(addAutomationPoint(
      project,
      input(trackId),
      { laneId: 'volume-lane', pointId: 'volume-point' },
    ));
    const pan = expectSuccess(addAutomationPoint(
      volume.project,
      input(trackId, { target: { type: 'track-pan', trackId }, value: 0 }),
      { laneId: 'pan-lane', pointId: 'pan-point' },
    ));

    const cleared = expectSuccess(clearAutomationLane(pan.project, 'volume-lane'));

    expect(cleared.pointId).toBeUndefined();
    expect(cleared.project.automationLanes).toEqual([
      pan.project.automationLanes.find((lane) => lane.id === 'pan-lane'),
    ]);
    expect(pan.project.automationLanes).toHaveLength(2);
  });

  it('allows effective-Master volume but rejects pan, later Masters, and invalid targets', () => {
    const { project, trackId, masterTrackId } = fixture();

    expectFailure(addAutomationPoint(
      project,
      input('missing-track'),
    ), 'track-not-found');
    const masterVolume = expectSuccess(addAutomationPoint(
      project,
      input(masterTrackId),
      { laneId: 'master-volume-lane', pointId: 'master-volume-point' },
    ));
    expect(masterVolume.project.automationLanes[0]?.target).toEqual({
      type: 'track-volume',
      trackId: masterTrackId,
    });
    expectFailure(addAutomationPoint(
      masterVolume.project,
      input(masterTrackId, {
        target: { type: 'track-pan', trackId: masterTrackId },
        value: 0,
      }),
    ), 'master-protected');
    const effectiveMaster = project.tracks.find((track) => track.id === masterTrackId)!;
    const compatibilityMaster = {
      ...structuredClone(effectiveMaster),
      id: 'automation-compatibility-master',
    };
    expectFailure(addAutomationPoint(
      { ...project, tracks: [...project.tracks, compatibilityMaster] },
      input(compatibilityMaster.id),
    ), 'master-protected');
    expectFailure(addAutomationPoint(
      project,
      input(trackId, {
        target: { type: 'track-gain', trackId } as never,
      }),
    ), 'invalid-target');
    expectFailure(addAutomationPoint(
      project,
      { beat: 1, value: 1, interpolation: 'linear' } as never,
    ), 'invalid-target');
  });

  it.each([
    ['negative beat', { beat: -1 }, 'invalid-beat'],
    ['non-finite beat', { beat: Number.NaN }, 'invalid-beat'],
    ['late beat', { beat: 9 }, 'invalid-beat'],
    ['high volume', { value: 2.01 }, 'invalid-value'],
    ['non-finite value', { value: Number.POSITIVE_INFINITY }, 'invalid-value'],
    ['invalid interpolation', { interpolation: 'curve' as never }, 'invalid-interpolation'],
  ] as const)('rejects %s without changing the source', (_name, overrides, code) => {
    const { project, trackId } = fixture();
    const before = structuredClone(project);

    expectFailure(
      addAutomationPoint(project, input(trackId, overrides)),
      code,
    );
    expect(project).toEqual(before);
  });

  it('validates update patches against their lane target', () => {
    const { project, trackId } = fixture();
    const added = expectSuccess(addAutomationPoint(
      project,
      input(trackId, { target: { type: 'track-pan', trackId }, value: 0 }),
      { laneId: 'pan-lane', pointId: 'pan-point' },
    ));

    expectFailure(updateAutomationPoint(
      added.project,
      'pan-lane',
      'pan-point',
      { beat: -0.1 },
    ), 'invalid-beat');
    expectFailure(updateAutomationPoint(
      added.project,
      'pan-lane',
      'pan-point',
      { value: 1.1 },
    ), 'invalid-value');
    expectFailure(updateAutomationPoint(
      added.project,
      'pan-lane',
      'pan-point',
      { interpolation: 'spline' as never },
    ), 'invalid-interpolation');
  });

  it('returns typed lookup failures for missing lanes and points', () => {
    const { project, trackId } = fixture();
    expectFailure(updateAutomationPoint(project, 'missing', 'point', {}), 'lane-not-found');
    expectFailure(removeAutomationPoint(project, 'missing', 'point'), 'lane-not-found');
    expectFailure(clearAutomationLane(project, 'missing'), 'lane-not-found');

    const added = expectSuccess(addAutomationPoint(
      project,
      input(trackId),
      { laneId: 'lane-a', pointId: 'point-a' },
    ));
    expectFailure(updateAutomationPoint(
      added.project,
      'lane-a',
      'missing',
      {},
    ), 'point-not-found');
    expectFailure(removeAutomationPoint(
      added.project,
      'lane-a',
      'missing',
    ), 'point-not-found');
  });

  it('rejects duplicate, malformed, and throwing id factories atomically', () => {
    const { project, trackId } = fixture();
    const existingClipId = project.tracks[0]?.clips[0]?.id;
    if (existingClipId === undefined) throw new Error('invalid fixture');
    const before = structuredClone(project);

    expectFailure(addAutomationPoint(
      project,
      input(trackId),
      { laneId: 'lane-a', pointId: existingClipId },
    ), 'duplicate-id');
    expectFailure(addAutomationPoint(
      project,
      input(trackId),
      { idFactory: () => '' },
    ), 'id-factory-failed');
    expectFailure(addAutomationPoint(
      project,
      input(trackId),
      { idFactory: () => { throw new Error('boom'); } },
    ), 'id-factory-failed');
    expectFailure(addAutomationPoint(
      project,
      input(trackId),
      { idFactory: () => 'same-id' },
    ), 'duplicate-id');
    expect(project).toEqual(before);
  });

  it('enforces the per-lane point cap before allocating another id', () => {
    const { project, trackId } = fixture();
    const points = Array.from({ length: MAX_AUTOMATION_POINTS_PER_LANE }, (_, index) => ({
      id: `capacity-point-${index}`,
      beat: index * project.lengthBeats / MAX_AUTOMATION_POINTS_PER_LANE,
      value: 1,
      interpolation: 'linear' as const,
    }));
    const full: Project = {
      ...project,
      automationLanes: [{
        id: 'capacity-lane',
        bypassed: false,
        target: { type: 'track-volume', trackId },
        points,
      }],
    };
    let idCalls = 0;

    expectFailure(addAutomationPoint(
      full,
      input(trackId, { beat: project.lengthBeats }),
      { idFactory: () => {
        idCalls += 1;
        return 'not-allocated';
      } },
    ), 'point-limit');
    expect(idCalls).toBe(0);
    expect(full.automationLanes[0]?.points).toBe(points);
  });

  it('fails closed for invalid sources without throwing', () => {
    const { project, trackId } = fixture();
    const invalid: Project = {
      ...project,
      automationLanes: [{
        id: 'invalid-lane',
        bypassed: false,
        target: { type: 'track-volume', trackId },
        points: [
          { id: 'point-late', beat: 2, value: 1, interpolation: 'linear' },
          { id: 'point-early', beat: 1, value: 1, interpolation: 'linear' },
        ],
      }],
    };
    const throwing = Object.defineProperty(
      { ...project },
      'automationLanes',
      { get: () => { throw new Error('hostile getter'); } },
    ) as Project;

    expectFailure(addAutomationPoint(
      invalid,
      input(trackId, { beat: 3 }),
    ), 'project-not-adoptable');
    expect(() => addAutomationPoint(
      throwing,
      input(trackId),
    )).not.toThrow();
    expectFailure(addAutomationPoint(
      throwing,
      input(trackId),
    ), 'project-not-adoptable');
  });

  it('codec-rejects an adversarial invalid candidate atomically', () => {
    const { project, trackId } = fixture();
    let reads = 0;
    const volatileInput = {
      target: { type: 'track-volume', trackId },
      beat: 1,
      get value() {
        reads += 1;
        return reads === 1 ? 1 : 3;
      },
      interpolation: 'linear',
    } as AddAutomationPointInput;
    const before = structuredClone(project);

    const result = expectFailure(addAutomationPoint(
      project,
      volatileInput,
      { laneId: 'lane-a', pointId: 'point-a' },
    ), 'invalid-automation');

    expect(result.error.issues?.some((issue) =>
      issue.path === 'automationLanes[0].points[0].value')).toBe(true);
    expect(project).toEqual(before);
  });
});
