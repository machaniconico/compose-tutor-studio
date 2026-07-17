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

/** One immutable source-event entry in a beat-sorted schedule index. */
export type ScheduleEventIndexEntry = Readonly<{
  event: Readonly<ScheduledEvent>;
  sourceOrdinal: number;
  /** Effective onset for one-shot playback, or loop-normalized onset phase. */
  indexedBeat: number;
  /** Loop cycles crossed by deterministic swing before the first occurrence. */
  passShift: number;
}>;

/** Immutable, loop-specific index built once when transport playback starts. */
export type ScheduleEventIndex = Readonly<{
  sourceEventCount: number;
  loop: Readonly<LoopRegion> | null;
  entries: readonly ScheduleEventIndexEntry[];
}>;

/** Deterministic query-work counters used by load and regression tests. */
export type ScheduleQueryStats = Readonly<{
  sourceEventCount: number;
  indexedEventCount: number;
  rangeCount: number;
  lowerBoundComparisons: number;
  candidatesVisited: number;
  emitted: number;
}>;

export type ScheduleQueryResult = Readonly<{
  events: DueEvent[];
  stats: ScheduleQueryStats;
}>;

export type ScheduleDensityBudgetResult =
  | Readonly<{
      ok: true;
      observed: number;
      limit: number;
    }>
  | Readonly<{
      ok: false;
      observed: number;
      limit: number;
      windowStartBeat: number;
    }>;

export type DrumGrooveHitInput = {
  beat: number;
  lane: string;
  velocity: number;
  probability?: number;
  swing?: number;
  humanizeVelocity?: number;
  seed?: number;
  stepKey?: string;
  sourceStepIndex?: number;
  stepsPerBar?: number;
  beatsPerBar?: number;
};

export type DrumGrooveHit = {
  beat: number;
  velocity: number;
};

type DrumPayload = {
  kind: 'drum';
  trackId?: string;
  lane: string;
  velocity: number;
  voiceSeed?: number;
};

type SelfContainedDrumPayload = DrumPayload & {
  trackId: string;
  clipId: string;
  eventId: string;
  sourceStepIndex: number;
  clipEndBeat: number;
  stepsPerBar: number;
  beatsPerBar: number;
  probability: number;
  swing: number;
  humanizeVelocity: number;
  seed: number;
};

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
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
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

function isDrumPayload(payload: unknown): payload is DrumPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as { kind?: unknown; lane?: unknown; velocity?: unknown };
  return (
    candidate.kind === 'drum' &&
    typeof candidate.lane === 'string' &&
    typeof candidate.velocity === 'number'
  );
}

function isSelfContainedDrumPayload(payload: DrumPayload): payload is SelfContainedDrumPayload {
  const candidate = payload as Partial<SelfContainedDrumPayload>;
  return (
    typeof candidate.trackId === 'string' &&
    typeof candidate.clipId === 'string' &&
    typeof candidate.eventId === 'string' &&
    Number.isSafeInteger(candidate.sourceStepIndex) &&
    typeof candidate.clipEndBeat === 'number' &&
    typeof candidate.stepsPerBar === 'number' &&
    typeof candidate.beatsPerBar === 'number' &&
    typeof candidate.probability === 'number' &&
    typeof candidate.swing === 'number' &&
    typeof candidate.humanizeVelocity === 'number' &&
    typeof candidate.seed === 'number'
  );
}

function withResolvedDrumVoice(
  payload: unknown,
  velocity: number,
  voiceSeed: number,
): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  return { ...payload, velocity, voiceSeed };
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

