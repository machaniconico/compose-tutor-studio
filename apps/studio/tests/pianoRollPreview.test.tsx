// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';
import { expandClip } from '@cts/project-model';
import { pxPerBeat } from '../src/features/timeline';

const previewMock = vi.hoisted(() => ({
  previewNote: vi.fn(async () => undefined),
  previewChord: vi.fn(async () => undefined),
  PREVIEW_DURATION_MS: 300,
  MAX_PREVIEW_VOICES: 8,
}));
vi.mock('../src/audio/livePreview', () => previewMock);

let useStore: typeof import('../src/state/store')['useStore'];
let getBridgeSnapshot: typeof import('../src/state/tutorialBridge')['getBridgeSnapshot'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ getBridgeSnapshot } = await import('../src/state/tutorialBridge'));
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
});

function selectFirstMidiClip() {
  const { project } = useStore.getState();
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.type === 'midi');
    if (clip) {
      act(() => useStore.getState().selectClip(clip.id));
      return { track, clip };
    }
  }
  throw new Error('no midi clip');
}

describe('PianoRoll keyboard preview', () => {
  beforeEach(() => {
    previewMock.previewNote.mockClear();
    act(() => useStore.getState().createNewProject('テスト'));
  });

  it('clicking a key previews that MIDI note with the track instrument', () => {
    const { track } = selectFirstMidiClip();
    render(<PianoRoll />);
    fireEvent.click(screen.getByTestId('piano-key-60'));
    expect(previewMock.previewNote).toHaveBeenCalledTimes(1);
    expect(previewMock.previewNote).toHaveBeenCalledWith(track.instrument, 60, 100, 300);
  });

  it('renders only the visible rows of the 88-key range', () => {
    selectFirstMidiClip();
    render(<PianoRoll />);
    const keys = screen.getAllByTestId(/^piano-key-/);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(88);
    expect(screen.queryByTestId('piano-key-108')).toBeNull();
  });

  it('can turn off the preview when placing notes (the note is still placed and undoable)', () => {
    const { clip } = selectFirstMidiClip();
    render(<PianoRoll />);
    expect(useStore.getState().editor.previewOnPlace).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: '置いたら試聴' }));
    expect(useStore.getState().editor.previewOnPlace).toBe(false);
    const notesOf = () =>
      useStore
        .getState()
        .project.tracks.flatMap((t) => t.clips)
        .find((c) => c.id === clip.id)!.notes ?? [];
    const before = notesOf();
    // Beat 0, MIDI 60 (jsdom grid origin is 0,0).
    fireEvent.doubleClick(document.querySelector('.pr__grid')!, {
      clientX: 1,
      clientY: (108 - 60) * 16 + 1,
    });
    const after = notesOf();
    expect(after).toHaveLength(before.length + 1);
    const added = after.find((n) => !before.some((b) => b.id === n.id));
    expect(added).toMatchObject({ pitch: 60, startBeat: 0 });
    expect(previewMock.previewNote).not.toHaveBeenCalled();
    act(() => useStore.getState().undo());
    expect(notesOf()).toEqual(before);
  });

  it('tells the user when the preview cannot start', async () => {
    previewMock.previewNote.mockRejectedValueOnce(new Error('NotAllowedError'));
    selectFirstMidiClip();
    render(<PianoRoll />);
    const toastsBefore = getBridgeSnapshot().toasts.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('piano-key-60'));
    });
    const toasts = getBridgeSnapshot().toasts;
    expect(toasts).toHaveLength(toastsBefore + 1);
    expect(toasts[toasts.length - 1]).toMatchObject({ kind: 'error' });
    expect(toasts[toasts.length - 1]!.message).toContain('試聴の音を鳴らせませんでした');
  });

  it('placing a note in a loop repeat stores it where playback sounds it', () => {
    const { track, clip } = selectFirstMidiClip();
    // An 8-beat clip that repeats its first 2 beats.
    act(() =>
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clip.id ? { ...c, notes: [], lengthBeats: 8, contentLengthBeats: 2, loop: true } : c,
          ),
        })),
      })),
    );
    render(<PianoRoll />);
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    // Local beat 4 (the third repeat), MIDI 60 (jsdom grid origin is 0,0).
    fireEvent.doubleClick(document.querySelector('.pr__grid')!, {
      clientX: 4 * ppb,
      clientY: (108 - 60) * 16 + 1,
    });
    const placed = useStore
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clip.id)!;
    expect(placed.notes).toHaveLength(1);
    const sounded = expandClip(placed, [placed], 4, track.type).notes.filter((n) => n.pitch === 60);
    expect(sounded.length).toBeGreaterThan(0);
    // The repeat under the click sounds it at the clicked beat.
    expect(sounded.some((n) => Math.abs(n.startBeat - (placed.startBeat + 4)) < 1e-9)).toBe(true);
    expect(previewMock.previewNote).toHaveBeenCalledWith(track.instrument, 60, 100, 300);
  });

  it('blocks direct changes to linked notes and lets one undo restore an edit to the source', () => {
    const { clip } = selectFirstMidiClip();
    const linked = { ...clip, id: 'linked', startBeat: 4, aliasOf: clip.id, notes: [] };
    act(() => {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((track) => track.id === clip.trackId
          ? { ...track, clips: [...track.clips, linked] }
          : track),
      }));
      useStore.getState().selectClip(linked.id);
    });
    const before = useStore.getState().project;
    render(<PianoRoll />);
    const clickPosition = { clientX: 1, clientY: (108 - 60) * 16 + 1 };
    // On the old editor the grid accepted this click and previewed an inaudible edit.
    const linkedGrid = document.querySelector('.pr__grid');
    if (linkedGrid) fireEvent.doubleClick(linkedGrid, clickPosition);
    expect(useStore.getState().project).toBe(before);
    expect(previewMock.previewNote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '元のクリップを開く' }));
    expect(useStore.getState().editor.selectedClipId).toBe(clip.id);
    fireEvent.doubleClick(document.querySelector('.pr__grid')!, clickPosition);
    const changed = useStore.getState().project;
    const allClips = changed.tracks.flatMap((track) => track.clips);
    expect(expandClip(linked, allClips).notes).toContainEqual(expect.objectContaining({
      pitch: 60, startBeat: 4,
    }));
    act(() => useStore.getState().undo());
    expect(useStore.getState().project).toEqual(before);
  });

  it('Enter on a focusable key previews that note', () => {
    const { track } = selectFirstMidiClip();
    render(<PianoRoll />);
    const key = screen.getByTestId('piano-key-60');
    expect(key.tabIndex).toBe(0);
    fireEvent.keyDown(key, { key: 'Enter' });
    expect(previewMock.previewNote).toHaveBeenCalledWith(track.instrument, 60, 100, 300);
  });
});

