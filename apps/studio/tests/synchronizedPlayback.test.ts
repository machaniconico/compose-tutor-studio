import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, type Project, type Track } from '@cts/project-model';
import type { AudioAssetBufferLease } from '../src/audio/audioAssetResolver';
import { buildTrackGraphs, type TrackGraph } from '../src/audio/graph';

const engineHarness = vi.hoisted(() => {
  const makeParam = () => {
    const commands: Array<{
      kind: 'cancel' | 'hold' | 'set' | 'target' | 'linear';
      value?: number;
      time: number;
    }> = [];
    return {
      value: 1,
      commands,
      cancelScheduledValues: vi.fn((time: number) => {
        commands.push({ kind: 'cancel', time });
      }),
      cancelAndHoldAtTime: vi.fn((time: number) => {
        commands.push({ kind: 'hold', time });
      }),
      setValueAtTime: vi.fn((value: number, time: number) => {
        commands.push({ kind: 'set', value, time });
      }),
      setTargetAtTime: vi.fn((value: number, time: number) => {
        commands.push({ kind: 'target', value, time });
      }),
      linearRampToValueAtTime: vi.fn((value: number, time: number) => {
        commands.push({ kind: 'linear', value, time });
      }),
    };
  };
  const makeGain = () => ({
    gain: makeParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  const gains: ReturnType<typeof makeGain>[] = [];
  const harness = {
    currentTime: 10,
    contextState: 'running',
    generation: 7,
    listeners: new Set<(state: string) => void>(),
    gains,
    makeGain,
    makeParam,
    context: null as unknown as AudioContext,
    master: null as unknown as GainNode,
    ensureContext: vi.fn(),
  };
  harness.context = {
    sampleRate: 48_000,
    get currentTime() {
      return harness.currentTime;
    },
    get state() {
      return harness.contextState;
    },
    createGain: vi.fn(() => {
      const gain = makeGain();
      gains.push(gain);
      return gain;
    }),
  } as unknown as AudioContext;
  harness.master = makeGain() as unknown as GainNode;
  return harness;
});

const assetHarness = vi.hoisted(() => ({
  acquire: vi.fn(),
  preflight: vi.fn(),
  clearUnused: vi.fn(),
  release: vi.fn(),
}));

type GraphDouble = Readonly<{
  input: GainNode;
  scheduleAutomation: ReturnType<typeof vi.fn>;
  schedulePunchAudibility: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}>;

const graphHarness = vi.hoisted(() => ({
  graphs: new Map<string, GraphDouble>(),
}));

vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    get audioContext() {
      return engineHarness.context;
    },
    get contextGeneration() {
      return engineHarness.generation;
    },
    ensureContext: engineHarness.ensureContext,
    now: () => engineHarness.currentTime,
    subscribeStateChange: (listener: (state: string) => void) => {
      engineHarness.listeners.add(listener);
      return () => engineHarness.listeners.delete(listener);
    },
  }),
}));

vi.mock('../src/audio/audioAssetResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/audioAssetResolver')>();
  return {
    ...actual,
    getAudioAssetPlaybackCache: () => ({
      clearUnused: assetHarness.clearUnused,
      preflight: assetHarness.preflight,
      retainedDecodedBytes: 0,
    }),
    projectHasReferencedReadyAudioAssets: () => false,
    acquireProjectAudioBuffers: assetHarness.acquire,
  };
});

vi.mock('../src/audio/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/graph')>();
  return {
    ...actual,
    assertRoutingGraphNodeBudget: vi.fn(),
    buildTrackGraphs: vi.fn(
      () => graphHarness.graphs as unknown as Map<string, TrackGraph>,
    ),
  };
});

import {
  initAudioBridge,
  startSynchronizedRecordingPlayback,
  stopSynchronizedRecordingPlayback,
} from '../src/audio/playback';
import {
  renderProjectToWav,
  renderSelectedTrackToWav,
} from '../src/audio/wav';
import { useStore } from '../src/state/store';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

const PUNCH_TARGET_TRACK_ID = 'test-punch-target';
const OTHER_AUDIO_TRACK_ID = 'test-punch-other';
const PUNCH_IN_BEAT = 4;
const PUNCH_OUT_BEAT = 8;
const PUNCH_PLAYBACK_END_BEAT = 12;
const PUNCH_CONTRACT = {
  targetTrackId: PUNCH_TARGET_TRACK_ID,
  punchInBeat: PUNCH_IN_BEAT,
  punchOutBeat: PUNCH_OUT_BEAT,
  playbackEndBeat: PUNCH_PLAYBACK_END_BEAT,
} as const;

