import {
  beatToSecondsAt,
  compileMusicalTime,
  secondsBetweenBeats,
  type EffectConfig,
  type MusicalTimeIndex,
  type Project,
} from '@cts/project-model';
import {
  DEFAULT_EFFECT_PARAMS,
  decayToSeconds,
  delayTimeToSeconds,
  feedbackToGain,
  normalizeEffectConfig,
  resolveEqBiquadSettings,
  resolveFilterBiquadSettings,
  webAudioBiquadPoleRadius,
  type BiquadStageSettings,
} from './effects';
import type { SchedulePayload } from './events';
import { computeAudibleTracks } from './graph';
import { MASTER_LIMITER_LOOKAHEAD_SECONDS } from './masterBus';
import type { ScheduledEvent } from './scheduler';
import { resolvePreset } from './synth';
import {
  DRUM_SOURCE_STOP_SECONDS,
  DYNAMICS_COMPRESSOR_LOOKAHEAD_SECONDS,
  REVERB_IMPULSE_PEAK_AMPLITUDE,
  SYNTH_OSCILLATOR_STOP_PAD_SECONDS,
} from './voiceTiming';

/** Amplitude below -60 dB is treated as silence for bounded effect tails. */
export const AUDIO_TAIL_SILENCE_THRESHOLD = 0.001;
/** A corrupt or highly recursive insert chain may never allocate an unbounded render. */
export const MAX_AUDIO_TAIL_SECONDS = 40;
/** Every non-empty tail ends with a short post-effect fade instead of a hard disconnect. */
export const FINAL_TAIL_FADE_SECONDS = 0.05;
/** Pure-planner fallback matching the WAV engine when no live rate is supplied. */
export const DEFAULT_AUDIO_TAIL_SAMPLE_RATE = 44_100;
/** One unstable/corrupt biquad may never make a render allocation unbounded. */
export const MAX_BIQUAD_TAIL_SECONDS = 2;
/** 36dB of state headroom above full scale before applying the -60dB cutoff. */
const BIQUAD_TAIL_HEADROOM_AMPLITUDE = 64;

/** Defensive ceiling; normalized feedback is at most 0.85 and normally needs <= 43 echoes. */
const MAX_DELAY_ECHO_COUNT = 1_024;
/** Covers arithmetic drift at an exact -60 dB boundary without admitting meaningfully quieter echoes. */
const DELAY_THRESHOLD_TOLERANCE =
  AUDIO_TAIL_SILENCE_THRESHOLD * Number.EPSILON * 16;

export type AudioTailPlan = Readonly<{
  /** Natural post-project output estimated from sources and enabled inserts. */
  uncappedTailSeconds: number;
  /** Tail actually allocated after applying the product safety ceiling. */
  tailSeconds: number;
  /** Duration from the supplied start beat through the end of the bounded tail. */
  totalSeconds: number;
  /** Native Master limiter output retained after the pre-limiter fade reaches zero. */
  postLimiterTailSeconds: number;
  /** Seconds from the supplied start beat at which the final post-effect fade starts. */
  fadeStartSeconds: number | null;
  /** Pre-limiter time at which the final fade reaches zero. */
  fadeEndSeconds: number | null;
  capped: boolean;
}>;

/** Source end relative to the planner's `startBeat`, used by Audio Clips. */
export type AudioTailSource = Readonly<{
  trackId: string;
  endSeconds: number;
}>;

/**
 * Estimate the last audible delay echo relative to the end of the input.
 *
 * The first wet echo has amplitude `mix` at one delay interval; later echoes
 * are multiplied by feedback. The result includes the last echo at or above
 * the shared -60 dB threshold.
 */
export function estimateDelayTailSeconds(effect: EffectConfig): number {
  if (!effect.enabled || effect.type !== 'delay') return 0;
  const normalized = normalizeEffectConfig(effect);
  const mix = normalized.params.mix ?? DEFAULT_EFFECT_PARAMS.delay.mix;
  if (mix < AUDIO_TAIL_SILENCE_THRESHOLD) return 0;

  const delaySeconds = delayTimeToSeconds(
    normalized.params.delayTime ?? DEFAULT_EFFECT_PARAMS.delay.delayTime,
  );
  const feedback = feedbackToGain(
    normalized.params.feedback ?? DEFAULT_EFFECT_PARAMS.delay.feedback,
  );
  if (feedback <= 0) return delaySeconds;

  // A logarithmic count can land just below an integer (for example
  // 14.999999999999998) and omit an echo exactly at the threshold. Directly
  // checking the bounded normalized sequence makes under-counting impossible.
  let echoAmplitude = mix;
  let echoCount = 0;
  while (
    echoCount < MAX_DELAY_ECHO_COUNT &&
    echoAmplitude + DELAY_THRESHOLD_TOLERANCE >= AUDIO_TAIL_SILENCE_THRESHOLD
  ) {
    echoCount += 1;
    echoAmplitude *= feedback;
  }
  return echoCount * delaySeconds;
}

