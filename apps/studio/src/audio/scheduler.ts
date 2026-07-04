// Lookahead scheduler for the Web Audio playback engine.
//
// The realtime audio clock (AudioContext.currentTime) is sample-accurate but
// JavaScript timers are not. The classic solution (Chris Wilson, "A Tale of Two
// Clocks") is a coarse timer that wakes up periodically and schedules every
// event that falls inside a small lookahead window, using the precise audio
// clock for the actual start times.
//
// All of the scheduling MATH lives in pure exported functions so it can be unit
// tested without an AudioContext. The `Scheduler` class only owns the timer and
// the "what time is it now" plumbing.

import { createPrng } from '@cts/theory-engine';

/** Timer wake-up interval, milliseconds. Coarse on purpose. */
export const TICK_MS = 25;

/** How far ahead of the audio clock we schedule, seconds. */
export const LOOKAHEAD_S = 0.12;

/** A scheduled musical event, expressed in beats. */
export type ScheduledEvent = {
  /** Absolute position on the project timeline, in beats. */
  beat: number;
  /** Opaque payload handed back to the consumer when fired. */
  readonly payload: unknown;
};

/** A loop region in beats. */
export type LoopRegion = {
  startBeat: number;
  endBeat: number;
};

/** An event resolved to an absolute AudioContext time (seconds). */
export type DueEvent = {
  /** AudioContext time at which the event should sound. */
  time: number;
  /** Beat the event was placed at (post loop-wrap, on the project timeline). */
  beat: number;
  payload: unknown;
};

/** A raw lookahead window advanced by the scheduler tick. */
export type ScheduleWindow = {
  /** Half-open window start, in unwrapped playhead beats. */
  startBeat: number;
  /** Half-open window end, in unwrapped playhead beats. */
  endBeat: number;
};

export type DrumGrooveHitInput = {
  beat: number;
  lane: string;
  velocity: number;
  probability?: number;
  swing?: number;
  humanizeVelocity?: number;
  seed?: number;
  stepKey?: string;
  stepsPerBar?: number;
  beatsPerBar?: number;
};

export type DrumGrooveHit = {
  beat: number;
  velocity: number;
};

export type DrumGrooveRuntimeOptions = {
  swing: number;
  probability: number;
  humanizeVelocity: number;
  seed: number;
  stepsPerBar: number;
  beatsPerBar: number;
  probabilitiesByStep: Record<string, number>;
};

const DEFAULT_DRUM_GROOVE: DrumGrooveRuntimeOptions = {
  swing: 0,
  probability: 1,
  humanizeVelocity: 0,
  seed: 1,
  stepsPerBar: 16,
  beatsPerBar: 4,
  probabilitiesByStep: {},
};

let drumGrooveRuntime: DrumGrooveRuntimeOptions = DEFAULT_DRUM_GROOVE;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clampVelocity(value: number): number {
  return Math.round(clamp(value, 1, 127));
}

function safePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed: number, salt: string): number {
  return createPrng((seed >>> 0) ^ hashString(salt))();
}

function isDrumPayload(payload: unknown): payload is { kind: 'drum'; lane: string; velocity: number } {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as { kind?: unknown; lane?: unknown; velocity?: unknown };
  return (
    candidate.kind === 'drum' &&
    typeof candidate.lane === 'string' &&
    typeof candidate.velocity === 'number'
  );
}

function withPayloadVelocity(payload: unknown, velocity: number): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  return { ...payload, velocity };
}

export function makeDrumGrooveStepKey(lane: string, beat: number): string {
  const roundedBeat = Math.round(beat * 1_000_000) / 1_000_000;
  return `${lane}:${roundedBeat}`;
}

/**
 * Move every other 16th-note subdivision later by up to half a step.
 *
 * The function uses a zero-based step grid, so steps 1, 3, 5... are the
 * "back side" 16ths that swing behind the beat. `swing=0` is straight timing;
 * `swing=1` delays those off-steps by half of one grid step.
 */
export function applyDrumSwingToBeat(
  beat: number,
  swing: number,
  stepsPerBar = 16,
  beatsPerBar = 4,
): number {
  const amount = clamp01(swing);
  if (amount <= 0) return beat;

  const steps = safePositive(stepsPerBar, 16);
  const bpb = safePositive(beatsPerBar, 4);
  const beatsPerStep = bpb / steps;
  if (beatsPerStep <= 0) return beat;

  const stepPosition = beat / beatsPerStep;
  const stepIndex = Math.round(stepPosition);
  if (Math.abs(stepPosition - stepIndex) > 1e-6) return beat;
  if (stepIndex % 2 === 0) return beat;
  return beat + beatsPerStep * 0.5 * amount;
}

