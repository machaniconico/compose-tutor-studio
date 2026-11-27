// Audition (preview) of single notes and chords: ephemeral audio only.
//
// Preview never touches the project, undo history, or the playback schedule.
// Voices go through their own bus into the engine's master input, so they work
// while the transport plays. Every voice is scheduled with a bounded duration
// (the synth then guarantees its note-off), the number of concurrent voices is
// capped, and a new chord preview cancels the previous one.

import type { ChordEvent, InstrumentConfig, Project } from '@cts/project-model';
import { findChordTrack, realizeChordPitches } from '@cts/project-model';
import { useStore } from '../state/store';
import { getAudioEngine } from './engine';
import { SynthVoiceManager, resolveSynthPatch } from './synth';
import { SYNTH_OSCILLATOR_STOP_PAD_SECONDS } from './voiceTiming';

/** Maximum simultaneous preview voices (the synth steals the oldest beyond it). */
export const MAX_PREVIEW_VOICES = 16;
/** Hard upper bound of one preview voice, seconds. */
export const MAX_PREVIEW_SECONDS = 2;
export const NOTE_PREVIEW_SECONDS = 0.35;
export const CHORD_PREVIEW_SECONDS = 1.2;
const PREVIEW_VELOCITY = 90;
/** Shortest held note, seconds. */
const MIN_HOLD_SECONDS = 0.05;

/**
 * Fit the patch envelope so note-on through silence and oscillator stop is
 * within MAX_PREVIEW_SECONDS: noteOff = min(requested, max - release), floor
 * 50 ms, with release, attack and decay squeezed to fit.
 */
function fitEnvelope(instrument: InstrumentConfig | undefined, requested: number) {
  const env = resolveSynthPatch(instrument).env;
  const avail = MAX_PREVIEW_SECONDS - SYNTH_OSCILLATOR_STOP_PAD_SECONDS;
  const release = Math.min(env.release, avail - MIN_HOLD_SECONDS);
  const hold = Math.max(MIN_HOLD_SECONDS, Math.min(requested, avail - release));
  const attack = Math.min(env.attack, hold * 0.5);
  const decay = Math.min(env.decay, hold - attack);
  return { hold, envelope: { attack, decay, sustain: env.sustain, release } };
}

export type PreviewTarget = { context: BaseAudioContext; master: AudioNode };

/** Owns the preview bus and one voice manager (the track being auditioned). */
export class LivePreview {
  private bus: GainNode | null = null;
  private busContext: BaseAudioContext | null = null;
  private synth: SynthVoiceManager | null = null;
  private synthInstrument: InstrumentConfig | undefined;
  /** Bumped by every cancel/start so a start that awaited audio init can detect it is stale. */
  private epoch = 0;

  constructor(
    private readonly getTarget: () => Promise<PreviewTarget>,
    /** Full guard re-run after every await (recording, automation pass, busy project). */
    private readonly isAllowed: () => boolean = () => true,
  ) {}

  /** Play `pitches` together. `replace` cancels voices still sounding (chord previews). */
  async play(
    instrument: InstrumentConfig | undefined,
    pitches: readonly number[],
    seconds: number,
    replace: boolean,
  ): Promise<void> {
    const valid = [...new Set(pitches)].filter(
      (p) => Number.isInteger(p) && p >= 0 && p <= 127,
    );
    if (valid.length === 0 || !Number.isFinite(seconds)) return;
    const duration = Math.min(MAX_PREVIEW_SECONDS, Math.max(0.05, seconds));
    if (replace) this.cancel();
    const epoch = this.epoch;
    const { context, master } = await this.getTarget();
    if (epoch !== this.epoch || !this.isAllowed()) return;
    if (!this.bus || this.busContext !== context) {
      this.disposeSynth();
      const bus = context.createGain();
      bus.connect(master);
      this.bus = bus;
      this.busContext = context;
    }
    if (!this.synth || this.synthInstrument !== instrument) {
      this.disposeSynth();
      this.synth = new SynthVoiceManager(context, this.bus, instrument, MAX_PREVIEW_VOICES);
      this.synthInstrument = instrument;
    }
    const now = context.currentTime;
    const fitted = fitEnvelope(instrument, duration);
    for (const pitch of valid) {
      this.synth.noteOn(pitch, now, fitted.hold, PREVIEW_VELOCITY, { envelope: fitted.envelope });
    }
  }

