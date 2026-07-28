import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@cts/project-model';
import type { StudioTempoMapErrorCode } from '../src/state/tempoMapActions';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let tempoMapActions: typeof import('../src/state/tempoMapActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  tempoMapActions = await import('../src/state/tempoMapActions');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({
    projectOperationBusy: false,
    audioRecordingOperationId: null,
  });
  expect(await useStore.getState().createNewProject('テンポ・拍子検証')).toBe(true);
});

function mapSnapshot(project: Project) {
  return {
    tempoMap: project.tempoMap.map((event) => ({ ...event })),
    timeSignatureMap: project.timeSignatureMap.map((event) => ({ ...event })),
    bpm: project.bpm,
    timeSignature: [...project.timeSignature],
    lengthBars: project.lengthBars,
  };
}

function expectMutationStateUnchanged(
  before: ReturnType<typeof useStore.getState>,
): void {
  const after = useStore.getState();
  expect(after.project).toBe(before.project);
  expect(after.past).toBe(before.past);
  expect(after.future).toBe(before.future);
  expect(after.saveState).toBe(before.saveState);
  expect(after.editor).toBe(before.editor);
  expect(after.transport).toBe(before.transport);
  expect(after.persistenceNotice).toBe(before.persistenceNotice);
  expect(after.projectOperationBusy).toBe(before.projectOperationBusy);
  expect(after.audioRecordingOperationId).toBe(before.audioRecordingOperationId);
}

function startPlaybackAt(positionBeat: number): number {
  useStore.getState().setPosition(positionBeat);
  useStore.getState().play();
  const requestId = useStore.getState().transport.playbackRequestId;
  useStore.getState().confirmPlaybackStarted(requestId);
  return requestId;
}

