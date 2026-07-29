import { describe, expect, it } from 'vitest';
import { MemoryProjectRepository } from '@cts/project-persistence';
import { beatsPerBar } from '@cts/project-model';
import type { AppEvent } from '@cts/tutorial-engine';
import { subscribeAppEvents } from '../src/state/appEvents';
import { createDefaultProject } from '../src/state/defaultProject';
import {
  createStudioStore,
  hasPlaybackTopologyChanged,
} from '../src/state/store';

describe('playback topology changes', () => {
  it('detects track ordering, semantic roles, instrument configuration, and clip layout changes', () => {
    const project = createDefaultProject();
    const [first, second] = project.tracks;
    if (!first || !second || !first.clips[0]) throw new Error('track fixture missing');

    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      tracks: [second, first, ...project.tracks.slice(2)],
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      bpm: 90,
      tempoMap: project.tempoMap.map((event, index) =>
        index === 0 ? { ...event, bpm: 90 } : event,
      ),
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      tracks: project.tracks.map((track, index) =>
        index === 0 ? { ...track, role: 'general' } : track,
      ),
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      tracks: project.tracks.map((track, index) =>
        index === 0
          ? {
              ...track,
              instrument: {
                type: 'synth',
                preset: 'brightLead',
                params: { attack: 0.1 },
              },
            }
          : track,
      ),
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      tracks: project.tracks.map((track, index) =>
        index === 0 && track.instrument
          ? {
              ...track,
              instrument: { ...track.instrument, params: { attack: 0.1 } },
            }
          : track,
      ),
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      tracks: project.tracks.map((track, index) =>
        index === 0
          ? {
              ...track,
              clips: track.clips.map((clip, clipIndex) =>
                clipIndex === 0 ? { ...clip, startBeat: clip.startBeat + 1 } : clip,
              ),
            }
          : track,
      ),
    })).toBe(true);
  });

  it('ignores names, mixer state, effects, and event-content-only changes', () => {
    const project = createDefaultProject();
    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      tracks: project.tracks.map((track, index) =>
        index === 0
          ? {
              ...track,
              name: 'Renamed',
              color: '#123456',
              volume: 0.25,
              pan: 0.5,
              mute: !track.mute,
              solo: !track.solo,
              effects: [
                {
                  id: 'effect-test',
                  type: 'reverb',
                  enabled: true,
                  params: { mix: 0.25 },
                },
              ],
              clips: track.clips.map((clip, clipIndex) =>
                clipIndex === 0
                  ? {
                      ...clip,
                      notes: [
                        ...(clip.notes ?? []),
                        {
                          id: 'note-test',
                          pitch: 60,
                          startBeat: 0,
                          durationBeats: 1,
                          velocity: 100,
                        },
                      ],
                    }
                  : clip,
              ),
            }
          : track,
      ),
    })).toBe(false);
  });

  it('stops for routing topology but keeps send gain and enable changes live', () => {
    const project = createDefaultProject();
    const source = project.tracks.find((track) => track.type !== 'master');
    if (!source) throw new Error('source track fixture missing');
    const bus = {
      id: 'bus-routing-test',
      name: 'Routing Bus',
      type: 'bus' as const,
      role: 'general' as const,
      clips: [],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    };
    const routed = {
      ...project,
      tracks: [...project.tracks, bus],
      audioRouting: {
        outputs: [
          ...project.audioRouting.outputs,
          { sourceTrackId: bus.id, destination: { type: 'master' as const } },
        ],
        sends: [{
          id: 'send-routing-test',
          sourceTrackId: source.id,
          targetBusId: bus.id,
          position: 'post-fader' as const,
          gain: 0.5,
          enabled: true,
        }],
      },
    };

    expect(hasPlaybackTopologyChanged(routed, {
      ...routed,
      audioRouting: {
        ...routed.audioRouting,
        sends: routed.audioRouting.sends.map((send) => ({
          ...send,
          gain: 1.25,
          enabled: false,
        })),
      },
    })).toBe(false);
    expect(hasPlaybackTopologyChanged(routed, {
      ...routed,
      audioRouting: {
        ...routed.audioRouting,
        sends: routed.audioRouting.sends.map((send) => ({
          ...send,
          position: 'pre-fader' as const,
        })),
      },
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(routed, {
      ...routed,
      audioRouting: {
        ...routed.audioRouting,
        outputs: routed.audioRouting.outputs.map((output) =>
          output.sourceTrackId === source.id
            ? { ...output, destination: { type: 'bus' as const, trackId: bus.id } }
            : output),
      },
    })).toBe(true);
  });

  it('treats automation edits and automated live-mix edits as snapshot changes', () => {
    const project = createDefaultProject();
    const target = project.tracks[0];
    if (!target) throw new Error('track fixture missing');
    project.automationLanes = [{
      id: 'volume-lane',
      target: { type: 'track-volume', trackId: target.id },
      points: [{ id: 'volume-point', beat: 0, value: 0.5, interpolation: 'hold' }],
    }];

    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === target.id ? { ...track, name: 'Renamed' } : track),
    })).toBe(false);
    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === target.id ? { ...track, volume: 0.75 } : track),
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(project, {
      ...project,
      automationLanes: project.automationLanes.map((lane) => ({
        ...lane,
        points: lane.points.map((point) => ({ ...point, value: 0.25 })),
      })),
    })).toBe(true);
  });

  it('invalidates playback for Audio Clip ranges, gain/fades, and asset identity changes', () => {
    const project = createDefaultProject();
    const asset = {
      id: 'asset-audio-topology',
      availability: 'ready' as const,
      checksumSha256: 'a'.repeat(64),
      originalName: 'recording.wav',
      mediaType: 'audio/wav' as const,
      byteLength: 1_000,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 480_000,
    };
    const clip = {
      id: 'clip-audio-topology',
      trackId: 'track-audio-topology',
      type: 'audio' as const,
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      audioAssetId: asset.id,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      gainDb: 0,
    };
    const withAudio = {
      ...project,
      audioAssets: [asset],
      tracks: [{
        id: clip.trackId,
        name: 'Audio',
        type: 'audio' as const,
        role: 'general' as const,
        clips: [clip],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      }, ...project.tracks],
    };

    for (const field of [
      'sourceStartFrame',
      'sourceFrameCount',
      'fadeInFrames',
      'fadeOutFrames',
      'gainDb',
    ] as const) {
      expect(hasPlaybackTopologyChanged(withAudio, {
        ...withAudio,
        tracks: withAudio.tracks.map((track) => track.id === clip.trackId
          ? { ...track, clips: [{ ...clip, [field]: clip[field] + 1 }] }
          : track),
      }), field).toBe(true);
    }
    expect(hasPlaybackTopologyChanged(withAudio, {
      ...withAudio,
      audioAssets: [{ ...asset, checksumSha256: 'b'.repeat(64) }],
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(withAudio, {
      ...withAudio,
      audioAssets: [{ ...asset, originalName: 'renamed.wav' }],
    })).toBe(false);
  });

  it('deeply compares Audio take folders, takes, and selected comp segments', () => {
    const project = createDefaultProject();
    const asset = {
      id: 'asset-take-topology',
      availability: 'ready' as const,
      checksumSha256: 'c'.repeat(64),
      originalName: 'take.wav',
      mediaType: 'audio/wav' as const,
      byteLength: 384_044,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 192_000,
    };
    const trackId = 'track-take-topology';
    const withFolder = {
      ...project,
      audioAssets: [asset],
      audioTakeFolders: [{
        id: 'folder-topology',
        trackId,
        startBeat: 0,
        lengthBeats: 4,
        crossfadeMs: 5,
        takes: [
          {
            id: 'take-topology-a',
            audioAssetId: asset.id,
            offsetBeats: 0,
            lengthBeats: 4,
            sourceStartFrame: 0,
            sourceFrameCount: 96_000,
            fadeInFrames: 0,
            fadeOutFrames: 0,
            gainDb: 0,
          },
          {
            id: 'take-topology-b',
            audioAssetId: asset.id,
            offsetBeats: 0,
            lengthBeats: 4,
            sourceStartFrame: 96_000,
            sourceFrameCount: 96_000,
            fadeInFrames: 0,
            fadeOutFrames: 0,
            gainDb: -2,
          },
        ],
        compSegments: [{
          id: 'segment-topology',
          takeId: 'take-topology-a',
          offsetBeats: 0,
          lengthBeats: 4,
        }],
      }],
      tracks: [{
        id: trackId,
        name: 'Takes',
        type: 'audio' as const,
        role: 'general' as const,
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      }, ...project.tracks],
    };

    expect(hasPlaybackTopologyChanged(withFolder, {
      ...withFolder,
      audioTakeFolders: withFolder.audioTakeFolders.map((folder) => ({
        ...folder,
        crossfadeMs: 12,
      })),
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(withFolder, {
      ...withFolder,
      audioTakeFolders: withFolder.audioTakeFolders.map((folder) => ({
        ...folder,
        takes: folder.takes.map((take, index) =>
          index === 1 ? { ...take, gainDb: -6 } : take),
      })),
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(withFolder, {
      ...withFolder,
      audioTakeFolders: withFolder.audioTakeFolders.map((folder) => ({
        ...folder,
        compSegments: folder.compSegments.map((segment) => ({
          ...segment,
          takeId: 'take-topology-b',
        })),
      })),
    })).toBe(true);
    expect(hasPlaybackTopologyChanged(withFolder, {
      ...withFolder,
      audioTakeFolders: withFolder.audioTakeFolders.map((folder) => ({
        ...folder,
        compSegments: folder.compSegments.map((segment) => ({ ...segment })),
        takes: folder.takes.map((take) => ({ ...take })),
      })),
    })).toBe(false);
  });

  it.each(['starting', 'playing'] as const)(
    'stops an active %s generation atomically when topology is adopted',
    (phase) => {
      const store = createStudioStore(new MemoryProjectRepository());
      store.getState().setPosition(3.5);
      store.getState().play();
      const requestId = store.getState().transport.playbackRequestId;
      if (phase === 'playing') store.getState().confirmPlaybackStarted(requestId);

      expect(store.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((track, index) =>
          index === 0
            ? {
                ...track,
                instrument: track.instrument
                  ? { ...track.instrument, preset: 'brightLead' }
                  : track.instrument,
              }
            : track,
        ),
      }))).toBe(true);

      expect(store.getState().transport).toMatchObject({
        phase: 'stopped',
        isPlaying: false,
        playbackRequestId: requestId + 1,
        positionBeat: 3.5,
      });
    },
  );

  it('keeps active playback for adopted rename and mixer changes', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const track = store.getState().project.tracks[0];
    if (!track) throw new Error('track fixture missing');
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    store.getState().confirmPlaybackStarted(requestId);

    expect(store.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((candidate) =>
        candidate.id === track.id
          ? {
              ...candidate,
              name: 'Renamed',
              effects: [
                {
                  id: 'effect-live-edit',
                  type: 'reverb',
                  enabled: true,
                  params: { mix: 0.25 },
                },
              ],
            }
          : candidate,
      ),
    }))).toBe(true);
    store.getState().setTrackVolume(track.id, 0.5);

    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      isPlaying: true,
      playbackRequestId: requestId,
    });
  });

  it('stops active playback when the tempo-map clock changes', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    store.getState().play();
    const requestId = store.getState().transport.playbackRequestId;
    store.getState().confirmPlaybackStarted(requestId);

    store.getState().setBpm(90);

    expect(store.getState().project).toMatchObject({
      bpm: 90,
      tempoMap: [{ beat: 0, bpm: 90 }],
    });
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      playbackRequestId: requestId + 1,
    });
  });

  it('stops active playback when undo and redo restore different topology', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    expect(store.getState().applyProjectChange((project) => ({
      ...project,
      tracks: [project.tracks[1]!, project.tracks[0]!, ...project.tracks.slice(2)],
    }))).toBe(true);

    store.getState().play();
    const undoRequestId = store.getState().transport.playbackRequestId;
    store.getState().confirmPlaybackStarted(undoRequestId);
    store.getState().undo();
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      playbackRequestId: undoRequestId + 1,
    });

    store.getState().play();
    const redoRequestId = store.getState().transport.playbackRequestId;
    store.getState().redo();
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      playbackRequestId: redoRequestId + 1,
    });
  });

  it('does not disturb transport for rejected or referential no-op edits', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    store.getState().play();
    const before = store.getState();

    expect(store.getState().applyProjectChange((project) => ({
      ...project,
      // Duplicate ownership IDs are rejected by the canonical project boundary.
      tracks: [...project.tracks, project.tracks[0]!],
    }))).toBe(false);
    expect(store.getState().applyProjectChange((project) => project)).toBe(true);

    expect(store.getState().project).toBe(before.project);
    expect(store.getState().transport).toBe(before.transport);
  });
});

