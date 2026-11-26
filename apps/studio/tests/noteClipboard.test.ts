// @vitest-environment jsdom
// Piano-roll note editing (US-014): in-memory clipboard, semitone / scale-degree
// transposition and fitting to the scale. Edits land on resolveEditTarget (the
// link source), note beats stay clip-relative, and every change is one undo step.
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Clip, NoteEvent, PitchClassName, Track } from '@cts/project-model';
import { resolveEditTarget, soundingEvents, validateProject } from '@cts/project-model';
import { createPrng, getScalePitchClasses, isInScale, pick, randomInt, type ScaleName } from '@cts/theory-engine';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');
let bridge: typeof import('../src/state/tutorialBridge');
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
  bridge = await import('../src/state/tutorialBridge');
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
});

afterEach(() => cleanup());

function note(id: string, pitch: number, startBeat: number, durationBeats = 1): NoteEvent {
  return { id, pitch, startBeat, durationBeats, velocity: 90 };
}

function midiClip(id: string, startBeat: number, lengthBeats: number, notes: NoteEvent[], extra: Partial<Clip> = {}): Clip {
  return { id, trackId: 'tr-a', type: 'midi', startBeat, lengthBeats, loop: false, notes, ...extra };
}

/** Replace the project's tracks with one instrument track (plus `more`) and reset history. */
function setup(clips: Clip[], opts: { key?: PitchClassName; scale?: ScaleName; positionBeat?: number; more?: Track[] } = {}) {
  act(() => useStore.getState().createNewProject('テスト'));
  useStore.setState((s) => {
    const template = s.project.tracks.find((t) => t.type === 'instrument')!;
    const track: Track = { ...template, id: 'tr-a', name: 'メロディ', clips, mute: false, solo: false };
    return {
      project: {
        ...s.project,
        key: opts.key ?? 'C',
        scale: opts.scale ?? 'major',
        lengthBars: 16,
        timeSignature: [4, 4],
        tracks: [track, ...(opts.more ?? [])],
      },
      past: [],
      future: [],
      transport: { ...s.transport, isPlaying: false, positionBeat: opts.positionBeat ?? 0 },
      noteClipboard: [],
    };
  });
  // 参照切れのリンクは validateProject を通らない(読み込み・保存では作られない)ので、それを含む場面だけ除く。
  const broken = clips.some((c) => c.aliasOf !== undefined && !clips.some((o) => o.id === c.aliasOf));
  expect(validateProject(useStore.getState().project).ok).toBe(!broken);
}

function clipNotes(clipId: string): NoteEvent[] {
  return resolveEditTarget(useStore.getState().project, clipId)?.notes ?? [];
}

function lastToast(): string | undefined {
  return bridge.getBridgeSnapshot().toasts.at(-1)?.message;
}

function setPlayhead(beat: number) {
  useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: beat } }));
}

