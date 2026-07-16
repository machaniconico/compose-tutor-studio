import {
  addAudioSend,
  defaultAudioSendInput,
  removeAudioSend,
  setTrackOutput,
  updateAudioSend,
  type AudioRouteDestination,
  type AudioRoutingMutationErrorCode,
  type AudioRoutingMutationResult,
  type AudioSendPosition,
  type Project,
  type UpdateAudioSendPatch,
} from '@cts/project-model';
import { useStore } from './store';

export type StudioRoutingErrorCode = AudioRoutingMutationErrorCode | 'commit-rejected';

export type StudioRoutingCommandResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      sourceTrackId: string;
      sendId?: string;
      playbackStopped: boolean;
    }>
  | Readonly<{ ok: false; code: StudioRoutingErrorCode }>;

function failed(code: StudioRoutingErrorCode): StudioRoutingCommandResult {
  return { ok: false, code };
}

function mutationFailure(
  result: Extract<AudioRoutingMutationResult, { ok: false }>,
): StudioRoutingCommandResult {
  return failed(result.error.code);
}

function commitRoutingMutation(
  snapshot: Project,
  result: Extract<AudioRoutingMutationResult, { ok: true }>,
  playbackWasActive: boolean,
): StudioRoutingCommandResult {
  if (!result.changed) {
    return {
      ok: true,
      changed: false,
      sourceTrackId: result.sourceTrackId,
      ...(result.sendId === undefined ? {} : { sendId: result.sendId }),
      playbackStopped: false,
    };
  }
  const state = useStore.getState();
  if (
    state.projectOperationBusy ||
    state.project !== snapshot ||
    !state.applyProjectChange((current) => (current === snapshot ? result.project : current)) ||
    useStore.getState().project === snapshot
  ) {
    return failed('commit-rejected');
  }
  return {
    ok: true,
    changed: true,
    sourceTrackId: result.sourceTrackId,
    ...(result.sendId === undefined ? {} : { sendId: result.sendId }),
    playbackStopped:
      playbackWasActive && useStore.getState().transport.phase === 'stopped',
  };
}

function runRoutingCommand(
  build: (snapshot: Project) => AudioRoutingMutationResult,
): StudioRoutingCommandResult {
  const state = useStore.getState();
  const snapshot = state.project;
  const playbackWasActive = state.transport.phase !== 'stopped';
  const result = build(snapshot);
  if (!result.ok) return mutationFailure(result);
  return commitRoutingMutation(snapshot, result, playbackWasActive);
}

export function setStudioTrackOutput(
  sourceTrackId: string,
  destination: AudioRouteDestination,
): StudioRoutingCommandResult {
  return runRoutingCommand((project) => setTrackOutput(project, sourceTrackId, destination));
}

export function addStudioAudioSend(
  sourceTrackId: string,
  targetBusId: string,
  position: AudioSendPosition = 'post-fader',
): StudioRoutingCommandResult {
  return runRoutingCommand((project) =>
    addAudioSend(project, defaultAudioSendInput(sourceTrackId, targetBusId, position)));
}

export function updateStudioAudioSend(
  sendId: string,
  patch: UpdateAudioSendPatch,
): StudioRoutingCommandResult {
  return runRoutingCommand((project) => updateAudioSend(project, sendId, patch));
}

export function removeStudioAudioSend(sendId: string): StudioRoutingCommandResult {
  return runRoutingCommand((project) => removeAudioSend(project, sendId));
}

export function studioRoutingErrorMessage(code: StudioRoutingErrorCode): string {
  switch (code) {
    case 'invalid-routing':
      return 'この接続は、音が同じ経路を回る、同じバスへ重複する、またはプロジェクトの接続数上限を超えるため設定できません。プロジェクトは変更されていません。';
    case 'track-not-found':
    case 'send-not-found':
      return '対象の経路が見つかりません。最新の状態を確認して、もう一度お試しください。';
    case 'master-protected':
      return 'マスターから別の出力やセンドは作れません。';
    case 'duplicate-id':
    case 'id-factory-failed':
      return '新しいセンドを安全に識別できませんでした。もう一度お試しください。';
    case 'project-not-adoptable':
      return '現在のプロジェクトの経路を安全に読み取れないため、変更しませんでした。';
    case 'commit-rejected':
      return '別の変更が先に反映されたため、経路は変更していません。もう一度お試しください。';
    case 'unexpected':
      return '経路を変更できませんでした。プロジェクトは変更されていません。';
  }
}