/** Deterministically decide whether a probabilistic drum step should sound. */
export function shouldPlayDrumStep(probability: number, seed = 1, stepKey = 'step'): boolean {
  const chance = clamp01(probability);
  if (chance <= 0) return false;
  if (chance >= 1) return true;
  return seededUnit(seed, `drum-probability:${stepKey}`) < chance;
}

/**
 * Deterministically vary MIDI velocity inside `baseVelocity +/- amount`.
 * `amount` is expressed in MIDI velocity units, not percent.
 */
export function humanizeDrumVelocity(
  baseVelocity: number,
  amount: number,
  seed = 1,
  stepKey = 'step',
): number {
  const width = Math.round(clamp(amount, 0, 127));
  const base = clampVelocity(baseVelocity);
  if (width <= 0) return base;
  const offset = Math.round((seededUnit(seed, `drum-velocity:${stepKey}`) * 2 - 1) * width);
  return clampVelocity(base + offset);
}

/** Apply probability, swing, and velocity humanization to one drum hit. */
export function resolveDrumGrooveHit(input: DrumGrooveHitInput): DrumGrooveHit | null {
  const seed = Math.trunc(input.seed ?? 1);
  const stepKey = input.stepKey ?? makeDrumGrooveStepKey(input.lane, input.beat);
  if (!shouldPlayDrumStep(input.probability ?? 1, seed, stepKey)) return null;

  return {
    beat: applyDrumSwingToBeat(
      input.beat,
      input.swing ?? 0,
      input.stepsPerBar ?? 16,
      input.beatsPerBar ?? 4,
    ),
    velocity: humanizeDrumVelocity(
      input.velocity,
      input.humanizeVelocity ?? 0,
      seed,
      stepKey,
    ),
  };
}

/** Runtime hook used by the drum grid; pure helpers above stay independently testable. */
export function setDrumGrooveRuntimeOptions(options: Partial<DrumGrooveRuntimeOptions>): void {
  drumGrooveRuntime = {
    swing: clamp01(options.swing ?? drumGrooveRuntime.swing),
    probability: clamp01(options.probability ?? drumGrooveRuntime.probability),
    humanizeVelocity: clamp(options.humanizeVelocity ?? drumGrooveRuntime.humanizeVelocity, 0, 127),
    seed: Math.trunc(options.seed ?? drumGrooveRuntime.seed),
    stepsPerBar: safePositive(options.stepsPerBar, drumGrooveRuntime.stepsPerBar),
    beatsPerBar: safePositive(options.beatsPerBar, drumGrooveRuntime.beatsPerBar),
    probabilitiesByStep: { ...(options.probabilitiesByStep ?? drumGrooveRuntime.probabilitiesByStep) },
  };
}

export function getDrumGrooveRuntimeOptions(): DrumGrooveRuntimeOptions {
  return {
    ...drumGrooveRuntime,
    probabilitiesByStep: { ...drumGrooveRuntime.probabilitiesByStep },
  };
}

function resolveDueEvent(
  ev: ScheduledEvent,
  playheadBeat: number,
  sourceBeat: number,
  bpm: number,
  anchorBeat: number,
  anchorTime: number,
): DueEvent | null {
  if (!isDrumPayload(ev.payload)) {
    return {
      time: beatToTime(playheadBeat, bpm, anchorBeat, anchorTime),
      beat: sourceBeat,
      payload: ev.payload,
    };
  }

  const sourceKey = makeDrumGrooveStepKey(ev.payload.lane, sourceBeat);
  const playheadKey = makeDrumGrooveStepKey(ev.payload.lane, playheadBeat);
  const hit = resolveDrumGrooveHit({
    beat: playheadBeat,
    lane: ev.payload.lane,
    velocity: ev.payload.velocity,
    probability: drumGrooveRuntime.probabilitiesByStep[sourceKey] ?? drumGrooveRuntime.probability,
    swing: drumGrooveRuntime.swing,
    humanizeVelocity: drumGrooveRuntime.humanizeVelocity,
    seed: drumGrooveRuntime.seed,
    stepKey: playheadKey,
    stepsPerBar: drumGrooveRuntime.stepsPerBar,
    beatsPerBar: drumGrooveRuntime.beatsPerBar,
  });
  if (!hit) return null;

  return {
    time: beatToTime(hit.beat, bpm, anchorBeat, anchorTime),
    beat: sourceBeat,
    payload: withPayloadVelocity(ev.payload, hit.velocity),
  };
}

/** Seconds per beat for a given tempo. */
export function secondsPerBeat(bpm: number): number {
  const safe = bpm > 0 ? bpm : 120;
  return 60 / safe;
}

/**
 * Convert a beat position to an absolute AudioContext time.
 *
 * `anchorTime` is the AudioContext time that corresponds to `anchorBeat`
 * (typically the play-start: the audio time captured when playback began and
 * the beat the playhead started from). Everything else is linear in tempo.
 */