describe('コピーと貼り付け', () => {
  beforeEach(() => setup([midiClip('clip-1', 8, 16, [note('n1', 60, 2), note('n2', 64, 3, 0.5)])]));

  it('貼り付けは再生ヘッドの位置(クリップ内)を基準に、最初の音からの間隔を保って置く', () => {
    expect(actions.copyNotes('clip-1', ['n1', 'n2'])).toBe(2);
    expect(useStore.getState().past).toHaveLength(0); // コピーは内容を変えない
    setPlayhead(8 + 6); // クリップ先頭から 6 拍
    const ids = actions.pasteNotes('clip-1');
    expect(ids).toHaveLength(2);
    expect(useStore.getState().past).toHaveLength(1);
    const pasted = clipNotes('clip-1').filter((n) => ids.includes(n.id));
    expect(pasted.map((n) => [n.pitch, n.startBeat, n.durationBeats])).toEqual([[60, 6, 1], [64, 7, 0.5]]);
    expect(useStore.getState().editor.selectedNoteIds).toEqual(ids);
    expect(clipNotes('clip-1')).toHaveLength(4);
  });

  it('再生ヘッドがクリップの外ならクリップの先頭(相対 0 拍)に置く', () => {
    actions.copyNotes('clip-1', ['n1', 'n2']);
    setPlayhead(2); // クリップより前
    const before = actions.pasteNotes('clip-1');
    expect(clipNotes('clip-1').filter((n) => before.includes(n.id)).map((n) => n.startBeat)).toEqual([0, 1]);
    setPlayhead(8 + 16); // クリップの終わりちょうど(外)
    const atEnd = actions.pasteNotes('clip-1');
    expect(clipNotes('clip-1').filter((n) => atEnd.includes(n.id)).map((n) => n.startBeat)).toEqual([0, 1]);
    expect(useStore.getState().past).toHaveLength(2);
  });

  it('再生ヘッドがクリップの先頭ちょうど(拍 0)なら相対 0 拍に置く', () => {
    actions.copyNotes('clip-1', ['n2']);
    setPlayhead(8);
    const ids = actions.pasteNotes('clip-1');
    expect(clipNotes('clip-1').find((n) => n.id === ids[0])?.startBeat).toBe(0);
  });

  it('クリップの長さを超える分は貼らず、クリップは伸ばさずにトーストで知らせる', () => {
    actions.copyNotes('clip-1', ['n1', 'n2']); // 0 拍 (1 拍) と 1 拍 (0.5 拍)
    setPlayhead(8 + 15.5);
    const ids = actions.pasteNotes('clip-1');
    expect(ids).toHaveLength(1);
    const pasted = clipNotes('clip-1').find((n) => n.id === ids[0]);
    expect(pasted).toMatchObject({ pitch: 60, startBeat: 15.5, durationBeats: 0.5 });
    expect(useStore.getState().project.tracks[0]!.clips[0]!.lengthBeats).toBe(16);
    expect(lastToast()).toBe(actions.NOTE_EDIT_MESSAGES.pastePartial);
    expect(validateProject(useStore.getState().project).ok).toBe(true);
  });

  it('コピーしていないときは何も変えず案内する', () => {
    const before = useStore.getState().project;
    expect(actions.pasteNotes('clip-1')).toEqual([]);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
    expect(lastToast()).toBe(actions.NOTE_EDIT_MESSAGES.emptyClipboard);
  });

  it('選択 0 件のコピー・切り取り・移調・スケール適合は何も変えない', () => {
    const before = useStore.getState().project;
    expect(actions.copyNotes('clip-1', [])).toBe(0);
    expect(actions.cutNotes('clip-1', [])).toBe(false);
    expect(actions.transposeSelected('clip-1', [], { semitones: 1 })).toBe(false);
    expect(actions.transposeSelected('clip-1', [], { degrees: 1 })).toBe(false);
    expect(actions.fitSelectedToScale('clip-1', [])).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
  });
});

describe('端数の拍のクリップ(Codex レビュー 1)', () => {
  it('開始 1/1200 拍・長さ 4+1/1200 拍のクリップで再生ヘッドが絶対 4 拍なら、相対 4−1/1200 拍に貼り、鳴る', () => {
    setup([midiClip('clip-f', 1 / 1200, 4 + 1 / 1200, [note('n1', 60, 0, 0.5)])]);
    actions.copyNotes('clip-f', ['n1']);
    setPlayhead(4); // 絶対 tick 1920。クリップの終了 tick は round((4 + 2/1200) * 480) = 1921
    const ids = actions.pasteNotes('clip-f');
    expect(ids).toHaveLength(1);
    const pasted = clipNotes('clip-f').find((n) => n.id === ids[0])!;
    expect(pasted.startBeat).toBe(4 - 1 / 1200);
    expect(pasted.startBeat + pasted.durationBeats).toBeCloseTo(4 + 1 / 1200, 12);
    const events = soundingEvents(useStore.getState().project, { clipId: 'clip-f', includeMuted: true }).events;
    expect(events).toHaveLength(2);
    expect(validateProject(useStore.getState().project).ok).toBe(true);
  });

  it('再生ヘッドが絶対の終了 tick ちょうどならクリップの外として先頭に貼る', () => {
    setup([midiClip('clip-f', 1 / 1200, 4 + 1 / 1200, [note('n1', 60, 0, 0.5)])]);
    actions.copyNotes('clip-f', ['n1']);
    setPlayhead(1921 / 480);
    const ids = actions.pasteNotes('clip-f');
    expect(clipNotes('clip-f').find((n) => n.id === ids[0])?.startBeat).toBe(0);
  });

  it('再生ヘッドがクリップ開始と同じ tick で半端に手前でも、負の位置に貼らない', () => {
    setup([midiClip('clip-f', 1 / 1200, 4 + 1 / 1200, [note('n1', 60, 0, 0.5)])]);
    actions.copyNotes('clip-f', ['n1']);
    setPlayhead(0); // 絶対 tick 0 はクリップ開始 tick 0 と同じ
    const ids = actions.pasteNotes('clip-f');
    expect(clipNotes('clip-f').find((n) => n.id === ids[0])?.startBeat).toBe(0);
    expect(validateProject(useStore.getState().project).ok).toBe(true);
  });
});

