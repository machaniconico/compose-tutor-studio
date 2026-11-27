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
//   tempo / meter changes              => schedule rebuilt from the playhead
//   clip edits / song length           => schedule updated in place (applyLiveEdit)
//
// The bridge writes transport.positionBeat back to the store ~30fps while
// playing so the playhead UI tracks the audio clock. The store owns play/stop
// *intent* and the position semantics (see store.stop(reset?)); this bridge owns
// the actual audio lifecycle.

import { beatTick, beatsPerBar as beatsPerBarOf, computeAudibleTracks, songEndBeat, type Project, type Track } from '@cts/project-model';
import { activeLoopRange, useStore } from '../state/store';
import { recordDiagnostic } from '../platform/diagnostics';
import { pushToast } from '../state/tutorialBridge';
import { automationLoopOffset } from './automationSchedule';
import { getAudioEngine } from './engine';
import { buildScheduleEvents, type SchedulePayload } from './events';
import { applyMixState, buildTrackGraphs, type TrackGraph } from './graph';
import { applyMasterVolume } from './masterChain';
import {
  beatToTime,
  isValidLoop,
  Scheduler,
  secondsPerBeat,
  type DueEvent,
  type LoopRegion,
} from './scheduler';
import { DrumVoiceManager } from './drums';
import { SynthVoiceManager } from './synth';
import { metronomeBeatEvents, scheduleMetronomeClick } from './metronome';
import { songTailSeconds } from './wav';

/** Position update rate while playing (ms ~= 30fps). */
const POSITION_TICK_MS = 33;
// At 300 BPM and the minimum loop period, one lookahead spans fewer than 40 repeats.
const MAX_AUTOMATION_PASSES_PER_TICK = 64;

/**
 * Ledger entry: a note or drum hit actually handed to a voice in this run
 * (queued or sounding). Only these are ever continued by a live edit or a
 * restart; nothing is inferred from beat positions.
 */
type LiveVoice = {
  /** What the event sounds like: track, start tick, pitch or lane, velocity (see buildScheduleEvents). */
  key: string;
  /** Start and end on the run's playhead timeline (unwrapped beats); end = start for a drum hit. */
  startBeat: number;
  endBeat: number;
  /** Playhead beat the voice itself started at (later than `startBeat` when resumed part-way). */
  soundFrom: number;
  payload: SchedulePayload;
  release?: (when: number) => void;
  /** Move a note's end; its length is counted from `soundFrom`. */
  setDuration?: (seconds: number, when: number, cutAtEnd?: boolean) => void;
};

/** Identity of every scheduled payload, filled by buildScheduleEvents. */
const eventKeys = new WeakMap<object, string>();