export function beatToTime(
  beat: number,
  bpm: number,
  anchorBeat: number,
  anchorTime: number,
): number {
  return anchorTime + (beat - anchorBeat) * secondsPerBeat(bpm);
}

/** Inverse of {@link beatToTime}: AudioContext time -> beat. */
export function timeToBeat(
  time: number,
  bpm: number,
  anchorBeat: number,
  anchorTime: number,
): number {
  return anchorBeat + (time - anchorTime) / secondsPerBeat(bpm);
}

/**
 * Validate that a loop region is usable (positive length, ordered).
 * A zero/negative length region is treated as "no loop".
 */
export function isValidLoop(loop: LoopRegion | null): loop is LoopRegion {
  return loop != null && loop.endBeat > loop.startBeat;
}

/**
 * Wrap a beat position into a loop region.
 *
 * Beats before the region are passed through unchanged (the playhead has not
 * reached the loop yet). Once at/after `endBeat` the position folds back into
 * the region modulo its length, so an arbitrarily large beat maps into
 * `[startBeat, endBeat)`.
 */
export function wrapBeat(beat: number, loop: LoopRegion): number {
  const length = loop.endBeat - loop.startBeat;
  if (length <= 0) return beat;
  if (beat < loop.startBeat) return beat;
  const offset = (beat - loop.startBeat) % length;
  return loop.startBeat + offset;
}

/**
 * Advance a playhead beat by a delta, honoring an optional loop region.
 *
 * Returns the next beat. With a valid loop the result always stays inside
 * `[startBeat, endBeat)` once the playhead has entered the region.
 */
export function advanceBeat(
  beat: number,
  deltaBeats: number,
  loop: LoopRegion | null,
): number {
  const next = beat + deltaBeats;
  if (!isValidLoop(loop)) return next;
  return wrapBeat(next, loop);
}

/**
 * Select the events whose beat falls inside the half-open window
 * `[windowStartBeat, windowEndBeat)` and resolve them to absolute audio times.
 *
 * When a loop is active, the window is interpreted as a contiguous run of
 * *playhead* beats that may cross the loop boundary; each window beat is mapped
 * back into the loop region to find the source event, while the returned
 * `time` reflects the (unwrapped) playhead beat so successive loop passes are
 * scheduled at increasing audio times.
 *
 * Pure: no AudioContext, no side effects.
 */
export function nextEventsInWindow(
  events: readonly ScheduledEvent[],
  windowStartBeat: number,
  windowEndBeat: number,
  bpm: number,
  anchorBeat: number,
  anchorTime: number,
  loop: LoopRegion | null,
): DueEvent[] {
  if (windowEndBeat <= windowStartBeat) return [];

  const due: DueEvent[] = [];
  const hasLoop = isValidLoop(loop);

  if (!hasLoop) {
    for (const ev of events) {
      if (ev.beat >= windowStartBeat && ev.beat < windowEndBeat) {
        const resolved = resolveDueEvent(ev, ev.beat, ev.beat, bpm, anchorBeat, anchorTime);
        if (resolved) due.push(resolved);
      }
    }
    due.sort((a, b) => a.time - b.time);
    return due;
  }

  // Looping: each source event inside the region recurs once per loop pass.
  const region = loop;
  const length = region.endBeat - region.startBeat;

  for (const ev of events) {
    // Events outside the loop region are unreachable once looping: the playhead
    // wraps at endBeat and never advances to them. Skip them entirely.
    if (ev.beat < region.startBeat || ev.beat >= region.endBeat) {
      continue;
    }

    // The event recurs at ev.beat + k*length for every integer k >= 0 such that
    // the recurrence lands in the window.
    const firstK = Math.ceil((windowStartBeat - ev.beat) / length);
    const startK = Math.max(0, firstK);
    for (let k = startK; ; k += 1) {
      const playheadBeat = ev.beat + k * length;
      if (playheadBeat >= windowEndBeat) break;
      if (playheadBeat < windowStartBeat) continue;
      const resolved = resolveDueEvent(ev, playheadBeat, ev.beat, bpm, anchorBeat, anchorTime);
      if (resolved) due.push(resolved);
    }
  }

  due.sort((a, b) => a.time - b.time);
  return due;
}

/**
 * Total length of a project in beats.
 * Stop-at-end (loop off) uses this as the hard cutoff.
 */
export function projectLengthBeats(lengthBars: number, beatsPerBar: number): number {
  const bars = lengthBars > 0 ? lengthBars : 0;
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  return bars * bpb;
}

// ---------------------------------------------------------------------------
// Scheduler class — owns the coarse timer; delegates math to the pure fns.
// ---------------------------------------------------------------------------