/**
 * Conservatively estimate the audible portion of the synthetic reverb impulse.
 * Its squared decay envelope is scaled by both the fixed impulse peak and wet
 * gain; the result ends when that upper bound reaches -60 dB.
 */
export function estimateReverbTailSeconds(effect: EffectConfig): number {
  if (!effect.enabled || effect.type !== 'reverb') return 0;
  const normalized = normalizeEffectConfig(effect);
  const wet = normalized.params.wet ?? DEFAULT_EFFECT_PARAMS.reverb.wet;
  const peak = wet * REVERB_IMPULSE_PEAK_AMPLITUDE;
  if (peak <= AUDIO_TAIL_SILENCE_THRESHOLD) return 0;

  const decaySeconds = decayToSeconds(
    normalized.params.decay ?? DEFAULT_EFFECT_PARAMS.reverb.decay,
  );
  const silentEnvelope = Math.sqrt(AUDIO_TAIL_SILENCE_THRESHOLD / peak);
  return decaySeconds * (1 - Math.min(1, silentEnvelope));
}

/** Bound a Web Audio biquad's coefficient-dependent IIR state at -60dB. */
export function estimateBiquadTailSeconds(
  settings: BiquadStageSettings,
  sampleRate: number = DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
): number {
  // A zero-gain EQ stage is an exact identity transfer function even though a
  // BiquadFilterNode exists in the runtime graph.
  if (settings.type !== 'lowpass' && settings.gainDb === 0) return 0;
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0
    ? sampleRate
    : DEFAULT_AUDIO_TAIL_SAMPLE_RATE;
  const radius = webAudioBiquadPoleRadius(settings, safeSampleRate);
  if (radius === null || !Number.isFinite(radius) || radius >= 1) {
    return MAX_BIQUAD_TAIL_SECONDS;
  }
  if (radius <= 0) return 0;
  const targetRatio =
    AUDIO_TAIL_SILENCE_THRESHOLD / BIQUAD_TAIL_HEADROOM_AMPLITUDE;
  const frames = Math.ceil(Math.log(targetRatio) / Math.log(radius));
  if (!Number.isSafeInteger(frames) || frames <= 0) return MAX_BIQUAD_TAIL_SECONDS;
  return Math.min(MAX_BIQUAD_TAIL_SECONDS, frames / safeSampleRate);
}

export function estimateFilterTailSeconds(
  effect: EffectConfig,
  sampleRate: number = DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
): number {
  if (!effect.enabled || effect.type !== 'filter') return 0;
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0
    ? sampleRate
    : DEFAULT_AUDIO_TAIL_SAMPLE_RATE;
  return estimateBiquadTailSeconds(
    resolveFilterBiquadSettings(effect, safeSampleRate),
    safeSampleRate,
  );
}

export function estimateEqTailSeconds(
  effect: EffectConfig,
  sampleRate: number = DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
): number {
  if (!effect.enabled || effect.type !== 'eq') return 0;
  return resolveEqBiquadSettings(effect).reduce(
    (tail, settings) => tail + estimateBiquadTailSeconds(settings, sampleRate),
    0,
  );
}

/** Sequential insert impulse responses are conservatively additive. */
export function estimateInsertChainTailSeconds(
  effects: readonly EffectConfig[],
  sampleRate: number = DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
): number {
  return effects.reduce((tail, effect) => {
    if (!effect.enabled) return tail;
    if (effect.type === 'delay') return tail + estimateDelayTailSeconds(effect);
    if (effect.type === 'reverb') return tail + estimateReverbTailSeconds(effect);
    if (effect.type === 'filter') {
      return tail + estimateFilterTailSeconds(effect, sampleRate);
    }
    if (effect.type === 'eq') return tail + estimateEqTailSeconds(effect, sampleRate);
    if (effect.type === 'compressor') {
      return tail + DYNAMICS_COMPRESSOR_LOOKAHEAD_SECONDS;
    }
    return tail;
  }, 0);
}

/**
 * Plan a bounded one-shot render tail from already-resolved occurrences.
 * Callers must resolve raw drum events exactly once before this boundary;
 * probability, swing, and the `[startBeat, endBeat)` onset filter therefore
 * affect both the audible render and its size without a second groove pass.
 * The supplied Project snapshot's mute/solo state is authoritative for WAV;
 * live callers with mutable mixing must pass an ever-audible snapshot.
 */