describe('移調 API の入力の守り(Codex レビュー 2)', () => {
  const BAD = [Infinity, -Infinity, NaN, 0.5, -1.25, 1e-9];
  it.each(BAD)('degrees / semitones = %s は何もせず false を返す', (value) => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 60, 0)])]);
    const before = useStore.getState().project;
    expect(actions.transposeSelected('clip-1', ['n1'], { degrees: value })).toBe(false);
    expect(actions.transposeSelected('clip-1', ['n1'], { semitones: value })).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
    expect(clipNotes('clip-1')[0]!.pitch).toBe(60);
  });
});

describe('切り取り', () => {
  it('元の音が消え、貼り付けで戻せる。切り取りと貼り付けはそれぞれ Undo 1 段', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 60, 1), note('n2', 62, 2)])]);
    expect(actions.cutNotes('clip-1', ['n1'])).toBe(true);
    expect(clipNotes('clip-1').map((n) => n.id)).toEqual(['n2']);
    expect(useStore.getState().past).toHaveLength(1);
    setPlayhead(4);
    const ids = actions.pasteNotes('clip-1');
    expect(clipNotes('clip-1').find((n) => n.id === ids[0])).toMatchObject({ pitch: 60, startBeat: 4 });
    expect(useStore.getState().past).toHaveLength(2);
    act(() => useStore.getState().undo());
    act(() => useStore.getState().undo());
    expect(clipNotes('clip-1').map((n) => n.id)).toEqual(['n1', 'n2']);
  });
});

describe('移調', () => {
  it('全選択して +12 半音で MIDI 127 を超える音があれば、何も変えずにトーストを出す', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 60, 0), note('n2', 120, 1)])]);
    const before = useStore.getState().project;
    const all = clipNotes('clip-1').map((n) => n.id);
    expect(actions.transposeSelected('clip-1', all, { semitones: 12 })).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
    expect(lastToast()).toContain('これ以上高くできません');
  });

  it('下へはみ出すときは「これ以上低くできません」', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 0, 0)])]);
    expect(actions.transposeSelected('clip-1', ['n1'], { semitones: -1 })).toBe(false);
    expect(lastToast()).toContain('これ以上低くできません');
    expect(actions.transposeSelected('clip-1', ['n1'], { degrees: -1 })).toBe(false);
    expect(clipNotes('clip-1')[0]!.pitch).toBe(0);
  });

  it('127 ちょうどまでは上げられる', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 115, 0)])]);
    expect(actions.transposeSelected('clip-1', ['n1'], { semitones: 12 })).toBe(true);
    expect(clipNotes('clip-1')[0]!.pitch).toBe(127);
  });

  it('半音移調は選んだ音だけを動かし、past が 1 増える', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 60, 0), note('n2', 64, 1)])]);
    expect(actions.transposeSelected('clip-1', ['n2'], { semitones: -1 })).toBe(true);
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([60, 63]);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('度数移調はキーのスケールに沿い、B→C のオクターブ境界をまたぐ', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 59, 0), note('n2', 61, 1)])]);
    expect(actions.transposeSelected('clip-1', ['n1', 'n2'], { degrees: 1 })).toBe(true);
    // B3 → C4、スケール外の C#4 は C4 に丸めてから → D4
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([60, 62]);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('マイナーキー(A natural minor)では G→A、A→G と動く', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 67, 0), note('n2', 69, 1)])], { key: 'A', scale: 'naturalMinor' });
    actions.transposeSelected('clip-1', ['n1'], { degrees: 1 });
    actions.transposeSelected('clip-1', ['n2'], { degrees: -1 });
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([69, 67]);
    expect(useStore.getState().past).toHaveLength(2);
  });
});

