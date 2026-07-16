import {
  MAX_TRACK_NAME_CODE_POINTS,
  addTrack,
  duplicateTrack,
  moveTrack,
  removeTrack,
  renameTrack,
  setTrackSynthPreset,
  type AddTrackKind,
  type Project,
  type Track,
  type TrackMoveDirection,
  type TrackMutationErrorCode,
  type TrackMutationResult,
} from '@cts/project-model';
import { listSynthPresets } from '../audio/synth';
import { isLearningTrack, isLearningTrackName } from '../features/tracklist/trackPresentation';
import { useStore } from './store';

export type AddStudioTrackKind = AddTrackKind;

export type TrackCommandErrorCode =
  | TrackMutationErrorCode
  | 'commit-rejected'
  | 'learning-track-name-protected'
  | 'reserved-learning-track-name';

export type TrackCommandResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      trackId: string;
      trackName: string;
      selectedTrackId: string | null;
      playbackStopped: boolean;
    }>
  | Readonly<{ ok: false; code: TrackCommandErrorCode }>;

export type AddStudioTrackInput = Readonly<{
  kind: AddStudioTrackKind;
  name: string;
  preset?: string;
}>;

const ALLOWED_SYNTH_PRESETS = listSynthPresets().map(({ name }) => name);

function failed(code: TrackCommandErrorCode): TrackCommandResult {
  return { ok: false, code };
}

function mutationFailure(result: Extract<TrackMutationResult, { ok: false }>): TrackCommandResult {
  return failed(result.error.code);
}

function projectTrack(project: Project, trackId: string): Track | null {
  return project.tracks.find((track) => track.id === trackId) ?? null;
}

function selectTrackForEditing(track: Track): void {
  const state = useStore.getState();
  state.selectTrack(track.id);
  state.selectClip(track.clips[0]?.id ?? null);
  state.selectChord(null);
  state.selectNotes([]);
  if (track.type === 'drum') state.setActiveView('drums');
  else if (track.type === 'instrument') state.setActiveView('pianoRoll');
  else state.setActiveView('arranger');
}

function commitMutation(
  snapshot: Project,
  result: Extract<TrackMutationResult, { ok: true }>,
): boolean {
  if (!result.changed) return true;
  const state = useStore.getState();
  if (state.projectOperationBusy || state.project !== snapshot) return false;
  if (!state.applyProjectChange((current) => (current === snapshot ? result.project : current))) {
    return false;
  }
  return useStore.getState().project !== snapshot;
}

function successResult(
  trackId: string,
  trackName: string,
  changed: boolean,
  playbackWasActive = false,
): TrackCommandResult {
  return {
    ok: true,
    changed,
    trackId,
    trackName,
    selectedTrackId: useStore.getState().editor.selectedTrackId,
    playbackStopped:
      changed &&
      playbackWasActive &&
      useStore.getState().transport.phase === 'stopped',
  };
}

/** Add one usable full-song track and select its initial clip. */
export function addStudioTrack(input: AddStudioTrackInput): TrackCommandResult {
  const startingState = useStore.getState();
  const snapshot = startingState.project;
  const playbackWasActive = startingState.transport.phase !== 'stopped';
  const addedMutation = addTrack(snapshot, input.kind, { name: input.name });
  if (!addedMutation.ok) return mutationFailure(addedMutation);
  let mutation: Extract<TrackMutationResult, { ok: true }> = addedMutation;

  if (input.kind === 'instrument' && input.preset !== undefined) {
    const presetMutation = setTrackSynthPreset(
      addedMutation.project,
      addedMutation.trackId,
      input.preset,
      ALLOWED_SYNTH_PRESETS,
    );
    if (!presetMutation.ok) return mutationFailure(presetMutation);
    // The preset itself may already equal the factory default, but the track
    // addition still has to be committed as this one atomic transaction.
    mutation = { ...presetMutation, changed: true };
  }

  if (!commitMutation(snapshot, mutation)) return failed('commit-rejected');
  const added = projectTrack(useStore.getState().project, mutation.trackId);
  if (!added) return failed('commit-rejected');
  selectTrackForEditing(added);
  return successResult(added.id, added.name, mutation.changed, playbackWasActive);
}

/** Rename a non-master track while preserving name-based schema-v2 learning roles. */
export function renameStudioTrack(trackId: string, name: string): TrackCommandResult {
  const snapshot = useStore.getState().project;
  const source = projectTrack(snapshot, trackId);
  if (!source) return failed('track-not-found');
  if (source.type === 'master') return failed('master-protected');
  if (isLearningTrack(source)) return failed('learning-track-name-protected');
  if (isLearningTrackName(name)) return failed('reserved-learning-track-name');

  const mutation = renameTrack(snapshot, trackId, name);
  if (!mutation.ok) return mutationFailure(mutation);
  if (!commitMutation(snapshot, mutation)) return failed('commit-rejected');
  const renamed = projectTrack(useStore.getState().project, trackId);
  if (!renamed) return failed('commit-rejected');
  return successResult(renamed.id, renamed.name, mutation.changed);
}

