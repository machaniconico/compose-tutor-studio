// Synthesized, GM-free drum voices.
//
// Every drum is generated from oscillators + filtered white noise so the app
// ships no samples (the project's legal rules forbid bundling un-licensed
// samples). A single white-noise buffer is shared across all noise-based voices
// to avoid re-allocating one per hit.
//
// Works with any BaseAudioContext (live playback and offline WAV render).

import type { DrumLane } from '@cts/project-model';
import { DRUM_VOICE_TIMING } from './voiceTiming';

/** Seconds of white noise in the shared buffer. Long enough for any one hit. */
const NOISE_SECONDS = 1;
/** Versioned default: changing it intentionally changes every synthesized drum. */
export const DRUM_NOISE_BUFFER_SEED_V1 = 0x4354_5301;
/** Independent versioned domain for per-hit noise-buffer offsets. */
export const DRUM_NOISE_OFFSET_DOMAIN_SEED_V1 = 0x4354_5302;
/** Deterministic fallback for callers carrying a legacy payload without a voice seed. */
export const LEGACY_DRUM_VOICE_SEED_V1 = 0x4354_53ff;

const UINT32_RANGE = 0x1_0000_0000;
const NOISE_SUBVOICE_SALT = Object.freeze({
  kickClick: 0x01,
  snareNoise: 0x02,
  closedHatNoise: 0x03,
  openHatNoise: 0x04,
  clapBurstBase: 0x100,
});

/**
 * End every envelope on the audio timeline itself. `ended` is delivered on the
 * main thread, so relying on its graph-disconnect timing can expose a few
 * engine-dependent filter-tail samples during an offline render.
 */
function silenceAtSourceStop(param: AudioParam, stopTime: number): void {
  param.setValueAtTime(0, stopTime);
}

function uint32(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? value >>> 0
    : fallback >>> 0;
}

function mixUint32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb_352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846c_a68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function createStablePrng(seed: number): () => number {
  let state = uint32(seed, DRUM_NOISE_BUFFER_SEED_V1);
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / UINT32_RANGE;
  };
}

/** Resolve a deterministic per-subvoice start offset into the shared noise buffer. */
export function drumNoiseStartOffsetSeconds(
  noiseBuffer: Pick<AudioBuffer, 'length' | 'sampleRate'>,
  voiceSeed: number | undefined,
  subvoiceSalt: number,
): number {
  const sampleRate = Number.isFinite(noiseBuffer.sampleRate) && noiseBuffer.sampleRate > 0
    ? noiseBuffer.sampleRate
    : 0;
  const length = Number.isSafeInteger(noiseBuffer.length) && noiseBuffer.length > 0
    ? noiseBuffer.length
    : 0;
  if (sampleRate <= 0 || length <= 0) return 0;
  const protectedTailFrames = Math.ceil(0.4 * sampleRate);
  const maxOffsetFrames = Math.max(0, length - protectedTailFrames);
  if (maxOffsetFrames <= 0) return 0;
  const seed = uint32(voiceSeed ?? LEGACY_DRUM_VOICE_SEED_V1, LEGACY_DRUM_VOICE_SEED_V1);
  const salt = uint32(subvoiceSalt, 0);
  const mixed = mixUint32(
    seed ^
      DRUM_NOISE_OFFSET_DOMAIN_SEED_V1 ^
      Math.imul((salt + 1) >>> 0, 0x9e37_79b9),
  );
  const offsetFrame = mixed % (maxOffsetFrames + 1);
  return offsetFrame / sampleRate;
}

/**
 * Build a mono white-noise buffer for the given context. Reused by every
 * noise-based drum voice via {@link DrumVoiceManager}.
 */
