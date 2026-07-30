// Store <-> audio engine bridge.
//
// The store owns transport intent and acknowledges an actual start only after
// this bridge has a running AudioContext and a live scheduler. Every async start
// carries a monotonically increasing request id; late work is disposed instead
// of being allowed to attach itself to a newer play request.

import {
  compileAudioRouting,
  effectiveMasterTrackId,
  MAX_AUDIO_TAKES_PER_FOLDER,
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
  ScheduleEventLimitError,
  AUTOMATION_TOUCH_RETURN_SECONDS,
  type AutomationTarget,
  type AudioRouting,
  type CompiledAudioRoutingPlan,
  type MusicalTimeIndex,
  type Project,
  type Track,
} from '@cts/project-model';
import {
  hasPlaybackTopologyChanged,
  useStore,
  type AudioIssue,
} from '../state/store';
import {
  automationBaseValue,
  automationCommandsInWindow,
  automationLaneForTrack,
  automationValueAt,
  isAutomationReadEnabled,
} from './automation';
import {
  acquireProjectAudioBuffers,
  AudioAssetPlaybackError,
  assertProjectAudioAssetCombinedResourceBudget,
  getAudioAssetPlaybackCache,
  preflightProjectAudioAssets,
  projectHasReferencedReadyAudioAssets,
  reserveProjectAudioAssetResourceBudget,
} from './audioAssetResolver';
import {
  acquireAudioClipPlaybackBuffers,
  estimateAudioWarpResourcePeakBytes,
  getAudioClipBufferCache,
  type AudioClipPlaybackBufferLease,
} from './audioClipBuffers';
import { AudioWarpDspError } from './audioWarpDsp';
import { AudioWarpPlanError } from './audioWarpPlan';
import { projectForAudioWarpAudition } from './audioWarpAudition';
import {
  AudioClipPlanLimitError,
  createAudioClipPlaybackIndex,
  planAudioClipTailSources,
  planAudioClipPlaybackWindow,
  type AudioClipPlaybackIndex,
} from './audioClipPlanner';
import { AudioClipVoiceManager } from './audioClipVoice';
import { createNoiseBuffer, DrumVoiceManager } from './drums';
import { getAudioEngine } from './engine';
import { buildScheduleEvents, type SchedulePayload } from './events';
import {
  applyMixState,
  applyReadScalarMixState,
  applyRoutingMixState,
  AudioRoutingGraphError,
  assertRoutingGraphNodeBudget,
  buildTrackGraphs,
  disposeMasterMeter,
  resolveAudioRoutingMix,
  type TrackGraph,
} from './graph';
import {
  hasLiveMixChanged,
  hasLiveRoutingMixChanged,
  resolveMasterMix,
} from './mixState';
import {
  buildSessionMasterGraph,
  type MasterAutomationGraph,
  type SessionMasterGraph,
} from './masterAutomationGraph';
import {
  createProjectMusicalTime,
  mappedBeatDurationSeconds,
} from './musicalTime';
import {
  metronomeMapEvents,
  scheduleMetronomeClick,
  type ScheduledMetronomeClick,
} from './metronome';
import {
  PlaybackController,
  type PlaybackSession,
  type PlaybackSessionHandlers,
} from './playbackController';
import {
  beatToTime,
  createScheduleEventIndex,
  LOOKAHEAD_S,
  loopBeatTimeMapping,
  preflightLoopScheduleDensity,
  resolveDrumOccurrence,
  Scheduler,
  timeToBeat,
  type BeatTimeMapping,
  type DueEvent,
  type LoopRegion,
  type ScheduledEvent,
} from './scheduler';
import { SynthVoiceManager } from './synth';
import {
  DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
  FINAL_TAIL_FADE_SECONDS,
  planAudioTail,
} from './tail';

/** Position update rate while playing (ms ~= 30fps). */
const POSITION_TICK_MS = 33;
/** Web Audio render quanta are fixed at 128 sample-frames. */
export const AUDIO_RENDER_QUANTUM_FRAMES = 128;
/** Leave one lookahead plus browser/worklet acknowledgement headroom. */
export const SYNCHRONIZED_RECORDING_START_LEAD_SECONDS = LOOKAHEAD_S + 0.13;
const SYNCHRONIZED_ANCHOR_POLL_MS = 8;

type RuntimeSession = PlaybackSession & {
  requestId: number;
  scheduler: Scheduler;
  /** Session input/output drain stage, upstream of the persisted Master fader. */
  output: GainNode;
  /** Persisted Master fader; retained as `master` for runtime call-site clarity. */
  master: GainNode;
  /** Application-wide output/calibration stage, held at unity for playback. */
  engineMaster: GainNode;
  masterAutomation: MasterAutomationGraph;
  graphs: Map<string, TrackGraph>;
  synths: Map<string, SynthVoiceManager>;
  drums: Map<string, DrumVoiceManager>;
  audioVoices: Map<string, AudioClipVoiceManager>;
  audioBuffers: AudioClipPlaybackBufferLease;
  readonly audioClipIndex: AudioClipPlaybackIndex;
  metronomeClicks: Set<ScheduledMetronomeClick>;
  metronomeBeatFrontier: number;
  readonly metronomeOn: boolean;
  readonly musicalTime: MusicalTimeIndex;
  readonly tempo: BeatTimeMapping;
  readonly transportTempo: BeatTimeMapping;
  readonly tempoChangeBeats: readonly number[];
  readonly anchorBeat: number;
  readonly anchorTime: number;
  readonly loop: LoopRegion | null;
  readonly lengthBeats: number;
  readonly projectSnapshot: Project;
  readonly contextGeneration: number;
  readonly routingPlan: CompiledAudioRoutingPlan;
  readonly scheduleEvents: readonly ScheduledEvent[];
  readonly everAudibleTrackIds: Set<string>;
  readonly everAudibleEdgeIds: Set<string>;
  positionTimer: ReturnType<typeof setInterval> | null;
  automationCycleBoundaryHandled: boolean;
};

type NaturalDrainControls = Readonly<{
  scheduler: Pick<Scheduler, 'stop'>;
  output: GainNode;
  now: () => number;
  projectEndTime: number;
  tailSeconds: number;
  postLimiterTailSeconds: number;
  stopPositionUpdates: () => void;
  cancelMetronomeClicks: () => void;
  onComplete: () => void;
}>;

type BridgeState = {
  controller: PlaybackController<RuntimeSession> | null;
  unsub: Array<() => void>;
  installed: boolean;
};

const bridge: BridgeState = {
  controller: null,
  unsub: [],
  installed: false,
};

class CancelledPlaybackRequest extends Error {
  constructor() {
    super('Playback request was superseded before audio startup completed.');
    this.name = 'CancelledPlaybackRequest';
  }
}

export type SynchronizedRecordingPlaybackErrorCode =
  | 'bridge-unavailable'
  | 'cancelled'
  | 'capture-arm-failed'
  | 'context-changed'
  | 'invalid-start'
  | 'loop-enabled'
  | 'playback-start-failed'
  | 'request-rejected'
  | 'stale-operation'
  | 'stale-request'
  | 'start-deadline-missed';

export class SynchronizedRecordingPlaybackError extends Error {
  constructor(readonly code: SynchronizedRecordingPlaybackErrorCode) {
    super(code);
    this.name = 'SynchronizedRecordingPlaybackError';
  }
}

export type SynchronizedRecordingPlaybackClock = Readonly<{
  context: AudioContext;
  contextGeneration: number;
  sampleRate: number;
  anchorContextFrame: number;
  anchorBeat: number;
  tempo: BeatTimeMapping;
  requestId: number;
  projectSnapshot: Project;
  /** Present only for a recording-owned finite loop generation. */
  cycle?: SynchronizedRecordingPlaybackCycle;
  /** Unwrapped Nth right boundary where finite cycle playback stops. */
  cycleEndBeat?: number;
  /** Present only for a bounded Auto Punch generation. */
  punch?: SynchronizedRecordingPlaybackPunch;
  /** Exact render frame where the microphone capture begins. */
  captureStartContextFrame?: number;
  /** Exact render frame for the half-open Auto Punch out boundary. */
  punchEndContextFrame?: number;
}>;

export type SynchronizedRecordingPlaybackCycle = Readonly<{
  loopStartBeat: number;
  loopEndBeat: number;
  passCount: number;
}>;

export type SynchronizedRecordingPlaybackPunch = Readonly<{
  targetTrackId: string;
  punchInBeat: number;
  punchOutBeat: number;
  playbackEndBeat: number;
}>;

export type StartSynchronizedRecordingPlaybackOptions = Readonly<{
  operationId: number;
  projectSnapshot: Project;
  startBeat: number;
  signal: AbortSignal;
  /** Frozen finite-cycle contract. Omit for the existing one-shot recording path. */
  cycle?: SynchronizedRecordingPlaybackCycle;
  /** Frozen bounded Auto Punch contract. Mutually exclusive with cycle. */
  punch?: SynchronizedRecordingPlaybackPunch;
  /**
   * Fires synchronously only when the scheduler reaches the requested Nth
   * cycle boundary. Manual stop/interruption never calls it.
   */
  onFiniteCycleComplete?: (requestId: number) => void;
  /** Fires only at the owned natural post-roll boundary. */
  onFinitePunchComplete?: (requestId: number) => void;
  armCapture: (
    context: AudioContext,
    startFrame: number,
    contextGeneration: number,
    playbackAnchorFrame?: number,
  ) => Promise<void>;
}>;

type SynchronizedStartIntent = StartSynchronizedRecordingPlaybackOptions & {
  requestId: number;
  claimed: boolean;
  settled: boolean;
  resolveClock: (clock: SynchronizedRecordingPlaybackClock) => void;
  rejectClock: (error: SynchronizedRecordingPlaybackError) => void;
  clockPromise: Promise<SynchronizedRecordingPlaybackClock>;
  removeAbortListener: () => void;
};

const synchronizedStartIntents = new Map<number, SynchronizedStartIntent>();

function synchronizedError(
  code: SynchronizedRecordingPlaybackErrorCode,
): SynchronizedRecordingPlaybackError {
  return new SynchronizedRecordingPlaybackError(code);
}

