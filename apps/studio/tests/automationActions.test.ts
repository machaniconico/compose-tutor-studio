import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AutomationLane, Project } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let automationActions: typeof import('../src/state/automationActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  automationActions = await import('../src/state/automationActions');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false });
  expect(await useStore.getState().createNewProject('オートメーション検証')).toBe(true);
});

function firstEditableTrackId(): string {
  const track = useStore.getState().project.tracks.find(
    (candidate) => candidate.type !== 'master',
  );
  if (!track) throw new Error('editable track fixture missing');
  return track.id;
}

function volumeLane(): AutomationLane {
  const lane = useStore.getState().project.automationLanes.find(
    (candidate) => candidate.target.type === 'track-volume',
  );
  if (!lane) throw new Error('volume lane fixture missing');
  return lane;
}

function addVolumePoint(beat = 2, value = 0.75) {
  return automationActions.addStudioAutomationPoint(
    { type: 'track-volume', trackId: firstEditableTrackId() },
    { beat, value, interpolation: 'linear' },
  );
}

function startPlayback(): number {
  useStore.getState().play();
  const requestId = useStore.getState().transport.playbackRequestId;
  useStore.getState().confirmPlaybackStarted(requestId);
  return requestId;
}

function expectMutationStateUnchanged(
  before: ReturnType<typeof useStore.getState>,
): void {
  const after = useStore.getState();
  expect(after.project).toBe(before.project);
  expect(after.past).toBe(before.past);
  expect(after.future).toBe(before.future);
  expect(after.saveState).toBe(before.saveState);
  expect(after.transport).toBe(before.transport);
}

function expectProjectRestoredAfterUndo(expected: Project): void {
  const restored = useStore.getState().project;
  expect(restored.automationLanes).toBe(expected.automationLanes);
  expect({ ...restored, updatedAt: expected.updatedAt }).toEqual(expected);
}

