// Drum occurrence resolution shared by live playback, offline WAV and MIDI.
//
// Moved verbatim from apps/studio/src/audio/scheduler.ts (main, schema v10) so
// the MIDI exporter can resolve the same probability, swing and velocity as
// the audio paths. Legacy-mode output must stay byte-identical to main; see
// apps/studio/tests/v11-legacy-main-parity.test.ts.
import { groovePrng } from './groove';
import type { Clip, DrumEvent, DrumLane } from './types';

/** A scheduled musical event, expressed in beats. */
export type ScheduledEvent = {
  /** Absolute position on the project timeline, in beats. */
  beat: number;
  /** Opaque payload handed back to the consumer when fired. */
  readonly payload: unknown;
};

/** A drum hit to be played on a drum track. */
export type DrumScheduleEvent = {
  kind: 'drum';
  trackId: string;
  clipId: string;
  eventId: string;
  lane: DrumLane;
  velocity: number;
  sourceStepIndex: number;
  clipEndBeat: number;
  stepsPerBar: number;
  beatsPerBar: number;
  probability: number;
  swing: number;
  humanizeVelocity: number;
  seed: number;
  /** Set by resolveDrumOccurrence; absent on raw persisted-project events. */
  voiceSeed?: number;
  /**
   * Resolved mode only (`swing > 0 || hiHatChoke`): absolute beat of the
   * closed hat on the same track that stops this open hat.
   */
  chokedAtBeat?: number;
  /**
   * Resolved mode only: the authored (pre-swing) occurrence beat. Random
   * decisions are salted with it, so they match legacy mode exactly.
   */
  authoredBeat?: number;
};

export type DrumScheduleOccurrence = ScheduledEvent & { payload: DrumScheduleEvent };

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
  authoredBeat?: number;
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
  return groovePrng((seed >>> 0) ^ hashString(salt))();
}

export function isDrumPayload(payload: unknown): payload is DrumPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as { kind?: unknown; lane?: unknown; velocity?: unknown };
  return (
    candidate.kind === 'drum' &&
    typeof candidate.lane === 'string' &&
    typeof candidate.velocity === 'number'
  );
}

export function isSelfContainedDrumPayload(payload: DrumPayload): payload is SelfContainedDrumPayload {
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

export function effectiveOnsetBeat(event: ScheduledEvent): number {
  return event.beat + occurrenceSwingLookback(event.payload);
}

export function canReachAnyScheduleWindow(event: ScheduledEvent): boolean {
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
  event: DrumScheduleOccurrence,
  playheadBeat?: number,
): DrumScheduleOccurrence | null;
export function resolveDrumOccurrence(
  event: ScheduledEvent,
  playheadBeat?: number,
): ScheduledEvent | null;
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
  // Resolved mode moves `event.beat` to the swung onset but keeps the authored
  // (pre-swing) beat, so probability, humanize and voiceSeed draw exactly what
  // legacy mode draws. Legacy payloads have no `authoredBeat`.
  const saltBeat = typeof payload.authoredBeat === 'number'
    ? payload.authoredBeat + (playheadBeat - event.beat)
    : playheadBeat;
  const seed = Number.isSafeInteger(payload.seed) && payload.seed > 0 ? payload.seed : 1;
  const hit = resolveDrumGrooveHit({
    beat: playheadBeat,
    lane: payload.lane,
    velocity: payload.velocity,
    probability: clamp01(payload.probability),
    swing: clamp01(payload.swing),
    humanizeVelocity: clamp(payload.humanizeVelocity, 0, 127),
    seed,
    stepKey: occurrenceSalt(payload, saltBeat),
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
      occurrenceVoiceSeed(payload, saltBeat),
    ),
  };
}

function clipEndBeatOf(startBeat: number, lengthBeats: number): number {
  const endBeat = startBeat + lengthBeats;
  return Number.isFinite(endBeat) && endBeat > startBeat
    ? endBeat
    : Number.POSITIVE_INFINITY;
}

function safeSeed(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : 1;
}

/**
 * Capture one projected drum step with its clip's persisted groove.
 *
 * `trackId` / `clipId` identify the timeline instance; `effectiveClip` is the
 * resolved (possibly linked) content. The payload shape and key order are the
 * main (v10) schedule contract.
 */
export function createDrumScheduleEvent(
  trackId: string,
  clipId: string,
  effectiveClip: Clip,
  drum: DrumEvent,
  beat: number,
  stepsPerBar: number,
  beatsPerBar: number,
): DrumScheduleOccurrence {
  const groove = effectiveClip.drumGroove;
  const swing = clamp(groove?.swing ?? 0, 0, 1);
  const clipProbability = clamp(groove?.probability ?? 1, 0, 1);
  return {
    beat,
    payload: {
      kind: 'drum',
      trackId,
      clipId,
      eventId: drum.id,
      lane: drum.lane,
      velocity: drum.velocity,
      sourceStepIndex: drum.stepIndex,
      clipEndBeat: clipEndBeatOf(effectiveClip.startBeat, effectiveClip.lengthBeats),
      stepsPerBar,
      beatsPerBar,
      probability: clamp(drum.probability ?? clipProbability, 0, 1),
      swing,
      humanizeVelocity: Math.round(clamp(groove?.humanizeVelocity ?? 0, 0, 127)),
      seed: safeSeed(groove?.seed),
    },
  };
}
