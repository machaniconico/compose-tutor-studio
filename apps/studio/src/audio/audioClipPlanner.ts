import type {
  AudioClip,
  Project,
  ReadyAudioAsset,
} from '@cts/project-model';
import { createProjectMusicalTime } from './musicalTime';
import {
  compileAudioWarpRenderRequestIndex,
  type AudioWarpRenderRequest,
} from './audioWarpPlan';
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

export type AudioClipPlaybackBufferKey =
  | Readonly<{
      kind: 'source';
      assetId: string;
      checksumSha256: string;
    }>
  | Readonly<{
      kind: 'derived';
      assetId: string;
      checksumSha256: string;
      cacheKey: string;
      sampleRate: number;
      frameCount: number;
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
  playbackBufferKey: AudioClipPlaybackBufferKey;
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
  /** Structured source identity; never parse or concatenate persisted ids. */
  sourceIdentity: readonly string[];
  asset: ReadyAudioAsset;
  warpRequest: AudioWarpRenderRequest | null;
  clipStartSeconds: number;
  audibleEndSeconds: number;
  sourceDurationSeconds: number;
  sourceStartSeconds: number;
  /** Persisted outer take/clip fades, evaluated on their original time axis. */
  fadeInSeconds: number;
  fadeOutSeconds: number;
  /** Original take/clip seconds already elapsed when this region begins. */
  outerFadeOffsetSeconds: number;
  /** Full original take/clip duration used by the persisted outer envelope. */
  outerFadeDurationSeconds: number;
  /** Independent comp-splice envelope, centered on a logical boundary. */
  spliceFadeInSeconds: number;
  spliceFadeOutSeconds: number;
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
  warpRequestsByClipId: ReadonlyMap<string, AudioWarpRenderRequest>;
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
  const warpRequestsByClipId = compileAudioWarpRenderRequestIndex(project).byClipId;
  const sortedRegions = collectAudioRegions(project, tempo, maxRegions, warpRequestsByClipId)
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
    warpRequestsByClipId,
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
  warpRequestsByClipId: ReadonlyMap<string, AudioWarpRenderRequest> =
    compileAudioWarpRenderRequestIndex(project).byClipId,
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
      const warpRequest = warpRequestsByClipId.get(clip.id);
      const playbackDurationSeconds = warpRequest
        ? warpRequest.outputFrameCount / warpRequest.targetSampleRate
        : sourceDurationSeconds;
      if (
        !Number.isFinite(clipStartSeconds) ||
        !Number.isFinite(timelineDurationSeconds) ||
        !Number.isFinite(playbackDurationSeconds) ||
        timelineDurationSeconds <= 0 ||
        playbackDurationSeconds <= 0
      ) {
        continue;
      }

      const audibleDurationSeconds = clip.loop
        ? timelineDurationSeconds
        : Math.min(timelineDurationSeconds, playbackDurationSeconds);
      const normalizedFades = normalizeFades(
        warpRequest
          ? sourceFrameOffsetToOutputSeconds(warpRequest, clip.fadeInFrames)
          : clip.fadeInFrames / asset.sampleRate,
        warpRequest
          ? playbackDurationSeconds - sourceFrameOffsetToOutputSeconds(
              warpRequest,
              clip.sourceFrameCount - clip.fadeOutFrames,
            )
          : clip.fadeOutFrames / asset.sampleRate,
        audibleDurationSeconds,
      );
      if (regions.length >= maxRegions) {
        throw new AudioClipPlanLimitError(maxRegions, regions.length + 1);
      }
      regions.push({
        trackId: track.id,
        clip,
        sourceIdentity: Object.freeze(['clip', track.id, clip.id]),
        asset,
        warpRequest: warpRequest ?? null,
        clipStartSeconds,
        audibleEndSeconds: clipStartSeconds + audibleDurationSeconds,
        sourceDurationSeconds: playbackDurationSeconds,
        sourceStartSeconds: warpRequest ? 0 : clip.sourceStartFrame / asset.sampleRate,
        fadeInSeconds: normalizedFades.fadeInSeconds,
        fadeOutSeconds: normalizedFades.fadeOutSeconds,
        outerFadeOffsetSeconds: 0,
        outerFadeDurationSeconds: audibleDurationSeconds,
        spliceFadeInSeconds: 0,
        spliceFadeOutSeconds: 0,
        gainLinear: audioClipGainToLinear(clip.gainDb),
      });
    }
  }

  for (const folder of project.audioTakeFolders) {
    const track = project.tracks.find(
      (candidate) => candidate.id === folder.trackId && candidate.type === 'audio',
    );
    if (!track) continue;
    const takes = new Map(folder.takes.map((take) => [take.id, take]));
    for (const [segmentIndex, segment] of folder.compSegments.entries()) {
      const take = takes.get(segment.takeId);
      if (!take) continue;
      const asset = readyAssets.get(take.audioAssetId);
      if (!asset || asset.sampleRate <= 0 || take.sourceFrameCount <= 0) continue;

      const segmentStartBeat = folder.startBeat + segment.offsetBeats;
      const segmentEndBeat = Math.min(
        project.lengthBeats,
        segmentStartBeat + segment.lengthBeats,
      );
      const takeStartBeat = folder.startBeat + take.offsetBeats;
      const segmentStartSeconds = tempo.beatToSeconds(segmentStartBeat);
      const segmentEndSeconds = tempo.beatToSeconds(segmentEndBeat);
      const takeStartSeconds = tempo.beatToSeconds(takeStartBeat);
      const elapsedTakeSeconds = segmentStartSeconds - takeStartSeconds;
      const logicalSourceStartSeconds =
        take.sourceStartFrame / asset.sampleRate + elapsedTakeSeconds;
      const sourceWindowEndSeconds =
        (take.sourceStartFrame + take.sourceFrameCount) / asset.sampleRate;
      const logicalTimelineDurationSeconds = segmentEndSeconds - segmentStartSeconds;
      const logicalSourceDurationSeconds =
        sourceWindowEndSeconds - logicalSourceStartSeconds;
      if (
        !Number.isFinite(segmentStartSeconds) ||
        !Number.isFinite(logicalTimelineDurationSeconds) ||
        !Number.isFinite(logicalSourceStartSeconds) ||
        !Number.isFinite(logicalSourceDurationSeconds) ||
        logicalTimelineDurationSeconds <= 0 ||
        logicalSourceDurationSeconds <= 0
      ) {
        continue;
      }

      const leftCrossfadeHalfSeconds = compBoundaryHalfSeconds({
        folder,
        leftSegment: folder.compSegments[segmentIndex - 1],
        rightSegment: segment,
        takes,
        readyAssets,
        tempo,
      });
      const rightCrossfadeHalfSeconds = compBoundaryHalfSeconds({
        folder,
        leftSegment: segment,
        rightSegment: folder.compSegments[segmentIndex + 1],
        takes,
        readyAssets,
        tempo,
      });
      const regionStartSeconds = segmentStartSeconds - leftCrossfadeHalfSeconds;
      const regionEndSeconds = segmentEndSeconds + rightCrossfadeHalfSeconds;
      const sourceStartSeconds =
        logicalSourceStartSeconds - leftCrossfadeHalfSeconds;
      const timelineDurationSeconds = regionEndSeconds - regionStartSeconds;
      const sourceDurationSeconds = Math.min(
        timelineDurationSeconds,
        logicalSourceDurationSeconds
          + leftCrossfadeHalfSeconds
          + rightCrossfadeHalfSeconds,
      );
      const audibleDurationSeconds = Math.min(timelineDurationSeconds, sourceDurationSeconds);
      // A persisted take fade is measured on the immutable take, not on the
      // currently selected comp slice. Keep that take-local duration intact:
      // an interior or short edge slice samples/truncates the original
      // envelope instead of discarding or speeding it up to fit the slice.
      const outerFades = {
        fadeInSeconds: finiteNonNegative(take.fadeInFrames / asset.sampleRate),
        fadeOutSeconds: finiteNonNegative(take.fadeOutFrames / asset.sampleRate),
      };
      const takeSourceStartSeconds = take.sourceStartFrame / asset.sampleRate;
      const outerFadeOffsetSeconds = finiteNonNegative(
        sourceStartSeconds - takeSourceStartSeconds,
      );
      const outerFadeDurationSeconds =
        take.sourceFrameCount / asset.sampleRate;
      const normalizedSpliceFades = normalizeFades(
        leftCrossfadeHalfSeconds * 2,
        rightCrossfadeHalfSeconds * 2,
        audibleDurationSeconds,
      );
      if (regions.length >= maxRegions) {
        throw new AudioClipPlanLimitError(maxRegions, regions.length + 1);
      }
      const virtualClip: AudioClip = {
        id: JSON.stringify(['comp', folder.id, segment.id, take.id]),
        trackId: track.id,
        type: 'audio',
        startBeat: tempo.secondsToBeat(regionStartSeconds),
        lengthBeats:
          tempo.secondsToBeat(regionEndSeconds) - tempo.secondsToBeat(regionStartSeconds),
        loop: false,
        audioAssetId: asset.id,
        sourceStartFrame: Math.max(0, Math.round(sourceStartSeconds * asset.sampleRate)),
        sourceFrameCount: Math.max(
          1,
          Math.floor(sourceDurationSeconds * asset.sampleRate),
        ),
        fadeInFrames: Math.max(
          0,
          Math.round(outerFades.fadeInSeconds * asset.sampleRate),
        ),
        fadeOutFrames: Math.max(
          0,
          Math.round(outerFades.fadeOutSeconds * asset.sampleRate),
        ),
        gainDb: take.gainDb,
      };
      regions.push({
        trackId: track.id,
        clip: virtualClip,
        sourceIdentity: Object.freeze([
          'comp',
          track.id,
          folder.id,
          segment.id,
          take.id,
        ]),
        asset,
        warpRequest: null,
        clipStartSeconds: regionStartSeconds,
        audibleEndSeconds: regionStartSeconds + audibleDurationSeconds,
        sourceDurationSeconds,
        sourceStartSeconds,
        fadeInSeconds: outerFades.fadeInSeconds,
        fadeOutSeconds: outerFades.fadeOutSeconds,
        outerFadeOffsetSeconds,
        outerFadeDurationSeconds,
        spliceFadeInSeconds: normalizedSpliceFades.fadeInSeconds,
        spliceFadeOutSeconds: normalizedSpliceFades.fadeOutSeconds,
        gainLinear: audioClipGainToLinear(take.gainDb),
      });
    }
  }
  return regions;
}

