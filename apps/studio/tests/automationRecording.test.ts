import { describe, expect, it, vi } from 'vitest';
import { MemoryProjectRepository } from '@cts/project-persistence';
import type { AutomationTarget, Project } from '@cts/project-model';
import {
  AutomationRecordingCoordinator,
  type AutomationRecordingGraphBridge,
  type AutomationRecordingOwnership,
} from '../src/audio/automationRecording';
import {
  PlaybackController,
  type PlaybackSessionHandlers,
} from '../src/audio/playbackController';
import { createDefaultProject } from '../src/state/defaultProject';
import { createStudioStore } from '../src/state/store';

function trackFixture(project: Project) {
  const track = project.tracks.find((candidate) => candidate.type !== 'master');
  if (!track) throw new Error('non-Master Track fixture missing');
  return track;
}

function masterFixture(project: Project) {
  const track = project.tracks.find((candidate) => candidate.type === 'master');
  if (!track) throw new Error('Master Track fixture missing');
  return track;
}

function trackPairFixture(project: Project) {
  const tracks = project.tracks.filter((candidate) => candidate.type !== 'master');
  if (tracks.length < 2) throw new Error('two non-Master Track fixtures are required');
  return [tracks[0]!, tracks[1]!] as const;
}

function graphBridge(): AutomationRecordingGraphBridge & {
  beginOverride: ReturnType<typeof vi.fn>;
  updateOverride: ReturnType<typeof vi.fn>;
  releaseTouchOverride: ReturnType<typeof vi.fn>;
  resumeOverride: ReturnType<typeof vi.fn>;
} {
  return {
    beginOverride: vi.fn(),
    updateOverride: vi.fn(),
    releaseTouchOverride: vi.fn(),
    resumeOverride: vi.fn(),
  };
}

function ownership(
  project: Project,
  activationId = 'activation-1',
  playbackRequestId = 1,
): AutomationRecordingOwnership {
  return { projectId: project.id, activationId, playbackRequestId };
}

