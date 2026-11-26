// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Clip, Section } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

// The store reads localStorage at module-import time, so install the stub
// BEFORE importing it (and editorActions, which imports the store).
let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');
let bridge: typeof import('../src/state/tutorialBridge');
let Arranger: typeof import('../src/features/arranger/Arranger')['Arranger'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
  bridge = await import('../src/state/tutorialBridge');
  ({ Arranger } = await import('../src/features/arranger/Arranger'));
});

const SECTIONS: Section[] = [
  { id: 'sec-a', name: 'はじまり', type: 'intro', startBar: 0, lengthBars: 4 },
  { id: 'sec-b', name: 'もりあがり', type: 'chorus', startBar: 4, lengthBars: 4 },
  { id: 'sec-c', name: 'おわり', type: 'outro', startBar: 8, lengthBars: 4 },
];

beforeEach(() => {
  installLocalStorage();
  useStore.getState().createNewProject('テスト');
  useStore.setState((s) => ({
    project: { ...s.project, lengthBars: 12, sections: SECTIONS },
    past: [],
    future: [],
    transport: { ...s.transport, loopEnabled: false },
  }));
});

afterEach(() => cleanup());

const past = () => useStore.getState().past.length;
const sectionIds = () =>
  [...useStore.getState().project.sections].sort((x, y) => x.startBar - y.startBar).map((s) => s.id);

describe('section actions', () => {
  it('duplicate adds one undo step and grows the song', () => {
    expect(actions.duplicateSectionInSong('sec-b')).toBe(true);
    expect(past()).toBe(1);
    expect(useStore.getState().project.lengthBars).toBe(16);
    expect(useStore.getState().project.sections).toHaveLength(4);
    useStore.getState().undo();
    expect(useStore.getState().project.lengthBars).toBe(12);
  });

  it('move earlier / later each add one undo step', () => {
    expect(actions.moveSectionInSong('sec-b', -1)).toBe(true);
    expect(past()).toBe(1);
    expect(sectionIds()).toEqual(['sec-b', 'sec-a', 'sec-c']);
    expect(actions.moveSectionInSong('sec-b', 1)).toBe(true);
    expect(past()).toBe(2);
    expect(sectionIds()).toEqual(['sec-a', 'sec-b', 'sec-c']);
  });

  it('delete adds one undo step and closes the gap', () => {
    expect(actions.deleteSectionFromSong('sec-b')).toBe(true);
    expect(past()).toBe(1);
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(useStore.getState().project.sections.find((s) => s.id === 'sec-c')?.startBar).toBe(4);
  });

  it('a refused edit adds no undo step and shows the reason', () => {
    expect(actions.moveSectionInSong('sec-a', -1)).toBe(false);
    expect(past()).toBe(0);

    // A looping clip across the chorus's first edge (beat 16).
    const track = useStore.getState().project.tracks.find((t) => t.type === 'instrument')!;
    const loop: Clip = {
      id: 'loop', trackId: track.id, type: 'midi', startBeat: 12, lengthBeats: 8, loop: true, contentLengthBeats: 2,
      notes: [{ id: 'loop-n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    useStore.setState((s) => ({
      project: { ...s.project, tracks: s.project.tracks.map((t) => (t.id === track.id ? { ...t, clips: [loop] } : t)) },
    }));
    const before = useStore.getState().project;
    const toasts = bridge.getBridgeSnapshot().toasts.length;
    expect(actions.duplicateSectionInSong('sec-b')).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(past()).toBe(0);
    expect(bridge.getBridgeSnapshot().toasts.at(-1)?.message).toMatch(/セクションの境目.*ループ/);
    expect(bridge.getBridgeSnapshot().toasts).toHaveLength(toasts + 1);
  });

  it('clicking a section sets loopRange to its bars and turns loop on', () => {
    render(createElement(Arranger));
    fireEvent.click(screen.getByTitle('もりあがり / サビ'));
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 16, endBeat: 32 });
    expect(useStore.getState().transport.loopEnabled).toBe(true);
    expect(past()).toBe(1);
  });
});

describe('Arranger section descriptions', () => {
  it('shows a short Japanese description of the clicked section type', () => {
    render(createElement(Arranger));
    fireEvent.click(screen.getByTitle('もりあがり / サビ'));
    expect(screen.getByText('サビ: 曲の一番盛り上がる部分')).toBeTruthy();
    fireEvent.click(screen.getByTitle('はじまり / イントロ'));
    expect(screen.getByText(/^イントロ: 曲の入り口/)).toBeTruthy();
  });

  it('the editor buttons duplicate, move and delete the section', () => {
    render(createElement(Arranger));
    fireEvent.click(screen.getByTitle('はじまり / イントロ'));
    expect((screen.getByRole('button', { name: '前へ' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '後ろへ' }));
    expect(sectionIds()).toEqual(['sec-b', 'sec-a', 'sec-c']);
    fireEvent.click(screen.getByRole('button', { name: '複製' }));
    expect(useStore.getState().project.lengthBars).toBe(16);
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(useStore.getState().project.lengthBars).toBe(12);
    expect(useStore.getState().project.sections.some((s) => s.id === 'sec-a')).toBe(false);
  });
});