  /** Release everything now and invalidate starts still waiting for audio. */
  cancel(): void {
    this.epoch += 1;
    const ctx = this.busContext;
    if (this.synth && ctx) this.synth.releaseAll(ctx.currentTime);
  }

  /** Cancel and tear the graph down (unmount). */
  dispose(): void {
    this.cancel();
    this.disposeSynth();
    try {
      this.bus?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.bus = null;
    this.busContext = null;
  }

  private disposeSynth(): void {
    this.synth?.dispose();
    this.synth = null;
    this.synthInstrument = undefined;
  }
}

let singleton: LivePreview | null = null;

function shared(): LivePreview {
  singleton ??= new LivePreview(async () => {
    const { context, master } = await getAudioEngine().ensureContext();
    return { context, master };
  }, canPreview);
  return singleton;
}

/**
 * Preview is refused while a recording owns the audio path (main has no input
 * monitoring). Playback is fine: preview uses its own bus and never touches
 * the scheduled events.
 */
export function canPreview(): boolean {
  const s = useStore.getState();
  return (
    !s.projectOperationBusy &&
    s.audioRecordingOperationId === null &&
    s.automationRecording.ownership === null
  );
}

/** The instrument that plays the track owning `clipId`, if any. */
export function instrumentForClip(project: Project, clipId: string | null): InstrumentConfig | undefined {
  if (!clipId) return undefined;
  return project.tracks.find((t) => t.clips.some((c) => c.id === clipId))?.instrument;
}

/** The chord-backing track's instrument (what playback uses for the chord track). */
export function instrumentForChords(project: Project): InstrumentConfig | undefined {
  return findChordTrack(project)?.instrument;
}

function run(promise: Promise<void>): void {
  promise.catch(() => {
    // Audio may be unavailable or blocked; preview is best effort.
  });
}

export function previewNote(instrument: InstrumentConfig | undefined, pitch: number): void {
  if (!canPreview()) return;
  run(shared().play(instrument, [pitch], NOTE_PREVIEW_SECONDS, false));
}

/** Play one chord exactly as playback realizes it. Returns false when refused or silent. */
export function previewChord(project: Project, chord: ChordEvent): boolean {
  if (!canPreview()) return false;
  const pitches = realizeChordPitches(chord);
  if (pitches.length === 0) return false;
  run(shared().play(instrumentForChords(project), pitches, CHORD_PREVIEW_SECONDS, true));
  return true;
}

export function stopPreview(): void {
  singleton?.cancel();
}

/**
 * Release preview on transport start, project switch, window blur/hide and
 * unmount. Returns the cleanup function.
 */
export function installPreviewLifecycle(): () => void {
  const initial = useStore.getState();
  let phase = initial.transport.phase;
  let activation = initial.saveState.activationId;
  let recording = false;
  const unsubscribe = useStore.subscribe((state) => {
    const nextRecording =
      state.audioRecordingOperationId !== null || state.automationRecording.ownership !== null;
    if (nextRecording && !recording) stopPreview();
    recording = nextRecording;
    const nextPhase = state.transport.phase;
    const nextActivation = state.saveState.activationId;
    if (nextPhase !== phase || nextActivation !== activation) stopPreview();
    phase = nextPhase;
    activation = nextActivation;
  });
  const onHide = () => stopPreview();
  window.addEventListener('blur', onHide);
  document.addEventListener('visibilitychange', onHide);
  return () => {
    unsubscribe();
    window.removeEventListener('blur', onHide);
    document.removeEventListener('visibilitychange', onHide);
    singleton?.dispose();
    singleton = null;
  };
}
