import { describe, expect, it } from 'vitest';
import {
  addAudioSend,
  addTrack,
  createEmptyProject,
  removeAudioSend,
  setTrackOutput,
  updateAudioSend,
  validateProject,
  type AudioRoutingMutationResult,
  type Project,
} from '../src/index';

const clock = () => new Date('2026-07-17T01:00:00.000Z');

function expectSuccess(result: AudioRoutingMutationResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function expectFailure(result: AudioRoutingMutationResult, code: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected routing mutation failure');
  expect(result.error.code).toBe(code);
  return result;
}

function projectWithBuses(): { project: Project; busA: string; busB: string } {
  const project = createEmptyProject({ clock });
  const first = addTrack(project, 'bus', {
    name: 'Bus A',
    idFactory: () => 'bus-a',
  });
  if (!first.ok) throw new Error(first.error.message);
  const second = addTrack(first.project, 'bus', {
    name: 'Bus B',
    idFactory: () => 'bus-b',
  });
  if (!second.ok) throw new Error(second.error.message);
  return { project: second.project, busA: first.trackId, busB: second.trackId };
}

describe('audio routing mutations', () => {
  it('sets a main output immutably, reports no-op identity, and rejects a cycle atomically', () => {
    const { project, busA, busB } = projectWithBuses();
    const source = project.tracks[0]!;
    const routed = expectSuccess(setTrackOutput(project, source.id, { type: 'bus', trackId: busA }));

    expect(routed.changed).toBe(true);
    expect(project.audioRouting.outputs.find(
      (output) => output.sourceTrackId === source.id,
    )?.destination).toEqual({ type: 'master' });
    const noOp = expectSuccess(setTrackOutput(
      routed.project,
      source.id,
      { type: 'bus', trackId: busA },
    ));
    expect(noOp.changed).toBe(false);
    expect(noOp.project).toBe(routed.project);

    const aToB = expectSuccess(setTrackOutput(
      routed.project,
      busA,
      { type: 'bus', trackId: busB },
    ));
    const beforeCycle = structuredClone(aToB.project);
    const cycle = expectFailure(
      setTrackOutput(aToB.project, busB, { type: 'bus', trackId: busA }),
      'invalid-routing',
    );
    expect(cycle.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'audioRouting', message: expect.stringContaining('acyclic') }),
    ]));
    expect(aToB.project).toEqual(beforeCycle);
  });

  it('adds, updates, and removes a stable send with injected ids and no-op updates', () => {
    const { project, busA, busB } = projectWithBuses();
    const source = project.tracks[0]!;
    let factoryCalls = 0;
    const added = expectSuccess(addAudioSend(project, {
      sourceTrackId: source.id,
      targetBusId: busA,
      position: 'post-fader',
      gain: 0.5,
      enabled: true,
    }, {
      idFactory: (kind) => `${kind}-${++factoryCalls}`,
    }));

    expect(added.sendId).toBe('send-1');
    expect(factoryCalls).toBe(1);
    expect(project.audioRouting.sends).toEqual([]);
    const updated = expectSuccess(updateAudioSend(added.project, added.sendId!, {
      targetBusId: busB,
      position: 'pre-fader',
      gain: 0,
      enabled: false,
    }));
    expect(updated.project.audioRouting.sends[0]).toEqual({
      id: added.sendId,
      sourceTrackId: source.id,
      targetBusId: busB,
      position: 'pre-fader',
      gain: 0,
      enabled: false,
    });
    const noOp = expectSuccess(updateAudioSend(updated.project, added.sendId!, {
      gain: 0,
      enabled: false,
    }));
    expect(noOp.changed).toBe(false);
    expect(noOp.project).toBe(updated.project);

    const removed = expectSuccess(removeAudioSend(updated.project, added.sendId!));
    expect(removed.project.audioRouting.sends).toEqual([]);
    expect(validateProject(removed.project).ok).toBe(true);
    expectFailure(removeAudioSend(removed.project, added.sendId!), 'send-not-found');
  });

  it('rejects collisions, duplicates, malformed factories, and update-created cycles without mutation', () => {
    const { project, busA, busB } = projectWithBuses();
    const source = project.tracks[0]!;
    const input = {
      sourceTrackId: source.id,
      targetBusId: busA,
      position: 'post-fader' as const,
      gain: 1,
      enabled: true,
    };
    expectFailure(addAudioSend(project, input, { id: project.id }), 'duplicate-id');
    expectFailure(addAudioSend(project, input, { idFactory: () => '' }), 'id-factory-failed');
    expect(() => addAudioSend(project, input, {
      idFactory: () => { throw new Error('boom'); },
    })).not.toThrow();

    const added = expectSuccess(addAudioSend(project, input, { id: 'send-a' }));
    const beforeDuplicate = structuredClone(added.project);
    expectFailure(addAudioSend(added.project, input, { id: 'send-b' }), 'invalid-routing');
    expect(added.project).toEqual(beforeDuplicate);

    const aToB = expectSuccess(setTrackOutput(project, busA, { type: 'bus', trackId: busB }));
    expectFailure(addAudioSend(aToB.project, {
      sourceTrackId: busB,
      targetBusId: busA,
      position: 'pre-fader',
      gain: 0,
      enabled: false,
    }, { id: 'cycle-send' }), 'invalid-routing');

    const third = addTrack(project, 'bus', {
      name: 'Bus C',
      idFactory: () => 'bus-c',
    });
    if (!third.ok) throw new Error(third.error.message);
    const backward = expectSuccess(addAudioSend(third.project, {
      sourceTrackId: busB,
      targetBusId: busA,
      position: 'post-fader',
      gain: 1,
      enabled: true,
    }, { id: 'backward-send' }));
    const forward = expectSuccess(addAudioSend(backward.project, {
      sourceTrackId: busA,
      targetBusId: third.trackId,
      position: 'post-fader',
      gain: 1,
      enabled: true,
    }, { id: 'forward-send' }));
    const beforeCycleUpdate = structuredClone(forward.project);
    expectFailure(
      updateAudioSend(forward.project, 'forward-send', { targetBusId: busB }),
      'invalid-routing',
    );
    expect(forward.project).toEqual(beforeCycleUpdate);
  });
});
