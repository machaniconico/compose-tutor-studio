import {
  addAudioClipToTakeFolder,
  compileMusicalTime,
  deleteUnusedAudioTake,
  groupAudioClipsIntoTakeFolder,
  moveAudioCompBoundary,
  paintAudioCompRange,
  secondsBetweenBeats,
  type AudioTakeCompMutationErrorCode,
  type AudioTakeCompMutationResult,
  type AudioClip,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { useStore } from './store';

export type StudioCompingErrorCode =
  | AudioTakeCompMutationErrorCode
  | 'commit-rejected'
  | 'operation-busy'
  | 'asset-unavailable';

export type StudioCompingCommandResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      folderId: string;
      playbackStopped: boolean;
    }>
  | Readonly<{ ok: false; code: StudioCompingErrorCode }>;

function failed(code: StudioCompingErrorCode): StudioCompingCommandResult {
  return { ok: false, code };
}

function mutationFailure(
  result: Extract<AudioTakeCompMutationResult, { ok: false }>,
): StudioCompingCommandResult {
  return failed(result.error.code);
}

function successResult(
  result: Extract<AudioTakeCompMutationResult, { ok: true }>,
  playbackStopped: boolean,
): StudioCompingCommandResult {
  return {
    ok: true,
    changed: result.changed,
    folderId: result.folderId,
    playbackStopped,
  };
}

function commitCompingMutation(
  snapshot: Project,
  result: Extract<AudioTakeCompMutationResult, { ok: true }>,
  playbackWasActive: boolean,
  relevantAssetIds: readonly string[],
): StudioCompingCommandResult {
  if (!result.changed) return successResult(result, false);
  const state = useStore.getState();
  if (
    compingFence(state, relevantAssetIds) !== null
    || state.project !== snapshot
    || !state.applyProjectChange((current) => (
      current === snapshot ? result.project : current
    ))
    || useStore.getState().project === snapshot
  ) {
    return failed('commit-rejected');
  }
  return successResult(
    result,
    playbackWasActive && useStore.getState().transport.phase === 'stopped',
  );
}

function runCompingCommand(
  build: (snapshot: Project) => AudioTakeCompMutationResult,
  relevantAssets: (snapshot: Project) => readonly string[],
): StudioCompingCommandResult {
  const state = useStore.getState();
  const snapshot = state.project;
  const relevantAssetIds = relevantAssets(snapshot);
  const blocked = compingFence(state, relevantAssetIds);
  if (blocked !== null) return failed(blocked);
  const playbackWasActive = state.transport.phase !== 'stopped';
  const result = build(snapshot);
  if (!result.ok) return mutationFailure(result);
  return commitCompingMutation(
    snapshot,
    result,
    playbackWasActive,
    relevantAssetIds,
  );
}

type CompingFenceState = Pick<
  ReturnType<typeof useStore.getState>,
  | 'projectOperationBusy'
  | 'audioRecordingOperationId'
  | 'saveState'
  | 'audioAssetIssues'
>;

function compingFence(
  state: CompingFenceState,
  relevantAssetIds: readonly string[],
): Extract<StudioCompingErrorCode, 'operation-busy' | 'asset-unavailable'> | null {
  if (
    state.projectOperationBusy
    || state.audioRecordingOperationId !== null
    || state.saveState.phase === 'pending'
  ) {
    return 'operation-busy';
  }
  return relevantAssetIds.some(
    (assetId) => state.audioAssetIssues[assetId] !== undefined,
  )
    ? 'asset-unavailable'
    : null;
}

function audioAssetIdsForClips(
  project: Project,
  clipIds: readonly string[],
): string[] {
  const selected = new Set(clipIds);
  return project.tracks.flatMap((track) => (
    track.clips.flatMap((clip) => (
      selected.has(clip.id)
      && clip.type === 'audio'
      && typeof clip.audioAssetId === 'string'
        ? [clip.audioAssetId]
        : []
    ))
  ));
}

