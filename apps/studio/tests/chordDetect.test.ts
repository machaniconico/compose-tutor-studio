// @vitest-environment jsdom
import { createElement } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beatTick, PPQ } from '@cts/project-model';
import { beforeAll, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];
let actions: typeof import('../src/state/editorActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
  actions = await import('../src/state/editorActions');
});

function setUpClip(withNotes = true, offsetBeats = 0) {
  act(() => {
    const store = useStore.getState();
    store.createNewProject('コード検出');
    store.setDifficulty('beginner');
    const clip = actions.firstMidiClipOfTrack(useStore.getState().project, 'Chords')!;
    store.applyProjectChange((project) => ({
      ...project,
      chordTrack: [actions.buildChordEvent(project, 'F', 4, 16)],
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((item) => item.id === clip.id ? {
          ...item,
          startBeat: 8 + offsetBeats,
          lengthBeats: 7 + offsetBeats,
          notes: withNotes ? [
            ...[57, 60, 64, 67].map((pitch) => ({ pitch, startBeat: 0 })),
            ...[60, 63, 67].map((pitch) => ({ pitch, startBeat: 4 })),
          ].map((note, i) => ({ ...note, id: `detect-note-${i}`, durationBeats: 1, velocity: 90 })) : [],
        } : item),
      })),
    }));
    store.selectClip(clip.id);
  });
  render(createElement(PianoRoll));
  return screen.getByRole('button', { name: 'このクリップのコードを調べる' });
}

function openCandidates(trigger: HTMLElement) {
  fireEvent.click(trigger);
  return within(screen.getByRole('dialog', { name: 'コードの候補' }));
}

describe('Piano Roll chord detection', () => {
  it('writes two selected interpretations at absolute beats only after confirmation, in one Undo step', () => {
    const trigger = setUpClip();
    const before = useStore.getState();
    const dialog = openCandidates(trigger);
    const [first, second] = dialog.getAllByRole('combobox');
    const confirm = dialog.getByRole<HTMLButtonElement>('button', { name: '選んだコードを反映' });

    expect(dialog.getByText(/このように解釈できます/)).toBeTruthy();
    expect(within(first!).getByRole('option', { name: 'Am7' })).toBeTruthy();
    expect(within(first!).getByRole('option', { name: 'C6' })).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    expect(useStore.getState().project).toBe(before.project);

    fireEvent.change(first!, { target: { value: 'C6' } });
    fireEvent.change(second!, { target: { value: 'Cm' } });
    expect(dialog.getByText(/コードに合う音は 4 種類/)).toBeTruthy();
    expect(useStore.getState().project.chordTrack).toBe(before.project.chordTrack);
    expect(useStore.getState().past).toBe(before.past);

    fireEvent.click(confirm);
    const after = useStore.getState();
    expect(after.past).toHaveLength(before.past.length + 1);
    expect(after.project.chordTrack).toMatchObject([
      { symbol: 'F', startBeat: 4, durationBeats: 4 },
      { symbol: 'C6', startBeat: 8, durationBeats: 4, notes: [0, 4, 7, 9] },
      { symbol: 'Cm', startBeat: 12, durationBeats: 3, notes: [0, 3, 7] },
      { symbol: 'F', startBeat: 15, durationBeats: 5 },
    ]);
    expect(new Set(after.project.chordTrack.map(({ id }) => id)).size).toBe(4);
    expect(document.activeElement).toBe(trigger);

    act(() => useStore.getState().undo());
    expect(useStore.getState().project.chordTrack).toEqual(before.project.chordTrack);
  });

  it('leaves the unselected interval alone and closes without changes on Escape', () => {
    const trigger = setUpClip();
    const before = useStore.getState();
    const dialog = openCandidates(trigger);
    const [first] = dialog.getAllByRole('combobox');
    expect(document.activeElement).toBe(first);
    const close = dialog.getByRole('button', { name: '閉じる' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(dialog.getByRole('button', { name: 'キャンセル' }));
    fireEvent.change(first!, { target: { value: 'Am7' } });
    fireEvent.keyDown(first!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toBe(before.past);

    const reopened = openCandidates(trigger);
    const [choice] = reopened.getAllByRole('combobox');
    fireEvent.change(choice!, { target: { value: 'Am7' } });
    fireEvent.click(reopened.getByRole('button', { name: '選んだコードを反映' }));
    expect(useStore.getState().project.chordTrack).toMatchObject([
      { symbol: 'F', startBeat: 4, durationBeats: 4 },
      { symbol: 'Am7', startBeat: 8, durationBeats: 4 },
      { symbol: 'F', startBeat: 12, durationBeats: 8 },
    ]);
  });

  it('offers no apply action for a clip with no chord candidates', () => {
    const trigger = setUpClip(false);
    const before = useStore.getState();
    const dialog = openCandidates(trigger);
    expect(dialog.getByText('コードの候補が見つかりませんでした。')).toBeTruthy();
    expect(dialog.queryByRole('button', { name: '選んだコードを反映' })).toBeNull();
    expect(useStore.getState().past).toBe(before.past);
  });

  it('ends at the clip boundary when its start and length are both between ticks', () => {
    const offset = 0.6 / PPQ;
    const dialog = openCandidates(setUpClip(true, offset));
    const [, choice] = dialog.getAllByRole('combobox');
    fireEvent.change(choice!, { target: { value: 'Cm' } });
    fireEvent.click(dialog.getByRole('button', { name: '選んだコードを反映' }));

    const chord = useStore.getState().project.chordTrack.find(({ symbol }) => symbol === 'Cm')!;
    expect(beatTick(chord.startBeat)).toBe(beatTick(12 + offset));
    expect(beatTick(chord.startBeat + chord.durationBeats)).toBe(beatTick(15 + 2 * offset));
  });

  it('prevents applying a preview after the project changes', () => {
    const dialog = openCandidates(setUpClip());
    const [choice] = dialog.getAllByRole('combobox');
    fireEvent.change(choice!, { target: { value: 'Am7' } });
    act(() => actions.addChordWithAnalysis('G', 20, 4));

    expect(dialog.getByRole<HTMLButtonElement>('button', { name: '選んだコードを反映' }).disabled).toBe(true);
    expect(dialog.getByRole('status').textContent).toContain('曲が変更されました');
  });
});