describe('スケールに合わせる', () => {
  it('スケール外の音だけを近いスケール音(等距離なら下)へ寄せる。past が 1 増える', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 61, 0), note('n2', 64, 1), note('n3', 66, 2)])]);
    expect(actions.fitSelectedToScale('clip-1', ['n1', 'n2', 'n3'])).toBe(true);
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([60, 64, 65]);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('すべてスケール内なら Undo の段を増やさず案内する', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 60, 0)])]);
    expect(actions.fitSelectedToScale('clip-1', ['n1'])).toBe(false);
    expect(useStore.getState().past).toHaveLength(0);
    expect(lastToast()).toBe(actions.NOTE_EDIT_MESSAGES.alreadyInScale);
  });

  it('マイナーキーのモード(harmonic minor)では G# はスケール内', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 68, 0), note('n2', 70, 1)])], { key: 'A', scale: 'harmonicMinor' });
    actions.fitSelectedToScale('clip-1', ['n1', 'n2']);
    // A harmonic minor: G#(68) は残り、A#(70) は A(69) と B(71) の等距離 → 下の A
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([68, 69]);
  });
});

describe('リンククリップ', () => {
  const source = () => midiClip('src', 0, 8, [note('n1', 60, 0), note('n2', 62, 1)]);
  const link = () => midiClip('link', 16, 8, [], { aliasOf: 'src' });

  it('リンクを通した移調は参照先に書き、共有するすべてのクリップに反映される', () => {
    setup([source(), link(), midiClip('link2', 32, 8, [], { aliasOf: 'src' })]);
    expect(actions.transposeSelected('link', ['n1'], { semitones: 2 })).toBe(true);
    const clips = useStore.getState().project.tracks[0]!.clips;
    expect(clips.find((c) => c.id === 'src')!.notes!.map((n) => n.pitch)).toEqual([62, 62]);
    expect(clips.find((c) => c.id === 'link')!.notes).toEqual([]);
    expect(clipNotes('link2').map((n) => n.pitch)).toEqual([62, 62]);
  });

  it('リンクへの貼り付けはリンクの位置で再生ヘッドを読み、参照先に書く', () => {
    setup([source(), link()]);
    actions.copyNotes('src', ['n2']);
    setPlayhead(16 + 3);
    const ids = actions.pasteNotes('link');
    expect(ids).toHaveLength(1);
    const src = useStore.getState().project.tracks[0]!.clips.find((c) => c.id === 'src')!;
    expect(src.notes!.find((n) => n.id === ids[0])).toMatchObject({ pitch: 62, startBeat: 3 });
    expect(validateProject(useStore.getState().project).ok).toBe(true);
  });

  it('参照切れのリンクでは何も変えず理由を出す', () => {
    setup([source(), midiClip('broken', 16, 8, [], { aliasOf: 'missing' })]);
    actions.copyNotes('src', ['n1']);
    const before = useStore.getState().project;
    expect(actions.pasteNotes('broken')).toEqual([]);
    expect(lastToast()).toBe(actions.NOTE_EDIT_MESSAGES.missingTarget);
    expect(actions.transposeSelected('broken', ['n1'], { semitones: 1 })).toBe(false);
    expect(actions.cutNotes('broken', ['n1'])).toBe(false);
    expect(actions.fitSelectedToScale('broken', ['n1'])).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
  });
});

describe('ループするクリップ', () => {
  it('貼り付けは繰り返しの 1 回分に収め、2 周目の再生ヘッドは 1 周目の同じ位置に写す', () => {
    setup([midiClip('clip-1', 0, 16, [note('n1', 60, 0)], { loop: true, contentLengthBeats: 4 })]);
    actions.copyNotes('clip-1', ['n1']);
    setPlayhead(4 + 1.5); // 2 周目の 1.5 拍
    const ids = actions.pasteNotes('clip-1');
    expect(clipNotes('clip-1').find((n) => n.id === ids[0])?.startBeat).toBe(1.5);
    setPlayhead(3.5); // 1 周目の終わり近く: 0.5 拍だけ残す
    const tail = actions.pasteNotes('clip-1');
    expect(clipNotes('clip-1').find((n) => n.id === tail[0])).toMatchObject({ startBeat: 3.5, durationBeats: 0.5 });
  });
});