function audioAssetIdsForFolder(
  project: Project,
  folderId: string,
): string[] {
  return project.audioTakeFolders
    .find((folder) => folder.id === folderId)
    ?.takes.map((take) => take.audioAssetId) ?? [];
}

/** Create one folder from explicitly chosen raw Audio Clips. */
export function groupStudioAudioClipsIntoTakeFolder(
  clipIds: readonly string[],
): StudioCompingCommandResult {
  const result = runCompingCommand((project) => (
    groupAudioClipsIntoTakeFolder(project, clipIds)
  ), (project) => audioAssetIdsForClips(project, clipIds));
  if (result.ok && result.changed) {
    const state = useStore.getState();
    state.selectTakeFolder(result.folderId);
    state.setActiveView('comping');
  }
  return result;
}

/**
 * Discover every eligible same-window clip from the selected/explicit anchor,
 * group them in one history step, then open the resulting take editor.
 */
export function groupSelectedStudioAudioClipIntoTakeFolder(
  anchorClipId: string | null = useStore.getState().editor.selectedClipId,
): StudioCompingCommandResult {
  if (anchorClipId === null) return failed('invalid-clip-selection');
  const clipIds = matchingAudioClipIdsForTakeFolder(
    useStore.getState().project,
    anchorClipId,
  );
  if (clipIds.length < 2) return failed('invalid-clip-selection');
  return groupStudioAudioClipsIntoTakeFolder(clipIds);
}

/** Append a matching raw clip as a take without changing the audible comp. */
export function addStudioAudioClipToTakeFolder(
  folderId: string,
  clipId: string,
): StudioCompingCommandResult {
  const result = runCompingCommand((project) => (
    addAudioClipToTakeFolder(project, folderId, clipId)
  ), (project) => [
    ...audioAssetIdsForFolder(project, folderId),
    ...audioAssetIdsForClips(project, [clipId]),
  ]);
  if (result.ok && result.changed) {
    useStore.getState().selectTakeFolder(result.folderId);
  }
  return result;
}

/** Replace one folder-local half-open range with the selected take. */
export function paintStudioAudioCompRange(
  folderId: string,
  takeId: string,
  offsetBeats: number,
  lengthBeats: number,
): StudioCompingCommandResult {
  return runCompingCommand((project) => (
    paintAudioCompRange(project, folderId, {
      takeId,
      offsetBeats,
      lengthBeats,
    })
  ), (project) => audioAssetIdsForFolder(project, folderId));
}

/** Move the shared boundary after `leftSegmentId`; no gap or overlap is created. */
export function moveStudioAudioCompBoundary(
  folderId: string,
  leftSegmentId: string,
  offsetBeats: number,
): StudioCompingCommandResult {
  return runCompingCommand((project) => (
    moveAudioCompBoundary(project, folderId, {
      leftSegmentId,
      offsetBeats,
    })
  ), (project) => audioAssetIdsForFolder(project, folderId));
}

/** Delete only a take that is not referenced by the current comp. */
export function deleteStudioUnusedAudioTake(
  folderId: string,
  takeId: string,
): StudioCompingCommandResult {
  return runCompingCommand((project) => (
    deleteUnusedAudioTake(project, folderId, takeId)
  ), (project) => audioAssetIdsForFolder(project, folderId));
}