function isValidSynchronizedRecordingCycle(
  cycle: SynchronizedRecordingPlaybackCycle,
  projectLengthBeats: number,
): boolean {
  if (
    !Number.isFinite(cycle.loopStartBeat)
    || !Number.isFinite(cycle.loopEndBeat)
    || cycle.loopStartBeat < 0
    || cycle.loopEndBeat <= cycle.loopStartBeat
    || cycle.loopEndBeat > projectLengthBeats
    || !Number.isSafeInteger(cycle.passCount)
    || cycle.passCount < 2
    || cycle.passCount > MAX_AUDIO_TAKES_PER_FOLDER
  ) {
    return false;
  }
  const endBeat = cycle.loopStartBeat
    + (cycle.loopEndBeat - cycle.loopStartBeat) * cycle.passCount;
  return Number.isFinite(endBeat) && endBeat > cycle.loopEndBeat;
}

function isValidSynchronizedRecordingPunch(
  punch: SynchronizedRecordingPlaybackPunch,
  project: Project,
  startBeat: number,
): boolean {
  return (
    typeof punch.targetTrackId === 'string'
    && punch.targetTrackId.length > 0
    && project.tracks.some(
      (track) => track.id === punch.targetTrackId && track.type === 'audio',
    )
    && Number.isFinite(startBeat)
    && Number.isFinite(punch.punchInBeat)
    && Number.isFinite(punch.punchOutBeat)
    && Number.isFinite(punch.playbackEndBeat)
    && startBeat >= 0
    && startBeat <= punch.punchInBeat
    && punch.punchInBeat >= 0
    && punch.punchOutBeat > punch.punchInBeat
    && punch.playbackEndBeat >= punch.punchOutBeat
    && punch.playbackEndBeat <= project.lengthBeats
  );
}

function synchronizedRecordingModeMatchesTransport(
  cycle: SynchronizedRecordingPlaybackCycle | undefined,
  punch: SynchronizedRecordingPlaybackPunch | undefined,
  transport: Readonly<{
    loopEnabled: boolean;
    loopStartBeat: number;
    loopEndBeat: number;
    punchEnabled: boolean;
    punchInBeat: number;
    punchOutBeat: number;
  }>,
): boolean {
  if (cycle && punch) return false;
  if (punch) {
    return !transport.loopEnabled
      && transport.punchEnabled
      && transport.punchInBeat === punch.punchInBeat
      && transport.punchOutBeat === punch.punchOutBeat;
  }
  if (!cycle) return !transport.loopEnabled && !transport.punchEnabled;
  return transport.loopEnabled
    && !transport.punchEnabled
    && transport.loopStartBeat === cycle.loopStartBeat
    && transport.loopEndBeat === cycle.loopEndBeat;
}

export function synchronizedRecordingCycleEndBeat(
  cycle: SynchronizedRecordingPlaybackCycle,
): number {
  return cycle.loopStartBeat
    + (cycle.loopEndBeat - cycle.loopStartBeat) * cycle.passCount;
}

/**
 * Claim a loop's half-open right boundary only after its capture pass commits.
 * A rejected CAS stays unclaimed so the next scheduler tick can retry the same
 * recoverable runtime pass; a successful claim suppresses second-loop repeats.
 */
export function finalizeAutomationCycleBoundaryOnce(
  alreadyHandled: boolean,
  boundaryCrossed: boolean,
  finalize: () => boolean,
): boolean {
  if (alreadyHandled || !boundaryCrossed) return alreadyHandled;
  return finalize();
}

function rejectSynchronizedIntent(
  intent: SynchronizedStartIntent,
  error: SynchronizedRecordingPlaybackError,
): void {
  if (intent.settled) return;
  intent.settled = true;
  intent.rejectClock(error);
}

function resolveSynchronizedIntent(
  intent: SynchronizedStartIntent,
  clock: SynchronizedRecordingPlaybackClock,
): void {
  if (intent.settled) return;
  intent.settled = true;
  intent.resolveClock(clock);
}

function classifySynchronizedIntentFailure(
  intent: SynchronizedStartIntent,
  requestId: number,
  error: unknown,
): SynchronizedRecordingPlaybackError {
  if (error instanceof SynchronizedRecordingPlaybackError) return error;
  if (intent.signal.aborted) return synchronizedError('cancelled');
  const state = useStore.getState();
  if (
    state.project !== intent.projectSnapshot
    || state.audioRecordingOperationId !== intent.operationId
  ) {
    return synchronizedError('stale-operation');
  }
  if (
    state.transport.playbackRequestId !== requestId
    || state.transport.phase !== 'starting'
    || state.transport.positionBeat !== intent.startBeat
  ) {
    return synchronizedError('stale-request');
  }
  if (!synchronizedRecordingModeMatchesTransport(
    intent.cycle,
    intent.punch,
    state.transport,
  )) {
    return synchronizedError(
      intent.cycle || intent.punch ? 'stale-request' : 'loop-enabled',
    );
  }
  return synchronizedError('playback-start-failed');
}

function takeSynchronizedStartIntent(requestId: number): SynchronizedStartIntent | null {
  const intent = synchronizedStartIntents.get(requestId) ?? null;
  if (!intent) return null;
  synchronizedStartIntents.delete(requestId);
  intent.claimed = true;
  return intent;
}

/** Pick a future, render-quantum-aligned frame without using a wall clock. */
export function planSynchronizedRecordingStartFrame(
  currentContextTime: number,
  sampleRate: number,
): number {
  if (
    !Number.isFinite(currentContextTime)
    || currentContextTime < 0
    || !Number.isSafeInteger(sampleRate)
    || sampleRate <= 0
  ) {
    throw synchronizedError('invalid-start');
  }
  const currentFrame = Math.ceil(currentContextTime * sampleRate);
  const leadFrames = Math.ceil(SYNCHRONIZED_RECORDING_START_LEAD_SECONDS * sampleRate);
  const candidate = currentFrame + leadFrames;
  const aligned = Math.ceil(candidate / AUDIO_RENDER_QUANTUM_FRAMES)
    * AUDIO_RENDER_QUANTUM_FRAMES;
  if (!Number.isSafeInteger(currentFrame) || !Number.isSafeInteger(aligned)) {
    throw synchronizedError('invalid-start');
  }
  return aligned;
}

function assertSynchronizedIntentCurrent(
  intent: SynchronizedStartIntent,
  context: AudioContext,
  contextGeneration: number,
  isCurrent: () => boolean,
): void {
  if (intent.signal.aborted) throw synchronizedError('cancelled');
  const state = useStore.getState();
  if (
    !isCurrent()
    || state.transport.playbackRequestId !== intent.requestId
    || state.transport.phase !== 'starting'
    || state.transport.positionBeat !== intent.startBeat
  ) {
    throw synchronizedError('stale-request');
  }
  if (
    state.project !== intent.projectSnapshot
    || state.audioRecordingOperationId !== intent.operationId
  ) {
    throw synchronizedError('stale-operation');
  }
  if (!synchronizedRecordingModeMatchesTransport(
    intent.cycle,
    intent.punch,
    state.transport,
  )) {
    throw synchronizedError(
      intent.cycle || intent.punch ? 'stale-request' : 'loop-enabled',
    );
  }
  const engine = getAudioEngine();
  if (
    engine.audioContext !== context
    || engine.contextGeneration !== contextGeneration
    || String(context.state) !== 'running'
  ) {
    throw synchronizedError('context-changed');
  }
}

async function waitForSynchronizedAnchor(
  intent: SynchronizedStartIntent,
  context: AudioContext,
  contextGeneration: number,
  anchorTime: number,
  isCurrent: () => boolean,
): Promise<void> {
  for (;;) {
    assertSynchronizedIntentCurrent(intent, context, contextGeneration, isCurrent);
    const remainingSeconds = anchorTime - context.currentTime;
    if (remainingSeconds <= 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.max(1, Math.min(SYNCHRONIZED_ANCHOR_POLL_MS, remainingSeconds * 1_000)),
      );
    });
  }
}

async function armSynchronizedCapture(
  intent: SynchronizedStartIntent,
  context: AudioContext,
  anchorContextFrame: number,
  captureStartContextFrame: number,
  contextGeneration: number,
): Promise<void> {
  const deadlineSeconds = (
    anchorContextFrame / context.sampleRate
    - context.currentTime
    - LOOKAHEAD_S
  );
  if (intent.signal.aborted) throw synchronizedError('cancelled');
  if (deadlineSeconds <= 0) throw synchronizedError('start-deadline-missed');

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let removeAbortListener = (): void => undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(synchronizedError('cancelled'));
    intent.signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => intent.signal.removeEventListener('abort', onAbort);
    if (intent.signal.aborted) onAbort();
    deadlineTimer = setTimeout(
      () => reject(synchronizedError('start-deadline-missed')),
      Math.max(1, deadlineSeconds * 1_000),
    );
  });

  let captureArm: Promise<void>;
  try {
    captureArm = intent.armCapture(
      context,
      captureStartContextFrame,
      contextGeneration,
      anchorContextFrame,
    );
  } catch {
    removeAbortListener();
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    throw synchronizedError('capture-arm-failed');
  }

  try {
    await Promise.race([captureArm, guard]);
  } catch (error) {
    if (error instanceof SynchronizedRecordingPlaybackError) throw error;
    throw synchronizedError('capture-arm-failed');
  } finally {
    removeAbortListener();
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

function waitForSynchronizedPlaybackConfirmation(
  intent: SynchronizedStartIntent,
  clock: SynchronizedRecordingPlaybackClock,
): Promise<SynchronizedRecordingPlaybackClock> {
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let finished = false;
    const finish = (
      value?: SynchronizedRecordingPlaybackClock,
      error?: SynchronizedRecordingPlaybackError,
    ): void => {
      if (finished) return;
      finished = true;
      unsubscribe();
      if (pollTimer !== null) clearInterval(pollTimer);
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(synchronizedError('playback-start-failed'));
    };
    const inspect = (): void => {
      if (intent.signal.aborted) {
        finish(undefined, synchronizedError('cancelled'));
        return;
      }
      if (!bridge.installed || bridge.controller === null) {
        finish(undefined, synchronizedError('bridge-unavailable'));
        return;
      }
      const state = useStore.getState();
      if (
        state.project !== intent.projectSnapshot
        || state.audioRecordingOperationId !== intent.operationId
      ) {
        finish(undefined, synchronizedError('stale-operation'));
        return;
      }
      if (!synchronizedRecordingModeMatchesTransport(
        intent.cycle,
        intent.punch,
        state.transport,
      )) {
        finish(
          undefined,
          synchronizedError(
            intent.cycle || intent.punch ? 'stale-request' : 'loop-enabled',
          ),
        );
        return;
      }
      if (state.transport.positionBeat !== intent.startBeat) {
        finish(undefined, synchronizedError('stale-request'));
        return;
      }
      if (
        state.transport.phase === 'playing'
        && state.transport.playbackRequestId === clock.requestId
      ) {
        finish(clock);
        return;
      }
      if (
        state.transport.playbackRequestId !== clock.requestId
        || state.transport.phase === 'stopped'
      ) {
        finish(undefined, synchronizedError('playback-start-failed'));
      }
    };
    unsubscribe = useStore.subscribe(inspect);
    // Bridge teardown itself is not a Zustand transition. A small bounded poll
    // closes that otherwise silent race while startup is awaiting confirmation.
    pollTimer = setInterval(inspect, SYNCHRONIZED_ANCHOR_POLL_MS);
    inspect();
  });
}

