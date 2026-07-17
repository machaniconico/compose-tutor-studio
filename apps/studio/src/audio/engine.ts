// AudioEngine: owns the single Web Audio AudioContext for the app.
//
// Browsers require a user gesture before audio can start, so the AudioContext is
// created lazily on the first call to `ensureContext()` (invoked from the play
// handler, which runs inside a click). The engine also exposes suspend/resume so
// playback can release the hardware when idle.
//
// This module owns the app-wide realtime output AudioContext. Short-lived
// decode/capture helpers may own isolated contexts, but transport playback and
// synchronized Audio Track recording share this engine generation.

import { buildMasterBus } from './masterBus';
import { disposeMasterMeter } from './graph';

export type AudioContextFactory = () => AudioContext;
export type AudioEngineStateListener = (state: string) => void;

type ActivationFlight = {
  context: AudioContext;
  promise: Promise<void>;
};

/**
 * The app-wide audio engine. Wraps a lazily-created AudioContext and the master
 * output bus. App code should use {@link getAudioEngine}; the public constructor
 * exists so tests can inject a deterministic AudioContext factory.
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  /** Monotonic identity for each successfully committed realtime context. */
  private generation = 0;
  /** Master input node: per-track chains connect here. */
  private masterBus: GainNode | null = null;
  /** Soft limiter on the master bus before the destination. */
  private limiter: DynamicsCompressorNode | null = null;
  private activationFlight: ActivationFlight | null = null;
  private readonly stateListeners = new Set<AudioEngineStateListener>();

  constructor(
    private readonly createAudioContext: AudioContextFactory = () => new AudioContext(),
  ) {}

  private readonly handleContextStateChange = (event: Event): void => {
    if (event.currentTarget !== this.context || !this.context) return;
    const state = String(this.context.state);
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch {
        // A playback/UI observer must not prevent other observers from seeing
        // the underlying browser state change.
      }
    }
  };

  /** True once a usable (possibly currently suspended) context has been created. */
  get isInitialized(): boolean {
    return this.context !== null;
  }

  /** The current AudioContext, or null if play has never been pressed. */
  get audioContext(): AudioContext | null {
    return this.context;
  }

  /**
   * Identity of the currently committed realtime context.
   *
   * Zero means no context has ever been committed. A replacement context
   * always receives a different positive generation so stale recording frame
   * coordinates can never be adopted against a newer device clock.
   */
  get contextGeneration(): number {
    return this.generation;
  }

  /**
   * Subscribe before or after context creation. The subscription follows any
   * replacement context created after the browser closes the previous one.
   */
  subscribeStateChange(listener: AudioEngineStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
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
  async ensureContext(): Promise<{
    context: AudioContext;
    master: GainNode;
    contextGeneration: number;
  }> {
    // Intentionally stays before the first await: browser gesture authorization
    // can be lost at a microtask boundary in stricter Web Audio implementations.
    const context = this.getOrCreateContext();

    try {
      await this.ensureRunning(context);
    } catch (error) {
      if (String(context.state) === 'closed') {
        this.clearCommittedContext(context);
      }
      throw error;
    }

    if (this.context !== context || String(context.state) !== 'running') {
      if (String(context.state) === 'closed') {
        this.clearCommittedContext(context);
      }
      throw new Error(
        `AudioEngine: audio context did not enter running state (${String(context.state)}).`,
      );
    }

    return {
      context,
      master: this.requireMaster(),
      contextGeneration: this.generation,
    };
  }

  /** The master input node. Throws if the context has not been created yet. */
  requireMaster(): GainNode {
    if (!this.masterBus) {
      throw new Error('AudioEngine: master bus not initialised. Call ensureContext() first.');
    }
    return this.masterBus;
  }

  /** Suspend the audio hardware (no-op if no context). */
  async suspend(): Promise<void> {
    const context = this.context;
    if (context && String(context.state) === 'running') {
      await context.suspend();
    }
  }

  /** Resume the audio hardware (no-op if no context). */
  async resume(): Promise<void> {
    const context = this.context;
    if (!context) return;
    if (String(context.state) === 'closed') {
      this.clearCommittedContext(context);
      return;
    }
    await this.ensureRunning(context);
  }

  /** Tear down the context entirely. Mainly for tests / project switches. */
  async dispose(): Promise<void> {
    const context = this.context;
    if (!context) return;

    // Clear first so an in-flight ensureContext cannot publish this context
    // after disposal. A later user gesture may safely create a replacement.
    this.clearCommittedContext(context);
    if (String(context.state) !== 'closed') {
      await context.close();
    }
  }

  /**
   * Return an existing context or synchronously construct and commit a complete
   * master graph. No partially-created context is ever exposed on failure.
   */
  private getOrCreateContext(): AudioContext {
    if (this.context && String(this.context.state) !== 'closed') {
      return this.context;
    }
    if (this.context) {
      this.clearCommittedContext(this.context);
    }

    let context: AudioContext | null = null;
    let master: GainNode | null = null;
    let limiter: DynamicsCompressorNode | null = null;
    let stateListenerAttached = false;

    try {
      context = this.createAudioContext();
      const graph = buildMasterBus(context, context.destination);
      master = graph.master;
      limiter = graph.limiter;
      context.addEventListener('statechange', this.handleContextStateChange);
      stateListenerAttached = true;
    } catch (error) {
      if (context && stateListenerAttached) {
        this.removeStateListenerBestEffort(context);
      }
      this.disconnectBestEffort(master);
      this.disconnectBestEffort(limiter);
      if (context) this.closeBestEffort(context);
      throw error;
    }

    this.context = context;
    this.masterBus = master;
    this.limiter = limiter;
    this.generation = this.generation === Number.MAX_SAFE_INTEGER
      ? 1
      : this.generation + 1;
    return context;
  }

  /** Share one resume attempt among concurrent callers for the same context. */
  private ensureRunning(context: AudioContext): Promise<void> {
    const state = String(context.state);
    if (state === 'running') return Promise.resolve();
    if (state === 'closed') {
      return Promise.reject(new Error('AudioEngine: cannot resume a closed audio context.'));
    }

    const currentFlight = this.activationFlight;
    if (currentFlight?.context === context) return currentFlight.promise;

    const promise = (async () => {
      await context.resume();
      if (this.context !== context) {
        throw new Error('AudioEngine: audio context changed while it was starting.');
      }
      if (String(context.state) !== 'running') {
        throw new Error(
          `AudioEngine: audio context did not enter running state (${String(context.state)}).`,
        );
      }
    })();
    const flight: ActivationFlight = { context, promise };
    this.activationFlight = flight;
    promise.then(
      () => {
        if (this.activationFlight === flight) this.activationFlight = null;
      },
      () => {
        if (this.activationFlight === flight) this.activationFlight = null;
      },
    );
    return promise;
  }

  private clearCommittedContext(context: AudioContext): void {
    if (this.context !== context) return;
    this.removeStateListenerBestEffort(context);
    const master = this.masterBus;
    const limiter = this.limiter;
    if (master) disposeMasterMeter(master);
    this.disconnectBestEffort(master);
    this.disconnectBestEffort(limiter);
    this.context = null;
    this.masterBus = null;
    this.limiter = null;
    if (this.activationFlight?.context === context) {
      this.activationFlight = null;
    }
  }

  private removeStateListenerBestEffort(context: AudioContext): void {
    try {
      context.removeEventListener('statechange', this.handleContextStateChange);
    } catch {
      // Cleanup should not replace the original initialization/disposal result.
    }
  }

  private disconnectBestEffort(node: AudioNode | null): void {
    if (!node) return;
    try {
      node.disconnect();
    } catch {
      // A node may never have connected if graph construction failed midway.
    }
  }

  private closeBestEffort(context: AudioContext): void {
    if (String(context.state) === 'closed') return;
    try {
      void context.close().catch(() => {
        // Preserve the graph-construction error; this context was never exposed.
      });
    } catch {
      // Some test doubles / implementations may throw before returning a promise.
    }
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
