import {
  addAutomationPoint,
  clearAutomationLane,
  removeAutomationPoint,
  setAutomationLaneBypassed,
  setGlobalAutomationReadEnabled,
  setTrackAutomationReadEnabled,
  updateAutomationPoint,
  type AddAutomationPointInput,
  type AutomationMutationErrorCode,
  type AutomationMutationResult,
  type AutomationReadMutationResult,
  type AutomationTarget,
  type Project,
  type UpdateAutomationPointPatch,
} from '@cts/project-model';
import { stopRuntimePlaybackAudio } from '../audio/playback';
import { useStore } from './store';

export type StudioAutomationErrorCode =
  | AutomationMutationErrorCode
  | 'commit-rejected';

export type StudioAddAutomationPointInput = Readonly<
  Omit<AddAutomationPointInput, 'target'>
>;

export type StudioAutomationCommandResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      trackId: string;
      laneId: string;
      pointId?: string;
      playbackStopped: boolean;
    }>
  | Readonly<{ ok: false; code: StudioAutomationErrorCode }>;

export type StudioAutomationReadCommandResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      trackId?: string;
      playbackStopped: boolean;
    }>
  | Readonly<{ ok: false; code: StudioAutomationErrorCode }>;

export type StudioAutomationRuntimeDependencies = Readonly<{
  stopRuntimePlaybackAudio: () => void;
}>;

const DEFAULT_RUNTIME_DEPENDENCIES: StudioAutomationRuntimeDependencies = {
  stopRuntimePlaybackAudio,
};

function failed(
  code: StudioAutomationErrorCode,
): Readonly<{ ok: false; code: StudioAutomationErrorCode }> {
  return { ok: false, code };
}

function mutationFailure(
  result: Extract<AutomationMutationResult, { ok: false }>,
): StudioAutomationCommandResult {
  return failed(result.error.code);
}

function successResult(
  result: Extract<AutomationMutationResult, { ok: true }>,
  playbackStopped: boolean,
): StudioAutomationCommandResult {
  return {
    ok: true,
    changed: result.changed,
    trackId: result.trackId,
    laneId: result.laneId,
    ...(result.pointId === undefined ? {} : { pointId: result.pointId }),
    playbackStopped,
  };
}

