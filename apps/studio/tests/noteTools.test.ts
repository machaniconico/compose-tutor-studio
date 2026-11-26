// @vitest-environment jsdom
// Piano-roll note tools (US-015): legato, staccato, join, split at the playhead,
// arrow-key nudges, triplet grids and velocity ramps / randomization. Edits land
// on resolveEditTarget (the link source), note beats stay clip-relative, notes stay
// in the first pass, clip lengths never change and every change is one undo step.
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Clip, NoteEvent, Project, Track } from '@cts/project-model';
import { beatTick, placedNoteTicks, resolveEditTarget, songEndBeat, soundingEvents, validateProject } from '@cts/project-model';
import { createPrng, pick, randomInt } from '@cts/theory-engine';
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

function note(id: string, pitch: number, startBeat: number, durationBeats = 1, velocity = 90): NoteEvent {
  return { id, pitch, startBeat, durationBeats, velocity };
}

function midiClip(id: string, startBeat: number, lengthBeats: number, notes: NoteEvent[], extra: Partial<Clip> = {}): Clip {
  return { id, trackId: 'tr-a', type: 'midi', startBeat, lengthBeats, loop: false, notes, ...extra };
}

/** Replace the project's tracks with one instrument track and reset history. */
function setup(clips: Clip[], opts: { positionBeat?: number; swing?: number } = {}) {
  act(() => useStore.getState().createNewProject('テスト'));
  useStore.setState((s) => {
    const template = s.project.tracks.find((t) => t.type === 'instrument')!;
    const track: Track = { ...template, id: 'tr-a', name: 'メロディ', clips, mute: false, solo: false };
    return {
      project: { ...s.project, key: 'C', scale: 'major', lengthBars: 16, timeSignature: [4, 4], tracks: [track], swing: opts.swing },
      past: [],
      future: [],
      transport: { ...s.transport, isPlaying: false, positionBeat: opts.positionBeat ?? 0 },
      noteClipboard: [],
    };
  });
  const broken = clips.some((c) => c.aliasOf !== undefined && !clips.some((o) => o.id === c.aliasOf));
  expect(validateProject(useStore.getState().project).ok).toBe(!broken);
}

function clipNotes(clipId: string): NoteEvent[] {
  return resolveEditTarget(useStore.getState().project, clipId)?.notes ?? [];
}

function byId(clipId: string, id: string): NoteEvent {
  return clipNotes(clipId).find((n) => n.id === id)!;
}

function lastToast(): string | undefined {
  return bridge.getBridgeSnapshot().toasts.at(-1)?.message;
}

function setPlayhead(beat: number) {
  useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: beat } }));
}

/** The edit was refused: same project object, no undo step, and the given toast. */
function expectRefused(before: Project, ok: boolean, toast?: string) {
  expect(ok).toBe(false);
  expect(useStore.getState().project).toBe(before);
  expect(useStore.getState().past).toHaveLength(0);
  if (toast) expect(lastToast()).toBe(toast);
}

function expectOneUndoBack(before: Project) {
  expect(useStore.getState().past).toHaveLength(1);
  act(() => useStore.getState().undo());
  expect(useStore.getState().project).toEqual(before);
}

describe('レガート', () => {
  it('各ノートの終端が次のノートの開始に一致する(重なる音は次の開始で切る)。最後の音はそのまま', () => {
    setup([midiClip('clip-1', 4, 8, [note('n3', 67, 2.5, 3), note('n1', 60, 0, 0.5), note('n2', 64, 1, 0.25), note('n4', 72, 3, 1)])]);
    const before = useStore.getState().project;
    expect(actions.legato('clip-1', ['n1', 'n2', 'n3', 'n4'])).toBe(true);
    const sorted = [...clipNotes('clip-1')].sort((a, b) => a.startBeat - b.startBeat);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      expect(sorted[i]!.startBeat + sorted[i]!.durationBeats).toBe(sorted[i + 1]!.startBeat);
    }
    expect(byId('clip-1', 'n4').durationBeats).toBe(1);
    expect(useStore.getState().project.tracks[0]!.clips[0]!.lengthBeats).toBe(8);
    expect(validateProject(useStore.getState().project).ok).toBe(true);
    expectOneUndoBack(before);
  });

  it('同時に鳴る音(和音)はどちらも次の開始まで伸ばす', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0, 0.5), note('b', 64, 0, 0.25), note('c', 62, 2)])]);
    expect(actions.legato('clip-1', ['a', 'b', 'c'])).toBe(true);
    expect([byId('clip-1', 'a').durationBeats, byId('clip-1', 'b').durationBeats]).toEqual([2, 2]);
  });

  it('同じ絶対 tick に丸まる開始(1/1200 拍差)は「次の音」に数えず、長さ 0 tick の音を作らない', () => {
    setup([midiClip('clip-f', 0, 4, [note('a', 60, 0, 0.5), note('b', 62, 1 / 1200, 0.5), note('c', 64, 1)])]);
    expect(actions.legato('clip-f', ['a', 'b', 'c'])).toBe(true);
    expect(byId('clip-f', 'a').durationBeats).toBe(1);
    expect(byId('clip-f', 'b').durationBeats).toBe(1 - 1 / 1200);
  });

  it('次の音が 1 周目の外にあり、伸ばすと繰り返しの 1 回分を越えるなら何も変えず知らせる', () => {
    setup([midiClip('clip-l', 0, 16, [note('a', 60, 0, 1), note('b', 62, 5, 1)], { loop: true, contentLengthBeats: 4 })]);
    const before = useStore.getState().project;
    expectRefused(before, actions.legato('clip-l', ['a', 'b']), actions.NOTE_EDIT_MESSAGES.outsideFirstPass);
  });

  it('すでにレガートなら何も変えない(Undo の段も増えない)', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0, 1), note('b', 62, 1, 1)])]);
    const before = useStore.getState().project;
    expectRefused(before, actions.legato('clip-1', ['a', 'b']));
  });
});

