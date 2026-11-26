// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Clip } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';
import { pxPerBeat } from '../src/features/timeline';

let useStore: typeof import('../src/state/store')['useStore'];
let ArrangeView: typeof import('../src/features/arranger/ArrangeView')['ArrangeView'];
let EditorArea: typeof import('../src/features/editor/EditorArea')['EditorArea'];
let addEmptyClipAt: typeof import('../src/state/editorActions')['addEmptyClipAt'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ ArrangeView } = await import('../src/features/arranger/ArrangeView'));
  ({ EditorArea } = await import('../src/features/editor/EditorArea'));
  ({ addEmptyClipAt } = await import('../src/state/editorActions'));
});

beforeEach(() => {
  act(() => {
    useStore.getState().createNewProject('テスト');
    useStore.getState().setPosition(0);
  });
});

function allClips(): Clip[] {
  return useStore.getState().project.tracks.flatMap((t) => t.clips);
}

function firstClip(type: Clip['type']): Clip {
  const clip = allClips().find((c) => c.type === type);
  if (!clip) throw new Error(`no ${type} clip`);
  return clip;
}

function pastLength(): number {
  return useStore.getState().past.length;
}

function select(clip: Clip): void {
  act(() => {
    useStore.getState().selectTrack(clip.trackId);
    useStore.getState().selectClip(clip.id);
  });
}

describe('ArrangeView: opening clips', () => {
  it('opens a drum clip in the drum grid and a MIDI clip in the piano roll on double-click', () => {
    act(() => useStore.getState().setActiveView('arrange'));
    render(createElement(EditorArea));
    const drum = firstClip('drum');
    const midi = allClips().filter((c) => c.type === 'midi')[1]!;

    fireEvent.doubleClick(screen.getByTestId(`clip-${drum.id}`));
    expect(useStore.getState().editor.activeView).toBe('drums');
    expect(useStore.getState().editor.selectedClipId).toBe(drum.id);
    expect(screen.getByRole('tab', { name: 'ドラム' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('tab', { name: '曲全体' }));
    fireEvent.doubleClick(screen.getByTestId(`clip-${midi.id}`));
    expect(useStore.getState().editor.activeView).toBe('pianoRoll');
    expect(useStore.getState().editor.selectedClipId).toBe(midi.id);
    expect(screen.getByRole('tab', { name: 'ピアノロール' }).getAttribute('aria-selected')).toBe('true');
  });

  it('creates an empty 1-bar clip when an empty spot of a lane is double-clicked', () => {
    const drum = firstClip('drum');
    act(() => useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === drum.trackId ? { ...t, clips: [] } : t)),
    })));
    render(createElement(ArrangeView));
    const before = pastLength();
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);

    // Double-click inside bar 3 (beats 8..12).
    fireEvent.doubleClick(screen.getByTestId(`arrange-lane-${drum.trackId}`), { clientX: 9.5 * ppb });

    const clips = useStore.getState().project.tracks.find((t) => t.id === drum.trackId)!.clips;
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ type: 'drum', startBeat: 8, lengthBeats: 4, drumEvents: [] });
    expect(useStore.getState().editor.selectedClipId).toBe(clips[0]!.id);
    expect(pastLength()).toBe(before + 1);
  });
});

