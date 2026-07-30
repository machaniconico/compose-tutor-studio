import {
  applyAudioParam,
  clampVolume,
  type MixUpdateMode,
} from './mixState';
import { AUTOMATION_MANUAL_SMOOTHING_SECONDS } from './graph';

type AutomationOverride = Readonly<{
  generation: number;
  until: number;
}>;

/**
 * Owns the persisted Master fader and its live automation schedule.
 *
 * The application-wide AudioEngine gain is intentionally kept out of this
 * controller: it remains an output/calibration stage while each playback
 * session gets an independently disposable Master fader.
 */
export class MasterAutomationGraph {
  private automationOverride: AutomationOverride | null = null;
  private automationOverrideGeneration = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly fader: GainNode,
  ) {}

  /** Apply the persisted Master scalar unless a manual gesture owns it. */
  applyScalar(
    value: number,
    when: number,
    mode: MixUpdateMode,
  ): boolean {
    this.retireExpiredOverride(this.ctx.currentTime);
    if (this.automationOverride !== null) return false;
    applyAudioParam(this.fader.gain, clampVolume(value), when, mode);
    return true;
  }

  /** Append one sample-accurate volume command to the Master fader. */
  scheduleAutomation(
    value: number,
    when: number,
    interpolation: 'hold' | 'linear',
  ): void {
    this.retireExpiredOverride(this.ctx.currentTime);
    const activeOverride = this.automationOverride;
    if (activeOverride !== null) {
      if (when <= activeOverride.until) return;
    }

    const safeValue = clampVolume(value);
    const candidate = this.fader.gain as AudioParam & {
      linearRampToValueAtTime?: (value: number, endTime: number) => AudioParam;
      setValueAtTime?: (value: number, startTime: number) => AudioParam;
    };
    if (
      interpolation === 'linear'
      && typeof candidate.linearRampToValueAtTime === 'function'
    ) {
      candidate.linearRampToValueAtTime(safeValue, when);
    } else if (typeof candidate.setValueAtTime === 'function') {
      candidate.setValueAtTime(safeValue, when);
    } else {
      this.fader.gain.value = safeValue;
    }
  }

  /** Cancel lookahead commands and give a manual gesture ownership. */
  beginAutomationOverride(value: number, when: number): number {
    const generation = this.nextAutomationOverrideGeneration();
    this.automationOverride = { generation, until: Number.POSITIVE_INFINITY };
    this.smoothAutomationOverride(value, when);
    return generation;
  }

  /** Update a manually owned value while retaining its scheduling fence. */
  updateAutomationOverride(value: number, when: number): number {
    if (this.automationOverride === null) {
      return this.beginAutomationOverride(value, when);
    }
    this.smoothAutomationOverride(value, when);
    return this.automationOverride.generation;
  }

  /**
   * Return to the frozen playback curve and resume later lookahead commands.
   * A generation token prevents a stale pointer-up from releasing a newer drag.
   */
  releaseAutomationOverride(
    frozenValue: number,
    when: number,
    returnSeconds: number,
    expectedGeneration?: number,
  ): boolean {
    const active = this.automationOverride;
    if (
      active === null
      || (
        expectedGeneration !== undefined
        && active.generation !== expectedGeneration
      )
    ) {
      return false;
    }

    const duration = Number.isFinite(returnSeconds)
      ? Math.max(0, returnSeconds)
      : 0;
    const endTime = Math.max(when, when + duration);
    this.automationOverride = {
      generation: active.generation,
      until: endTime,
    };
    const safeValue = clampVolume(frozenValue);
    this.cancelAndHold(when);
    const candidate = this.fader.gain as AudioParam & {
      linearRampToValueAtTime?: (value: number, endTime: number) => AudioParam;
      setValueAtTime?: (value: number, startTime: number) => AudioParam;
    };
    if (
      duration > 0
      && typeof candidate.linearRampToValueAtTime === 'function'
    ) {
      candidate.linearRampToValueAtTime(safeValue, endTime);
    } else if (typeof candidate.setValueAtTime === 'function') {
      candidate.setValueAtTime(safeValue, endTime);
    } else {
      this.fader.gain.value = safeValue;
    }
    return true;
  }

  /** True while a gesture or its return ramp owns the fader. */
  isAutomationOverridden(when = this.ctx.currentTime): boolean {
    this.retireExpiredOverride(when);
    return this.automationOverride !== null;
  }

  /** Release session-owned gesture state during teardown. */
  dispose(): void {
    this.automationOverride = null;
  }

  private cancelAndHold(when: number): void {
    const param = this.fader.gain;
    const candidate = param as AudioParam & {
      cancelAndHoldAtTime?: (cancelTime: number) => AudioParam;
      cancelScheduledValues?: (cancelTime: number) => AudioParam;
      setValueAtTime?: (value: number, startTime: number) => AudioParam;
    };
    if (typeof candidate.cancelAndHoldAtTime === 'function') {
      candidate.cancelAndHoldAtTime(when);
      return;
    }
    candidate.cancelScheduledValues?.(when);
    candidate.setValueAtTime?.(param.value, when);
  }

  private smoothAutomationOverride(value: number, when: number): void {
    const safeValue = clampVolume(value);
    this.cancelAndHold(when);
    const candidate = this.fader.gain as AudioParam & {
      linearRampToValueAtTime?: (value: number, endTime: number) => AudioParam;
      setValueAtTime?: (value: number, startTime: number) => AudioParam;
    };
    const endTime = when + AUTOMATION_MANUAL_SMOOTHING_SECONDS;
    if (typeof candidate.linearRampToValueAtTime === 'function') {
      candidate.linearRampToValueAtTime(safeValue, endTime);
    } else if (typeof candidate.setValueAtTime === 'function') {
      candidate.setValueAtTime(safeValue, endTime);
    } else {
      this.fader.gain.value = safeValue;
    }
  }

  private nextAutomationOverrideGeneration(): number {
    this.automationOverrideGeneration =
      this.automationOverrideGeneration === Number.MAX_SAFE_INTEGER
        ? 1
        : this.automationOverrideGeneration + 1;
    return this.automationOverrideGeneration;
  }

  private retireExpiredOverride(now: number): void {
    const active = this.automationOverride;
    if (active !== null && Number.isFinite(now) && now > active.until) {
      this.automationOverride = null;
    }
  }
}