describe('スタッカート', () => {
  it('選んだ音の長さが半分になり、開始は動かない', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 1, 1), note('b', 62, 2, 0.75), note('c', 64, 3, 1)])]);
    const before = useStore.getState().project;
    expect(actions.staccato('clip-1', ['a', 'b'])).toBe(true);
    expect(byId('clip-1', 'a')).toMatchObject({ startBeat: 1, durationBeats: 0.5 });
    expect(byId('clip-1', 'b')).toMatchObject({ startBeat: 2, durationBeats: 0.375 });
    expect(byId('clip-1', 'c').durationBeats).toBe(1);
    expectOneUndoBack(before);
  });

  it('半分にすると 1 tick 未満になる音があれば、何も変えず知らせる', () => {
    // b: 960 tick から 0.8 tick(終わりは 961 tick で 1 tick)。半分の 0.4 tick だと終わりも 960 tick になる。
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0, 1), note('b', 62, 2, 0.8 / 480)])]);
    const before = useStore.getState().project;
    expectRefused(before, actions.staccato('clip-1', ['a', 'b']), actions.NOTE_EDIT_MESSAGES.tooShort);
  });

  it('端数の開始(1/1200 拍)のクリップでも、長さは絶対 tick で 1 tick 以上を確かめる', () => {
    // 開始 0.4 tick、長さ 2 tick → 半分は 1 tick(0.4 + 1 = 1.4 → 1 tick、開始は 0 tick)
    setup([midiClip('clip-f', 1 / 1200, 4, [note('a', 60, 0, 2 / 480)])]);
    expect(actions.staccato('clip-f', ['a'])).toBe(true);
    const a = byId('clip-f', 'a');
    expect(beatTick(1 / 1200 + a.durationBeats) - beatTick(1 / 1200)).toBe(1);
  });
});

describe('つなぐ(joinNotes)', () => {
  it('同じ音高で隣り合う 2 つの音が 1 つになる(最初の音の id とベロシティを残す)', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0, 1, 70), note('b', 60, 1, 1.5, 110), note('c', 64, 1, 1)])]);
    const before = useStore.getState().project;
    expect(actions.joinNotes('clip-1', ['a', 'b', 'c'])).toBe(true);
    const notes = clipNotes('clip-1');
    expect(notes.filter((n) => n.pitch === 60)).toEqual([note('a', 60, 0, 2.5, 70)]);
    expect(notes).toHaveLength(2);
    expect(useStore.getState().editor.selectedNoteIds).toEqual(['a', 'c']);
    expectOneUndoBack(before);
  });

  it('重なっている同じ音高の音も 1 つにし、長い方の終わりまで伸ばす', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0, 2), note('b', 60, 1, 0.5), note('c', 60, 1.5, 2)])]);
    expect(actions.joinNotes('clip-1', ['a', 'b', 'c'])).toBe(true);
    expect(clipNotes('clip-1')).toEqual([note('a', 60, 0, 3.5)]);
  });

  it('間があく音・違う音高の音はつながず、つなげる音がなければ知らせる', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0, 1), note('b', 60, 1.5, 1), note('c', 62, 1, 1)])]);
    const before = useStore.getState().project;
    expectRefused(before, actions.joinNotes('clip-1', ['a', 'b', 'c']), actions.NOTE_EDIT_MESSAGES.nothingToJoin);
  });

  it('隣り合うかは絶対 tick で判定する(終わり 1 − 1/1200 拍と開始 1 拍は同じ tick)', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0, 1 - 1 / 1200), note('b', 60, 1, 1)])]);
    expect(actions.joinNotes('clip-1', ['a', 'b'])).toBe(true);
    expect(clipNotes('clip-1')).toEqual([note('a', 60, 0, 2)]);
  });
});

describe('再生ヘッドで分ける(splitNoteAtPlayhead)', () => {
  it('再生ヘッドの位置(絶対拍)で選んだ音を 2 つに分け、両方を選ぶ', () => {
    setup([midiClip('clip-1', 8, 8, [note('a', 60, 1, 2, 77), note('b', 64, 4, 1)])], { positionBeat: 8 + 1.5 });
    const before = useStore.getState().project;
    expect(actions.splitNoteAtPlayhead('clip-1', ['a', 'b'])).toBe(true);
    const pieces = clipNotes('clip-1').filter((n) => n.pitch === 60).sort((x, y) => x.startBeat - y.startBeat);
    expect(pieces.map((n) => [n.startBeat, n.durationBeats, n.velocity])).toEqual([[1, 0.5, 77], [1.5, 1.5, 77]]);
    expect(byId('clip-1', 'b').durationBeats).toBe(1);
    expect(useStore.getState().editor.selectedNoteIds).toEqual(expect.arrayContaining(pieces.map((n) => n.id)));
    expectOneUndoBack(before);
  });

  it('再生ヘッドが音の端(開始・終わり)にあれば何もしない', () => {
    setup([midiClip('clip-1', 8, 8, [note('a', 60, 1, 2)])], { positionBeat: 9 });
    const before = useStore.getState().project;
    expect(actions.splitNoteAtPlayhead('clip-1', ['a'])).toBe(false);
    setPlayhead(11);
    expect(actions.splitNoteAtPlayhead('clip-1', ['a'])).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
    expect(lastToast()).toBe(actions.NOTE_EDIT_MESSAGES.splitNothing);
  });

  it('端の判定は絶対 tick で行う(開始 1/1200 拍のクリップで再生ヘッドが絶対 1 拍 = 音の終わりの tick)', () => {
    // 音の終わり: round((1/1200 + 1) * 480) = round(480.4) = 480 tick = 絶対 1 拍
    setup([midiClip('clip-f', 1 / 1200, 4, [note('a', 60, 0, 1)])], { positionBeat: 1 });
    const before = useStore.getState().project;
    expect(actions.splitNoteAtPlayhead('clip-f', ['a'])).toBe(false);
    setPlayhead(0); // 開始の tick(0.4 → 0)
    expect(actions.splitNoteAtPlayhead('clip-f', ['a'])).toBe(false);
    expect(useStore.getState().project).toBe(before);
    setPlayhead(0.5);
    expect(actions.splitNoteAtPlayhead('clip-f', ['a'])).toBe(true);
    expect(validateProject(useStore.getState().project).ok).toBe(true);
  });

  it('ループするクリップでは 2 周目の再生ヘッドを 1 周目の同じ位置に写して分ける', () => {
    setup([midiClip('clip-l', 0, 16, [note('a', 60, 0, 2)], { loop: true, contentLengthBeats: 4 })], { positionBeat: 4 + 1 });
    expect(actions.splitNoteAtPlayhead('clip-l', ['a'])).toBe(true);
    expect(clipNotes('clip-l').map((n) => [n.startBeat, n.durationBeats])).toEqual([[0, 1], [1, 1]]);
    expect(useStore.getState().project.tracks[0]!.clips[0]!.lengthBeats).toBe(16);
  });

  it('リンクで分けると参照先に書き、再生ヘッドはリンクの位置で読む', () => {
    setup([midiClip('src', 0, 8, [note('a', 60, 0, 2)]), midiClip('link', 16, 8, [], { aliasOf: 'src' })], { positionBeat: 16 + 0.5 });
    expect(actions.splitNoteAtPlayhead('link', ['a'])).toBe(true);
    const clips = useStore.getState().project.tracks[0]!.clips;
    expect(clips.find((c) => c.id === 'src')!.notes!.map((n) => [n.startBeat, n.durationBeats])).toEqual([[0, 0.5], [0.5, 1.5]]);
    expect(clips.find((c) => c.id === 'link')!.notes).toEqual([]);
  });
});

