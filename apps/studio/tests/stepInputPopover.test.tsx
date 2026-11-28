// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];
let step: typeof import('../src/state/stepInput');

beforeAll(async () => {
  Object.defineProperty(navigator, 'locks', {
    value: { request: async (_n: string, _o: unknown, cb: () => unknown) => cb() },
    configurable: true,
  });
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
  step = await import('../src/state/stepInput');
});

beforeEach(async () => {
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
  expect(await useStore.getState().createNewProject('ステップ')).toBe(true);
  step.stopStepInput();
});

afterEach(async () => {
  cleanup();
  step.stopStepInput();
  await useStore.getState().flushPendingSave();
});

it('clicking a piano key inserts at the cursor; Enter rests and Backspace steps back only while on', () => {
  const state = useStore.getState();
  const clip = state.project.tracks.find((t) => t.name === 'Melody')!.clips[0]!;
  state.selectClip(clip.id);
  state.setActiveView('pianoRoll');
  const count = () => (useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)?.notes ?? []).length;
  const before = count();
  const { container } = render(<PianoRoll />);
  const key = container.querySelector('.pr__key[data-midi="72"]')!;

  // Off: Backspace does nothing to step state; a key click does not insert.
  fireEvent.pointerDown(key, { button: 0 });
  expect(count()).toBe(before);

  fireEvent.click(screen.getByRole('button', { name: /ゆらぎ/ }));
  fireEvent.click(screen.getByRole('button', { name: 'ステップ入力を始める' }));
  fireEvent.pointerDown(key, { button: 0 });
  expect(count()).toBe(before + 1);
  expect(container.querySelector('[data-testid="step-cursor"]')).not.toBeNull();

  fireEvent.keyDown(window, { key: 'Enter' });
  expect(step.useStepInput.getState().cursorTicks).toBe(480);
  fireEvent.keyDown(window, { key: 'Backspace' });
  fireEvent.keyDown(window, { key: 'Backspace' });
  expect(count()).toBe(before);
  expect(step.useStepInput.getState().cursorTicks).toBe(0);

  // AltGr (Ctrl+Alt) must not trigger a rest.
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, altKey: true });
  expect(step.useStepInput.getState().cursorTicks).toBe(0);
});

it('Enter dispatched on the focused toolbar button rests instead of re-activating it', () => {
  const state = useStore.getState();
  const clip = state.project.tracks.find((t) => t.name === 'Melody')!.clips[0]!;
  state.selectClip(clip.id);
  state.setActiveView('pianoRoll');
  render(<PianoRoll />);
  fireEvent.click(screen.getByRole('button', { name: /ゆらぎ/ }));
  const start = screen.getByRole('button', { name: 'ステップ入力を始める' });
  fireEvent.click(start);
  expect(step.useStepInput.getState().active).toBe(true);
  start.focus();
  fireEvent.keyDown(document.activeElement ?? start, { key: 'Enter' });
  expect(step.useStepInput.getState().active).toBe(true);
  expect(step.useStepInput.getState().cursorTicks).toBe(240);
});
