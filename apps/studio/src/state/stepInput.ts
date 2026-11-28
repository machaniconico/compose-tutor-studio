// ピアノロールのステップ入力(移植 P43 / wave5 US-036)。
//
// 決めた規則:
// - 音を 1 つ入力するたびに Undo 1 段(セッション全体を 1 段にはしない)。休符とカーソル移動は曲を変えない。
// - カーソルはクリップの先頭から数えた整数 tick。入力した長さだけ進む。クリップの終わりを
//   超える入力・休符は断り(クリップは伸ばさない)、その旨を知らせる。
// - バックスペースは最後に入力した音(休符ならその分のカーソルだけ)を取り消して 1 つ戻る。
//   Undo で音が先に消えていても、カーソルだけ戻して続けられる。
// - 録音中は入力しない。曲を切り替える・クリップを変えるとセッションは捨てる(保存もしない)。
// - PC 鍵盤(P40)からの入力は、`stepInputPlay(clipId, pitch)` を呼ぶだけで同じ経路に乗る。
import { create } from 'zustand';
import { PPQ, beatTick, resolveClipContent, type Project } from '@cts/project-model';
import { stepInsertNote, stepRemoveNote } from './noteEditActions';
import { useStore } from './store';

export type StepLength = Readonly<{ ticks: number; label: string }>;

/** 選べる音符の長さ(三連符は 1 拍を 3 等分などで、すべて整数 tick)。 */
export const STEP_LENGTHS: readonly StepLength[] = [
  { ticks: PPQ, label: '4分音符' },
  { ticks: PPQ / 2, label: '8分音符' },
  { ticks: PPQ / 4, label: '16分音符' },
  { ticks: PPQ / 8, label: '32分音符' },
  { ticks: (PPQ * 2) / 3, label: '4分3連' },
  { ticks: PPQ / 3, label: '8分3連' },
  { ticks: PPQ / 6, label: '16分3連' },
];

/** 入力した音の控え。Backspace は、同じ id の音が今もこの内容のままのときだけ消す。 */
type NoteSnapshot = Readonly<{ id: string; pitch: number; startTick: number; durationTicks: number; velocity: number }>;
type Entry = Readonly<{ note: NoteSnapshot | null; fromTicks: number }>;

type StepInputState = {
  active: boolean;
  clipId: string | null;
  stepTicks: number;
  cursorTicks: number;
  history: readonly Entry[];
};

export const useStepInput = create<StepInputState>(() => ({
  active: false,
  clipId: null,
  stepTicks: PPQ / 2,
  cursorTicks: 0,
  history: [],
}));

export type StepInputResult = Readonly<{ ok: boolean; message: string }>;

function findClip(project: Project, clipId: string) {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return resolveClipContent(project, clip) ?? clip;
  }
  return null;
}

/** 録音中(オーディオ録音・MIDI のテイク)は、ステップ入力を始めることも続けることもしない。 */
function recordingLock(): string | null {
  const state = useStore.getState();
  return state.audioRecordingOperationId !== null || state.midiRecordingActive
    ? '録音中はステップ入力できません。録音を止めてからやり直してください。'
    : null;
}

function clipTicks(lengthBeats: number): number {
  return Math.floor(lengthBeats * PPQ + 1e-6);
}

/** セッションを捨てる(曲の切り替え・クリップの変更・終了)。 */
export function stopStepInput(): void {
  useStepInput.setState({ active: false, clipId: null, cursorTicks: 0, history: [] });
}

/** 入力を始める。カーソルは再生ヘッドがクリップの中ならその位置、外なら先頭。 */
export function startStepInput(clipId: string): StepInputResult {
  const state = useStore.getState();
  const locked = recordingLock();
  if (locked) return { ok: false, message: locked };
  const clip = findClip(state.project, clipId);
  if (!clip || clip.type !== 'midi') {
    return { ok: false, message: 'MIDI クリップを選んでからステップ入力を始めてください。' };
  }
  const position = state.transport.positionBeat;
  const inside = Number.isFinite(position) && position >= clip.startBeat && position < clip.startBeat + clip.lengthBeats;
  const cursorTicks = inside ? Math.max(0, beatTick(position) - beatTick(clip.startBeat)) : 0;
  useStepInput.setState({ active: true, clipId, cursorTicks, history: [] });
  return { ok: true, message: 'ステップ入力を始めました。鍵盤を押すと音が入り、カーソルが進みます。' };
}