async function settlePlaybackController(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('AutomationRecordingCoordinator', () => {
  it('buffers any number of scheduler-clock samples and adopts one atomic candidate', () => {
    const project = createDefaultProject();
    const track = trackFixture(project);
    const before = JSON.stringify(project);
    const coordinator = new AutomationRecordingCoordinator();
    const graph = graphBridge();
    let beat = 1;
    coordinator.activate(project, 'activation-1');
    expect(coordinator.setTrackMode(
      project,
      'activation-1',
      track.id,
      'touch',
    )).toEqual({ ok: true, changed: true });
    expect(coordinator.attachPlayback({
      project,
      activationId: 'activation-1',
      playbackRequestId: 1,
      currentBeat: () => beat,
      graph,
      audioRecordingActive: false,
    }).ok).toBe(true);

    const target: AutomationTarget = {
      type: 'track-volume',
      trackId: track.id,
    };
    expect(coordinator.gestureBegin(ownership(project), target, 0.4).ok).toBe(true);
    for (let index = 0; index < 500; index += 1) {
      beat += 0.001;
      expect(coordinator.gestureUpdate(
        ownership(project),
        target,
        0.4 + index / 2_000,
      ).ok).toBe(true);
    }
    beat = 2;
    expect(coordinator.gestureEnd(ownership(project), target).ok).toBe(true);

    expect(JSON.stringify(project)).toBe(before);
    expect(project.automationLanes).toEqual([]);
    const commit = vi.fn((_expected: Project, _next: Project) => true);
    const result = coordinator.punchOut(
      ownership(project),
      project,
      commit,
      3,
    );

    expect(result).toEqual({ ok: true, changed: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toBe(project);
    expect(commit.mock.calls[0]?.[1]).not.toBe(project);
    expect(coordinator.snapshot().passActive).toBe(false);
    expect(graph.releaseTouchOverride).toHaveBeenCalledWith(target, 2);
  });

  it('implements Touch return, Latch hold, and gesture-free Write ownership', () => {
    const project = createDefaultProject();
    const track = trackFixture(project);
    const target: AutomationTarget = {
      type: 'track-pan',
      trackId: track.id,
    };
    let beat = 1;

    const touch = new AutomationRecordingCoordinator();
    const touchGraph = graphBridge();
    touch.activate(project, 'activation-1');
    touch.setTrackMode(project, 'activation-1', track.id, 'touch');
    touch.attachPlayback({
      project,
      activationId: 'activation-1',
      playbackRequestId: 1,
      currentBeat: () => beat,
      graph: touchGraph,
      audioRecordingActive: false,
    });
    touch.gestureBegin(ownership(project), target, -0.25);
    beat = 1.5;
    touch.gestureEnd(ownership(project), target);
    expect(touchGraph.releaseTouchOverride).toHaveBeenCalledWith(target, 1.5);
    expect(touch.snapshot().writingTrackIds).toEqual([]);

    const latch = new AutomationRecordingCoordinator();
    const latchGraph = graphBridge();
    latch.activate(project, 'activation-2');
    latch.setTrackMode(project, 'activation-2', track.id, 'latch');
    latch.attachPlayback({
      project,
      activationId: 'activation-2',
      playbackRequestId: 2,
      currentBeat: () => beat,
      graph: latchGraph,
      audioRecordingActive: false,
    });
    const latchOwner = ownership(project, 'activation-2', 2);
    latch.gestureBegin(latchOwner, target, 0.3);
    latch.gestureEnd(latchOwner, target);
    expect(latchGraph.releaseTouchOverride).not.toHaveBeenCalled();
    expect(latch.snapshot().writingTrackIds).toEqual([track.id]);

    const write = new AutomationRecordingCoordinator();
    const writeGraph = graphBridge();
    write.activate(project, 'activation-3');
    write.setTrackMode(project, 'activation-3', track.id, 'write');
    write.attachPlayback({
      project,
      activationId: 'activation-3',
      playbackRequestId: 3,
      currentBeat: () => 0,
      graph: writeGraph,
      audioRecordingActive: false,
    });
    expect(writeGraph.beginOverride).toHaveBeenCalledTimes(2);
    expect(write.snapshot()).toMatchObject({
      armedTrackIds: [track.id],
      writingTrackIds: [track.id],
      passActive: true,
    });
  });

  it('owns only effective Master output volume in Write and rejects a later Master', () => {
    const baseProject = createDefaultProject();
    const master = masterFixture(baseProject);
    const laterMaster = {
      ...structuredClone(master),
      id: 'later-master-recording',
      name: 'Later Master',
    };
    const project = {
      ...baseProject,
      tracks: [...baseProject.tracks, laterMaster],
    };
    const coordinator = new AutomationRecordingCoordinator();
    const graph = graphBridge();
    coordinator.activate(project, 'activation-1');

    expect(coordinator.snapshot().trackModes[master.id]).toBe('read');
    expect(coordinator.snapshot().trackModes[laterMaster.id]).toBeUndefined();
    expect(coordinator.setTrackMode(
      project,
      'activation-1',
      laterMaster.id,
      'touch',
    )).toMatchObject({ ok: false, code: 'master-protected' });
    expect(coordinator.setTrackMode(
      project,
      'activation-1',
      master.id,
      'write',
    )).toEqual({ ok: true, changed: true });
    expect(coordinator.attachPlayback({
      project,
      activationId: 'activation-1',
      playbackRequestId: 1,
      currentBeat: () => 0,
      graph,
      audioRecordingActive: false,
    })).toEqual({ ok: true, changed: true });

    const masterVolumeTarget = {
      type: 'track-volume',
      trackId: master.id,
    } as const;
    expect(graph.beginOverride).toHaveBeenCalledOnce();
    expect(graph.beginOverride).toHaveBeenCalledWith(
      masterVolumeTarget,
      master.volume,
    );

    const committedProjects: Project[] = [];
    expect(coordinator.punchOut(
      ownership(project),
      project,
      (_expected, next) => {
        committedProjects.push(next);
        return true;
      },
      2,
    )).toEqual({ ok: true, changed: true });
    const committed = committedProjects[0];
    if (!committed) throw new Error('Master Write pass was not committed');
    expect(committed.automationLanes).toEqual([
      expect.objectContaining({ target: masterVolumeTarget }),
    ]);
    expect(
      committed.automationLanes.some(
        (lane) =>
          lane.target.trackId === master.id
          && lane.target.type === 'track-pan',
      ),
    ).toBe(false);
  });

  it('keeps a rejected CAS pass recoverable and rejects stale/resource ownership', () => {
    const project = createDefaultProject();
    const track = trackFixture(project);
    const coordinator = new AutomationRecordingCoordinator();
    coordinator.activate(project, 'activation-1');
    coordinator.setTrackMode(project, 'activation-1', track.id, 'write');
    expect(coordinator.attachPlayback({
      project,
      activationId: 'activation-1',
      playbackRequestId: 1,
      currentBeat: () => 1,
      graph: graphBridge(),
      audioRecordingActive: true,
    })).toMatchObject({ ok: false, code: 'audio-recording-conflict' });
    expect(project.automationLanes).toEqual([]);

    expect(coordinator.attachPlayback({
      project,
      activationId: 'activation-1',
      playbackRequestId: 1,
      currentBeat: () => 1,
      graph: graphBridge(),
      audioRecordingActive: false,
    }).ok).toBe(true);
    expect(coordinator.punchOut(
      ownership(project, 'activation-1', 999),
      project,
      () => true,
      2,
    )).toMatchObject({ ok: false, code: 'stale-playback' });
    expect(coordinator.punchOut(
      ownership(project),
      project,
      () => false,
      2,
    )).toMatchObject({ ok: false, code: 'commit-rejected' });
    expect(coordinator.snapshot()).toMatchObject({
      passActive: true,
      status: { code: 'commit-rejected' },
    });
    expect(project.automationLanes).toEqual([]);
  });

  it('resets every runtime mode and buffer on project activation', () => {
    const first = createDefaultProject();
    const track = trackFixture(first);
    const coordinator = new AutomationRecordingCoordinator();
    const graph = graphBridge();
    coordinator.activate(first, 'activation-1');
    coordinator.setTrackMode(first, 'activation-1', track.id, 'write');
    coordinator.attachPlayback({
      project: first,
      activationId: 'activation-1',
      playbackRequestId: 1,
      currentBeat: () => 0,
      graph,
      audioRecordingActive: false,
    });

    const second = { ...createDefaultProject(), id: 'second-project' };
    coordinator.activate(second, 'activation-2');
    expect(coordinator.snapshot()).toMatchObject({
      passActive: false,
      armedTrackIds: [],
      writingTrackIds: [],
      touchingTargetKeys: [],
      ownership: null,
      status: null,
    });
    expect(Object.values(coordinator.snapshot().trackModes))
      .toEqual(expect.arrayContaining(['read']));
    expect(new Set(Object.values(coordinator.snapshot().trackModes)))
      .toEqual(new Set(['read']));
    expect(graph.resumeOverride).toHaveBeenCalledTimes(2);
  });

  it('rolls back a partial Write graph allocation failure without owning a pass', () => {
    const project = createDefaultProject();
    const track = trackFixture(project);
    const coordinator = new AutomationRecordingCoordinator();
    const graph = graphBridge();
    graph.beginOverride
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('AudioParam is unavailable');
      });
    coordinator.activate(project, 'activation-1');
    coordinator.setTrackMode(project, 'activation-1', track.id, 'write');
    const before = JSON.stringify(project);

    const result = coordinator.attachPlayback({
      project,
      activationId: 'activation-1',
      playbackRequestId: 1,
      currentBeat: () => 0,
      graph,
      audioRecordingActive: false,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'unexpected',
      message: expect.stringContaining('プロジェクトは変更されていません'),
    });
    expect(coordinator.snapshot()).toMatchObject({
      passActive: false,
      ownership: null,
      writingTrackIds: [],
      touchingTargetKeys: [],
      status: { code: 'unexpected' },
    });
    expect(graph.resumeOverride).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('Studio automation pass commit', () => {
  it('finalizes a runtime interruption at the live scheduler beat before session detach', async () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(track.id, 'write')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let schedulerBeat = 1;
    let callbacks!: PlaybackSessionHandlers;
    let runtimeOwnership!: AutomationRecordingOwnership;
    const order: string[] = [];
    const session = {
      dispose: vi.fn(() => {
        order.push('dispose');
        store.getState().detachAutomationPlaybackRuntime(runtimeOwnership);
      }),
    };
    const controller = new PlaybackController<typeof session>({
      getRequestState: () => ({
        phase: store.getState().transport.phase,
        requestId: store.getState().transport.playbackRequestId,
      }),
      createSession: async (candidateRequestId, handlers) => {
        callbacks = handlers;
        expect(store.getState().attachAutomationPlaybackRuntime(
          candidateRequestId,
          () => schedulerBeat,
          graphBridge(),
        )).toBe(true);
        const attached = store.getState().automationRecording.ownership;
        if (!attached) throw new Error('automation playback ownership was not attached');
        runtimeOwnership = attached;
        return session;
      },
      confirmStarted: (candidateRequestId) => {
        store.getState().confirmPlaybackStarted(candidateRequestId);
      },
      failStart: (candidateRequestId) => {
        store.getState().failPlaybackStart(candidateRequestId);
      },
      finish: (candidateRequestId) => {
        store.getState().finishPlayback(candidateRequestId);
      },
      interrupt: (candidateRequestId) => {
        order.push('interrupt-start');
        store.getState().interruptPlayback(candidateRequestId);
        order.push('interrupt-complete');
      },
    });

    controller.reconcile();
    await settlePlaybackController();
    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });
    expect(store.getState().automationRecording.passActive).toBe(true);
    const revisionBefore = store.getState().saveState.revision;

    schedulerBeat = 4;
    store.setState({ projectOperationBusy: true });
    callbacks.onInterrupted();

    expect(order).toEqual(['interrupt-start', 'interrupt-complete']);
    expect(session.dispose).not.toHaveBeenCalled();
    expect(store.getState().automationRecording).toMatchObject({
      passActive: true,
      status: { code: 'commit-rejected' },
    });
    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });
    expect(store.getState().saveState.revision).toBe(revisionBefore);

    store.setState({ projectOperationBusy: false });
    callbacks.onInterrupted();

    expect(order).toEqual([
      'interrupt-start',
      'interrupt-complete',
      'interrupt-start',
      'interrupt-complete',
      'dispose',
    ]);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(store.getState().automationRecording.passActive).toBe(false);
    expect(store.getState().saveState.revision).toBe(revisionBefore + 1);
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      playbackRequestId: requestId + 1,
      audioIssue: 'interrupted',
    });
    expect(store.getState().project.automationLanes).toHaveLength(2);
    for (const lane of store.getState().project.automationLanes) {
      expect(lane.points.some((point) => point.beat === 4)).toBe(true);
    }

    callbacks.onInterrupted();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(store.getState().saveState.revision).toBe(revisionBefore + 1);
  });

  it('keeps Project/history/revision stable while sampling and commits one revision on stop', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(track.id, 'touch')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let beat = 1;
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => beat,
      graphBridge(),
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);

    const target: AutomationTarget = {
      type: 'track-volume',
      trackId: track.id,
    };
    const projectBefore = store.getState().project;
    const pastBefore = store.getState().past.length;
    const revisionBefore = store.getState().saveState.revision;
    const savePhaseBefore = store.getState().saveState.phase;
    expect(store.getState().beginAutomationGesture(target, 0.5)).toBe(true);
    for (let index = 0; index < 250; index += 1) {
      beat += 0.002;
      expect(store.getState().updateAutomationGesture(
        target,
        0.5 + index / 1_000,
      )).toBe(true);
    }

    expect(store.getState().project).toBe(projectBefore);
    expect(store.getState().past).toHaveLength(pastBefore);
    expect(store.getState().saveState.revision).toBe(revisionBefore);
    expect(store.getState().saveState.phase).toBe(savePhaseBefore);

    store.getState().stop();
    expect(store.getState().project).not.toBe(projectBefore);
    expect(store.getState().project.automationLanes).toHaveLength(1);
    expect(store.getState().past).toHaveLength(pastBefore + 1);
    expect(store.getState().saveState.revision).toBe(revisionBefore + 1);
    expect(store.getState().automationRecording.passActive).toBe(false);
  });

  it('keeps stopped mixer gestures as ordinary scalar edits', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    const revision = store.getState().saveState.revision;
    expect(store.getState().beginAutomationGesture({
      type: 'track-pan',
      trackId: track.id,
    }, 0.35)).toBe(true);

    expect(
      store.getState().project.tracks.find((candidate) => candidate.id === track.id)?.pan,
    ).toBe(0.35);
    expect(store.getState().project.automationLanes).toEqual([]);
    expect(store.getState().saveState.revision).toBe(revision + 1);
  });

  it('keeps a stopped effective Master fader edit as its base scalar', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const master = masterFixture(store.getState().project);
    const revision = store.getState().saveState.revision;

    store.getState().setTrackVolume(master.id, 0.65);

    expect(
      store.getState().project.tracks.find(
        (candidate) => candidate.id === master.id,
      )?.volume,
    ).toBe(0.65);
    expect(store.getState().project.automationLanes).toEqual([]);
    expect(store.getState().saveState.revision).toBe(revision + 1);
    expect(store.getState().beginAutomationGesture({
      type: 'track-pan',
      trackId: master.id,
    }, 0.25)).toBe(false);
  });

  it('rejects unsupported automation modes without finalizing an active pass', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    const master = masterFixture(store.getState().project);
    const laterMaster = {
      ...structuredClone(master),
      id: 'later-master-mode-fail-fast',
      name: 'Later Master',
    };
    expect(store.getState().applyProjectChange((project) => ({
      ...project,
      tracks: [...project.tracks, laterMaster],
    }))).toBe(true);
    expect(store.getState().setTrackAutomationMode(track.id, 'touch')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    const graph = graphBridge();
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => 1,
      graph,
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);
    expect(store.getState().beginAutomationGesture({
      type: 'track-volume',
      trackId: track.id,
    }, 0.45)).toBe(true);

    const before = store.getState();
    expect(before.automationRecording.passActive).toBe(true);
    for (const invalidTrackId of [laterMaster.id, 'missing-master-id']) {
      expect(store.getState().setTrackAutomationMode(
        invalidTrackId,
        'touch',
      )).toBe(false);
      const after = store.getState();
      expect(after.project).toBe(before.project);
      expect(after.past).toBe(before.past);
      expect(after.saveState.revision).toBe(before.saveState.revision);
      expect(after.transport).toBe(before.transport);
      expect(after.automationRecording).toBe(before.automationRecording);
      expect(after.automationRecording.passActive).toBe(true);
      expect(graph.resumeOverride).not.toHaveBeenCalled();
    }

    expect(store.getState().endAutomationGesture({
      type: 'track-volume',
      trackId: track.id,
    })).toBe(true);
    store.getState().stop();
  });

  it('keeps playing Read mixer changes as ordinary scalar edits', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    const graph = graphBridge();
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => 1,
      graph,
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);
    expect(store.getState().transport.phase).toBe('playing');

    const pastBefore = store.getState().past.length;
    const revisionBefore = store.getState().saveState.revision;
    store.getState().setTrackVolume(track.id, 0.42);
    store.getState().setTrackPan(track.id, -0.2);

    const updated = store.getState().project.tracks.find(
      (candidate) => candidate.id === track.id,
    );
    expect(updated).toMatchObject({ volume: 0.42, pan: -0.2 });
    expect(store.getState().past).toHaveLength(pastBefore + 2);
    expect(store.getState().saveState.revision).toBe(revisionBefore + 2);
    expect(store.getState().automationRecording).toMatchObject({
      passActive: false,
      touchingTargetKeys: [],
      writingTrackIds: [],
    });
    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });
    expect(graph.beginOverride).not.toHaveBeenCalled();
    expect(graph.updateOverride).not.toHaveBeenCalled();
    expect(graph.releaseTouchOverride).not.toHaveBeenCalled();
    expect(graph.resumeOverride).not.toHaveBeenCalled();
    expect(store.getState().project.automationLanes).toEqual([]);
  });

  it.each(['touch', 'latch', 'write'] as const)(
    'keeps %s mixer changes scalar until playback is confirmed',
    (mode) => {
      const store = createStudioStore(new MemoryProjectRepository());
      const track = trackFixture(store.getState().project);
      expect(store.getState().setTrackAutomationMode(track.id, mode)).toBe(true);
      store.getState().play();
      const requestId = store.getState().transport.playbackRequestId;
      expect(store.getState().transport.phase).toBe('starting');

      const revisionBefore = store.getState().saveState.revision;
      store.getState().setTrackVolume(track.id, 0.42);
      store.getState().setTrackPan(track.id, -0.2);

      const updated = store.getState().project.tracks.find(
        (candidate) => candidate.id === track.id,
      );
      expect(updated).toMatchObject({ volume: 0.42, pan: -0.2 });
      expect(store.getState().saveState.revision).toBe(revisionBefore + 2);
      expect(store.getState().automationRecording).toMatchObject({
        passActive: false,
        touchingTargetKeys: [],
        writingTrackIds: [],
      });
      expect(store.getState().transport).toMatchObject({
        phase: 'starting',
        playbackRequestId: requestId,
      });
      expect(store.getState().project.automationLanes).toEqual([]);
    },
  );

  it('rebases a Read Track scalar through another Track Touch pass without loss', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const [writingTrack, readTrack] = trackPairFixture(store.getState().project);
    expect(store.getState().applyProjectChange((project) => ({
      ...project,
      automationLanes: [{
        id: 'existing-writing-volume',
        bypassed: false,
        target: { type: 'track-volume', trackId: writingTrack.id },
        points: [{
          id: 'existing-writing-volume-point',
          beat: 0,
          value: writingTrack.volume,
          interpolation: 'hold',
        }],
      }],
    }))).toBe(true);
    expect(store.getState().setTrackAutomationMode(
      writingTrack.id,
      'touch',
    )).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let beat = 1;
    const graph = graphBridge();
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => beat,
      graph,
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);

    const revisionBefore = store.getState().saveState.revision;
    const pastBefore = store.getState().past.length;
    const readVolumeBefore = readTrack.volume;
    expect(store.getState().beginAutomationGesture({
      type: 'track-pan',
      trackId: writingTrack.id,
    }, 0.25)).toBe(true);
    store.getState().setTrackVolume(readTrack.id, 0.55);

    expect(
      store.getState().project.tracks.find(
        (candidate) => candidate.id === readTrack.id,
      )?.volume,
    ).toBe(0.55);
    expect(store.getState().saveState.revision).toBe(revisionBefore + 1);
    expect(store.getState().past).toHaveLength(pastBefore + 1);
    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });
    expect(store.getState().automationRecording).toMatchObject({
      passActive: true,
      touchingTargetKeys: [`${writingTrack.id}:track-pan`],
    });
    expect(store.getState().automationReadScalarCommit).toEqual({
      playbackRequestId: requestId,
      targets: [{ type: 'track-volume', trackId: readTrack.id }],
    });
    expect(graph.resumeOverride).not.toHaveBeenCalled();

    beat = 2;
    expect(store.getState().endAutomationGesture({
      type: 'track-pan',
      trackId: writingTrack.id,
    })).toBe(true);
    store.getState().stop();

    expect(store.getState().transport.phase).toBe('stopped');
    expect(store.getState().automationRecording.status).toBeNull();
    expect(store.getState().project.automationLanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: { type: 'track-volume', trackId: writingTrack.id },
        }),
        expect.objectContaining({
          target: { type: 'track-pan', trackId: writingTrack.id },
        }),
      ]),
    );
    expect(
      store.getState().project.tracks.find(
        (candidate) => candidate.id === readTrack.id,
      )?.volume,
    ).toBe(0.55);
    expect(store.getState().saveState.revision).toBe(revisionBefore + 2);
    expect(store.getState().past).toHaveLength(pastBefore + 2);

    store.getState().undo();
    expect(store.getState().project.automationLanes).toHaveLength(1);
    expect(
      store.getState().project.tracks.find(
        (candidate) => candidate.id === readTrack.id,
      )?.volume,
    ).toBe(0.55);
    store.getState().undo();
    expect(
      store.getState().project.tracks.find(
        (candidate) => candidate.id === readTrack.id,
      )?.volume,
    ).toBe(readVolumeBefore);
  });

  it('rebases a playing Read Master scalar through another Track Touch pass', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const writingTrack = trackFixture(store.getState().project);
    const master = masterFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(
      writingTrack.id,
      'touch',
    )).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let beat = 1;
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => beat,
      graphBridge(),
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);
    expect(store.getState().beginAutomationGesture({
      type: 'track-pan',
      trackId: writingTrack.id,
    }, 0.2)).toBe(true);

    store.getState().setTrackVolume(master.id, 0.55);

    expect(store.getState().automationReadScalarCommit).toEqual({
      playbackRequestId: requestId,
      targets: [{ type: 'track-volume', trackId: master.id }],
    });
    expect(store.getState().automationRecording.passActive).toBe(true);
    expect(
      store.getState().project.tracks.find(
        (candidate) => candidate.id === master.id,
      )?.volume,
    ).toBe(0.55);

    beat = 2;
    expect(store.getState().endAutomationGesture({
      type: 'track-pan',
      trackId: writingTrack.id,
    })).toBe(true);
    store.getState().stop();
    expect(
      store.getState().project.tracks.find(
        (candidate) => candidate.id === master.id,
      )?.volume,
    ).toBe(0.55);
  });

  it('keeps Write graph ownership continuous across a Read scalar commit', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const [writingTrack, readTrack] = trackPairFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(
      writingTrack.id,
      'write',
    )).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let beat = 1;
    const graph = graphBridge();
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => beat,
      graph,
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);
    const revisionBefore = store.getState().saveState.revision;

    expect(graph.beginOverride).toHaveBeenCalledTimes(2);
    store.getState().setTrackPan(readTrack.id, -0.35);
    expect(graph.beginOverride).toHaveBeenCalledTimes(2);
    expect(graph.resumeOverride).not.toHaveBeenCalled();
    expect(store.getState().automationRecording).toMatchObject({
      passActive: true,
      writingTrackIds: [writingTrack.id],
    });
    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });

    beat = 2;
    store.getState().stop();
    expect(graph.resumeOverride).toHaveBeenCalledTimes(2);
    expect(
      store.getState().project.tracks.find(
        (candidate) => candidate.id === readTrack.id,
      )?.pan,
    ).toBe(-0.35);
    expect(store.getState().project.automationLanes.filter((lane) =>
      lane.target.trackId === writingTrack.id)).toHaveLength(2);
    expect(store.getState().saveState.revision).toBe(revisionBefore + 2);
  });

  it('rejects busy or unrelated Project edits without invalidating an active pass', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const [writingTrack, readTrack] = trackPairFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(
      writingTrack.id,
      'touch',
    )).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    const graph = graphBridge();
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => 1,
      graph,
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);
    const before = store.getState();

    store.setState({ projectOperationBusy: true });
    store.getState().setTrackVolume(readTrack.id, 0.5);
    store.setState({ projectOperationBusy: false });
    expect(store.getState().project).toBe(before.project);
    expect(store.getState().past).toBe(before.past);
    expect(store.getState().saveState.revision).toBe(before.saveState.revision);
    expect(store.getState().automationRecording.passActive).toBe(true);

    expect(store.getState().applyProjectChange((project) => ({
      ...project,
      title: 'must be rejected during capture',
    }))).toBe(false);
    expect(store.getState().project).toBe(before.project);
    expect(store.getState().automationRecording.passActive).toBe(true);

    store.getState().setTrackVolume(readTrack.id, 0.5);
    expect(
      store.getState().project.tracks.find(
        (candidate) => candidate.id === readTrack.id,
      )?.volume,
    ).toBe(0.5);
    expect(store.getState().automationRecording.passActive).toBe(true);
    store.getState().stop();
    expect(store.getState().transport.phase).toBe('stopped');
  });

  it('routes live mixer volume and pan changes into one buffered Touch pass', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(track.id, 'touch')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let beat = 1;
    const graph = graphBridge();
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => beat,
      graph,
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);

    const projectBefore = store.getState().project;
    const pastBefore = store.getState().past.length;
    const revisionBefore = store.getState().saveState.revision;
    store.getState().setTrackVolume(track.id, 0.42);
    beat = 1.25;
    store.getState().setTrackVolume(track.id, 0.48);
    beat = 1.4;
    store.getState().setTrackVolume(track.id, track.volume);
    store.getState().setTrackPan(track.id, -0.2);

    expect(store.getState().project).toBe(projectBefore);
    expect(store.getState().past).toHaveLength(pastBefore);
    expect(store.getState().saveState.revision).toBe(revisionBefore);
    expect(store.getState().automationRecording.touchingTargetKeys).toEqual([
      `${track.id}:track-volume`,
      `${track.id}:track-pan`,
    ]);
    expect(graph.beginOverride).toHaveBeenCalledTimes(2);
    expect(graph.updateOverride).toHaveBeenCalledWith({
      type: 'track-volume',
      trackId: track.id,
    }, track.volume);

    beat = 1.5;
    expect(store.getState().endAutomationGesture({
      type: 'track-volume',
      trackId: track.id,
    })).toBe(true);
    expect(store.getState().endAutomationGesture({
      type: 'track-pan',
      trackId: track.id,
    })).toBe(true);
    store.getState().stop();

    expect(store.getState().project.automationLanes).toHaveLength(2);
    expect(store.getState().past).toHaveLength(pastBefore + 1);
    expect(store.getState().saveState.revision).toBe(revisionBefore + 1);
  });

  it('routes a playing Master fader through one volume-only Touch pass', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const master = masterFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(master.id, 'touch')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let beat = 1;
    const graph = graphBridge();
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => beat,
      graph,
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);

    store.getState().setTrackVolume(master.id, 0.42);
    beat = 1.25;
    store.getState().setTrackVolume(master.id, 0.48);
    expect(store.getState().automationRecording.touchingTargetKeys).toEqual([
      `${master.id}:track-volume`,
    ]);
    expect(graph.beginOverride).toHaveBeenCalledWith({
      type: 'track-volume',
      trackId: master.id,
    }, 0.42);

    beat = 1.5;
    expect(store.getState().endAutomationGesture({
      type: 'track-volume',
      trackId: master.id,
    })).toBe(true);
    store.getState().stop();

    expect(store.getState().project.automationLanes).toEqual([
      expect.objectContaining({
        target: { type: 'track-volume', trackId: master.id },
      }),
    ]);
    expect(store.getState().project.automationLanes.some(
      (lane) =>
        lane.target.trackId === master.id
        && lane.target.type === 'track-pan',
    )).toBe(false);
  });

  it('ends every live Touch target through the production release action', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(track.id, 'touch')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    const graph = graphBridge();
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => 1,
      graph,
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);

    store.getState().setTrackVolume(track.id, 0.45);
    store.getState().setTrackPan(track.id, -0.25);
    expect(store.getState().automationRecording.touchingTargetKeys).toHaveLength(2);

    expect(store.getState().endActiveAutomationGestures()).toBe(true);
    expect(store.getState().automationRecording.touchingTargetKeys).toEqual([]);
    expect(store.getState().automationRecording.writingTrackIds).toEqual([]);
    expect(graph.releaseTouchOverride).toHaveBeenCalledTimes(2);
  });

  it('keeps Store history, revision, and save state atomic on graph resource failure', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(track.id, 'write')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    const graph = graphBridge();
    graph.beginOverride
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('AudioParam allocation failed');
      });
    const before = store.getState();

    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => 1,
      graph,
    )).toBe(false);
    const after = store.getState();
    expect(after.project).toBe(before.project);
    expect(after.past).toBe(before.past);
    expect(after.future).toBe(before.future);
    expect(after.saveState).toBe(before.saveState);
    expect(after.automationRecording).toMatchObject({
      passActive: false,
      ownership: null,
      status: { code: 'unexpected' },
    });
  });

  it.each([
    ['stop', (store: ReturnType<typeof createStudioStore>) => store.getState().stop()],
    ['seek', (store: ReturnType<typeof createStudioStore>) => store.getState().setPosition(8)],
    ['interrupt', (store: ReturnType<typeof createStudioStore>) => {
      const requestId = store.getState().transport.playbackRequestId;
      store.getState().interruptPlayback(requestId, 'interrupted');
    }],
    ['natural end', (store: ReturnType<typeof createStudioStore>) => {
      const requestId = store.getState().transport.playbackRequestId;
      store.getState().finishPlayback(requestId);
    }],
    ['loop range', (store: ReturnType<typeof createStudioStore>) => {
      expect(store.getState().setLoopRange(2, 6)).toBe(false);
    }],
    ['loop toggle', (store: ReturnType<typeof createStudioStore>) => {
      store.getState().toggleLoop();
    }],
  ])('keeps transport ownership recoverable when %s finalization is rejected', (
    _boundary,
    crossBoundary,
  ) => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
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
    const transportBefore = store.getState().transport;

    beat = 2;
    store.setState({ projectOperationBusy: true });
    crossBoundary(store);

    expect(store.getState().project).toBe(projectBefore);
    expect(store.getState().automationRecording).toMatchObject({
      passActive: true,
      status: { code: 'commit-rejected' },
    });
    expect(store.getState().transport).toBe(transportBefore);
    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      isPlaying: true,
      playbackRequestId: requestId,
      positionBeat: transportBefore.positionBeat,
    });

    store.setState({ projectOperationBusy: false });
    store.getState().stop();
    expect(store.getState().automationRecording.passActive).toBe(false);
    expect(store.getState().transport.phase).toBe('stopped');
    expect(store.getState().project.automationLanes).toHaveLength(2);
  });

  it('punches out once at the half-open cycle right locator and keeps playback running', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(track.id, 'write')).toBe(true);
    expect(store.getState().setLoopRange(1, 4)).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => 3.99,
      graphBridge(),
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);
    const revision = store.getState().saveState.revision;

    expect(store.getState().finalizeAutomationRecording(
      'cycle-right-locator',
      4,
    )).toBe(true);
    const once = store.getState().project;
    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });
    expect(store.getState().saveState.revision).toBe(revision + 1);
    expect(once.automationLanes).toHaveLength(2);
    for (const lane of once.automationLanes) {
      expect(lane.points.some((point) => point.beat >= 1 && point.beat < 4))
        .toBe(true);
      expect(lane.points.filter((point) => point.beat === 4)).toHaveLength(1);
    }

    store.getState().updatePlaybackPosition(requestId, 1);
    expect(store.getState().finalizeAutomationRecording(
      'cycle-right-locator',
      4,
    )).toBe(true);
    expect(store.getState().project).toBe(once);
    expect(store.getState().saveState.revision).toBe(revision + 1);
    expect(store.getState().transport.phase).toBe('playing');
  });

  it('keeps a rejected cycle-right pass recoverable and commits it on retry', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
    expect(store.getState().setTrackAutomationMode(track.id, 'write')).toBe(true);
    expect(store.getState().setLoopRange(1, 4)).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => 3.99,
      graphBridge(),
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);
    const projectBefore = store.getState().project;
    const revisionBefore = store.getState().saveState.revision;

    store.setState({ projectOperationBusy: true });
    expect(store.getState().finalizeAutomationRecording(
      'cycle-right-locator',
      4,
    )).toBe(false);
    expect(store.getState().project).toBe(projectBefore);
    expect(store.getState().saveState.revision).toBe(revisionBefore);
    expect(store.getState().automationRecording).toMatchObject({
      passActive: true,
      status: { code: 'commit-rejected' },
    });
    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });

    store.setState({ projectOperationBusy: false });
    expect(store.getState().finalizeAutomationRecording(
      'cycle-right-locator',
      4,
    )).toBe(true);
    expect(store.getState().project.automationLanes).toHaveLength(2);
    expect(store.getState().saveState.revision).toBe(revisionBefore + 1);
    expect(store.getState().automationRecording.passActive).toBe(false);
    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: requestId,
    });
  });

  it('finalizes before the native edit fence and resets modes on the next activation', async () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
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

    expect(store.getState().tryBeginNativeClose()).toBe(true);
    expect(store.getState().automationRecording.passActive).toBe(false);
    expect(store.getState().projectOperationBusy).toBe(true);
    expect(store.getState().project.automationLanes).toHaveLength(2);
    store.getState().cancelNativeClose();

    expect(await store.getState().createNewProject('Next')).toBe(true);
    expect(store.getState().automationRecording).toMatchObject({
      armedTrackIds: [],
      writingTrackIds: [],
      touchingTargetKeys: [],
      passActive: false,
      ownership: null,
    });
    expect(new Set(Object.values(store.getState().automationRecording.trackModes)))
      .toEqual(new Set(['read']));
  });

  it('finalizes the old pass once at project activation and opens the new project in Read', async () => {
    const repository = new MemoryProjectRepository();
    const store = createStudioStore(repository);
    const originalProject = store.getState().project;
    const track = trackFixture(originalProject);
    const graph = graphBridge();
    expect(store.getState().setTrackAutomationMode(track.id, 'write')).toBe(true);
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    let beat = 1;
    expect(store.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => beat,
      graph,
    )).toBe(true);
    store.getState().confirmPlaybackStarted(requestId);
    beat = 2;

    await expect(store.getState().createNewProject('Activated project'))
      .resolves.toBe(true);

    const activated = store.getState();
    expect(activated.project.id).not.toBe(originalProject.id);
    expect(activated.automationRecording).toMatchObject({
      armedTrackIds: [],
      writingTrackIds: [],
      touchingTargetKeys: [],
      passActive: false,
      ownership: null,
      status: null,
    });
    expect(new Set(Object.values(activated.automationRecording.trackModes)))
      .toEqual(new Set(['read']));
    expect(graph.resumeOverride).toHaveBeenCalledTimes(2);

    const savedOriginal = await repository.load(originalProject.id);
    expect(savedOriginal.ok).toBe(true);
    if (!savedOriginal.ok || !savedOriginal.value) {
      throw new Error('finalized original project was not saved');
    }
    expect(savedOriginal.value.project.automationLanes).toHaveLength(2);
  });

  it('punches out on an active mode change and keeps the result undoable/redoable', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = trackFixture(store.getState().project);
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

    expect(store.getState().setTrackAutomationMode(track.id, 'read')).toBe(true);
    expect(store.getState().automationRecording).toMatchObject({
      passActive: false,
      armedTrackIds: [],
    });
    expect(store.getState().project.automationLanes).toHaveLength(2);

    store.getState().undo();
    expect(store.getState().project.automationLanes).toEqual([]);
    store.getState().redo();
    expect(store.getState().project.automationLanes).toHaveLength(2);
  });
});