describe('矢印での移動(nudge)', () => {
  it('↑ で +1、Shift+↑ で +12。範囲外になる場合は変更しない', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0), note('b', 64, 1)])]);
    expect(actions.nudge('clip-1', ['a', 'b'], { semitones: 1 })).toBe(true);
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([61, 65]);
    expect(actions.nudge('clip-1', ['a', 'b'], { semitones: 12 })).toBe(true);
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([73, 77]);
    setup([midiClip('clip-1', 0, 8, [note('a', 120, 0), note('b', 60, 1)])]);
    const before = useStore.getState().project;
    expectRefused(before, actions.nudge('clip-1', ['a', 'b'], { semitones: 12 }), actions.NOTE_EDIT_MESSAGES.tooHigh);
  });

  it('←/→ でグリッド 1 つ分動かし、1/3 拍グリッドで 3 回動かすと 1 拍ちょうどになる', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0, 1 / 3)])]);
    for (let i = 0; i < 3; i += 1) expect(actions.nudge('clip-1', ['a'], { gridSteps: 1, snap: 1 / 3 })).toBe(true);
    expect(byId('clip-1', 'a').startBeat).toBe(1);
    expect(actions.nudge('clip-1', ['a'], { gridSteps: -1, snap: 0.25 })).toBe(true);
    expect(byId('clip-1', 'a').startBeat).toBe(0.75);
    expect(useStore.getState().past).toHaveLength(4);
  });

  it('先頭より前・1 周目の終わりより後ろへは動かさず知らせる', () => {
    setup([midiClip('clip-1', 0, 4, [note('a', 60, 0), note('b', 62, 3, 1)])]);
    const before = useStore.getState().project;
    expectRefused(before, actions.nudge('clip-1', ['a'], { gridSteps: -1, snap: 0.25 }), actions.NOTE_EDIT_MESSAGES.outsideFirstPass);
    expectRefused(before, actions.nudge('clip-1', ['a', 'b'], { gridSteps: 1, snap: 0.25 }), actions.NOTE_EDIT_MESSAGES.outsideFirstPass);
    setup([midiClip('clip-l', 0, 16, [note('a', 60, 3, 1)], { loop: true, contentLengthBeats: 4 })]);
    const looped = useStore.getState().project;
    expectRefused(looped, actions.nudge('clip-l', ['a'], { gridSteps: 1, snap: 0.25 }), actions.NOTE_EDIT_MESSAGES.outsideFirstPass);
  });

  it('1 周目の終わりの判定は絶対 tick で行う(終わり 4 + 1/2400 拍は 4 拍と同じ tick)', () => {
    setup([midiClip('clip-1', 0, 4, [note('a', 60, 2.75, 1 + 1 / 2400)])]);
    expect(actions.nudge('clip-1', ['a'], { gridSteps: 1, snap: 0.25 })).toBe(true);
    expect(byId('clip-1', 'a').startBeat).toBe(3);
    expect(validateProject(useStore.getState().project).ok).toBe(true);
    // 端数の開始のクリップ: 開始 1/1200 拍・長さ 4 拍の終わりは round(1920.4) = 1920 tick
    setup([midiClip('clip-f', 1 / 1200, 4, [note('a', 60, 2.75, 1)])]);
    expect(actions.nudge('clip-f', ['a'], { gridSteps: 1, snap: 0.25 })).toBe(true);
    const at = useStore.getState().project;
    expect(actions.nudge('clip-f', ['a'], { gridSteps: 1, snap: 1 / 6 })).toBe(false);
    expect(useStore.getState().project).toBe(at);
  });

  it.each([NaN, Infinity, -Infinity, 0.5, 0, 1e-9])('移動量 %s は何もせず false を返す', (value) => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 1)])]);
    const before = useStore.getState().project;
    expect(actions.nudge('clip-1', ['a'], { gridSteps: value, snap: 0.25 })).toBe(false);
    // 1e-9 拍は有限の正の数なのでスナップとしては受け付ける。ここでは負にして拒否を確かめる。
    expect(actions.nudge('clip-1', ['a'], { gridSteps: 1, snap: value === 0.5 || value === 1e-9 ? -value : value })).toBe(false);
    expect(actions.nudge('clip-1', ['a'], { semitones: value })).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('リンクで動かすと参照先に書く', () => {
    setup([midiClip('src', 0, 8, [note('a', 60, 1)]), midiClip('link', 16, 8, [], { aliasOf: 'src' })]);
    expect(actions.nudge('link', ['a'], { gridSteps: 1, snap: 0.5 })).toBe(true);
    expect(byId('src', 'a').startBeat).toBe(1.5);
    expect(useStore.getState().project.tracks[0]!.clips.find((c) => c.id === 'link')!.notes).toEqual([]);
  });
});