/** Mutable bridge state held at module scope (singleton, like the engine). */
type BridgeState = {
  scheduler: Scheduler | null;
  graphs: Map<string, TrackGraph>;
  /**
   * Sound tracks selected at play time. Live edits refresh tracks still in
   * the project. Removed tracks keep their last state through graph rebuilds.
   */
  playbackTracks: Map<string, Track>;
  synths: Map<string, SynthVoiceManager>;
  drums: Map<string, DrumVoiceManager>;
  bpm: number;
  loop: LoopRegion | null;
  /** Song end of the running schedule; live edits move it. */
  songEnd: number;
  /** Voices handed out in this run that may still sound or are yet to start. */
  voices: LiveVoice[];
  /** Metronome clicks scheduled in this run; a stop silences those not yet heard. */
  clicks: Array<{ time: number; cancel?: () => void }>;
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
  playbackTracks: new Map(),
  synths: new Map(),
  drums: new Map(),
  bpm: 120,
  loop: null,
  songEnd: 0,
  voices: [],
  clicks: [],
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
      state.playbackTracks = new Map(
        s.project.tracks.filter((track) => track.type !== 'master').map((track) => [track.id, track]),
      );
      const generation = ++state.playGeneration;
      void startPlayback(generation).catch((error: unknown) => {
        if (generation === state.playGeneration) handlePlaybackStartFailure(error);
      });
    } else {
      stopAudio();
      state.playbackTracks.clear();
    }
  });

  // React to project / mixer changes. The master volume follows the project
  // even while stopped, so piano-roll previews (which go through the master
  // bus) hear the current master fader. While playing, mix and clip edits
  // apply live, and tempo or meter changes rebuild from the current playhead.
  const unsubProject = useStore.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    let clipsChanged = false;
    let previousAudible: Set<string> | undefined;
    for (const track of s.project.tracks) {
      const playingTrack = state.playbackTracks.get(track.id);
      if (!playingTrack || playingTrack === track) continue;
      clipsChanged ||= track.clips !== playingTrack.clips;
      if (track.mute !== playingTrack.mute || track.solo !== playingTrack.solo) {
        previousAudible ??= computeAudibleTracks([...state.playbackTracks.values()]);
      }
      // Keep the lane captured at play time, including across internal restarts.
      state.playbackTracks.set(track.id, track.automation === playingTrack.automation
        ? track : { ...track, automation: playingTrack.automation });
    }
    // Returns have no scheduled voices and can be added or removed mid-play.
    let returnsChanged = false;
    if (s.transport.isPlaying) {
      const returns = new Map(s.project.tracks.filter((track) => track.type === 'bus').map((track) => [track.id, track]));
      for (const [id, track] of state.playbackTracks) {
        if (track.type === 'bus' && !returns.has(id)) {
          state.playbackTracks.delete(id);
          returnsChanged = true;
        }
      }
      for (const [id, track] of returns) {
        if (!state.playbackTracks.has(id)) {
          state.playbackTracks.set(id, track);
          returnsChanged = true;
        }
      }
    }
    const engine = getAudioEngine();
    if (!state.scheduler?.isRunning) {
      if (engine.isInitialized) {
        applyMasterVolume(engine.requireMaster(), s.project.tracks, engine.now());
      }
      return;
    }
    const lengthChanged = s.project.lengthBars !== prev.project.lengthBars;
    if (returnsChanged || tempoOrMeterChanged(s.project, prev.project) ||
      (lengthChanged && !state.loop && [...state.playbackTracks.values()].some(hasVolumeAutomation))) {
      restartPlayback();
      return;
    }
    if (
      (clipsChanged || lengthChanged) &&
      !applyLiveEdit(playbackProject(s.project))
    ) {
      restartPlayback();
      return;
    }
    const tracks = [...state.playbackTracks.values()];
    applyMixState(state.graphs, tracks, engine.now());
    if (engine.isInitialized) {
      applyMasterVolume(engine.requireMaster(), s.project.tracks, engine.now());
    }
    if (previousAudible) {
      const audible = computeAudibleTracks(tracks);
      const before = previousAudible;
      if (audible.size !== before.size || [...audible].some((id) => !before.has(id))) {
        // The queued events reflect the previous mix. Rebuild from the playhead.
        restartPlayback();
      }
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
    state.playbackTracks.clear();
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

/** True when tempo or meter differs between two project states. */
function tempoOrMeterChanged(next: Project, prev: Project): boolean {
  return next.bpm !== prev.bpm || next.timeSignature.join('/') !== prev.timeSignature.join('/');
}

/** The project as this run plays it: the tracks selected at play time plus the master. */
function playbackProject(project: Project): Project {
  return {
    ...project,
    tracks: [...state.playbackTracks.values(), ...project.tracks.filter((track) => track.type === 'master')],
  };
}

/** The notes sounding when a restart began, from the ledger, on the old run's timeline. */
type ResumePoint = { playhead: number; sounding: LiveVoice[] };

/**
 * Tear the running audio down and start again from the audio clock's current
 * playhead. Notes that had a sounding voice and are still in the updated
 * schedule are started again for their remaining length.
 * Play intent is untouched; a start past the new end stops through the
 * scheduler's own end handling, as usual.
 */
function restartPlayback(): void {
  // The displayed position can lag the audio by a position-timer tick. Capture
  // the old scheduler position before stopping it, using its old tempo.
  const scheduler = state.scheduler;
  const beat = scheduler?.currentBeat();
  const playhead = scheduler?.playheadBeat();
  const resume: ResumePoint | undefined = playhead === undefined ? undefined : {
    playhead,
    sounding: state.voices.filter((v) => v.payload.kind === 'note' && v.startBeat < playhead && v.endBeat > playhead),
  };
  stopAudio();
  if (beat !== undefined && Number.isFinite(beat) && beat >= 0) {
    useStore.getState().setPosition(beat);
  }
  const generation = ++state.playGeneration;
  void startPlayback(generation, resume).catch((error: unknown) => {
    if (generation === state.playGeneration) handlePlaybackStartFailure(error);
  });
}

/**
 * Hand a note or drum hit starting at playhead beat `startBeat` to its voice
 * at audio time `time`, from playhead beat `from` (later than the start only
 * for the rest of a note that already had a voice), and add it to the ledger.
 */
function startVoice(key: string, payload: SchedulePayload, startBeat: number, from: number, time: number): void {
  let handle: Pick<LiveVoice, 'release' | 'setDuration'> | undefined;
  if (payload.kind === 'note') {
    handle = state.synths.get(payload.trackId)?.noteOn(
      payload.pitch,
      time,
      (from === startBeat ? payload.durationBeats : startBeat + payload.durationBeats - from) * secondsPerBeat(state.bpm),
      payload.velocity,
      { cutAtEnd: payload.cut },
    );
  } else {
    const drums = state.drums.get(payload.trackId);
    handle = payload.durationBeats === undefined
      ? drums?.trigger(payload.lane, time, payload.velocity)
      : drums?.trigger(payload.lane, time, payload.velocity, payload.durationBeats * secondsPerBeat(state.bpm));
  }
  const endBeat = payload.kind === 'note' ? startBeat + payload.durationBeats : startBeat;
  state.voices.push({
    key, startBeat, endBeat, soundFrom: from, payload,
    release: handle?.release,
    setDuration: handle?.setDuration,
  });
}

/** The scheduled payloads by identity, as a multiset (equal sounds share a key). */
function payloadsByKey(events: readonly { payload: unknown }[]): Map<string, SchedulePayload[]> {
  const byKey = new Map<string, SchedulePayload[]>();
  for (const ev of events) {
    const key = eventKeys.get(ev.payload as object) ?? '';
    const same = byKey.get(key);
    if (same) same.push(ev.payload as SchedulePayload);
    else byKey.set(key, [ev.payload as SchedulePayload]);
  }
  return byKey;
}

function voicePass(key: string, startBeat: number): string {
  return `${key}@${beatTick(startBeat)}`;
}

function voicesByPass(voices: readonly LiveVoice[]): Map<string, LiveVoice[]> {
  const passes = new Map<string, LiveVoice[]>();
  for (const voice of voices) {
    const pass = voicePass(voice.key, voice.startBeat);
    const same = passes.get(pass);
    if (same) same.push(voice);
    else passes.set(pass, [voice]);
  }
  return passes;
}

const durationOf = (payload: SchedulePayload) => payload.kind === 'note' ? payload.durationBeats : 0;

/** Keep equal ends first, then pair the remaining voices and events in end order. */
function matchPass(voices: LiveVoice[], candidates: readonly SchedulePayload[]): Map<LiveVoice, SchedulePayload> {
  const byEnd = new Map<number, SchedulePayload[]>();
  for (const payload of candidates) {
    const end = beatTick(voices[0]!.startBeat + durationOf(payload));
    const same = byEnd.get(end);
    if (same) same.push(payload);
    else byEnd.set(end, [payload]);
  }

  const matches = new Map<LiveVoice, SchedulePayload>();
  const unmatched: LiveVoice[] = [];
  for (const voice of voices) {
    const payload = byEnd.get(beatTick(voice.endBeat))?.pop();
    if (payload) matches.set(voice, payload);
    else unmatched.push(voice);
  }
  const remaining = [...byEnd.values()].flat().sort((a, b) => durationOf(b) - durationOf(a));
  unmatched.sort((a, b) => b.endBeat - a.endBeat);
  for (const [index, payload] of remaining.entries()) {
    const voice = unmatched[index];
    if (!voice) break;
    matches.set(voice, payload);
  }
  return matches;
}

/**
 * Bring the running schedule in line with an edited project without
 * restarting. A ledger voice keeps sounding while the new schedule has a
 * sound with the same identity (track, start, pitch or lane, velocity),
 * matched as a multiset per pass; when that sound's end moved, only the
 * voice's release moves, so no voice is rebuilt or taken from another note.
 * Voices without a match are released. Events without a voice are only
 * queued at their own start, when it falls in the window the scheduler has
 * already passed, never started part-way.
 * Returns false when playback has to restart instead: the song now ends at or
 * before the playhead.
 */
function applyLiveEdit(project: Project): boolean {
  const scheduler = state.scheduler;
  if (!scheduler) return false;
  const songEnd = songEndBeat(project);
  const playhead = scheduler.playheadBeat();
  if (!state.loop && playhead >= songEnd) return false;
  const events = buildScheduleEvents(project, eventKeys, state.loop);
  scheduler.update(events, state.loop ? Infinity : songEnd);
  state.songEnd = songEnd;

  const byKey = payloadsByKey(events);
  const now = getAudioEngine().now();
  const spb = secondsPerBeat(state.bpm);
  const passes = voicesByPass(state.voices.filter((voice) => voice.startBeat >= playhead || voice.endBeat > playhead));
  const held = new Map<string, Set<SchedulePayload>>();
  state.voices = [];
  for (const [pass, group] of passes) {
    const matches = matchPass(group, byKey.get(group[0]!.key) ?? []);
    const heldInPass = new Set<SchedulePayload>();
    held.set(pass, heldInPass);
    for (const voice of group) {
      const payload = matches.get(voice);
      if (!payload) {
        voice.release?.(now);
        continue;
      }
      if (payload.kind !== 'note') {
        state.voices.push({ ...voice, payload });
        heldInPass.add(payload);
        continue;
      }
      const endBeat = voice.startBeat + payload.durationBeats;
      const before = voice.payload.kind === 'note' ? voice.payload.cut : undefined;
      if (beatTick(endBeat) !== beatTick(voice.endBeat) || before !== payload.cut) {
        if (endBeat <= playhead) {
          voice.release?.(now);
          continue;
        }
        if (voice.setDuration) voice.setDuration((endBeat - voice.soundFrom) * spb, now, payload.cut);
        else if (endBeat < voice.endBeat) voice.release?.(scheduler.timeAt(endBeat));
      }
      state.voices.push({ ...voice, endBeat, payload });
      heldInPass.add(payload);
    }
  }

  // Events in the already scheduled window that have no voice yet.
  for (const due of scheduler.eventsBetween(playhead, scheduler.scheduledUntil)) {
    const payload = due.payload as SchedulePayload;
    const key = eventKeys.get(payload) ?? '';
    const startBeat = scheduler.playheadBeat(due.time);
    if (held.get(voicePass(key, startBeat))?.delete(payload)) continue;
    startVoice(key, payload, startBeat, startBeat, due.time);
  }
  return true;
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

function hasVolumeAutomation(track: Track): boolean {
  return track.type !== 'master' && Boolean(track.automation?.volume?.points.length);
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
    } else if (track.type !== 'master' && track.type !== 'bus') {
      state.synths.set(
        track.id,
        // The voice manager applies the track's macros, as in the WAV render.
        new SynthVoiceManager(ctx, graph.input, track.instrument?.preset, undefined, track.instrument?.macros),
      );
    }
  }
}

