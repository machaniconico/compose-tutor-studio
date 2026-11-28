// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { useStore } from '../src/state/store';
import { makeProject, melodyClip, off, on, options, ticksOf } from './acceptance/p42-helpers';

it('warns before unload and finalizes the take before the synchronous pagehide save', async () => {
  const listeners = vi.spyOn(window as EventTarget, 'addEventListener');
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  await import('../src/main');
  await useStore.getState().initializePersistence();
  await vi.waitFor(() => expect(listeners.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true));
  listeners.mockRestore();
  const project = makeProject({ notes: [{ pitch: 62, startBeat: 2, durationBeats: 0.25 }] });
  expect(await useStore.getState().replaceProject(project)).toBe(true);
  const state = useStore.getState();
  expect(state.startMidiRecording(options(project, { mode: 'replace' }), () => 2).ok).toBe(true);
  state.feedMidiRecording(on(60, 0));
  state.feedMidiRecording(off(60, 0.25));

  const beforeUnload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(beforeUnload);
  expect.soft(beforeUnload.defaultPrevented).toBe(true);
  const flushProject = vi.fn(() => useStore.getState().project);
  useStore.setState({ flushPendingSaveSynchronously: () => {
    flushProject();
    return state.flushPendingSaveSynchronously();
  } });
  window.dispatchEvent(new Event('pagehide'));
  expect(flushProject).toHaveBeenCalledOnce();
  useStore.setState({ flushPendingSaveSynchronously: state.flushPendingSaveSynchronously });
  expect(useStore.getState().midiRecordingActive).toBe(false);
  expect(ticksOf(melodyClip(flushProject.mock.results[0]!.value))).toEqual([
    { pitch: 60, startTick: 0, durTick: 240 }, { pitch: 62, startTick: 960, durTick: 120 },
  ]);
});
