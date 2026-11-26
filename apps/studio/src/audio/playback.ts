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
//   tempo / time signature / length    => schedule rebuilt from the playhead
//
// The bridge writes transport.positionBeat back to the store ~30fps while
// playing so the playhead UI tracks the audio clock. The store owns play/stop
// *intent* and the position semantics (see store.stop(reset?)); this bridge owns
// the actual audio lifecycle.

import { beatsPerBar as beatsPerBarOf, type Project } from '@cts/project-model';
import { activeLoopRange, useStore } from '../state/store';
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
import { songSoundEndBeat, songTailSeconds } from './wav';

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
  /**
   * Set by the scheduler's end handling just before the store stop: the
   * AudioContext time the notes started before the song end finish ringing.
   * The stop that follows keeps the graphs until then instead of cutting them.
   */
  ringUntil: number | null;
  /** Graphs left ringing after the song end, disposed when the timer fires. */
  ringing: { graphs: Map<string, TrackGraph>; timer: ReturnType<typeof setTimeout> } | null;
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
  ringUntil: null,
  ringing: null,
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

  // React to project / mixer changes. The master volume follows the project
  // even while stopped, so piano-roll previews (which go through the master
  // bus) hear the current master fader. While playing, the mix is updated live;
  // a new tempo, meter or song length (also via undo/redo) changes event timing, the end
  // position and the metronome accent, so the schedule is rebuilt from the
  // current playhead.
  const unsubProject = useStore.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    const engine = getAudioEngine();
    if (!state.scheduler?.isRunning) {
      if (engine.isInitialized) {
        applyMasterVolume(engine.requireMaster(), s.project.tracks, engine.now());
      }
      return;
    }
    if (timingChanged(s.project, prev.project)) {
      restartPlayback();
      return;
    }
    applyMixState(state.graphs, s.project.tracks, engine.now());
    if (engine.isInitialized) {
      applyMasterVolume(engine.requireMaster(), s.project.tracks, engine.now());
    }
  });

  // Turning loop on/off or changing the loop range while playing rebuilds the
  // schedule from the current playhead, so the new range is heard at once.
  const unsubLoop = useStore.subscribe((s, prev) => {
    if (!state.scheduler?.isRunning) return;
    const next = activeLoopRange(s);
    const before = activeLoopRange(prev);
    if (next?.startBeat === before?.startBeat && next?.endBeat === before?.endBeat) return;
    restartPlayback();
  });

  state.unsub = [unsubPlaying, unsubProject, unsubLoop];

  return () => {
    for (const u of state.unsub) u();
    state.unsub = [];
    state.installed = false;
    stopAudio();
    silenceRinging();
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

/** True when tempo, meter or song length differs between two project states. */
function timingChanged(next: Project, prev: Project): boolean {
  return (
    next.bpm !== prev.bpm ||
    next.lengthBars !== prev.lengthBars ||
    next.timeSignature.join('/') !== prev.timeSignature.join('/')
  );
}

/**
 * Tear the running audio down and start again from the audio clock's current
 * playhead. Notes that were sounding across the playhead are started again
 * for their remaining length at the new tempo, so timing edits keep them sounding.
 * Play intent is untouched; a start past the new end stops through the
 * scheduler's own end handling, as usual.
 */
function restartPlayback(): void {
  // The displayed position can lag the audio by a position-timer tick. Capture
  // the old scheduler position before stopping it, using its old tempo.
  const beat = state.scheduler?.currentBeat();
  stopAudio();
  if (beat !== undefined && Number.isFinite(beat) && beat >= 0) {
    useStore.getState().setPosition(beat);
  }
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
      ?.noteOn(payload.pitch, now, remainingBeats * spb, payload.velocity, { cutAtEnd: payload.cut });
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
  const loop = activeLoopRange(store);
  state.loop = loop ? { startBeat: loop.startBeat, endBeat: loop.endBeat } : null;

  const startBeat = transport.positionBeat;
  const now = engine.now();
  state.anchorBeat = startBeat;
  state.anchorTime = now;
  state.metronomeBeatFrontier = startBeat;

  silenceRinging();
  buildVoices(context, master, project.tracks, now);

  const events: ScheduledEvent[] = buildScheduleEvents(project);
  const endBeat = state.loop ? Infinity : lengthBeats;
  if (resumeSounding && startBeat < endBeat) resumeSoundingNotes(events, startBeat, now);

  const soundEndBeat = songSoundEndBeat(project);
  const tailSeconds = songTailSeconds(project);
  const scheduler = new Scheduler({
    clock: () => engine.now(),
    fire: (due) => fireEvents(due, context, master),
    onEnd: () => {
      // Stop at project end and reset the store transport to the start.
      // No new note starts, but notes started before the end ring out in full
      // (with their release and echoes), as in the WAV render and MIDI.
      const s = useStore.getState();
      if (s.transport.isPlaying) {
        if (startBeat < lengthBeats) {
          state.ringUntil = beatToTime(soundEndBeat, state.bpm, state.anchorBeat, state.anchorTime) + tailSeconds;
        }
        s.stop(true);
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
        synth.noteOn(payload.pitch, ev.time, payload.durationBeats * spb, payload.velocity, {
          cutAtEnd: payload.cut,
        });
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

/**
 * Stop the audio: scheduler + voices + position loop. Does not touch store.
 * At the song end (`ringUntil` set) the sounding notes keep their scheduled
 * ends and the graphs stay connected until they have rung out.
 */
function stopAudio(): void {
  state.playGeneration += 1;
  state.scheduler?.stop();
  state.scheduler = null;
  stopPositionLoop();

  const engine = getAudioEngine();
  const when = engine.now();
  const ringUntil = state.ringUntil;
  state.ringUntil = null;
  if (ringUntil !== null && ringUntil > when) {
    silenceRinging();
    const graphs = state.graphs;
    const timer = setTimeout(silenceRinging, (ringUntil - when) * 1000);
    state.ringing = { graphs, timer };
    state.graphs = new Map();
  } else {
    for (const synth of state.synths.values()) synth.releaseAll(when);
    for (const g of state.graphs.values()) g.dispose();
    state.graphs.clear();
  }
  state.synths.clear();
  state.drums.clear();
  state.metronomeBeatFrontier = 0;
}

/** Disconnect the graphs still ringing after the song end, if any. */
function silenceRinging(): void {
  const ringing = state.ringing;
  if (ringing === null) return;
  state.ringing = null;
  clearTimeout(ringing.timer);
  for (const g of ringing.graphs.values()) g.dispose();
}