function makeAudioTrack(id: string, name: string): Track {
  return {
    id,
    name,
    type: 'audio',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
}

function createPunchProject(): Project {
  const base = createEmptyProject();
  const masterIndex = base.tracks.findIndex((track) => track.type === 'master');
  const insertionIndex = masterIndex < 0 ? base.tracks.length : masterIndex;
  const target = makeAudioTrack(PUNCH_TARGET_TRACK_ID, 'Punch target');
  const other = makeAudioTrack(OTHER_AUDIO_TRACK_ID, 'Other audio');
  return {
    ...base,
    tracks: [
      ...base.tracks.slice(0, insertionIndex),
      target,
      other,
      ...base.tracks.slice(insertionIndex),
    ],
    audioRouting: {
      ...base.audioRouting,
      outputs: [
        ...base.audioRouting.outputs,
        {
          sourceTrackId: target.id,
          destination: { type: 'master' },
        },
        {
          sourceTrackId: other.id,
          destination: { type: 'master' },
        },
      ],
    },
  };
}

function makeGraphDouble(): GraphDouble {
  return {
    input: {} as GainNode,
    scheduleAutomation: vi.fn(),
    schedulePunchAudibility: vi.fn(),
    dispose: vi.fn(),
  };
}

type MasterParamCommand =
  ReturnType<typeof engineHarness.makeParam>['commands'][number];

function normalizedMasterCommands(
  gain: ReturnType<typeof engineHarness.makeGain>,
  timeOrigin: number,
): readonly MasterParamCommand[] {
  return gain.gain.commands.map((command) => ({
    ...command,
    time: Number((command.time - timeOrigin).toFixed(9)),
  }));
}

function installMasterParityOfflineContext(): Readonly<{
  gains: Array<ReturnType<typeof engineHarness.makeGain>>;
}> {
  const gains: Array<ReturnType<typeof engineHarness.makeGain>> = [];
  const compressor = {
    threshold: engineHarness.makeParam(),
    knee: engineHarness.makeParam(),
    ratio: engineHarness.makeParam(),
    attack: engineHarness.makeParam(),
    release: engineHarness.makeParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const rendered = {
    duration: 1 / 44_100,
    length: 1,
    sampleRate: 44_100,
    numberOfChannels: 2,
    getChannelData: () => new Float32Array(1),
  } as unknown as AudioBuffer;
  const context = {
    currentTime: 0,
    sampleRate: 44_100,
    destination: {},
    createGain: vi.fn(() => {
      const gain = engineHarness.makeGain();
      gains.push(gain);
      return gain;
    }),
    createDynamicsCompressor: vi.fn(() => compressor),
    startRendering: vi.fn(async () => rendered),
  };
  vi.stubGlobal(
    'OfflineAudioContext',
    vi.fn(function OfflineAudioContext() {
      return context;
    }),
  );
  return { gains };
}

describe('synchronized recording playback runtime races', () => {
  let teardownBridge = (): void => undefined;
  let project = createEmptyProject();
  let operationId = 71;

  function installPunchProject(): Readonly<{
    targetGraph: GraphDouble;
    otherGraph: GraphDouble;
  }> {
    project = createPunchProject();
    const targetGraph = makeGraphDouble();
    const otherGraph = makeGraphDouble();
    graphHarness.graphs.set(PUNCH_TARGET_TRACK_ID, targetGraph);
    graphHarness.graphs.set(OTHER_AUDIO_TRACK_ID, otherGraph);
    useStore.setState((state) => ({
      project,
      armedAudioTrackId: PUNCH_TARGET_TRACK_ID,
      transport: {
        ...state.transport,
        phase: 'stopped',
        isPlaying: false,
        positionBeat: 0,
        loopEnabled: false,
        punchEnabled: true,
        punchInBeat: PUNCH_IN_BEAT,
        punchOutBeat: PUNCH_OUT_BEAT,
        punchPreRollBeats: 4,
        punchPostRollBeats: 4,
      },
    }));
    return { targetGraph, otherGraph };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    engineHarness.currentTime = 10;
    engineHarness.contextState = 'running';
    engineHarness.generation = 7;
    engineHarness.listeners.clear();
    engineHarness.gains.length = 0;
    engineHarness.ensureContext.mockReset();
    engineHarness.ensureContext.mockResolvedValue({
      context: engineHarness.context,
      master: engineHarness.master,
      contextGeneration: engineHarness.generation,
    });

    assetHarness.acquire.mockReset();
    assetHarness.preflight.mockReset();
    assetHarness.clearUnused.mockReset();
    assetHarness.release = vi.fn();
    assetHarness.preflight.mockResolvedValue({
      assets: [],
      estimatedDecodedBytes: 0,
    });
    assetHarness.acquire.mockResolvedValue({
      buffersByAssetId: new Map(),
      release: assetHarness.release,
    } satisfies AudioAssetBufferLease);
    graphHarness.graphs.clear();

    project = {
      ...createEmptyProject(),
      // Raw Zustand replacement is intentional in this runtime race harness.
      // Keep the persistence coordinator's active ID so tests that exercise a
      // real Project edit do not fail at the unrelated save CAS boundary.
      id: useStore.getState().saveState.projectId,
    };
    operationId += 1;
    const transport = useStore.getState().transport;
    useStore.setState({
      project,
      projectOperationBusy: false,
      audioRecordingOperationId: operationId,
      armedAudioTrackId: null,
      transport: {
        ...transport,
        phase: 'stopped',
        isPlaying: false,
        playbackRequestId: 900,
        audioIssue: null,
        positionBeat: 0,
        loopEnabled: false,
        loopStartBeat: 0,
        loopEndBeat: 0,
        punchEnabled: false,
        punchInBeat: 0,
        punchOutBeat: 0,
        punchPreRollBeats: 4,
        punchPostRollBeats: 4,
        metronome: false,
      },
    });
    teardownBridge = initAudioBridge();
  });

  afterEach(async () => {
    const transport = useStore.getState().transport;
    stopSynchronizedRecordingPlayback(transport.playbackRequestId);
    teardownBridge();
    await flushMicrotasks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('arms the shared context frame and confirms playback only after the anchor', async () => {
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _startFrame: number,
      _contextGeneration: number,
      _playbackAnchorFrame?: number,
    ) => undefined);
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: new AbortController().signal,
      armCapture,
    });
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await flushMicrotasks();

    expect(armCapture).toHaveBeenCalledOnce();
    const [
      context,
      captureStartFrame,
      contextGeneration,
      playbackAnchorFrame,
    ] = armCapture.mock.calls[0]!;
    const anchorFrame = captureStartFrame;
    expect(context).toBe(engineHarness.context);
    expect(contextGeneration).toBe(engineHarness.generation);
    expect(playbackAnchorFrame).toBe(anchorFrame);
    expect(useStore.getState().transport.phase).toBe('starting');

    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate - 0.001;
    await vi.advanceTimersByTimeAsync(4);
    expect(settled).toBe(false);
    expect(useStore.getState().transport.phase).toBe('starting');

    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;

    expect(clock).toMatchObject({
      context: engineHarness.context,
      contextGeneration: engineHarness.generation,
      sampleRate: 48_000,
      anchorContextFrame: anchorFrame,
      anchorBeat: 0,
      projectSnapshot: project,
    });
    expect(Object.isFrozen(clock)).toBe(true);
    expect(clock.captureStartContextFrame).toBeUndefined();
    expect(clock.punchEndContextFrame).toBeUndefined();
    expect(clock.punch).toBeUndefined();
    expect(useStore.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: clock.requestId,
    });
    expect(assetHarness.release).not.toHaveBeenCalled();

    expect(stopSynchronizedRecordingPlayback(clock.requestId)).toBe(true);
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('uses the Track scalar while live Read is disabled and restores the exact curve plan', async () => {
    const target = project.tracks.find((track) => track.type !== 'master');
    if (!target) throw new Error('The default Project must contain a playable Track.');
    const points = [
      {
        id: 'live-read-point-0',
        beat: 0,
        value: 0.25,
        interpolation: 'linear' as const,
      },
      {
        id: 'live-read-point-1',
        beat: 2,
        value: 1.25,
        interpolation: 'hold' as const,
      },
    ];
    const readProject: Project = {
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === target.id ? { ...track, volume: 0.73 } : track),
      automationLanes: [{
        id: 'live-read-volume',
        bypassed: false,
        target: { type: 'track-volume', trackId: target.id },
        points,
      }],
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    };
    const graph = makeGraphDouble();
    graphHarness.graphs.set(target.id, graph);

    const playAndCapture = async (snapshot: Project) => {
      const before = useStore.getState();
      const ensureContextCalls = engineHarness.ensureContext.mock.calls.length;
      vi.mocked(buildTrackGraphs).mockClear();
      useStore.setState({
        project: snapshot,
        audioRecordingOperationId: null,
        transport: {
          ...before.transport,
          phase: 'stopped',
          isPlaying: false,
          positionBeat: 0,
          playbackRequestId: before.transport.playbackRequestId + 1,
        },
      });
      graph.scheduleAutomation.mockClear();
      graphHarness.graphs.set(target.id, graph);
      expect(useStore.getState()).toMatchObject({
        projectOperationBusy: false,
        audioRecordingOperationId: null,
        transport: { phase: 'stopped' },
      });
      useStore.getState().play();
      expect(useStore.getState().transport.phase).toBe('starting');
      await flushMicrotasks();
      expect(engineHarness.ensureContext).toHaveBeenCalledTimes(ensureContextCalls + 1);
      expect(buildTrackGraphs).toHaveBeenCalledOnce();
      const runtimeProject = vi.mocked(buildTrackGraphs).mock.calls[0]?.[2] as Project;
      expect(runtimeProject.tracks.find((track) => track.id === target.id)?.volume).toBe(0.73);
      const commands = graph.scheduleAutomation.mock.calls.map((call) => [...call]);
      useStore.getState().stop();
      await flushMicrotasks();
      return commands;
    };

    const enabledCommands = await playAndCapture(readProject);
    expect(enabledCommands[0]).toEqual(
      ['track-volume', 0.25, 10, 'hold', true],
    );
    expect(enabledCommands[1]?.[0]).toBe('track-volume');
    expect(enabledCommands[1]?.[1]).toBeCloseTo(0.37, 10);
    expect(enabledCommands[1]?.[2]).toBeCloseTo(10.12, 10);
    expect(enabledCommands[1]?.slice(3)).toEqual(['linear', true]);
    expect(enabledCommands).toHaveLength(2);

    const disabledProject: Project = {
      ...readProject,
      automationReadState: { globalEnabled: false, disabledTrackIds: [] },
    };
    expect(await playAndCapture(disabledProject)).toEqual([]);
    expect(disabledProject.tracks.find((track) => track.id === target.id)?.volume).toBe(0.73);

    const reenabledProject: Project = {
      ...disabledProject,
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    };
    expect(await playAndCapture(reenabledProject)).toEqual(enabledCommands);
    expect(reenabledProject.automationLanes[0]?.points).toBe(points);
    expect(reenabledProject.automationLanes[0]?.points).toEqual(readProject.automationLanes[0]?.points);
  });

  it('matches production live Master commands with full and selected-Track WAV across every Read gate', async () => {
    const target = project.tracks.find((track) => track.type !== 'master');
    const master = project.tracks.find((track) => track.type === 'master');
    if (!target || !master) {
      throw new Error('Expected playable and effective Master Tracks');
    }
    const readProject: Project = {
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === master.id ? { ...track, volume: 0.9 } : track),
      automationLanes: [{
        id: 'live-wav-master-parity-lane',
        bypassed: false,
        target: { type: 'track-volume', trackId: master.id },
        points: [
          {
            id: 'live-wav-master-parity-0',
            beat: 0,
            value: 0.35,
            interpolation: 'hold',
          },
          {
            id: 'live-wav-master-parity-1',
            beat: 0.1,
            value: 0.65,
            interpolation: 'hold',
          },
        ],
      }],
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    };
    const variants = [
      { state: 'read-enabled', project: readProject },
      {
        state: 'global-read-disabled',
        project: {
          ...readProject,
          automationReadState: {
            globalEnabled: false,
            disabledTrackIds: [],
          },
        },
      },
      {
        state: 'master-read-disabled',
        project: {
          ...readProject,
          automationReadState: {
            globalEnabled: true,
            disabledTrackIds: [master.id],
          },
        },
      },
      {
        state: 'lane-bypassed',
        project: {
          ...readProject,
          automationLanes: readProject.automationLanes.map((lane) => ({
            ...lane,
            bypassed: true,
          })),
        },
      },
    ] satisfies ReadonlyArray<Readonly<{ state: string; project: Project }>>;

    const captureLive = async (
      snapshot: Project,
    ): Promise<readonly MasterParamCommand[]> => {
      vi.unstubAllGlobals();
      engineHarness.currentTime = 10;
      engineHarness.gains.length = 0;
      graphHarness.graphs.clear();
      graphHarness.graphs.set(target.id, makeGraphDouble());
      const before = useStore.getState();
      useStore.setState({
        project: snapshot,
        projectOperationBusy: false,
        audioRecordingOperationId: null,
        armedAudioTrackId: null,
        transport: {
          ...before.transport,
          phase: 'stopped',
          isPlaying: false,
          positionBeat: 0,
          playbackRequestId: before.transport.playbackRequestId + 1,
          audioIssue: null,
          loopEnabled: false,
          metronome: false,
        },
      });

      useStore.getState().play();
      await flushMicrotasks();
      expect(useStore.getState().transport.phase).toBe('playing');
      const liveMaster = engineHarness.gains[1];
      if (!liveMaster) throw new Error('Expected the production live Master fader');
      const commands = normalizedMasterCommands(liveMaster, 10);
      useStore.getState().stop();
      await flushMicrotasks();
      return commands;
    };

    const captureWav = async (
      snapshot: Project,
      selected: boolean,
    ): Promise<readonly MasterParamCommand[]> => {
      vi.unstubAllGlobals();
      graphHarness.graphs.clear();
      graphHarness.graphs.set(target.id, makeGraphDouble());
      const offline = installMasterParityOfflineContext();
      const rendered = selected
        ? await renderSelectedTrackToWav(snapshot, target.id)
        : await renderProjectToWav(snapshot);
      rendered.release();
      const offlineMaster = offline.gains[0];
      if (!offlineMaster) throw new Error('Expected the offline Master fader');
      return normalizedMasterCommands(offlineMaster, 0);
    };

    for (const variant of variants) {
      const liveCommands = await captureLive(variant.project);
      const mixCommands = await captureWav(variant.project, false);
      const selectedCommands = await captureWav(variant.project, true);
      expect({
        state: variant.state,
        commands: mixCommands,
      }).toEqual({
        state: variant.state,
        commands: liveCommands,
      });
      expect({
        state: variant.state,
        commands: selectedCommands,
      }).toEqual({
        state: variant.state,
        commands: liveCommands,
      });
    }

    const enabledCommands = await captureLive(readProject);
    expect(enabledCommands).toContainEqual({
      kind: 'set',
      value: 0.35,
      time: 0,
    });
    expect(enabledCommands).toContainEqual({
      kind: 'set',
      value: 0.65,
      time: 0.05,
    });
    for (const variant of variants.slice(1)) {
      const commands = await captureLive(variant.project);
      expect(commands).toContainEqual({
        kind: 'set',
        value: 0.9,
        time: 0,
      });
      expect(commands.some((command) => command.value === 0.35)).toBe(false);
    }
  });

  it('replaces live playback at the same beat after editing an automated Master base scalar', async () => {
    const master = project.tracks.find((track) => track.type === 'master');
    if (!master) throw new Error('Master fixture missing');
    project = {
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === master.id ? { ...track, volume: 0.8 } : track),
      automationLanes: [{
        id: 'live-master-base-replacement-lane',
        bypassed: false,
        target: { type: 'track-volume', trackId: master.id },
        points: [{
          id: 'live-master-base-replacement-point',
          beat: 4,
          value: 0.35,
          interpolation: 'hold',
        }],
      }],
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    };
    useStore.setState((state) => ({
      project,
      audioRecordingOperationId: null,
      transport: {
        ...state.transport,
        phase: 'stopped',
        isPlaying: false,
        positionBeat: 2.75,
        playbackRequestId: state.transport.playbackRequestId + 1,
      },
    }));

    useStore.getState().play();
    await flushMicrotasks();
    const firstRequestId = useStore.getState().transport.playbackRequestId;
    expect(useStore.getState().transport).toMatchObject({
      phase: 'playing',
      positionBeat: 2.75,
      playbackRequestId: firstRequestId,
    });
    const graphBuildsBeforeEdit = vi.mocked(buildTrackGraphs).mock.calls.length;
    engineHarness.currentTime = 10.25;
    expect(useStore.getState().transport.positionBeat).toBe(2.75);

    useStore.getState().setTrackVolume(master.id, 0.6);

    expect(
      useStore.getState().project.tracks.find(
        (track) => track.id === master.id,
      )?.volume,
    ).toBe(0.6);
    expect(useStore.getState().transport).toMatchObject({
      phase: 'starting',
      isPlaying: false,
      positionBeat: 3.25,
      audioIssue: null,
    });
    const replacementRequestId =
      useStore.getState().transport.playbackRequestId;
    expect(replacementRequestId).toBeGreaterThan(firstRequestId);
    await flushMicrotasks();
    expect(useStore.getState().transport).toMatchObject({
      phase: 'playing',
      positionBeat: 3.25,
      playbackRequestId: replacementRequestId,
    });
    expect(vi.mocked(buildTrackGraphs).mock.calls.length)
      .toBe(graphBuildsBeforeEdit + 1);
  });

  it('arms Auto Punch capture at the exact punch-in frame and exposes both clocks', async () => {
    installPunchProject();
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _captureStartFrame: number,
      _contextGeneration: number,
      _playbackAnchorFrame?: number,
    ) => undefined);
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      punch: PUNCH_CONTRACT,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();

    expect(armCapture).toHaveBeenCalledOnce();
    const [
      context,
      captureStartFrame,
      contextGeneration,
      playbackAnchorFrame,
    ] = armCapture.mock.calls[0]!;
    const anchorFrame = playbackAnchorFrame ?? Number.NaN;
    const expectedPreRollFrames = Math.round(
      (PUNCH_IN_BEAT * 60 / project.bpm) * engineHarness.context.sampleRate,
    );
    expect(context).toBe(engineHarness.context);
    expect(contextGeneration).toBe(engineHarness.generation);
    expect(playbackAnchorFrame).toEqual(expect.any(Number));
    expect(captureStartFrame).toBe(anchorFrame + expectedPreRollFrames);
    expect(useStore.getState().transport.phase).toBe('starting');

    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;

    expect(clock).toMatchObject({
      context: engineHarness.context,
      contextGeneration: engineHarness.generation,
      sampleRate: 48_000,
      anchorContextFrame: anchorFrame,
      captureStartContextFrame: captureStartFrame,
      punchEndContextFrame: anchorFrame + Math.round(
        (PUNCH_OUT_BEAT * 60 / project.bpm) * engineHarness.context.sampleRate,
      ),
      anchorBeat: 0,
      punch: PUNCH_CONTRACT,
      projectSnapshot: project,
    });
    expect(Object.isFrozen(clock)).toBe(true);
    expect(Object.isFrozen(clock.punch)).toBe(true);
    expect(useStore.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: clock.requestId,
      punchEnabled: true,
    });

    expect(stopSynchronizedRecordingPlayback(clock.requestId)).toBe(true);
  });

  it('completes finite Auto Punch only at the post-roll boundary', async () => {
    installPunchProject();
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _captureStartFrame: number,
      _contextGeneration: number,
      _playbackAnchorFrame?: number,
    ) => undefined);
    const onFinitePunchComplete = vi.fn();
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      punch: PUNCH_CONTRACT,
      onFinitePunchComplete,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();
    const [, , , playbackAnchorFrame] = armCapture.mock.calls[0]!;
    const anchorFrame = playbackAnchorFrame ?? Number.NaN;
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;

    // At 120 BPM, punch-out is four seconds after the pre-roll anchor.
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate + 4;
    await vi.advanceTimersByTimeAsync(25);
    expect(onFinitePunchComplete).not.toHaveBeenCalled();
    expect(useStore.getState().transport.phase).toBe('playing');

    // Four post-roll beats end two seconds later at playbackEndBeat=12.
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate + 6;
    await vi.advanceTimersByTimeAsync(25);

    expect(onFinitePunchComplete).toHaveBeenCalledOnce();
    expect(onFinitePunchComplete).toHaveBeenCalledWith(clock.requestId);
    expect(useStore.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      punchEnabled: true,
    });
    expect(useStore.getState().transport.playbackRequestId).not.toBe(clock.requestId);
  });

  it('gates only the target track for the half-open Auto Punch window', async () => {
    const { targetGraph, otherGraph } = installPunchProject();
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _captureStartFrame: number,
      _contextGeneration: number,
      _playbackAnchorFrame?: number,
    ) => undefined);
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      punch: PUNCH_CONTRACT,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();
    const [, , , playbackAnchorFrame] = armCapture.mock.calls[0]!;
    const anchorFrame = playbackAnchorFrame ?? Number.NaN;
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;

    expect(targetGraph.schedulePunchAudibility).toHaveBeenCalledOnce();
    const [punchInTime, punchOutTime, restoreAudible] =
      targetGraph.schedulePunchAudibility.mock.calls[0]!;
    expect(punchInTime).toBe(
      clock.captureStartContextFrame! / clock.sampleRate,
    );
    expect(punchOutTime).toBe(
      clock.punchEndContextFrame! / clock.sampleRate,
    );
    expect(restoreAudible).toBe(true);
    expect(otherGraph.schedulePunchAudibility).not.toHaveBeenCalled();

    expect(stopSynchronizedRecordingPlayback(clock.requestId)).toBe(true);
  });

  it('rounds non-integer punch boundaries once for both capture and track gate', async () => {
    const { targetGraph } = installPunchProject();
    const bpm = 137;
    const punch = {
      targetTrackId: PUNCH_TARGET_TRACK_ID,
      punchInBeat: 1,
      punchOutBeat: 3,
      playbackEndBeat: 4,
    } as const;
    project = {
      ...project,
      bpm,
      tempoMap: project.tempoMap.map((event, index) => (
        index === 0 ? { ...event, bpm } : event
      )),
    };
    useStore.setState((state) => ({
      project,
      transport: {
        ...state.transport,
        punchInBeat: punch.punchInBeat,
        punchOutBeat: punch.punchOutBeat,
        punchPreRollBeats: 1,
        punchPostRollBeats: 1,
      },
    }));
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _captureStartFrame: number,
      _contextGeneration: number,
      _playbackAnchorFrame?: number,
    ) => undefined);
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      punch,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();

    const [, captureStartFrame, , playbackAnchorFrame] =
      armCapture.mock.calls[0]!;
    const anchorFrame = playbackAnchorFrame ?? Number.NaN;
    const framesPerBeat = 60 / bpm * engineHarness.context.sampleRate;
    const expectedPunchInFrame = anchorFrame + Math.round(framesPerBeat);
    const expectedPunchOutFrame = anchorFrame + Math.round(framesPerBeat * 3);
    expect(captureStartFrame).toBe(expectedPunchInFrame);

    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;
    expect(clock.captureStartContextFrame).toBe(expectedPunchInFrame);
    expect(clock.punchEndContextFrame).toBe(expectedPunchOutFrame);
    expect(targetGraph.schedulePunchAudibility).toHaveBeenCalledWith(
      expectedPunchInFrame / clock.sampleRate,
      expectedPunchOutFrame / clock.sampleRate,
      true,
    );

    expect(stopSynchronizedRecordingPlayback(clock.requestId)).toBe(true);
  });

  it('rejects Auto Punch when the frozen locator contract becomes stale during arm', async () => {
    installPunchProject();
    const arm = deferred<void>();
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      punch: PUNCH_CONTRACT,
      signal: new AbortController().signal,
      armCapture: () => arm.promise,
    });
    await flushMicrotasks();

    useStore.setState((state) => ({
      transport: {
        ...state.transport,
        punchOutBeat: PUNCH_OUT_BEAT + 1,
      },
    }));
    arm.resolve(undefined);

    await expect(resultPromise).rejects.toMatchObject({ code: 'stale-request' });
    await flushMicrotasks();
    expect(assetHarness.release).toHaveBeenCalledOnce();
    expect(useStore.getState().transport.phase).toBe('stopped');
  });

  it('rejects Auto Punch locator, armed-track, and target-type mismatches before capture', async () => {
    installPunchProject();
    const armCapture = vi.fn(async () => undefined);

    await expect(startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      punch: {
        ...PUNCH_CONTRACT,
        punchInBeat: PUNCH_IN_BEAT + 1,
      },
      signal: new AbortController().signal,
      armCapture,
    })).rejects.toMatchObject({ code: 'stale-request' });

    await expect(startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      punch: {
        ...PUNCH_CONTRACT,
        targetTrackId: OTHER_AUDIO_TRACK_ID,
      },
      signal: new AbortController().signal,
      armCapture,
    })).rejects.toMatchObject({ code: 'request-rejected' });

    const instrumentTrackId = project.tracks.find(
      (track) => track.type === 'instrument',
    )!.id;
    await expect(startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      punch: {
        ...PUNCH_CONTRACT,
        targetTrackId: instrumentTrackId,
      },
      signal: new AbortController().signal,
      armCapture,
    })).rejects.toMatchObject({ code: 'invalid-start' });

    expect(armCapture).not.toHaveBeenCalled();
    expect(assetHarness.acquire).not.toHaveBeenCalled();
    expect(useStore.getState().transport.phase).toBe('stopped');
  });

  it('hard-stops finite cycle playback at the requested right boundary', async () => {
    useStore.setState((state) => ({
      transport: {
        ...state.transport,
        loopEnabled: true,
        loopStartBeat: 2,
        loopEndBeat: 4,
        positionBeat: 2,
      },
    }));
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _startFrame: number,
      _contextGeneration: number,
      _playbackAnchorFrame?: number,
    ) => undefined);
    const onFiniteCycleComplete = vi.fn();
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      onFiniteCycleComplete,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();
    const [, captureStartFrame, , playbackAnchorFrame] = armCapture.mock.calls[0]!;
    const anchorFrame = captureStartFrame;
    expect(playbackAnchorFrame).toBe(anchorFrame);
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;

    expect(useStore.getState().transport).toMatchObject({
      phase: 'playing',
      loopEnabled: true,
      loopStartBeat: 2,
      loopEndBeat: 4,
      playbackRequestId: clock.requestId,
    });
    expect(clock).toMatchObject({
      anchorBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      cycleEndBeat: 6,
    });
    expect(clock.captureStartContextFrame).toBeUndefined();
    expect(clock.punchEndContextFrame).toBeUndefined();
    expect(clock.punch).toBeUndefined();
    expect(onFiniteCycleComplete).not.toHaveBeenCalled();

    // The empty project defaults to 120 BPM. Two 2-beat passes end two
    // seconds after the synchronized anchor on the scheduler's raw beat axis.
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate + 2;
    await vi.advanceTimersByTimeAsync(25);

    expect(armCapture).toHaveBeenCalledOnce();
    expect(useStore.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      loopEnabled: true,
    });
    expect(useStore.getState().transport.playbackRequestId).not.toBe(clock.requestId);
    expect(onFiniteCycleComplete).toHaveBeenCalledOnce();
    expect(onFiniteCycleComplete).toHaveBeenCalledWith(clock.requestId);
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('does not report finite-cycle completion for a manual stop', async () => {
    useStore.setState((state) => ({
      transport: {
        ...state.transport,
        loopEnabled: true,
        loopStartBeat: 2,
        loopEndBeat: 4,
        positionBeat: 2,
      },
    }));
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _startFrame: number,
      _contextGeneration: number,
    ) => undefined);
    const onFiniteCycleComplete = vi.fn();
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      onFiniteCycleComplete,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();
    const [, anchorFrame] = armCapture.mock.calls[0]!;
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;

    expect(stopSynchronizedRecordingPlayback(clock.requestId)).toBe(true);
    expect(onFiniteCycleComplete).not.toHaveBeenCalled();
    expect(useStore.getState().transport.phase).toBe('stopped');
  });

  it('rejects a frozen cycle when its loop or AudioContext generation changes during arm', async () => {
    useStore.setState((state) => ({
      transport: {
        ...state.transport,
        loopEnabled: true,
        loopStartBeat: 2,
        loopEndBeat: 4,
        positionBeat: 2,
      },
    }));
    const loopArm = deferred<void>();
    const loopAttempt = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      signal: new AbortController().signal,
      armCapture: () => loopArm.promise,
    });
    await flushMicrotasks();
    useStore.setState((state) => ({
      transport: { ...state.transport, loopEndBeat: 5 },
    }));
    loopArm.resolve(undefined);
    await expect(loopAttempt).rejects.toMatchObject({ code: 'stale-request' });
    await flushMicrotasks();
    expect(assetHarness.release).toHaveBeenCalledOnce();

    assetHarness.release.mockClear();
    useStore.setState((state) => ({
      transport: {
        ...state.transport,
        phase: 'stopped',
        loopEnabled: true,
        loopStartBeat: 2,
        loopEndBeat: 4,
        positionBeat: 2,
      },
    }));
    const contextArm = deferred<void>();
    const contextAttempt = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      signal: new AbortController().signal,
      armCapture: () => contextArm.promise,
    });
    await flushMicrotasks();
    engineHarness.generation += 1;
    contextArm.resolve(undefined);
    await expect(contextAttempt).rejects.toMatchObject({ code: 'context-changed' });
    await flushMicrotasks();
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('aborts a never-settling capture arm and releases the decoded lease', async () => {
    const abortController = new AbortController();
    const armCapture = vi.fn(() => new Promise<void>(() => undefined));
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: abortController.signal,
      armCapture,
    });
    await flushMicrotasks();
    expect(armCapture).toHaveBeenCalledOnce();

    abortController.abort();
    await expect(resultPromise).rejects.toMatchObject({ code: 'cancelled' });
    await flushMicrotasks();

    expect(useStore.getState().transport.phase).toBe('stopped');
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('rejects a seek during capture arm as a stale request', async () => {
    const arm = deferred<void>();
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: new AbortController().signal,
      armCapture: () => arm.promise,
    });
    await flushMicrotasks();

    useStore.getState().setPosition(2);
    arm.resolve(undefined);

    await expect(resultPromise).rejects.toMatchObject({ code: 'stale-request' });
    await flushMicrotasks();
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('fails a capture arm that misses its scheduling deadline and releases resources', async () => {
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: new AbortController().signal,
      armCapture: () => new Promise<void>(() => undefined),
    });
    await flushMicrotasks();

    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: 'start-deadline-missed',
    });
    await vi.advanceTimersByTimeAsync(200);
    await rejection;
    await flushMicrotasks();
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('releases a decoded lease when the recording operation becomes stale during decode', async () => {
    const decodedLease = deferred<AudioAssetBufferLease>();
    assetHarness.acquire.mockReturnValue(decodedLease.promise);
    const release = vi.fn();
    const armCapture = vi.fn(async () => undefined);
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();
    expect(assetHarness.acquire).toHaveBeenCalledOnce();

    useStore.setState({ audioRecordingOperationId: operationId + 1 });
    decodedLease.resolve({
      buffersByAssetId: new Map(),
      release,
    });

    await expect(resultPromise).rejects.toMatchObject({ code: 'stale-operation' });
    await flushMicrotasks();
    expect(armCapture).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
