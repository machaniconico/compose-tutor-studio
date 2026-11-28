// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, type Clip } from '@cts/project-model';
import { matchShortcut } from '../src/features/common/keymap';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
});
afterEach(cleanup);

function melodyClip(): Clip {
  return useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'midi')!;
}
function notes() {
  return useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!.notes ?? [];
}
let clipId = '';

describe('ノート操作(ピアノロール)', () => {
  beforeEach(async () => {
    installLocalStorage();
    await act(async () => {
      await useStore.getState().createNewProject('ノート操作');
    });
    const clip = melodyClip();
    clipId = clip.id;
    act(() => {
      useStore.setState((s) => ({
        project: {
          ...s.project,
          tracks: s.project.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, notes: [] } : c)) })),
        },
        past: [],
        future: [],
        midiRecordingActive: false,
      }));
      const state = useStore.getState();
      for (const [pitch, startBeat, durationBeats] of [[60, 0, 0.5], [62, 1, 0.5], [64, 2, 0.5]] as const) {
        state.addNote(clip.id, { pitch, startBeat, durationBeats, velocity: 90 });
      }
      state.selectClip(clip.id);
    });
    const ids = notes().map((n) => n.id);
    act(() => useStore.getState().selectNotes(ids));
  });

  it('「ゆらぎ…」の中のボタンでレガートが効き、元に戻す 1 回で戻る', () => {
    const before = JSON.stringify(notes());
    render(<PianoRoll />);
    fireEvent.click(screen.getByRole('button', { name: 'ゆらぎ…' }));
    fireEvent.click(screen.getByRole('button', { name: 'なめらかにつなぐ' }));
    expect(notes().map((n) => n.durationBeats)).toEqual([1, 1, 0.5]);
    expect(screen.getByRole('status').textContent).toMatch(/レガート/);
    act(() => useStore.getState().undo());
    expect(JSON.stringify(notes())).toBe(before);
  });

  it('録音中はボタンが使えない。グリッドに 3 連符がある', () => {
    act(() => useStore.setState({ midiRecordingActive: true }));
    render(<PianoRoll />);
    fireEvent.click(screen.getByRole('button', { name: 'ゆらぎ…' }));
    expect((screen.getByRole('button', { name: '短く切る' }) as HTMLButtonElement).disabled).toBe(true);
    const options = [...screen.getByLabelText('グリッド分解能').querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['1/8三連', '1/16三連']));
    act(() => useStore.setState({ midiRecordingActive: false }));
  });

  it('矢印キーで選んだ音がグリッド幅・半音・オクターブずつ動き、1 回の Undo で戻る。入力欄の中では動かない', () => {
    const { container } = render(<PianoRoll />);
    const root = container.querySelector<HTMLElement>('.pr')!;
    root.tabIndex = -1;
    root.focus();
    const first = () => notes().map((n) => [n.startBeat, n.pitch]);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(first()[0]).toEqual([1, 60]); // 既定のグリッドは 1/4(1 拍)
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(first()[0]).toEqual([1, 61]);
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    expect(first()[0]).toEqual([1, 49]);
    const past = useStore.getState().past.length;
    expect(past).toBeGreaterThanOrEqual(3);
    const field = document.createElement('input');
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: 'ArrowLeft', bubbles: true });
    expect(first()[0]).toEqual([1, 49]);
    expect(matchShortcut({ key: 'ArrowLeft', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: field }, 'pianoRoll', false)).toBeNull();
    field.remove();
    act(() => useStore.getState().undo());
    expect(first()[0]).toEqual([1, 61]);
  });
});