export type SessionMasterGraph = Readonly<{
  /** Natural-drain/final-tail stage. */
  output: GainNode;
  /** Persisted Project Master fader. */
  master: GainNode;
  /** Application-wide output/calibration stage. */
  engineMaster: GainNode;
  automation: MasterAutomationGraph;
  dispose: () => void;
}>;

/**
 * Build an isolated playback Master topology:
 * session output -> Project Master fader -> engine output/calibration stage.
 */
export function buildSessionMasterGraph(
  ctx: BaseAudioContext,
  engineMaster: GainNode,
  projectMasterGain: number,
  when: number,
): SessionMasterGraph {
  let output: GainNode | null = null;
  let master: GainNode | null = null;
  let automation: MasterAutomationGraph | null = null;
  let outputConnected = false;
  let masterConnected = false;
  try {
    output = ctx.createGain();
    master = ctx.createGain();
    output.gain.value = 1;
    master.gain.value = 1;
    output.connect(master);
    outputConnected = true;
    master.connect(engineMaster);
    masterConnected = true;
    automation = new MasterAutomationGraph(ctx, master);
    applyAudioParam(engineMaster.gain, 1, when, 'immediate');
    automation.applyScalar(projectMasterGain, when, 'immediate');
  } catch (error) {
    automation?.dispose();
    if (outputConnected && output && master) {
      try { output.disconnect(master); } catch { /* construction rollback */ }
    }
    if (masterConnected && master) {
      try { master.disconnect(engineMaster); } catch { /* construction rollback */ }
    }
    throw error;
  }

  const ownedOutput = output;
  const ownedMaster = master;
  const ownedAutomation = automation;
  let disposed = false;
  return {
    output: ownedOutput,
    master: ownedMaster,
    engineMaster,
    automation: ownedAutomation,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ownedAutomation.dispose();
      try { ownedOutput.disconnect(ownedMaster); } catch { /* already disconnected */ }
      try { ownedMaster.disconnect(engineMaster); } catch { /* already disconnected */ }
    },
  };
}
