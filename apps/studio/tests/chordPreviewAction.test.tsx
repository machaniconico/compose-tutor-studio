// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChordEvent } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

const previewMock = vi.hoisted(() => ({
  previewChord: vi.fn(() => true),
  previewNote: vi.fn(),
}));
vi.mock('../src/audio/livePreview', () => previewMock);

let useStore: typeof import('../src/state/store')['useStore'];
let ChordLane: typeof import('../src/features/chordTrack/ChordLane')['ChordLane'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ ChordLane } = await import('../src/features/chordTrack/ChordLane'));
});

const chord: ChordEvent = {
  id: 'c1', symbol: 'C', startBeat: 0, durationBeats: 4, root: 'C', quality: 'major', notes: [0, 4, 7],
};

describe('chord click audition', () => {
  beforeEach(async () => {
    previewMock.previewChord.mockClear();
    await useStore.getState().flushPendingSave();
    installLocalStorage();
    expect(await useStore.getState().createNewProject('テスト')).toBe(true);
    useStore.setState((s) => ({ project: { ...s.project, chordTrack: [chord] } }));
  });
  afterEach(() => cleanup());

  it('clicking a chord chip and the popover play button plays it without touching the project', () => {
    const before = useStore.getState().project;
    render(<ChordLane />);
    fireEvent.click(screen.getByText('C').closest('button') as HTMLElement);
    expect(previewMock.previewChord).toHaveBeenCalledTimes(1);
    expect(previewMock.previewChord).toHaveBeenCalledWith(before, chord);
    fireEvent.click(screen.getByRole('button', { name: 'このコードを鳴らす' }));
    expect(previewMock.previewChord).toHaveBeenCalledTimes(2);
    expect(useStore.getState().project).toBe(before);
  });
});
