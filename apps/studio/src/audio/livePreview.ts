// Live preview ("試聴"): short one-off notes for keyboard clicks and note
// placement in the piano roll.
//
// Preview voices go through their own GainNode connected to the master input,
// so they work while the song is playing and never touch the playback schedule.
// At most MAX_PREVIEW_VOICES sound at once; the oldest is stopped to make room.
// A preview lasts exactly the requested length: the preset envelope is squeezed
// to fit, so a slow pad does not ring on past a 300ms key click.

import type { InstrumentConfig } from '@cts/project-model';
import { useStore } from '../state/store';
import { getAudioEngine } from './engine';
import { applyMacros } from './macros';
import { SynthVoiceManager, resolvePreset, type Envelope } from './synth';

/** Maximum simultaneous preview voices. */
export const MAX_PREVIEW_VOICES = 8;

/** Default preview length for a key click, milliseconds. */
export const PREVIEW_DURATION_MS = 300;

/** Default preview velocity (0..127). */
const PREVIEW_VELOCITY = 100;

/** Fade applied to a stolen voice; the new voice starts the moment it stops. */
const STEAL_FADE_S = 0.005;

/** Padding the synth adds between the end of the release ramp and the stop. */
const SYNTH_STOP_PAD_S = 0.02;

/** Shortest preview we schedule, seconds (room for a click-free ramp). */
const MIN_PREVIEW_S = 0.03;

/**
 * Squeeze `env` so a note held `hold` seconds and released by the returned
 * envelope stops exactly `totalSeconds` after it starts (including the synth's
 * stop padding). Release takes at most 30% of the time, attack at most half
 * of the rest.
 */
export function fitEnvelope(env: Envelope, totalSeconds: number): { env: Envelope; hold: number } {
  const avail = Math.max(MIN_PREVIEW_S, totalSeconds) - SYNTH_STOP_PAD_S;
  const release = Math.min(env.release, avail * 0.3);
  const hold = avail - release;
  const attack = Math.min(env.attack, hold * 0.5);
  const decay = Math.min(env.decay, hold - attack);
  return { env: { attack, decay, sustain: env.sustain, release }, hold };
}

/** Where preview audio goes: a context and the node preview output connects to. */
export type PreviewTarget = { context: BaseAudioContext; master: AudioNode };

type PreviewVoice = { synth: SynthVoiceManager; startTime: number; endTime: number };

/** Whether a preview request can be scheduled (AudioParams reject NaN/Infinity). */
function isPlayable(midi: number, velocity: number, durationMs: number): boolean {
  return (
    Number.isInteger(midi) && midi >= 0 && midi <= 127 &&
    Number.isFinite(velocity) && Number.isFinite(durationMs)
  );
}

/** Owns the preview bus and the preview voice pool. */
export class LivePreview {
  private readonly getTarget: () => Promise<PreviewTarget>;
  private bus: GainNode | null = null;
  private busContext: BaseAudioContext | null = null;
  private voices: PreviewVoice[] = [];

  constructor(getTarget: () => Promise<PreviewTarget>) {
    this.getTarget = getTarget;
  }

  /** Number of preview voices sounding now (a stolen voice counts until it stops). */
  activeVoiceCount(): number {
    const ctx = this.busContext;
    if (!ctx) return 0;
    this.reap(ctx.currentTime);
    return this.soundingAt(ctx.currentTime).length;
  }

  /** Sound one note with the track's instrument for `durationMs`. */
  async previewNote(
    trackInstrument: InstrumentConfig | undefined,
    midi: number,
    velocity: number = PREVIEW_VELOCITY,
    durationMs: number = PREVIEW_DURATION_MS,
  ): Promise<void> {
    const { context, bus } = await this.prepare();
    this.start(context, bus, trackInstrument, midi, velocity, durationMs);
  }

