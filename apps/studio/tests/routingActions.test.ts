import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let trackActions: typeof import('../src/state/trackActions');
let routingActions: typeof import('../src/state/routingActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  trackActions = await import('../src/state/trackActions');
  routingActions = await import('../src/state/routingActions');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('ルーティング検証')).toBe(true);
});

function addBus(name: string): string {
  const result = trackActions.addStudioTrack({ kind: 'bus', name });
  if (!result.ok) throw new Error(`Bus fixture failed: ${result.code}`);
  return result.trackId;
}

function firstSource(project: Project): string {
  const source = project.tracks.find((track) => track.type !== 'master' && track.type !== 'bus');
  if (!source) throw new Error('source fixture missing');
  return source.id;
}

function startPlayback(): number {
  useStore.getState().play();
  const requestId = useStore.getState().transport.playbackRequestId;
  useStore.getState().confirmPlaybackStarted(requestId);
  return requestId;
}

describe('studio audio-routing commands', () => {
  it('explains every invalid-routing cause, including the project edge limit', () => {
    expect(routingActions.studioRoutingErrorMessage('invalid-routing')).toContain('接続数上限');
    expect(routingActions.studioRoutingErrorMessage('invalid-routing')).toContain('プロジェクトは変更されていません');
  });

  it('adds one post-fader send as one undoable project change', () => {
    const busId = addBus('Vocal Bus');
    const sourceId = firstSource(useStore.getState().project);
    const before = useStore.getState();

    const result = routingActions.addStudioAudioSend(sourceId, busId);
    expect(result).toMatchObject({ ok: true, changed: true, sourceTrackId: sourceId });
    if (!result.ok || result.sendId === undefined) throw new Error('send was not added');
    expect(useStore.getState().project.audioRouting.sends).toContainEqual({
      id: result.sendId,
      sourceTrackId: sourceId,
      targetBusId: busId,
      position: 'post-fader',
      gain: 1,
      enabled: true,
    });
    expect(useStore.getState().past).toHaveLength(before.past.length + 1);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision + 1);

    useStore.getState().undo();
    expect(useStore.getState().project.audioRouting.sends).toEqual([]);
  });

  it('keeps gain and enable live, but stops playback for a send position change', () => {
    const busId = addBus('FX Bus');
    const sourceId = firstSource(useStore.getState().project);
    const added = routingActions.addStudioAudioSend(sourceId, busId);
    if (!added.ok || added.sendId === undefined) throw new Error('send fixture missing');
    const requestId = startPlayback();

    expect(routingActions.updateStudioAudioSend(added.sendId, {
      gain: 0.25,
      enabled: false,
    })).toMatchObject({ ok: true, changed: true, playbackStopped: false });
    expect(useStore.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });

    expect(routingActions.updateStudioAudioSend(added.sendId, {
      position: 'pre-fader',
    })).toMatchObject({ ok: true, changed: true, playbackStopped: true });
    expect(useStore.getState().transport).toMatchObject({
      phase: 'stopped',
      playbackRequestId: requestId + 1,
    });
  });

  it('rejects output and send cycles without touching project, history, or playback', () => {
    const busA = addBus('Bus A');
    const busB = addBus('Bus B');
    expect(routingActions.setStudioTrackOutput(busA, {
      type: 'bus',
      trackId: busB,
    })).toMatchObject({ ok: true, changed: true });
    const requestId = startPlayback();
    const before = useStore.getState();
    const fingerprint = JSON.stringify(before.project);

    expect(routingActions.setStudioTrackOutput(busB, {
      type: 'bus',
      trackId: busA,
    })).toMatchObject({ ok: false, code: 'invalid-routing' });
    expect(JSON.stringify(useStore.getState().project)).toBe(fingerprint);
    expect(useStore.getState().past).toHaveLength(before.past.length);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
    expect(useStore.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });
  });

  it('keeps an already selected output out of history', () => {
    const sourceId = firstSource(useStore.getState().project);
    const before = useStore.getState();
    expect(routingActions.setStudioTrackOutput(sourceId, { type: 'master' })).toMatchObject({
      ok: true,
      changed: false,
      playbackStopped: false,
    });
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toHaveLength(before.past.length);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
  });
});
