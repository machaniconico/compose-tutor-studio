import type {
  AudioClip,
  Project,
  ReadyAudioAsset,
} from '@cts/project-model';
import { createProjectMusicalTime } from './musicalTime';
import type { BeatTimeMapping, LoopRegion } from './scheduler';

/** A single lookahead/offline pass may never allocate an unbounded source list. */
export const MAX_AUDIO_CLIP_PLANS_PER_WINDOW = 10_000;
/** A live session compiles at most this many playable Audio Clip regions. */
export const MAX_AUDIO_CLIP_REGIONS = 10_000;

const BEAT_EPSILON = 1e-9;
const SECOND_EPSILON = 1e-9;

export class AudioClipPlanLimitError extends Error {
  readonly code = 'audio-clip-plan-limit-exceeded' as const;

  constructor(
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`Audio clip playback requires more than ${limit} source occurrences`);
    this.name = 'AudioClipPlanLimitError';
  }
}

export type AudioClipGainPoint = Readonly<{
  /** Seconds after this source occurrence starts. */
  offsetSeconds: number;
  /** Linear amplitude including the persisted clip gain. */
  value: number;
}>;

/**
 * One independently-owned AudioBufferSource occurrence.
 *
 * `startBeat`/`endBeat` live on the unwrapped transport axis. The source range
 * stays in seconds so a canonical 48 kHz asset has identical trim semantics
 * when a live or offline context resamples its decoded AudioBuffer.
 */
export type AudioClipPlaybackPlan = Readonly<{
  occurrenceId: string;
  trackId: string;
  clipId: string;
  assetId: string;
  checksumSha256: string;
  startBeat: number;
  endBeat: number;
  sourceOffsetSeconds: number;
  durationSeconds: number;
  /** Source-range loop bounds for AudioBufferSourceNode, or null for one-shot. */
  loopStartSeconds: number | null;
  loopEndSeconds: number | null;
  gainPoints: readonly AudioClipGainPoint[];
}>;

export type AudioClipPlanningOptions = Readonly<{
  /** Half-open lookahead range on the unwrapped transport beat axis. */
  windowStartBeat: number;
  windowEndBeat: number;
  /** Project tempo map. Compiled internally when omitted. */
  tempo?: BeatTimeMapping;
  /** Transport loop; clip.loop is handled independently. */
  transportLoop?: LoopRegion | null;
  maxPlans?: number;
  /** Immutable session/offline snapshot; avoids rebuilding regions per tick. */
  index?: AudioClipPlaybackIndex;
}>;

export type AudioClipTailSource = Readonly<{
  trackId: string;
  endSeconds: number;
}>;

export type AudioClipRegionIndexEntry = Readonly<{
  trackId: string;
  clip: AudioClip;
  asset: ReadyAudioAsset;
  clipStartSeconds: number;
  audibleEndSeconds: number;
  sourceDurationSeconds: number;
  sourceStartSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  gainLinear: number;
}>;

/**
 * Tempo-bound interval index compiled once for a project playback snapshot.
 * `prefixMaxEndSeconds` supports a bounded overlap query without rebuilding or
 * scanning regions that provably ended before the requested time range.
 */
export type AudioClipPlaybackIndex = Readonly<{
  project: Project;
  tempo: BeatTimeMapping;
  regionCount: number;
  sortedRegions: readonly AudioClipRegionIndexEntry[];
  prefixMaxEndSeconds: readonly number[];
}>;

type TransportSlice = Readonly<{
  cycleKey: string;
  projectStartBeat: number;
  projectEndBeat: number;
  transportStartBeat: number;
  queryStartBeat: number;
  queryEndBeat: number;
}>;

/** Convert the persisted dB trim to Web Audio's linear gain domain. */
export function audioClipGainToLinear(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 1;
  return 10 ** (gainDb / 20);
}

