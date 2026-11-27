import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compileAudioRouting, type Project } from '@cts/project-model';
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
  expect(await useStore.getState().createNewProject('リターン検証')).toBe(true);
});

function sources(project: Project) {
  return project.tracks.filter((track) => track.type !== 'master' && track.type !== 'bus');
}

function reverbReturns(project: Project) {
  return project.tracks.filter(
    (track) => track.type === 'bus' && track.effects.some((fx) => fx.type === 'reverb'),
  );
}

describe('addStudioReverbReturn', () => {
  it('creates the return, its reverb and a post-fader send as one undo step', () => {
    const before = useStore.getState();
    const sourceId = sources(before.project)[0]!.id;

    const result = routingActions.addStudioReverbReturn(sourceId);
    expect(result).toMatchObject({ ok: true, changed: true, reusedReturn: false });
    if (!result.ok) throw new Error('unreachable');

    const after = useStore.getState();
    expect(after.past).toHaveLength(before.past.length + 1);
    const returns = reverbReturns(after.project);
    expect(returns).toHaveLength(1);
    expect(returns[0]!.id).toBe(result.returnId);
    expect(returns[0]!.effects).toHaveLength(1);
    expect(returns[0]!.effects[0]).toMatchObject({ type: 'reverb', enabled: true });
    expect(after.project.audioRouting.sends).toEqual([
      expect.objectContaining({
        id: result.sendId,
        sourceTrackId: sourceId,
        targetBusId: result.returnId,
        position: 'post-fader',
        gain: routingActions.REVERB_RETURN_SEND_GAIN,
        enabled: true,
      }),
    ]);

    after.undo();
    const undone = useStore.getState().project;
    expect(reverbReturns(undone)).toHaveLength(0);
    expect(undone.tracks).toHaveLength(before.project.tracks.length);
    expect(undone.audioRouting.sends).toEqual([]);
  });

  it('reuses the existing return for another track and does not duplicate it', () => {
    const [first, second] = sources(useStore.getState().project);
    const a = routingActions.addStudioReverbReturn(first!.id);
    if (!a.ok) throw new Error('first call failed');
    const trackCount = useStore.getState().project.tracks.length;

    const b = routingActions.addStudioReverbReturn(second!.id);
    expect(b).toMatchObject({ ok: true, changed: true, reusedReturn: true, returnId: a.returnId });
    expect(useStore.getState().project.tracks).toHaveLength(trackCount);
    expect(reverbReturns(useStore.getState().project)).toHaveLength(1);
    expect(useStore.getState().project.audioRouting.sends).toHaveLength(2);
  });

  it('is idempotent for a track that already sends to the return', () => {
    const sourceId = sources(useStore.getState().project)[0]!.id;
    routingActions.addStudioReverbReturn(sourceId);
    const before = useStore.getState();

    const again = routingActions.addStudioReverbReturn(sourceId);
    expect(again).toMatchObject({ ok: true, changed: false, reusedReturn: true });
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toHaveLength(before.past.length);
  });

  it('reuses a reverb bus the user built by hand', () => {
    const bus = trackActions.addStudioTrack({ kind: 'bus', name: 'My Room' });
    if (!bus.ok) throw new Error('bus fixture failed');
    const effectId = 'fx-manual';
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === bus.trackId
          ? { ...track, effects: [{ id: effectId, type: 'reverb' as const, enabled: true, params: { wet: 1, decay: 0.5 } }] }
          : track),
    }));
    const trackCount = useStore.getState().project.tracks.length;
    const sourceId = sources(useStore.getState().project)[0]!.id;

    const result = routingActions.addStudioReverbReturn(sourceId);
    expect(result).toMatchObject({ ok: true, reusedReturn: true, returnId: bus.trackId });
    expect(useStore.getState().project.tracks).toHaveLength(trackCount);
  });

  it('compiles to a post-fader send into a bus that outputs to the master', () => {
    const sourceId = sources(useStore.getState().project)[0]!.id;
    const result = routingActions.addStudioReverbReturn(sourceId);
    if (!result.ok) throw new Error('call failed');

    const compiled = compileAudioRouting(useStore.getState().project);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const sends = compiled.plan.sendsBySource[sourceId]!;
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      targetBusId: result.returnId,
      position: 'post-fader',
      gain: routingActions.REVERB_RETURN_SEND_GAIN,
      enabled: true,
    });
    expect(compiled.plan.outputsBySource[result.returnId]!.destination).toEqual({ type: 'master' });
    const order = compiled.plan.topologicalTrackIds;
    expect(order.indexOf(sourceId)).toBeLessThan(order.indexOf(result.returnId));
  });

  it('rejects the master and bus tracks without changing the project', () => {
    const project = useStore.getState().project;
    const master = project.tracks.find((track) => track.type === 'master')!;
    const bus = trackActions.addStudioTrack({ kind: 'bus', name: 'Plain Bus' });
    if (!bus.ok) throw new Error('bus fixture failed');
    const snapshot = useStore.getState().project;

    expect(routingActions.addStudioReverbReturn(master.id)).toEqual({ ok: false, code: 'master-protected' });
    expect(routingActions.addStudioReverbReturn(bus.trackId)).toEqual({ ok: false, code: 'invalid-source' });
    expect(routingActions.addStudioReverbReturn('missing')).toEqual({ ok: false, code: 'track-not-found' });
    expect(useStore.getState().project).toBe(snapshot);
  });
});
