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

  /** Trigger a drum lane at an absolute audio time. */
  trigger(lane: DrumLane, time: number, velocity: number): void {
    const vel = Math.min(1, Math.max(0, velocity / 127));
    switch (lane) {
      case 'kick':
        this.kick(time, vel);
        break;
      case 'snare':
        this.snare(time, vel);
        break;
      case 'closedHat':
        this.hat(time, vel, 0.045);
        break;
      case 'openHat':
        this.hat(time, vel, 0.32);
        break;
      case 'clap':
        this.clap(time, vel);
        break;
      case 'perc':
        this.perc(time, vel);
        break;
      default:
        break;
    }
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
  private kick(time: number, vel: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(50, time + 0.12);

    const gain = this.ctx.createGain();
    const peak = 0.9 * vel;
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
    osc.connect(gain);
    gain.connect(this.output);
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
    clickGain.connect(this.output);
    click.stop(time + 0.05);
  }

  /** Bandpassed noise + a 180Hz tone burst. */
  private snare(time: number, vel: number): void {
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
    noiseGain.connect(this.output);
    noise.stop(time + 0.25);

    const tone = this.ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(180, time);
    const toneGain = this.ctx.createGain();
    toneGain.gain.setValueAtTime(0.4 * vel, time);
    toneGain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
    tone.connect(toneGain);
    toneGain.connect(this.output);
    tone.start(time);
    tone.stop(time + 0.15);
  }

  /** Highpassed noise; decay length distinguishes closed vs open. */
  private hat(time: number, vel: number, decay: number): void {
    const noise = this.noiseSource(time);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(7000, time);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.32 * vel, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
    noise.connect(hp);
    hp.connect(gain);
    gain.connect(this.output);
    noise.stop(time + decay + 0.05);
  }

  /** Three staggered noise bursts to imitate a hand clap. */
  private clap(time: number, vel: number): void {
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
      gain.connect(this.output);
      noise.stop(start + 0.12);
    }
  }

  /** Mid tom-like body. */
  private perc(time: number, vel: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, time);
    osc.frequency.exponentialRampToValueAtTime(160, time + 0.18);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.5 * vel, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
    osc.connect(gain);
    gain.connect(this.output);
    osc.start(time);
    osc.stop(time + 0.28);
  }
}