/** Lightweight discovery; the domain mutation remains the final eligibility gate. */
export function matchingAudioClipIdsForTakeFolder(
  project: Project,
  anchorClipId: string,
): string[] {
  const located = project.tracks.flatMap((track) => (
    track.clips
      .filter((clip) => clip.id === anchorClipId)
      .map((clip) => ({ track, clip }))
  ))[0];
  if (!located || located.track.type !== 'audio' || located.clip.type !== 'audio') {
    return [];
  }
  if (
    located.clip.loop
    || typeof located.clip.audioAssetId !== 'string'
  ) {
    return [];
  }
  const readyAssets = new Map(
    project.audioAssets
      .filter((asset) => asset.availability === 'ready')
      .map((asset) => [asset.id, asset] as const),
  );
  let musicalTime;
  try {
    musicalTime = compileMusicalTime(project);
  } catch {
    return [];
  }
  const coversWindow = (clip: AudioClip, asset: ReadyAudioAsset): boolean => {
    const requiredFrames = secondsBetweenBeats(
      musicalTime,
      clip.startBeat,
      clip.startBeat + clip.lengthBeats,
    ) * asset.sampleRate;
    return Number.isFinite(requiredFrames)
      && requiredFrames > 0
      && clip.sourceFrameCount + 1 >= requiredFrames;
  };
  const anchorAsset = readyAssets.get(located.clip.audioAssetId);
  if (!anchorAsset || !coversWindow(located.clip as AudioClip, anchorAsset)) {
    return [];
  }
  const matches = located.track.clips
    .filter((clip): clip is AudioClip => {
      if (
        clip.type !== 'audio'
        || typeof clip.audioAssetId !== 'string'
        || clip.loop
        || clip.startBeat !== located.clip.startBeat
        || clip.lengthBeats !== located.clip.lengthBeats
      ) {
        return false;
      }
      const clipAsset = readyAssets.get(clip.audioAssetId);
      return clipAsset !== undefined && coversWindow(clip as AudioClip, clipAsset);
    })
    .map((clip) => clip.id);
  return matches.includes(anchorClipId) ? matches : [];
}

export function studioCompingErrorMessage(
  code: StudioCompingErrorCode,
): string {
  switch (code) {
    case 'folder-not-found':
    case 'take-not-found':
    case 'clip-not-found':
    case 'boundary-not-found':
      return '対象のテイクが見つかりません。最新の状態を確認して、もう一度お試しください。';
    case 'invalid-clip-selection':
      return '同じ位置・長さのオーディオクリップを2つ以上選んでください。';
    case 'ineligible-clip':
      return 'テイク化できるのは、同じオーディオトラック・位置・長さで、全区間の音声が残っている非ループ素材です。';
    case 'edited-clip-unsupported':
      return '音声のタイミングまたは音程を補正したクリップは、まだテイクへまとめられません。補正をリセットしてからお試しください。';
    case 'invalid-range':
      return '範囲がテイクの外へ出ています。開始と終了をテイク内に設定してください。';
    case 'invalid-crossfade':
      return 'クロスフェードは0〜50ミリ秒で設定してください。';
    case 'take-in-use':
      return '仕上がりで使っているテイクは削除できません。先にその区間を別テイクへ切り替えてください。';
    case 'minimum-takes':
      return 'テイク編集には2テイク以上が必要なため、これ以上削除できません。';
    case 'folder-limit':
    case 'take-limit':
    case 'segment-limit':
      return 'このプロジェクトのテイク編集上限に達しました。不要なテイクまたは区間を整理してください。';
    case 'duplicate-id':
    case 'id-factory-failed':
      return '新しいテイクを安全に識別できませんでした。もう一度お試しください。';
    case 'project-not-adoptable':
      return '現在のプロジェクトを安全に読み取れないため、テイクを変更しませんでした。';
    case 'operation-busy':
      return '録音または保存などの処理中です。完了してからテイクを変更してください。';
    case 'asset-unavailable':
    case 'audio-asset-not-ready':
      return '音声素材を確認できないため、テイクを変更していません。素材を再リンクまたは復旧してください。';
    case 'audio-asset-limit':
      return 'このプロジェクトの音声素材上限に達しました。不要な音声素材を整理してください。';
    case 'track-limit':
      return 'このプロジェクトのトラック上限に達しました。不要なトラックを整理してください。';
    case 'track-not-found':
      return '録音先のオーディオトラックが見つかりません。最新の状態を確認してください。';
    case 'unsupported-track-type':
      return '録音テイクをまとめられるのはオーディオトラックだけです。';
    case 'invalid-track-name':
      return 'オーディオトラック名を短い文字列で入力してください。';
    case 'commit-rejected':
      return '別の変更が先に反映されたため、テイクは変更していません。最新の状態でやり直してください。';
    case 'unexpected':
      return 'テイクを変更できませんでした。プロジェクトは変更されていません。';
  }
}