describe('ベロシティ', () => {
  it('ランプ 40→100 が拍順に線形になる(保存順ではなく拍の順)', () => {
    setup([midiClip('clip-1', 0, 8, [note('d', 60, 3), note('a', 60, 0), note('c', 64, 2), note('b', 62, 1)])]);
    const before = useStore.getState().project;
    expect(actions.rampVelocity('clip-1', ['a', 'b', 'c', 'd'], 40, 100)).toBe(true);
    expect(['a', 'b', 'c', 'd'].map((id) => byId('clip-1', id).velocity)).toEqual([40, 60, 80, 100]);
    expectOneUndoBack(before);
  });

  it('ランプは拍の位置に比例し、同じ拍の音は同じ値。結果は 1〜127 の整数', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0), note('b', 62, 0.5), note('b2', 65, 0.5), note('c', 64, 3)])]);
    expect(actions.rampVelocity('clip-1', ['a', 'b', 'b2', 'c'], 100, 1)).toBe(true);
    const v = ['a', 'b', 'b2', 'c'].map((id) => byId('clip-1', id).velocity);
    expect(v).toEqual([100, Math.round(100 - 99 / 6), Math.round(100 - 99 / 6), 1]);
    for (const x of v) expect(Number.isInteger(x)).toBe(true);
  });

  it('範囲外(0、128)は何も変えず知らせ、整数でない値は何もしない', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0), note('b', 62, 1)])]);
    const before = useStore.getState().project;
    expectRefused(before, actions.rampVelocity('clip-1', ['a', 'b'], 0, 100), actions.NOTE_EDIT_MESSAGES.velocityRange);
    expectRefused(before, actions.rampVelocity('clip-1', ['a', 'b'], 40, 128), actions.NOTE_EDIT_MESSAGES.velocityRange);
    for (const bad of [NaN, Infinity, 40.5]) {
      expectRefused(before, actions.rampVelocity('clip-1', ['a', 'b'], bad, 100));
      expectRefused(before, actions.randomizeVelocity('clip-1', ['a', 'b'], { center: bad, width: 5, seed: 1 }));
    }
    expectRefused(before, actions.randomizeVelocity('clip-1', ['a', 'b'], { center: 64, width: NaN, seed: 1 }));
    expectRefused(before, actions.randomizeVelocity('clip-1', ['a', 'b'], { center: 64, width: -1, seed: 1 }));
    expectRefused(before, actions.randomizeVelocity('clip-1', ['a', 'b'], { center: 64, width: 5, seed: 0.5 }));
    expectRefused(
      before,
      actions.randomizeVelocity('clip-1', ['a', 'b'], { center: 120, width: 10, seed: 1 }),
      actions.NOTE_EDIT_MESSAGES.velocityRange,
    );
  });

  it('ランダムは中心±幅に収まり、seed を固定すると同じ結果を再現する', () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(`n${i}`, 60 + (i % 5), i * 0.5));
    setup([midiClip('clip-1', 0, 8, notes)]);
    const ids = notes.map((n) => n.id);
    const before = useStore.getState().project;
    expect(actions.randomizeVelocity('clip-1', ids, { center: 80, width: 20, seed: 42 })).toBe(true);
    const first = ids.map((id) => byId('clip-1', id).velocity);
    for (const v of first) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(60);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(new Set(first).size).toBeGreaterThan(3);
    expectOneUndoBack(before);
    expect(actions.randomizeVelocity('clip-1', ids, { center: 80, width: 20, seed: 42 })).toBe(true);
    expect(ids.map((id) => byId('clip-1', id).velocity)).toEqual(first);
    act(() => useStore.getState().undo());
    expect(actions.randomizeVelocity('clip-1', ids, { center: 80, width: 20, seed: 43 })).toBe(true);
    expect(ids.map((id) => byId('clip-1', id).velocity)).not.toEqual(first);
  });
});

