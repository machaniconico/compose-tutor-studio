// AudioEngine: owns the single Web Audio AudioContext for the app.
//
// Browsers require a user gesture before audio can start, so the AudioContext is
// created lazily on the first call to `ensureContext()` (invoked from the play
// handler, which runs inside a click). The engine also exposes suspend/resume so
// playback can release the hardware when idle.
//
// This module is the only place that constructs a (live, non-offline)
// AudioContext, which keeps the singleton invariant simple.

import { createMasterChain } from './masterChain';
import { syncSpectrumTap } from './metering';

/**
 * The app-wide audio engine. Wraps a lazily-created AudioContext and the master
 * output bus. Construct via {@link getAudioEngine}; do not instantiate directly.
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  /** Master input node: per-track chains connect here. */
  private masterBus: GainNode | null = null;
  /** Meter tap on the master bus before the limiter. */
  private masterAnalyser: AnalyserNode | null = null;
  /** Soft limiter on the master bus before the destination. */
  private limiter: DynamicsCompressorNode | null = null;
  /** Optional spectrum tap after the limiter; only exists while the view is on. */
  private spectrumAnalyser: AnalyserNode | null = null;
  private spectrumEnabled = false;

  /** True once an AudioContext has been created. */
  get isInitialized(): boolean {
    return this.context !== null;
  }

  /** The live AudioContext, or null if play has never been pressed. */
  get audioContext(): AudioContext | null {
    return this.context;
  }

  /**
   * Current audio clock time in seconds, or 0 before the context exists.
   * Safe to call from the scheduler's clock callback.
   */
  now(): number {
    return this.context ? this.context.currentTime : 0;
  }

  /**
   * Create the AudioContext on first use (must be called from a user gesture),
   * resume it if the browser auto-suspended it, and return the context plus the
   * master input node that per-track chains should connect to.
   */
  async ensureContext(): Promise<{ context: AudioContext; master: GainNode }> {
    if (!this.context) {
      this.context = new AudioContext();
      // Gain follows the master track volume once playback applies the project.
      const chain = createMasterChain(this.context, []);

      this.masterBus = chain.input;
      this.masterAnalyser = chain.analyser;
      this.limiter = chain.limiter;
      this.syncSpectrum();
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    return { context: this.context, master: this.requireMaster() };
  }

  /** The master input node. Throws if the context has not been created yet. */
  requireMaster(): GainNode {
    if (!this.masterBus) {
      throw new Error('AudioEngine: master bus not initialised. Call ensureContext() first.');
    }
    return this.masterBus;
  }

  /** Master level analyser, tapped before the limiter. */
  getMasterAnalyser(): AnalyserNode | null {
    return this.masterAnalyser;
  }

  /**
   * Turn the master spectrum tap on or off. Off disconnects and drops the
   * AnalyserNode; on before audio has started connects it on the first play.
   */
  setSpectrumEnabled(enabled: boolean): void {
    this.spectrumEnabled = enabled;
    this.syncSpectrum();
  }

  /** Spectrum analyser, or null while the spectrum view is off. */
  getSpectrumAnalyser(): AnalyserNode | null {
    return this.spectrumAnalyser;
  }

  private syncSpectrum(): void {
    this.spectrumAnalyser = syncSpectrumTap(
      this.spectrumAnalyser,
      this.spectrumEnabled,
      this.context,
      this.limiter,
    );
  }

  /** Suspend the audio hardware (no-op if no context). */
  async suspend(): Promise<void> {
    if (this.context && this.context.state === 'running') {
      await this.context.suspend();
    }
  }

  /** Resume the audio hardware (no-op if no context). */
  async resume(): Promise<void> {
    if (this.context && this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  /** Tear down the context entirely. Mainly for tests / project switches. */
  async dispose(): Promise<void> {
    if (this.context) {
      await this.context.close();
    }
    this.context = null;
    this.masterBus = null;
    this.masterAnalyser = null;
    this.limiter = null;
    this.spectrumAnalyser = null;
  }
}

let singleton: AudioEngine | null = null;

/** Get the process-wide AudioEngine singleton, creating it on first use. */
export function getAudioEngine(): AudioEngine {
  if (!singleton) {
    singleton = new AudioEngine();
  }
  return singleton;
}
