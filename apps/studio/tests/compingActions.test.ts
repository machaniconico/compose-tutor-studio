import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendAudioTrackClip,
  createAudioTrackClip,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/compingActions');

function asset(id: string, fill: string): ReadyAudioAsset {
  return {
    id,
    availability: 'ready',
    checksumSha256: fill.repeat(64),
    originalName: `${id}.wav`,
    mediaType: 'audio/wav',
    byteLength: 192_044,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 96_000,
  };
}

function deterministicIds(prefix: string) {
  let sequence = 0;
  return (kind: 'track' | 'clip'): string => `${prefix}-${kind}-${++sequence}`;
}

function twoClipProject(base: Project): Readonly<{
  project: Project;
  trackId: string;
  clipIds: readonly [string, string];
}> {
  const first = createAudioTrackClip(base, asset('asset-take-a', 'a'), {
    startBeat: 0,
    idFactory: deterministicIds('first'),
  });
  if (!first.ok) throw new Error(first.error.code);
  const second = appendAudioTrackClip(
    first.project,
    first.trackId,
    asset('asset-take-b', 'b'),
    {
      startBeat: 0,
      idFactory: deterministicIds('second'),
    },
  );
  if (!second.ok) throw new Error(second.error.code);
  return {
    project: second.project,
    trackId: first.trackId,
    clipIds: [first.clipId, second.clipId],
  };
}

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/compingActions');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({
    projectOperationBusy: false,
    audioRecordingOperationId: null,
  });
  expect(await useStore.getState().createNewProject('テイク操作検証')).toBe(true);
  const fixture = twoClipProject(useStore.getState().project);
  useStore.setState({
    project: fixture.project,
    past: [],
    future: [],
    audioAssetIssues: {},
  });
});