describe('PianoRoll のショートカット(US-015)', () => {
  function open(clips: Clip[], selectedNoteIds: string[]) {
    setup(clips);
    useStore.setState((s) => ({ editor: { ...s.editor, activeView: 'pianoRoll', selectedClipId: clips[0]!.id, selectedTrackId: 'tr-a', selectedNoteIds } }));
    render(createElement(PianoRoll));
  }
  const key = (init: Parameters<typeof fireEvent.keyDown>[1]) => act(() => { fireEvent.keyDown(window, init); });

  it('↑ で +1、Shift+↑ で +12、Shift+↓ で −12。範囲外になる Shift+↑ は変更しない', () => {
    open([midiClip('clip-1', 0, 8, [note('a', 60, 0), note('b', 110, 1)])], ['a', 'b']);
    key({ key: 'ArrowUp' });
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([61, 111]);
    key({ key: 'ArrowUp', shiftKey: true });
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([73, 123]);
    const before = useStore.getState().project;
    key({ key: 'ArrowUp', shiftKey: true });
    expect(useStore.getState().project).toBe(before);
    expect(lastToast()).toBe(actions.NOTE_EDIT_MESSAGES.tooHigh);
    key({ key: 'ArrowDown', shiftKey: true });
    expect(clipNotes('clip-1').map((n) => n.pitch)).toEqual([61, 111]);
  });

  it('←/→ は今のグリッド 1 つ分(既定 1 拍)、L/T/J/K でレガート・スタッカート・つなぐ・分ける', () => {
    open([midiClip('clip-1', 0, 8, [note('a', 60, 1, 0.5), note('b', 60, 2, 1)])], ['a', 'b']);
    key({ key: 'ArrowRight' });
    expect(clipNotes('clip-1').map((n) => n.startBeat)).toEqual([2, 3]);
    key({ key: 'ArrowLeft' });
    expect(clipNotes('clip-1').map((n) => n.startBeat)).toEqual([1, 2]);
    key({ key: 'l' });
    expect(byId('clip-1', 'a').durationBeats).toBe(1);
    key({ key: 't' });
    expect(clipNotes('clip-1').map((n) => n.durationBeats)).toEqual([0.5, 0.5]);
    key({ key: 'l' });
    key({ key: 'j' });
    expect(clipNotes('clip-1')).toEqual([note('a', 60, 1, 1.5)]);
    setPlayhead(1.25);
    key({ key: 'k' });
    expect(clipNotes('clip-1').map((n) => [n.startBeat, n.durationBeats])).toEqual([[1, 0.25], [1.25, 1.25]]);
    expect(useStore.getState().past).toHaveLength(7);
  });
});

describe('Codex レビュー(US-015)の回帰', () => {
  it('右に 1/4 拍動かすとクリップ末尾の tick に丸まって消える音は移動しない', () => {
    setup([midiClip('src', 0, 1.25 + 2.5 / 480, [note('a', 60, 1 + 2.5 / 480, 0.1 / 480)])]);
    const before = useStore.getState().project;
    expect(soundingEvents(before).events.map((event) => {
      if (event.kind !== 'note') throw new Error('Expected a note');
      return [beatTick(event.startBeat), beatTick(event.startBeat + event.durationBeats)];
    })).toEqual([[482, 483]]);
    expectRefused(before, actions.nudge('src', ['a'], { gridSteps: 1, snap: 0.25 }),
      '細かい位置の音がずれたり消えたりするため、この操作はできません。');
  });

  it('端数拍のレガートも再生上では隙間なく 3842 tick でつながる', () => {
    setup([midiClip('src', 8, 4, [note('a', 60, 0.1 / 480), note('b', 62, 1.5 / 480)])]);
    expect(actions.legato('src', ['a', 'b'])).toBe(true);
    const events = soundingEvents(useStore.getState().project).events.filter((event) => event.kind === 'note');
    const [a, b] = events;
    expect([beatTick(a!.startBeat + a!.durationBeats), beatTick(b!.startBeat)]).toEqual([3842, 3842]);
  });

  it('開始拍 0 と 1e307 の 2 音への 40→100 のランプは、途中でオーバーフローせず 40 と 100 を書く', () => {
    setup([midiClip('clip-1', 0, 8, [note('a', 60, 0), note('b', 62, 1e307)])]);
    expect(actions.rampVelocity('clip-1', ['a', 'b'], 40, 100)).toBe(true);
    expect([byId('clip-1', 'a').velocity, byId('clip-1', 'b').velocity]).toEqual([40, 100]);
    expect(validateProject(useStore.getState().project).ok).toBe(true);
  });

  it('リンク(8 + 0.6/480 拍)で長さ 0 tick になるスタッカートは、共有元側から行っても拒否する', () => {
    // 共有元: 0〜1.2 tick → 0〜1 tick、半分 0.6 tick → 1 tick。リンク: 3840.6 → 3841、半分の終わり 3841.2 → 3841(0 tick)。
    setup([midiClip('src', 0, 8, [note('a', 60, 0, 1.2 / 480)]), midiClip('link', 8 + 0.6 / 480, 8, [], { aliasOf: 'src' })]);
    const before = useStore.getState().project;
    expectRefused(before, actions.staccato('src', ['a']), actions.NOTE_EDIT_MESSAGES.tooShort);
    expectRefused(before, actions.staccato('link', ['a']), actions.NOTE_EDIT_MESSAGES.tooShort);
  });

  it('2 回目: リンク(8 拍)で再生側の足し算の順 (8 + 開始) + 長さ が 0 tick になるスタッカートは拒否する', () => {
    // 再生側: (8 + 0.1/480) + 0.4/480 → 3840 tick(開始も 3840)。8 + (0.1/480 + 0.4/480) と足すと 3841 になる。
    setup([midiClip('src', 0, 8, [note('a', 60, 0.1 / 480, 0.8 / 480)]), midiClip('link', 8, 8, [], { aliasOf: 'src' })]);
    const before = useStore.getState().project;
    expectRefused(before, actions.staccato('src', ['a']), actions.NOTE_EDIT_MESSAGES.tooShort);
  });

  it('1 周目の範囲は共有するすべてのリンクで確かめる(短いリンクを越える移動・貼り付けは拒否・切り詰め)', () => {
    setup([
      midiClip('src', 0, 8, [note('a', 60, 2, 1)]),
      midiClip('l1', 8, 8, [], { aliasOf: 'src' }),
      midiClip('l2', 16, 3, [], { aliasOf: 'src' }),
    ]);
    const before = useStore.getState().project;
    expectRefused(before, actions.nudge('src', ['a'], { gridSteps: 1, snap: 0.5 }), actions.NOTE_EDIT_MESSAGES.outsideFirstPass);
    actions.copyNotes('src', ['a']);
    setPlayhead(2.5);
    const ids = actions.pasteNotes('src');
    expect(byId('src', ids[0]!)).toMatchObject({ startBeat: 2.5, durationBeats: 0.5 });
    expect(lastToast()).toBe(actions.NOTE_EDIT_MESSAGES.pastePartial);
  });

  it('共有元とリンクで次に鳴る音が異なり、両方に合わせられないレガートは拒否する', () => {
    // 共有元では 0 と 0.6 tick は別の tick(0 と 1)、リンク(+0.4 tick)では 0.4 → 0 と 1.0 → 1 で別、
    // リンク(+0.5 tick)では 0.5 → 1 と 1.1 → 1 で同じ tick になる。
    setup([
      midiClip('src', 0, 8, [note('a', 60, 0, 0.5), note('b', 62, 0.6 / 480, 0.5), note('c', 64, 1)]),
      midiClip('link', 8 + 0.5 / 480, 8, [], { aliasOf: 'src' }),
    ]);
    const before = useStore.getState().project;
    expectRefused(before, actions.legato('src', ['a', 'b', 'c']), actions.NOTE_EDIT_MESSAGES.soundChanged);
  });

  it('半分にしても再生上で 1 tick のままのスタッカートは拒否する', () => {
    setup([midiClip('src', 0, 4, [note('a', 60, 0, 1.2 / 480)])]);
    const before = useStore.getState().project;
    expectRefused(before, actions.staccato('src', ['a']), actions.NOTE_EDIT_MESSAGES.soundChanged);
  });

  it('ループの最後の周で後半が鳴らなくなる分割は拒否する', () => {
    setup([midiClip('src', 0, 2.75, [note('a', 60, 0.5)], { loop: true, contentLengthBeats: 2 })], { positionBeat: 1 });
    const before = useStore.getState().project;
    expectRefused(before, actions.splitNoteAtPlayhead('src', ['a']), actions.NOTE_EDIT_MESSAGES.soundChanged);
  });

  it('スウィングで元の発音区間より長くなる連結は拒否する', () => {
    setup([midiClip('src', 0, 4, [note('a', 60, 0.25, 0.3), note('b', 60, 0.5, 0.5)])], { swing: 60 });
    const before = useStore.getState().project;
    expectRefused(before, actions.joinNotes('src', ['a', 'b']), actions.NOTE_EDIT_MESSAGES.soundChanged);
  });
});