export function setStepLength(ticks: number): void {
  if (STEP_LENGTHS.some((length) => length.ticks === ticks)) useStepInput.setState({ stepTicks: ticks });
}

function session(): { clipId: string } | null {
  const { active, clipId } = useStepInput.getState();
  return active && clipId !== null ? { clipId } : null;
}

function snapshotOf(clipId: string, noteId: string | undefined): NoteSnapshot | null {
  const note = findClip(useStore.getState().project, clipId)?.notes?.find((candidate) => candidate.id === noteId);
  if (!note) return null;
  return {
    id: note.id,
    pitch: note.pitch,
    startTick: Math.round(note.startBeat * PPQ),
    durationTicks: Math.round(note.durationBeats * PPQ),
    velocity: note.velocity,
  };
}

/** カーソルの位置へ 1 音入れて、カーソルを進める。 */
export function stepInputPlay(pitch: number): StepInputResult {
  const current = session();
  if (!current) return { ok: false, message: 'ステップ入力はオフです。' };
  const locked = recordingLock();
  if (locked) return { ok: false, message: locked };
  const { stepTicks, cursorTicks, history } = useStepInput.getState();
  const result = stepInsertNote(current.clipId, pitch, cursorTicks, stepTicks);
  if (!result.ok) return { ok: false, message: result.reason };
  useStepInput.setState({
    cursorTicks: cursorTicks + stepTicks,
    history: [...history, { note: snapshotOf(current.clipId, result.noteIds[0]), fromTicks: cursorTicks }],
  });
  return { ok: true, message: result.message };
}

/** 休符: 音を入れずカーソルだけ進める。 */
export function stepInputRest(): StepInputResult {
  const current = session();
  if (!current) return { ok: false, message: 'ステップ入力はオフです。' };
  const state = useStore.getState();
  const locked = recordingLock();
  if (locked) return { ok: false, message: locked };
  const clip = findClip(state.project, current.clipId);
  const { stepTicks, cursorTicks, history } = useStepInput.getState();
  if (!clip || clip.type !== 'midi') {
    stopStepInput();
    return { ok: false, message: 'クリップが見つからないため、ステップ入力を終えました。' };
  }
  if (cursorTicks + stepTicks > clipTicks(clip.lengthBeats)) {
    return {
      ok: false,
      message: 'クリップの終わりまで来ました。これ以上は進めません(クリップの長さは変わりません)。',
    };
  }
  useStepInput.setState({ cursorTicks: cursorTicks + stepTicks, history: [...history, { note: null, fromTicks: cursorTicks }] });
  return { ok: true, message: '休符を入れました。' };
}

/** 最後の入力(音または休符)を取り消して、カーソルを 1 つ戻す。 */
export function stepInputBack(): StepInputResult {
  const current = session();
  if (!current) return { ok: false, message: 'ステップ入力はオフです。' };
  const locked = recordingLock();
  if (locked) return { ok: false, message: locked };
  const { history } = useStepInput.getState();
  const last = history[history.length - 1];
  if (!last) return { ok: false, message: 'ここから前には戻せる入力がありません。' };
  const rest = history.slice(0, -1);
  if (last.note === null) {
    useStepInput.setState({ cursorTicks: last.fromTicks, history: rest });
    return { ok: true, message: '休符を取り消して、1 つ戻りました。' };
  }
  const clip = findClip(useStore.getState().project, current.clipId);
  const found = clip?.notes?.find((note) => note.id === last.note?.id);
  if (!found) {
    // 元に戻す(Undo)などで音がすでにない。カーソルだけ戻す。
    useStepInput.setState({ cursorTicks: last.fromTicks, history: rest });
    return { ok: true, message: 'その音はすでにないため、カーソルだけ 1 つ戻しました。' };
  }
  const now = snapshotOf(current.clipId, found.id);
  const same = now !== null
    && now.pitch === last.note.pitch
    && now.startTick === last.note.startTick
    && now.durationTicks === last.note.durationTicks
    && now.velocity === last.note.velocity;
  if (!same) {
    // 入力したあとに動かした・作り直された音は、利用者のものなので消さない。
    useStepInput.setState({ cursorTicks: last.fromTicks, history: rest });
    return { ok: true, message: '入力したあとに変わった音なので消しません。カーソルだけ 1 つ戻しました。' };
  }
  const result = stepRemoveNote(current.clipId, last.note.id);
  if (!result.ok) return { ok: false, message: result.reason };
  useStepInput.setState({ cursorTicks: last.fromTicks, history: rest });
  return { ok: true, message: result.message };
}