/** Compile the immutable Audio Clip interval index used by live and WAV paths. */
export function createAudioClipPlaybackIndex(
  project: Project,
  options: Readonly<{
    tempo?: BeatTimeMapping;
    maxRegions?: number;
  }> = {},
): AudioClipPlaybackIndex {
  const tempo = options.tempo ?? createProjectMusicalTime(project).tempo;
  const maxRegions = Math.min(
    MAX_AUDIO_CLIP_REGIONS,
    positiveSafeLimit(options.maxRegions, MAX_AUDIO_CLIP_REGIONS),
  );
  const sortedRegions = collectAudioRegions(project, tempo, maxRegions)
    .sort((left, right) => (
      left.clipStartSeconds - right.clipStartSeconds ||
      left.trackId.localeCompare(right.trackId) ||
      left.clip.id.localeCompare(right.clip.id)
    ));
  const prefixMaxEndSeconds: number[] = [];
  let latestEnd = Number.NEGATIVE_INFINITY;
  for (const region of sortedRegions) {
    latestEnd = Math.max(latestEnd, region.audibleEndSeconds);
    prefixMaxEndSeconds.push(latestEnd);
  }
  return Object.freeze({
    project,
    tempo,
    regionCount: sortedRegions.length,
    sortedRegions: Object.freeze(sortedRegions),
    prefixMaxEndSeconds: Object.freeze(prefixMaxEndSeconds),
  });
}

/**
 * Plan every AudioBufferSource occurrence that intersects a lookahead window.
 *
 * The function is pure and shared by live playback and offline WAV export.
 * Returning an already-active occurrence is intentional: the voice manager
 * de-duplicates by `occurrenceId`, while a scheduler that wakes late can still
 * resume a source from the correct mid-clip offset.
 */
export function planAudioClipPlaybackWindow(
  project: Project,
  options: AudioClipPlanningOptions,
): AudioClipPlaybackPlan[] {
  const windowStartBeat = finiteNonNegative(options.windowStartBeat);
  const windowEndBeat = Number.isFinite(options.windowEndBeat)
    ? Math.max(windowStartBeat, options.windowEndBeat)
    : windowStartBeat;
  if (windowEndBeat <= windowStartBeat) return [];

  const maxPlans = positiveSafeLimit(
    options.maxPlans,
    MAX_AUDIO_CLIP_PLANS_PER_WINDOW,
  );
  const index = options.index?.project === project
    ? options.index
    : createAudioClipPlaybackIndex(project, {
        ...(options.tempo ? { tempo: options.tempo } : {}),
      });
  const tempo = index.tempo;
  if (index.regionCount > MAX_AUDIO_CLIP_REGIONS) {
    throw new AudioClipPlanLimitError(MAX_AUDIO_CLIP_REGIONS, index.regionCount);
  }
  if (index.regionCount === 0) return [];
  const slices = transportSlices(
    windowStartBeat,
    windowEndBeat,
    project.lengthBeats,
    options.transportLoop ?? null,
    maxPlans,
  );
  const candidateCache = new Map<string, readonly AudioClipRegionIndexEntry[]>();
  const work: Array<Readonly<{
    slice: TransportSlice;
    regions: readonly AudioClipRegionIndexEntry[];
  }>> = [];
  let candidateCount = 0;
  for (const slice of slices) {
    const queryProjectStartBeat = transportToProjectBeat(slice.queryStartBeat, slice);
    const queryProjectEndBeat = transportToProjectBeat(slice.queryEndBeat, slice);
    const key = `${queryProjectStartBeat}:${queryProjectEndBeat}`;
    let candidates = candidateCache.get(key);
    if (!candidates) {
      const queryStartSeconds = tempo.beatToSeconds(queryProjectStartBeat);
      const queryEndSeconds = tempo.beatToSeconds(queryProjectEndBeat);
      candidates = audioClipRegionsInRange(index, queryStartSeconds, queryEndSeconds);
      candidateCache.set(key, candidates);
    }
    candidateCount = saturatingAdd(candidateCount, candidates.length);
    if (candidateCount > maxPlans) {
      throw new AudioClipPlanLimitError(maxPlans, candidateCount);
    }
    work.push({ slice, regions: candidates });
  }
  const plans: AudioClipPlaybackPlan[] = [];

  for (const item of work) {
    for (const region of item.regions) {
      planRegionInSlice(region, item.slice, tempo, plans, maxPlans);
    }
  }

  plans.sort((left, right) => (
    left.startBeat - right.startBeat || left.occurrenceId.localeCompare(right.occurrenceId)
  ));
  return plans;
}