// ---------------------------------------------------------------------------
// Property test: seed-fixed random clips and notes.
// ---------------------------------------------------------------------------

const FRACTIONS = [0, 1 / 3, 0.25, 0.5, 2 / 7, 0.125, 1 / 1200, 1 / 6, 0.6 / 480, 0.1 / 480];
/** 非常に大きい開始拍(途中の計算があふれないことを確かめる)。 */
const HUGE_BEATS = [1e307, 1e15, 2 ** 53];
const SNAPS = [1 / 6, 0.25, 1 / 3, 0.5, 1, 2];
/** 有限の整数でない量(必ず拒否される)。 */
const ODD_INPUTS = [NaN, Infinity, -Infinity, 0.5, -2.5, 1 / 3];

type Rng = () => number;

function randomBeat(rng: Rng, maxWhole: number): number {
  return randomInt(rng, 0, maxWhole) + FRACTIONS[randomInt(rng, 0, FRACTIONS.length - 1)]!;
}

function randomPitch(rng: Rng): number {
  const r = rng();
  if (r < 0.25) return randomInt(rng, 0, 4);
  if (r < 0.5) return randomInt(rng, 115, 127);
  return randomInt(rng, 30, 100);
}

function randomVelocity(rng: Rng): number {
  const r = rng();
  if (r < 0.25) return 1;
  if (r < 0.5) return 127;
  return randomInt(rng, 2, 126);
}

function randomScenario(rng: Rng, index: number) {
  const clips: Clip[] = [];
  const count = randomInt(rng, 1, 3);
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    // 共有元とリンクの開始位置も端数の拍(0.5〜0.6 tick)になる。
    const start = cursor + randomBeat(rng, 3) + pick(rng, [0, 0, 0.6 / 480, 0.5 / 480, 1 / 1200]);
    const length = randomInt(rng, 2, 8) + FRACTIONS[randomInt(rng, 1, FRACTIONS.length - 1)]!;
    const notes: NoteEvent[] = [];
    const noteCount = randomInt(rng, 0, 6);
    for (let k = 0; k < noteCount; k += 1) {
      // Short (down to 1 tick), touching (same pitch, so joinable) and overlapping notes all appear.
      const prev = notes.at(-1);
      const continues = prev !== undefined && rng() < 0.5;
      const pitch = continues ? prev.pitch : randomPitch(rng);
      const duration = rng() < 0.15 ? pick(rng, [1 / 480, 2 / 480, 1 / 1200 + 1 / 480, 1.2 / 480, 0.8 / 480]) : 0.25 + randomBeat(rng, 1);
      const startBeat = rng() < 0.05
        ? pick(rng, HUGE_BEATS)
        : continues
          ? Math.max(0, prev.startBeat + prev.durationBeats - pick(rng, [0, 0, 1 / 1200, 0.25]))
          : randomBeat(rng, Math.floor(length));
      notes.push(note(`p${index}-${i}-${k}`, pitch, startBeat, duration, randomVelocity(rng)));
    }
    const loop = rng() < 0.3;
    const extra: Partial<Clip> = loop ? { loop: true, contentLengthBeats: randomInt(rng, 1, 3) + pick(rng, [0.5, 1 / 3, 1 / 1200]) } : {};
    if (i > 0 && rng() < 0.35) {
      clips.push(midiClip(`c${i}`, start, length, [], { ...extra, aliasOf: rng() < 0.85 ? 'c0' : 'gone' }));
    } else {
      clips.push(midiClip(`c${i}`, start, length, notes, extra));
    }
    cursor = start + length;
  }
  return { clips, positionBeat: randomBeat(rng, Math.ceil(cursor) + 2), swing: rng() < 0.2 ? pick(rng, [0, 30, 60]) : undefined };
}

