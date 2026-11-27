import {
  addAudioSend,
  addTrack,
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
import { createDefaultEffectConfig } from '../audio/effects';
import { uid } from './ids';
import { useStore } from './store';

export type StudioRoutingErrorCode =
  | AudioRoutingMutationErrorCode
  | 'commit-rejected'
  | 'track-limit'
  | 'invalid-source';

export type StudioRoutingCommandResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      sourceTrackId: string;
      sendId?: string;
      playbackStopped: boolean;
    }>
  | Readonly<{ ok: false; code: StudioRoutingErrorCode }>;

type StudioRoutingFailure = Extract<StudioRoutingCommandResult, { ok: false }>;

function failed(code: StudioRoutingErrorCode): StudioRoutingFailure {
  return { ok: false, code };
}

function mutationFailure(
  result: Extract<AudioRoutingMutationResult, { ok: false }>,
): StudioRoutingFailure {
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

/** Name of the return created by the one-step reverb action. */
export const REVERB_RETURN_NAME = 'リバーブ';
/** Starting send level: a light touch of reverb (linear gain, 1 = full). */
export const REVERB_RETURN_SEND_GAIN = 0.3;

export type StudioReverbReturnResult =
  | (Extract<StudioRoutingCommandResult, { ok: true }> & Readonly<{ returnId: string; reusedReturn: boolean }>)
  | StudioRoutingFailure;

/**
 * One undoable step: make sure the project has a return (bus with a reverb) and
 * send the track to it post-fader. An existing bus that already has an enabled
 * reverb is reused; a track already sending to it is left unchanged.
 */
export function addStudioReverbReturn(sourceTrackId: string): StudioReverbReturnResult {
  const state = useStore.getState();
  const snapshot = state.project;
  const playbackWasActive = state.transport.phase !== 'stopped';
  const source = snapshot.tracks.find((track) => track.id === sourceTrackId);
  if (!source) return failed('track-not-found');
  if (source.type === 'master') return failed('master-protected');
  if (source.type === 'bus') return failed('invalid-source');

  let working = snapshot;
  let returnTrack = snapshot.tracks.find(
    (track) => track.type === 'bus' && track.effects.some((fx) => fx.type === 'reverb' && fx.enabled),
  );
  const reusedReturn = returnTrack !== undefined;
  if (!returnTrack) {
    const added = addTrack(snapshot, 'bus', { name: REVERB_RETURN_NAME });
    if (!added.ok) return failed(added.error.code === 'track-limit' ? 'track-limit' : 'unexpected');
    const reverb = createDefaultEffectConfig('reverb', uid('fx'));
    // A return carries only the effect's own sound, so it is fully wet.
    const effect = { ...reverb, params: { ...reverb.params, wet: 1 } };
    working = {
      ...added.project,
      tracks: added.project.tracks.map((track) =>
        track.id === added.trackId ? { ...track, effects: [effect] } : track),
    };
    returnTrack = working.tracks.find((track) => track.id === added.trackId)!;
  }

  const existingSend = working.audioRouting.sends.find(
    (send) => send.sourceTrackId === sourceTrackId && send.targetBusId === returnTrack.id,
  );
  if (existingSend) {
    return {
      ok: true,
      changed: false,
      sourceTrackId,
      sendId: existingSend.id,
      playbackStopped: false,
      returnId: returnTrack.id,
      reusedReturn,
    };
  }

  const sent = addAudioSend(working, {
    ...defaultAudioSendInput(sourceTrackId, returnTrack.id, 'post-fader'),
    gain: REVERB_RETURN_SEND_GAIN,
  });
  if (!sent.ok) return mutationFailure(sent);
  const committed = commitRoutingMutation(snapshot, sent, playbackWasActive);
  return committed.ok ? { ...committed, returnId: returnTrack.id, reusedReturn } : committed;
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
    case 'track-limit':
      return 'トラックの数が上限に達しているため、リターンを追加できません。使わないトラックを減らしてからお試しください。';
    case 'invalid-source':
      return 'バスからはリバーブ用リターンを作れません。楽器やドラムのトラックで試してください。';
    case 'unexpected':
      return '経路を変更できませんでした。プロジェクトは変更されていません。';
  }
}