describe('ArrangeView: shortcuts', () => {
  it('duplicates the selected clip with Ctrl+D as one undo step', () => {
    const drum = firstClip('drum');
    select(drum);
    render(createElement(ArrangeView));
    const before = pastLength();
    const count = allClips().length;

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });

    expect(allClips()).toHaveLength(count + 1);
    expect(pastLength()).toBe(before + 1);
    const created = allClips().find((c) => c.id === useStore.getState().editor.selectedClipId)!;
    expect(created.id).not.toBe(drum.id);
    expect(created.startBeat).toBe(drum.startBeat + drum.lengthBeats);
    expect(screen.getByTestId(`clip-${created.id}`)).toBeTruthy();
    // The song grows to cover the new clip.
    expect(useStore.getState().project.lengthBars).toBe(16);
  });

  it('deletes the selected clip with Delete as one undo step', () => {
    const drum = firstClip('drum');
    select(drum);
    render(createElement(ArrangeView));
    const before = pastLength();

    fireEvent.keyDown(window, { key: 'Delete' });

    expect(allClips().some((c) => c.id === drum.id)).toBe(false);
    expect(screen.queryByTestId(`clip-${drum.id}`)).toBeNull();
    expect(useStore.getState().editor.selectedClipId).toBeNull();
    expect(pastLength()).toBe(before + 1);
  });

  it('ignores the shortcuts while typing in an input', () => {
    const drum = firstClip('drum');
    select(drum);
    render(createElement(ArrangeView));
    const input = document.createElement('input');
    document.body.appendChild(input);
    const count = allClips().length;

    fireEvent.keyDown(input, { key: 'Delete' });
    fireEvent.keyDown(input, { key: 'd', ctrlKey: true });

    expect(allClips()).toHaveLength(count);
    input.remove();
  });
});

describe('ArrangeView: playhead and split', () => {
  it('draws a playhead whose left follows positionBeat', () => {
    render(createElement(ArrangeView));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    expect(parseFloat(screen.getByTestId('playhead').style.left)).toBeCloseTo(0, 5);
    act(() => useStore.getState().setPosition(6));
    expect(parseFloat(screen.getByTestId('playhead').style.left)).toBeCloseTo(6 * ppb, 5);
  });

  it('splits the selected clip at the playhead only when the playhead is inside it', () => {
    const drum = firstClip('drum');
    select(drum);
    render(createElement(ArrangeView));
    const split = screen.getByRole('button', { name: '分割' }) as HTMLButtonElement;

    // At the clip's start edge, at its end edge and after it: disabled.
    expect(split.disabled).toBe(true);
    act(() => useStore.getState().setPosition(drum.startBeat + drum.lengthBeats));
    expect(split.disabled).toBe(true);
    act(() => useStore.getState().setPosition(drum.startBeat + drum.lengthBeats + 4));
    expect(split.disabled).toBe(true);

    act(() => useStore.getState().setPosition(8));
    expect(split.disabled).toBe(false);
    const before = pastLength();
    fireEvent.click(split);

    const clips = useStore.getState().project.tracks.find((t) => t.id === drum.trackId)!.clips;
    expect(clips.map((c) => [c.startBeat, c.lengthBeats])).toEqual([
      [0, 8],
      [8, drum.lengthBeats - 8],
    ]);
    expect(pastLength()).toBe(before + 1);
  });

  it('keeps split disabled while no clip is selected', () => {
    act(() => {
      useStore.getState().selectClip(null);
      useStore.getState().setPosition(8);
    });
    render(createElement(ArrangeView));
    expect((screen.getByRole('button', { name: '分割' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ArrangeView: dragging', () => {
  it('moves a clip by whole bars and makes the whole drag one undo step', () => {
    const drum = firstClip('drum');
    act(() => useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) =>
        t.id === drum.trackId ? { ...t, clips: t.clips.map((c) => ({ ...c, lengthBeats: 4 })) } : t,
      ),
    })));
    render(createElement(ArrangeView));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const el = screen.getByTestId(`clip-${drum.id}`);
    const before = pastLength();

    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 10 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 10 + 3 * ppb });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 10 + 9 * ppb });
    fireEvent.pointerUp(window, { pointerId: 1 });

    const moved = allClips().find((c) => c.id === drum.id)!;
    expect(moved.startBeat).toBe(8);
    expect(pastLength()).toBe(before + 1);
  });

  it('resizes a clip from its right edge, never below 1 beat', () => {
    const drum = firstClip('drum');
    render(createElement(ArrangeView));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const handle = screen.getByTestId(`clip-${drum.id}`).querySelector('.arrange__clip-resize')!;
    const before = pastLength();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 500 - 100 * ppb });
    fireEvent.pointerUp(window, { pointerId: 2 });

    expect(allClips().find((c) => c.id === drum.id)!.lengthBeats).toBe(1);
    expect(pastLength()).toBe(before + 1);
  });
});