describe('transport playback lifecycle', () => {
  it('publishes transport.played only after the matching start is confirmed', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const events: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => events.push(event));

    try {
      store.getState().setPosition(2);
      store.getState().play();
      const requestId = store.getState().transport.playbackRequestId;

      expect(store.getState().transport).toMatchObject({
        phase: 'starting',
        isPlaying: false,
        audioIssue: null,
      });
      expect(events).toEqual([]);

      store.getState().confirmPlaybackStarted(requestId + 1);
      expect(store.getState().transport.phase).toBe('starting');
      expect(events).toEqual([]);

      store.getState().confirmPlaybackStarted(requestId);
      expect(store.getState().transport).toMatchObject({
        phase: 'playing',
        isPlaying: true,
      });
      expect(events).toEqual([
        { type: 'transport.played', payload: { positionBeats: 2 } },
      ]);

      store.getState().confirmPlaybackStarted(requestId);
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('keeps a startup failure visible and ignores its stale completion', () => {
    const store = createStudioStore(new MemoryProjectRepository());

    store.getState().play();
    const failedRequestId = store.getState().transport.playbackRequestId;
    store.getState().failPlaybackStart(failedRequestId);

    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      audioIssue: 'start-failed',
      playbackRequestId: failedRequestId + 1,
    });

    store.getState().confirmPlaybackStarted(failedRequestId);
    expect(store.getState().transport.phase).toBe('stopped');

    store.getState().play();
    expect(store.getState().transport).toMatchObject({
      phase: 'starting',
      isPlaying: false,
      audioIssue: null,
    });
    expect(store.getState().transport.playbackRequestId).toBe(failedRequestId + 2);
  });

  it.each([
    ['the exact song end', 32],
    ['past the song end', 32.25],
    ['a non-finite position', Number.NaN],
    ['a negative position', -0.25],
  ])('rewinds %s before requesting playback', (_label, positionBeat) => {
    const store = createStudioStore(new MemoryProjectRepository());
    store.setState((state) => ({
      project: { ...state.project, lengthBars: 8, timeSignature: [4, 4] },
      transport: { ...state.transport, positionBeat },
    }));

    const before = store.getState();
    before.play();

    expect(store.getState().transport).toMatchObject({
      phase: 'starting',
      isPlaying: false,
      playbackRequestId: before.transport.playbackRequestId + 1,
      audioIssue: null,
      positionBeat: 0,
    });
  });

  it('preserves a valid playhead and leaves project history untouched', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    store.getState().setPosition(3.5);
    store.setState((state) => ({
      transport: { ...state.transport, audioIssue: 'start-failed' },
    }));
    const before = store.getState();

    before.play();

    expect(store.getState().transport).toMatchObject({
      phase: 'starting',
      playbackRequestId: before.transport.playbackRequestId + 1,
      audioIssue: null,
      positionBeat: 3.5,
    });
    expect(store.getState().project).toBe(before.project);
    expect(store.getState().past).toBe(before.past);
    expect(store.getState().future).toBe(before.future);
    expect(store.getState().saveState).toBe(before.saveState);
  });

  it('uses denominator-aware song length when deciding whether to rewind', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    store.setState((state) => ({
      project: {
        ...state.project,
        lengthBars: 2,
        lengthBeats: 6,
        timeSignature: [6, 8] as [number, number],
        timeSignatureMap: [{
          id: 'signature-6-8',
          beat: 0,
          numerator: 6,
          denominator: 8,
        }],
      },
      transport: { ...state.transport, positionBeat: 6 },
    }));

    store.getState().play();

    expect(store.getState().transport.positionBeat).toBe(0);
  });

  it.each([0, Number.NaN])(
    'uses beat zero when the project length is unusable (%s)',
    (lengthBeats) => {
      const store = createStudioStore(new MemoryProjectRepository());
      store.setState((state) => ({
        project: { ...state.project, lengthBeats },
        transport: { ...state.transport, positionBeat: 2 },
      }));

      store.getState().play();

      expect(store.getState().transport.positionBeat).toBe(0);
    },
  );

  it('rewinds at the song end without changing an enabled loop region', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    store.setState((state) => ({
      project: {
        ...state.project,
        lengthBars: 2,
        lengthBeats: 8,
        timeSignature: [4, 4],
      },
      transport: {
        ...state.transport,
        positionBeat: 8,
        loopEnabled: true,
        loopStartBeat: 2,
        loopEndBeat: 6,
      },
    }));

    store.getState().play();

    expect(store.getState().transport).toMatchObject({
      phase: 'starting',
      positionBeat: 0,
      loopEnabled: true,
      loopStartBeat: 2,
      loopEndBeat: 6,
    });
  });

  it('can confirm a retry after a failed end-of-song start', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const projectLength =
      store.getState().project.lengthBars *
      beatsPerBar(store.getState().project.timeSignature);
    store.getState().setPosition(projectLength);

    store.getState().play();
    const failedRequestId = store.getState().transport.playbackRequestId;
    expect(store.getState().transport.positionBeat).toBe(0);
    store.getState().failPlaybackStart(failedRequestId);

    store.getState().setPosition(projectLength);
    store.getState().play();
    const retryRequestId = store.getState().transport.playbackRequestId;
    store.getState().confirmPlaybackStarted(retryRequestId);

    expect(store.getState().transport).toMatchObject({
      phase: 'playing',
      isPlaying: true,
      playbackRequestId: retryRequestId,
      audioIssue: null,
      positionBeat: 0,
    });
    expect(retryRequestId).toBe(failedRequestId + 2);
  });

  it('invalidates rapid stop/play races while preserving pause and rewind semantics', () => {
    const store = createStudioStore(new MemoryProjectRepository());

    store.getState().setPosition(4);
    store.getState().play();
    const staleRequestId = store.getState().transport.playbackRequestId;
    store.getState().stop();

    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      positionBeat: 4,
      playbackRequestId: staleRequestId + 1,
    });

    store.getState().play();
    const activeRequestId = store.getState().transport.playbackRequestId;
    store.getState().confirmPlaybackStarted(staleRequestId);
    expect(store.getState().transport.phase).toBe('starting');

    store.getState().confirmPlaybackStarted(activeRequestId);
    store.getState().stop();
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      positionBeat: 4,
    });

    store.getState().stop();
    expect(store.getState().transport.positionBeat).toBe(0);
  });

  it('does not recycle request IDs when a project activation resets transport', async () => {
    const store = createStudioStore(new MemoryProjectRepository());

    store.getState().play();
    const oldProjectRequestId = store.getState().transport.playbackRequestId;

    await expect(store.getState().createNewProject('次の曲')).resolves.toBe(true);
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      playbackRequestId: oldProjectRequestId + 1,
    });

    store.getState().play();
    expect(store.getState().transport.playbackRequestId).toBe(oldProjectRequestId + 2);
    store.getState().confirmPlaybackStarted(oldProjectRequestId);
    expect(store.getState().transport.phase).toBe('starting');
  });

  it('surfaces matching interruptions and rewinds a matching natural end', () => {
    const store = createStudioStore(new MemoryProjectRepository());

    store.getState().play();
    let requestId = store.getState().transport.playbackRequestId;
    store.getState().confirmPlaybackStarted(requestId);
    store.getState().interruptPlayback(requestId + 1);
    expect(store.getState().transport.phase).toBe('playing');

    store.getState().interruptPlayback(requestId);
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      audioIssue: 'interrupted',
    });

    store.getState().play();
    requestId = store.getState().transport.playbackRequestId;
    store.getState().confirmPlaybackStarted(requestId);
    store.getState().interruptPlayback(requestId, 'audio-resource-limit');
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      audioIssue: 'audio-resource-limit',
    });

    store.getState().play();
    requestId = store.getState().transport.playbackRequestId;
    store.getState().confirmPlaybackStarted(requestId);
    store.getState().setPosition(8);
    store.getState().finishPlayback(requestId);
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      audioIssue: null,
      positionBeat: 0,
    });
  });

  it('enables a first loop over the whole song without starting stopped playback', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const before = store.getState();
    const projectLength =
      before.project.lengthBars * beatsPerBar(before.project.timeSignature);

    before.toggleLoop();

    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      playbackRequestId: before.transport.playbackRequestId,
      loopEnabled: true,
      loopStartBeat: 0,
      loopEndBeat: projectLength,
    });
    expect(store.getState().project).toBe(before.project);
    expect(store.getState().past).toBe(before.past);
    expect(store.getState().future).toBe(before.future);

    store.getState().toggleLoop();
    expect(store.getState().transport).toMatchObject({
      phase: 'stopped',
      playbackRequestId: before.transport.playbackRequestId,
      loopEnabled: false,
      loopStartBeat: 0,
      loopEndBeat: projectLength,
    });
  });

  it('uses denominator-aware quarter-note beats and clamps position on toggle', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    store.setState((state) => ({
      project: {
        ...state.project,
        lengthBars: 2,
        lengthBeats: 6,
        timeSignature: [6, 8] as [number, number],
        timeSignatureMap: [{
          id: 'signature-6-8',
          beat: 0,
          numerator: 6,
          denominator: 8,
        }],
      },
      transport: {
        ...state.transport,
        positionBeat: 99,
      },
    }));

    store.getState().toggleLoop();

    expect(store.getState().transport).toMatchObject({
      loopEnabled: true,
      loopStartBeat: 0,
      loopEndBeat: 6,
      positionBeat: 6,
    });
  });

  it('supersedes starting and playing generations when the loop setting changes', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const project = store.getState().project;
    const past = store.getState().past;
    const future = store.getState().future;

    store.getState().setPosition(2.5);
    store.getState().play();
    const firstRequestId = store.getState().transport.playbackRequestId;
    store.setState((state) => ({
      transport: { ...state.transport, audioIssue: 'interrupted' },
    }));

    store.getState().toggleLoop();
    const loopRequestId = store.getState().transport.playbackRequestId;
    expect(store.getState().transport).toMatchObject({
      phase: 'starting',
      isPlaying: false,
      playbackRequestId: firstRequestId + 1,
      audioIssue: null,
      positionBeat: 2.5,
      loopEnabled: true,
    });

    store.getState().confirmPlaybackStarted(loopRequestId);
    expect(store.getState().transport.phase).toBe('playing');

    store.getState().toggleLoop();
    expect(store.getState().transport).toMatchObject({
      phase: 'starting',
      isPlaying: false,
      playbackRequestId: loopRequestId + 1,
      audioIssue: null,
      positionBeat: 2.5,
      loopEnabled: false,
    });
    expect(store.getState().project).toBe(project);
    expect(store.getState().past).toBe(past);
    expect(store.getState().future).toBe(future);
  });
});