  /** Sound several notes together (each one is a voice). */
  async previewChord(
    midis: readonly number[],
    trackInstrument?: InstrumentConfig,
    velocity: number = PREVIEW_VELOCITY,
    durationMs: number = PREVIEW_DURATION_MS,
  ): Promise<void> {
    const { context, bus } = await this.prepare();
    for (const midi of midis) this.start(context, bus, trackInstrument, midi, velocity, durationMs);
  }

  private async prepare(): Promise<{ context: BaseAudioContext; bus: GainNode }> {
    const { context, master } = await this.getTarget();
    if (context.state === 'suspended' && 'resume' in context) {
      await (context as AudioContext).resume();
    }
    if (!this.bus || this.busContext !== context) {
      const bus = context.createGain();
      bus.connect(master);
      this.bus = bus;
      this.busContext = context;
      this.voices = [];
    }
    return { context, bus: this.bus };
  }

  private start(
    context: BaseAudioContext,
    bus: GainNode,
    instrument: InstrumentConfig | undefined,
    midi: number,
    velocity: number,
    durationMs: number,
  ): void {
    // Reject unschedulable input before stealing, so a failed request never
    // cuts off a voice it does not replace.
    if (!isPlayable(midi, velocity, durationMs)) return;
    const now = context.currentTime;
    this.reap(now);
    // Steal before starting: the stolen voice fades for STEAL_FADE_S and is
    // stopped exactly when the new voice starts, so never more than
    // MAX_PREVIEW_VOICES sound at the same instant. Count both fading voices
    // and pending starts. All pending starts are due by now + STEAL_FADE_S,
    // so checking that time also accounts for every remaining reservation.
    let start = now;
    if (this.voices.length >= MAX_PREVIEW_VOICES) {
      start = now + STEAL_FADE_S;
      let live = this.soundingAt(start);
      while (live.length >= MAX_PREVIEW_VOICES) {
        const victim = live[0] as PreviewVoice;
        victim.synth.releaseAll(now, STEAL_FADE_S, 0);
        victim.endTime = start;
        live = this.soundingAt(start);
      }
    }
    const total = Math.max(MIN_PREVIEW_S, durationMs / 1000);
    // The fitted envelope starts from the macro-shaped one; the voice manager
    // applies the same macros to the filter and stereo spread.
    const fitted = fitEnvelope(applyMacros(resolvePreset(instrument?.preset), instrument?.macros).env, total);
    const synth = new SynthVoiceManager(context, bus, instrument?.preset, 1, instrument?.macros);
    synth.noteOn(midi, start, fitted.hold, velocity, { env: fitted.env });
    this.voices.push({ synth, startTime: start, endTime: start + total });
  }

  /** Voices sounding at time `t` (started at or before it, not yet stopped), oldest first. */
  private soundingAt(t: number): PreviewVoice[] {
    return this.voices.filter((v) => v.startTime <= t && v.endTime > t);
  }

  private reap(now: number): void {
    this.voices = this.voices.filter((v) => v.endTime > now);
  }
}

let singleton: LivePreview | null = null;

function shared(): LivePreview {
  if (!singleton) singleton = new LivePreview(() =>
      getAudioEngine().ensureContext(useStore.getState().project.tracks),
    );
  return singleton;
}

/** Preview one note through the app's audio engine (usable during playback). */
export function previewNote(
  trackInstrument: InstrumentConfig | undefined,
  midi: number,
  velocity: number = PREVIEW_VELOCITY,
  durationMs: number = PREVIEW_DURATION_MS,
): Promise<void> {
  return shared().previewNote(trackInstrument, midi, velocity, durationMs);
}

/** Preview a chord through the app's audio engine (usable during playback). */
export function previewChord(
  midis: readonly number[],
  trackInstrument?: InstrumentConfig,
  velocity: number = PREVIEW_VELOCITY,
  durationMs: number = PREVIEW_DURATION_MS,
): Promise<void> {
  return shared().previewChord(midis, trackInstrument, velocity, durationMs);
}