/**
 * Start audio playback from the current transport position. With `resume`
 * (a restart) the notes sounding at that point of the old run, loop passes
 * included, go on for their remaining length; a plain start or seek leaves
 * them silent.
 */
async function startPlayback(generation: number, resume?: ResumePoint): Promise<void> {
  const engine = getAudioEngine();
  const { context, master } = await engine.ensureContext();

  // A stop or a newer seek during the await replaced this request.
  if (generation !== state.playGeneration) return;

  const store = useStore.getState();

  const project = playbackProject(store.project);
  const transport = store.transport;
  applyMasterVolume(master, project.tracks, context.currentTime);
  const bpb = beatsPerBarOf(project.timeSignature);
  const beatsPerBar = bpb > 0 ? bpb : 4;
  state.songEnd = songEndBeat(project);

  state.bpm = project.bpm;
  const loop = activeLoopRange(store);
  // A region shorter than the shortest loop period plays as if loop were off.
  state.loop = loop && isValidLoop(loop) ? { startBeat: loop.startBeat, endBeat: loop.endBeat } : null;

  const startBeat = transport.positionBeat;
  const now = engine.now();
  const automation = { bpm: project.bpm, startBeat, loop: state.loop, endBeat: state.songEnd, startTime: now };
  const hasAutomation = project.tracks.some(hasVolumeAutomation);
  let nextAutomationPass = 0;

  silenceRinging();
  buildVoices(context, master, project.tracks, now);

  const events = buildScheduleEvents(project, eventKeys, state.loop);
  const endBeat = state.loop ? Infinity : state.songEnd;
  if (resume && startBeat < endBeat) {
    const byKey = payloadsByKey(events);
    // Map the old run's timeline onto this one, which starts at `startBeat`.
    const offset = startBeat - resume.playhead;
    for (const group of voicesByPass(resume.sounding).values()) {
      for (const [voice, next] of matchPass(group, byKey.get(group[0]!.key) ?? [])) {
        if (next.kind !== 'note' || voice.startBeat + next.durationBeats <= resume.playhead) continue;
        startVoice(voice.key, next, voice.startBeat + offset, startBeat, now);
      }
    }
  }

  const scheduler = new Scheduler({
    clock: () => engine.now(),
    fire: fireEvents,
    onWindow: (fromBeat, toBeat) => {
      if (hasAutomation) {
        automation.startTime = scheduler.timeAt(startBeat);
        const schedule = (pass: number) => {
          for (const graph of state.graphs.values()) graph.scheduleAutomation(automation, pass);
        };
        if (nextAutomationPass === 0) {
          schedule(0);
          nextAutomationPass = 1;
        }
        const { loop } = automation;
        if (loop) {
          // Jump past completed passes after a stalled timer. A normal lookahead
          // schedules each repeat shortly before its first sample.
          const firstRepeat = automationLoopOffset(startBeat, loop, 1);
          const period = loop.endBeat - loop.startBeat;
          const through = 1 + Math.floor((toBeat - startBeat - firstRepeat) / period);
          const current = 1 + Math.floor((scheduler.playheadBeat() - startBeat - firstRepeat) / period);
          nextAutomationPass = Math.max(nextAutomationPass, current);
          // Even a pathological tempo/range cannot create an unbounded batch.
          const first = Math.max(nextAutomationPass, through - MAX_AUTOMATION_PASSES_PER_TICK + 1);
          for (let pass = first; Number.isSafeInteger(pass) && pass <= through; pass++) schedule(pass);
          nextAutomationPass = Math.max(nextAutomationPass, through + 1);
        }
      }
      if (!transport.metronome) return;
      const clickNow = engine.now();
      state.clicks = state.clicks.filter((click) => click.time >= clickNow);
      for (const click of metronomeBeatEvents(fromBeat, toBeat, beatsPerBar)) {
        const time = beatToTime(click.beat, project.bpm, startBeat, now);
        state.clicks.push({ time, cancel: scheduleMetronomeClick(context, master, time, click.accent) });
      }
    },
    onEnd: () => {
      // Stop at project end and reset the store transport to the start.
      // Keep the release and effect tails after the shared note cutoff.
      const s = useStore.getState();
      if (s.transport.isPlaying) {
        if (startBeat < state.songEnd) {
          const songEndTime = beatToTime(state.songEnd, project.bpm, startBeat, now);
          let latestReleaseEnd = songEndTime;
          for (const synth of state.synths.values()) {
            const releaseEnd = synth.latestReleaseEndTime;
            if (releaseEnd > latestReleaseEnd) latestReleaseEnd = releaseEnd;
          }
          const tail = songTailSeconds(playbackProject(s.project), {
            liveReleaseOverhang: latestReleaseEnd - songEndTime,
          });
          state.ringUntil = songEndTime + tail;
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
function fireEvents(due: DueEvent[]): void {
  const scheduler = state.scheduler;
  if (!scheduler) return;
  const playhead = scheduler.playheadBeat();
  state.voices = state.voices.filter((voice) => voice.startBeat >= playhead || voice.endBeat > playhead);
  for (const ev of due) {
    const startBeat = scheduler.playheadBeat(ev.time);
    startVoice(eventKeys.get(ev.payload as object) ?? '', ev.payload as SchedulePayload, startBeat, startBeat, ev.time);
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
  for (const click of state.clicks) {
    if (click.time >= when) click.cancel?.();
  }
  state.clicks = [];
  state.voices = [];
  const ringUntil = state.ringUntil;
  state.ringUntil = null;
  if (ringUntil !== null && ringUntil > when) {
    silenceRinging();
    const graphs = state.graphs;
    // Timers use whole milliseconds. Keep the graph through the final fraction.
    const timer = setTimeout(silenceRinging, Math.ceil((ringUntil - when) * 1000));
    state.ringing = { graphs, timer };
    state.graphs = new Map();
  } else {
    for (const synth of state.synths.values()) synth.releaseAll(when);
    for (const g of state.graphs.values()) g.dispose();
    state.graphs.clear();
  }
  state.synths.clear();
  state.drums.clear();
}

/** Disconnect the graphs still ringing after the song end, if any. */
function silenceRinging(): void {
  const ringing = state.ringing;
  if (ringing === null) return;
  state.ringing = null;
  clearTimeout(ringing.timer);
  for (const g of ringing.graphs.values()) g.dispose();
}