/** Map bounded startup failures to the transport issue vocabulary. */
export function classifyPlaybackStartFailure(
  error: unknown,
): Exclude<AudioIssue, 'interrupted' | null> {
  if (error instanceof ScheduleEventLimitError || error instanceof AudioClipPlanLimitError) {
    return 'event-limit-exceeded';
  }
  if (error instanceof AudioAssetPlaybackError) {
    if (error.code === 'asset-missing') return 'audio-asset-missing';
    if (error.code === 'asset-changed') return 'audio-asset-changed';
    if (error.code === 'decode-failed') return 'audio-decode-failed';
    if (error.code === 'resource-limit') return 'audio-resource-limit';
    if (error.code === 'resolver-unavailable' || error.code === 'asset-unavailable') {
      return 'audio-asset-unavailable';
    }
  }
  if (error instanceof AudioRoutingGraphError && error.code === 'graph-node-limit') {
    return 'audio-resource-limit';
  }
  if (error instanceof AudioWarpDspError) {
    return error.code === 'resource-limit'
      ? 'audio-resource-limit'
      : 'audio-warp-failed';
  }
  if (error instanceof AudioWarpPlanError) {
    return error.code === 'resource-limit'
      ? 'audio-resource-limit'
      : 'audio-warp-failed';
  }
  return 'start-failed';
}

/** File-state failures should refresh the store's runtime availability evidence. */
export function shouldRefreshAudioAssetIssuesAfterFailure(error: unknown): boolean {
  return error instanceof AudioAssetPlaybackError && (
    error.code === 'asset-missing' ||
    error.code === 'asset-changed' ||
    error.code === 'asset-unavailable'
  );
}

/**
 * Resolve persisted transport loop state into a scheduler-safe region.
 * Invalid enabled bounds intentionally recover to the whole song so the loop
 * control remains useful even for older projects that stored the 0..0 default.
 */
export function normalizeTransportLoop(
  enabled: boolean,
  startBeat: number,
  endBeat: number,
  projectLength: number,
): LoopRegion | null {
  if (!enabled || !Number.isFinite(projectLength) || projectLength <= 0) {
    return null;
  }
  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat)) {
    return { startBeat: 0, endBeat: projectLength };
  }

  const safeStart = Math.min(projectLength, Math.max(0, startBeat));
  const safeEnd = Math.min(projectLength, Math.max(0, endBeat));
  return safeEnd > safeStart
    ? { startBeat: safeStart, endBeat: safeEnd }
    : { startBeat: 0, endBeat: projectLength };
}

/**
 * Build the live-session tail plan from its immutable schedule snapshot.
 *
 * Effects may be edited while the session is active, so effects from the latest
 * matching track id are merged in. Audibility is conservative: once a track has
 * fed the live graph, muting it at the boundary must not erase delay/reverb
 * energy that is already circulating through that graph.
 */
export function planRuntimeAudioTail(
  projectSnapshot: Project,
  latestTracks: readonly Track[],
  rawEvents: readonly ScheduledEvent[],
  startBeat: number,
  endBeat: number,
  everAudibleTrackIds: ReadonlySet<string>,
  sampleRate: number = DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
  everAudibleEdgeIds?: ReadonlySet<string>,
  latestAudioRouting: AudioRouting = projectSnapshot.audioRouting,
): ReturnType<typeof planAudioTail> {
  const latestById = new Map(latestTracks.map((track) => [track.id, track]));
  const planningTracks = projectSnapshot.tracks.map((snapshotTrack) => {
    const latestTrack = latestById.get(snapshotTrack.id);
    const effects = latestTrack?.effects ?? snapshotTrack.effects;
    if (snapshotTrack.type === 'master') {
      return { ...snapshotTrack, effects };
    }
    return {
      ...snapshotTrack,
      effects,
      mute: !everAudibleTrackIds.has(snapshotTrack.id),
      solo: false,
    };
  });
  const planningProject: Project = {
    ...projectSnapshot,
    tracks: planningTracks,
    audioRouting: latestAudioRouting,
  };
  const resolvedEvents = rawEvents.flatMap((event) => {
    const resolved = resolveDrumOccurrence(event, event.beat);
    return resolved ? [resolved] : [];
  });
  const { tempo } = createProjectMusicalTime(planningProject);
  const audioSources = planAudioClipTailSources(planningProject, {
    startBeat,
    endBeat,
    tempo,
  });

  const compiled = compileAudioRouting(planningProject);
  if (!compiled.ok) {
    const first = compiled.errors[0];
    throw new Error(
      `Audio routing is invalid.${first ? ` ${first.path}: ${first.message}` : ''}`,
    );
  }
  const currentMix = resolveAudioRoutingMix(planningProject, compiled.plan);

  return planAudioTail(
    planningProject,
    resolvedEvents,
    startBeat,
    endBeat,
    sampleRate,
    audioSources,
    {
      plan: compiled.plan,
      audibleChannelIds: everAudibleTrackIds,
      activeEdgeIds: everAudibleEdgeIds ?? currentMix.activeEdgeIds,
    },
  );
}

/**
 * Stop transport-owned controls and leave the audio graph connected until its
 * absolute tail deadline. The returned cancellation is used by manual stop,
 * supersession, context interruption, and bridge disposal.
 */