/**
 * Aggregate only the latest source end per track for natural-tail planning.
 * Unlike playback occurrence planning this stays O(clips) and deliberately has
 * no whole-song source-node cap, so a long sparse arrangement cannot fail only
 * when transport reaches its natural end.
 */
export function planAudioClipTailSources(
  project: Project,
  options: Readonly<{
    startBeat: number;
    endBeat: number;
    tempo?: BeatTimeMapping;
  }>,
): AudioClipTailSource[] {
  const startBeat = finiteNonNegative(options.startBeat);
  const endBeat = Number.isFinite(options.endBeat)
    ? Math.max(startBeat, options.endBeat)
    : startBeat;
  if (endBeat <= startBeat) return [];
  const tempo = options.tempo ?? createProjectMusicalTime(project).tempo;
  const rangeStartSeconds = tempo.beatToSeconds(startBeat);
  const rangeEndSeconds = tempo.beatToSeconds(endBeat);
  const latestByTrack = new Map<string, number>();
  for (const region of collectAudioRegions(project, tempo)) {
    const audibleStart = Math.max(region.clipStartSeconds, rangeStartSeconds);
    const audibleEnd = Math.min(region.audibleEndSeconds, rangeEndSeconds);
    if (audibleEnd <= audibleStart + SECOND_EPSILON) continue;
    const endSeconds = audibleEnd - rangeStartSeconds;
    latestByTrack.set(
      region.trackId,
      Math.max(latestByTrack.get(region.trackId) ?? Number.NEGATIVE_INFINITY, endSeconds),
    );
  }
  return [...latestByTrack].map(([trackId, endSeconds]) => ({ trackId, endSeconds }));
}

function collectAudioRegions(
  project: Project,
  tempo: BeatTimeMapping,
  maxRegions: number = Number.MAX_SAFE_INTEGER,
): AudioClipRegionIndexEntry[] {
  const readyAssets = new Map<string, ReadyAudioAsset>();
  for (const asset of project.audioAssets) {
    if (asset.availability === 'ready') readyAssets.set(asset.id, asset);
  }

  const regions: AudioClipRegionIndexEntry[] = [];
  for (const track of project.tracks) {
    if (track.type !== 'audio') continue;
    for (const candidate of track.clips) {
      if (candidate.type !== 'audio') continue;
      const clip = candidate as AudioClip;
      const asset = readyAssets.get(clip.audioAssetId);
      if (!asset || clip.sourceFrameCount <= 0 || asset.sampleRate <= 0) continue;

      const clipStartSeconds = tempo.beatToSeconds(clip.startBeat);
      const clipEndSeconds = tempo.beatToSeconds(
        Math.min(project.lengthBeats, clip.startBeat + clip.lengthBeats),
      );
      const timelineDurationSeconds = clipEndSeconds - clipStartSeconds;
      const sourceDurationSeconds = clip.sourceFrameCount / asset.sampleRate;
      if (
        !Number.isFinite(clipStartSeconds) ||
        !Number.isFinite(timelineDurationSeconds) ||
        !Number.isFinite(sourceDurationSeconds) ||
        timelineDurationSeconds <= 0 ||
        sourceDurationSeconds <= 0
      ) {
        continue;
      }

      const audibleDurationSeconds = clip.loop
        ? timelineDurationSeconds
        : Math.min(timelineDurationSeconds, sourceDurationSeconds);
      const normalizedFades = normalizeFades(
        clip.fadeInFrames / asset.sampleRate,
        clip.fadeOutFrames / asset.sampleRate,
        audibleDurationSeconds,
      );
      if (regions.length >= maxRegions) {
        throw new AudioClipPlanLimitError(maxRegions, regions.length + 1);
      }
      regions.push({
        trackId: track.id,
        clip,
        asset,
        clipStartSeconds,
        audibleEndSeconds: clipStartSeconds + audibleDurationSeconds,
        sourceDurationSeconds,
        sourceStartSeconds: clip.sourceStartFrame / asset.sampleRate,
        fadeInSeconds: normalizedFades.fadeInSeconds,
        fadeOutSeconds: normalizedFades.fadeOutSeconds,
        gainLinear: audioClipGainToLinear(clip.gainDb),
      });
    }
  }
  return regions;
}

