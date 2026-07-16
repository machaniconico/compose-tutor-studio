// Store <-> audio engine bridge.
//
// The store owns transport intent and acknowledges an actual start only after
// this bridge has a running AudioContext and a live scheduler. Every async start
// carries a monotonically increasing request id; late work is disposed instead
// of being allowed to attach itself to a newer play request.

import {
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
  ScheduleEventLimitError,
  type MusicalTimeIndex,
  type Project,
  type Track,
} from '@cts/project-model';
import { useStore } from '../state/store';
import {
  automationBaseValue,
  automationCommandsInWindow,
} from './automation';
import { createNoiseBuffer, DrumVoiceManager } from './drums';
import { getAudioEngine } from './engine';
import { buildScheduleEvents, type SchedulePayload } from './events';
import {
  applyMixState,
  buildTrackGraphs,
  computeAudibleTracks,
  type TrackGraph,
} from './graph';
import { applyMasterMix, hasLiveMixChanged } from './mixState';
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

type RuntimeSession = PlaybackSession & {
  requestId: number;
  scheduler: Scheduler;
  master: GainNode;
  graphs: Map<string, TrackGraph>;
  synths: Map<string, SynthVoiceManager>;
  drums: Map<string, DrumVoiceManager>;
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
  readonly scheduleEvents: readonly ScheduledEvent[];
  readonly everAudibleTrackIds: Set<string>;
  positionTimer: ReturnType<typeof setInterval> | null;
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
  };
  const resolvedEvents = rawEvents.flatMap((event) => {
    const resolved = resolveDrumOccurrence(event, event.beat);
    return resolved ? [resolved] : [];
  });

  return planAudioTail(
    planningProject,
    resolvedEvents,
    startBeat,
    endBeat,
    sampleRate,
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

/** Cancel a finished/cancelled drain's master automation before reusing the engine. */
export function restoreRuntimeMaster(
  master: GainNode,
  tracks: readonly Track[],
  when: number,
): void {
  applyMasterMix(master, tracks, when, 'immediate');
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
    failStart: (requestId, error) => useStore.getState().failPlaybackStart(
      requestId,
      error instanceof ScheduleEventLimitError ? 'event-limit-exceeded' : 'start-failed',
    ),
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

  // Apply mixer changes to the accepted session only. Notes, tempo and loop
  // topology remain snapshots until the next playback request, as before.
  const unsubProject = useStore.subscribe((next, previous) => {
    if (next.project === previous.project) return;
    if (!hasLiveMixChanged(previous.project.tracks, next.project.tracks)) return;
    const session = controller.activeSession;
    if (!session?.scheduler.isRunning) return;
    for (const trackId of computeAudibleTracks(next.project.tracks)) {
      if (session.graphs.has(trackId)) session.everAudibleTrackIds.add(trackId);
    }
    const now = getAudioEngine().now();
    applyMasterMix(session.master, next.project.tracks, now, 'smoothed');
    applyMixState(session.graphs, next.project.tracks, now);
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

/** Build and start one fully isolated render session. */
async function createRuntimeSession(
  requestId: number,
  handlers: PlaybackSessionHandlers,
  isCurrent: () => boolean,
): Promise<RuntimeSession> {
  const engine = getAudioEngine();
  // ensureContext begins synchronously when this async function is invoked.
  const { context, master } = await engine.ensureContext();
  if (!isCurrent()) throw new CancelledPlaybackRequest();
  if (String(context.state) !== 'running') {
    throw new Error(`AudioContext did not enter the running state (${String(context.state)}).`);
  }

  const store = useStore.getState();
  const project = store.project;
  const transport = store.transport;
  const { index: musicalTime, tempo } = createProjectMusicalTime(project);
  const lengthBeats = project.lengthBeats;
  const loop = normalizeTransportLoop(
    transport.loopEnabled,
    transport.loopStartBeat,
    transport.loopEndBeat,
    lengthBeats,
  );
  const transportTempo = loop ? loopBeatTimeMapping(tempo, loop) : tempo;
  const tempoChangeBeats = Object.freeze(
    project.tempoMap.slice(1).map((event) => event.beat),
  );
  const startBeat = transport.positionBeat;
  const now = engine.now();
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
  const synths = new Map<string, SynthVoiceManager>();
  const drums = new Map<string, DrumVoiceManager>();
  let session: RuntimeSession | null = null;
  let unsubscribeContext = () => {};
  let cancelNaturalDrainTimer = () => {};
  let disposed = false;

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
    for (const graph of graphs.values()) {
      try {
        graph.dispose();
      } catch {
        // Dispose every track even if one browser node was already disconnected.
      }
    }
    graphs.clear();
    try {
      // Natural drain fades the shared master only while this generation owns
      // it. Restore the current project value and cancel pending fade events so
      // a later preview or replacement session never inherits silence.
      restoreRuntimeMaster(master, useStore.getState().project.tracks, engine.now());
    } catch {
      // A closed context has no reusable output to restore.
    }
  };

  try {
    applyMasterMix(master, project.tracks, now, 'immediate');
    graphs = buildTrackGraphs(context, master, project.tracks, now, 'live');
    let sharedDrumNoise: AudioBuffer | undefined;
    for (const track of project.tracks) {
      const graph = graphs.get(track.id);
      if (!graph) continue;
      if (track.type === 'drum') {
        sharedDrumNoise ??= createNoiseBuffer(context);
        drums.set(
          track.id,
          new DrumVoiceManager(context, graph.input, sharedDrumNoise),
        );
      } else if (track.type !== 'master') {
        synths.set(
          track.id,
          new SynthVoiceManager(context, graph.input, track.instrument?.preset),
        );
      }
    }

    if (!isCurrent()) throw new CancelledPlaybackRequest();

    let startupAnchorTime: number | null = null;
    const scheduler = new Scheduler({
      clock: () => startupAnchorTime ?? engine.now(),
      fire: (due) => {
        if (session) fireEvents(session, due);
      },
      onScheduleWindow: (window) => {
        if (session) {
          scheduleAutomationForWindow(session, window.startBeat, window.endBeat);
        }
        if (session?.metronomeOn) {
          scheduleMetronomeForWindow(
            session,
            window.startBeat,
            window.endBeat,
            context,
            master,
          );
        }
      },
      onError: () => handlers.onInterrupted(),
      ...(loop ? {} : { onEnd: handlers.onEnd }),
    });

    const anchorTime = engine.now();
    const everAudibleTrackIds = computeAudibleTracks(project.tracks);
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
      );
      const projectEndTime = beatToTime(
        lengthBeats,
        tempo,
        startBeat,
        anchorTime,
      );
      cancelNaturalDrainTimer = beginRuntimeNaturalDrain({
        scheduler,
        output: master,
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
      master,
      graphs,
      synths,
      drums,
      metronomeClicks: new Set(),
      metronomeBeatFrontier: startBeat,
      metronomeOn: transport.metronome,
      musicalTime,
      tempo,
      transportTempo,
      tempoChangeBeats,
      anchorBeat: startBeat,
      anchorTime,
      loop,
      lengthBeats,
      projectSnapshot: project,
      scheduleEvents,
      everAudibleTrackIds,
      positionTimer: null,
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

    const endBeat = loop ? Infinity : lengthBeats;
    startupAnchorTime = anchorTime;
    scheduler.startIndexed(scheduleIndex, tempo, startBeat, endBeat);
    startupAnchorTime = null;
    if (!scheduler.isRunning || String(context.state) !== 'running' || !isCurrent()) {
      throw new CancelledPlaybackRequest();
    }
    startPositionLoop(runtimeSession);
    return runtimeSession;
  } catch (error) {
    disposeResources();
    throw error;
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
  const audible = computeAudibleTracks(liveTracks);

  for (const lane of session.projectSnapshot.automationLanes) {
    const track = tracks.get(lane.target.trackId);
    const graph = session.graphs.get(lane.target.trackId);
    if (!track || !graph) continue;
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
      graph.scheduleAutomation(
        lane.target.type,
        command.value,
        beatToTime(
          command.beat,
          session.transportTempo,
          session.anchorBeat,
          session.anchorTime,
        ),
        command.interpolation,
        audible.has(track.id),
      );
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
    const { transport, setPosition } = useStore.getState();
    if (
      transport.phase !== 'playing' ||
      transport.playbackRequestId !== session.requestId ||
      !session.scheduler.isRunning
    ) {
      return;
    }
    const beat = session.scheduler.currentBeat();
    if (Number.isFinite(beat) && beat >= 0) setPosition(beat);
  }, POSITION_TICK_MS);
}
