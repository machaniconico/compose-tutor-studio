// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChordEvent } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

const previewMock = vi.hoisted(() => ({
  previewNote: vi.fn(async () => undefined),
  previewChord: vi.fn(async () => undefined),
  PREVIEW_DURATION_MS: 300,
  MAX_PREVIEW_VOICES: 8,
}));
vi.mock('../src/audio/livePreview', () => previewMock);

let useStore: typeof import('../src/state/store')['useStore'];
let ChordPopover: typeof import('../src/features/chordTrack/ChordPopover')['ChordPopover'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ ChordPopover } = await import('../src/features/chordTrack/ChordPopover'));
});

const chord: ChordEvent = {
  id: 'c1',
  symbol: 'C',
  startBeat: 0,
  durationBeats: 4,
  root: 'C',
  quality: 'major',
  notes: [60, 64, 67],
};

describe('ChordPopover preview', () => {
  beforeEach(() => {
    previewMock.previewChord.mockClear();
    act(() => useStore.getState().createNewProject('テスト'));
  });

  function renderPopover() {
    const project = { ...useStore.getState().project, key: 'C' as const, scale: 'major' as const, chordTrack: [chord] };
    render(<ChordPopover project={project} chord={chord} onClose={() => undefined} />);
  }

  it('focusing a palette candidate plays its close voicing from C4', () => {
    renderPopover();
    fireEvent.focus(screen.getByRole('button', { name: 'Am' }));
    expect(previewMock.previewChord).toHaveBeenCalledTimes(1);
    expect((previewMock.previewChord.mock.calls[0] as unknown[])[0]).toEqual([69, 72, 76]);
  });

  it('hovering a candidate plays it, and the listen button plays the typed chord', () => {
    renderPopover();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'G' }));
    expect((previewMock.previewChord.mock.calls[0] as unknown[])[0]).toEqual([67, 71, 74]);
    fireEvent.click(screen.getByRole('button', { name: 'このコードを聞く' }));
    expect((previewMock.previewChord.mock.calls[1] as unknown[])[0]).toEqual([60, 64, 67]);
  });

  it('a chord name the input accepts, such as Cadd9, is heard when listened to', () => {
    renderPopover();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cadd9' } });
    fireEvent.click(screen.getByRole('button', { name: 'このコードを聞く' }));
    expect((previewMock.previewChord.mock.calls[0] as unknown[])[0]).toEqual([60, 62, 64, 67]);
  });
});
