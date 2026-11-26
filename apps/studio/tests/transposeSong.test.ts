// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  beatTick,
  soundingEvents,
  validateProject,
  type ChordEvent,
  type MusicalKey,
  type Project,
  type ScaleName,
} from '@cts/project-model';
import { transposeChordSymbol } from '@cts/theory-engine';
import { installLocalStorage } from './localStorageStub';
import { drumClip, generateProject, makeProject, makeTrack, midiClip, mulberry32 } from '../../../packages/project-model/tests/acceptance/helpers';

// Opening the dialog never starts audio, so the engine is a stub here.
vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: false,
    now: () => 0,
    ensureContext: async () => ({ context: { currentTime: 0 }, master: {} }),
  }),
}));

let useStore: typeof import('../src/state/store')['useStore'];
let TransportBar: typeof import('../src/features/transport/TransportBar')['TransportBar'];
let actions: typeof import('../src/state/editorActions');
let bridge: typeof import('../src/state/tutorialBridge');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
  bridge = await import('../src/state/tutorialBridge');
  ({ TransportBar } = await import('../src/features/transport/TransportBar'));
});

afterEach(() => cleanup());

function chord(id: string, startBeat: number, symbol: string, notes: number[]): ChordEvent {
  return { id, startBeat, durationBeats: 4, symbol, root: symbol.match(/^[A-G][#b]?/)?.[0] ?? symbol, quality: 'major', notes, function: 'T', degree: 'I' };
}

function song(): Project {
  return makeProject(
    [
      makeTrack('inst', 'instrument', [midiClip('src', 'inst', 0, 4, [[0, 1, 60], [1, 1, 64]])]),
      makeTrack('drums', 'drum', [drumClip('d1', 'drums', 0, 4, [[0, 'kick']])]),
    ],
    {
      chordTrack: [chord('c1', 0, 'C', [0, 4, 7]), chord('c2', 4, 'Am7', [9, 0, 4, 7]), chord('c3', 8, 'G/B', [7, 11, 2]), chord('c4', 12, 'Bb', [10, 2, 5])],
    },
  );
}

function load(project: Project): void {
  useStore.setState({ project, past: [], future: [] });
}

const state = () => useStore.getState();

beforeEach(() => {
  installLocalStorage();
  load(song());
});

describe('transposeSongToKey(曲全体を移調)', () => {
  it('C→D で project.key が D になり、全コードが変換され、ノートは +2、ドラムは不変', () => {
    const before = state().project;
    expect(actions.transposeSongToKey('D')).toBe(true);
    const after = state().project;
    expect(after.key).toBe('D');
    expect(after.chordTrack.map((c) => c.symbol)).toEqual(['D', 'Bm7', 'A/C#', 'C']);
    expect(after.chordTrack.map((c) => c.root)).toEqual(['D', 'B', 'A', 'C']);
    // コードの構成音(ピッチクラス)も 2 半音動き、度数・機能は相対なので変わらない。
    expect(after.chordTrack.map((c) => c.notes)).toEqual([[2, 6, 9], [11, 2, 6, 9], [9, 1, 4], [0, 4, 7]]);
    expect(after.chordTrack.map((c) => [c.degree, c.function])).toEqual(before.chordTrack.map((c) => [c.degree, c.function]));
    expect(after.tracks[0]!.clips[0]!.notes!.map((n) => n.pitch)).toEqual([62, 66]);
    expect(after.tracks[1]).toBe(before.tracks[1]);
    expect(state().past.length).toBe(1);
  });

  it('Undo 1 回で全体(キー・コード・ノート)が元に戻る', () => {
    const before = state().project;
    actions.transposeSongToKey('D');
    state().undo();
    expect(state().project).toEqual(before);
    expect(state().past.length).toBe(0);
  });

  it('フラット系のキーへ移すとフラットで書く(C→Eb で G/B は Bb/D)', () => {
    expect(actions.transposeSongToKey('Eb')).toBe(true);
    expect(state().project.chordTrack.map((c) => c.symbol)).toEqual(['Eb', 'Cm7', 'Bb/D', 'Db']);
  });

  it('近い方向へ動かす(C→Bb は -2)', () => {
    actions.transposeSongToKey('Bb');
    expect(state().project.tracks[0]!.clips[0]!.notes!.map((n) => n.pitch)).toEqual([58, 62]);
  });

  it('「ノートとコードも動かす」をオフにするとキーだけ変える(Undo 1 段)', () => {
    const before = state().project;
    expect(actions.transposeSongToKey('D', false)).toBe(true);
    expect(state().project.key).toBe('D');
    expect(state().project.tracks).toBe(before.tracks);
    expect(state().project.chordTrack).toBe(before.chordTrack);
    expect(state().past.length).toBe(1);
  });

  it('同じキーを選んだら何もしない', () => {
    const before = state().project;
    expect(actions.transposeSongToKey('C')).toBe(false);
    expect(state().project).toBe(before);
    expect(state().past.length).toBe(0);
  });

  it('読み取れないコードがあると全体を拒否し、理由を表示する', () => {
    load({ ...song(), chordTrack: [chord('x', 0, 'N.C.', [])] });
    const before = state().project;
    expect(actions.transposeSong(2)).toBe(false);
    expect(state().project).toBe(before);
    expect(state().past.length).toBe(0);
    expect(bridge.getBridgeSnapshot().toasts.at(-1)?.message).toMatch(/コード名として読み取れません/);
  });

  it('127 を超える音があると拒否し、初心者向けの理由を表示する', () => {
    load(makeProject([makeTrack('inst', 'instrument', [midiClip('c', 'inst', 0, 4, [[0, 1, 127]])])]));
    const before = state().project;
    expect(actions.transposeSongToKey('D')).toBe(false);
    expect(state().project).toBe(before);
    expect(bridge.getBridgeSnapshot().toasts.at(-1)?.message).toMatch(/MIDI 127 を超えて/);
  });

  it('移調量は有限の整数に限る(NaN・小数・Infinity は何も変えない)', () => {
    const before = state().project;
    for (const bad of [Number.NaN, 0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(actions.transposeSong(bad)).toBe(false);
      expect(state().project).toBe(before);
    }
    expect(state().past.length).toBe(0);
  });
});

describe('レビュー指摘の回帰(US-016)', () => {
  it('低い音高を含むコードの構成音 [5, 9, 12] は C→Bb→C の往復で元に戻る(オクターブを失わない)', () => {
    load({ ...song(), chordTrack: [chord('f', 0, 'F', [5, 9, 12])] });
    expect(actions.transposeSongToKey('Bb')).toBe(true);
    // ピッチクラスは mod 12 で動き、12 の倍数ぶん(オクターブ)はそのまま残す。
    expect(state().project.chordTrack[0]!.notes).toEqual([3, 7, 22]);
    expect(state().project.chordTrack[0]!.notes.map((n) => n % 12)).toEqual([3, 7, 10]);
    expect(actions.transposeSongToKey('C')).toBe(true);
    expect(state().project.chordTrack[0]!.notes).toEqual([5, 9, 12]);
  });

  it('構成音が 127 を超える移調は全体を拒否して理由を出す', () => {
    load({ ...song(), chordTrack: [chord('g', 0, 'G', [127])] });
    const before = state().project;
    expect(actions.transposeSongToKey('D')).toBe(false);
    expect(state().project).toBe(before);
    expect(bridge.getBridgeSnapshot().toasts.at(-1)?.message).toMatch(/構成音の番号が 0〜127/);
  });

  it("キーが Unicode の 'F♯' でもダイアログが開き、A へ移調できる", () => {
    load({ ...song(), key: 'F♯' as MusicalKey });
    expect(validateProject(state().project).ok).toBe(true);
    render(createElement(TransportBar));
    fireEvent.click(screen.getByRole('button', { name: '曲全体を移調' }));
    fireEvent.change(screen.getByLabelText('新しいキー'), { target: { value: 'A' } });
    expect(screen.getByRole('dialog').textContent).toContain('3 半音上へ');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '移調する' }));
    });
    expect(state().project.key).toBe('A');
    expect(state().project.tracks[0]!.clips[0]!.notes!.map((n) => n.pitch)).toEqual([63, 67]);
  });

  it('読み取れないキーでは例外にせず、理由をトーストで出して何も変えない', () => {
    load({ ...song(), key: 'H' as MusicalKey });
    const before = state().project;
    render(createElement(TransportBar));
    fireEvent.click(screen.getByRole('button', { name: '曲全体を移調' }));
    fireEvent.change(screen.getByLabelText('新しいキー'), { target: { value: 'D' } });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '移調する' }));
    });
    expect(state().project).toBe(before);
    expect(bridge.getBridgeSnapshot().toasts.at(-1)?.message).toMatch(/キー「H」を読み取れない/);
    expect(actions.transposeSong(2)).toBe(false);
  });

  it('巨大な移調量: 安全な整数でなければ拒否、2^53-1 はノートが無ければコードだけ +7 と同じに動く', () => {
    load({ ...song(), tracks: [] });
    const before = state().project;
    expect(actions.transposeSong(2 ** 53)).toBe(false);
    expect(state().project).toBe(before);
    expect(actions.transposeSong(2 ** 53 - 1)).toBe(true);
    expect(state().project.key).toBe('G');
    expect(state().project.chordTrack.map((c) => c.symbol)).toEqual(['G', 'Em7', 'D/F#', 'F']);
  });
});