function pickIds(rng: Rng, notes: readonly NoteEvent[]): string[] {
  const r = rng();
  if (r < 0.12 || notes.length === 0) return [];
  if (r < 0.35) return [notes[randomInt(rng, 0, notes.length - 1)]!.id];
  return notes.filter(() => rng() < 0.7).map((n) => n.id);
}

function clipShapes(project: Project) {
  return project.tracks.flatMap((t) => t.clips.map((c) => [c.id, c.startBeat, c.lengthBeats, c.contentLengthBeats, c.loop]));
}

const OP_NAMES = ['legato', 'staccato', 'join', 'split', 'nudgeTime', 'nudgePitch', 'ramp', 'random'] as const;

function playedNotes(project: Project, sourceClipId: string) {
  const notes = resolveEditTarget(project, sourceClipId)!.notes!;
  return soundingEvents(project, { sourceClipId, includeMuted: true }).events.flatMap((event) =>
    event.kind === 'note' ? [{
      id: notes[event.sourceIndex]!.id,
      clipId: event.clipId,
      repeat: event.repeat,
      start: beatTick(event.startBeat),
      end: beatTick(event.startBeat + event.durationBeats),
    }] : []);
}

describe('プロパティ: 端数 tick の格子(共有元とリンクの位置 × 音の開始・長さ)', () => {
  it('成功した加工は共有元とリンクの全周で再生上の条件を満たし、拒否なら Project は元のまま', () => {
    const LINK_STARTS = [8, 8 + 0.6 / 480, 8 + 0.5 / 480, 9 + 1 / 1200, 8 + 0.1 / 480];
    const ops = ['legato', 'staccato', 'join', 'split', 'nudgeTime'] as const;
    const accepted = new Set<string>();
    const refused = new Set<string>();
    for (const linkStart of LINK_STARTS) {
      for (let k = 0; k <= 10; k += 1) {
        for (let m = 1; m <= 30; m += 1) {
          const start = (m % 2 === 0 ? 1 : 0.25) + (k * 0.1) / 480;
          const duration = (m * 0.1) / 480;
          const op = ops[(k + m) % ops.length]!;
          const follow = start + duration * (op === 'join' ? 0.75 : 1.4);
          setup([
            midiClip('src', 0, 4, [note('a', 60, start, duration), note('b', op === 'join' ? 60 : 62, follow, 1 / 480)]),
            midiClip('link', linkStart, 3.125, [], {
              aliasOf: 'src', loop: true, contentLengthBeats: 2 + 0.4 / 480,
            }),
          ], { positionBeat: start + duration / 2, swing: m % 3 === 0 ? 60 : 0 });
          const before = useStore.getState().project;
          const run = {
            legato: () => actions.legato('link', ['a', 'b']),
            staccato: () => actions.staccato('src', ['a']),
            join: () => actions.joinNotes('link', ['a', 'b']),
            split: () => actions.splitNoteAtPlayhead('src', ['a']),
            nudgeTime: () => actions.nudge('src', ['a'], { gridSteps: 1, snap: 0.25 }),
          }[op];
          const ok = run();
          const after = useStore.getState().project;
          const label = `link ${linkStart} start ${start} duration ${duration} ${op}`;
          expect(validateProject(after).errors, label).toEqual([]);
          if (!ok) {
            expect(after, label).toBe(before);
            expect(useStore.getState().past, label).toHaveLength(0);
            refused.add(op);
            continue;
          }
          accepted.add(op);
          const original = playedNotes(before, 'src');
          const result = playedNotes(after, 'src');
          for (const old of original) {
            const inPass = (event: typeof old) => event.clipId === old.clipId && event.repeat === old.repeat;
            const updated = result.find((e) => inPass(e) && e.id === (op === 'join' ? 'a' : old.id));
            expect(updated, label).toBeDefined();
            if (op === 'staccato' && old.id === 'a') {
              expect(updated!.end - updated!.start, label).toBeGreaterThanOrEqual(1);
              expect(updated!.end - updated!.start, label).toBeLessThan(old.end - old.start);
            }
            if (op === 'split' && old.id === 'a') {
              expect(result.find((e) => inPass(e) && e.id !== 'a' && e.id !== 'b'), label).toBeDefined();
            }
          }
          for (const played of result) {
            const inPass = (event: typeof played) => event.clipId === played.clipId && event.repeat === played.repeat;
            if (op === 'legato') {
              const laterStarts = result.filter((e) => inPass(e) && e.start > played.start).map((e) => e.start);
              if (laterStarts.length) expect(played.end, label).toBe(Math.min(...laterStarts));
            } else if (op === 'join') {
              const ticks = new Set(original.filter(inPass).flatMap((e) =>
                Array.from({ length: e.end - e.start }, (_, i) => e.start + i)));
              expect(played.id, label).toBe('a');
              expect(ticks, label).toEqual(new Set(Array.from({ length: played.end - played.start }, (_, i) => played.start + i)));
            }
          }
          act(() => useStore.getState().undo());
          expect(useStore.getState().project, label).toEqual(before);
        }
      }
    }
    expect(accepted).toEqual(new Set(ops));
    expect(refused).toEqual(new Set(ops));
  });
});