describe('PianoRoll vertical view', () => {
  const ROW = 16;
  let viewportHeight = 12 * ROW;
  let resizeCallbacks: (() => void)[] = [];
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

  beforeEach(() => {
    viewportHeight = 12 * ROW;
    resizeCallbacks = [];
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('pr__scroll') ? viewportHeight : 0;
      },
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
        }
        observe() {
          resizeCallbacks.push(this.cb);
        }
        disconnect() {
          resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
        }
      },
    );
    act(() => useStore.getState().createNewProject('テスト'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    }
  });

  function setClipNotes(pitches: number[], noteLength = 1) {
    const { clip } = selectFirstMidiClip();
    act(() =>
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clip.id && c.type === 'midi'
              ? {
                  ...c,
                  notes: pitches.map((pitch, i) => ({
                    id: `n${i}`,
                    pitch,
                    startBeat: i * noteLength,
                    durationBeats: noteLength,
                    velocity: 100,
                  })),
                }
              : c,
          ),
        })),
      })),
    );
    // Reselect so the piano roll opens on the new notes.
    act(() => useStore.getState().selectClip(clip.id));
  }

  /** MIDI notes whose rows sit inside the scroll viewport. */
  function midisInViewport(): number[] {
    const scroll = document.querySelector('.pr__scroll') as HTMLElement;
    const top = scroll.scrollTop;
    return screen
      .getAllByTestId(/^piano-key-/)
      .filter((k) => {
        const y = parseFloat(k.style.top);
        return y + ROW > top && y < top + viewportHeight;
      })
      .map((k) => Number(k.dataset.testid?.replace('piano-key-', '')));
  }

  it('opens with the clip notes (60..72) inside a short viewport', () => {
    setClipNotes([60, 64, 67, 72]);
    render(<PianoRoll />);
    const visible = midisInViewport();
    expect(visible).toContain(64);
    expect(visible).toContain(67);
    expect(Math.max(...visible)).toBeGreaterThanOrEqual(71);
    expect(Math.min(...visible)).toBeLessThanOrEqual(61);
  });

  it.each([108, 21])('reopens a clip whose only note is MIDI %i with that key below the ruler', (pitch) => {
    // 1280x800: a 72px scroll area, of which the sticky ruler takes 22px.
    viewportHeight = 72;
    setClipNotes([pitch]);
    render(<PianoRoll />);
    const scroll = document.querySelector('.pr__scroll') as HTMLElement;
    const keyTop = parseFloat(screen.getByTestId(`piano-key-${pitch}`).style.top);
    expect(keyTop).toBeGreaterThanOrEqual(scroll.scrollTop);
    expect(keyTop + ROW).toBeLessThanOrEqual(scroll.scrollTop + viewportHeight - 22);
  });

  it('mounts only notes on rendered rows, and the off-screen ones after scrolling to them', () => {
    // MIDI 60 opens at the top of a 12-row view; MIDI 21 is 39 rows below it.
    setClipNotes([60, ...Array.from({ length: 500 }, () => 21)], 1 / 16);
    render(<PianoRoll />);
    expect(document.querySelectorAll('.pr__note')).toHaveLength(1);
    const scroll = document.querySelector('.pr__scroll') as HTMLElement;
    act(() => {
      scroll.scrollTop = (108 - 21) * ROW;
      fireEvent.scroll(scroll);
    });
    expect(document.querySelectorAll('.pr__note')).toHaveLength(500);
  });

  it('keeps a dragged note mounted while it is scrolled out of view', () => {
    setClipNotes([60, 21]);
    render(<PianoRoll />);
    const note = document.querySelector('.pr__note') as HTMLElement;
    fireEvent.pointerDown(note, { pointerId: 1, clientX: 1, clientY: 1 });
    const scroll = document.querySelector('.pr__scroll') as HTMLElement;
    act(() => {
      scroll.scrollTop = (108 - 21) * ROW;
      fireEvent.scroll(scroll);
    });
    // The held note (MIDI 60) is still there next to the newly visible MIDI 21.
    expect(document.querySelectorAll('.pr__note')).toHaveLength(2);
    fireEvent.pointerUp(document.querySelector('.pr__grid')!, { pointerId: 1 });
    expect(document.querySelectorAll('.pr__note')).toHaveLength(1);
  });

  it('ignores stored notes outside the 88 keys when opening (MIDI 60 and 127)', () => {
    viewportHeight = 154;
    setClipNotes([60, 127]);
    render(<PianoRoll />);
    expect(midisInViewport()).toContain(60);
    // The out-of-range pitch stays stored as it was.
    const stored = useStore
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .flatMap((c) => c.notes ?? [])
      .map((n) => n.pitch);
    expect(stored).toContain(127);
  });

  it('draws the newly visible keys after a taller resize without scrolling', () => {
    setClipNotes([60, 64, 67, 72]);
    render(<PianoRoll />);
    const scroll = document.querySelector('.pr__scroll') as HTMLElement;
    const top = scroll.scrollTop;
    const lowestAfterResize = 108 - Math.floor((top + 40 * ROW - 1) / ROW);
    expect(screen.queryByTestId(`piano-key-${lowestAfterResize}`)).toBeNull();
    viewportHeight = 40 * ROW;
    act(() => resizeCallbacks.forEach((cb) => cb()));
    expect(scroll.scrollTop).toBe(top);
    expect(screen.getByTestId(`piano-key-${lowestAfterResize}`)).toBeTruthy();
    expect(midisInViewport()).toContain(lowestAfterResize);
  });

  it('keeps the user scroll position when a note is added to the open clip', () => {
    const { clip } = selectFirstMidiClip();
    render(<PianoRoll />);
    const scroll = document.querySelector('.pr__scroll') as HTMLElement;
    scroll.scrollTop = 800;
    fireEvent.scroll(scroll);

    act(() => useStore.getState().addNote(clip.id, {
      id: 'high-note',
      pitch: 108,
      startBeat: 0,
      durationBeats: 1,
      velocity: 100,
    }));

    expect(scroll.scrollTop).toBe(800);
  });
});
