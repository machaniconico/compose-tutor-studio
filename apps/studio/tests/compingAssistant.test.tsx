// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyProject } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let CompingAssistant: typeof import('../src/features/assistant/CompingAssistant')['CompingAssistant'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ CompingAssistant } = await import('../src/features/assistant/CompingAssistant'));
});
afterEach(cleanup);

beforeEach(() => {
  const base = createEmptyProject();
  const chordTrack = [0, 1, 2, 3].map((bar) => ({
    id: `c${bar}`, startBeat: bar * 4, durationBeats: 4, symbol: bar === 1 ? 'F' : 'C', root: 'C', quality: 'major', notes: [0, 4, 7],
  }));
  useStore.setState({
    project: { ...base, id: useStore.getState().project.id, chordTrack },
    past: [],
    future: [],
    audioRecordingOperationId: null,
    projectOperationBusy: false,
  });
});

describe('CompingAssistant', () => {
  it('generates a clip from the chosen pattern and reports the result', () => {
    render(<CompingAssistant />);
    fireEvent.click(screen.getByRole('button', { name: 'アルペジオ(上行)' }));
    fireEvent.change(screen.getByLabelText('おわりの小節'), { target: { value: '2' } });
    act(() => { fireEvent.click(screen.getByRole('button', { name: '伴奏を作る' })); });
    expect(screen.getByRole('status').textContent).toContain('新しいトラック「伴奏」の 1〜2 小節');
    const tracks = useStore.getState().project.tracks;
    expect(tracks.some((t) => t.name === '伴奏' && t.clips.length === 1)).toBe(true);
    expect(screen.queryByLabelText('トラック')).toBeNull();
    expect(useStore.getState().past.length).toBe(1);
  });

  it('shows the refusal reason and leaves the song alone when the range is invalid', () => {
    render(<CompingAssistant />);
    fireEvent.change(screen.getByLabelText('はじめの小節'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('おわりの小節'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '伴奏を作る' }));
    expect(screen.getByRole('alert').textContent).toContain('小節の範囲');
    expect(useStore.getState().past.length).toBe(0);
  });
});
