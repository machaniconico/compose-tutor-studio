// Store <-> audio engine bridge.
//
// Design (documented): the Zustand store stays fully decoupled from the audio
// layer — it never imports anything under src/audio. Instead the transport UI
// calls `initAudioBridge()` once on mount, which subscribes to the store and
// drives the engine in response to state changes:
//
//   transport.isPlaying  false->true  => startPlayback()
//                        true ->false  => stopAudio()
//   project / mixer changes            => live volume/pan/mute/solo update
//
// The bridge writes transport.positionBeat back to the store ~30fps while
// playing so the playhead UI tracks the audio clock. The store owns play/stop
// *intent* and the position semantics (see store.stop(reset?)); this bridge owns
// the actual audio lifecycle.

import { useStore } from '../state/store';
import { getAudioEngine } from './engine';
import { buildScheduleEvents, type SchedulePayload } from './events';
import { applyMixState, buildTrackGraphs, type TrackGraph } from './graph';
import {
  beatToTime,
  projectLengthBeats,
  Scheduler,
  secondsPerBeat,
  type DueEvent,
  type LoopRegion,
  type ScheduledEvent,
} from './scheduler';
import { DrumVoiceManager } from './drums';
import { SynthVoiceManager } from './synth';
import { metronomeBeatEvents, scheduleMetronomeClick } from './metronome';

/** Position update rate while playing (ms ~= 30fps). */
const POSITION_TICK_MS = 33;

/** Mutable bridge state held at module scope (singleton, like the engine). */
type BridgeState = {
  scheduler: Scheduler | null;
  graphs: Map<string, TrackGraph>;
  synths: Map<string, SynthVoiceManager>;
  drums: Map<string, DrumVoiceManager>;
  /** Metronome clicks already scheduled up to this beat (exclusive). */
  metronomeBeatFrontier: number;
  metronomeOn: boolean;
  beatsPerBar: number;
  bpm: number;
  anchorBeat: number;
  anchorTime: number;
  loop: LoopRegion | null;
  positionTimer: ReturnType<typeof setInterval> | null;
  /** Unsubscribe handles. */
  unsub: Array<() => void>;
  installed: boolean;
};

const state: BridgeState = {
  scheduler: null,
  graphs: new Map(),
  synths: new Map(),
  drums: new Map(),
  metronomeBeatFrontier: 0,
  metronomeOn: false,
  beatsPerBar: 4,
  bpm: 120,
  anchorBeat: 0,
  anchorTime: 0,
  loop: null,
  positionTimer: null,
  unsub: [],
  installed: false,
};

/**
 * Install the store subscriptions. Idempotent — safe to call from multiple
 * component mounts. Returns a teardown function.
 */
export function initAudioBridge(): () => void {
  if (state.installed) {
    return () => {
      /* already installed; teardown is owned by the first caller */
    };
  }
  state.installed = true;

  // React to play/stop intent.
  const unsubPlaying = useStore.subscribe((s, prev) => {
    if (s.transport.isPlaying === prev.transport.isPlaying) return;
    if (s.transport.isPlaying) {
      void startPlayback();
    } else {
      stopAudio();
    }
  });

  // React to project / mixer changes for live mix updates while playing.
  const unsubProject = useStore.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    if (!state.scheduler?.isRunning) return;
    const engine = getAudioEngine();
    applyMixState(state.graphs, s.project.tracks, engine.now());
  });

  state.unsub = [unsubPlaying, unsubProject];

  return () => {
    for (const u of state.unsub) u();
    state.unsub = [];
    state.installed = false;
    stopAudio();
  };
}

/** Build (or rebuild) the per-track graph + voice managers for a render pass. */
function buildVoices(
  ctx: AudioContext,
  master: GainNode,
  tracks: ReturnType<typeof useStore.getState>['project']['tracks'],
  when: number,
): void {
  // Tear down any prior graphs.
  for (const g of state.graphs.values()) g.dispose();
  state.graphs = buildTrackGraphs(ctx, master, tracks, when);
  state.synths = new Map();
  state.drums = new Map();
  for (const track of tracks) {
    const graph = state.graphs.get(track.id);
    if (!graph) continue;
    if (track.type === 'drum') {
      state.drums.set(track.id, new DrumVoiceManager(ctx, graph.input));
    } else if (track.type !== 'master') {
      state.synths.set(
        track.id,
        new SynthVoiceManager(ctx, graph.input, track.instrument?.preset),
      );
    }
  }
}

