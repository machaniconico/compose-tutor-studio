// Groove edits (US-018 / US-019): project swing, hi-hat choke, strength
// quantize, seeded humanize, and the 12 / 16 drum step choice.
//
// Every action is one project commit (so one undo step), applies all or
// nothing, and is refused while recording. Note edits work in whole ticks
// (480 PPQ) and are checked against the audible schedule before they commit.

import {
  MAX_SWING_PERCENT,
  PPQ,
  humanize,
  quantize,
  resampleDrumSteps,
  type Clip,
  type Project,
} from '@cts/project-model';
import { buildScheduleEvents, type SchedulePayload } from '../audio/events';
import { findClip, projectBeatsPerBarAt } from './editorActions';
import { retimeSelectedNotes, type NoteEditResult } from './noteEditActions';
import { useStore } from './store';

export type GrooveEditResult =
  | Readonly<{ ok: true; changed: number; message?: string; moved?: number; merged?: number }>
  | Readonly<{ ok: false; reason: string }>;

export const MAX_HUMANIZE_TIMING_TICKS = 240;
export const MAX_HUMANIZE_VELOCITY = 40;
export const MAX_HUMANIZE_SEED = 0xffff_ffff;
export const DRUM_STEPS_PER_BAR_CHOICES = [12, 16] as const;


const refuse = (reason: string): GrooveEditResult => ({ ok: false, reason });
const REASON_RECORDING = '録音中は変更できません。録音を止めてからやり直してください。';
const REASON_REFUSED = 'この変更は反映できませんでした。現在の内容はそのままです。';

function recordingActive(): boolean {
  return useStore.getState().audioRecordingOperationId !== null;
}

/** Returns a reason when the candidate has no sane schedule; null when it is fine. */
function scheduleProblem(project: Project): string | null {
  try {
    const events = buildScheduleEvents(project);
    return events.every((event) => Number.isFinite(event.beat) && event.beat >= 0)
      ? null
      : 'この設定では演奏データが作れないため、反映しませんでした。';
  } catch {
    return 'この設定では演奏データが作れないため、反映しませんでした。';
  }
}

function commit(snapshot: Project, next: Project): boolean {
  return useStore.getState().applyProjectChange((current) => (current === snapshot ? next : current));
}

/** 曲全体のスウィング(0〜60 %、整数)。範囲外は丸め、数値でない値は拒否する。 */
export function setProjectSwing(percent: number): GrooveEditResult {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return refuse('スウィングは数字で指定してください。');
  if (recordingActive()) return refuse(REASON_RECORDING);
  const value = Math.min(MAX_SWING_PERCENT, Math.max(0, Math.round(percent)));
  const snapshot = useStore.getState().project;
  if (snapshot.swing === value) return { ok: true, changed: 0 };
  const next: Project = { ...snapshot, swing: value };
  if (scheduleProblem(next) !== null) return refuse('この設定では演奏データが作れないため、反映しませんでした。');
  return commit(snapshot, next) ? { ok: true, changed: 1 } : refuse(REASON_REFUSED);
}

/** ハイハットのチョーク(開いたハイハットを、次の閉じたハイハットで止める)の切替。 */
export function setHiHatChoke(on: boolean): GrooveEditResult {
  if (typeof on !== 'boolean') return refuse('オンかオフで指定してください。');
  if (recordingActive()) return refuse(REASON_RECORDING);
  const snapshot = useStore.getState().project;
  if (snapshot.hiHatChoke === on) return { ok: true, changed: 0 };
  const next: Project = { ...snapshot, hiHatChoke: on };
  if (scheduleProblem(next) !== null) return refuse('この設定では演奏データが作れないため、反映しませんでした。');
  return commit(snapshot, next) ? { ok: true, changed: 1 } : refuse(REASON_REFUSED);
}

function flatClips(project: Project): Clip[] {
  return project.tracks.flatMap((track) => track.clips);
}

function toGrooveResult(result: NoteEditResult): GrooveEditResult {
  return result.ok
    ? { ok: true, changed: result.changed ? result.noteIds.length : 0, message: result.message }
    : { ok: false, reason: result.reason };
}

/** 強さ付きクオンタイズ(開始位置だけ)。strength は 0〜100 %、snap は拍。 */
export function quantizeNotesWithStrength(
  clipId: string,
  noteIds: readonly string[],
  snapBeats: number,
  strengthPercent: number,
): GrooveEditResult {
  if (!Number.isFinite(snapBeats) || snapBeats < 1 / PPQ) return refuse('グリッドを正しく選んでください。');
  if (!Number.isFinite(strengthPercent) || strengthPercent < 0 || strengthPercent > 100) {
    return refuse('強さは0〜100%で指定してください。');
  }
  const strength = Math.round(strengthPercent);
  return toGrooveResult(retimeSelectedNotes(
    clipId,
    noteIds,
    (selected) => quantize(selected, snapBeats, { strength, target: 'start' }),
    (count) => `${count}個のノートをグリッドへ寄せました。`,
    '変更はありません',
  ));
}