/** Query the compiled interval index for half-open source overlap. */
function audioClipRegionsInRange(
  index: AudioClipPlaybackIndex,
  rangeStartSeconds: number,
  rangeEndSeconds: number,
): AudioClipRegionIndexEntry[] {
  if (
    !Number.isFinite(rangeStartSeconds) ||
    !Number.isFinite(rangeEndSeconds) ||
    rangeEndSeconds <= rangeStartSeconds
  ) {
    return [];
  }
  const startBoundary = rangeEndSeconds - SECOND_EPSILON;
  let low = 0;
  let high = index.sortedRegions.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((index.sortedRegions[middle]?.clipStartSeconds ?? Infinity) < startBoundary) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const upperExclusive = low;
  const endBoundary = rangeStartSeconds + SECOND_EPSILON;
  low = 0;
  high = upperExclusive;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((index.prefixMaxEndSeconds[middle] ?? Number.NEGATIVE_INFINITY) > endBoundary) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const candidates: AudioClipRegionIndexEntry[] = [];
  for (let indexPosition = low; indexPosition < upperExclusive; indexPosition += 1) {
    const region = index.sortedRegions[indexPosition];
    if (region && region.audibleEndSeconds > endBoundary) candidates.push(region);
  }
  return candidates;
}

function transportSlices(
  windowStartBeat: number,
  windowEndBeat: number,
  projectLengthBeats: number,
  transportLoop: LoopRegion | null,
  maxSlices: number,
): TransportSlice[] {
  const projectEnd = finiteNonNegative(projectLengthBeats);
  const loopStart = transportLoop?.startBeat ?? 0;
  const loopEnd = transportLoop?.endBeat ?? 0;
  const loopLength = loopEnd - loopStart;
  if (
    !transportLoop ||
    !Number.isFinite(loopStart) ||
    !Number.isFinite(loopEnd) ||
    loopStart < 0 ||
    loopEnd > projectEnd ||
    !(loopLength > 0)
  ) {
    const queryStart = Math.min(projectEnd, windowStartBeat);
    const queryEnd = Math.min(projectEnd, windowEndBeat);
    return queryEnd > queryStart
      ? [{
          cycleKey: 'once',
          projectStartBeat: 0,
          projectEndBeat: projectEnd,
          transportStartBeat: 0,
          queryStartBeat: queryStart,
          queryEndBeat: queryEnd,
        }]
      : [];
  }

  const slices: TransportSlice[] = [];
  if (windowStartBeat < loopStart) {
    const queryStart = Math.max(0, windowStartBeat);
    const queryEnd = Math.min(loopStart, windowEndBeat);
    if (queryEnd > queryStart) {
      slices.push({
        cycleKey: 'pre-loop',
        projectStartBeat: 0,
        projectEndBeat: loopStart,
        transportStartBeat: 0,
        queryStartBeat: queryStart,
        queryEndBeat: queryEnd,
      });
    }
  }

  const loopQueryStart = Math.max(windowStartBeat, loopStart);
  if (windowEndBeat <= loopQueryStart) return slices;
  const firstCycle = Math.max(0, Math.floor((loopQueryStart - loopStart) / loopLength));
  const rawLastCycle = Math.floor(
    (windowEndBeat - loopStart - BEAT_EPSILON) / loopLength,
  );
  const lastCycle = Math.max(firstCycle, rawLastCycle);
  const cycleCount = lastCycle - firstCycle + 1;
  if (
    !Number.isSafeInteger(firstCycle) ||
    !Number.isSafeInteger(lastCycle) ||
    !Number.isSafeInteger(cycleCount) ||
    cycleCount > maxSlices - slices.length
  ) {
    throw new AudioClipPlanLimitError(
      maxSlices,
      Number.isSafeInteger(cycleCount) ? cycleCount + slices.length : Number.MAX_SAFE_INTEGER,
    );
  }
  for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
    const transportStartBeat = loopStart + cycle * loopLength;
    const queryStartBeat = Math.max(windowStartBeat, transportStartBeat);
    const queryEndBeat = Math.min(windowEndBeat, transportStartBeat + loopLength);
    if (queryEndBeat <= queryStartBeat) continue;
    slices.push({
      cycleKey: `loop-${cycle}`,
      projectStartBeat: loopStart,
      projectEndBeat: loopEnd,
      transportStartBeat,
      queryStartBeat,
      queryEndBeat,
    });
  }
  return slices;
}