describe('プロパティ: ランダムなクリップとノートへの加工', () => {
  it('結果は validateProject を通り、範囲外なら元のまま、Undo 1 段で deepEqual に戻り、クリップ長は変わらない', () => {
    const rng = createPrng(1515);
    const changedByOp = new Map<string, number>();
    let refused = 0;
    for (let iter = 0; iter < 3000; iter += 1) {
      const scenario = randomScenario(rng, iter);
      setup(scenario.clips, { positionBeat: scenario.positionBeat, swing: scenario.swing });
      const clipId = scenario.clips[randomInt(rng, 0, scenario.clips.length - 1)]!.id;
      const targetNotes = clipNotes(clipId);
      const ids = pickIds(rng, targetNotes);
      const selected = targetNotes.filter((n) => ids.includes(n.id));
      const before = useStore.getState().project;
      const op = OP_NAMES[randomInt(rng, 0, OP_NAMES.length - 1)]!;
      let ok: boolean;
      let mustRefuse = ids.length === 0;
      if (op === 'legato') {
        ok = actions.legato(clipId, ids);
      } else if (op === 'staccato') {
        ok = actions.staccato(clipId, ids);
      } else if (op === 'join') {
        ok = actions.joinNotes(clipId, ids);
      } else if (op === 'split') {
        if (selected.length > 0 && rng() < 0.7) {
          // 再生ヘッドを選んだ音の途中・端・すぐ近く(1/1200 拍)に置く。
          const n = pick(rng, selected);
          const clipStart = scenario.clips.find((c) => c.id === clipId)!.startBeat;
          setPlayhead(clipStart + n.startBeat + n.durationBeats * pick(rng, [0.5, 0.37, 0, 1]) + pick(rng, [0, 0, 1 / 1200, -1 / 1200]));
        }
        ok = actions.splitNoteAtPlayhead(clipId, ids);
      } else if (op === 'nudgeTime') {
        const gridSteps = rng() < 0.15 ? pick(rng, ODD_INPUTS) : pick(rng, [-1, 1, -3, 2]);
        const snap = pick(rng, SNAPS);
        mustRefuse ||= !Number.isInteger(gridSteps);
        ok = actions.nudge(clipId, ids, { gridSteps, snap });
      } else if (op === 'nudgePitch') {
        const semitones = rng() < 0.15 ? pick(rng, ODD_INPUTS) : pick(rng, [-12, -1, 1, 12]);
        mustRefuse ||= !Number.isInteger(semitones) ||
          selected.some((n) => n.pitch + semitones > 127 || n.pitch + semitones < 0);
        ok = actions.nudge(clipId, ids, { semitones });
      } else if (op === 'ramp') {
        const from = rng() < 0.15 ? pick(rng, [0, 128, ...ODD_INPUTS]) : randomVelocity(rng);
        const to = randomVelocity(rng);
        mustRefuse ||= !Number.isInteger(from) || from < 1 || from > 127;
        ok = actions.rampVelocity(clipId, ids, from, to);
      } else {
        const center = randomVelocity(rng);
        const width = rng() < 0.15 ? pick(rng, [NaN, -1, Infinity]) : randomInt(rng, 0, 40);
        mustRefuse ||= !(width >= 0) || !Number.isFinite(width) || center - width < 1 || center + width > 127;
        ok = actions.randomizeVelocity(clipId, ids, { center, width, seed: randomInt(rng, 0, 1000) });
      }
      const after = useStore.getState().project;
      const label = `iter ${iter} op ${op}`;
      // 新しい検証エラーを作らない(参照切れのリンクの場面は元のエラーのまま)。
      expect(validateProject(after).errors, label).toEqual(validateProject(before).errors);
      expect(clipShapes(after), label).toEqual(clipShapes(before));
      for (const clip of after.tracks.flatMap((t) => t.clips)) {
        if (clip.aliasOf !== undefined) expect(clip.notes ?? [], label).toEqual([]);
        for (const n of clip.notes ?? []) {
          expect(Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127, label).toBe(true);
          expect(Number.isInteger(n.velocity) && n.velocity >= 1 && n.velocity <= 127, label).toBe(true);
        }
      }
      if (mustRefuse) expect(ok, label).toBe(false);
      if (!ok) {
        expect(after, label).toBe(before);
        expect(useStore.getState().past, label).toHaveLength(0);
        refused += 1;
        continue;
      }
      changedByOp.set(op, (changedByOp.get(op) ?? 0) + 1);
      expect(useStore.getState().past, label).toHaveLength(1);
      // 動いた・伸びた・新しくできた音は 1 tick 以上で、編集先を共有するすべての配置
      // (共有元と、それを aliasOf にしているすべてのリンク)の 1 周目に収まる。
      const target = resolveEditTarget(after, clipId)!;
      const placements = after.tracks.flatMap((t) => t.clips).filter((c) => resolveEditTarget(after, c.id) === target);
      const old = new Map(targetNotes.map((n) => [n.id, n]));
      for (const n of target.notes ?? []) {
        const prev = old.get(n.id);
        if (prev && prev.startBeat === n.startBeat && n.durationBeats <= prev.durationBeats) continue;
        for (const c of placements) {
          const t = placedNoteTicks(c, n, { swing: after.swing, songEnd: songEndBeat(after) });
          expect(t.endTick - t.startTick, label).toBeGreaterThanOrEqual(1);
          if (op !== 'split') expect(t.naturalEndTick, label).toBeLessThanOrEqual(t.passEndTick);
          else expect(t.startTick, label).toBeLessThan(t.passEndTick);
        }
      }
      // エディタの判定 tick(placedNoteTicks)と soundingEvents が鳴らす tick は、すべての配置で一致する。
      for (const c of placements) {
        for (const event of soundingEvents(after, { clipId: c.id, includeMuted: true }).events) {
          if (event.kind !== 'note' || event.repeat !== 0) continue;
          const t = placedNoteTicks(c, target.notes![event.sourceIndex]!, { swing: after.swing, songEnd: songEndBeat(after) });
          expect(beatTick(event.startBeat), label).toBe(t.startTick);
          expect(beatTick(event.startBeat + event.durationBeats), label).toBe(t.endTick <= t.startTick ? t.startTick + 1 : t.endTick);
        }
      }
      act(() => useStore.getState().undo());
      expect(useStore.getState().project, label).toEqual(before);
    }
    // ランダムの組み合わせがどの加工でも変更と拒否の両方の経路を通ることを確かめる。
    for (const op of OP_NAMES) expect(changedByOp.get(op) ?? 0, op).toBeGreaterThan(15);
    expect(refused).toBeGreaterThan(150);
  });
});