function nextCopyName(project: Project, sourceName: string): string {
  const used = new Set(project.tracks.map((track) => track.name));
  for (let ordinal = 1; ; ordinal += 1) {
    const suffix = ordinal === 1 ? ' コピー' : ` コピー ${ordinal}`;
    const baseLength = MAX_TRACK_NAME_CODE_POINTS - Array.from(suffix).length;
    const base = Array.from(sourceName.trim()).slice(0, baseLength).join('').trimEnd() || 'Track';
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Duplicate every owned entity, then select the fresh track. */
export function duplicateStudioTrack(trackId: string): TrackCommandResult {
  const startingState = useStore.getState();
  const snapshot = startingState.project;
  const playbackWasActive = startingState.transport.phase !== 'stopped';
  const source = projectTrack(snapshot, trackId);
  if (!source) return failed('track-not-found');
  const mutation = duplicateTrack(snapshot, trackId, {
    name: nextCopyName(snapshot, source.name),
  });
  if (!mutation.ok) return mutationFailure(mutation);
  if (!commitMutation(snapshot, mutation)) return failed('commit-rejected');
  const duplicate = projectTrack(useStore.getState().project, mutation.trackId);
  if (!duplicate) return failed('commit-rejected');
  selectTrackForEditing(duplicate);
  return successResult(duplicate.id, duplicate.name, mutation.changed, playbackWasActive);
}

/** Move a track by one visible row without crossing a master boundary. */
export function moveStudioTrack(
  trackId: string,
  direction: TrackMoveDirection,
): TrackCommandResult {
  const startingState = useStore.getState();
  const snapshot = startingState.project;
  const playbackWasActive = startingState.transport.phase !== 'stopped';
  const source = projectTrack(snapshot, trackId);
  if (!source) return failed('track-not-found');
  const mutation = moveTrack(snapshot, trackId, direction);
  if (!mutation.ok) return mutationFailure(mutation);
  if (!commitMutation(snapshot, mutation)) return failed('commit-rejected');
  return successResult(source.id, source.name, mutation.changed, playbackWasActive);
}

function deletionSelection(project: Project, removedId: string): Track | null {
  const removedIndex = project.tracks.findIndex((track) => track.id === removedId);
  if (removedIndex < 0) return null;
  const after = project.tracks
    .slice(removedIndex + 1)
    .find((track) => track.type !== 'master');
  if (after) return after;
  for (let index = removedIndex - 1; index >= 0; index -= 1) {
    const before = project.tracks[index];
    if (before?.type !== 'master') return before ?? null;
  }
  return project.tracks.find((track) => track.id !== removedId && track.type === 'master') ?? null;
}

/** Delete a non-master track and repair selection when it owned the editor focus. */
export function deleteStudioTrack(trackId: string): TrackCommandResult {
  const state = useStore.getState();
  const snapshot = state.project;
  const playbackWasActive = state.transport.phase !== 'stopped';
  const source = projectTrack(snapshot, trackId);
  if (!source) return failed('track-not-found');
  const wasSelected = state.editor.selectedTrackId === trackId;
  const nextSelection = wasSelected ? deletionSelection(snapshot, trackId) : null;
  const mutation = removeTrack(snapshot, trackId);
  if (!mutation.ok) return mutationFailure(mutation);
  if (!commitMutation(snapshot, mutation)) return failed('commit-rejected');

  if (wasSelected) {
    const adopted = nextSelection
      ? projectTrack(useStore.getState().project, nextSelection.id)
      : null;
    if (adopted) selectTrackForEditing(adopted);
    else {
      const latest = useStore.getState();
      latest.selectTrack(null);
      latest.selectClip(null);
      latest.selectChord(null);
      latest.selectNotes([]);
    }
  }
  return successResult(source.id, source.name, mutation.changed, playbackWasActive);
}

/** Commit one canonical synth preset; playback topology invalidation is store-owned. */
export function setStudioTrackPreset(trackId: string, preset: string): TrackCommandResult {
  const startingState = useStore.getState();
  const snapshot = startingState.project;
  const playbackWasActive = startingState.transport.phase !== 'stopped';
  const source = projectTrack(snapshot, trackId);
  if (!source) return failed('track-not-found');
  const mutation = setTrackSynthPreset(
    snapshot,
    trackId,
    preset,
    ALLOWED_SYNTH_PRESETS,
  );
  if (!mutation.ok) return mutationFailure(mutation);
  if (!commitMutation(snapshot, mutation)) return failed('commit-rejected');
  const adopted = projectTrack(useStore.getState().project, trackId);
  if (!adopted) return failed('commit-rejected');
  return successResult(adopted.id, adopted.name, mutation.changed, playbackWasActive);
}

/** Plain-language recovery guidance for every rejected command. */
export function trackCommandErrorMessage(code: TrackCommandErrorCode): string {
  switch (code) {
    case 'track-not-found':
      return '対象のトラックが見つかりません。もう一度選び直してください。';
    case 'track-limit':
      return 'トラック数が上限の128件に達しています。不要なトラックを削除してください。';
    case 'master-protected':
      return 'マスタートラックは名前・順序・複製・削除を変更できません。';
    case 'learning-track-protected':
      return 'Chords、Bass、Melodyは学習支援との互換性を守るため、現在は削除できません。';
    case 'invalid-track-name':
      return '名前は空白以外の128文字以内で入力してください。';
    case 'invalid-preset':
      return '選択した音色は利用できません。一覧から選び直してください。';
    case 'unsupported-track-kind':
    case 'unsupported-track-type':
      return 'この種類のトラックでは、その操作を利用できません。';
    case 'duplicate-id':
    case 'id-factory-failed':
      return '安全な識別子を作れなかったため反映しませんでした。もう一度お試しください。';
    case 'project-not-adoptable':
      return 'この変更はプロジェクトの保存上限または整合性条件を超えるため反映しませんでした。';
    case 'learning-track-name-protected':
      return 'この学習用トラック名は、支援機能との互換性を守るため現在は固定です。';
    case 'reserved-learning-track-name':
      return 'Chords、Bass、Melodyは学習用に予約された名前です。別の名前を入力してください。';
    case 'commit-rejected':
      return '変更を安全に保存できなかったため反映しませんでした。保存のお知らせを確認してください。';
    case 'unexpected':
      return 'トラックを変更できませんでした。現在の内容は保持されています。';
  }
}