/** A function returning the current audio clock time (seconds). */
export type ClockFn = () => number;

/**
 * Called for every batch of due events. Implementations must do only light
 * work here — voice allocation, node creation — never heavy synthesis loops.
 */
export type FireFn = (events: DueEvent[]) => void;

/** Called once when the playhead passes the project end with loop off. */
export type EndFn = () => void;

/** Called whenever the scheduler advances its raw lookahead window. */
export type ScheduleWindowFn = (window: ScheduleWindow) => void;

export type SchedulerOptions = {
  clock: ClockFn;
  fire: FireFn;
  onScheduleWindow?: ScheduleWindowFn;
  onEnd?: EndFn;
  /** Override timer interval (ms); defaults to {@link TICK_MS}. */
  tickMs?: number;
  /** Override lookahead window (s); defaults to {@link LOOKAHEAD_S}. */
  lookaheadS?: number;
};

/**
 * Lookahead scheduler. Drives playback of a fixed list of beat-stamped events
 * against the audio clock, honoring an optional loop region and stopping at the
 * project end when looping is off.
 */
export class Scheduler {
  private readonly clock: ClockFn;
  private readonly fire: FireFn;
  private readonly onScheduleWindow?: ScheduleWindowFn;
  private readonly onEnd?: EndFn;
  private readonly tickMs: number;
  private readonly lookaheadS: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private events: readonly ScheduledEvent[] = [];
  private bpm = 120;
  private loop: LoopRegion | null = null;
  private endBeat = Infinity;

  /** Beat already scheduled up to (exclusive). Frontier of the lookahead. */
  private scheduledBeat = 0;
  /** Beat the playhead started from. */
  private anchorBeat = 0;
  /** Audio time captured when playback (re)started. */
  private anchorTime = 0;
  private running = false;

  constructor(options: SchedulerOptions) {
    this.clock = options.clock;
    this.fire = options.fire;
    this.onScheduleWindow = options.onScheduleWindow;
    this.onEnd = options.onEnd;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.lookaheadS = options.lookaheadS ?? LOOKAHEAD_S;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Start scheduling.
   *
   * @param events     all events to play, in beats (need not be sorted)
   * @param bpm        tempo
   * @param startBeat  playhead start position in beats
   * @param loop       loop region, or null for one-shot playback
   * @param endBeat    project end (stop point when loop is off)
   */
  start(
    events: readonly ScheduledEvent[],
    bpm: number,
    startBeat: number,
    loop: LoopRegion | null,
    endBeat: number,
  ): void {
    this.stop();
    this.events = events;
    this.bpm = bpm;
    this.loop = isValidLoop(loop) ? loop : null;
    this.endBeat = Number.isFinite(endBeat) ? endBeat : Infinity;
    this.anchorBeat = startBeat;
    this.scheduledBeat = startBeat;
    this.anchorTime = this.clock();
    this.running = true;
    // Schedule the first window immediately, then on each tick.
    this.tick();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  /** Stop the timer. Does not release any already-scheduled audio. */
  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /**
   * Compute the beat that corresponds to the current audio clock time. Used by
   * the playback layer to drive the on-screen playhead. Loop-wrapped.
   */
  currentBeat(): number {
    const raw = timeToBeat(this.clock(), this.bpm, this.anchorBeat, this.anchorTime);
    if (this.loop) return wrapBeat(raw, this.loop);
    return raw;
  }

  private tick(): void {
    if (!this.running) return;
    const now = this.clock();
    const horizonTime = now + this.lookaheadS;
    // Convert the time horizon into a playhead-beat horizon.
    const horizonBeat = timeToBeat(horizonTime, this.bpm, this.anchorBeat, this.anchorTime);

    // Stop-at-end: clamp the horizon to the project end when not looping.
    const effectiveHorizon = this.loop ? horizonBeat : Math.min(horizonBeat, this.endBeat);

    if (effectiveHorizon > this.scheduledBeat) {
      const windowStartBeat = this.scheduledBeat;
      this.onScheduleWindow?.({ startBeat: windowStartBeat, endBeat: effectiveHorizon });
      const due = nextEventsInWindow(
        this.events,
        windowStartBeat,
        effectiveHorizon,
        this.bpm,
        this.anchorBeat,
        this.anchorTime,
        this.loop,
      );
      if (due.length > 0) this.fire(due);
      this.scheduledBeat = effectiveHorizon;
    }

    // End handling (loop off): once the playhead itself has reached the end.
    if (!this.loop && this.scheduledBeat >= this.endBeat) {
      const playheadBeat = timeToBeat(now, this.bpm, this.anchorBeat, this.anchorTime);
      if (playheadBeat >= this.endBeat) {
        this.stop();
        this.onEnd?.();
      }
    }
  }
}