describe('ArrangeView: song length, split rounding and keys during a drag', () => {
  function drumClip(id: string, startBeat: number, lengthBeats: number): Clip {
    const trackId = firstClip('drum').trackId;
    return {
      id,
      trackId,
      type: 'drum',
      startBeat,
      lengthBeats,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: `${id}-kick`, lane: 'kick', stepIndex: 0, velocity: 100 }],
    };
  }

  /** Put only `clips` on the drum track (and set the bar count), then forget that undo step. */
  function setDrumClips(clips: Clip[], lengthBars?: number): void {
    const trackId = firstClip('drum').trackId;
    act(() => {
      useStore.getState().applyProjectChange((p) => ({
        ...p,
        lengthBars: lengthBars ?? p.lengthBars,
        tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, clips } : t)),
      }));
    });
  }

  function drumClips(): Clip[] {
    const trackId = firstClip('drum').trackId;
    return useStore.getState().project.tracks.find((t) => t.id === trackId)!.clips;
  }

  it('grows the song when a clip is dragged past its end, in the same undo step', () => {
    setDrumClips([drumClip('k', 28, 4)]);
    expect(useStore.getState().project.lengthBars).toBe(8);
    render(createElement(ArrangeView));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const el = screen.getByTestId('clip-k');
    const before = pastLength();

    fireEvent.pointerDown(el, { button: 0, pointerId: 3, clientX: 10 });
    fireEvent.pointerMove(el, { pointerId: 3, clientX: 10 + 4 * ppb });
    fireEvent.pointerUp(window, { pointerId: 3 });

    expect(drumClips()[0]!.startBeat).toBe(32);
    expect(useStore.getState().project.lengthBars).toBe(9);
    expect(pastLength()).toBe(before + 1);

    act(() => useStore.getState().undo());
    expect(drumClips()[0]!.startBeat).toBe(28);
    expect(useStore.getState().project.lengthBars).toBe(8);
  });

  it('gives the length back when the dragged clip returns inside the song', () => {
    setDrumClips([drumClip('k', 28, 4)]);
    render(createElement(ArrangeView));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const el = screen.getByTestId('clip-k');
    const before = pastLength();

    fireEvent.pointerDown(el, { button: 0, pointerId: 4, clientX: 10 });
    fireEvent.pointerMove(el, { pointerId: 4, clientX: 10 + 8 * ppb });
    expect(useStore.getState().project.lengthBars).toBe(10);
    fireEvent.pointerMove(el, { pointerId: 4, clientX: 10 - 4 * ppb });
    fireEvent.pointerUp(window, { pointerId: 4 });

    expect(drumClips()[0]!.startBeat).toBe(24);
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(pastLength()).toBe(before + 1);
  });

  it('grows the song when a clip is resized past its end', () => {
    setDrumClips([drumClip('k', 28, 4)]);
    render(createElement(ArrangeView));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const handle = screen.getByTestId('clip-k').querySelector('.arrange__clip-resize')!;

    fireEvent.pointerDown(handle, { button: 0, pointerId: 5, clientX: 10 });
    fireEvent.pointerMove(handle, { pointerId: 5, clientX: 10 + 2 * ppb });
    fireEvent.pointerUp(window, { pointerId: 5 });

    expect(drumClips()[0]!.lengthBeats).toBe(6);
    expect(useStore.getState().project.lengthBars).toBe(9);
  });

  it('does not move a clip past the longest song', () => {
    setDrumClips([drumClip('k', 252, 4)], 64);
    render(createElement(ArrangeView));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const el = screen.getByTestId('clip-k');
    const before = pastLength();

    fireEvent.pointerDown(el, { button: 0, pointerId: 6, clientX: 10 });
    fireEvent.pointerMove(el, { pointerId: 6, clientX: 10 + 4 * ppb });
    fireEvent.pointerUp(window, { pointerId: 6 });

    expect(drumClips()[0]!.startBeat).toBe(252);
    expect(useStore.getState().project.lengthBars).toBe(64);
    expect(pastLength()).toBe(before);
  });

  it('keeps a song longer than the maximum and refuses a duplicate past it', () => {
    setDrumClips([drumClip('early', 36, 4), drumClip('last', 256, 4)], 65);
    render(createElement(ArrangeView));

    select(drumClips()[0]!);
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(drumClips()).toHaveLength(3);
    expect(useStore.getState().project.lengthBars).toBe(65);

    select(drumClips().find((c) => c.id === 'last')!);
    const before = pastLength();
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(drumClips()).toHaveLength(3);
    expect(useStore.getState().project.lengthBars).toBe(65);
    expect(pastLength()).toBe(before);
    expect(useStore.getState().editor.selectedClipId).toBe('last');
  });

  it('does not create an empty clip past the longest song', () => {
    setDrumClips([], 64);
    const trackId = firstClip('midi').trackId;
    const before = pastLength();
    let created: string | null = 'unset';
    act(() => {
      created = addEmptyClipAt(trackId, 64 * 4, 64);
    });
    expect(created).toBeNull();
    expect(pastLength()).toBe(before);
  });

  it('disables split where the drum step rounding would land on the clip edge', () => {
    setDrumClips([drumClip('k', 28, 4)]);
    select(drumClips()[0]!);
    render(createElement(ArrangeView));
    const split = screen.getByRole('button', { name: '分割' }) as HTMLButtonElement;

    act(() => useStore.getState().setPosition(28.05));
    expect(split.disabled).toBe(true);

    act(() => useStore.getState().setPosition(28.25));
    expect(split.disabled).toBe(false);
    const before = pastLength();
    fireEvent.click(split);
    expect(drumClips().map((c) => [c.startBeat, c.lengthBeats])).toEqual([
      [28, 0.25],
      [28.25, 3.75],
    ]);
    expect(pastLength()).toBe(before + 1);
  });

  it('never resizes into a neighbour less than 1 beat away', () => {
    setDrumClips([drumClip('left', 28, 0.25), drumClip('right', 28.25, 3.75)]);
    render(createElement(ArrangeView));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const handle = screen.getByTestId('clip-left').querySelector('.arrange__clip-resize')!;

    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 10 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 10 + ppb });
    fireEvent.pointerUp(window, { pointerId: 7 });

    const [left, right] = drumClips();
    expect(left!.startBeat + left!.lengthBeats).toBeLessThanOrEqual(right!.startBeat);
    expect(left!.lengthBeats).toBe(0.25);
  });

  it('makes Ctrl+D pressed during a drag its own undo step', () => {
    setDrumClips([drumClip('k', 0, 4)]);
    render(createElement(ArrangeView));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const el = screen.getByTestId('clip-k');
    const before = pastLength();

    fireEvent.pointerDown(el, { button: 0, pointerId: 8, clientX: 10 });
    fireEvent.pointerMove(el, { pointerId: 8, clientX: 10 + 4 * ppb });
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    fireEvent.pointerMove(el, { pointerId: 8, clientX: 10 + 12 * ppb });
    fireEvent.pointerUp(window, { pointerId: 8 });

    expect(drumClips().map((c) => c.startBeat).sort((a, b) => a - b)).toEqual([4, 8]);
    expect(pastLength()).toBe(before + 2);
    act(() => useStore.getState().undo());
    expect(drumClips().map((c) => c.startBeat)).toEqual([4]);
  });

  it('selects a focused clip with Enter or Space so Delete acts on it', () => {
    setDrumClips([drumClip('a', 0, 4), drumClip('b', 8, 4)]);
    select(drumClips()[0]!);
    render(createElement(ArrangeView));

    fireEvent.keyDown(screen.getByTestId('clip-b'), { key: 'Enter' });
    expect(useStore.getState().editor.selectedClipId).toBe('b');
    fireEvent.keyDown(screen.getByTestId('clip-a'), { key: ' ' });
    expect(useStore.getState().editor.selectedClipId).toBe('a');
    fireEvent.keyDown(screen.getByTestId('clip-b'), { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(drumClips().map((c) => c.id)).toEqual(['a']);
  });
});