function planRegionInSlice(
  region: AudioClipRegionIndexEntry,
  slice: TransportSlice,
  tempo: BeatTimeMapping,
  plans: AudioClipPlaybackPlan[],
  maxPlans: number,
): void {
  const queryProjectStartBeat = transportToProjectBeat(slice.queryStartBeat, slice);
  const queryProjectEndBeat = transportToProjectBeat(slice.queryEndBeat, slice);
  const queryStartSeconds = tempo.beatToSeconds(queryProjectStartBeat);
  const queryEndSeconds = tempo.beatToSeconds(queryProjectEndBeat);
  const sliceStartSeconds = tempo.beatToSeconds(slice.projectStartBeat);
  const sliceEndSeconds = tempo.beatToSeconds(slice.projectEndBeat);
  if (
    !Number.isFinite(queryStartSeconds) ||
    !Number.isFinite(queryEndSeconds) ||
    queryEndSeconds <= queryStartSeconds
  ) {
    return;
  }

  const intersectStart = Math.max(
    queryStartSeconds,
    sliceStartSeconds,
    region.clipStartSeconds,
  );
  const intersectEnd = Math.min(
    queryEndSeconds,
    sliceEndSeconds,
    region.audibleEndSeconds,
  );
  if (intersectEnd <= intersectStart + SECOND_EPSILON) return;

  const fullStartSeconds = Math.max(region.clipStartSeconds, sliceStartSeconds);
  const fullEndSeconds = Math.min(region.audibleEndSeconds, sliceEndSeconds);
  const plannedStartSeconds = Math.max(fullStartSeconds, queryStartSeconds);
  if (fullEndSeconds <= plannedStartSeconds + SECOND_EPSILON) return;

  const fullStartProjectBeat = tempo.secondsToBeat(fullStartSeconds);
  const fullEndProjectBeat = tempo.secondsToBeat(fullEndSeconds);
  const plannedStartProjectBeat = tempo.secondsToBeat(plannedStartSeconds);
  if (
    !Number.isFinite(fullStartProjectBeat) ||
    !Number.isFinite(fullEndProjectBeat) ||
    !Number.isFinite(plannedStartProjectBeat)
  ) {
    return;
  }
  const startBeat = projectToTransportBeat(plannedStartProjectBeat, slice);
  const endBeat = projectToTransportBeat(fullEndProjectBeat, slice);
  const durationSeconds = fullEndSeconds - plannedStartSeconds;
  if (!(endBeat > startBeat) || !(durationSeconds > 0)) return;

  const elapsedSourceSeconds = plannedStartSeconds - region.clipStartSeconds;
  const sourcePhaseSeconds = region.clip.loop
    ? positiveModulo(elapsedSourceSeconds, region.sourceDurationSeconds)
    : elapsedSourceSeconds;
  plans.push({
    occurrenceId: occurrenceId(region, slice.cycleKey, fullStartProjectBeat),
    trackId: region.trackId,
    clipId: region.clip.id,
    assetId: region.asset.id,
    checksumSha256: region.asset.checksumSha256,
    startBeat,
    endBeat,
    sourceOffsetSeconds: region.sourceStartSeconds + sourcePhaseSeconds,
    durationSeconds,
    loopStartSeconds: region.clip.loop ? region.sourceStartSeconds : null,
    loopEndSeconds: region.clip.loop
      ? region.sourceStartSeconds + region.sourceDurationSeconds
      : null,
    gainPoints: gainPoints(region, plannedStartSeconds, fullEndSeconds),
  });
  if (plans.length > maxPlans) {
    throw new AudioClipPlanLimitError(maxPlans, plans.length);
  }
}

