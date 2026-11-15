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
//   time signature / length changes    => schedule rebuilt from the playhead
//
// The bridge writes transport.positionBeat back to the store ~30fps while
// playing so the playhead UI tracks the audio clock. The store owns play/stop
// *intent* and the position semantics (see store.stop(reset?)); this bridge owns
// the actual audio lifecycle.

import { beatsPerBar as beatsPerBarOf, type Project } from '@cts/project-model';
import { useStore } from '../state/store';
import { recordDiagnostic } from '../platform/diagnostics';
import { pushToast } from '../state/tutorialBridge';
import { getAudioEngine } from './engine';
import { buildScheduleEvents, type SchedulePayload } from './events';
import { applyMixState, buildTrackGraphs, type TrackGraph } from './graph';
import { applyMasterVolume } from './masterChain';
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
  /** Bumped by every play and stop; a start that no longer matches is abandoned. */
  playGeneration: number;
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
  playGeneration: 0,
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
      const generation = ++state.playGeneration;
      void startPlayback(generation).catch((error: unknown) => {
        if (generation === state.playGeneration) handlePlaybackStartFailure(error);
      });
    } else {
      stopAudio();
    }
  });

  // React to project / mixer changes while playing: the mix is updated live;
  // a new meter or song length (also via undo/redo) changes the events, the end
  // position and the metronome accent, so the schedule is rebuilt from the
  // current playhead.
  const unsubProject = useStore.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    if (!state.scheduler?.isRunning) return;
    if (timingChanged(s.project, prev.project)) {
      restartPlayback();
      return;
    }
    const engine = getAudioEngine();
    applyMixState(state.graphs, s.project.tracks, engine.now());
    if (engine.isInitialized) {
      applyMasterVolume(engine.requireMaster(), s.project.tracks, engine.now());
    }
  });

  state.unsub = [unsubPlaying, unsubProject];

  return () => {
    for (const u of state.unsub) u();
    state.unsub = [];
    state.installed = false;
    stopAudio();
  };
}

/**
 * Jump the playhead to `beat`. While playing, audio restarts from there
 * (pause, move, resume); when stopped only the position changes. Seeking is
 * transport state, so it never touches undo history.
 */
export function restartAt(beat: number): void {
  const store = useStore.getState();
  if (!store.transport.isPlaying) {
    store.setPosition(beat);
    return;
  }
  store.stop(); // pause: keeps position and tears the audio down
  store.setPosition(beat);
  store.play();
}

/** True when the meter or the song length differs between two project states. */
function timingChanged(next: Project, prev: Project): boolean {
  return (
    next.lengthBars !== prev.lengthBars ||
    next.timeSignature.join('/') !== prev.timeSignature.join('/')
  );
}

/**
 * Tear the running audio down and start again from the store's current
 * playhead. Notes that were sounding across the playhead are started again
 * for their remaining length, so a meter or length change does not cut them.
 * Play intent is untouched; a start past the new end stops through the
 * scheduler's own end handling, as usual.
 */
function restartPlayback(): void {
  stopAudio();
  const generation = ++state.playGeneration;
  void startPlayback(generation, true).catch((error: unknown) => {
    if (generation === state.playGeneration) handlePlaybackStartFailure(error);
  });
}

/**
 * Start the notes that began before `beat` and still sound at it, for their
 * remaining length from `now`. Used when the voices were rebuilt mid-note.
 */
function resumeSoundingNotes(events: readonly ScheduledEvent[], beat: number, now: number): void {
  const spb = secondsPerBeat(state.bpm);
  for (const ev of events) {
    const payload = ev.payload as SchedulePayload;
    if (payload.kind !== 'note' || ev.beat >= beat) continue;
    const remainingBeats = ev.beat + payload.durationBeats - beat;
    if (remainingBeats <= 0) continue;
    state.synths
      .get(payload.trackId)
      ?.noteOn(payload.pitch, now, remainingBeats * spb, payload.velocity);
  }
}

export function audioPlaybackFailureMessage(error: unknown): string {
  const detail =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === 'string'
        ? error
        : '';

  if (/notallowed|gesture|permission/i.test(detail)) {
    return '音声の開始が許可されませんでした。再生ボタンをもう一度押してください。';
  }

  if (/audiocontext|not supported|not defined/i.test(detail)) {
    return 'この環境では音声機能を開始できません。OSの音声出力とWebView2を確認してください。';
  }

  return '音を開始できませんでした。出力先とOSの音量を確認し、続く場合はサポートから診断情報をコピーしてください。';
}

function handlePlaybackStartFailure(error: unknown): void {
  stopAudio();
  const store = useStore.getState();
  if (store.transport.isPlaying) {
    store.stop();
  }
  recordDiagnostic('audio-playback', error);
  pushToast(audioPlaybackFailureMessage(error), 'error');
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

/**
 * Start audio playback from the current transport position. With
 * `resumeSounding` the notes already sounding at that position are restored
 * (see `resumeSoundingNotes`); a plain start or seek leaves them silent.
 */
async function startPlayback(generation: number, resumeSounding = false): Promise<void> {
  const engine = getAudioEngine();
  const { context, master } = await engine.ensureContext();

  // A stop or a newer seek during the await replaced this request.
  if (generation !== state.playGeneration) return;

  const store = useStore.getState();

  const project = store.project;
  const transport = store.transport;
  applyMasterVolume(master, project.tracks, context.currentTime);
  const bpb = beatsPerBarOf(project.timeSignature);
  const beatsPerBar = bpb > 0 ? bpb : 4;
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
  if (resumeSounding && startBeat < endBeat) resumeSoundingNotes(events, startBeat, now);

  const scheduler = new Scheduler({
    clock: () => engine.now(),
    fire: (due) => fireEvents(due, context, master),
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

  // Starting at the project end ends synchronously: onEnd already reset the
  // transport and the store subscription tore the audio down, so no loop.
  if (!scheduler.isRunning) return;

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

  if (state.metronomeOn) {
    scheduleMetronomeForWindow(due, ctx, master);
  }
}

/**
 * Schedule metronome clicks for the playhead window covered by `due`. Uses the
 * resolved audio times of the batch to bound the window so clicks line up with
 * the same lookahead the scheduler used.
 */
function scheduleMetronomeForWindow(due: DueEvent[], ctx: AudioContext, master: GainNode): void {
  if (due.length === 0) return;
  const lastTime = due[due.length - 1]?.time ?? state.anchorTime;
  const horizonBeat =
    state.anchorBeat + (lastTime - state.anchorTime) / secondsPerBeat(state.bpm) + 0.001;
  const clicks = metronomeBeatEvents(state.metronomeBeatFrontier, horizonBeat, state.beatsPerBar);
  for (const click of clicks) {
    const time = beatToTime(click.beat, state.bpm, state.anchorBeat, state.anchorTime);
    scheduleMetronomeClick(ctx, master, time, click.accent);
  }
  if (clicks.length > 0) {
    state.metronomeBeatFrontier = horizonBeat;
  }
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
  state.playGeneration += 1;
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