type CompBoundaryInput = Readonly<{
  folder: Project['audioTakeFolders'][number];
  leftSegment: Project['audioTakeFolders'][number]['compSegments'][number] | undefined;
  rightSegment: Project['audioTakeFolders'][number]['compSegments'][number] | undefined;
  takes: ReadonlyMap<string, Project['audioTakeFolders'][number]['takes'][number]>;
  readyAssets: ReadonlyMap<string, ReadyAudioAsset>;
  tempo: BeatTimeMapping;
}>;

/**
 * Return the symmetric half-window around one logical comp boundary.
 *
 * A folder value of 10 ms therefore yields a 10 ms overlap: the outgoing
 * source extends 5 ms right and the incoming source extends 5 ms left. The
 * window is reduced deterministically when a segment or source handle is too
 * short, so adjacent fades never request bytes outside either immutable take.
 */
function compBoundaryHalfSeconds(input: CompBoundaryInput): number {
  const {
    folder,
    leftSegment,
    rightSegment,
    takes,
    readyAssets,
    tempo,
  } = input;
  if (
    !leftSegment ||
    !rightSegment ||
    leftSegment.takeId === rightSegment.takeId ||
    Math.abs(
      leftSegment.offsetBeats
        + leftSegment.lengthBeats
        - rightSegment.offsetBeats,
    ) > BEAT_EPSILON
  ) {
    return 0;
  }
  const requestedHalfSeconds = folder.crossfadeMs / 2_000;
  if (!(requestedHalfSeconds > 0) || !Number.isFinite(requestedHalfSeconds)) {
    return 0;
  }
  const leftTake = takes.get(leftSegment.takeId);
  const rightTake = takes.get(rightSegment.takeId);
  if (!leftTake || !rightTake) return 0;
  const leftAsset = readyAssets.get(leftTake.audioAssetId);
  const rightAsset = readyAssets.get(rightTake.audioAssetId);
  if (!leftAsset || !rightAsset || leftAsset.sampleRate <= 0 || rightAsset.sampleRate <= 0) {
    return 0;
  }

  const boundaryBeat =
    folder.startBeat + leftSegment.offsetBeats + leftSegment.lengthBeats;
  const boundarySeconds = tempo.beatToSeconds(boundaryBeat);
  const leftStartSeconds = tempo.beatToSeconds(
    folder.startBeat + leftSegment.offsetBeats,
  );
  const rightEndSeconds = tempo.beatToSeconds(
    folder.startBeat + rightSegment.offsetBeats + rightSegment.lengthBeats,
  );
  const leftTakeStartSeconds = tempo.beatToSeconds(
    folder.startBeat + leftTake.offsetBeats,
  );
  const rightTakeStartSeconds = tempo.beatToSeconds(
    folder.startBeat + rightTake.offsetBeats,
  );
  const leftSourceAtBoundary =
    leftTake.sourceStartFrame / leftAsset.sampleRate
    + boundarySeconds
    - leftTakeStartSeconds;
  const rightSourceAtBoundary =
    rightTake.sourceStartFrame / rightAsset.sampleRate
    + boundarySeconds
    - rightTakeStartSeconds;
  const leftSourceEnd =
    (leftTake.sourceStartFrame + leftTake.sourceFrameCount) / leftAsset.sampleRate;
  const rightSourceStart = rightTake.sourceStartFrame / rightAsset.sampleRate;
  const halfSeconds = Math.min(
    requestedHalfSeconds,
    Math.max(0, (boundarySeconds - leftStartSeconds) / 4),
    Math.max(0, (rightEndSeconds - boundarySeconds) / 4),
    Math.max(0, leftSourceEnd - leftSourceAtBoundary),
    Math.max(0, rightSourceAtBoundary - rightSourceStart),
  );
  return Number.isFinite(halfSeconds) ? Math.max(0, halfSeconds) : 0;
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
    playbackBufferKey: playbackBufferKey(region),
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

function playbackBufferKey(region: AudioClipRegionIndexEntry): AudioClipPlaybackBufferKey {
  const request = region.warpRequest;
  return request
    ? Object.freeze({
        kind: 'derived',
        assetId: request.assetId,
        checksumSha256: request.checksumSha256,
        cacheKey: request.cacheKey,
        sampleRate: request.targetSampleRate,
        frameCount: request.outputFrameCount,
      })
    : Object.freeze({
        kind: 'source',
        assetId: region.asset.id,
        checksumSha256: region.asset.checksumSha256,
      });
}

function sourceFrameOffsetToOutputSeconds(
  request: AudioWarpRenderRequest,
  sourceFrameOffset: number,
): number {
  const sourceIndex = sourceFrameOffset
    * request.targetSampleRate
    / request.sourceSampleRate;
  const knots = request.knots;
  if (sourceIndex <= 0) return 0;
  if (sourceIndex >= request.sourceFrameCountAtTargetRate) {
    return request.outputFrameCount / request.targetSampleRate;
  }
  for (let index = 1; index < knots.length; index += 1) {
    const right = knots[index]!;
    if (sourceIndex > right.sourceIndex) continue;
    const left = knots[index - 1]!;
    const ratio = (sourceIndex - left.sourceIndex)
      / (right.sourceIndex - left.sourceIndex);
    return (left.outputFrame + ratio * (right.outputFrame - left.outputFrame))
      / request.targetSampleRate;
  }
  return request.outputFrameCount / request.targetSampleRate;
}

function gainPoints(
  region: AudioClipRegionIndexEntry,
  startSeconds: number,
  endSeconds: number,
): AudioClipGainPoint[] {
  const startElapsed = startSeconds - region.clipStartSeconds;
  const endElapsed = endSeconds - region.clipStartSeconds;
  const fadeInEnd =
    region.fadeInSeconds - region.outerFadeOffsetSeconds;
  const fadeOutStart =
    region.outerFadeDurationSeconds
    - region.fadeOutSeconds
    - region.outerFadeOffsetSeconds;
  const spliceFadeOutStart = Math.max(
    0,
    region.audibleEndSeconds
      - region.clipStartSeconds
      - region.spliceFadeOutSeconds,
  );
  const breakpoints = [
    startElapsed,
    fadeInEnd,
    fadeOutStart,
    region.spliceFadeInSeconds,
    spliceFadeOutStart,
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
  const outerEnvelope = linearEdgeEnvelope(
    region.outerFadeOffsetSeconds + elapsedSeconds,
    region.outerFadeDurationSeconds,
    region.fadeInSeconds,
    region.fadeOutSeconds,
  );
  const spliceEnvelope = linearEdgeEnvelope(
    elapsedSeconds,
    totalSeconds,
    region.spliceFadeInSeconds,
    region.spliceFadeOutSeconds,
  );
  return region.gainLinear * outerEnvelope * spliceEnvelope;
}

function linearEdgeEnvelope(
  elapsedSeconds: number,
  totalSeconds: number,
  fadeInSeconds: number,
  fadeOutSeconds: number,
): number {
  let envelope = 1;
  if (fadeInSeconds > 0 && elapsedSeconds < fadeInSeconds) {
    envelope = Math.min(envelope, Math.max(0, elapsedSeconds / fadeInSeconds));
  }
  if (fadeOutSeconds > 0 && elapsedSeconds > totalSeconds - fadeOutSeconds) {
    envelope = Math.min(
      envelope,
      Math.max(0, (totalSeconds - elapsedSeconds) / fadeOutSeconds),
    );
  }
  return envelope;
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
  return JSON.stringify([
    ...region.sourceIdentity,
    cycleKey,
    roundBeat(fullStartProjectBeat),
  ]);
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
