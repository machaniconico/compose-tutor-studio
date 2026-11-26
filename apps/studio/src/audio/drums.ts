// Synthesized, GM-free drum voices.
//
// Every drum is generated from oscillators + filtered white noise so the app
// ships no samples (the project's legal rules forbid bundling un-licensed
// samples). A single white-noise buffer is shared across all noise-based voices
// to avoid re-allocating one per hit.
//
// Works with any BaseAudioContext (live playback and offline WAV render).

import type { DrumLane } from '@cts/project-model';

/** Seconds of white noise in the shared buffer. Long enough for any one hit. */
const NOISE_SECONDS = 1;

/** Fade before a choked hat stops, so the cut does not click. */
const CHOKE_FADE_SECONDS = 0.003;

/**
 * Build a mono white-noise buffer for the given context. Reused by every
 * noise-based drum voice via {@link DrumVoiceManager}.
 */
export function createNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/**
 * A set of drum voices bound to one output node (the drum track gain input).
 * One instance per drum track; shares a single noise buffer.
 */
export class DrumVoiceManager {
  private readonly ctx: BaseAudioContext;
  private readonly output: AudioNode;
  private readonly noise: AudioBuffer;

  constructor(ctx: BaseAudioContext, output: AudioNode, noise?: AudioBuffer) {
    this.ctx = ctx;
    this.output = output;
    this.noise = noise ?? createNoiseBuffer(ctx);
  }

  /**
   * Trigger a drum lane at an absolute audio time. The returned handle
   * cancels a hit that has not started yet (live edits); a hit already
   * playing is short and rings out. `chokeSeconds` cuts an open hat that
   * long after its start (the hi-hat choke from soundingEvents).
   */
  trigger(
    lane: DrumLane,
    time: number,
    velocity: number,
    chokeSeconds = Infinity,
  ): { release: (when: number) => void } {
    const vel = Math.min(1, Math.max(0, velocity / 127));
    const out = this.ctx.createGain();
    out.connect(this.output);
    switch (lane) {
      case 'kick':
        this.kick(time, vel, out);
        break;
      case 'snare':
        this.snare(time, vel, out);
        break;
      case 'closedHat':
        this.hat(time, vel, 0.045, out);
        break;
      case 'openHat':
        this.hat(time, vel, 0.32, out, chokeSeconds);
        break;
      case 'clap':
        this.clap(time, vel, out);
        break;
      case 'perc':
        this.perc(time, vel, out);
        break;
      default:
        break;
    }
    return {
      release: (when) => {
        if (when > time) return;
        // Silence without a fade: the hit has not started yet.
        out.gain.setValueAtTime(0, when);
        out.disconnect();
      },
    };
  }

  /** Shared noise source factory. */
  private noiseSource(time: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    // Randomize start offset so repeated hits do not phase-lock.
    const maxOffset = Math.max(0, this.noise.duration - 0.4);
    src.loop = false;
    src.start(time, Math.random() * maxOffset);
    return src;
  }

  /** Sine body 150->50Hz with a short click transient. */
  private kick(time: number, vel: number, out: AudioNode): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(50, time + 0.12);

    const gain = this.ctx.createGain();
    const peak = 0.9 * vel;
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
    osc.connect(gain);
    gain.connect(out);
    osc.start(time);
    osc.stop(time + 0.35);

    // Click transient: very short highpassed noise burst at the attack.
    const click = this.noiseSource(time);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(1500, time);
    const clickGain = this.ctx.createGain();
    clickGain.gain.setValueAtTime(0.4 * vel, time);
    clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
    click.connect(hp);
    hp.connect(clickGain);
    clickGain.connect(out);
    click.stop(time + 0.05);
  }

  /** Bandpassed noise + a 180Hz tone burst. */
  private snare(time: number, vel: number, out: AudioNode): void {
    const noise = this.noiseSource(time);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, time);
    bp.Q.setValueAtTime(0.8, time);
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.6 * vel, time);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
    noise.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(out);
    noise.stop(time + 0.25);

    const tone = this.ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(180, time);
    const toneGain = this.ctx.createGain();
    toneGain.gain.setValueAtTime(0.4 * vel, time);
    toneGain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
    tone.connect(toneGain);
    toneGain.connect(out);
    tone.start(time);
    tone.stop(time + 0.15);
  }

  /**
   * Highpassed noise; decay length distinguishes closed vs open. A choke that
   * comes before the decay ends follows the same curve, fades to 0 over a few
   * ms and stops the noise exactly at `time + chokeSeconds`.
   */
  private hat(time: number, vel: number, decay: number, out: AudioNode, chokeSeconds = Infinity): void {
    const noise = this.noiseSource(time);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(7000, time);
    const gain = this.ctx.createGain();
    const peak = 0.32 * vel;
    gain.gain.setValueAtTime(peak, time);
    noise.connect(hp);
    hp.connect(gain);
    gain.connect(out);
    if (chokeSeconds < decay + 0.05) {
      const fade = Math.min(CHOKE_FADE_SECONDS, chokeSeconds / 2);
      const fadeFrom = chokeSeconds - fade;
      const reached = fadeFrom < decay ? peak * (0.001 / peak) ** (fadeFrom / decay) : 0.001;
      gain.gain.exponentialRampToValueAtTime(reached, time + fadeFrom);
      gain.gain.linearRampToValueAtTime(0, time + chokeSeconds);
      noise.stop(time + chokeSeconds);
      return;
    }
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
    noise.stop(time + decay + 0.05);
  }

  /** Three staggered noise bursts to imitate a hand clap. */
  private clap(time: number, vel: number, out: AudioNode): void {
    const offsets = [0, 0.012, 0.024];
    for (const offset of offsets) {
      const start = time + offset;
      const noise = this.noiseSource(start);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1200, start);
      bp.Q.setValueAtTime(1.2, start);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.34 * vel, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.09);
      noise.connect(bp);
      bp.connect(gain);
      gain.connect(out);
      noise.stop(start + 0.12);
    }
  }

  /** Mid tom-like body. */
  private perc(time: number, vel: number, out: AudioNode): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, time);
    osc.frequency.exponentialRampToValueAtTime(160, time + 0.18);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.5 * vel, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
    osc.connect(gain);
    gain.connect(out);
    osc.start(time);
    osc.stop(time + 0.28);
  }
}