describe('studio Audio comping commands', () => {
  it('groups matching clips as one saved Undo step and stops active playback', () => {
    const state = useStore.getState();
    const track = state.project.tracks.find(
      (candidate) => candidate.type === 'audio',
    );
    if (!track) throw new Error('audio track fixture missing');
    const clipIds = track.clips.map((clip) => clip.id);
    const before = useStore.getState();
    before.play();
    before.confirmPlaybackStarted(before.transport.playbackRequestId + 1);

    const result = actions.groupStudioAudioClipsIntoTakeFolder(clipIds);

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      playbackStopped: true,
    });
    if (!result.ok) throw new Error(result.code);
    const after = useStore.getState();
    const folder = after.project.audioTakeFolders.find(
      (candidate) => candidate.id === result.folderId,
    );
    expect(folder?.takes).toHaveLength(2);
    expect(folder?.compSegments).toEqual([expect.objectContaining({
      takeId: folder?.takes[0]?.id,
      offsetBeats: 0,
      lengthBeats: 4,
    })]);
    expect(after.project.tracks.find((candidate) => candidate.id === track.id)?.clips)
      .toEqual([]);
    expect(after.editor).toMatchObject({
      activeView: 'comping',
      selectedTrackId: track.id,
      selectedClipId: null,
      selectedTakeFolderId: result.folderId,
    });
    expect(after.past).toHaveLength(before.past.length + 1);
    expect(after.saveState.revision).toBe(before.saveState.revision + 1);

    after.undo();
    expect(useStore.getState().project.audioTakeFolders).toEqual([]);
    expect(useStore.getState().editor.selectedTakeFolderId).toBeNull();
    expect(
      useStore.getState().project.tracks.find((candidate) => candidate.id === track.id)?.clips,
    ).toHaveLength(2);
    useStore.getState().redo();
    expect(useStore.getState().editor.selectedTakeFolderId).toBe(result.folderId);
    expect(useStore.getState().project.audioTakeFolders[0]?.id).toBe(result.folderId);
  });

  it('paints one range as one history step and keeps a semantic no-op out of history', async () => {
    const track = useStore.getState().project.tracks.find(
      (candidate) => candidate.type === 'audio',
    );
    if (!track) throw new Error('audio track fixture missing');
    const grouped = actions.groupStudioAudioClipsIntoTakeFolder(
      track.clips.map((clip) => clip.id),
    );
    if (!grouped.ok) throw new Error(grouped.code);
    expect(await useStore.getState().flushPendingSave()).toBe(true);
    const folder = useStore.getState().project.audioTakeFolders[0];
    const alternate = folder?.takes[1];
    if (!folder || !alternate) throw new Error('take folder fixture missing');
    const beforePaint = useStore.getState();
    beforePaint.setPosition(1.5);
    beforePaint.play();
    beforePaint.confirmPlaybackStarted(useStore.getState().transport.playbackRequestId);

    const painted = actions.paintStudioAudioCompRange(
      folder.id,
      alternate.id,
      1,
      2,
    );
    expect(painted).toMatchObject({
      ok: true,
      changed: true,
      playbackStopped: true,
    });
    const afterPaint = useStore.getState();
    expect(afterPaint.transport).toMatchObject({
      phase: 'stopped',
      positionBeat: 1.5,
    });
    expect(afterPaint.project.audioTakeFolders[0]?.compSegments).toHaveLength(3);
    expect(afterPaint.past).toHaveLength(beforePaint.past.length + 1);
    expect(afterPaint.saveState.revision).toBe(beforePaint.saveState.revision + 1);

    expect(await useStore.getState().flushPendingSave()).toBe(true);
    const beforeNoOp = useStore.getState();
    expect(actions.paintStudioAudioCompRange(
      folder.id,
      alternate.id,
      1,
      2,
    )).toMatchObject({ ok: true, changed: false });
    expect(useStore.getState().project).toBe(beforeNoOp.project);
    expect(useStore.getState().past).toBe(beforeNoOp.past);
    expect(useStore.getState().saveState).toBe(beforeNoOp.saveState);

    useStore.getState().undo();
    expect(useStore.getState().project.audioTakeFolders[0]?.compSegments)
      .toEqual(folder.compSegments);
  });

  it('discovers same-window ready clips and rejects commits while recording owns the store', () => {
    const track = useStore.getState().project.tracks.find(
      (candidate) => candidate.type === 'audio',
    );
    const anchor = track?.clips[0];
    if (!track || !anchor) throw new Error('audio clip fixture missing');
    expect(actions.matchingAudioClipIdsForTakeFolder(
      useStore.getState().project,
      anchor.id,
    )).toEqual(track.clips.map((clip) => clip.id));

    useStore.getState().selectClip(anchor.id);
    const grouped = actions.groupSelectedStudioAudioClipIntoTakeFolder();
    expect(grouped).toMatchObject({ ok: true, changed: true });
    if (!grouped.ok) throw new Error(grouped.code);
    expect(useStore.getState().editor).toMatchObject({
      activeView: 'comping',
      selectedTakeFolderId: grouped.folderId,
    });
    useStore.getState().undo();

    useStore.setState({ audioRecordingOperationId: 99 });
    const before = useStore.getState();
    expect(actions.groupStudioAudioClipsIntoTakeFolder(
      track.clips.map((clip) => clip.id),
    )).toEqual({ ok: false, code: 'operation-busy' });
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toBe(before.past);
  });

  it('adds a later matching clip without changing the audible comp', async () => {
    const track = useStore.getState().project.tracks.find(
      (candidate) => candidate.type === 'audio',
    );
    if (!track) throw new Error('audio track fixture missing');
    const grouped = actions.groupStudioAudioClipsIntoTakeFolder(
      track.clips.map((clip) => clip.id),
    );
    if (!grouped.ok) throw new Error(grouped.code);
    expect(await useStore.getState().flushPendingSave()).toBe(true);
    const folder = useStore.getState().project.audioTakeFolders[0];
    if (!folder) throw new Error('take folder fixture missing');
    const appended = appendAudioTrackClip(
      useStore.getState().project,
      track.id,
      asset('asset-take-c', 'c'),
      {
        startBeat: folder.startBeat,
        idFactory: deterministicIds('later'),
      },
    );
    if (!appended.ok) throw new Error(appended.error.code);
    useStore.setState({ project: appended.project });
    useStore.getState().selectTakeFolder(folder.id);
    useStore.getState().selectClip(appended.clipId);
    expect(useStore.getState().editor.selectedTakeFolderId).toBeNull();
    const compBefore = JSON.stringify(folder.compSegments);
    const historyBefore = useStore.getState().past.length;

    expect(actions.addStudioAudioClipToTakeFolder(
      folder.id,
      appended.clipId,
    )).toMatchObject({ ok: true, changed: true });
    const after = useStore.getState();
    expect(JSON.stringify(after.project.audioTakeFolders[0]?.compSegments)).toBe(compBefore);
    expect(after.project.audioTakeFolders[0]?.takes).toHaveLength(3);
    expect(after.past).toHaveLength(historyBefore + 1);
  });

  it('rejects save-pending and runtime asset issues without touching playback or history', async () => {
    const track = useStore.getState().project.tracks.find(
      (candidate) => candidate.type === 'audio',
    );
    const firstClip = track?.clips.find((clip) => clip.type === 'audio');
    if (
      !track
      || !firstClip
      || firstClip.type !== 'audio'
      || typeof firstClip.audioAssetId !== 'string'
    ) {
      throw new Error('audio clip fixture missing');
    }
    const firstAudioAssetId = firstClip.audioAssetId;
    const clipIds = track.clips.map((clip) => clip.id);
    useStore.getState().play();
    useStore.getState().confirmPlaybackStarted(
      useStore.getState().transport.playbackRequestId,
    );

    useStore.setState((state) => ({
      saveState: { ...state.saveState, phase: 'pending' },
    }));
    const pending = useStore.getState();
    expect(actions.groupStudioAudioClipsIntoTakeFolder(clipIds))
      .toEqual({ ok: false, code: 'operation-busy' });
    expect(useStore.getState().project).toBe(pending.project);
    expect(useStore.getState().past).toBe(pending.past);
    expect(useStore.getState().future).toBe(pending.future);
    expect(useStore.getState().saveState.revision).toBe(pending.saveState.revision);
    expect(useStore.getState().transport).toBe(pending.transport);

    useStore.setState((state) => ({
      saveState: { ...state.saveState, phase: 'saved' },
    }));
    for (const issue of ['missing', 'changed', 'unavailable'] as const) {
      useStore.setState({ audioAssetIssues: { [firstAudioAssetId]: issue } });
      const before = useStore.getState();
      expect(actions.groupStudioAudioClipsIntoTakeFolder(clipIds))
        .toEqual({ ok: false, code: 'asset-unavailable' });
      expect(useStore.getState().project).toBe(before.project);
      expect(useStore.getState().past).toBe(before.past);
      expect(useStore.getState().future).toBe(before.future);
      expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
      expect(useStore.getState().transport).toBe(before.transport);
    }

    useStore.setState({ audioAssetIssues: {} });
    expect(await useStore.getState().flushPendingSave()).toBe(true);
  });

  it('checks every take asset again for folder edits', async () => {
    const track = useStore.getState().project.tracks.find(
      (candidate) => candidate.type === 'audio',
    );
    if (!track) throw new Error('audio track fixture missing');
    const grouped = actions.groupStudioAudioClipsIntoTakeFolder(
      track.clips.map((clip) => clip.id),
    );
    if (!grouped.ok) throw new Error(grouped.code);
    expect(await useStore.getState().flushPendingSave()).toBe(true);
    const folder = useStore.getState().project.audioTakeFolders[0];
    const alternate = folder?.takes[1];
    if (!folder || !alternate) throw new Error('take folder fixture missing');
    useStore.setState({
      audioAssetIssues: { [folder.takes[0]!.audioAssetId]: 'changed' },
    });
    const before = useStore.getState();

    expect(actions.paintStudioAudioCompRange(
      folder.id,
      alternate.id,
      1,
      2,
    )).toEqual({ ok: false, code: 'asset-unavailable' });
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toBe(before.past);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
  });

  it('rejects an ineligible selected anchor even when matching siblings exist', () => {
    const state = useStore.getState();
    const track = state.project.tracks.find((candidate) => candidate.type === 'audio');
    const anchor = track?.clips[0];
    const sibling = track?.clips[1];
    if (!track || !anchor || !sibling || anchor.type !== 'audio') {
      throw new Error('audio clip fixture missing');
    }
    const project = structuredClone(state.project);
    const projectTrack = project.tracks.find((candidate) => candidate.id === track.id)!;
    projectTrack.clips = [
      { ...anchor, loop: true },
      sibling,
      { ...sibling, id: 'third-matching-sibling' },
    ];

    expect(actions.matchingAudioClipIdsForTakeFolder(project, anchor.id)).toEqual([]);
    useStore.setState({ project });
    expect(actions.groupSelectedStudioAudioClipIntoTakeFolder(anchor.id))
      .toEqual({ ok: false, code: 'invalid-clip-selection' });
    expect(useStore.getState().project).toBe(project);
  });

  it('excludes a same-window sibling that cannot cover the folder range', () => {
    const state = useStore.getState();
    const track = state.project.tracks.find((candidate) => candidate.type === 'audio');
    const anchor = track?.clips[0];
    const sibling = track?.clips[1];
    if (
      !track
      || !anchor
      || !sibling
      || sibling.type !== 'audio'
    ) {
      throw new Error('audio clip fixture missing');
    }
    const project = structuredClone(state.project);
    const projectTrack = project.tracks.find((candidate) => candidate.id === track.id)!;
    projectTrack.clips = [
      anchor,
      sibling,
      {
        ...sibling,
        id: 'short-matching-sibling',
        sourceFrameCount: 1,
        fadeInFrames: 0,
        fadeOutFrames: 0,
      },
    ];
    useStore.setState({ project });

    expect(actions.matchingAudioClipIdsForTakeFolder(project, anchor.id))
      .toEqual([anchor.id, sibling.id]);
    expect(actions.groupSelectedStudioAudioClipIntoTakeFolder(anchor.id))
      .toMatchObject({ ok: true, changed: true });
    expect(
      useStore.getState().project.tracks
        .find((candidate) => candidate.id === track.id)
        ?.clips.map((clip) => clip.id),
    ).toEqual(['short-matching-sibling']);
  });
});