/** Start audio playback from the current transport position. */
async function startPlayback(): Promise<void> {
  const engine = getAudioEngine();
  const { context, master } = await engine.ensureContext();

  // The store could have been stopped again during the await.
  const store = useStore.getState();
  if (!store.transport.isPlaying) return;

  const project = store.project;
  const transport = store.transport;
  const beatsPerBar = project.timeSignature[0] > 0 ? project.timeSignature[0] : 4;
  const lengthBeats = projectLengthBeats(project.lengthBars, beatsPerBar);

  state.beatsPerBar = beatsPerBar;
  state.bpm = project.bpm;
  state.metronomeOn = transport.metronome;
  state.loop =
    transport.loopEnabled && transport.loopEndBeat > transport.loopStartBeat
      ? { startBeat: transport.loopStartBeat, endBeat: transport.loopEndBeat }
      : null;

  const startBeat = transport.positionBeat;
  const now = engine.now();
  state.anchorBeat = startBeat;
  state.anchorTime = now;
  state.metronomeBeatFrontier = startBeat;

  buildVoices(context, master, project.tracks, now);

  const events: ScheduledEvent[] = buildScheduleEvents(project);
  const endBeat = state.loop ? Infinity : lengthBeats;

  const scheduler = new Scheduler({
    clock: () => engine.now(),
    fire: (due) => fireEvents(due, context, master),
    onScheduleWindow: (window) => {
      if (state.metronomeOn) {
        scheduleMetronomeForWindow(window.startBeat, window.endBeat, context, master);
      }
    },
    onEnd: () => {
      // Stop at project end: pause then reset the store transport to the start.
      const s = useStore.getState();
      if (s.transport.isPlaying) {
        s.stop(); // pause: keeps position
        s.stop(); // second stop resets position to 0 (store semantics)
      }
    },
  });
  state.scheduler = scheduler;
  scheduler.start(events, project.bpm, startBeat, state.loop, endBeat);

  startPositionLoop();
}

/** Schedule a batch of due note/drum events (light work only). */
function fireEvents(due: DueEvent[], ctx: AudioContext, master: GainNode): void {
  const spb = secondsPerBeat(state.bpm);
  for (const ev of due) {
    const payload = ev.payload as SchedulePayload;
    if (payload.kind === 'note') {
      const synth = state.synths.get(payload.trackId);
      if (synth) {
        synth.noteOn(payload.pitch, ev.time, payload.durationBeats * spb, payload.velocity);
      }
    } else {
      const drum = state.drums.get(payload.trackId);
      if (drum) {
        drum.trigger(payload.lane, ev.time, payload.velocity);
      }
    }
  }
}

/**
 * Schedule metronome clicks for the raw scheduler lookahead window. This is
 * independent of note/drum due events so empty projects and silent tails still
 * click while transport is running.
 */
function scheduleMetronomeForWindow(
  windowStartBeat: number,
  windowEndBeat: number,
  ctx: AudioContext,
  master: GainNode,
): void {
  if (windowEndBeat <= windowStartBeat) return;
  const horizonBeat = Math.max(windowEndBeat, state.metronomeBeatFrontier);
  const clicks = metronomeBeatEvents(state.metronomeBeatFrontier, horizonBeat, state.beatsPerBar);
  for (const click of clicks) {
    const time = beatToTime(click.beat, state.bpm, state.anchorBeat, state.anchorTime);
    scheduleMetronomeClick(ctx, master, time, click.accent);
  }
  state.metronomeBeatFrontier = horizonBeat;
}

/** Drive transport.positionBeat from the audio clock ~30fps. */
function startPositionLoop(): void {
  stopPositionLoop();
  state.positionTimer = setInterval(() => {
    const scheduler = state.scheduler;
    if (!scheduler?.isRunning) return;
    const beat = scheduler.currentBeat();
    if (Number.isFinite(beat) && beat >= 0) {
      useStore.getState().setPosition(beat);
    }
  }, POSITION_TICK_MS);
}

function stopPositionLoop(): void {
  if (state.positionTimer != null) {
    clearInterval(state.positionTimer);
    state.positionTimer = null;
  }
}

/** Stop the audio: scheduler + voices + position loop. Does not touch store. */
function stopAudio(): void {
  state.scheduler?.stop();
  state.scheduler = null;
  stopPositionLoop();

  const engine = getAudioEngine();
  const when = engine.now();
  for (const synth of state.synths.values()) synth.releaseAll(when);
  state.synths.clear();
  state.drums.clear();
  for (const g of state.graphs.values()) g.dispose();
  state.graphs.clear();
  state.metronomeBeatFrontier = 0;
}