describe('studio tempo and time-signature map commands', () => {
  it('adds one tempo event as one saved history change and restores it exactly with Undo/Redo', () => {
    const before = useStore.getState();
    const beforeMaps = mapSnapshot(before.project);

    const added = tempoMapActions.addStudioTempoMapEvent({
      beat: 4,
      bpm: 96,
    });

    expect(added).toMatchObject({
      ok: true,
      changed: true,
      map: 'tempo',
      playbackStopped: false,
    });
    if (!added.ok) throw new Error('tempo event was not added');
    const afterAdd = useStore.getState();
    const addedMaps = mapSnapshot(afterAdd.project);
    expect(afterAdd.project.tempoMap).toContainEqual({
      id: added.eventId,
      beat: 4,
      bpm: 96,
    });
    expect(afterAdd.project.bpm).toBe(120);
    expect(afterAdd.past).toHaveLength(before.past.length + 1);
    expect(afterAdd.past.at(-1)).toBe(before.project);
    expect(afterAdd.saveState.revision).toBe(before.saveState.revision + 1);

    useStore.getState().undo();
    expect(mapSnapshot(useStore.getState().project)).toEqual(beforeMaps);
    expect(useStore.getState().saveState.revision).toBe(
      afterAdd.saveState.revision + 1,
    );

    useStore.getState().redo();
    expect(mapSnapshot(useStore.getState().project)).toEqual(addedMaps);
    expect(useStore.getState().saveState.revision).toBe(
      afterAdd.saveState.revision + 2,
    );
  });

  it('adds one signature event with mirrors and lengthBars in one saved history change', () => {
    const before = useStore.getState();
    const beforeMaps = mapSnapshot(before.project);

    const added = tempoMapActions.addStudioTimeSignatureMapEvent({
      beat: 8,
      numerator: 3,
      denominator: 4,
    });

    expect(added).toMatchObject({
      ok: true,
      changed: true,
      map: 'time-signature',
      playbackStopped: false,
    });
    if (!added.ok) throw new Error('time-signature event was not added');
    const afterAdd = useStore.getState();
    const addedMaps = mapSnapshot(afterAdd.project);
    expect(afterAdd.project.timeSignatureMap).toContainEqual({
      id: added.eventId,
      beat: 8,
      numerator: 3,
      denominator: 4,
    });
    expect(afterAdd.project.timeSignature).toEqual([4, 4]);
    expect(afterAdd.project.lengthBars).toBe(10);
    expect(afterAdd.past).toHaveLength(before.past.length + 1);
    expect(afterAdd.past.at(-1)).toBe(before.project);
    expect(afterAdd.saveState.revision).toBe(before.saveState.revision + 1);

    useStore.getState().undo();
    expect(mapSnapshot(useStore.getState().project)).toEqual(beforeMaps);
    useStore.getState().redo();
    expect(mapSnapshot(useStore.getState().project)).toEqual(addedMaps);
  });

  it('updates anchors and exposes move and delete commands for both maps', () => {
    const tempoAnchorId = useStore.getState().project.tempoMap[0]?.id;
    const signatureAnchorId =
      useStore.getState().project.timeSignatureMap[0]?.id;
    if (!tempoAnchorId || !signatureAnchorId) {
      throw new Error('map anchor fixtures missing');
    }

    expect(tempoMapActions.updateStudioTempoMapEvent(
      tempoAnchorId,
      { bpm: 90 },
    )).toMatchObject({ ok: true, changed: true });
    expect(useStore.getState().project.bpm).toBe(90);

    const tempo = tempoMapActions.addStudioTempoMapEvent({ beat: 4, bpm: 110 });
    if (!tempo.ok) throw new Error('tempo fixture missing');
    expect(tempoMapActions.moveStudioTempoMapEvent(
      tempo.eventId,
      8,
    )).toMatchObject({ ok: true, changed: true });
    expect(tempoMapActions.updateStudioTempoMapEvent(
      tempo.eventId,
      { bpm: 140 },
    )).toMatchObject({ ok: true, changed: true });
    expect(useStore.getState().project.tempoMap).toContainEqual({
      id: tempo.eventId,
      beat: 8,
      bpm: 140,
    });
    expect(tempoMapActions.deleteStudioTempoMapEvent(
      tempo.eventId,
    )).toMatchObject({ ok: true, changed: true });

    expect(tempoMapActions.updateStudioTimeSignatureMapEvent(
      signatureAnchorId,
      { numerator: 8, denominator: 8 },
    )).toMatchObject({ ok: true, changed: true });
    expect(useStore.getState().project.timeSignature).toEqual([8, 8]);

    const signature = tempoMapActions.addStudioTimeSignatureMapEvent({
      beat: 8,
      numerator: 3,
      denominator: 4,
    });
    if (!signature.ok) throw new Error('signature fixture missing');
    expect(tempoMapActions.moveStudioTimeSignatureMapEvent(
      signature.eventId,
      20,
    )).toMatchObject({ ok: true, changed: true });
    expect(tempoMapActions.updateStudioTimeSignatureMapEvent(
      signature.eventId,
      { numerator: 6 },
    )).toMatchObject({ ok: true, changed: true });
    expect(useStore.getState().project.timeSignatureMap).toContainEqual({
      id: signature.eventId,
      beat: 20,
      numerator: 6,
      denominator: 4,
    });
    expect(tempoMapActions.deleteStudioTimeSignatureMapEvent(
      signature.eventId,
    )).toMatchObject({ ok: true, changed: true });
  });

  it('keeps semantic no-ops out of history, persistence, selection, and transport', () => {
    const anchor = useStore.getState().project.tempoMap[0];
    if (!anchor) throw new Error('tempo anchor fixture missing');
    startPlaybackAt(6.25);
    const before = useStore.getState();

    expect(tempoMapActions.updateStudioTempoMapEvent(anchor.id, {
      beat: anchor.beat,
      bpm: anchor.bpm,
    })).toEqual({
      ok: true,
      changed: false,
      map: 'tempo',
      eventId: anchor.id,
      playbackStopped: false,
    });
    expectMutationStateUnchanged(before);
  });

  it('rejects invalid and protected edits atomically without stopping playback', () => {
    const tempoAnchor = useStore.getState().project.tempoMap[0];
    const signatureAnchor = useStore.getState().project.timeSignatureMap[0];
    if (!tempoAnchor || !signatureAnchor) {
      throw new Error('map anchor fixtures missing');
    }
    startPlaybackAt(5.5);
    const beforeInvalid = useStore.getState();

    expect(tempoMapActions.addStudioTempoMapEvent({
      beat: 4,
      bpm: 301,
    })).toEqual({ ok: false, code: 'invalid-bpm' });
    expectMutationStateUnchanged(beforeInvalid);

    expect(tempoMapActions.removeStudioTempoMapEvent(
      tempoAnchor.id,
    )).toEqual({ ok: false, code: 'anchor-protected' });
    expectMutationStateUnchanged(beforeInvalid);

    expect(tempoMapActions.removeStudioTimeSignatureMapEvent(
      signatureAnchor.id,
    )).toEqual({ ok: false, code: 'anchor-protected' });
    expectMutationStateUnchanged(beforeInvalid);
  });

  it('rejects a stale compare-and-swap without changing any observable state', () => {
    const originalApplyProjectChange =
      useStore.getState().applyProjectChange;
    useStore.setState({ applyProjectChange: () => false });
    const before = useStore.getState();

    try {
      expect(tempoMapActions.addStudioTempoMapEvent({
        beat: 4,
        bpm: 96,
      })).toEqual({ ok: false, code: 'commit-rejected' });
      expectMutationStateUnchanged(before);
    } finally {
      useStore.setState({ applyProjectChange: originalApplyProjectChange });
    }
  });

  it('does not overwrite a concurrent project change that wins the snapshot race', () => {
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
      expect(tempoMapActions.addStudioTempoMapEvent({
        beat: 4,
        bpm: 96,
      })).toEqual({ ok: false, code: 'commit-rejected' });
      const after = useStore.getState();
      expect(after.project.title).toBe('先に反映された変更');
      expect(after.project.tempoMap).toBe(before.project.tempoMap);
      expect(after.project.timeSignatureMap).toBe(
        before.project.timeSignatureMap,
      );
      expect(after.past).toHaveLength(before.past.length + 1);
      expect(after.saveState.revision).toBe(before.saveState.revision + 1);
    } finally {
      useStore.setState({ applyProjectChange: originalApplyProjectChange });
    }
  });

  it('fails atomically while a project transition or recording owns persistence', () => {
    useStore.setState({ projectOperationBusy: true });
    const busy = useStore.getState();
    expect(tempoMapActions.addStudioTempoMapEvent({
      beat: 4,
      bpm: 96,
    })).toEqual({ ok: false, code: 'commit-rejected' });
    expectMutationStateUnchanged(busy);
    useStore.setState({ projectOperationBusy: false });

    const operationId = useStore.getState().tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording operation fixture missing');
    const recording = useStore.getState();
    try {
      expect(tempoMapActions.addStudioTimeSignatureMapEvent({
        beat: 8,
        numerator: 3,
        denominator: 4,
      })).toEqual({ ok: false, code: 'commit-rejected' });
      expectMutationStateUnchanged(recording);
    } finally {
      useStore.getState().finishAudioRecordingOperation(operationId);
    }
  });

  it('stops active playback once and preserves the playhead after an accepted edit', () => {
    const requestId = startPlaybackAt(6.25);

    expect(tempoMapActions.addStudioTempoMapEvent({
      beat: 4,
      bpm: 96,
    })).toMatchObject({
      ok: true,
      changed: true,
      playbackStopped: true,
    });
    expect(useStore.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      playbackRequestId: requestId + 1,
      positionBeat: 6.25,
    });
  });

  it('translates every domain and commit error into actionable Japanese', () => {
    const codes: StudioTempoMapErrorCode[] = [
      'event-not-found',
      'anchor-protected',
      'invalid-beat',
      'invalid-bpm',
      'invalid-time-signature',
      'event-beat-conflict',
      'invalid-bar-boundary',
      'map-limit',
      'duplicate-id',
      'id-factory-failed',
      'project-not-adoptable',
      'invalid-map',
      'commit-rejected',
      'unexpected',
    ];

    for (const code of codes) {
      expect(tempoMapActions.studioTempoMapErrorMessage(code)).toMatch(
        /[ぁ-んァ-ン一-龯]/,
      );
    }
    expect(
      tempoMapActions.studioTempoMapErrorMessage('invalid-bpm'),
    ).toContain('20〜300 BPM');
    expect(
      tempoMapActions.studioTempoMapErrorMessage('invalid-bar-boundary'),
    ).toContain('小節');
    expect(
      tempoMapActions.studioTempoMapErrorMessage('commit-rejected'),
    ).toContain('最新の状態');
  });
});
