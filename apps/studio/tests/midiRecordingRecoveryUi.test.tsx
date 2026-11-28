// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryProjectRepository } from '@cts/project-persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAudioEngine } from '../src/audio/engine';
import { PcKeyboardPlayer } from '../src/features/input/PcKeyboardPlayer';
import { useStore } from '../src/state/store';
import { makeProject, melodyClip, on, ticksOf } from './acceptance/p42-helpers';

vi.mock('../src/state/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/state/store')>();
  return { ...original, useStore: original.createStudioStore(new MemoryProjectRepository()) };
});

describe('MIDI recording recovery controls', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each(['retry', 'discard'] as const)('can %s a take after a failed stop on unmount', async (action) => {
    const context = { currentTime: 10 };
    vi.spyOn(getAudioEngine(), 'ensureContext').mockResolvedValue({
      context: context as AudioContext, master: {} as GainNode, contextGeneration: 1,
    });
    const project = makeProject();
    const track = project.tracks.find((item) => item.name === 'Melody')!;
    expect(await useStore.getState().replaceProject(project)).toBe(true);
    useStore.setState((state) => ({
      editor: { ...state.editor, selectedTrackId: track.id, selectedClipId: melodyClip(project).id },
    }));
    const view = render(<PcKeyboardPlayer />);
    const toggle = () => fireEvent.click(screen.getByRole('button', { name: 'PC鍵盤で弾く' }));
    toggle();
    fireEvent.click(screen.getByRole('button', { name: 'MIDI 録音' }));
    const stopButton = { name: 'MIDI 録音を停止' };
    await screen.findByRole('button', stopButton);
    const state = useStore.getState();
    state.feedMidiRecording(on(60, 0));
    state.feedMidiRecording(on(62, 0.125));
    context.currentTime = 10.5;
    const invalidProject = { ...project, lengthBars: 0 };
    if (action === 'discard') {
      act(() => useStore.setState({ project: invalidProject }));
    } else {
      act(() => useStore.setState({ projectOperationBusy: true }));
    }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    try {
      view.unmount();
      expect(useStore.getState().midiRecordingActive).toBe(true);
      render(<PcKeyboardPlayer />);
      toggle();
      if (action === 'retry') {
        act(() => useStore.setState({ projectOperationBusy: false }));
        fireEvent.click(screen.getByRole('button', stopButton));
        expect(ticksOf(melodyClip(useStore.getState().project))).toEqual([
          { pitch: 60, startTick: 0, durTick: 480 },
          { pitch: 62, startTick: 120, durTick: 360 },
        ]);
        await act(async () => { expect(await useStore.getState().flushPendingSave()).toBe(true); });
      } else {
        expect(screen.getByRole('status').textContent).toContain('現在のプロジェクトの内容');
        const discard = screen.getByRole('button', { name: 'このテイクを捨てて録音を終える' });
        fireEvent.click(discard);
        expect(useStore.getState().midiRecordingActive).toBe(true);
        fireEvent.click(discard);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(useStore.getState().project).toBe(invalidProject);
      }
      expect(useStore.getState().midiRecordingActive).toBe(false);
    } finally {
      confirm.mockRestore();
      act(() => {
        if (!useStore.getState().midiRecordingActive) return;
        useStore.setState({ project, projectOperationBusy: false });
        state.stopMidiRecording({ timeSec: 0.5 });
      });
    }
  });
});
