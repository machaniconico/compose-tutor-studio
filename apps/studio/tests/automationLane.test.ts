// @vitest-environment jsdom
import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';
import { pxPerBeat } from '../src/features/timeline';

let useStore: typeof import('../src/state/store')['useStore'];
let ArrangeView: typeof import('../src/features/arranger/ArrangeView')['ArrangeView'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ ArrangeView } = await import('../src/features/arranger/ArrangeView'));
});

beforeEach(() => {
  useStore.getState().createNewProject('音量の変化テスト');
});

function openLane() {
  const track = useStore.getState().project.tracks.find((t) => t.type === 'instrument')!;
  render(createElement(ArrangeView));
  const summary = screen.getByLabelText(`${track.name}の音の変化`);
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  expect(screen.queryByRole('button', { name: 'フェードイン' })).toBeNull();
  fireEvent.click(summary);
  fireEvent(details, new Event('toggle'));
  const plot = screen.getByTestId(`automation-plot-${track.id}`);
  const lanes = () => useStore.getState().project.tracks.find((t) => t.id === track.id)?.automation;
  const points = () => lanes()?.volume?.points;
  return { details, summary, plot, points, lanes };
}

it('creates and replaces two fade points in one undo step each', () => {
  const { points, details, summary } = openLane();
  const before = useStore.getState().past.length;
  fireEvent.click(screen.getByRole('button', { name: 'フェードイン' }));
  expect(points()).toEqual([{ beat: 0, value: 0 }, { beat: 4, value: 1 }]);
  expect(useStore.getState().past).toHaveLength(before + 1);
  fireEvent.click(screen.getByRole('button', { name: 'フェードアウト' }));
  const end = useStore.getState().project.lengthBars * 4;
  expect(points()).toEqual([{ beat: end - 4, value: 1 }, { beat: end, value: 0 }]);
  expect(useStore.getState().past).toHaveLength(before + 2);
  act(() => useStore.getState().undo());
  expect(points()).toEqual([{ beat: 0, value: 0 }, { beat: 4, value: 1 }]);
  fireEvent.click(summary);
  fireEvent(details, new Event('toggle'));
  expect(screen.queryByRole('button', { name: 'フェードイン' })).toBeNull();
});

it('adds on click, moves across another point in one undo step, and deletes on double-click', () => {
  const { plot, points } = openLane();
  const ppb = pxPerBeat(useStore.getState().editor.zoomX);
  fireEvent.click(plot, { clientX: ppb, clientY: 40 });
  fireEvent.click(plot, { clientX: 2 * ppb, clientY: 40 });
  expect(points()).toEqual([{ beat: 1, value: 0.5 }, { beat: 2, value: 0.5 }]);
  const first = screen.getByRole('button', { name: '曲の始まりから 1 拍、音量 50%' });
  const previous = useStore.getState().past.length;
  fireEvent.pointerDown(first, { pointerId: 1, button: 0, clientX: ppb, clientY: 40 });
  fireEvent.pointerMove(first, { pointerId: 1, clientX: 2 * ppb, clientY: 30 });
  fireEvent.pointerMove(first, { pointerId: 1, clientX: 3 * ppb, clientY: 12 });
  expect(useStore.getState().past).toHaveLength(previous);
  fireEvent.pointerUp(first, { pointerId: 1, clientX: 3 * ppb, clientY: 12 });
  expect(points()).toEqual([{ beat: 2, value: 0.5 }, { beat: 3, value: 1 }]);
  expect(useStore.getState().past).toHaveLength(previous + 1);
  act(() => useStore.getState().undo());
  expect(points()).toEqual([{ beat: 1, value: 0.5 }, { beat: 2, value: 0.5 }]);
  fireEvent.doubleClick(screen.getByRole('button', { name: '曲の始まりから 1 拍、音量 50%' }));
  expect(points()).toEqual([{ beat: 2, value: 0.5 }]);
});

it('supports adding, adjusting and deleting points with the keyboard', () => {
  const { points } = openLane();
  fireEvent.click(screen.getByRole('button', { name: '再生位置に点を追加' }));
  fireEvent.keyDown(screen.getByRole('button', { name: '曲の始まりから 0 拍、音量 100%' }), { key: 'ArrowRight' });
  expect(points()).toEqual([{ beat: 0.25, value: 1 }]);
  fireEvent.keyDown(screen.getByRole('button', { name: '曲の始まりから 0.25 拍、音量 100%' }), { key: 'Delete' });
  expect(points()).toEqual([]);
});

it('edits and undoes pan and brightness independently of volume', () => {
  const { plot, points, lanes } = openLane();
  const before = useStore.getState().past.length;
  const selector = screen.getByRole('combobox', { name: '変えるもの' });
  fireEvent.click(screen.getByRole('button', { name: 'フェードイン' }));

  fireEvent.change(selector, { target: { value: 'pan' } });
  expect(screen.queryByRole('button', { name: 'フェードイン' })).toBeNull();
  fireEvent.click(plot, { clientX: 0, clientY: 68 });
  expect(lanes()?.pan?.points).toEqual([{ beat: 0, value: -1 }]);

  fireEvent.change(selector, { target: { value: 'cutoff' } });
  fireEvent.click(screen.getByRole('button', { name: '再生位置に点を追加' }));
  expect(lanes()?.cutoff?.points).toEqual([{ beat: 0, value: 1 }]);
  fireEvent.keyDown(screen.getByRole('button', { name: '曲の始まりから 0 拍、明るさ 1 倍' }), { key: 'ArrowUp' });
  expect(lanes()?.cutoff?.points).toEqual([{ beat: 0, value: 1.26 }]);
  expect(useStore.getState().past).toHaveLength(before + 4);

  act(() => useStore.getState().undo());
  expect(lanes()?.cutoff?.points).toEqual([{ beat: 0, value: 1 }]);
  act(() => useStore.getState().undo());
  expect(lanes()?.cutoff).toBeUndefined();
  expect(lanes()?.pan?.points).toEqual([{ beat: 0, value: -1 }]);
  expect(points()).toEqual([{ beat: 0, value: 0 }, { beat: 4, value: 1 }]);
});

it('rejects a drum cutoff edit with a message and preserves the project', async () => {
  const { setTrackAutomation } = await import('../src/state/editorActions');
  const { getBridgeSnapshot } = await import('../src/state/tutorialBridge');
  const before = useStore.getState().project;
  const drums = before.tracks.find((track) => track.type === 'drum')!;
  expect(setTrackAutomation(drums.id, 'cutoff', undefined, { points: [{ beat: 0, value: 1 }] })).toBe(false);
  expect(useStore.getState().project).toBe(before);
  expect(getBridgeSnapshot().toasts.at(-1)?.message).toBe('ドラムトラックには明るさの変化を設定できません。');
});
