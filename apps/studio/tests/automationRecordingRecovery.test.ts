import { describe, expect, it, vi } from 'vitest';
import type { AutomationRecordingGraphBridge } from '../src/audio/automationRecording';
import { MemoryProjectRepository } from '@cts/project-persistence';
import { createStudioStore } from '../src/state/store';

function graphBridge(): AutomationRecordingGraphBridge {
  return {
    beginOverride: vi.fn(),
    updateOverride: vi.fn(),
    releaseTouchOverride: vi.fn(),
    resumeOverride: vi.fn(),
  };
}

describe('automation recording recovery', () => {
  it('falls Write back to Touch inside the successful pass transaction', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = store
      .getState()
      .project.tracks.find((candidate) => candidate.type !== 'master');
    if (!track) throw new Error('non-Master Track fixture missing');

    expect(store.getState().setTrackAutomationMode(track.id, 'write')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let beat = 1;
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => beat,
      graphBridge(),
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);

    beat = 2;
    store.getState().stop();

    expect(store.getState().project.automationLanes).toHaveLength(2);
    expect(store.getState().automationRecording).toMatchObject({
      passActive: false,
      trackModes: { [track.id]: 'touch' },
    });
  });

  it('can discard a rejected pass and stop without publishing partial points', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = store
      .getState()
      .project.tracks.find((candidate) => candidate.type !== 'master');
    if (!track) throw new Error('non-Master Track fixture missing');

    expect(store.getState().setTrackAutomationMode(track.id, 'write')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let beat = 1;
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => beat,
      graphBridge(),
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);
    const projectBefore = store.getState().project;
    const pastBefore = store.getState().past;
    const revisionBefore = store.getState().saveState.revision;

    beat = 2;
    store.setState({ projectOperationBusy: true });
    store.getState().stop();
    expect(store.getState().automationRecording).toMatchObject({
      passActive: true,
      status: { code: 'commit-rejected' },
    });
    expect(store.getState().transport.phase).toBe('playing');

    expect(store.getState().cancelAutomationRecording()).toBe(true);
    store.getState().stop();

    expect(store.getState().automationRecording).toMatchObject({
      passActive: false,
      ownership: null,
      status: null,
      trackModes: { [track.id]: 'touch' },
    });
    expect(store.getState().transport.phase).toBe('stopped');
    expect(store.getState().project).toBe(projectBefore);
    expect(store.getState().project.automationLanes).toEqual([]);
    expect(store.getState().past).toBe(pastBefore);
    expect(store.getState().saveState.revision).toBe(revisionBefore);
  });
});