/** ヒューマナイズ。seed が同じなら結果も同じ。seed は保存せず、呼び出し側が毎回渡す。 */
export function humanizeNotes(
  clipId: string,
  noteIds: readonly string[],
  options: Readonly<{ timingTicks: number; velocity: number; seed: number }>,
): GrooveEditResult {
  const { timingTicks, velocity, seed } = options;
  if (!Number.isInteger(timingTicks) || timingTicks < 0 || timingTicks > MAX_HUMANIZE_TIMING_TICKS) {
    return refuse(`タイミングのゆれは0〜${MAX_HUMANIZE_TIMING_TICKS}ティックで指定してください。`);
  }
  if (!Number.isInteger(velocity) || velocity < 0 || velocity > MAX_HUMANIZE_VELOCITY) {
    return refuse(`強さのゆれは0〜${MAX_HUMANIZE_VELOCITY}で指定してください。`);
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_HUMANIZE_SEED) return refuse('乱数の種が正しくありません。');
  return toGrooveResult(retimeSelectedNotes(
    clipId,
    noteIds,
    (selected) => humanize(selected, { timingBeats: timingTicks / PPQ, velocity, seed }),
    (count) => `${count}個のノートを人の演奏らしくゆらしました。`,
    '変更はありません',
  ));
}

/** ドラムクリップの 1 小節あたりのステップ数を 12 / 16 で切り替える。 */
export function setDrumStepsPerBar(clipId: string, steps: number): GrooveEditResult {
  if (!DRUM_STEPS_PER_BAR_CHOICES.some((choice) => choice === steps)) return refuse('ステップ数は12か16から選んでください。');
  if (recordingActive()) return refuse(REASON_RECORDING);
  const snapshot = useStore.getState().project;
  const resolved = findClip(snapshot, clipId);
  if (!resolved || resolved.type !== 'drum') return refuse('ドラムクリップを選んでください。');
  const ownerId = resolved.aliasOf ?? resolved.id;
  const owner = flatClips(snapshot).find((clip) => clip.id === ownerId);
  if (!owner || owner.type !== 'drum') return refuse('ドラムクリップを選んでください。');
  const from = owner.stepsPerBar ?? 16;
  if (from === steps) return { ok: true, changed: 0 };
  const result = resampleDrumSteps(owner.drumEvents ?? [], from, steps, {
    beatsPerBar: projectBeatsPerBarAt(snapshot, owner.startBeat),
    clipStartBeat: owner.startBeat,
  });
  if (result.outOfRange > 0) return refuse('ステップを置き換えられない音があるため、切り替えませんでした。');
  const next: Project = {
    ...snapshot,
    tracks: snapshot.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === ownerId ? { ...clip, stepsPerBar: steps, drumEvents: result.events } : clip),
    })),
  };
  if (scheduleProblem(next) !== null) return refuse('この設定では演奏データが作れないため、反映しませんでした。');
  // 鳴っている打点が、まとめた分以外の理由(クリップの外へ出るなど)で消えないか確かめる。
  // 1 つずつ置き換えた「まとめない版」の数と、元の数を比べる。
  const withEvents = (drumEvents: Clip['drumEvents']): Project => ({
    ...next,
    tracks: next.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => (clip.id === ownerId ? { ...clip, drumEvents } : clip)),
    })),
  });
  let silent = 0;
  try {
    const hits = (project: Project): number =>
      buildScheduleEvents(project).filter((event) => (event.payload as SchedulePayload).kind === 'drum').length;
    const unmerged = (owner.drumEvents ?? []).flatMap((event) =>
      resampleDrumSteps([event], from, steps, {
        beatsPerBar: projectBeatsPerBarAt(snapshot, owner.startBeat),
        clipStartBeat: owner.startBeat,
      }).events);
    silent = hits(snapshot) - hits(withEvents(unmerged));
  } catch {
    return refuse('この設定では演奏データが作れないため、切り替えませんでした。');
  }
  if (silent > 0) {
    return refuse(`切り替えると ${silent} 個の音がクリップの外に出て鳴らなくなるため、切り替えられません。`);
  }
  return commit(snapshot, next)
    ? { ok: true, changed: 1, moved: result.moved, merged: result.merged }
    : refuse('クリップの終わりをはみ出す音ができるため、切り替えませんでした。');
}