function gainPoints(
  region: AudioClipRegionIndexEntry,
  startSeconds: number,
  endSeconds: number,
): AudioClipGainPoint[] {
  const startElapsed = startSeconds - region.clipStartSeconds;
  const endElapsed = endSeconds - region.clipStartSeconds;
  const fadeOutStart = Math.max(
    0,
    region.audibleEndSeconds - region.clipStartSeconds - region.fadeOutSeconds,
  );
  const breakpoints = [
    startElapsed,
    region.fadeInSeconds,
    fadeOutStart,
    endElapsed,
  ]
    .filter((value) => value >= startElapsed && value <= endElapsed)
    .sort((left, right) => left - right);

  const unique: number[] = [];
  for (const point of breakpoints) {
    if (unique.length === 0 || Math.abs(point - (unique.at(-1) ?? point)) > SECOND_EPSILON) {
      unique.push(point);
    }
  }
  if (unique[0] !== startElapsed) unique.unshift(startElapsed);

  return unique.map((elapsed) => ({
    offsetSeconds: Math.max(0, elapsed - startElapsed),
    value: envelopeGain(region, elapsed),
  }));
}

function envelopeGain(
  region: AudioClipRegionIndexEntry,
  elapsedSeconds: number,
): number {
  const totalSeconds = region.audibleEndSeconds - region.clipStartSeconds;
  let envelope = 1;
  if (region.fadeInSeconds > 0 && elapsedSeconds < region.fadeInSeconds) {
    envelope = Math.min(envelope, Math.max(0, elapsedSeconds / region.fadeInSeconds));
  }
  if (
    region.fadeOutSeconds > 0 &&
    elapsedSeconds > totalSeconds - region.fadeOutSeconds
  ) {
    envelope = Math.min(
      envelope,
      Math.max(0, (totalSeconds - elapsedSeconds) / region.fadeOutSeconds),
    );
  }
  return region.gainLinear * envelope;
}

function normalizeFades(
  fadeInSeconds: number,
  fadeOutSeconds: number,
  audibleDurationSeconds: number,
): Readonly<{ fadeInSeconds: number; fadeOutSeconds: number }> {
  const fadeIn = finiteNonNegative(fadeInSeconds);
  const fadeOut = finiteNonNegative(fadeOutSeconds);
  const sum = fadeIn + fadeOut;
  if (sum <= audibleDurationSeconds || sum <= 0) {
    return { fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut };
  }
  const scale = audibleDurationSeconds / sum;
  return { fadeInSeconds: fadeIn * scale, fadeOutSeconds: fadeOut * scale };
}

function projectToTransportBeat(projectBeat: number, slice: TransportSlice): number {
  return slice.transportStartBeat + (projectBeat - slice.projectStartBeat);
}

function transportToProjectBeat(transportBeat: number, slice: TransportSlice): number {
  return slice.projectStartBeat + (transportBeat - slice.transportStartBeat);
}

function occurrenceId(
  region: AudioClipRegionIndexEntry,
  cycleKey: string,
  fullStartProjectBeat: number,
): string {
  return [
    region.trackId,
    region.clip.id,
    cycleKey,
    roundBeat(fullStartProjectBeat),
  ].join(':');
}

function positiveModulo(value: number, modulus: number): number {
  if (!(modulus > 0)) return 0;
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

function saturatingAdd(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  return left + right;
}

function roundBeat(beat: number): string {
  return (Math.round(beat * 1_000_000) / 1_000_000).toString();
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function positiveSafeLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : fallback;
}