export function planAudioTail(
  project: Project,
  resolvedEvents: readonly ScheduledEvent[],
  startBeat = 0,
  endBeat = project.lengthBeats,
  sampleRate: number = DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
  additionalSources: readonly AudioTailSource[] = [],
): AudioTailPlan {
  const safeStartBeat = finiteNonNegative(startBeat);
  const safeEndBeat = Number.isFinite(endBeat)
    ? Math.max(safeStartBeat, endBeat)
    : safeStartBeat;
  const musicalTime = compileMusicalTime(project);
  const rangeSeconds = Math.max(
    0,
    secondsBetweenBeats(musicalTime, safeStartBeat, safeEndBeat),
  );
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const audibleTrackIds = computeAudibleTracks(project.tracks);
  const sourceEndByTrack = new Map<string, number>();

  for (const event of resolvedEvents) {
    if (
      !Number.isFinite(event.beat) ||
      event.beat < safeStartBeat ||
      event.beat >= safeEndBeat
    ) {
      continue;
    }
    const payload = schedulePayload(event.payload);
    if (!payload || !audibleTrackIds.has(payload.trackId)) continue;
    const track = tracks.get(payload.trackId);
    if (!track) continue;

    const sourceEnd = sourceEndSeconds(
      event,
      payload,
      safeStartBeat,
      musicalTime,
    );
    if (sourceEnd === null) continue;
    sourceEndByTrack.set(
      track.id,
      Math.max(
        sourceEndByTrack.get(track.id) ?? Number.NEGATIVE_INFINITY,
        sourceEnd,
      ),
    );
  }

  for (const source of additionalSources) {
    if (
      !audibleTrackIds.has(source.trackId) ||
      !tracks.has(source.trackId) ||
      !Number.isFinite(source.endSeconds) ||
      source.endSeconds < 0
    ) {
      continue;
    }
    sourceEndByTrack.set(
      source.trackId,
      Math.max(sourceEndByTrack.get(source.trackId) ?? Number.NEGATIVE_INFINITY, source.endSeconds),
    );
  }

  let latestPreMasterEnd = Number.NEGATIVE_INFINITY;
  for (const [trackId, sourceEnd] of sourceEndByTrack) {
    const track = tracks.get(trackId);
    if (!track) continue;
    latestPreMasterEnd = Math.max(
      latestPreMasterEnd,
      sourceEnd + estimateInsertChainTailSeconds(track.effects, sampleRate),
    );
  }

  if (sourceEndByTrack.size === 0 || !Number.isFinite(latestPreMasterEnd)) {
    return {
      uncappedTailSeconds: 0,
      tailSeconds: 0,
      totalSeconds: rangeSeconds,
      postLimiterTailSeconds: 0,
      fadeStartSeconds: null,
      fadeEndSeconds: null,
      capped: false,
    };
  }

  const postLimiterTailSeconds = MASTER_LIMITER_LOOKAHEAD_SECONDS;
  const uncappedPostLimiterEnd = latestPreMasterEnd + postLimiterTailSeconds;
  const uncappedTailSeconds = Math.max(0, uncappedPostLimiterEnd - rangeSeconds);
  if (uncappedTailSeconds <= 0) {
    return {
      uncappedTailSeconds: 0,
      tailSeconds: 0,
      totalSeconds: rangeSeconds,
      postLimiterTailSeconds: 0,
      fadeStartSeconds: null,
      fadeEndSeconds: null,
      capped: false,
    };
  }

  // The 40-second product cap includes the Master limiter's look-ahead. The
  // pre-limiter fade therefore ends 6ms before cleanup when capped; empty or
  // fully-muted schedules never pay either tail or fade allocation.
  const tailSeconds = Math.min(
    MAX_AUDIO_TAIL_SECONDS,
    Math.max(
      FINAL_TAIL_FADE_SECONDS + postLimiterTailSeconds,
      uncappedTailSeconds,
    ),
  );
  const totalSeconds = rangeSeconds + tailSeconds;
  const fadeEndSeconds = totalSeconds - postLimiterTailSeconds;
  return {
    uncappedTailSeconds,
    tailSeconds,
    totalSeconds,
    postLimiterTailSeconds,
    fadeStartSeconds: Math.max(
      rangeSeconds,
      fadeEndSeconds - FINAL_TAIL_FADE_SECONDS,
    ),
    fadeEndSeconds,
    capped: uncappedTailSeconds > MAX_AUDIO_TAIL_SECONDS,
  };
}

function schedulePayload(payload: unknown): SchedulePayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Partial<SchedulePayload>;
  if (
    (candidate.kind !== 'note' && candidate.kind !== 'drum') ||
    typeof candidate.trackId !== 'string'
  ) {
    return null;
  }
  return candidate as SchedulePayload;
}

function sourceEndSeconds(
  event: ScheduledEvent,
  payload: SchedulePayload,
  startBeat: number,
  musicalTime: MusicalTimeIndex,
): number | null {
  if (!Number.isFinite(event.beat)) return null;
  const onsetSeconds = Math.max(
    0,
    beatToSecondsAt(musicalTime, event.beat)
      - beatToSecondsAt(musicalTime, startBeat),
  );
  if (payload.kind === 'drum') {
    return onsetSeconds + DRUM_SOURCE_STOP_SECONDS[payload.lane];
  }

  const patch = resolvePreset(payload.preset);
  const durationBeats = finiteNonNegative(payload.durationBeats);
  const durationSeconds = Math.max(
    0,
    secondsBetweenBeats(musicalTime, event.beat, event.beat + durationBeats),
  );
  return (
    onsetSeconds +
    Math.max(durationSeconds, patch.env.attack + patch.env.decay) +
    patch.env.release +
    SYNTH_OSCILLATOR_STOP_PAD_SECONDS
  );
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
