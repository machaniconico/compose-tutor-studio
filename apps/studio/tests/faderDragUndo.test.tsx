// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let MixerStrip: typeof import('../src/features/mixer/MixerStrip')['MixerStrip'];

// jsdom has no Web Locks; the repository fails closed without them, so give
// it a serial in-process lock (one renderer, as in the app).
function installSerialLocks(): void {
  let tail: Promise<unknown> = Promise.resolve();
  const locks = {
    request<T>(_name: string, _options: unknown, callback: () => Promise<T> | T): Promise<T> {
      const run = tail.then(() => callback());
      tail = run.catch(() => undefined);
      return run;
    },
  };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

beforeAll(async () => {
  // Carry pointer identity in jsdom, which does not implement PointerEvent.
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.isPrimary = init.isPrimary ?? false;
    }
  }
  Object.defineProperty(window, 'PointerEvent', { value: TestPointerEvent, configurable: true });
  installSerialLocks();
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ MixerStrip } = await import('../src/features/mixer/MixerStrip'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('フェーダー取引')).toBe(true);
});

afterEach(() => cleanup());

function fixture() {
  const track = useStore.getState().project.tracks.find((t) => t.type !== 'master');
  if (!track) throw new Error('fixture track missing');
  render(<MixerStrip />);
  const fader = screen
    .getAllByRole('slider')
    .find((el) => el.getAttribute('aria-label')?.endsWith('音量')
      && el.getAttribute('aria-label')?.includes(track.name));
  if (!(fader instanceof HTMLInputElement)) throw new Error('volume fader missing');
  const volume = () => useStore.getState().project.tracks.find((t) => t.id === track.id)?.volume;
  return { track, fader, volume };
}

function drag(fader: HTMLInputElement, values: readonly number[]) {
  fireEvent.pointerDown(fader, { pointerId: 7, button: 0, isPrimary: true });
  for (const value of values) fireEvent.change(fader, { target: { value: String(value) } });
}