export function createNoiseBuffer(
  ctx: BaseAudioContext,
  seed: number = DRUM_NOISE_BUFFER_SEED_V1,
): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const random = createStablePrng(seed);
  for (let i = 0; i < length; i += 1) {
    data[i] = random() * 2 - 1;
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
  private readonly activeSubvoices = new Set<{ cancel: () => void }>();
  private disposed = false;

  constructor(ctx: BaseAudioContext, output: AudioNode, noise?: AudioBuffer) {
    this.ctx = ctx;
    this.output = output;
    this.noise = noise ?? createNoiseBuffer(ctx);
  }

  /** Trigger a drum lane at an absolute audio time. */
  trigger(
    lane: DrumLane,
    time: number,
    velocity: number,
    voiceSeed: number = LEGACY_DRUM_VOICE_SEED_V1,
  ): void {
    if (this.disposed) return;
    const vel = Math.min(1, Math.max(0, velocity / 127));
    const stableVoiceSeed = uint32(voiceSeed, LEGACY_DRUM_VOICE_SEED_V1);
    const alreadyActive = new Set(this.activeSubvoices);
    try {
      switch (lane) {
        case 'kick':
          this.kick(time, vel, stableVoiceSeed);
          break;
        case 'snare':
          this.snare(time, vel, stableVoiceSeed);
          break;
        case 'closedHat':
          this.hat(
            time,
            vel,
            DRUM_VOICE_TIMING.closedHat,
            stableVoiceSeed,
            NOISE_SUBVOICE_SALT.closedHatNoise,
          );
          break;
        case 'openHat':
          this.hat(
            time,
            vel,
            DRUM_VOICE_TIMING.openHat,
            stableVoiceSeed,
            NOISE_SUBVOICE_SALT.openHatNoise,
          );
          break;
        case 'clap':
          this.clap(time, vel, stableVoiceSeed);
          break;
        case 'perc':
          this.perc(time, vel);
          break;
        default:
          break;
      }
    } catch (error) {
      for (const subvoice of [...this.activeSubvoices]) {
        if (!alreadyActive.has(subvoice)) subvoice.cancel();
      }
      throw error;
    }
  }

  /** Cancel and synchronously disconnect every scheduled source. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subvoice of [...this.activeSubvoices]) subvoice.cancel();
    this.activeSubvoices.clear();
  }

  /** Shared noise source factory. Starting happens only after its graph is wired. */
  private noiseSource(
    voiceSeed: number,
    subvoiceSalt: number,
  ): { source: AudioBufferSourceNode; offset: number } {
    const offset = drumNoiseStartOffsetSeconds(this.noise, voiceSeed, subvoiceSalt);
    const source = this.ctx.createBufferSource();
    return {
      source,
      offset,
    };
  }

  private scheduleSubvoice(
    source: AudioScheduledSourceNode,
    schedule: (own: <T extends AudioNode>(node: T) => T) => void,
  ): void {
    const nodes: AudioNode[] = [];
    let settled = false;
    let subvoice: { cancel: () => void };

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      source.onended = null;
      this.activeSubvoices.delete(subvoice);
      disconnectNode(source);
      for (const node of nodes) disconnectNode(node);
    };
    const cancel = (): void => {
      if (settled) return;
      try {
        source.stop();
      } catch {
        // Source may not have started or the context may already be closed.
      }
      cleanup();
    };

    subvoice = { cancel };
    source.onended = cleanup;
    this.activeSubvoices.add(subvoice);
    try {
      schedule(<T extends AudioNode>(node: T): T => {
        nodes.push(node);
        return node;
      });
    } catch (error) {
      cancel();
      throw error;
    }
  }

  /** Sine body 150->50Hz with a short click transient. */
  private kick(time: number, vel: number, voiceSeed: number): void {
    const osc = this.ctx.createOscillator();
    this.scheduleSubvoice(osc, (own) => {
      const gain = own(this.ctx.createGain());
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, time);
      osc.frequency.exponentialRampToValueAtTime(50, time + 0.12);
      const peak = 0.9 * vel;
      gain.gain.setValueAtTime(peak, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
      silenceAtSourceStop(
        gain.gain,
        time + DRUM_VOICE_TIMING.kick.bodySourceStopSeconds,
      );
      osc.connect(gain);
      gain.connect(this.output);
      osc.start(time);
      osc.stop(time + DRUM_VOICE_TIMING.kick.bodySourceStopSeconds);
    });

    // Click transient: very short highpassed noise burst at the attack.
    const { source: click, offset } = this.noiseSource(
      voiceSeed,
      NOISE_SUBVOICE_SALT.kickClick,
    );
    this.scheduleSubvoice(click, (own) => {
      const hp = own(this.ctx.createBiquadFilter());
      const clickGain = own(this.ctx.createGain());
      click.buffer = this.noise;
      click.loop = false;
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(1500, time);
      clickGain.gain.setValueAtTime(0.4 * vel, time);
      clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
      silenceAtSourceStop(
        clickGain.gain,
        time + DRUM_VOICE_TIMING.kick.clickSourceStopSeconds,
      );
      click.connect(hp);
      hp.connect(clickGain);
      clickGain.connect(this.output);
      click.start(time, offset);
      click.stop(time + DRUM_VOICE_TIMING.kick.clickSourceStopSeconds);
    });
  }

  /** Bandpassed noise + a 180Hz tone burst. */
  private snare(time: number, vel: number, voiceSeed: number): void {
    const { source: noise, offset } = this.noiseSource(
      voiceSeed,
      NOISE_SUBVOICE_SALT.snareNoise,
    );
    this.scheduleSubvoice(noise, (own) => {
      const bp = own(this.ctx.createBiquadFilter());
      const noiseGain = own(this.ctx.createGain());
      noise.buffer = this.noise;
      noise.loop = false;
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1800, time);
      bp.Q.setValueAtTime(0.8, time);
      noiseGain.gain.setValueAtTime(0.6 * vel, time);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
      silenceAtSourceStop(
        noiseGain.gain,
        time + DRUM_VOICE_TIMING.snare.noiseSourceStopSeconds,
      );
      noise.connect(bp);
      bp.connect(noiseGain);
      noiseGain.connect(this.output);
      noise.start(time, offset);
      noise.stop(time + DRUM_VOICE_TIMING.snare.noiseSourceStopSeconds);
    });

    const tone = this.ctx.createOscillator();
    this.scheduleSubvoice(tone, (own) => {
      const toneGain = own(this.ctx.createGain());
      tone.type = 'triangle';
      tone.frequency.setValueAtTime(180, time);
      toneGain.gain.setValueAtTime(0.4 * vel, time);
      toneGain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
      silenceAtSourceStop(
        toneGain.gain,
        time + DRUM_VOICE_TIMING.snare.toneSourceStopSeconds,
      );
      tone.connect(toneGain);
      toneGain.connect(this.output);
      tone.start(time);
      tone.stop(time + DRUM_VOICE_TIMING.snare.toneSourceStopSeconds);
    });
  }

  /** Highpassed noise; decay length distinguishes closed vs open. */
  private hat(
    time: number,
    vel: number,
    timing: typeof DRUM_VOICE_TIMING.closedHat | typeof DRUM_VOICE_TIMING.openHat,
    voiceSeed: number,
    subvoiceSalt: number,
  ): void {
    const { source: noise, offset } = this.noiseSource(voiceSeed, subvoiceSalt);
    this.scheduleSubvoice(noise, (own) => {
      const hp = own(this.ctx.createBiquadFilter());
      const gain = own(this.ctx.createGain());
      noise.buffer = this.noise;
      noise.loop = false;
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(7000, time);
      gain.gain.setValueAtTime(0.32 * vel, time);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        time + timing.envelopeDecaySeconds,
      );
      silenceAtSourceStop(gain.gain, time + timing.sourceStopSeconds);
      noise.connect(hp);
      hp.connect(gain);
      gain.connect(this.output);
      noise.start(time, offset);
      noise.stop(time + timing.sourceStopSeconds);
    });
  }

  /** Three staggered noise bursts to imitate a hand clap. */
  private clap(time: number, vel: number, voiceSeed: number): void {
    for (const [index, offset] of DRUM_VOICE_TIMING.clap.burstOffsetsSeconds.entries()) {
      const start = time + offset;
      const { source: noise, offset: noiseOffset } = this.noiseSource(
        voiceSeed,
        NOISE_SUBVOICE_SALT.clapBurstBase + index,
      );
      this.scheduleSubvoice(noise, (own) => {
        const bp = own(this.ctx.createBiquadFilter());
        const gain = own(this.ctx.createGain());
        noise.buffer = this.noise;
        noise.loop = false;
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1200, start);
        bp.Q.setValueAtTime(1.2, start);
        gain.gain.setValueAtTime(0.34 * vel, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.09);
        silenceAtSourceStop(
          gain.gain,
          start + DRUM_VOICE_TIMING.clap.burstSourceStopSeconds,
        );
        noise.connect(bp);
        bp.connect(gain);
        gain.connect(this.output);
        noise.start(start, noiseOffset);
        noise.stop(start + DRUM_VOICE_TIMING.clap.burstSourceStopSeconds);
      });
    }
  }

  /** Mid tom-like body. */
  private perc(time: number, vel: number): void {
    const osc = this.ctx.createOscillator();
    this.scheduleSubvoice(osc, (own) => {
      const gain = own(this.ctx.createGain());
      osc.type = 'sine';
      osc.frequency.setValueAtTime(320, time);
      osc.frequency.exponentialRampToValueAtTime(160, time + 0.18);
      gain.gain.setValueAtTime(0.5 * vel, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
      silenceAtSourceStop(
        gain.gain,
        time + DRUM_VOICE_TIMING.perc.sourceStopSeconds,
      );
      osc.connect(gain);
      gain.connect(this.output);
      osc.start(time);
      osc.stop(time + DRUM_VOICE_TIMING.perc.sourceStopSeconds);
    });
  }
}

function disconnectNode(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // Cleanup is idempotent and must continue across already-disconnected nodes.
  }
}