describe('PianoRoll のショートカットと説明文', () => {
  it('Ctrl/Cmd+A で全選択、C でコピー、V で貼り付け、↑ で半音上げる', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 60, 0), note('n2', 64, 1)])]);
    useStore.setState((s) => ({ editor: { ...s.editor, activeView: 'pianoRoll', selectedClipId: 'clip-1', selectedTrackId: 'tr-a', selectedNoteIds: [] } }));
    render(createElement(PianoRoll));
    act(() => { fireEvent.keyDown(window, { key: 'a', ctrlKey: true }); });
    expect(useStore.getState().editor.selectedNoteIds).toEqual(['n1', 'n2']);
    act(() => { fireEvent.keyDown(window, { key: 'ArrowUp' }); });
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([61, 65]);
    act(() => { fireEvent.keyDown(window, { key: 'c', metaKey: true }); });
    setPlayhead(4);
    act(() => { fireEvent.keyDown(window, { key: 'v', ctrlKey: true }); });
    expect(clipNotes('clip-1')).toHaveLength(4);
    act(() => { fireEvent.keyDown(window, { key: 'x', ctrlKey: true }); });
    expect(clipNotes('clip-1')).toHaveLength(2);
    expect(useStore.getState().past).toHaveLength(3);
  });

  it('ツールバーに移調・スケール適合のボタンと、スケール外の音の説明文がある(初心者は簡略文)', () => {
    setup([midiClip('clip-1', 0, 8, [note('n1', 61, 0)])]);
    useStore.setState((s) => ({ editor: { ...s.editor, activeView: 'pianoRoll', selectedClipId: 'clip-1', selectedTrackId: 'tr-a', selectedNoteIds: ['n1'], difficulty: 'standard' } }));
    const { rerender } = render(createElement(PianoRoll));
    expect(screen.getByText(/スケール外の音も、経過音やブルーノートとして/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'スケールに合わせる' }));
    expect(clipNotes('clip-1')[0]!.pitch).toBe(60);
    fireEvent.click(screen.getByRole('button', { name: '上へ 1 度' }));
    expect(clipNotes('clip-1')[0]!.pitch).toBe(62);
    fireEvent.click(screen.getByRole('button', { name: '下へ 1 半音' }));
    expect(clipNotes('clip-1')[0]!.pitch).toBe(61);
    act(() => useStore.setState((s) => ({ editor: { ...s.editor, difficulty: 'beginner' } })));
    rerender(createElement(PianoRoll));
    expect(screen.queryByText(/経過音やブルーノート/)).toBeNull();
    expect(screen.getByText(/スケール外の音も、/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Property test: seed-fixed random clips and notes.
// ---------------------------------------------------------------------------

const SCALES: ScaleName[] = ['major', 'naturalMinor', 'harmonicMinor', 'melodicMinor', 'majorPentatonic', 'minorPentatonic', 'blues'];
const KEYS: PitchClassName[] = ['C', 'G', 'F', 'Bb', 'A', 'E', 'Eb', 'F#'];
const FRACTIONS = [0, 1 / 3, 0.25, 0.5, 2 / 7, 0.125, 1 / 1200];
/** 有限の整数でない移調量(必ず拒否される)。 */
const ODD_INPUTS = [NaN, Infinity, -Infinity, 0.5, -2.5, 1 / 3];

type Rng = () => number;

function randomBeat(rng: Rng, maxWhole: number): number {
  return randomInt(rng, 0, maxWhole) + FRACTIONS[randomInt(rng, 0, FRACTIONS.length - 1)]!;
}

function randomPitch(rng: Rng): number {
  const r = rng();
  if (r < 0.25) return randomInt(rng, 0, 4);
  if (r < 0.5) return randomInt(rng, 123, 127);
  return randomInt(rng, 30, 100);
}

function randomScenario(rng: Rng, index: number) {
  const clips: Clip[] = [];
  const count = randomInt(rng, 1, 3);
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const start = cursor + randomBeat(rng, 3);
    const length = randomInt(rng, 2, 8) + FRACTIONS[randomInt(rng, 1, FRACTIONS.length - 1)]!;
    const notes: NoteEvent[] = [];
    const noteCount = randomInt(rng, 0, 5);
    for (let k = 0; k < noteCount; k += 1) {
      notes.push(note(`p${index}-${i}-${k}`, randomPitch(rng), randomBeat(rng, Math.floor(length)), 0.25 + randomBeat(rng, 2)));
    }
    const loop = rng() < 0.3;
    const extra: Partial<Clip> = loop ? { loop: true, contentLengthBeats: randomInt(rng, 1, 3) + 0.5 } : {};
    if (i > 0 && rng() < 0.35) {
      clips.push(midiClip(`c${i}`, start, length, [], { ...extra, aliasOf: rng() < 0.85 ? 'c0' : 'gone' }));
    } else {
      clips.push(midiClip(`c${i}`, start, length, notes, extra));
    }
    cursor = start + length;
  }
  return {
    clips,
    key: KEYS[randomInt(rng, 0, KEYS.length - 1)]!,
    scale: SCALES[randomInt(rng, 0, SCALES.length - 1)]!,
    positionBeat: randomBeat(rng, Math.ceil(cursor) + 2),
    mute: rng() < 0.3,
  };
}

describe('プロパティ: ランダムなクリップとノートへの編集', () => {
  it('結果は validateProject を通り、音高は 0〜127、拒否なら元のまま、Undo 1 段で元に戻る', () => {
    const rng = createPrng(1127);
    let changed = 0;
    let refused = 0;
    for (let iter = 0; iter < 300; iter += 1) {
      const scenario = randomScenario(rng, iter);
      setup(scenario.clips, { key: scenario.key, scale: scenario.scale, positionBeat: scenario.positionBeat });
      if (scenario.mute) {
        useStore.setState((s) => ({ project: { ...s.project, tracks: s.project.tracks.map((t) => ({ ...t, mute: true })) } }));
      }
      const clipId = scenario.clips[randomInt(rng, 0, scenario.clips.length - 1)]!.id;
      const targetNotes = clipNotes(clipId);
      const ids = targetNotes.filter(() => rng() < 0.6).map((n) => n.id);
      const before = useStore.getState().project;
      const pastBefore = useStore.getState().past.length;
      const op = randomInt(rng, 0, 5);
      let ok: boolean;
      let expectRefused = false;
      if (op === 0) {
        actions.copyNotes(clipId, ids);
        ok = actions.pasteNotes(clipId).length > 0;
      } else if (op === 1) {
        ok = actions.cutNotes(clipId, ids);
      } else if (op === 2) {
        actions.copyNotes(clipId, ids);
        // 別のクリップへ貼る
        const other = scenario.clips[randomInt(rng, 0, scenario.clips.length - 1)]!.id;
        ok = actions.pasteNotes(other).length > 0;
      } else if (op === 3) {
        const semitones = rng() < 0.2 ? pick(rng, ODD_INPUTS) : randomInt(rng, -13, 13);
        const selected = targetNotes.filter((n) => ids.includes(n.id));
        expectRefused = !Number.isInteger(semitones) ||
          selected.some((n) => n.pitch + semitones > 127 || n.pitch + semitones < 0);
        ok = actions.transposeSelected(clipId, ids, { semitones });
      } else if (op === 4) {
        const degrees = rng() < 0.2 ? pick(rng, ODD_INPUTS) : randomInt(rng, -8, 8);
        expectRefused = !Number.isInteger(degrees);
        ok = actions.transposeSelected(clipId, ids, { degrees });
        const selected = targetNotes.filter((n) => ids.includes(n.id));
        const inScale = selected.every((n) => isInScale(n.pitch, scenario.key, scenario.scale));
        if (ok && inScale) {
          // +n して −n すると元に戻る(スケール内の音)。
          expect(actions.transposeSelected(clipId, ids, { degrees: -degrees })).toBe(true);
          expect(clipNotes(clipId)).toEqual(targetNotes);
          act(() => useStore.getState().undo());
        }
      } else {
        ok = actions.fitSelectedToScale(clipId, ids);
      }
      const after = useStore.getState().project;
      // 編集で新しい検証エラーを作らない(参照切れのリンクの場面は元のエラーのまま)。
      expect(validateProject(after).errors, `iter ${iter} op ${op}`).toEqual(validateProject(before).errors);
      for (const track of after.tracks) {
        for (const clip of track.clips) {
          for (const n of clip.notes ?? []) {
            expect(Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127).toBe(true);
          }
        }
      }
      if (expectRefused) expect(ok).toBe(false);
      if (!ok) {
        expect(after).toBe(before);
        expect(useStore.getState().past).toHaveLength(pastBefore);
        refused += 1;
        continue;
      }
      changed += 1;
      expect(useStore.getState().past).toHaveLength(pastBefore + 1);
      // 編集は参照先にだけ入り、リンク自身は中身を持たない。
      for (const clip of after.tracks[0]!.clips) {
        if (clip.aliasOf !== undefined) expect(clip.notes ?? []).toEqual([]);
      }
      if (op === 4 || op === 5) {
        const scalePcs = new Set(getScalePitchClasses(scenario.key, scenario.scale));
        for (const n of clipNotes(clipId).filter((x) => ids.includes(x.id))) {
          expect(scalePcs.has(((n.pitch % 12) + 12) % 12)).toBe(true);
        }
      }
      act(() => useStore.getState().undo());
      expect(useStore.getState().project).toEqual(before);
    }
    // ランダムの組み合わせが両方の経路を通ることを確かめる。
    expect(changed).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(20);
  });
});