describe('studio automation commands', () => {
  it('adds and clears a lane as one undoable saved project change each', () => {
    const before = useStore.getState();
    const added = addVolumePoint();

    expect(added).toMatchObject({
      ok: true,
      changed: true,
      trackId: firstEditableTrackId(),
      playbackStopped: false,
    });
    if (!added.ok || added.pointId === undefined) {
      throw new Error('automation point was not added');
    }
    expect(volumeLane()).toMatchObject({
      id: added.laneId,
      target: { type: 'track-volume', trackId: firstEditableTrackId() },
      points: [{
        id: added.pointId,
        beat: 2,
        value: 0.75,
        interpolation: 'linear',
      }],
    });
    expect(useStore.getState().past).toHaveLength(before.past.length + 1);
    expect(useStore.getState().saveState.revision).toBe(
      before.saveState.revision + 1,
    );

    useStore.getState().undo();
    expect(useStore.getState().project.automationLanes).toEqual([]);
    useStore.getState().redo();
    expect(volumeLane().id).toBe(added.laneId);

    const beforeClear = useStore.getState();
    expect(automationActions.clearStudioAutomationLane(added.laneId)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(useStore.getState().project.automationLanes).toEqual([]);
    expect(useStore.getState().past).toHaveLength(beforeClear.past.length + 1);
    expect(useStore.getState().saveState.revision).toBe(
      beforeClear.saveState.revision + 1,
    );
  });

  it('keeps a semantic no-op out of history and the save revision', () => {
    const added = addVolumePoint();
    if (!added.ok || added.pointId === undefined) {
      throw new Error('automation point fixture missing');
    }
    const before = useStore.getState();

    expect(automationActions.updateStudioAutomationPoint(
      added.laneId,
      added.pointId,
      { beat: 2, value: 0.75, interpolation: 'linear' },
    )).toMatchObject({
      ok: true,
      changed: false,
      playbackStopped: false,
    });
    expectMutationStateUnchanged(before);
  });

  it('records one update change and one Undo restores its exact prior content', () => {
    const added = addVolumePoint();
    if (!added.ok || added.pointId === undefined) {
      throw new Error('automation point fixture missing');
    }
    const beforeUpdate = useStore.getState();

    expect(automationActions.updateStudioAutomationPoint(
      added.laneId,
      added.pointId,
      { beat: 3, value: 1.25, interpolation: 'hold' },
    )).toMatchObject({
      ok: true,
      changed: true,
      laneId: added.laneId,
      pointId: added.pointId,
    });
    const afterUpdate = useStore.getState();
    expect(afterUpdate.past).toHaveLength(beforeUpdate.past.length + 1);
    expect(afterUpdate.past.at(-1)).toBe(beforeUpdate.project);
    expect(afterUpdate.saveState.revision).toBe(beforeUpdate.saveState.revision + 1);
    expect(volumeLane().points).toEqual([{
      id: added.pointId,
      beat: 3,
      value: 1.25,
      interpolation: 'hold',
    }]);

    useStore.getState().undo();
    expectProjectRestoredAfterUndo(beforeUpdate.project);
  });

  it('records one removal change and one Undo restores its exact prior content', () => {
    const first = addVolumePoint();
    const second = addVolumePoint(4, 1);
    if (
      !first.ok
      || first.pointId === undefined
      || !second.ok
      || second.pointId === undefined
    ) {
      throw new Error('automation point fixtures missing');
    }
    const beforeRemove = useStore.getState();

    expect(automationActions.removeStudioAutomationPoint(
      second.laneId,
      second.pointId,
    )).toMatchObject({
      ok: true,
      changed: true,
      laneId: second.laneId,
      pointId: second.pointId,
    });
    const afterRemove = useStore.getState();
    expect(afterRemove.past).toHaveLength(beforeRemove.past.length + 1);
    expect(afterRemove.past.at(-1)).toBe(beforeRemove.project);
    expect(afterRemove.saveState.revision).toBe(beforeRemove.saveState.revision + 1);
    expect(volumeLane().points.map((point) => point.id)).toEqual([first.pointId]);

    useStore.getState().undo();
    expectProjectRestoredAfterUndo(beforeRemove.project);
  });

  it('stops active playback once when an automation snapshot changes', () => {
    const requestId = startPlayback();
    const added = addVolumePoint();

    expect(added).toMatchObject({
      ok: true,
      changed: true,
      playbackStopped: true,
    });
    expect(useStore.getState().transport).toMatchObject({
      phase: 'stopped',
      playbackRequestId: requestId + 1,
    });
  });

  it('rejects collisions and Master targets without touching state', () => {
    const added = addVolumePoint();
    if (!added.ok || added.pointId === undefined) {
      throw new Error('automation point fixture missing');
    }
    const second = addVolumePoint(4, 1);
    if (!second.ok || second.pointId === undefined) {
      throw new Error('second point fixture missing');
    }
    const beforeCollision = useStore.getState();

    expect(automationActions.updateStudioAutomationPoint(
      second.laneId,
      second.pointId,
      { beat: 2 },
    )).toEqual({ ok: false, code: 'point-beat-conflict' });
    expectMutationStateUnchanged(beforeCollision);

    const master = useStore.getState().project.tracks.find(
      (track) => track.type === 'master',
    );
    if (!master) throw new Error('Master fixture missing');
    const beforeMaster = useStore.getState();
    expect(automationActions.addStudioAutomationPoint(
      { type: 'track-pan', trackId: master.id },
      { beat: 1, value: 0, interpolation: 'hold' },
    )).toEqual({ ok: false, code: 'master-protected' });
    expectMutationStateUnchanged(beforeMaster);
  });

  it('does not overwrite a project change that wins the snapshot race', () => {
    const before = useStore.getState();
    const originalApplyProjectChange = before.applyProjectChange;
    useStore.setState({
      applyProjectChange: () => {
        expect(originalApplyProjectChange((project) => ({
          ...project,
          title: '先に反映された変更',
        }))).toBe(true);
        return false;
      },
    });

    try {
      expect(addVolumePoint()).toEqual({ ok: false, code: 'commit-rejected' });
      expect(useStore.getState().project.title).toBe('先に反映された変更');
      expect(useStore.getState().project.automationLanes).toEqual([]);
      expect(useStore.getState().past).toHaveLength(before.past.length + 1);
      expect(useStore.getState().saveState.revision).toBe(
        before.saveState.revision + 1,
      );
    } finally {
      useStore.setState({ applyProjectChange: originalApplyProjectChange });
    }
  });

  it('fails compare-and-swap adoption while a project operation is busy', () => {
    const before = useStore.getState();
    useStore.setState({ projectOperationBusy: true });
    try {
      expect(addVolumePoint()).toEqual({ ok: false, code: 'commit-rejected' });
      expect(useStore.getState().project).toBe(before.project);
      expect(useStore.getState().past).toHaveLength(before.past.length);
      expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
    } finally {
      useStore.setState({ projectOperationBusy: false });
    }
  });

  it('maps every common correction into plain actionable Japanese', () => {
    expect(
      automationActions.studioAutomationErrorMessage('point-beat-conflict'),
    ).toContain('同じ位置');
    expect(
      automationActions.studioAutomationErrorMessage('invalid-value'),
    ).toContain('音量は0〜200%');
    expect(
      automationActions.studioAutomationErrorMessage('master-protected'),
    ).toContain('通常トラックまたはバス');
    expect(
      automationActions.studioAutomationErrorMessage('commit-rejected'),
    ).toContain('最新の状態');
  });
});
