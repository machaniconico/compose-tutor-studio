// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyProject } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let AutoAccompanimentAssistant: typeof import('../src/features/assistant/AutoAccompanimentAssistant')['AutoAccompanimentAssistant'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ AutoAccompanimentAssistant } = await import('../src/features/assistant/AutoAccompanimentAssistant'));
});
afterEach(cleanup);

function load(chords: boolean) {
  const base = createEmptyProject();
  const chordTrack = chords
    ? [0, 1, 2, 3].map((bar) => ({
      id: `c${bar}`, startBeat: bar * 4, durationBeats: 4, symbol: bar === 1 ? 'F' : 'C',
      root: bar === 1 ? 'F' : 'C', quality: 'major', notes: bar === 1 ? [5, 9, 0] : [0, 4, 7],
    }))
    : [];
  useStore.setState({
    project: { ...base, id: useStore.getState().project.id, chordTrack },
    past: [],
    future: [],
    audioRecordingOperationId: null,
    projectOperationBusy: false,
  });
}

describe('AutoAccompanimentAssistant', () => {
  beforeEach(() => load(true));

  it('builds comping, bass and drum tracks in one click and one undo step', () => {
    const before = useStore.getState().project.tracks.length;
    render(<AutoAccompanimentAssistant />);
    fireEvent.change(screen.getByLabelText('雰囲気'), { target: { value: 'soft' } });
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'おまかせで伴奏を作る' })); });
    expect(screen.getByRole('status').textContent).toContain('1〜4 小節');
    expect(screen.getByText('小節の頭にルート音を置いて', { exact: false })).toBeTruthy();
    expect(useStore.getState().project.tracks).toHaveLength(before + 3);
    expect(useStore.getState().past).toHaveLength(1);
    act(() => { useStore.getState().undo(); });
    expect(useStore.getState().project.tracks).toHaveLength(before);
  });

  it('explains a refusal kindly while recording and changes nothing', () => {
    useStore.setState({ audioRecordingOperationId: 1 });
    render(<AutoAccompanimentAssistant />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'おまかせで伴奏を作る' })); });
    expect(screen.getByRole('alert').textContent).toContain('録音中');
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('asks for chords first when the chord lane is empty', () => {
    load(false);
    render(<AutoAccompanimentAssistant />);
    expect(screen.queryByRole('button', { name: 'おまかせで伴奏を作る' })).toBeNull();
    expect(screen.getByText('コードトラックにコードを置くと', { exact: false })).toBeTruthy();
  });
});