describe('mixer fader drag in the DOM', () => {
  it('one pointer drag through many values is exactly one Undo step', () => {
    const { track, fader, volume } = fixture();
    const pastBefore = useStore.getState().past.length;

    act(() => {
      drag(fader, [0.3, 0.5, 0.7, 0.9]);
    });
    expect(volume()).toBe(0.9);
    expect(useStore.getState().past).toHaveLength(pastBefore);
    act(() => {
      fireEvent.pointerUp(fader, { pointerId: 7 });
      fireEvent.lostPointerCapture(fader, { pointerId: 7 });
    });

    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(useStore.getState().past).toHaveLength(pastBefore + 1);
    act(() => useStore.getState().undo());
    expect(volume()).toBe(track.volume);
    expect(useStore.getState().past).toHaveLength(pastBefore);
  });

  it('pointercancel restores the pre-drag value and records nothing', () => {
    const { track, fader, volume } = fixture();
    act(() => {
      drag(fader, [0.4, 0.6]);
      fireEvent.pointerCancel(fader, { pointerId: 7 });
    });
    expect(volume()).toBe(track.volume);
    expect(useStore.getState().past).toHaveLength(0);
    expect(Number(fader.value)).toBe(track.volume);
  });

  it('Escape mid-drag restores the value and ignores the rest of that drag', () => {
    const { track, fader, volume } = fixture();
    act(() => {
      drag(fader, [0.4, 0.6]);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      fireEvent.change(fader, { target: { value: '1.2' } });
      fireEvent.pointerUp(fader, { pointerId: 7 });
    });
    expect(volume()).toBe(track.volume);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('Escape on the focused fader itself cancels the drag (real-browser focus)', () => {
    const { track, fader, volume } = fixture();
    act(() => {
      fader.focus();
      drag(fader, [0.4, 0.6]);
      fireEvent.keyDown(fader, { key: 'Escape' });
      fireEvent.pointerUp(fader, { pointerId: 7 });
    });
    expect(volume()).toBe(track.volume);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('unmounting mid-drag commits the open gesture instead of leaking it', () => {
    const { fader, volume } = fixture();
    act(() => {
      drag(fader, [0.4, 0.8]);
    });
    cleanup();
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(useStore.getState().past).toHaveLength(1);
    expect(volume()).toBe(0.8);
  });
});

function faderFor(trackName: string): HTMLInputElement {
  const fader = screen
    .getAllByRole('slider')
    .find((el) => el.getAttribute('aria-label') === `${trackName} 音量`
      || (el.getAttribute('aria-label')?.endsWith('音量')
        && el.getAttribute('aria-label')?.includes(trackName)));
  if (!(fader instanceof HTMLInputElement)) throw new Error(`fader for ${trackName} missing`);
  return fader;
}

describe('one gesture app-wide, bound to its project and pointer', () => {
  it('blur commits and ends the drag; later moves and cancel from that pointer are ignored', () => {
    const { fader, volume } = fixture();
    act(() => {
      drag(fader, [0.4]);
      fireEvent.blur(fader);
      fireEvent.change(fader, { target: { value: '0.6' } });
      fireEvent.pointerCancel(fader, { pointerId: 7 });
    });
    expect(useStore.getState().past).toHaveLength(1);
    expect(volume()).toBe(0.4);
  });

  it('window blur (store finalize) also ends the drag', () => {
    const { fader, volume } = fixture();
    act(() => {
      drag(fader, [0.4]);
      useStore.getState().finalizeProjectTransaction();
      fireEvent.change(fader, { target: { value: '0.6' } });
      fireEvent.pointerCancel(fader, { pointerId: 7 });
    });
    expect(useStore.getState().past).toHaveLength(1);
    expect(volume()).toBe(0.4);
  });

  it('a stale drag never edits the next project, even with the same IDs', async () => {
    const { track, fader, volume } = fixture();
    const copy = structuredClone(useStore.getState().project);
    act(() => {
      drag(fader, [0.4]);
    });
    await act(async () => {
      expect(await useStore.getState().replaceProject(copy)).toBe(true);
    });
    act(() => {
      fireEvent.change(fader, { target: { value: '0.6' } });
      fireEvent.pointerCancel(fader, { pointerId: 7 });
    });
    expect(volume()).toBe(track.volume);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('a second fader is ignored entirely while one drag is active', () => {
    const tracks = useStore.getState().project.tracks.filter((t) => t.type !== 'master');
    const [a, b] = [tracks[0]!, tracks[1]!];
    render(<MixerStrip />);
    const faderA = faderFor(a.name);
    const faderB = faderFor(b.name);
    const volumeOf = (id: string) =>
      useStore.getState().project.tracks.find((t) => t.id === id)?.volume;
    act(() => {
      fireEvent.pointerDown(faderA, { pointerId: 1, button: 0, isPrimary: true });
      fireEvent.change(faderA, { target: { value: '0.4' } });
      fireEvent.pointerDown(faderB, { pointerId: 2, button: 0, isPrimary: false });
      fireEvent.change(faderB, { target: { value: '1.5' } });
      fireEvent.pointerCancel(faderB, { pointerId: 2 });
      fireEvent.pointerUp(faderA, { pointerId: 1 });
    });
    expect(volumeOf(a.id)).toBe(0.4);
    expect(volumeOf(b.id)).toBe(b.volume);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('a second pointer on the same fader is ignored', () => {
    const { track, fader, volume } = fixture();
    act(() => {
      drag(fader, [0.4]);
      fireEvent.pointerDown(fader, { pointerId: 8, button: 0, isPrimary: false });
      fireEvent.pointerCancel(fader, { pointerId: 8 });
      fireEvent.pointerUp(fader, { pointerId: 8 });
    });
    expect(useStore.getState().isProjectTransactionOpen()).toBe(true);
    act(() => {
      fireEvent.pointerCancel(fader, { pointerId: 7 });
    });
    expect(volume()).toBe(track.volume);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('Escape during IME composition does not cancel the drag', () => {
    const { fader, volume } = fixture();
    act(() => {
      drag(fader, [0.4]);
      fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
      fireEvent.keyDown(document.body, { key: 'Escape', keyCode: 229 });
      fireEvent.pointerUp(fader, { pointerId: 7 });
    });
    expect(volume()).toBe(0.4);
    expect(useStore.getState().past).toHaveLength(1);
  });
});


function pointerChange(fader: HTMLInputElement, pointerId: number, value: number) {
  const event = createEvent.change(fader, { target: { value: String(value) } });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  fireEvent(fader, event);
}

describe('P03 fader review regressions', () => {
  it('refuses a Read drag away and back during another track’s Touch pass', () => {
    const { track: readTrack, fader, volume } = fixture();
    const touchTrack = useStore.getState().project.tracks.find(
      (track) => track.id !== readTrack.id && track.type !== 'master',
    )!;
    act(() => {
      const state = useStore.getState();
      expect(state.setTrackAutomationMode(touchTrack.id, 'touch')).toBe(true);
      state.play();
      const requestId = useStore.getState().transport.playbackRequestId;
      expect(state.attachAutomationPlaybackRuntime(requestId, () => 1, {
        beginOverride() {},
        updateOverride() {},
        releaseTouchOverride() {},
        resumeOverride() {},
      })).toBe(true);
      state.confirmPlaybackStarted(requestId);
    });
    expect(useStore.getState().automationRecording.passActive).toBe(true);
    const before = useStore.getState();
    act(() => {
      drag(fader, [0.4]);
      expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
      expect(volume()).toBe(readTrack.volume);
      fireEvent.change(fader, { target: { value: String(readTrack.volume) } });
      fireEvent.pointerCancel(fader, { pointerId: 7 });
    });
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toBe(before.past);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
    expect(useStore.getState().persistenceNotice?.message).toMatch(/記録中/);
  });

  it('never revives pointer 7 after a fresh pointer 8 gesture on the same track in a replacement project', async () => {
    const { fader } = fixture();
    const copy = structuredClone(useStore.getState().project);
    act(() => drag(fader, [0.4]));
    await act(async () => {
      expect(await useStore.getState().replaceProject(copy)).toBe(true);
    });
    act(() => {
      fireEvent.pointerDown(fader, { pointerId: 8, button: 0, isPrimary: true });
      expect(useStore.getState().isProjectTransactionOpen()).toBe(true);
      // A native untagged range change follows the competing pointer's move.
      fireEvent.pointerMove(fader, { pointerId: 7, buttons: 1 });
      fireEvent.change(fader, { target: { value: '0.7' } });
      expect(useStore.getState().past).toHaveLength(0);
      expect(useStore.getState().project.tracks.find((item) => item.id === copy.tracks[0]?.id)?.volume)
        .toBe(copy.tracks[0]?.volume);
      fireEvent.pointerUp(fader, { pointerId: 8 });
    });
    const before = useStore.getState();
    act(() => {
      pointerChange(fader, 7, 0.5);
      pointerChange(fader, 7, 0.6);
      fireEvent.pointerCancel(fader, { pointerId: 7 });
    });
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toBe(before.past);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
  });

  it.each([
    ['window blur', () => fireEvent.blur(window)],
    ['visibilitychange', () => fireEvent(document, new Event('visibilitychange'))],
  ])('commits on %s and persists the next keyboard edit without a pointerup', async (_, end) => {
    const user = userEvent.setup();
    const { track, fader, volume } = fixture();
    act(() => drag(fader, [0.4]));
    end();
    const revision = useStore.getState().saveState.revision;
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    fireEvent.focus(window);
    // jsdom does not perform the range input's default ArrowRight action.
    const previousControl = document.createElement('button');
    fader.before(previousControl);
    previousControl.focus();
    await user.tab();
    expect(document.activeElement).toBe(fader);
    fireEvent.keyDown(fader, { key: 'ArrowRight' });
    fireEvent.change(fader, { target: { value: '0.41' } });
    fireEvent.keyUp(fader, { key: 'ArrowRight' });

    expect(volume()).toBe(0.41);
    expect(useStore.getState().past).toHaveLength(2);
    expect(useStore.getState().saveState.revision).toBe(revision + 1);
    await act(async () => {
      expect(await useStore.getState().flushPendingSave()).toBe(true);
      expect(await useStore.getState().loadProjectById(useStore.getState().project.id)).toBe(true);
    });
    expect(useStore.getState().project.tracks.find((item) => item.id === track.id)?.volume)
      .toBe(0.41);
  });
});

it('lets a text input keep Escape while a piano-roll note drag is active', async () => {
  const user = userEvent.setup();
  const { PianoRoll } = await import('../src/features/pianoRoll/PianoRoll');
  const state = useStore.getState();
  const clip = state.project.tracks.find((track) => track.name === 'Melody')?.clips[0];
  if (!clip) throw new Error('MIDI clip fixture missing');
  state.selectClip(clip.id);
  state.addNote(clip.id, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 });
  const { container } = render(<PianoRoll />);
  const grid = container.querySelector<HTMLElement>('.pr__grid')!;
  const note = container.querySelector<HTMLButtonElement>('.pr__note')!;
  grid.setPointerCapture = () => {};
  fireEvent.pointerDown(note, { pointerId: 7, button: 0, isPrimary: true });
  fireEvent.pointerMove(grid, { pointerId: 7, clientX: 100 });
  expect(document.activeElement).toBe(note);
  const input = document.createElement('input');
  note.after(input);
  await user.tab();
  expect(document.activeElement).toBe(input);
  const onEscape = vi.fn();
  input.addEventListener('keydown', onEscape);

  expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
  expect(onEscape).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(input);
  fireEvent.pointerUp(grid, { pointerId: 7, clientX: 100 });
  expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
    .find((item) => item.id === clip.id)?.notes?.[0]?.startBeat).toBeGreaterThan(0);
});

it.each([
  { keyCode: 229 },
  { altKey: true },
])('leaves the project unchanged when a focused automation point receives Ctrl+Z with %j', async (modifiers) => {
  const { AutomationLaneEditor } = await import('../src/features/automation/AutomationLaneEditor');
  const { addStudioAutomationPoint } = await import('../src/state/automationActions');
  const track = useStore.getState().project.tracks.find((item) => item.type !== 'master')!;
  useStore.getState().selectTrack(track.id);
  expect(addStudioAutomationPoint(
    { type: 'track-volume', trackId: track.id },
    { beat: 1, value: 0.5, interpolation: 'linear' },
  )).toMatchObject({ ok: true });
  const { container } = render(<AutomationLaneEditor />);
  const point = container.querySelector<HTMLButtonElement>('[data-automation-point-id]')!;
  act(() => point.focus());
  expect(document.activeElement).toBe(point);
  const before = useStore.getState();
  fireEvent.keyDown(point, { key: 'z', ctrlKey: true, ...modifiers });
  expect(useStore.getState().project).toBe(before.project);
  expect(useStore.getState().past).toBe(before.past);
});