export function beginRuntimeNaturalDrain(controls: NaturalDrainControls): () => void {
  controls.scheduler.stop();
  controls.stopPositionUpdates();
  controls.cancelMetronomeClicks();

  const now = controls.now();
  const safeTailSeconds = Number.isFinite(controls.tailSeconds)
    ? Math.max(0, controls.tailSeconds)
    : 0;
  const cleanupDeadline = controls.projectEndTime + safeTailSeconds;
  const safePostLimiterTailSeconds = Number.isFinite(controls.postLimiterTailSeconds)
    ? Math.min(safeTailSeconds, Math.max(0, controls.postLimiterTailSeconds))
    : 0;
  const fadeEndTime = cleanupDeadline - safePostLimiterTailSeconds;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const complete = (): void => {
    if (settled) return;
    settled = true;
    timer = null;
    controls.onComplete();
  };

  if (!Number.isFinite(now) || !Number.isFinite(cleanupDeadline) || cleanupDeadline <= now) {
    complete();
    return () => {
      settled = true;
    };
  }

  if (safeTailSeconds > 0) {
    const fadeStartTime = Math.max(now, fadeEndTime - FINAL_TAIL_FADE_SECONDS);
    const fadeFromValue = Number.isFinite(controls.output.gain.value)
      ? controls.output.gain.value
      : 1;
    controls.output.gain.cancelScheduledValues(fadeStartTime);
    if (fadeEndTime <= fadeStartTime) {
      controls.output.gain.setValueAtTime(0, fadeStartTime);
    } else {
      controls.output.gain.setValueAtTime(fadeFromValue, fadeStartTime);
      controls.output.gain.linearRampToValueAtTime(0, fadeEndTime);
    }
  }

  timer = setTimeout(
    complete,
    Math.ceil((cleanupDeadline - now) * 1_000),
  );
  return () => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/**
 * Dispose audio captured from an obsolete Project topology, including a
 * naturally draining session whose transport is already stopped.
 */
export function stopRuntimePlaybackForProjectTopologyChange(
  previousProject: Project,
  nextProject: Project,
  stop: () => void,
): boolean {
  if (!hasPlaybackTopologyChanged(previousProject, nextProject)) return false;
  stop();
  return true;
}

type RuntimeStopTransportSnapshot = Readonly<{
  phase: 'stopped' | 'starting' | 'playing';
  playbackRequestId: number;
}>;

/**
 * Whether the transport subscription owns disposal for the same atomic store
 * publication. Project topology remains the owner when an already-stopped
 * transport may still have a naturally draining session.
 */
export function transportTransitionOwnsRuntimeStop(
  previous: RuntimeStopTransportSnapshot,
  next: RuntimeStopTransportSnapshot,
): boolean {
  return next.phase === 'stopped'
    && (
      previous.phase !== next.phase
      || previous.playbackRequestId !== next.playbackRequestId
    );
}

/** Capture commits keep the exact frozen playback generation and natural tail alive. */
export function automationCaptureCommitPreservesRuntimeSession(
  previousRequestId: number,
  nextRequestId: number,
  captureCommitRequestId: number | null,
): boolean {
  return captureCommitRequestId !== null
    && captureCommitRequestId === previousRequestId
    && previousRequestId === nextRequestId;
}

/** A target-scoped Read scalar commit keeps the same playback generation. */
export function automationReadScalarCommitPreservesRuntimeSession(
  previousRequestId: number,
  nextRequestId: number,
  marker: Readonly<{ playbackRequestId: number }> | null,
): boolean {
  return marker !== null
    && marker.playbackRequestId === previousRequestId
    && previousRequestId === nextRequestId;
}

function effectiveMasterTrack(project: Project): Track | null {
  const trackId = effectiveMasterTrackId(project);
  return trackId === null
    ? null
    : project.tracks.find((track) => track.id === trackId) ?? null;
}

function isEffectiveMasterVolumeTarget(
  project: Project,
  target: AutomationTarget,
): boolean {
  const master = effectiveMasterTrack(project);
  return master !== null
    && target.trackId === master.id
    && target.type === 'track-volume';
}

function hasEnabledMasterVolumeLane(project: Project): boolean {
  const master = effectiveMasterTrack(project);
  if (!master) return false;
  const lane = automationLaneForTrack(
    project.automationLanes,
    master.id,
    'track-volume',
  );
  return lane !== null
    && isAutomationReadEnabled(project.automationReadState, lane);
}

function applyRuntimeReadScalarMixState(
  session: RuntimeSession,
  project: Project,
  targets: readonly AutomationTarget[],
  when: number,
): boolean {
  const master = effectiveMasterTrack(project);
  const targetsForMasterId = master
    ? targets.filter((target) => target.trackId === master.id)
    : [];
  const masterTargets = targets.filter((target) =>
    isEffectiveMasterVolumeTarget(project, target));
  const trackTargets = targets.filter((target) =>
    !isEffectiveMasterVolumeTarget(project, target));

  if (targetsForMasterId.length !== masterTargets.length) return false;
  if (masterTargets.length > 0) {
    if (hasEnabledMasterVolumeLane(project)) {
      return false;
    }
    if (session.masterAutomation.isAutomationOverridden(when)) {
      throw new Error('A manual automation override owns the Master fader.');
    }
  }

  if (!applyReadScalarMixState(
    session.graphs,
    project,
    trackTargets,
    when,
    session.routingPlan,
  )) {
    return false;
  }

  if (masterTargets.length > 0) {
    if (
      !master
      || !session.masterAutomation.applyScalar(master.volume, when, 'smoothed')
    ) {
      throw new Error('The live Master fader is unavailable.');
    }
  }
  return true;
}

function replaceRuntimePlaybackAtCurrentPosition(
  playbackRequestId: number,
  exactPositionBeat: number,
): boolean {
  const before = useStore.getState();
  if (
    before.transport.phase === 'stopped'
    || before.transport.playbackRequestId !== playbackRequestId
    || !Number.isFinite(exactPositionBeat)
    || exactPositionBeat < 0
  ) {
    return false;
  }
  before.updatePlaybackPosition(playbackRequestId, exactPositionBeat);
  const synchronized = useStore.getState();
  if (
    synchronized.transport.phase !== 'playing'
    || synchronized.transport.playbackRequestId !== playbackRequestId
    || synchronized.transport.positionBeat !== exactPositionBeat
  ) {
    return false;
  }
  synchronized.interruptPlayback(playbackRequestId, 'interrupted');
  const stopped = useStore.getState();
  if (
    stopped.transport.phase !== 'stopped'
    || stopped.transport.playbackRequestId === playbackRequestId
    || stopped.transport.positionBeat !== exactPositionBeat
  ) {
    return false;
  }
  stopped.play();
  const replacement = useStore.getState().transport;
  return replacement.phase === 'starting'
    && replacement.positionBeat === exactPositionBeat;
}

/**
 * Install the store subscriptions. Idempotent — safe to call from multiple
 * component mounts. Returns a teardown function owned by the first caller.
 */
export function initAudioBridge(): () => void {
  if (bridge.installed) {
    return () => {
      /* already installed; teardown is owned by the first caller */
    };
  }
  bridge.installed = true;

  const controller = new PlaybackController<RuntimeSession>({
    getRequestState: () => {
      const { transport } = useStore.getState();
      return {
        phase: transport.phase,
        requestId: transport.playbackRequestId,
      };
    },
    createSession: (requestId, handlers, isCurrent) =>
      createRuntimeSession(requestId, handlers, isCurrent),
    confirmStarted: (requestId) => useStore.getState().confirmPlaybackStarted(requestId),
    failStart: (requestId, error) => {
      const store = useStore.getState();
      store.failPlaybackStart(requestId, classifyPlaybackStartFailure(error));
      if (shouldRefreshAudioAssetIssuesAfterFailure(error)) {
        void store.refreshAudioAssetIssues();
      }
    },
    finish: (requestId) => useStore.getState().finishPlayback(requestId),
    interrupt: (requestId) => useStore.getState().interruptPlayback(requestId),
  });
  bridge.controller = controller;

  // React to transport intent. Invoking requestStart synchronously is important:
  // AudioContext construction stays inside the originating click/key gesture.
  const unsubTransport = useStore.subscribe((next, previous) => {
    const current = next.transport;
    const prior = previous.transport;
    if (
      current.phase === prior.phase &&
      current.playbackRequestId === prior.playbackRequestId
    ) {
      return;
    }
    controller.reconcile({
      phase: current.phase,
      requestId: current.playbackRequestId,
    });
  });

  // Dispose sessions captured from obsolete topology, including a natural
  // drain whose transport already reached stopped. Apply compatible mixer
  // changes to the accepted running session only.
  const unsubProject = useStore.subscribe((next, previous) => {
    if (next.project === previous.project) return;
    if (automationCaptureCommitPreservesRuntimeSession(
      previous.transport.playbackRequestId,
      next.transport.playbackRequestId,
      next.automationRecordingCommitRequestId,
    )) {
      // The active pass intentionally keeps playing its frozen session snapshot.
      // This also preserves an already-started natural tail.
      return;
    }
    if (automationReadScalarCommitPreservesRuntimeSession(
      previous.transport.playbackRequestId,
      next.transport.playbackRequestId,
      next.automationReadScalarCommit,
    )) {
      const session = controller.activeSession;
      if (!session?.scheduler.isRunning) return;
      try {
        const applied = applyRuntimeReadScalarMixState(
          session,
          next.project,
          next.automationReadScalarCommit!.targets,
          getAudioEngine().now(),
        );
        if (!applied) {
          const replaced = replaceRuntimePlaybackAtCurrentPosition(
            next.transport.playbackRequestId,
            session.scheduler.currentBeat(),
          );
          if (!replaced) {
            const current = useStore.getState();
            current.interruptPlayback(
              current.transport.playbackRequestId,
              'interrupted',
            );
          }
        }
      } catch {
        useStore.getState().interruptPlayback(
          next.transport.playbackRequestId,
          'audio-resource-limit',
        );
      }
      return;
    }
    // commitProject moves an active/starting transport to stopped before store
    // subscribers run. In that case unsubTransport already owns the single
    // controller stop. The Project subscriber remains responsible for a
    // topology change while transport is already stopped, notably a natural
    // drain whose graph still owns audible tail resources.
    const transportStopOwnsInvalidation = transportTransitionOwnsRuntimeStop(
      previous.transport,
      next.transport,
    );
    if (
      stopRuntimePlaybackForProjectTopologyChange(
        previous.project,
        next.project,
        () => {
          if (!transportStopOwnsInvalidation) controller.stop();
        },
      )
    ) {
      return;
    }
    const trackMixChanged = hasLiveMixChanged(
      previous.project.tracks,
      next.project.tracks,
    );
    const routingMixChanged = hasLiveRoutingMixChanged(
      previous.project.audioRouting,
      next.project.audioRouting,
    );
    if (!trackMixChanged && !routingMixChanged) return;
    const previousMasterMix = resolveMasterMix(previous.project.tracks);
    const nextMasterMix = resolveMasterMix(next.project.tracks);
    const masterMixChanged = previousMasterMix.trackId !== nextMasterMix.trackId
      || previousMasterMix.gain !== nextMasterMix.gain;
    const session = controller.activeSession;
    if (!session?.scheduler.isRunning) return;
    if (masterMixChanged && hasEnabledMasterVolumeLane(next.project)) {
      // Changing the base scalar changes the value before the first point and
      // after loop wrap. Rebuild from the accepted Project instead of
      // cancelling just part of the frozen Master lookahead.
      useStore.getState().interruptPlayback(
        next.transport.playbackRequestId,
        'interrupted',
      );
      return;
    }
    try {
      // Effect edits are live updates, so they must satisfy the same static-node
      // budget as startup before Master or any channel is mutated.
      if (trackMixChanged) {
        assertRoutingGraphNodeBudget(next.project, session.routingPlan, 'live');
      }
      const routingMix = resolveAudioRoutingMix(next.project, session.routingPlan);
      for (const trackId of routingMix.audibleChannelIds) {
        if (session.graphs.has(trackId)) {
          session.everAudibleTrackIds.add(trackId);
        }
      }
      for (const edgeId of routingMix.activeEdgeIds) {
        session.everAudibleEdgeIds.add(edgeId);
      }
      const now = getAudioEngine().now();
      if (
        masterMixChanged
        && !session.masterAutomation.applyScalar(
          nextMasterMix.gain,
          now,
          'smoothed',
        )
      ) {
        throw new Error('A manual automation override owns the Master fader.');
      }
      if (trackMixChanged) {
        applyMixState(session.graphs, next.project, now, session.routingPlan);
      } else {
        applyRoutingMixState(
          session.graphs,
          next.project,
          now,
          session.routingPlan,
          routingMix,
        );
      }
    } catch {
      // The Project change remains adopted and undoable, but the old session no
      // longer matches it. Stop and dispose the whole graph instead of exposing
      // a partially rebuilt mix or throwing out of the store subscriber.
      useStore.getState().interruptPlayback(
        next.transport.playbackRequestId,
        'audio-resource-limit',
      );
    }
  });

  bridge.unsub = [unsubTransport, unsubProject];
  controller.reconcile();

  return () => {
    for (const unsubscribe of bridge.unsub) unsubscribe();
    bridge.unsub = [];
    bridge.installed = false;
    controller.dispose();
    if (bridge.controller === controller) bridge.controller = null;
  };
}

/**
 * Dispose active or naturally draining runtime audio before an exclusive
 * non-transport operation reuses the shared Master graph.
 */
export function stopRuntimePlaybackAudio(): void {
  bridge.controller?.stop();
}

/**
 * Start one transport generation whose playback and microphone capture share
 * an exact future AudioContext frame.
 *
 * The store performs the operation/loop/position transition atomically. This
 * layer owns the realtime preparation, render-thread arm acknowledgement and
 * confirmation barrier at the selected context frame.
 */
export function startSynchronizedRecordingPlayback(
  options: StartSynchronizedRecordingPlaybackOptions,
): Promise<SynchronizedRecordingPlaybackClock> {
  const state = useStore.getState();
  if (options.signal.aborted) {
    return Promise.reject(synchronizedError('cancelled'));
  }
  if (
    state.project !== options.projectSnapshot
    || state.audioRecordingOperationId !== options.operationId
  ) {
    return Promise.reject(synchronizedError('stale-operation'));
  }
  if (
    (options.cycle !== undefined && options.punch !== undefined)
    || (
      options.cycle
      && (
        !isValidSynchronizedRecordingCycle(
          options.cycle,
          options.projectSnapshot.lengthBeats,
        )
        || options.startBeat !== options.cycle.loopStartBeat
      )
    )
    || (
      options.punch
      && !isValidSynchronizedRecordingPunch(
        options.punch,
        options.projectSnapshot,
        options.startBeat,
      )
    )
  ) {
    return Promise.reject(synchronizedError('invalid-start'));
  }
  if (!synchronizedRecordingModeMatchesTransport(
    options.cycle,
    options.punch,
    state.transport,
  )) {
    return Promise.reject(
      synchronizedError(
        options.cycle || options.punch ? 'stale-request' : 'loop-enabled',
      ),
    );
  }
  if (
    !Number.isFinite(options.startBeat)
    || options.startBeat < 0
    || options.startBeat >= options.projectSnapshot.lengthBeats
  ) {
    return Promise.reject(synchronizedError('invalid-start'));
  }
  if (state.transport.phase !== 'stopped') {
    return Promise.reject(synchronizedError('request-rejected'));
  }
  if (!bridge.installed || bridge.controller === null) {
    return Promise.reject(synchronizedError('bridge-unavailable'));
  }

  const expectedRequestId = state.transport.playbackRequestId + 1;
  const frozenCycle = options.cycle
    ? Object.freeze({ ...options.cycle })
    : undefined;
  const frozenPunch = options.punch
    ? Object.freeze({ ...options.punch })
    : undefined;
  let resolveClock!: (clock: SynchronizedRecordingPlaybackClock) => void;
  let rejectClock!: (error: SynchronizedRecordingPlaybackError) => void;
  const clockPromise = new Promise<SynchronizedRecordingPlaybackClock>((resolve, reject) => {
    resolveClock = resolve;
    rejectClock = reject;
  });
  const intent: SynchronizedStartIntent = {
    ...options,
    ...(frozenCycle ? { cycle: frozenCycle } : {}),
    ...(frozenPunch ? { punch: frozenPunch } : {}),
    requestId: expectedRequestId,
    claimed: false,
    settled: false,
    resolveClock,
    rejectClock,
    clockPromise,
    removeAbortListener: () => undefined,
  };
  synchronizedStartIntents.set(expectedRequestId, intent);

  const requestId = state.startAudioRecordingPlayback(
    options.operationId,
    options.startBeat,
    frozenCycle,
    frozenPunch,
  );
  if (requestId !== expectedRequestId) {
    synchronizedStartIntents.delete(expectedRequestId);
    if (requestId !== null) stopSynchronizedRecordingPlayback(requestId);
    rejectSynchronizedIntent(intent, synchronizedError('request-rejected'));
    return clockPromise;
  }

  // Zustand subscribers run before the action returns. The bridge therefore
  // must have claimed this intent synchronously; otherwise no controller owns
  // the accepted transport generation and the promise could never settle.
  if (!intent.claimed) {
    synchronizedStartIntents.delete(requestId);
    stopSynchronizedRecordingPlayback(requestId);
    rejectSynchronizedIntent(intent, synchronizedError('bridge-unavailable'));
    return clockPromise;
  }

  const onAbort = (): void => {
    synchronizedStartIntents.delete(requestId);
    rejectSynchronizedIntent(intent, synchronizedError('cancelled'));
    stopSynchronizedRecordingPlayback(requestId);
    if (!intent.claimed) intent.removeAbortListener();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  intent.removeAbortListener = () => options.signal.removeEventListener('abort', onAbort);
  if (options.signal.aborted) onAbort();

  return clockPromise.then((clock) =>
    waitForSynchronizedPlaybackConfirmation(intent, clock)
  ).catch((error: unknown) => {
    stopSynchronizedRecordingPlayback(requestId);
    if (!intent.claimed) intent.removeAbortListener();
    throw error;
  });
}

/** Stop only the exact synchronized playback generation named by the caller. */
export function stopSynchronizedRecordingPlayback(requestId: number): boolean {
  if (!Number.isSafeInteger(requestId) || requestId < 0) return false;
  const state = useStore.getState();
  if (
    state.transport.phase === 'stopped'
    || state.transport.playbackRequestId !== requestId
  ) {
    return false;
  }
  state.stop();
  const stopped = useStore.getState().transport;
  return stopped.phase === 'stopped' && stopped.playbackRequestId !== requestId;
}

/** Reserve startup atomically through verified decoded lease acquisition. */
export async function acquireRuntimeProjectAudioBuffers(
  project: Project,
  context: AudioContext,
  isCurrent: () => boolean,
): Promise<AudioClipPlaybackBufferLease> {
  const audioAssetCache = getAudioAssetPlaybackCache();
  const derivedCache = getAudioClipBufferCache();
  // Only active leases and in-flight decodes survive; reclaimable LRU entries
  // cannot create a false process-level reservation failure.
  audioAssetCache.clearUnused();
  if (!projectHasReferencedReadyAudioAssets(project)) {
    const source = await acquireProjectAudioBuffers({ assets: [], estimatedDecodedBytes: 0 }, context, {
      cache: audioAssetCache,
    });
    return acquireAudioClipPlaybackBuffers(
      project,
      { assets: [], estimatedDecodedBytes: 0 },
      source,
      context,
    );
  }

  const retainedDecodedBytes = audioAssetCache.retainedDecodedBytes;
  let warpResources = estimateAudioWarpResourcePeakBytes(project, derivedCache);
  const estimate = assertProjectAudioAssetCombinedResourceBudget(
    project,
    context.sampleRate,
    retainedDecodedBytes,
    warpResources.estimatedPeakBytes,
  );
  const reservation = reserveProjectAudioAssetResourceBudget(
    project,
    estimate.estimatedPeakBytes - warpResources.retainedDerivedBytes,
  );
  try {
    const preparedAudio = await preflightProjectAudioAssets(project, {
      cache: audioAssetCache,
      targetSampleRate: context.sampleRate,
    });
    // Cache state can change while resolver I/O is pending. Recompute and
    // atomically resize before decode/Worker allocation; retained cache PCM
    // already owns its own shared-ledger reservation.
    warpResources = estimateAudioWarpResourcePeakBytes(project, derivedCache);
    const currentEstimate = assertProjectAudioAssetCombinedResourceBudget(
      project,
      context.sampleRate,
      retainedDecodedBytes,
      warpResources.estimatedPeakBytes,
    );
    reservation.resize(
      currentEstimate.estimatedPeakBytes - warpResources.retainedDerivedBytes,
    );
    if (!isCurrent()) throw new CancelledPlaybackRequest();
    if (String(context.state) !== 'running') {
      throw new Error(`AudioContext left the running state (${String(context.state)}).`);
    }
    const sourceBuffers = await acquireProjectAudioBuffers(preparedAudio, context, {
      cache: audioAssetCache,
    });
    if (!isCurrent()) {
      sourceBuffers.release();
      throw new CancelledPlaybackRequest();
    }
    const generation = useStore.getState().transport.playbackRequestId;
    const audioBuffers = await acquireAudioClipPlaybackBuffers(
      project,
      preparedAudio,
      sourceBuffers,
      context,
      {
        cache: derivedCache,
        resourceBudget: reservation,
        generation,
        currentGeneration: () => useStore.getState().transport.playbackRequestId,
      },
    );
    if (!isCurrent()) {
      audioBuffers.release();
      throw new CancelledPlaybackRequest();
    }
    // The active decoded lease is now visible through retainedDecodedBytes, so
    // subsequent live/WAV/import reservations will include it directly.
    reservation.release();
    return audioBuffers;
  } catch (error) {
    reservation.release();
    throw error;
  }
}

/** Build and start one fully isolated render session. */
async function createRuntimeSession(
  requestId: number,
  handlers: PlaybackSessionHandlers,
  isCurrent: () => boolean,
): Promise<RuntimeSession> {
  const synchronizedIntent = takeSynchronizedStartIntent(requestId);
  try {
    return await createRuntimeSessionImpl(
      requestId,
      handlers,
      isCurrent,
      synchronizedIntent,
    );
  } catch (error) {
    if (synchronizedIntent) {
      rejectSynchronizedIntent(
        synchronizedIntent,
        classifySynchronizedIntentFailure(synchronizedIntent, requestId, error),
      );
      synchronizedIntent.removeAbortListener();
    }
    throw error;
  }
}

async function createRuntimeSessionImpl(
  requestId: number,
  handlers: PlaybackSessionHandlers,
  isCurrent: () => boolean,
  synchronizedIntent: SynchronizedStartIntent | null,
): Promise<RuntimeSession> {
  const initialStore = useStore.getState();
  const persistedProject = initialStore.project;
  const project = synchronizedIntent
    ? persistedProject
    : projectForAudioWarpAudition(
        persistedProject,
        initialStore.audioWarpAuditionClipId,
      );
  const transport = initialStore.transport;
  if (synchronizedIntent) {
    if (synchronizedIntent.signal.aborted) throw synchronizedError('cancelled');
    if (
      persistedProject !== synchronizedIntent.projectSnapshot
      || initialStore.audioRecordingOperationId !== synchronizedIntent.operationId
    ) {
      throw synchronizedError('stale-operation');
    }
    if (
      transport.phase !== 'starting'
      || transport.playbackRequestId !== requestId
      || transport.positionBeat !== synchronizedIntent.startBeat
    ) {
      throw synchronizedError('stale-request');
    }
    if (!synchronizedRecordingModeMatchesTransport(
      synchronizedIntent.cycle,
      synchronizedIntent.punch,
      transport,
    )) {
      throw synchronizedError(
        synchronizedIntent.cycle || synchronizedIntent.punch
          ? 'stale-request'
          : 'loop-enabled',
      );
    }
  }
  const engine = getAudioEngine();
  const compiledRouting = compileAudioRouting(project);
  if (!compiledRouting.ok) {
    const first = compiledRouting.errors[0];
    throw new Error(
      `Audio routing is invalid.${first ? ` ${first.path}: ${first.message}` : ''}`,
    );
  }
  const routingPlan = compiledRouting.plan;
  assertRoutingGraphNodeBudget(project, routingPlan, 'live');
  // Context activation must begin in the originating click/key stack. Asset
  // I/O is asynchronous, so live playback starts this promise immediately and
  // still withholds every TrackGraph/source until preflight and decode succeed.
  // WAV export has no gesture constraint and preflights before OfflineContext.
  const contextActivation = engine.ensureContext();
  void contextActivation.catch(() => {
    // The authoritative rejection is awaited below if this request survives.
  });
  const {
    context,
    master: engineMaster,
    contextGeneration,
  } = await contextActivation;
  if (!isCurrent()) throw new CancelledPlaybackRequest();
  if (String(context.state) !== 'running') {
    throw new Error(`AudioContext did not enter the running state (${String(context.state)}).`);
  }
  if (synchronizedIntent) {
    assertSynchronizedIntentCurrent(
      synchronizedIntent,
      context,
      contextGeneration,
      isCurrent,
    );
  }

  const { index: musicalTime, tempo } = createProjectMusicalTime(project);
  const lengthBeats = project.lengthBeats;
  const loop = normalizeTransportLoop(
    transport.loopEnabled,
    transport.loopStartBeat,
    transport.loopEndBeat,
    lengthBeats,
  );
  if (
    synchronizedIntent?.cycle
    && (
      loop === null
      || loop.startBeat !== synchronizedIntent.cycle.loopStartBeat
      || loop.endBeat !== synchronizedIntent.cycle.loopEndBeat
    )
  ) {
    throw synchronizedError('stale-request');
  }
  const transportTempo = loop ? loopBeatTimeMapping(tempo, loop) : tempo;
  const tempoChangeBeats = Object.freeze(
    project.tempoMap.slice(1).map((event) => event.beat),
  );
  // Audio Clip regions are immutable for this playback generation. Compile
  // and bound them once; 25 ms scheduler ticks perform only indexed overlap
  // queries and never rebuild the full project region list.
  const audioClipIndex = createAudioClipPlaybackIndex(project, { tempo });
  // Build and budget the immutable schedule before allocating per-track Web
  // Audio graphs. Oversized linked projects fail closed at this boundary.
  const scheduleEvents: readonly ScheduledEvent[] = buildScheduleEvents(project);
  const scheduleIndex = createScheduleEventIndex(scheduleEvents, loop);
  if (loop) {
    const density = preflightLoopScheduleDensity(
      scheduleIndex,
      RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
      MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
    );
    if (!density.ok) {
      throw new ScheduleEventLimitError(
        density.limit,
        density.observed,
        'density',
        density.windowStartBeat,
      );
    }
  }

  let graphs = new Map<string, TrackGraph>();
  let sessionMasterGraph: SessionMasterGraph | null = null;
  const synths = new Map<string, SynthVoiceManager>();
  const drums = new Map<string, DrumVoiceManager>();
  const audioVoices = new Map<string, AudioClipVoiceManager>();
  const audioBuffers = await acquireRuntimeProjectAudioBuffers(project, context, isCurrent);
  // Byte I/O and decode may have taken long enough for non-topological state
  // to change without superseding this request. Adopt the latest mix, seek
  // position, and metronome value only after the final await. Loop/topology
  // edits increment the request id and have already failed isCurrent above.
  const startupStore = useStore.getState();
  if (startupStore.project.id !== project.id || !isCurrent()) {
    audioBuffers.release();
    throw new CancelledPlaybackRequest();
  }
  if (synchronizedIntent) {
    try {
      assertSynchronizedIntentCurrent(
        synchronizedIntent,
        context,
        contextGeneration,
        isCurrent,
      );
      if (
        startupStore.project !== persistedProject
        || startupStore.transport.positionBeat !== synchronizedIntent.startBeat
      ) {
        throw synchronizedError('stale-operation');
      }
    } catch (error) {
      audioBuffers.release();
      throw error;
    }
  }
  const startupTracks = startupStore.project.tracks;
  const startupTransport = startupStore.transport;
  const startBeat = (
    Number.isFinite(startupTransport.positionBeat) &&
    startupTransport.positionBeat >= 0 &&
    startupTransport.positionBeat < lengthBeats
  ) ? startupTransport.positionBeat : 0;
  if (synchronizedIntent && startBeat !== synchronizedIntent.startBeat) {
    audioBuffers.release();
    throw synchronizedError('stale-request');
  }
  const metronomeOn = startupTransport.metronome;
  const now = engine.now();
  let session: RuntimeSession | null = null;
  let unsubscribeContext = () => {};
  let cancelNaturalDrainTimer = () => {};
  let disposed = false;
  const automationOwnership = Object.freeze({
    projectId: project.id,
    activationId: initialStore.saveState.activationId,
    playbackRequestId: requestId,
  });
  let automationRuntimeAttached = false;

  const stopPositionUpdates = (): void => {
    if (session?.positionTimer != null) {
      clearInterval(session.positionTimer);
      session.positionTimer = null;
    }
  };

  const cancelMetronomeClicks = (): void => {
    for (const click of session?.metronomeClicks ?? []) click.cancel();
    session?.metronomeClicks.clear();
  };

  const disposeResources = (): void => {
    if (disposed) return;
    disposed = true;
    if (automationRuntimeAttached) {
      automationRuntimeAttached = false;
      useStore.getState().detachAutomationPlaybackRuntime(automationOwnership);
    }
    synchronizedIntent?.removeAbortListener();
    cancelNaturalDrainTimer();
    cancelNaturalDrainTimer = () => {};
    unsubscribeContext();
    unsubscribeContext = () => {};
    stopPositionUpdates();
    session?.scheduler.stop();
    cancelMetronomeClicks();
    for (const synth of synths.values()) {
      try {
        synth.dispose();
      } catch {
        // A closed output device must not prevent the remaining graph cleanup.
      }
    }
    synths.clear();
    for (const drum of drums.values()) {
      try {
        drum.dispose();
      } catch {
        // Dispose every scheduled drum even if one source is already stopped.
      }
    }
    drums.clear();
    for (const voice of audioVoices.values()) {
      try {
        voice.dispose();
      } catch {
        // Dispose every AudioBufferSource even after an output interruption.
      }
    }
    audioVoices.clear();
    audioBuffers.release();
    for (const graph of graphs.values()) {
      try {
        graph.dispose();
      } catch {
        // Dispose every track even if one browser node was already disconnected.
      }
    }
    graphs.clear();
    if (sessionMasterGraph) {
      disposeMasterMeter(sessionMasterGraph.master);
    }
    sessionMasterGraph?.dispose();
    sessionMasterGraph = null;
  };

  try {
    sessionMasterGraph = buildSessionMasterGraph(
      context,
      engineMaster,
      resolveMasterMix(startupTracks).gain,
      now,
    );
    const runtimeOutput = sessionMasterGraph.output;
    const runtimeMasterFader = sessionMasterGraph.master;
    const runtimeMasterAutomation = sessionMasterGraph.automation;
    graphs = buildTrackGraphs(context, runtimeOutput, {
      ...project,
      tracks: startupTracks,
      audioRouting: startupStore.project.audioRouting,
    }, now, 'live', routingPlan, undefined, runtimeMasterFader);
    let sharedDrumNoise: AudioBuffer | undefined;
    for (const track of startupTracks) {
      const graph = graphs.get(track.id);
      if (!graph) continue;
      if (track.type === 'drum') {
        sharedDrumNoise ??= createNoiseBuffer(context);
        drums.set(
          track.id,
          new DrumVoiceManager(context, graph.input, sharedDrumNoise),
        );
      } else if (track.type === 'instrument') {
        synths.set(
          track.id,
          new SynthVoiceManager(context, graph.input, track.instrument?.preset),
        );
      } else if (track.type === 'audio') {
        audioVoices.set(track.id, new AudioClipVoiceManager(context, graph.input));
      }
    }

    if (!isCurrent()) throw new CancelledPlaybackRequest();

    let startupAnchorTime: number | null = null;
    const schedulerEnd = synchronizedIntent?.cycle || synchronizedIntent?.punch
      ? (): void => {
          try {
            if (synchronizedIntent.cycle) {
              synchronizedIntent.onFiniteCycleComplete?.(requestId);
            } else {
              synchronizedIntent.onFinitePunchComplete?.(requestId);
            }
          } catch {
            // Completion observers are advisory and cannot turn a proven
            // scheduler boundary into an interruption.
          }
          handlers.onEnd();
        }
      : handlers.onEnd;
    const scheduler = new Scheduler({
      clock: () => startupAnchorTime ?? engine.now(),
      fire: (due) => {
        if (session) fireEvents(session, due);
      },
      onScheduleWindow: (window) => {
        if (session) {
          scheduleAudioForWindow(session, window.startBeat, window.endBeat);
          scheduleAutomationForWindow(session, window.startBeat, window.endBeat);
        }
        if (session?.metronomeOn) {
          scheduleMetronomeForWindow(
            session,
            window.startBeat,
            window.endBeat,
            context,
            runtimeOutput,
          );
        }
      },
      onError: () => handlers.onInterrupted(),
      ...(loop && !synchronizedIntent?.cycle && !synchronizedIntent?.punch
        ? {}
        : { onEnd: schedulerEnd }),
    });

    let anchorTime = engine.now();
    let synchronizedClock: SynchronizedRecordingPlaybackClock | null = null;
    if (synchronizedIntent) {
      assertSynchronizedIntentCurrent(
        synchronizedIntent,
        context,
        contextGeneration,
        isCurrent,
      );
      const anchorContextFrame = planSynchronizedRecordingStartFrame(
        context.currentTime,
        context.sampleRate,
      );
      let captureStartContextFrame = anchorContextFrame;
      let punchEndContextFrame: number | undefined;
      if (synchronizedIntent.punch) {
        const punchInOffsetSeconds =
          tempo.beatToSeconds(synchronizedIntent.punch.punchInBeat)
          - tempo.beatToSeconds(startBeat);
        const punchOutOffsetSeconds =
          tempo.beatToSeconds(synchronizedIntent.punch.punchOutBeat)
          - tempo.beatToSeconds(startBeat);
        const punchInOffsetFrames = Math.round(
          punchInOffsetSeconds * context.sampleRate,
        );
        const punchOutOffsetFrames = Math.round(
          punchOutOffsetSeconds * context.sampleRate,
        );
        if (
          !Number.isFinite(punchInOffsetSeconds)
          || !Number.isFinite(punchOutOffsetSeconds)
          || punchInOffsetSeconds < 0
          || punchOutOffsetSeconds <= punchInOffsetSeconds
          || !Number.isSafeInteger(punchInOffsetFrames)
          || !Number.isSafeInteger(punchOutOffsetFrames)
          || punchOutOffsetFrames <= punchInOffsetFrames
          || !Number.isSafeInteger(anchorContextFrame + punchInOffsetFrames)
          || !Number.isSafeInteger(anchorContextFrame + punchOutOffsetFrames)
        ) {
          throw synchronizedError('invalid-start');
        }
        captureStartContextFrame = anchorContextFrame + punchInOffsetFrames;
        punchEndContextFrame = anchorContextFrame + punchOutOffsetFrames;
      }
      anchorTime = anchorContextFrame / context.sampleRate;
      await armSynchronizedCapture(
        synchronizedIntent,
        context,
        anchorContextFrame,
        captureStartContextFrame,
        contextGeneration,
      );
      assertSynchronizedIntentCurrent(
        synchronizedIntent,
        context,
        contextGeneration,
        isCurrent,
      );
      const currentContextFrame = Math.ceil(context.currentTime * context.sampleRate);
      const minimumScheduleLeadFrames = Math.ceil(LOOKAHEAD_S * context.sampleRate);
      if (anchorContextFrame - currentContextFrame < minimumScheduleLeadFrames) {
        throw synchronizedError('start-deadline-missed');
      }
      synchronizedClock = Object.freeze({
        context,
        contextGeneration,
        sampleRate: context.sampleRate,
        anchorContextFrame,
        ...(synchronizedIntent.punch
          ? { captureStartContextFrame, punchEndContextFrame }
          : {}),
        anchorBeat: startBeat,
        tempo,
        requestId,
        projectSnapshot: project,
        ...(synchronizedIntent.cycle
          ? {
            cycle: synchronizedIntent.cycle,
            cycleEndBeat: synchronizedRecordingCycleEndBeat(synchronizedIntent.cycle),
          }
          : {}),
        ...(synchronizedIntent.punch
          ? { punch: synchronizedIntent.punch }
          : {}),
      });
    }
    const startupRoutingMix = resolveAudioRoutingMix(startupStore.project, routingPlan);
    if (synchronizedIntent?.punch && synchronizedClock) {
      const targetGraph = graphs.get(synchronizedIntent.punch.targetTrackId);
      if (!targetGraph) throw synchronizedError('stale-request');
      const {
        captureStartContextFrame,
        punchEndContextFrame,
      } = synchronizedClock;
      if (
        captureStartContextFrame === undefined
        || punchEndContextFrame === undefined
      ) {
        throw synchronizedError('invalid-start');
      }
      targetGraph.schedulePunchAudibility(
        captureStartContextFrame / context.sampleRate,
        punchEndContextFrame / context.sampleRate,
        startupRoutingMix.audibleChannelIds.has(
          synchronizedIntent.punch.targetTrackId,
        ),
      );
    }
    const everAudibleTrackIds = new Set(startupRoutingMix.audibleChannelIds);
    const everAudibleEdgeIds = new Set(startupRoutingMix.activeEdgeIds);
    let naturalDrainStarted = false;

    const beginNaturalDrain = (onComplete: () => void): void => {
      if (naturalDrainStarted) return;
      naturalDrainStarted = true;
      if (!session || disposed) {
        onComplete();
        return;
      }

      const latestProject = useStore.getState().project;
      const latestTracks = latestProject.id === project.id
        ? latestProject.tracks
        : project.tracks;
      const tail = planRuntimeAudioTail(
        project,
        latestTracks,
        scheduleEvents,
        startBeat,
        lengthBeats,
        everAudibleTrackIds,
        context.sampleRate,
        everAudibleEdgeIds,
        latestProject.id === project.id
          ? latestProject.audioRouting
          : project.audioRouting,
      );
      const projectEndTime = beatToTime(
        lengthBeats,
        tempo,
        startBeat,
        anchorTime,
      );
      cancelNaturalDrainTimer = beginRuntimeNaturalDrain({
        scheduler,
        output: runtimeOutput,
        now: () => engine.now(),
        projectEndTime,
        tailSeconds: tail.tailSeconds,
        postLimiterTailSeconds: tail.postLimiterTailSeconds,
        stopPositionUpdates,
        cancelMetronomeClicks,
        onComplete,
      });
    };

    const runtimeSession: RuntimeSession = {
      requestId,
      scheduler,
      output: runtimeOutput,
      master: runtimeMasterFader,
      engineMaster,
      masterAutomation: runtimeMasterAutomation,
      graphs,
      synths,
      drums,
      audioVoices,
      audioBuffers,
      audioClipIndex,
      metronomeClicks: new Set(),
      metronomeBeatFrontier: startBeat,
      metronomeOn,
      musicalTime,
      tempo,
      transportTempo,
      tempoChangeBeats,
      anchorBeat: startBeat,
      anchorTime,
      loop,
      lengthBeats,
      projectSnapshot: project,
      contextGeneration,
      routingPlan,
      scheduleEvents,
      everAudibleTrackIds,
      everAudibleEdgeIds,
      positionTimer: null,
      automationCycleBoundaryHandled: false,
      ...(loop ? {} : { beginNaturalDrain }),
      isReady: () =>
        !disposed &&
        scheduler.isRunning &&
        engine.audioContext === context &&
        String(context.state) === 'running',
      dispose: disposeResources,
    };
    session = runtimeSession;

    unsubscribeContext = engine.subscribeStateChange((contextState) => {
      // Ignore notifications from a replacement context after this generation
      // has lost ownership of the engine.
      if (engine.audioContext === context && contextState !== 'running') {
        handlers.onInterrupted();
      }
    });

    const endBeat = synchronizedIntent?.cycle
      ? synchronizedRecordingCycleEndBeat(synchronizedIntent.cycle)
      : synchronizedIntent?.punch
        ? synchronizedIntent.punch.playbackEndBeat
      : loop
        ? Infinity
        : lengthBeats;
    if (synchronizedIntent && synchronizedClock) {
      assertSynchronizedIntentCurrent(
        synchronizedIntent,
        context,
        contextGeneration,
        isCurrent,
      );
      if (context.currentTime >= anchorTime) {
        throw synchronizedError('start-deadline-missed');
      }
    }
    startupAnchorTime = anchorTime;
    try {
      scheduler.startIndexedAt(scheduleIndex, tempo, startBeat, endBeat, anchorTime);
    } finally {
      startupAnchorTime = null;
    }
    if (!scheduler.isRunning || String(context.state) !== 'running' || !isCurrent()) {
      throw new CancelledPlaybackRequest();
    }
    const automationGraphBridge = {
      beginOverride: (target: AutomationTarget, value: number): void => {
        if (isEffectiveMasterVolumeTarget(project, target)) {
          runtimeMasterAutomation.beginAutomationOverride(value, engine.now());
          return;
        }
        const graph = graphs.get(target.trackId);
        if (!graph) throw new CancelledPlaybackRequest();
        graph.beginAutomationOverride(
          target.type,
          value,
          engine.now(),
          startupRoutingMix.audibleChannelIds.has(target.trackId),
        );
      },
      updateOverride: (target: AutomationTarget, value: number): void => {
        if (isEffectiveMasterVolumeTarget(project, target)) {
          runtimeMasterAutomation.updateAutomationOverride(value, engine.now());
          return;
        }
        const graph = graphs.get(target.trackId);
        if (!graph) throw new CancelledPlaybackRequest();
        graph.updateAutomationOverride(
          target.type,
          value,
          engine.now(),
          startupRoutingMix.audibleChannelIds.has(target.trackId),
        );
      },
      releaseTouchOverride: (
        target: AutomationTarget,
        releaseBeat: number,
      ): void => {
        const returnBeat = tempo.secondsToBeat(
          tempo.beatToSeconds(releaseBeat) + AUTOMATION_TOUCH_RETURN_SECONDS,
        );
        if (isEffectiveMasterVolumeTarget(project, target)) {
          runtimeMasterAutomation.releaseAutomationOverride(
            frozenAutomationValueAt(project, target, returnBeat),
            engine.now(),
            AUTOMATION_TOUCH_RETURN_SECONDS,
          );
        } else {
          const graph = graphs.get(target.trackId);
          if (!graph) throw new CancelledPlaybackRequest();
          graph.releaseAutomationOverride(
            target.type,
            frozenAutomationValueAt(project, target, returnBeat),
            engine.now(),
            AUTOMATION_TOUCH_RETURN_SECONDS,
            startupRoutingMix.audibleChannelIds.has(target.trackId),
          );
        }
        scheduleAutomationTargetForWindow(
          runtimeSession,
          target,
          returnBeat,
          timeToBeat(
            engine.now() + AUTOMATION_TOUCH_RETURN_SECONDS + LOOKAHEAD_S,
            runtimeSession.transportTempo,
            runtimeSession.anchorBeat,
            runtimeSession.anchorTime,
          ),
        );
      },
      resumeOverride: (target: AutomationTarget, resumeBeat: number): void => {
        if (isEffectiveMasterVolumeTarget(project, target)) {
          runtimeMasterAutomation.releaseAutomationOverride(
            frozenAutomationValueAt(project, target, resumeBeat),
            engine.now(),
            0.010,
          );
        } else {
          const graph = graphs.get(target.trackId);
          if (!graph) return;
          graph.releaseAutomationOverride(
            target.type,
            frozenAutomationValueAt(project, target, resumeBeat),
            engine.now(),
            0.010,
            startupRoutingMix.audibleChannelIds.has(target.trackId),
          );
        }
        scheduleAutomationTargetForWindow(
          runtimeSession,
          target,
          resumeBeat,
          timeToBeat(
            engine.now() + 0.010 + LOOKAHEAD_S,
            runtimeSession.transportTempo,
            runtimeSession.anchorBeat,
            runtimeSession.anchorTime,
          ),
        );
      },
    };
    if (!useStore.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => scheduler.currentBeat(),
      automationGraphBridge,
    )) {
      throw new CancelledPlaybackRequest();
    }
    automationRuntimeAttached = true;
    if (synchronizedIntent && synchronizedClock) {
      await waitForSynchronizedAnchor(
        synchronizedIntent,
        context,
        contextGeneration,
        anchorTime,
        isCurrent,
      );
      resolveSynchronizedIntent(synchronizedIntent, synchronizedClock);
    }
    startPositionLoop(runtimeSession);
    return runtimeSession;
  } catch (error) {
    disposeResources();
    throw error;
  }
}

/** Schedule interval sources, including clips already active at a resumed window. */
function scheduleAudioForWindow(
  session: RuntimeSession,
  windowStartBeat: number,
  windowEndBeat: number,
): void {
  const plans = planAudioClipPlaybackWindow(session.projectSnapshot, {
    windowStartBeat,
    windowEndBeat,
    tempo: session.tempo,
    transportLoop: session.loop,
    index: session.audioClipIndex,
  });
  for (const plan of plans) {
    const voice = session.audioVoices.get(plan.trackId);
    const buffer = session.audioBuffers.bufferForPlan(plan);
    if (!voice) {
      throw new AudioAssetPlaybackError(
        'asset-unavailable',
        plan.assetId,
        'The Audio Clip track output is unavailable.',
      );
    }
    if (!buffer) {
      throw new AudioAssetPlaybackError(
        'asset-missing',
        plan.assetId,
        'A preflighted Audio Clip buffer is unavailable.',
      );
    }
    voice.schedule(
      plan,
      buffer,
      beatToTime(
        plan.startBeat,
        session.transportTempo,
        session.anchorBeat,
        session.anchorTime,
      ),
    );
  }
}

/** Schedule a batch of due note/drum events for one generation only. */
function fireEvents(session: RuntimeSession, due: DueEvent[]): void {
  for (const event of due) {
    const payload = event.payload as SchedulePayload;
    if (payload.kind === 'note') {
      const synth = session.synths.get(payload.trackId);
      synth?.noteOn(
        payload.pitch,
        event.time,
        mappedBeatDurationSeconds(
          session.transportTempo,
          timeToBeat(
            event.time,
            session.transportTempo,
            session.anchorBeat,
            session.anchorTime,
          ),
          payload.durationBeats,
        ),
        payload.velocity,
      );
    } else {
      session.drums
        .get(payload.trackId)
        ?.trigger(payload.lane, event.time, payload.velocity, payload.voiceSeed);
    }
  }
}

function frozenAutomationValueAt(
  project: Project,
  target: AutomationTarget,
  beat: number,
): number {
  const track = project.tracks.find((candidate) => candidate.id === target.trackId);
  if (!track) return target.type === 'track-volume' ? 1 : 0;
  const baseValue = automationBaseValue(track, target);
  const lane = automationLaneForTrack(
    project.automationLanes,
    target.trackId,
    target.type,
  );
  return lane && isAutomationReadEnabled(project.automationReadState, lane)
    ? automationValueAt(lane, baseValue, beat)
    : baseValue;
}

/** Rebuild only one target's cancelled lookahead after manual ownership ends. */
function scheduleAutomationTargetForWindow(
  session: RuntimeSession,
  target: AutomationTarget,
  windowStartBeat: number,
  windowEndBeat: number,
): void {
  if (!(windowEndBeat > windowStartBeat)) return;
  const lane = automationLaneForTrack(
    session.projectSnapshot.automationLanes,
    target.trackId,
    target.type,
  );
  const track = session.projectSnapshot.tracks.find(
    (candidate) => candidate.id === target.trackId,
  );
  const isMasterTarget = isEffectiveMasterVolumeTarget(
    session.projectSnapshot,
    target,
  );
  const graph = session.graphs.get(target.trackId);
  if (
    !lane
    || !track
    || (!isMasterTarget && !graph)
    || !isAutomationReadEnabled(session.projectSnapshot.automationReadState, lane)
  ) {
    return;
  }
  const latestProject = useStore.getState().project;
  const routingProject = latestProject.id === session.projectSnapshot.id
    ? latestProject
    : session.projectSnapshot;
  const audible = resolveAudioRoutingMix(routingProject, session.routingPlan)
    .audibleChannelIds.has(target.trackId);
  for (const command of automationCommandsInWindow(
    lane,
    automationBaseValue(track, target),
    windowStartBeat,
    windowEndBeat,
    session.loop,
    false,
    session.tempoChangeBeats,
  )) {
    const when = beatToTime(
      command.beat,
      session.transportTempo,
      session.anchorBeat,
      session.anchorTime,
    );
    if (isMasterTarget) {
      session.masterAutomation.scheduleAutomation(
        command.value,
        when,
        command.interpolation,
      );
    } else {
      graph!.scheduleAutomation(
        target.type,
        command.value,
        when,
        command.interpolation,
        audible,
      );
    }
  }
}

function scheduleAutomationForWindow(
  session: RuntimeSession,
  windowStartBeat: number,
  windowEndBeat: number,
): void {
  const latestProject = useStore.getState().project;
  const liveTracks = latestProject.id === session.projectSnapshot.id
    ? latestProject.tracks
    : session.projectSnapshot.tracks;
  const tracks = new Map(liveTracks.map((track) => [track.id, track]));
  const liveRoutingProject = latestProject.id === session.projectSnapshot.id
    ? latestProject
    : session.projectSnapshot;
  const audible = resolveAudioRoutingMix(liveRoutingProject, session.routingPlan)
    .audibleChannelIds;

  for (const lane of session.projectSnapshot.automationLanes) {
    if (!isAutomationReadEnabled(session.projectSnapshot.automationReadState, lane)) continue;
    const track = tracks.get(lane.target.trackId);
    const isMasterTarget = isEffectiveMasterVolumeTarget(
      session.projectSnapshot,
      lane.target,
    );
    const graph = session.graphs.get(lane.target.trackId);
    if (!track || (!isMasterTarget && !graph)) continue;
    const commands = automationCommandsInWindow(
      lane,
      automationBaseValue(track, lane.target),
      windowStartBeat,
      windowEndBeat,
      session.loop,
      session.loop === null && windowEndBeat >= session.projectSnapshot.lengthBeats,
      session.tempoChangeBeats,
    );
    for (const command of commands) {
      const when = beatToTime(
        command.beat,
        session.transportTempo,
        session.anchorBeat,
        session.anchorTime,
      );
      if (isMasterTarget) {
        session.masterAutomation.scheduleAutomation(
          command.value,
          when,
          command.interpolation,
        );
      } else {
        graph!.scheduleAutomation(
          lane.target.type,
          command.value,
          when,
          command.interpolation,
          audible.has(track.id),
        );
      }
    }
  }
}

function scheduleMetronomeForWindow(
  session: RuntimeSession,
  windowStartBeat: number,
  windowEndBeat: number,
  context: AudioContext,
  master: GainNode,
): void {
  if (windowEndBeat <= windowStartBeat) return;
  const scheduleStartBeat = Math.max(windowStartBeat, session.metronomeBeatFrontier);
  const horizonBeat = Math.max(windowEndBeat, session.metronomeBeatFrontier);
  const clicks = metronomeMapEvents(
    session.musicalTime,
    scheduleStartBeat,
    horizonBeat,
    session.loop,
  );
  for (const click of clicks) {
    const time = beatToTime(
      click.beat,
      session.transportTempo,
      session.anchorBeat,
      session.anchorTime,
    );
    let scheduled: ScheduledMetronomeClick | null = null;
    scheduled = scheduleMetronomeClick(context, master, time, click.accent, () => {
      if (scheduled) session.metronomeClicks.delete(scheduled);
    });
    session.metronomeClicks.add(scheduled);
  }
  session.metronomeBeatFrontier = horizonBeat;
}

function startPositionLoop(session: RuntimeSession): void {
  if (session.positionTimer != null) clearInterval(session.positionTimer);
  session.positionTimer = setInterval(() => {
    const {
      transport,
      updatePlaybackPosition,
      finalizeAutomationRecording,
    } = useStore.getState();
    if (
      transport.phase !== 'playing' ||
      transport.playbackRequestId !== session.requestId ||
      !session.scheduler.isRunning
    ) {
      return;
    }
    const beat = session.scheduler.currentBeat();
    if (Number.isFinite(beat) && beat >= 0) {
      if (session.loop && !session.automationCycleBoundaryHandled) {
        const unwrappedBeat = timeToBeat(
          getAudioEngine().now(),
          session.transportTempo,
          session.anchorBeat,
          session.anchorTime,
        );
        if (unwrappedBeat >= session.loop.endBeat) {
          session.automationCycleBoundaryHandled =
            finalizeAutomationCycleBoundaryOnce(
              session.automationCycleBoundaryHandled,
              true,
              () => finalizeAutomationRecording(
                'cycle-right-locator',
                session.loop!.endBeat,
              ),
            );
        }
      }
      updatePlaybackPosition(session.requestId, beat);
    }
  }, POSITION_TICK_MS);
}
