import {
  addTempoMapEvent,
  addTimeSignatureMapEvent,
  removeTempoMapEvent,
  removeTimeSignatureMapEvent,
  updateTempoMapEvent,
  updateTimeSignatureMapEvent,
  type AddTempoMapEventInput,
  type AddTimeSignatureMapEventInput,
  type Project,
  type TempoMapMutationErrorCode,
  type TempoMapMutationResult,
  type UpdateTempoMapEventPatch,
  type UpdateTimeSignatureMapEventPatch,
} from '@cts/project-model';
import { useStore } from './store';

export type StudioTempoMapErrorCode =
  | TempoMapMutationErrorCode
  | 'commit-rejected';

export type StudioTempoMapCommandResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      map: 'tempo' | 'time-signature';
      eventId: string;
      playbackStopped: boolean;
    }>
  | Readonly<{ ok: false; code: StudioTempoMapErrorCode }>;

function failed(code: StudioTempoMapErrorCode): StudioTempoMapCommandResult {
  return { ok: false, code };
}

function mutationFailure(
  result: Extract<TempoMapMutationResult, { ok: false }>,
): StudioTempoMapCommandResult {
  return failed(result.error.code);
}

function successResult(
  result: Extract<TempoMapMutationResult, { ok: true }>,
  playbackStopped: boolean,
): StudioTempoMapCommandResult {
  return {
    ok: true,
    changed: result.changed,
    map: result.map,
    eventId: result.eventId,
    playbackStopped,
  };
}

function commitTempoMapMutation(
  snapshot: Project,
  result: Extract<TempoMapMutationResult, { ok: true }>,
  playbackWasActive: boolean,
): StudioTempoMapCommandResult {
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

function runTempoMapCommand(
  build: (snapshot: Project) => TempoMapMutationResult,
): StudioTempoMapCommandResult {
  const state = useStore.getState();
  const snapshot = state.project;
  const playbackWasActive = state.transport.phase !== 'stopped';
  const result = build(snapshot);
  if (!result.ok) return mutationFailure(result);
  return commitTempoMapMutation(snapshot, result, playbackWasActive);
}

export function addStudioTempoMapEvent(
  input: AddTempoMapEventInput,
): StudioTempoMapCommandResult {
  return runTempoMapCommand((project) => addTempoMapEvent(project, input));
}

export function updateStudioTempoMapEvent(
  eventId: string,
  patch: UpdateTempoMapEventPatch,
): StudioTempoMapCommandResult {
  return runTempoMapCommand((project) => (
    updateTempoMapEvent(project, eventId, patch)
  ));
}

export function moveStudioTempoMapEvent(
  eventId: string,
  beat: number,
): StudioTempoMapCommandResult {
  return updateStudioTempoMapEvent(eventId, { beat });
}

export function removeStudioTempoMapEvent(
  eventId: string,
): StudioTempoMapCommandResult {
  return runTempoMapCommand((project) => removeTempoMapEvent(project, eventId));
}

export const deleteStudioTempoMapEvent = removeStudioTempoMapEvent;

export function addStudioTimeSignatureMapEvent(
  input: AddTimeSignatureMapEventInput,
): StudioTempoMapCommandResult {
  return runTempoMapCommand((project) => (
    addTimeSignatureMapEvent(project, input)
  ));
}

export function updateStudioTimeSignatureMapEvent(
  eventId: string,
  patch: UpdateTimeSignatureMapEventPatch,
): StudioTempoMapCommandResult {
  return runTempoMapCommand((project) => (
    updateTimeSignatureMapEvent(project, eventId, patch)
  ));
}

export function moveStudioTimeSignatureMapEvent(
  eventId: string,
  beat: number,
): StudioTempoMapCommandResult {
  return updateStudioTimeSignatureMapEvent(eventId, { beat });
}

export function removeStudioTimeSignatureMapEvent(
  eventId: string,
): StudioTempoMapCommandResult {
  return runTempoMapCommand((project) => (
    removeTimeSignatureMapEvent(project, eventId)
  ));
}

export const deleteStudioTimeSignatureMapEvent =
  removeStudioTimeSignatureMapEvent;

export function studioTempoMapErrorMessage(
  code: StudioTempoMapErrorCode,
): string {
  switch (code) {
    case 'event-not-found':
      return '対象のテンポまたは拍子が見つかりません。最新の状態を確認して、もう一度お試しください。';
    case 'anchor-protected':
      return '曲の先頭にあるテンポと拍子は移動または削除できません。値だけを編集してください。';
    case 'invalid-beat':
      return '位置が曲の範囲外です。0拍から曲の終わりより前までに設定してください。';
    case 'invalid-bpm':
      return 'テンポは20〜300 BPMの範囲で設定してください。';
    case 'invalid-time-signature':
      return '拍子は、分子を1〜32の整数、分母を2・4・8・16のいずれかに設定してください。';
    case 'event-beat-conflict':
      return '同じ位置に別のテンポまたは拍子があります。位置をずらすか、既存の項目を編集してください。';
    case 'invalid-bar-boundary':
      return '拍子は小節の先頭に置いてください。後ろの拍子と曲の終わりも小節の区切りに合う位置を選んでください。';
    case 'map-limit':
      return 'テンポまたは拍子の数が上限に達しました。不要な項目を削除してください。';
    case 'duplicate-id':
    case 'id-factory-failed':
      return '新しいテンポまたは拍子を安全に識別できませんでした。もう一度お試しください。';
    case 'project-not-adoptable':
      return '現在のプロジェクトを安全に読み取れないため、テンポと拍子を変更しませんでした。';
    case 'invalid-map':
      return 'この変更ではテンポと拍子を安全に保存できないため、反映しませんでした。';
    case 'commit-rejected':
      return '別の変更が先に反映されたため、テンポと拍子は変更していません。最新の状態でやり直してください。';
    case 'unexpected':
      return 'テンポと拍子を変更できませんでした。プロジェクトは変更されていません。';
  }
}