describe('2 回目のレビュー指摘の回帰(US-016)', () => {
  it('移調量と合わないキーを渡すと拒否し、理由を出す', () => {
    const before = state().project;
    expect(actions.transposeSong(2, 'C')).toBe(false);
    expect(state().project).toBe(before);
    expect(bridge.getBridgeSnapshot().toasts.at(-1)?.message).toMatch(/キーと移調する量が合いません/);
  });

  it("保存キー 'F♯' はダイアログで 12 キーの 'F#' として表示・保持され、C へ直接移調できる", () => {
    load({ ...song(), key: 'F♯' as MusicalKey });
    render(createElement(TransportBar));
    fireEvent.click(screen.getByRole('button', { name: '曲全体を移調' }));
    const select = screen.getByLabelText('新しいキー') as HTMLSelectElement;
    expect(select.value).toBe('F#');
    expect(select.selectedOptions[0]!.textContent).toBe('F#');
    expect((screen.getByRole('button', { name: '移調する' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'C' } });
    expect(select.value).toBe('C');
    expect((screen.getByRole('button', { name: '移調する' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '移調する' }));
    });
    expect(state().project.key).toBe('C');
    expect(state().project.tracks[0]!.clips[0]!.notes!.map((n) => n.pitch)).toEqual([66, 70]);
  });

  it('12 キーに直せないキーでは理由を表示し、未選択の状態から始める', () => {
    load({ ...song(), key: 'H' as MusicalKey });
    render(createElement(TransportBar));
    fireEvent.click(screen.getByRole('button', { name: '曲全体を移調' }));
    const select = screen.getByLabelText('新しいキー') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('dialog').textContent).toContain('今のキー「H」を読み取れません');
    expect((screen.getByRole('button', { name: '移調する' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// --- seed 固定のファズ ---
const KEYS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B', 'F♯', 'B♭', 'E♭', 'C♯'] as MusicalKey[];
const SCALES: ScaleName[] = ['major', 'naturalMinor', 'harmonicMinor', 'melodicMinor', 'majorPentatonic', 'minorPentatonic', 'blues'];
const ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B', 'F♯', 'B♭', 'E♭', 'C♯'];
const HUGE = [2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 40 + 5];
const SUFFIXES = ['', 'm', '7', 'm7', 'maj7', 'm7b5', 'dim', 'sus4', 'add9', 'maj9', '6'];
const EXTREMES = [0, 1, 3, 11, 116, 120, 124, 126, 127];

/** Chord tones: empty, pitch classes, or MIDI-style numbers including low ones (0..11) and ones near 127. */
function chordNotes(r: () => number): number[] {
  const kind = r();
  if (kind < 0.15) return [];
  if (kind < 0.5) return [0, 4, 7];
  return Array.from({ length: 3 }, () => (r() < 0.5 ? Math.floor(r() * 12) : Math.floor(r() * 116)));
}

function randomSong(seed: number): Project {
  const r = mulberry32(seed * 13 + 1);
  const pickOf = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const base = generateProject(seed, { allowOverrunSongEnd: false });
  const chordTrack: ChordEvent[] = Array.from({ length: Math.floor(r() * 6) }, (_, i) => {
    const symbol = pickOf(ROOTS) + pickOf(SUFFIXES) + (r() < 0.3 ? `/${pickOf(ROOTS)}` : '');
    return { id: `ch${i}`, startBeat: i * 4, durationBeats: 4, symbol, root: 'C', quality: 'major', notes: chordNotes(r) };
  });
  return {
    ...base,
    key: pickOf(KEYS),
    scale: pickOf(SCALES),
    chordTrack,
    tracks: base.tracks.map((t) => ({
      ...t,
      mute: r() < 0.3,
      clips: t.clips.map((c) => (c.notes ? { ...c, notes: c.notes.map((n) => (r() < 0.15 ? { ...n, pitch: pickOf(EXTREMES) } : n)) } : c)),
    })),
  };
}

function sounds(p: Project) {
  return soundingEvents(p, { includeMuted: true }).events.map((e) => ({
    trackId: e.trackId,
    clipId: e.clipId,
    start: beatTick(e.startBeat),
    end: e.kind === 'note' ? beatTick(e.startBeat + e.durationBeats) : null,
    pitch: e.kind === 'note' ? e.pitch : null,
    lane: e.kind === 'drum' ? e.lane : null,
    velocity: e.velocity,
  }));
}

const scaleKey = (key: MusicalKey, scale: ScaleName) => `${key} ${scale}`;

describe('transposeSong ファズ(seed 固定)', () => {
  it('成功時は事後条件と validateProject を満たし、拒否時は同じオブジェクト、+n -n で元に戻り、Undo 1 段で戻る', () => {
    let accepted = 0;
    let refused = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      const before = randomSong(seed);
      load(before);
      expect(validateProject(before).ok).toBe(true);
      const r = mulberry32(seed + 5);
      const n = r() < 0.05 ? HUGE[seed % HUGE.length]! : Math.floor(r() * 25) - 12;
      if (!actions.transposeSong(n)) {
        refused += 1;
        expect(state().project).toBe(before);
        expect(state().past.length).toBe(0);
        continue;
      }
      accepted += 1;
      const after = state().project;
      expect(validateProject(after).ok).toBe(true);
      expect(state().past.length).toBe(1);
      // 事後条件: 楽器トラックの発音は音高だけ +n、開始・終了 tick は完全一致。ドラムは不変。ミュートも動く。
      const instruments = new Set(before.tracks.filter((t) => t.type === 'instrument').map((t) => t.id));
      const a = sounds(before);
      expect(sounds(after)).toEqual(a.map((s) => (s.pitch === null || !instruments.has(s.trackId) ? s : { ...s, pitch: s.pitch + n })));
      before.tracks.forEach((t, ti) => {
        if (t.type === 'drum') expect(after.tracks[ti]).toBe(t);
      });
      // コードは新しいキーの表記規則で書かれる。
      after.chordTrack.forEach((c, i) => {
        expect(c.symbol).toBe(transposeChordSymbol(before.chordTrack[i]!.symbol, n, scaleKey(after.key, after.scale)));
      });
      // Undo 1 段で元に戻る。
      state().undo();
      expect(state().project).toEqual(before);
      // +n して -n(元のキーを指定)で、ノートは完全に、コードはキーの表記規則で元に戻る。
      state().redo();
      expect(actions.transposeSong(-n, before.key)).toBe(true);
      const back = state().project;
      expect(back.tracks).toEqual(before.tracks);
      expect(back.key).toBe(before.key);
      back.chordTrack.forEach((c, i) => {
        const orig = before.chordTrack[i]!;
        expect(c.symbol).toBe(transposeChordSymbol(orig.symbol, 0, scaleKey(before.key, before.scale)));
        expect(c.notes).toEqual(orig.notes);
        expect({ ...c, symbol: orig.symbol, root: orig.root }).toEqual(orig);
      });
    }
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(10);
  });

  it('コードだけの曲(低い音高を含む MIDI のコード)で移調を何度も重ねても、逆に戻すと元どおり', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const r = mulberry32(seed + 77);
      const base = randomSong(seed);
      // ノートは範囲外で拒否されやすいので外し、コードの往復だけを確かめる。
      const before = { ...base, tracks: [], chordTrack: base.chordTrack.map((c, i) => ({ ...c, notes: i % 2 ? [Math.floor(r() * 12), Math.floor(r() * 12) + 12, 5] : c.notes })) };
      load(before);
      const keys: MusicalKey[] = [before.key];
      const steps: number[] = [];
      for (let k = 0; k < 6; k += 1) {
        const n = r() < 0.15 ? HUGE[k % HUGE.length]! : Math.floor(r() * 25) - 12;
        if (!actions.transposeSong(n)) continue;
        steps.push(n);
        keys.push(state().project.key);
      }
      for (let k = steps.length - 1; k >= 0; k -= 1) {
        expect(actions.transposeSong(-steps[k]!, keys[k])).toBe(true);
      }
      const back = state().project;
      expect(back.key).toBe(before.key);
      back.chordTrack.forEach((c, i) => {
        const orig = before.chordTrack[i]!;
        expect(c.notes).toEqual(orig.notes);
        expect(c.symbol).toBe(transposeChordSymbol(orig.symbol, 0, scaleKey(before.key, before.scale)));
      });
    }
  });

  it('移調量が NaN・小数・Infinity なら必ず拒否し、Project は同じオブジェクトのまま', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const before = randomSong(seed);
      load(before);
      const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, (seed % 25) - 12 + 0.5, 2 ** 53, -(2 ** 60)][seed % 6]!;
      expect(actions.transposeSong(bad)).toBe(false);
      expect(state().project).toBe(before);
      expect(state().past.length).toBe(0);
    }
  });
});

describe('TransportBar の「曲全体を移調」', () => {
  it('ボタンでダイアログが開き、説明・新しいキー・「ノートとコードも動かす」(既定オン)がある', () => {
    render(createElement(TransportBar));
    fireEvent.click(screen.getByRole('button', { name: '曲全体を移調' }));
    const dialog = screen.getByRole('dialog', { name: '曲全体を移調' });
    expect(dialog.textContent).toContain('キーを変えると曲の高さ全体が変わります。歌いやすい高さを探すときに使います。');
    expect((screen.getByLabelText('ノートとコードも動かす') as HTMLInputElement).checked).toBe(true);
    // 今と同じキーのままでは移調できない。
    expect((screen.getByRole('button', { name: '移調する' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('D を選んで「移調する」で曲全体が D へ動き、ダイアログが閉じ、Undo 1 段で戻る', () => {
    const before = state().project;
    render(createElement(TransportBar));
    fireEvent.click(screen.getByRole('button', { name: '曲全体を移調' }));
    fireEvent.change(screen.getByLabelText('新しいキー'), { target: { value: 'D' } });
    expect(screen.getByRole('dialog').textContent).toContain('2 半音上へ');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '移調する' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state().project.key).toBe('D');
    expect(state().project.chordTrack.map((c) => c.symbol)).toEqual(['D', 'Bm7', 'A/C#', 'C']);
    expect(state().past.length).toBe(1);
    act(() => state().undo());
    expect(state().project).toEqual(before);
  });

  it('チェックを外すとキーだけ変わる', () => {
    const before = state().project;
    render(createElement(TransportBar));
    fireEvent.click(screen.getByRole('button', { name: '曲全体を移調' }));
    fireEvent.change(screen.getByLabelText('新しいキー'), { target: { value: 'G' } });
    fireEvent.click(screen.getByLabelText('ノートとコードも動かす'));
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '移調する' }));
    });
    expect(state().project.key).toBe('G');
    expect(state().project.chordTrack).toBe(before.chordTrack);
  });

  it('拒否されたらダイアログを開いたまま理由を表示し、何も変えない', () => {
    load(makeProject([makeTrack('inst', 'instrument', [midiClip('c', 'inst', 0, 4, [[0, 1, 127]])])]));
    const before = state().project;
    render(createElement(TransportBar));
    fireEvent.click(screen.getByRole('button', { name: '曲全体を移調' }));
    fireEvent.change(screen.getByLabelText('新しいキー'), { target: { value: 'D' } });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '移調する' }));
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(state().project).toBe(before);
    expect(bridge.getBridgeSnapshot().toasts.at(-1)?.message).toMatch(/MIDI 127 を超えて/);
  });
});
