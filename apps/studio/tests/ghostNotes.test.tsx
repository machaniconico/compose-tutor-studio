// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';
import { makeProject, makeTrack, midiClip } from '../../../packages/project-model/tests/acceptance/helpers';

vi.mock('../src/audio/livePreview', () => ({
  previewNote: vi.fn(async () => undefined),
  previewChord: vi.fn(async () => undefined),
  PREVIEW_DURATION_MS: 300,
  MAX_PREVIEW_VOICES: 8,
}));

let useStore: typeof import('../src/state/store')['useStore'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
});
afterEach(cleanup);

function load(project: ReturnType<typeof makeProject>, clipId = 'view') {
  act(() => {
    useStore.getState().loadProjectForPreview(project);
    useStore.getState().selectClip(clipId);
  });
}

const twoTracks = () =>
  makeProject(
    [
      makeTrack('a', 'instrument', [midiClip('view', 'a', 8, 8, [[0, 1, 60]])]),
      makeTrack('b', 'instrument', [midiClip('other', 'b', 16, 8, [[2, 1, 64], [3, 1, 65]])]),
    ],
    { lengthBars: 8 },
  );

describe('PianoRoll ゴーストノート', () => {
  beforeEach(() => {
    act(() => useStore.getState().createNewProject('テスト'));
  });

  it('他トラックのノートを ghost-note として描き、表示チェックを外すと消え、戻すと出る', () => {
    load(twoTracks());
    render(<PianoRoll />);
    expect(screen.getAllByTestId('ghost-note')).toHaveLength(2);
    const box = screen.getByRole('checkbox', { name: /b/ });
    fireEvent.click(box);
    expect(screen.queryAllByTestId('ghost-note')).toHaveLength(0);
    fireEvent.click(box);
    expect(screen.getAllByTestId('ghost-note')).toHaveLength(2);
  });

  it('ゴーストは編集不可(クリックしてもノートの選択や追加が起きない)', () => {
    load(twoTracks());
    render(<PianoRoll />);
    const before = JSON.stringify(useStore.getState().project);
    fireEvent.pointerDown(screen.getAllByTestId('ghost-note')[0]!);
    expect(JSON.stringify(useStore.getState().project)).toBe(before);
    expect(useStore.getState().editor.selectedNoteIds).toEqual([]);
  });

  it('トラックが 1 本だけなら ghost も表示チェックも出ない', () => {
    load(makeProject([makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 8, [[0, 1, 60]])])]));
    render(<PianoRoll />);
    expect(screen.queryAllByTestId('ghost-note')).toHaveLength(0);
    expect(screen.queryByRole('group', { name: 'ほかのトラックを重ねる' })).toBeNull();
  });

  it('他トラックにノートが無ければ ghost は 0 件', () => {
    load(
      makeProject([
        makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 8, [])]),
        makeTrack('b', 'instrument', [midiClip('other', 'b', 0, 8, [])]),
      ]),
    );
    render(<PianoRoll />);
    expect(screen.queryAllByTestId('ghost-note')).toHaveLength(0);
  });

  it('描画数に上限があり、高密度でも落ちない', () => {
    const dense = Array.from({ length: 3000 }, (_, i): [number, number, number] => [(i % 3000) / 50, 0.01, 60]);
    load(
      makeProject(
        [
          makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 8, [])]),
          makeTrack('b', 'instrument', [midiClip('other', 'b', 0, 60, dense)]),
        ],
        { lengthBars: 16 },
      ),
    );
    render(<PianoRoll />);
    const n = screen.getAllByTestId('ghost-note').length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(600);
  });

  it('色分けモードのセレクタがあり、選ぶとノートに記号が出る', () => {
    load(twoTracks());
    render(<PianoRoll />);
    fireEvent.change(screen.getByRole('combobox', { name: 'ノートの色分け' }), { target: { value: 'chordTone' } });
    expect(useStore.getState().editor.noteColorMode).toBe('chordTone');
    expect(document.querySelectorAll('.pr__note-mark').length).toBeGreaterThan(0);
    act(() => useStore.getState().setNoteColorMode('plain'));
  });

  it('audio クリップに入った notes でも、soundingEvents が返す音はゴーストの候補になる', () => {
    const audioish = { ...midiClip('other', 'b', 0, 8, [[0, 1, 60]]), type: 'audio' as const };
    load(
      makeProject([
        makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 8, [])]),
        makeTrack('b', 'instrument', [audioish]),
      ]),
    );
    render(<PianoRoll />);
    expect(screen.getAllByTestId('ghost-note')).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: /b/ })).toBeTruthy();
  });

  it('色分けのコードは実際に鳴る拍(スウィング込み)で引く', () => {
    const chord = (id: string, startBeat: number, durationBeats: number, symbol: string, notes: number[]) => ({
      id, startBeat, durationBeats, symbol, root: symbol, quality: 'major', notes,
    });
    const project = makeProject([makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 4, [[0.25, 0.25, 64]])])], {
      swing: 60,
      chordTrack: [chord('c1', 0, 0.375, 'C', [60, 64, 67]), chord('c2', 0.375, 3.625, 'F', [65, 69, 72])],
    });
    load(project);
    act(() => useStore.getState().setNoteColorMode('chordTone'));
    render(<PianoRoll />);
    expect(document.querySelector('.pr__note--chordTone')).toBeNull();
    expect(document.querySelector('.pr__note--scaleTone')).not.toBeNull();
    act(() => useStore.getState().setNoteColorMode('plain'));
  });
});
