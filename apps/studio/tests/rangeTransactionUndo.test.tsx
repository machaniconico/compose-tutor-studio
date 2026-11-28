// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let TrackInspector: typeof import('../src/features/tracklist/TrackInspector')['TrackInspector'];
let DrumGrid: typeof import('../src/features/drums/DrumGrid')['DrumGrid'];
let addStudioTrack: typeof import('../src/state/trackActions')['addStudioTrack'];
let readInstrumentMacro: typeof import('../src/audio/macros')['readInstrumentMacro'];

function installSerialLocks(): void {
  let tail: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    value: {
      request<T>(_name: string, _options: unknown, callback: () => Promise<T> | T): Promise<T> {
        const run = tail.then(() => callback());
        tail = run.catch(() => undefined);
        return run;
      },
    },
    configurable: true,
  });
}

beforeAll(async () => {
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
  ({ TrackInspector } = await import('../src/features/tracklist/TrackInspector'));
  ({ DrumGrid } = await import('../src/features/drums/DrumGrid'));
  ({ addStudioTrack } = await import('../src/state/trackActions'));
  ({ readInstrumentMacro } = await import('../src/audio/macros'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('ドラッグ取引')).toBe(true);
});

afterEach(() => cleanup());

const down = (el: HTMLElement, pointerId = 5) =>
  fireEvent.pointerDown(el, { pointerId, button: 0, isPrimary: true });
const up = (el: HTMLElement, pointerId = 5) => {
  fireEvent.pointerUp(el, { pointerId });
  fireEvent.lostPointerCapture(el, { pointerId });
};
const change = (el: HTMLElement, value: number) =>
  fireEvent.change(el, { target: { value: String(value) } });

function macroFixture() {
  const track = useStore.getState().project.tracks.find((t) => t.type === 'instrument');
  if (!track) throw new Error('instrument track missing');
  act(() => useStore.getState().selectTrack(track.id));
  render(<TrackInspector />);
  const slider = screen.getAllByRole('slider', { hidden: true })
    .find((el) => el.getAttribute('aria-label') === '明るさ');
  if (!(slider instanceof HTMLInputElement)) throw new Error('macro slider missing');
  const value = () => readInstrumentMacro(
    useStore.getState().project.tracks.find((t) => t.id === track.id)?.instrument?.params,
    'macroBrightness',
  );
  return { slider, value };
}

describe('instrument macro slider', () => {
  it('one drag is one undo step and undo restores the pre-drag value', () => {
    const { slider, value } = macroFixture();
    const before = value();
    const past = useStore.getState().past.length;
    act(() => {
      down(slider);
      for (const v of [0.2, 0.4, 0.8]) change(slider, v);
    });
    expect(value()).toBe(0.8); // live while dragging
    expect(useStore.getState().past).toHaveLength(past);
    act(() => up(slider));
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(useStore.getState().past).toHaveLength(past + 1);
    act(() => useStore.getState().undo());
    expect(value()).toBe(before);
  });

  it('a drag that ends at the original value adds no undo step', () => {
    const { slider, value } = macroFixture();
    const before = value();
    const past = useStore.getState().past.length;
    act(() => {
      down(slider);
      change(slider, 0.9);
      change(slider, before);
      up(slider);
    });
    expect(useStore.getState().past).toHaveLength(past);
  });

  it('Escape restores the value and ignores the rest of the drag', () => {
    const { slider, value } = macroFixture();
    const before = value();
    act(() => {
      down(slider);
      change(slider, 0.9);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      change(slider, 0.3);
      up(slider);
    });
    expect(value()).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
  });

  it('pointercancel reverts', () => {
    const { slider, value } = macroFixture();
    const before = value();
    act(() => {
      down(slider);
      change(slider, 0.9);
      fireEvent.pointerCancel(slider, { pointerId: 5 });
    });
    expect(value()).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('blur commits the drag as one step (same as the mixer faders)', () => {
    const { slider, value } = macroFixture();
    act(() => {
      down(slider);
      change(slider, 0.9);
      fireEvent.blur(slider);
      change(slider, 0.1);
    });
    expect(value()).toBe(0.9);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('unmounting mid-drag commits and leaves no transaction open', () => {
    const { slider, value } = macroFixture();
    act(() => {
      down(slider);
      change(slider, 0.9);
    });
    cleanup();
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(useStore.getState().past).toHaveLength(1);
    expect(value()).toBe(0.9);
  });

  it('switching project mid-drag never edits the next project', async () => {
    const { slider, value } = macroFixture();
    const before = value();
    const copy = structuredClone(useStore.getState().project);
    act(() => {
      down(slider);
      change(slider, 0.9);
    });
    await act(async () => {
      expect(await useStore.getState().replaceProject(copy)).toBe(true);
    });
    act(() => {
      change(slider, 0.2);
      up(slider);
    });
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(value()).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('each keyboard step is its own undo step and opens no transaction', () => {
    const { slider } = macroFixture();
    act(() => {
      fireEvent.keyDown(slider, { key: 'ArrowRight' });
      change(slider, 0.55);
    });
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    act(() => {
      fireEvent.keyDown(slider, { key: 'ArrowRight' });
      change(slider, 0.56);
    });
    expect(useStore.getState().past).toHaveLength(2);
  });

  it('a drag refused by an open transaction cannot write', () => {
    const { slider, value } = macroFixture();
    const before = value();
    const owner = {};
    act(() => {
      expect(useStore.getState().beginProjectTransaction(owner, 1)).toBe(true);
      down(slider);
      change(slider, 0.9);
      up(slider);
    });
    expect(value()).toBe(before);
    expect(useStore.getState().cancelProjectTransaction(owner)).toBe(true);
  });
});

describe('drum swing slider', () => {
  function drumFixture() {
    const track = useStore.getState().project.tracks.find((t) => t.type === 'drum');
    const clip = track?.clips[0];
    if (!track || !clip) throw new Error('drum clip missing');
    act(() => {
      useStore.getState().selectTrack(track.id);
      useStore.getState().selectClip(clip.id);
    });
    render(<DrumGrid />);
    const slider = screen.getByRole('slider', { name: /スイング/ });
    if (!(slider instanceof HTMLInputElement)) throw new Error('swing slider missing');
    return { slider };
  }

  it('one drag is one undo step; a no-op drag adds none; unmount leaves nothing open', () => {
    const { slider } = drumFixture();
    const before = Number(slider.value);
    act(() => {
      down(slider);
      for (const v of [0.2, 0.4, 0.6]) change(slider, v);
    });
    expect(Number(slider.value)).toBe(0.6);
    expect(useStore.getState().past).toHaveLength(0);
    act(() => up(slider));
    expect(useStore.getState().past).toHaveLength(1);
    act(() => useStore.getState().undo());
    expect(Number(slider.value)).toBe(before);

    const past = useStore.getState().past.length;
    act(() => {
      down(slider);
      change(slider, 0.9);
      change(slider, before);
      up(slider);
    });
    expect(useStore.getState().past).toHaveLength(past);

    act(() => {
      down(slider);
      change(slider, 0.5);
    });
    cleanup();
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(useStore.getState().past).toHaveLength(past + 1);
  });
});

function macroSliders() {
  const track = useStore.getState().project.tracks.find((t) => t.type === 'instrument');
  if (!track) throw new Error('instrument track missing');
  act(() => useStore.getState().selectTrack(track.id));
  render(<TrackInspector />);
  const get = (name: string) => {
    const el = screen.getAllByRole('slider', { hidden: true })
      .find((e) => e.getAttribute('aria-label') === name);
    if (!(el instanceof HTMLInputElement)) throw new Error(`${name} missing`);
    return el;
  };
  const params = () =>
    useStore.getState().project.tracks.find((t) => t.id === track.id)?.instrument?.params;
  return { bright: get('明るさ'), release: get('余韻'), params };
}

describe('gesture ownership', () => {
  it('a stale blur from the previous slider does not close the next drag', () => {
    const { bright, release, params } = macroSliders();
    act(() => {
      down(bright, 5);
      change(bright, 0.8);
      up(bright, 5);
      down(release, 6);
      fireEvent.blur(bright);
      change(release, 0.2);
    });
    expect(useStore.getState().isProjectTransactionOpen()).toBe(true);
    act(() => up(release, 6));
    expect(useStore.getState().past).toHaveLength(2);
    expect(params()?.macroRelease).toBe(0.2);
  });

  it('a second pointer cannot take over or end the drag', () => {
    const { bright } = macroSliders();
    act(() => {
      down(bright, 5);
      change(bright, 0.8);
      down(bright, 6);
      up(bright, 6);
      fireEvent.pointerCancel(bright, { pointerId: 6 });
    });
    expect(useStore.getState().isProjectTransactionOpen()).toBe(true);
    act(() => up(bright, 5));
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('after Escape, other keys do not re-enable writes until the pointer is released', () => {
    const { bright, params } = macroSliders();
    act(() => {
      down(bright, 5);
      change(bright, 0.8);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      fireEvent.keyDown(bright, { key: 'Shift' });
      fireEvent.keyUp(bright, { key: 'Shift' });
      change(bright, 0.3);
    });
    expect(params()?.macroBrightness).toBeUndefined();
    act(() => up(bright, 5));
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('arrow keys during a pointer drag are ignored and prevented', () => {
    const { bright } = macroSliders();
    let notPrevented = true;
    act(() => {
      down(bright, 5);
      change(bright, 0.8);
      notPrevented = fireEvent.keyDown(bright, { key: 'ArrowRight' });
      change(bright, 0.81);
    });
    expect(notPrevented).toBe(false);
    act(() => up(bright, 5));
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('a no-op drag cancels the transaction (no step, base restored)', () => {
    const { bright, params } = macroSliders();
    const start = Number(bright.value);
    act(() => {
      down(bright, 5);
      change(bright, 0.9);
      change(bright, start);
      up(bright, 5);
    });
    expect(useStore.getState().past).toHaveLength(0);
    expect(params()?.macroBrightness).toBeUndefined();
  });
});

describe('drum drag target binding', () => {
  it('switching the selected track mid-drag commits on the original and never writes to the next', () => {
    const drumA = useStore.getState().project.tracks.find((t) => t.type === 'drum');
    if (!drumA?.clips[0]) throw new Error('drum clip missing');
    let newTrackId = '';
    act(() => {
      const result = addStudioTrack({ kind: 'drum', name: 'ドラムB' });
      if (!result.ok) throw new Error('second drum track failed');
      newTrackId = result.trackId;
    });
    const drumB = useStore.getState().project.tracks.find((t) => t.id === newTrackId);
    if (!drumB?.clips[0]) throw new Error('drum B clip missing');
    act(() => {
      useStore.getState().selectTrack(drumA.id);
      useStore.getState().selectClip(drumA.clips[0]!.id);
    });
    render(<DrumGrid />);
    const slider = screen.getByRole('slider', { name: /スイング/ }) as HTMLInputElement;
    const swingOf = (id: string) => {
      const clip = useStore.getState().project.tracks.find((t) => t.id === id)?.clips[0] as
        { drumGroove?: { swing: number } } | undefined;
      return clip?.drumGroove?.swing;
    };
    const pastBefore = useStore.getState().past.length;
    act(() => {
      down(slider, 5);
      change(slider, 0.6);
    });
    act(() => {
      useStore.getState().selectTrack(drumB.id);
      useStore.getState().selectClip(drumB.clips[0]!.id);
    });
    act(() => {
      change(slider, 0.9);
      up(slider, 5);
    });
    expect(swingOf(drumA.id)).toBe(0.6);
    expect(swingOf(drumB.id)).toBeUndefined();
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(useStore.getState().past).toHaveLength(pastBefore + 1);
  });
});