/** Apply swing from the source clip step parity, independent of clip placement. */
export function applyDrumSwingToOccurrenceBeat(
  playheadBeat: number,
  sourceStepIndex: number,
  swing: number,
  stepsPerBar = 16,
  beatsPerBar = 4,
): number {
  const amount = clamp01(swing);
  if (amount <= 0 || !Number.isSafeInteger(sourceStepIndex) || sourceStepIndex % 2 === 0) {
    return playheadBeat;
  }
  const steps = safePositive(stepsPerBar, 16);
  const bpb = safePositive(beatsPerBar, 4);
  return playheadBeat + (bpb / steps) * 0.5 * amount;
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
    beat: input.sourceStepIndex === undefined
      ? applyDrumSwingToBeat(
          input.beat,
          input.swing ?? 0,
          input.stepsPerBar ?? 16,
          input.beatsPerBar ?? 4,
        )
      : applyDrumSwingToOccurrenceBeat(
          input.beat,
          input.sourceStepIndex,
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

function roundedBeatKey(beat: number): number {
  return Math.round(beat * 1_000_000) / 1_000_000;
}

function occurrenceSalt(payload: SelfContainedDrumPayload, playheadBeat: number): string {
  return JSON.stringify([
    payload.trackId,
    payload.clipId,
    payload.eventId,
    payload.lane,
    payload.sourceStepIndex,
    roundedBeatKey(playheadBeat),
  ]);
}

/** Stable voice identity; bump the domain tag only for an intentional sound change. */
function occurrenceVoiceSeed(
  payload: SelfContainedDrumPayload,
  playheadBeat: number,
): number {
  const persistedSeed =
    Number.isSafeInteger(payload.seed) && payload.seed > 0 ? payload.seed : 1;
  return hashString(JSON.stringify([
    'cts-drum-voice-v1',
    persistedSeed,
    payload.trackId,
    payload.clipId,
    payload.eventId,
    payload.lane,
    payload.sourceStepIndex,
    roundedBeatKey(playheadBeat),
  ]));
}

/** Deterministic fallback for pre-groove payloads that lack clip/event identity. */
function legacyOccurrenceVoiceSeed(payload: DrumPayload, playheadBeat: number): number {
  return hashString(JSON.stringify([
    'cts-drum-legacy-voice-v1',
    payload.trackId ?? '',
    payload.lane,
    roundedBeatKey(playheadBeat),
  ]));
}

function occurrenceSwingLookback(payload: unknown): number {
  if (!isDrumPayload(payload) || !isSelfContainedDrumPayload(payload)) return 0;
  if (payload.sourceStepIndex % 2 === 0) return 0;
  const steps = safePositive(payload.stepsPerBar, 16);
  const beatsPerBar = safePositive(payload.beatsPerBar, 4);
  return (beatsPerBar / steps) * 0.5 * clamp01(payload.swing);
}

function effectiveOnsetBeat(event: ScheduledEvent): number {
  return event.beat + occurrenceSwingLookback(event.payload);
}

function canReachAnyScheduleWindow(event: ScheduledEvent): boolean {
  if (!isDrumPayload(event.payload) || !isSelfContainedDrumPayload(event.payload)) {
    return true;
  }
  const clipEndBeat = Number.isFinite(event.payload.clipEndBeat)
    ? event.payload.clipEndBeat
    : Number.POSITIVE_INFINITY;
  return effectiveOnsetBeat(event) < clipEndBeat;
}

/** Resolve one raw scheduled occurrence for both live playback and offline WAV. */
export function resolveDrumOccurrence(
  event: ScheduledEvent,
  playheadBeat: number = event.beat,
): ScheduledEvent | null {
  if (!isDrumPayload(event.payload)) {
    return { beat: playheadBeat, payload: event.payload };
  }

  // Legacy raw drum payloads had no clip identity or persisted groove. Preserve
  // their old neutral schedule without consulting any process-global UI state.
  if (!isSelfContainedDrumPayload(event.payload)) {
    return {
      beat: playheadBeat,
      payload: withResolvedDrumVoice(
        event.payload,
        clampVelocity(event.payload.velocity),
        legacyOccurrenceVoiceSeed(event.payload, playheadBeat),
      ),
    };
  }

  const payload = event.payload;
  const seed = Number.isSafeInteger(payload.seed) && payload.seed > 0 ? payload.seed : 1;
  const hit = resolveDrumGrooveHit({
    beat: playheadBeat,
    lane: payload.lane,
    velocity: payload.velocity,
    probability: clamp01(payload.probability),
    swing: clamp01(payload.swing),
    humanizeVelocity: clamp(payload.humanizeVelocity, 0, 127),
    seed,
    stepKey: occurrenceSalt(payload, playheadBeat),
    sourceStepIndex: payload.sourceStepIndex,
    stepsPerBar: safePositive(payload.stepsPerBar, 16),
    beatsPerBar: safePositive(payload.beatsPerBar, 4),
  });
  if (!hit) return null;
  const sourceClipEnd = Number.isFinite(payload.clipEndBeat)
    ? payload.clipEndBeat
    : Number.POSITIVE_INFINITY;
  const occurrenceClipEnd = sourceClipEnd + (playheadBeat - event.beat);
  if (hit.beat >= occurrenceClipEnd) return null;
  return {
    beat: hit.beat,
    payload: withResolvedDrumVoice(
      payload,
      hit.velocity,
      occurrenceVoiceSeed(payload, playheadBeat),
    ),
  };
}

function resolveDueEvent(
  ev: ScheduledEvent,
  playheadBeat: number,
  sourceBeat: number,
  tempo: TempoSource,
  anchorBeat: number,
  anchorTime: number,
  windowStartBeat: number,
  windowEndBeat: number,
): DueEvent | null {
  const occurrence = resolveDrumOccurrence(ev, playheadBeat);
  if (
    !occurrence ||
    occurrence.beat < windowStartBeat ||
    occurrence.beat >= windowEndBeat
  ) return null;

  return {
    time: beatToTime(occurrence.beat, tempo, anchorBeat, anchorTime),
    beat: sourceBeat,
    payload: occurrence.payload,
  };
}

/** Seconds per beat for a given tempo. */
export function secondsPerBeat(bpm: number): number {
  const safe = bpm > 0 ? bpm : 120;
  return 60 / safe;
}

/** A precompiled, monotonic mapping between project beats and elapsed seconds. */
export type BeatTimeMapping = Readonly<{
  beatToSeconds: (beat: number) => number;
  secondsToBeat: (seconds: number) => number;
}>;

/** Fixed BPM remains supported for callers and tests that do not need a tempo map. */
export type TempoSource = number | BeatTimeMapping;

function isBeatTimeMapping(source: TempoSource): source is BeatTimeMapping {
  return typeof source !== 'number';
}

function elapsedSecondsAtBeat(beat: number, source: TempoSource): number {
  return isBeatTimeMapping(source)
    ? source.beatToSeconds(beat)
    : beat * secondsPerBeat(source);
}

function beatAtElapsedSeconds(seconds: number, source: TempoSource): number {
  return isBeatTimeMapping(source)
    ? source.secondsToBeat(seconds)
    : seconds / secondsPerBeat(source);
}

/**
 * Repeat the tempo contour inside a loop on every pass.
 *
 * The scheduler advances on an unwrapped beat axis. Without this adapter a
 * tempo map would be applied only on the first pass and every later pass would
 * incorrectly continue at the map's final tempo.
 */
export function loopBeatTimeMapping(
  source: TempoSource,
  loop: LoopRegion,
): BeatTimeMapping {
  const loopLength = loop.endBeat - loop.startBeat;
  if (!(loopLength > 0)) {
    return {
      beatToSeconds: (beat) => elapsedSecondsAtBeat(beat, source),
      secondsToBeat: (seconds) => beatAtElapsedSeconds(seconds, source),
    };
  }

  const loopStartSeconds = elapsedSecondsAtBeat(loop.startBeat, source);
  const loopEndSeconds = elapsedSecondsAtBeat(loop.endBeat, source);
  const loopSeconds = loopEndSeconds - loopStartSeconds;
  if (!(loopSeconds > 0) || !Number.isFinite(loopSeconds)) {
    return {
      beatToSeconds: (beat) => elapsedSecondsAtBeat(beat, source),
      secondsToBeat: (seconds) => beatAtElapsedSeconds(seconds, source),
    };
  }

  return {
    beatToSeconds: (beat) => {
      if (beat < loop.startBeat) return elapsedSecondsAtBeat(beat, source);
      const offset = beat - loop.startBeat;
      const cycle = Math.floor(offset / loopLength);
      const phaseBeat = loop.startBeat + (offset - cycle * loopLength);
      return loopStartSeconds
        + cycle * loopSeconds
        + (elapsedSecondsAtBeat(phaseBeat, source) - loopStartSeconds);
    },
    secondsToBeat: (seconds) => {
      if (seconds < loopStartSeconds) return beatAtElapsedSeconds(seconds, source);
      const offset = seconds - loopStartSeconds;
      const cycle = Math.floor(offset / loopSeconds);
      const phaseSeconds = loopStartSeconds + (offset - cycle * loopSeconds);
      const phaseBeat = beatAtElapsedSeconds(phaseSeconds, source);
      return loop.startBeat + cycle * loopLength + (phaseBeat - loop.startBeat);
    },
  };
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
  tempo: TempoSource,
  anchorBeat: number,
  anchorTime: number,
): number {
  if (typeof tempo === 'number') {
    return anchorTime + (beat - anchorBeat) * secondsPerBeat(tempo);
  }
  return anchorTime
    + elapsedSecondsAtBeat(beat, tempo)
    - elapsedSecondsAtBeat(anchorBeat, tempo);
}

/** Inverse of {@link beatToTime}: AudioContext time -> beat. */
export function timeToBeat(
  time: number,
  tempo: TempoSource,
  anchorBeat: number,
  anchorTime: number,
): number {
  if (typeof tempo === 'number') {
    return anchorBeat + (time - anchorTime) / secondsPerBeat(tempo);
  }
  const anchorElapsed = elapsedSecondsAtBeat(anchorBeat, tempo);
  return beatAtElapsedSeconds(anchorElapsed + time - anchorTime, tempo);
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

type MutableScheduleQueryStats = {
  sourceEventCount: number;
  indexedEventCount: number;
  rangeCount: number;
  lowerBoundComparisons: number;
  candidatesVisited: number;
  emitted: number;
};

type IndexedDueEvent = {
  due: DueEvent;
  sourceOrdinal: number;
};

function finiteBeat(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite beat`);
  }
  return value;
}

/**
 * Snapshot and sort a schedule once for repeated half-open range queries.
 *
 * A loop uses normalized effective-onset phases. `passShift` records how many
 * loop cycles a deterministic swing delay crosses, including delays longer
 * than the loop itself.
 */
export function createScheduleEventIndex(
  events: readonly ScheduledEvent[],
  loop: LoopRegion | null = null,
): ScheduleEventIndex {
  let normalizedLoop: Readonly<LoopRegion> | null = null;
  if (isValidLoop(loop)) {
    const startBeat = finiteBeat(loop.startBeat, 'loop.startBeat');
    const endBeat = finiteBeat(loop.endBeat, 'loop.endBeat');
    normalizedLoop = Object.freeze({ startBeat, endBeat });
  }

  const entries: ScheduleEventIndexEntry[] = [];
  const loopLength = normalizedLoop
    ? normalizedLoop.endBeat - normalizedLoop.startBeat
    : 0;

  events.forEach((sourceEvent, sourceOrdinal) => {
    const beat = finiteBeat(sourceEvent.beat, `events[${sourceOrdinal}].beat`);
    if (
      normalizedLoop &&
      (beat < normalizedLoop.startBeat || beat >= normalizedLoop.endBeat)
    ) {
      return;
    }

    // Effective onset depends on persisted drum-groove scalars. Snapshot that
    // flat payload together with the beat so later caller mutation cannot make
    // the immutable index disagree with occurrence resolution.
    const payload = isDrumPayload(sourceEvent.payload) &&
      isSelfContainedDrumPayload(sourceEvent.payload)
      ? Object.freeze({ ...sourceEvent.payload })
      : sourceEvent.payload;
    const event = Object.freeze({ beat, payload });
    const onsetBeat = finiteBeat(
      effectiveOnsetBeat(event),
      `events[${sourceOrdinal}] effective onset`,
    );
    let indexedBeat = onsetBeat;
    let passShift = 0;

    if (normalizedLoop) {
      passShift = Math.floor((onsetBeat - normalizedLoop.startBeat) / loopLength);
      indexedBeat = onsetBeat - passShift * loopLength;

      // Absorb floating-point edge drift while preserving the corresponding
      // unwrapped occurrence represented by passShift.
      if (indexedBeat < normalizedLoop.startBeat) {
        indexedBeat += loopLength;
        passShift -= 1;
      } else if (indexedBeat >= normalizedLoop.endBeat) {
        indexedBeat -= loopLength;
        passShift += 1;
      }
    }

    entries.push(Object.freeze({
      event,
      sourceOrdinal,
      indexedBeat,
      passShift,
    }));
  });

  entries.sort(
    (left, right) =>
      left.indexedBeat - right.indexedBeat || left.sourceOrdinal - right.sourceOrdinal,
  );

  return Object.freeze({
    sourceEventCount: events.length,
    loop: normalizedLoop,
    entries: Object.freeze(entries),
  });
}

function lowerBoundIndexedBeat(
  entries: readonly ScheduleEventIndexEntry[],
  targetBeat: number,
  stats: MutableScheduleQueryStats | null,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (stats) stats.lowerBoundComparisons += 1;
    if ((entries[middle]?.indexedBeat ?? Number.POSITIVE_INFINITY) < targetBeat) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function appendIndexedRange(
  index: ScheduleEventIndex,
  rangeStartBeat: number,
  rangeEndBeat: number,
  searchPaddingBeats: number,
  cycle: number,
  tempo: TempoSource,
  anchorBeat: number,
  anchorTime: number,
  windowStartBeat: number,
  windowEndBeat: number,
  due: IndexedDueEvent[],
  stats: MutableScheduleQueryStats | null,
): void {
  if (rangeEndBeat <= rangeStartBeat) return;
  if (stats) stats.rangeCount += 1;
  const startIndex = lowerBoundIndexedBeat(
    index.entries,
    rangeStartBeat - searchPaddingBeats,
    stats,
  );
  const endIndex = lowerBoundIndexedBeat(
    index.entries,
    rangeEndBeat + searchPaddingBeats,
    stats,
  );
  const loopLength = index.loop ? index.loop.endBeat - index.loop.startBeat : 0;

  for (let position = startIndex; position < endIndex; position += 1) {
    const indexed = index.entries[position];
    if (!indexed) continue;
    if (stats) stats.candidatesVisited += 1;

    let playheadBeat = indexed.event.beat;
    if (index.loop) {
      if (cycle < indexed.passShift) continue;
      playheadBeat += (cycle - indexed.passShift) * loopLength;
    }

    const resolved = resolveDueEvent(
      indexed.event,
      playheadBeat,
      indexed.event.beat,
      tempo,
      anchorBeat,
      anchorTime,
      windowStartBeat,
      windowEndBeat,
    );
    if (resolved) {
      due.push({ due: resolved, sourceOrdinal: indexed.sourceOrdinal });
    }
  }
}

function selectIndexedEventsInWindow(
  index: ScheduleEventIndex,
  windowStartBeat: number,
  windowEndBeat: number,
  tempo: TempoSource,
  anchorBeat: number,
  anchorTime: number,
  stats: MutableScheduleQueryStats | null,
): DueEvent[] {
  if (
    !Number.isFinite(windowStartBeat) ||
    !Number.isFinite(windowEndBeat) ||
    windowEndBeat <= windowStartBeat
  ) {
    return [];
  }

  const due: IndexedDueEvent[] = [];
  const region = index.loop;
  const transportTempo = region && typeof tempo !== 'number'
    ? loopBeatTimeMapping(tempo, region)
    : tempo;

  if (!region) {
    appendIndexedRange(
      index,
      windowStartBeat,
      windowEndBeat,
      0,
      0,
      transportTempo,
      anchorBeat,
      anchorTime,
      windowStartBeat,
      windowEndBeat,
      due,
      stats,
    );
  } else {
    const loopLength = region.endBeat - region.startBeat;
    // Mapping an unwrapped decimal beat back to its loop phase subtracts a
    // cycle offset. Widen only the binary-search bounds by a few ULPs so a
    // mathematically exact boundary occurrence cannot be omitted; the exact
    // resolver guard below remains the authoritative half-open filter.
    const firstCycle = Math.floor((windowStartBeat - region.startBeat) / loopLength);
    const endCycle = Math.ceil((windowEndBeat - region.startBeat) / loopLength);

    for (let cycle = firstCycle; cycle < endCycle; cycle += 1) {
      const cycleOffset = cycle * loopLength;
      const phaseSearchPadding =
        Number.EPSILON *
        Math.max(
          1,
          Math.abs(region.startBeat),
          Math.abs(region.endBeat),
          loopLength,
          Math.abs(windowStartBeat),
          Math.abs(windowEndBeat),
          Math.abs(cycleOffset),
        ) *
        8;
      const rangeStartBeat = Math.max(
        region.startBeat,
        windowStartBeat - cycleOffset,
      );
      const rangeEndBeat = Math.min(region.endBeat, windowEndBeat - cycleOffset);
      appendIndexedRange(
        index,
        rangeStartBeat,
        rangeEndBeat,
        phaseSearchPadding,
        cycle,
        transportTempo,
        anchorBeat,
        anchorTime,
        windowStartBeat,
        windowEndBeat,
        due,
        stats,
      );
    }
  }

  due.sort(
    (left, right) =>
      left.due.time - right.due.time || left.sourceOrdinal - right.sourceOrdinal,
  );
  if (stats) stats.emitted = due.length;
  return due.map((entry) => entry.due);
}

/** Query a prebuilt schedule index without rebuilding or scanning all events. */
export function nextIndexedEventsInWindow(
  index: ScheduleEventIndex,
  windowStartBeat: number,
  windowEndBeat: number,
  tempo: TempoSource,
  anchorBeat: number,
  anchorTime: number,
): DueEvent[] {
  return selectIndexedEventsInWindow(
    index,
    windowStartBeat,
    windowEndBeat,
    tempo,
    anchorBeat,
    anchorTime,
    null,
  );
}

/** Query a prebuilt index and return deterministic work counters for tests. */
export function queryScheduleEventIndex(
  index: ScheduleEventIndex,
  windowStartBeat: number,
  windowEndBeat: number,
  tempo: TempoSource,
  anchorBeat: number,
  anchorTime: number,
): ScheduleQueryResult {
  const stats: MutableScheduleQueryStats = {
    sourceEventCount: index.sourceEventCount,
    indexedEventCount: index.entries.length,
    rangeCount: 0,
    lowerBoundComparisons: 0,
    candidatesVisited: 0,
    emitted: 0,
  };
  const events = selectIndexedEventsInWindow(
    index,
    windowStartBeat,
    windowEndBeat,
    tempo,
    anchorBeat,
    anchorTime,
    stats,
  );
  return { events, stats };
}

function saturatingProduct(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Math.floor(Number.MAX_SAFE_INTEGER / Math.max(1, right))
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  return left * right;
}

function saturatingCountSum(left: number, right: number): number {
  if (left > Number.MAX_SAFE_INTEGER - right) return Number.MAX_SAFE_INTEGER;
  return left + right;
}

/**
 * Check the steady-state density of a periodic loop without unrolling it.
 *
 * Every complete loop inside the density window contributes every indexed
 * onset once. A two-pointer scan over one duplicated phase cycle finds the
 * maximum contribution from the remaining partial loop in O(N).
 */
export function preflightLoopScheduleDensity(
  index: ScheduleEventIndex,
  windowBeats: number,
  maxEventsPerWindow: number,
): ScheduleDensityBudgetResult {
  if (!Number.isFinite(windowBeats) || windowBeats <= 0) {
    throw new RangeError('schedule density window must be a positive finite beat count');
  }
  if (!Number.isSafeInteger(maxEventsPerWindow) || maxEventsPerWindow <= 0) {
    throw new RangeError('schedule density limit must be a positive safe integer');
  }

  const region = index.loop;
  const phases = index.entries
    .filter((entry) => canReachAnyScheduleWindow(entry.event))
    .map((entry) => entry.indexedBeat);
  if (!region || phases.length === 0) {
    return { ok: true, observed: 0, limit: maxEventsPerWindow };
  }

  const loopLength = region.endBeat - region.startBeat;
  const rawFullCycles = Math.floor(windowBeats / loopLength);
  if (!Number.isSafeInteger(rawFullCycles)) {
    return {
      ok: false,
      observed: Number.MAX_SAFE_INTEGER,
      limit: maxEventsPerWindow,
      windowStartBeat: region.startBeat,
    };
  }

  let fullCycles = rawFullCycles;
  let remainder = windowBeats - fullCycles * loopLength;
  const remainderTolerance =
    Number.EPSILON *
    Math.max(1, windowBeats, loopLength, Math.abs(fullCycles * loopLength)) *
    8;
  if (Math.abs(remainder) <= remainderTolerance) {
    remainder = 0;
  } else if (Math.abs(loopLength - remainder) <= remainderTolerance) {
    fullCycles += 1;
    remainder = 0;
  }

  const fullCycleEvents = saturatingProduct(fullCycles, phases.length);
  let maxPartialEvents = 0;
  let densestWindowStart = region.startBeat;

  if (remainder > 0) {
    const duplicated = [
      ...phases,
      ...phases.map((phase) => phase + loopLength),
    ];
    let right = 0;
    for (let left = 0; left < phases.length; left += 1) {
      if (right < left) right = left;
      while (
        right < left + phases.length &&
        (duplicated[right] ?? Number.POSITIVE_INFINITY) -
          (duplicated[left] ?? Number.NEGATIVE_INFINITY) <
          remainder
      ) {
        right += 1;
      }
      const partialEvents = right - left;
      if (partialEvents > maxPartialEvents) {
        maxPartialEvents = partialEvents;
        densestWindowStart = phases[left] ?? region.startBeat;
      }
    }
  }

  const observed = saturatingCountSum(fullCycleEvents, maxPartialEvents);
  return observed > maxEventsPerWindow
    ? {
        ok: false,
        observed,
        limit: maxEventsPerWindow,
        windowStartBeat: densestWindowStart,
      }
    : { ok: true, observed, limit: maxEventsPerWindow };
}

/**
 * Select occurrences whose resolved onset falls inside the half-open window
 * `[windowStartBeat, windowEndBeat)` and convert them to absolute audio times.
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
  tempo: TempoSource,
  anchorBeat: number,
  anchorTime: number,
  loop: LoopRegion | null,
): DueEvent[] {
  return nextIndexedEventsInWindow(
    createScheduleEventIndex(events, loop),
    windowStartBeat,
    windowEndBeat,
    tempo,
    anchorBeat,
    anchorTime,
  );
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

/** Called once after an interval-time scheduling failure stops the scheduler. */
export type SchedulerErrorFn = (error: unknown) => void;

/** Called whenever the scheduler advances its raw lookahead window. */
export type ScheduleWindowFn = (window: ScheduleWindow) => void;

export type SchedulerOptions = {
  clock: ClockFn;
  fire: FireFn;
  onScheduleWindow?: ScheduleWindowFn;
  onEnd?: EndFn;
  onError?: SchedulerErrorFn;
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
  private readonly onError?: SchedulerErrorFn;
  private readonly tickMs: number;
  private readonly lookaheadS: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private eventIndex: ScheduleEventIndex = createScheduleEventIndex([]);
  private tempo: TempoSource = 120;
  private transportTempo: TempoSource = 120;
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
    this.onError = options.onError;
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
   * @param tempo      fixed tempo or a precompiled beat/time mapping
   * @param startBeat  playhead start position in beats
   * @param loop       loop region, or null for one-shot playback
   * @param endBeat    project end (stop point when loop is off)
   */
  start(
    events: readonly ScheduledEvent[],
    tempo: TempoSource,
    startBeat: number,
    loop: LoopRegion | null,
    endBeat: number,
  ): void {
    this.startIndexed(
      createScheduleEventIndex(events, isValidLoop(loop) ? loop : null),
      tempo,
      startBeat,
      endBeat,
    );
  }

  /** Start from an explicit AudioContext anchor, typically a future frame. */
  startAt(
    events: readonly ScheduledEvent[],
    tempo: TempoSource,
    startBeat: number,
    loop: LoopRegion | null,
    endBeat: number,
    anchorTime: number,
  ): void {
    this.startIndexedAt(
      createScheduleEventIndex(events, isValidLoop(loop) ? loop : null),
      tempo,
      startBeat,
      endBeat,
      anchorTime,
    );
  }

  /** Start from an already-built index after caller-side safety preflight. */
  startIndexed(
    eventIndex: ScheduleEventIndex,
    tempo: TempoSource,
    startBeat: number,
    endBeat: number,
  ): void {
    // Preserve the legacy failure boundary: a throwing clock stops the prior
    // schedule before the exception escapes.
    this.stop();
    this.startIndexedAt(eventIndex, tempo, startBeat, endBeat, this.clock());
  }

  /**
   * Start from an already-built index at an exact AudioContext time.
   *
   * A future anchor lets another realtime participant arm itself against the
   * same integer context frame before either playback or capture becomes live.
   */
  startIndexedAt(
    eventIndex: ScheduleEventIndex,
    tempo: TempoSource,
    startBeat: number,
    endBeat: number,
    anchorTime: number,
  ): void {
    if (!Number.isFinite(anchorTime) || anchorTime < 0) {
      throw new RangeError('Scheduler anchorTime must be a non-negative finite number.');
    }
    this.stop();
    this.tempo = tempo;
    this.eventIndex = eventIndex;
    this.loop = eventIndex.loop;
    this.transportTempo = this.loop && typeof tempo !== 'number'
      ? loopBeatTimeMapping(tempo, this.loop)
      : tempo;
    this.endBeat = Number.isFinite(endBeat) ? endBeat : Infinity;
    this.anchorBeat = startBeat;
    this.scheduledBeat = startBeat;
    this.anchorTime = anchorTime;
    this.running = true;
    // Surface a synchronous first-window failure to startup. Later timer
    // failures stop once and cross the session's interruption boundary.
    this.tick(true);
    if (this.running) this.timer = setInterval(() => this.tick(false), this.tickMs);
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
    const now = this.clock();
    if (now < this.anchorTime) return this.anchorBeat;
    const raw = timeToBeat(
      now,
      this.transportTempo,
      this.anchorBeat,
      this.anchorTime,
    );
    if (this.loop) return wrapBeat(raw, this.loop);
    return raw;
  }

  private tick(rethrow: boolean): void {
    if (!this.running) return;
    try {
      this.scheduleTick();
    } catch (error) {
      this.stop();
      if (rethrow) throw error;
      try {
        this.onError?.(error);
      } catch {
        // A reporting failure must not restart or escape the stopped timer.
      }
    }
  }

  private scheduleTick(): void {
    const now = this.clock();
    const horizonTime = now + this.lookaheadS;
    const playheadBeat = now < this.anchorTime
      ? this.anchorBeat
      : timeToBeat(
          now,
          this.transportTempo,
          this.anchorBeat,
          this.anchorTime,
        );
    // Convert the time horizon into a playhead-beat horizon.
    const horizonBeat = timeToBeat(
      horizonTime,
      this.transportTempo,
      this.anchorBeat,
      this.anchorTime,
    );

    // Stop-at-end: clamp the horizon to the project end when not looping.
    const effectiveHorizon = this.loop ? horizonBeat : Math.min(horizonBeat, this.endBeat);

    // A throttled timer or resumed device may wake after the prior frontier.
    // Past AudioContext times cannot be recovered faithfully and scheduling
    // them now would replay the entire backlog as a burst, so resume from the
    // current playhead while retaining the normal ahead-of-playhead frontier.
    const windowStartBeat = Math.max(this.scheduledBeat, playheadBeat);
    if (effectiveHorizon > windowStartBeat) {
      this.onScheduleWindow?.({ startBeat: windowStartBeat, endBeat: effectiveHorizon });
      const due = nextIndexedEventsInWindow(
        this.eventIndex,
        windowStartBeat,
        effectiveHorizon,
        this.tempo,
        this.anchorBeat,
        this.anchorTime,
      );
      if (due.length > 0) this.fire(due);
    }
    this.scheduledBeat = Math.max(this.scheduledBeat, effectiveHorizon);

    // End handling (loop off): once the playhead itself has reached the end.
    if (!this.loop && this.scheduledBeat >= this.endBeat) {
      if (playheadBeat >= this.endBeat) {
        this.stop();
        this.onEnd?.();
      }
    }
  }
}