function commitAutomationMutation(
  snapshot: Project,
  result: Extract<AutomationMutationResult, { ok: true }>,
  playbackWasActive: boolean,
): StudioAutomationCommandResult {
  if (!result.changed) return successResult(result, false);

  const state = useStore.getState();
  if (
    state.projectOperationBusy
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

function runAutomationCommand(
  build: (snapshot: Project) => AutomationMutationResult,
): StudioAutomationCommandResult {
  let state = useStore.getState();
  if (!state.finalizeAutomationRecording('bypass-change')) {
    return failed('commit-rejected');
  }
  state = useStore.getState();
  const snapshot = state.project;
  const playbackWasActive = state.transport.phase !== 'stopped';
  const result = build(snapshot);
  if (!result.ok) return mutationFailure(result);
  return commitAutomationMutation(snapshot, result, playbackWasActive);
}

function runAutomationReadCommand(
  build: (snapshot: Project) => AutomationReadMutationResult,
): StudioAutomationReadCommandResult {
  let state = useStore.getState();
  if (!state.finalizeAutomationRecording('read-change')) {
    return failed('commit-rejected');
  }
  state = useStore.getState();
  if (state.projectOperationBusy) return failed('commit-rejected');
  const snapshot = state.project;
  const playbackWasActive = state.transport.phase !== 'stopped';
  const result = build(snapshot);
  if (!result.ok) return failed(result.error.code);
  if (!result.changed) {
    return {
      ok: true,
      changed: false,
      ...(result.trackId === undefined ? {} : { trackId: result.trackId }),
      playbackStopped: false,
    };
  }
  const current = useStore.getState();
  if (current.projectOperationBusy || current.project !== snapshot) {
    return failed('commit-rejected');
  }
  let snapshotMatched = false;
  const committed = current.applyProjectChange((candidate) => {
    if (candidate !== snapshot) return candidate;
    snapshotMatched = true;
    return result.project;
  });
  if (
    !snapshotMatched
    || !committed
    || useStore.getState().project === snapshot
  ) {
    return failed('commit-rejected');
  }
  return {
    ok: true,
    changed: true,
    ...(result.trackId === undefined ? {} : { trackId: result.trackId }),
    playbackStopped:
      playbackWasActive && useStore.getState().transport.phase === 'stopped',
  };
}

export function setStudioGlobalAutomationReadEnabled(
  enabled: boolean,
): StudioAutomationReadCommandResult {
  return runAutomationReadCommand(
    (project) => setGlobalAutomationReadEnabled(project, enabled),
  );
}

export function setStudioTrackAutomationReadEnabled(
  trackId: string,
  enabled: boolean,
): StudioAutomationReadCommandResult {
  return runAutomationReadCommand(
    (project) => setTrackAutomationReadEnabled(project, trackId, enabled),
  );
}

export function addStudioAutomationPoint(
  target: AutomationTarget,
  input: StudioAddAutomationPointInput,
): StudioAutomationCommandResult {
  return runAutomationCommand((project) => addAutomationPoint(project, {
    ...input,
    target,
  }));
}

export function updateStudioAutomationPoint(
  laneId: string,
  pointId: string,
  patch: UpdateAutomationPointPatch,
): StudioAutomationCommandResult {
  return runAutomationCommand((project) => (
    updateAutomationPoint(project, laneId, pointId, patch)
  ));
}

export function removeStudioAutomationPoint(
  laneId: string,
  pointId: string,
): StudioAutomationCommandResult {
  return runAutomationCommand((project) => (
    removeAutomationPoint(project, laneId, pointId)
  ));
}

export function clearStudioAutomationLane(
  laneId: string,
): StudioAutomationCommandResult {
  return runAutomationCommand((project) => clearAutomationLane(project, laneId));
}

export function setStudioAutomationLaneBypassed(
  laneId: string,
  bypassed: boolean,
  dependencies: StudioAutomationRuntimeDependencies = DEFAULT_RUNTIME_DEPENDENCIES,
): StudioAutomationCommandResult {
  const result = runAutomationCommand((project) => (
    setAutomationLaneBypassed(project, laneId, bypassed)
  ));
  if (result.ok && result.changed) {
    dependencies.stopRuntimePlaybackAudio();
  }
  return result;
}

export function studioAutomationErrorMessage(
  code: StudioAutomationErrorCode,
): string {
  switch (code) {
    case 'track-not-found':
    case 'lane-not-found':
    case 'point-not-found':
      return '対象のオートメーションが見つかりません。最新の状態を確認して、もう一度お試しください。';
    case 'master-protected':
      return 'マスタートラックのオートメーションは現在編集できません。通常トラックまたはバスを選択してください。';
    case 'invalid-target':
      return 'このパラメーターはオートメーションの対象にできません。音量またはパンを選択してください。';
    case 'invalid-beat':
      return 'ポイントの位置が曲の範囲外です。0拍から曲の終わりまでに設定してください。';
    case 'invalid-value':
      return 'ポイントの値が範囲外です。音量は0〜200%、パンは左100〜右100に設定してください。';
    case 'invalid-interpolation':
      return '変化方法を設定できませんでした。「なめらかに変化」または「値を保つ」を選択してください。';
    case 'invalid-bypassed':
    case 'invalid-read-enabled':
      return 'Read / Bypassの状態を設定できませんでした。現在のレーンを確認して、もう一度お試しください。';
    case 'point-beat-conflict':
      return '同じ位置に別のポイントがあります。位置をずらすか、既存ポイントを編集してください。';
    case 'lane-limit':
    case 'point-limit':
      return 'このプロジェクトのオートメーション数上限に達しました。不要なポイントまたはカーブを削除してください。';
    case 'duplicate-id':
    case 'id-factory-failed':
      return '新しいポイントを安全に識別できませんでした。もう一度お試しください。';
    case 'project-not-adoptable':
      return '現在のプロジェクトを安全に読み取れないため、オートメーションを変更しませんでした。';
    case 'invalid-automation':
      return 'この変更ではオートメーションを安全に保存できないため、反映しませんでした。';
    case 'commit-rejected':
      return '別の変更が先に反映されたため、オートメーションは変更していません。最新の状態でやり直してください。';
    case 'unexpected':
      return 'オートメーションを変更できませんでした。プロジェクトは変更されていません。';
  }
}
