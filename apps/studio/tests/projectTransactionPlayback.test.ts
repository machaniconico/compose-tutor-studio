import { describe, expect, it, vi } from 'vitest';
import { MemoryProjectRepository } from '@cts/project-persistence';
import type { Project } from '@cts/project-model';
import type { AutomationRecordingGraphBridge } from '../src/audio/automationRecording';
import { createStudioStore } from '../src/state/store';

function trackPair(project: Project) {
  const tracks = project.tracks.filter((candidate) => candidate.type !== 'master');
  if (tracks.length < 2) throw new Error('two non-Master Track fixtures are required');
  return [tracks[0]!, tracks[1]!] as const;
}

function graphBridge(): AutomationRecordingGraphBridge {
  return {
    beginOverride: vi.fn(),
    updateOverride: vi.fn(),
    releaseTouchOverride: vi.fn(),
    resumeOverride: vi.fn(),
  };
}

/** Play with an automation lane on `laneTrack`; optionally a Touch pass on it. */
function playingStore(touchPass: boolean) {
  const store = createStudioStore(new MemoryProjectRepository());
  const [laneTrack, readTrack] = trackPair(store.getState().project);
  expect(store.getState().applyProjectChange((project) => ({
    ...project,
    automationLanes: [{
      id: 'lane-volume',
      bypassed: false,
      target: { type: 'track-volume', trackId: laneTrack.id },
      points: [{ id: 'lane-point', beat: 0, value: laneTrack.volume, interpolation: 'hold' }],
    }],
  }))).toBe(true);
  if (touchPass) {
    expect(store.getState().setTrackAutomationMode(laneTrack.id, 'touch')).toBe(true);
  }
  store.getState().play();
  const requestId = store.getState().transport.playbackRequestId;
  expect(store.getState().attachAutomationPlaybackRuntime(requestId, () => 1, graphBridge()))
    .toBe(true);
  store.getState().confirmPlaybackStarted(requestId);
  expect(store.getState().automationRecording.passActive).toBe(touchPass);
  const volumeOf = () =>
    store.getState().project.tracks.find((t) => t.id === readTrack.id)?.volume;
  return { store, readTrack, requestId, volumeOf };
}

describe('gesture transactions during playback', () => {
  it('refuses a transaction during a Touch pass and keeps ordinary Read edits available', () => {
    const { store, readTrack, requestId, volumeOf } = playingStore(true);
    const before = store.getState();
    const token = {};
    expect(before.beginProjectTransaction(token, 1)).toBe(false);
    expect(store.getState().cancelProjectTransaction(token)).toBe(false);
    expect(store.getState().project).toBe(before.project);
    expect(store.getState().past).toBe(before.past);
    expect(store.getState().saveState.revision).toBe(before.saveState.revision);
    expect(store.getState().transport).toMatchObject({ phase: 'playing', playbackRequestId: requestId });
    expect(store.getState().automationRecording.passActive).toBe(true);

    // A normal Read edit (for example, by keyboard) still rebases the pass.
    store.getState().setTrackVolume(readTrack.id, 0.7);
    expect(volumeOf()).toBe(0.7);
    expect(store.getState().past).toHaveLength(before.past.length + 1);
  });

  it('commits an already-open fader drag before starting a Touch pass', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const [touchTrack, readTrack] = trackPair(store.getState().project);
    expect(store.getState().setTrackAutomationMode(touchTrack.id, 'touch')).toBe(true);
    const before = store.getState();
    const token = {};
    expect(before.beginProjectTransaction(token, 1)).toBe(true);
    store.getState().setTrackVolume(readTrack.id, 0.4);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    expect(store.getState().attachAutomationPlaybackRuntime(requestId, () => 1, graphBridge()))
      .toBe(true);

    const state = store.getState();
    expect(state.automationRecording.passActive).toBe(true);
    expect(state.isProjectTransactionOpen()).toBe(false);
    expect(state.committedProject()).toBe(state.project);
    expect(state.past.slice(-1)).toEqual([before.project]);
    expect(state.saveState.revision).toBe(before.saveState.revision + 1);
    expect(state.cancelProjectTransaction(token)).toBe(false);
  });

  it('cancel never stops playback (automation lane present, no pass)', () => {
    const { store, readTrack, requestId, volumeOf } = playingStore(false);
    const owner = {};
    expect(store.getState().beginProjectTransaction(owner, 1)).toBe(true);
    store.getState().setTrackVolume(readTrack.id, 0.4);
    expect(store.getState().transport.phase).toBe('playing');
    expect(store.getState().cancelProjectTransaction(owner)).toBe(true);

    expect(volumeOf()).toBe(readTrack.volume);
    expect(store.getState().transport).toMatchObject({ phase: 'playing', playbackRequestId: requestId });
  });
});

describe('committed project while a gesture is open', () => {
  it('committedProject is the pre-gesture project until commit', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const [track] = trackPair(store.getState().project);
    const before = store.getState().project;
    const owner = {};
    expect(store.getState().committedProject()).toBe(before);
    store.getState().beginProjectTransaction(owner, 1);
    store.getState().setTrackVolume(track.id, 0.3);
    expect(store.getState().project).not.toBe(before);
    expect(store.getState().committedProject()).toBe(before);
    store.getState().commitProjectTransaction(owner);
    expect(store.getState().committedProject()).toBe(store.getState().project);
  });

  it('only one gesture app-wide: a second begin is refused, even by the same owner', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const owner = {};
    expect(store.getState().beginProjectTransaction(owner, 1)).toBe(true);
    expect(store.getState().beginProjectTransaction(owner, 2)).toBe(false);
    expect(store.getState().beginProjectTransaction({}, 3)).toBe(false);
    expect(store.getState().ownsProjectTransaction(owner, 1)).toBe(true);
    expect(store.getState().ownsProjectTransaction(owner, 2)).toBe(false);
  });
});
