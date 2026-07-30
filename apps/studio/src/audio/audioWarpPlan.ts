import {
  audioWarpTimingSegmentIssues,
  MAX_AUDIO_PITCH_REGIONS,
  MAX_AUDIO_WARP_MARKERS,
  MAX_AUDIO_WARP_STRETCH,
  MAX_TEMPO_MAP_EVENTS,
  MIN_AUDIO_WARP_SEGMENT_SECONDS,
  MIN_AUDIO_WARP_STRETCH,
  iterateAudioWarpTimingSegments,
  type AudioPitchRegion,
  type AudioWarpFormantMode,
  type Project,
  type ReadyAudioAsset,
  type TempoMapEvent,
  validateProject,
} from '@cts/project-model';
import { createProjectMusicalTime } from './musicalTime';

export const AUDIO_WARP_RENDER_ALGORITHM_VERSION = 'wsola-v1/dsp-2';
export const MAX_DERIVED_AUDIO_PCM_BYTES = 128 * 1024 * 1024;
export const MAX_AUDIO_WARP_SHARED_HEAVY_BYTES = 384 * 1024 * 1024;
export const AUDIO_WARP_FORMANT_SCRATCH_BYTES = 147_456;
export const MAX_AUDIO_WARP_RENDER_SECONDS = 60;
export const MAX_COMPILED_AUDIO_WARP_KNOTS =
  MAX_AUDIO_WARP_MARKERS + MAX_TEMPO_MAP_EVENTS;

export type AudioWarpFormantResourceReason =
  | 'invalid-projection'
  | 'derived-ceiling'
  | 'shared-heavy';

export type AudioWarpFormantResourcePlan = Readonly<{
  accepted: boolean;
  reason: AudioWarpFormantResourceReason | null;
  sourceBytes: number;
  outputBytes: number;
  sourcePeakBytes: number;
  outputPeakBytes: number;
  scratchBytes: number;
  processingPeakBytes: number;
  sharedPeakBytes: number;
  fftSize: 0 | 2048;
  hopSize: 0 | 1024;
  radix2Stages: 0 | 11;
  workUnits: number;
}>;

/** Allocation-free projection shared by every live and export consumer. */
export function computeAudioWarpFormantResourcePlan(
  projection: Readonly<{
    sourceBytes: number;
    outputBytes: number;
    outerReservationBytes?: number;
    outputFrames?: number;
    channelCount?: number;
    sampleRate?: number;
  }>,
): AudioWarpFormantResourcePlan {
  const sourceBytes = projection.sourceBytes;
  const outputBytes = projection.outputBytes;
  const outer = projection.outerReservationBytes ?? 0;
  const supported = projection.sampleRate === undefined
    || projection.sampleRate === 44_100
    || projection.sampleRate === 48_000;
  const base = {
    sourceBytes,
    outputBytes,
    sourcePeakBytes: 0,
    outputPeakBytes: 0,
    scratchBytes: supported ? AUDIO_WARP_FORMANT_SCRATCH_BYTES : 0,
    processingPeakBytes: 0,
    sharedPeakBytes: 0,
    fftSize: supported ? 2048 as const : 0 as const,
    hopSize: supported ? 1024 as const : 0 as const,
    radix2Stages: supported ? 11 as const : 0 as const,
    workUnits: 0,
  };
  if ([sourceBytes, outputBytes, outer].some(
    (value) => !Number.isSafeInteger(value) || value < 0,
  )) return Object.freeze({ ...base, accepted: false, reason: 'invalid-projection' });
  if (outputBytes > MAX_DERIVED_AUDIO_PCM_BYTES) {
    return Object.freeze({ ...base, accepted: false, reason: 'derived-ceiling' });
  }
  const sourcePeakBytes = checkedProjectionProduct(sourceBytes, 4);
  const outputPeakBytes = checkedProjectionProduct(outputBytes, 9);
  const processingPeakBytes = sourcePeakBytes === null || outputPeakBytes === null
    ? null
    : checkedProjectionSum([sourcePeakBytes, outputPeakBytes, base.scratchBytes]);
  const sharedPeakBytes = processingPeakBytes === null
    ? null
    : checkedProjectionSum([outer, processingPeakBytes]);
  const outputFrames = projection.outputFrames ?? 0;
  const channelCount = projection.channelCount ?? 0;
  const hasWorkProjection = projection.outputFrames !== undefined
    || projection.channelCount !== undefined;
  let workUnits: number | null = 0;
  if (
    supported
    && Number.isSafeInteger(outputFrames)
    && outputFrames >= 0
    && (channelCount === 1 || channelCount === 2)
  ) {
    const blocks = Math.ceil(outputFrames / 1024);
    const maximumLag = Math.ceil((projection.sampleRate ?? 48_000) / 70);
    const maximumHarmonics = Math.floor(5_000 / 70);
    const projected = [
      checkedProjectionProduct(blocks, 11, 2048, 2 + 2 * channelCount),
      checkedProjectionProduct(outputFrames, maximumLag),
      checkedProjectionProduct(blocks, 2048, maximumHarmonics, channelCount),
      checkedProjectionProduct(blocks, 8_192, 13, channelCount),
      checkedProjectionProduct(outputFrames, maximumHarmonics, 4 + 4 * channelCount),
      checkedProjectionProduct(blocks, 2_000, maximumHarmonics, 10),
    ];
    workUnits = projected.some((value) => value === null)
      ? null
      : checkedProjectionSum(projected as number[]);
  } else if (supported && hasWorkProjection) {
    workUnits = null;
  }
  if (
    sourcePeakBytes === null
    || outputPeakBytes === null
    || processingPeakBytes === null
    || sharedPeakBytes === null
    || workUnits === null
  ) {
    return Object.freeze({ ...base, accepted: false, reason: 'invalid-projection' });
  }
  const plan = {
    ...base,
    sourcePeakBytes,
    outputPeakBytes,
    processingPeakBytes,
    sharedPeakBytes,
    workUnits,
  };
  return sharedPeakBytes > MAX_AUDIO_WARP_SHARED_HEAVY_BYTES
    ? Object.freeze({ ...plan, accepted: false, reason: 'shared-heavy' })
    : Object.freeze({ ...plan, accepted: true, reason: null });
}

function checkedProjectionProduct(...values: number[]): number | null {
  let result = 1;
  for (const value of values) {
    if (
      !Number.isSafeInteger(value)
      || value < 0
      || (value !== 0 && result > Number.MAX_SAFE_INTEGER / value)
    ) return null;
    result *= value;
  }
  return Number.isSafeInteger(result) ? result : null;
}

function checkedProjectionSum(values: readonly number[]): number | null {
  let result = 0;
  for (const value of values) {
    if (
      !Number.isSafeInteger(value)
      || value < 0
      || result > Number.MAX_SAFE_INTEGER - value
    ) return null;
    result += value;
  }
  return result;
}

export type AudioWarpPlanErrorCode =
  | 'invalid-project'
  | 'invalid-target-rate'
  | 'invalid-edit'
  | 'unsupported-source'
  | 'resource-limit';

export class AudioWarpPlanError extends Error {
  constructor(
    readonly code: AudioWarpPlanErrorCode,
    readonly clipId: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'AudioWarpPlanError';
  }
}

export type CompiledAudioWarpKnot = Readonly<{
  /** Absolute source asset frame. */
  sourceFrame: number;
  /** Clip-window frame after exact rational conversion to target rate. */
  sourceIndex: number;
  /** Exact, once-rounded frame on the derived buffer timeline. */
  outputFrame: number;
}>;

export type CompiledAudioPitchRegion = Readonly<AudioPitchRegion & {
  sourceStartIndex: number;
  sourceFrameCountAtTargetRate: number;
  transitionFramesAtTargetRate: number;
  cents: number;
}>;

export type AudioWarpRenderRequest = Readonly<{
  algorithmVersion: typeof AUDIO_WARP_RENDER_ALGORITHM_VERSION;
  formantMode: AudioWarpFormantMode;
  assetId: string;
  checksumSha256: string;
  sourceSampleRate: number;
  sourceStartFrame: number;
  sourceFrameCount: number;
  sourceStartIndex: number;
  sourceFrameCountAtTargetRate: number;
  targetSampleRate: number;
  channelCount: 1 | 2;
  outputFrameCount: number;
  knots: readonly CompiledAudioWarpKnot[];
  pitchRegions: readonly CompiledAudioPitchRegion[];
  cacheKey: string;
}>;

export type AudioWarpRenderRequestIndex = Readonly<{
  requests: readonly AudioWarpRenderRequest[];
  byClipId: ReadonlyMap<string, AudioWarpRenderRequest>;
}>;

const AUDIO_WARP_RENDER_REQUEST_KEYS = Object.freeze([
  'algorithmVersion',
  'formantMode',
  'assetId',
  'checksumSha256',
  'sourceSampleRate',
  'sourceStartFrame',
  'sourceFrameCount',
  'sourceStartIndex',
  'sourceFrameCountAtTargetRate',
  'targetSampleRate',
  'channelCount',
  'outputFrameCount',
  'knots',
  'pitchRegions',
  'cacheKey',
]);
const AUDIO_WARP_KNOT_KEYS = Object.freeze([
  'sourceFrame',
  'sourceIndex',
  'outputFrame',
]);
const AUDIO_WARP_PITCH_REGION_KEYS = Object.freeze([
  'sourceStartFrame',
  'sourceFrameCount',
  'sourcePitchCents',
  'targetPitchCents',
  'correctionAmount',
  'transitionFrames',
  'sourceStartIndex',
  'sourceFrameCountAtTargetRate',
  'transitionFramesAtTargetRate',
  'cents',
]);

/**
 * Runtime request validator shared by the public DSP entry and Worker
 * protocol. It validates compiled cross-field invariants, not only shape.
 */
export function isValidAudioWarpRenderRequest(
  value: unknown,
): value is AudioWarpRenderRequest {
  if (!record(value) || !hasExactKeys(value, AUDIO_WARP_RENDER_REQUEST_KEYS)) return false;
  if (
    value.algorithmVersion !== AUDIO_WARP_RENDER_ALGORITHM_VERSION
    || (value.formantMode !== 'off' && value.formantMode !== 'preserve')
    || typeof value.assetId !== 'string'
    || value.assetId.length === 0
    || typeof value.checksumSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.checksumSha256)
    || typeof value.cacheKey !== 'string'
    || value.cacheKey.length === 0
    || value.sourceSampleRate !== 48_000
    || !safeIntegerIn(value.targetSampleRate, 8_000, 384_000)
    || !safeIntegerIn(value.sourceStartFrame, 0, Number.MAX_SAFE_INTEGER)
    || !safeIntegerIn(value.sourceFrameCount, 1, Number.MAX_SAFE_INTEGER)
    || !safeIntegerIn(value.sourceStartIndex, 0, Number.MAX_SAFE_INTEGER)
    || !safeIntegerIn(value.sourceFrameCountAtTargetRate, 1, Number.MAX_SAFE_INTEGER)
    || (value.channelCount !== 1 && value.channelCount !== 2)
    || !safeIntegerIn(value.outputFrameCount, 1, Number.MAX_SAFE_INTEGER)
    || value.sourceFrameCount / value.sourceSampleRate > MAX_AUDIO_WARP_RENDER_SECONDS
  ) return false;

  const sourceEndFrame = checkedSafeSum(value.sourceStartFrame, value.sourceFrameCount);
  const expectedSourceStartIndex = convertedFrameOrNull(
    value.sourceStartFrame,
    value.sourceSampleRate,
    value.targetSampleRate,
  );
  const expectedSourceFrameCountAtTargetRate = convertedFrameOrNull(
    value.sourceFrameCount,
    value.sourceSampleRate,
    value.targetSampleRate,
  );
  const derivedBytes = value.outputFrameCount * value.channelCount * 4;
  if (
    sourceEndFrame === null
    || expectedSourceStartIndex !== value.sourceStartIndex
    || expectedSourceFrameCountAtTargetRate !== value.sourceFrameCountAtTargetRate
    || !Number.isSafeInteger(derivedBytes)
    || derivedBytes > MAX_DERIVED_AUDIO_PCM_BYTES
    || !Array.isArray(value.knots)
    || value.knots.length < 2
    || value.knots.length > MAX_COMPILED_AUDIO_WARP_KNOTS
    || !Array.isArray(value.pitchRegions)
    || value.pitchRegions.length > MAX_AUDIO_PITCH_REGIONS
  ) return false;

  let previousSourceFrame = Number.NEGATIVE_INFINITY;
  let previousSourceIndex = Number.NEGATIVE_INFINITY;
  let previousOutputFrame = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < value.knots.length; index += 1) {
    const knot = value.knots[index];
    if (
      !record(knot)
      || !hasExactKeys(knot, AUDIO_WARP_KNOT_KEYS)
      || !finiteIn(knot.sourceFrame, value.sourceStartFrame, sourceEndFrame)
      || !safeIntegerIn(knot.sourceIndex, 0, value.sourceFrameCountAtTargetRate)
      || !safeIntegerIn(knot.outputFrame, 0, value.outputFrameCount)
      || convertedFrameOrNull(
        knot.sourceFrame - value.sourceStartFrame,
        value.sourceSampleRate,
        value.targetSampleRate,
      ) !== knot.sourceIndex
      || knot.sourceFrame <= previousSourceFrame
      || knot.sourceIndex <= previousSourceIndex
      || knot.outputFrame <= previousOutputFrame
    ) return false;
    if (
      index === 0
      && (
        knot.sourceFrame !== value.sourceStartFrame
        || knot.sourceIndex !== 0
        || knot.outputFrame !== 0
      )
    ) return false;
    if (
      index === value.knots.length - 1
      && (
        knot.sourceFrame !== sourceEndFrame
        || knot.sourceIndex !== value.sourceFrameCountAtTargetRate
        || knot.outputFrame !== value.outputFrameCount
      )
    ) return false;
    if (
      index > 0
      && !compiledTimingSegmentWithinLimits(
        knot.sourceIndex - previousSourceIndex,
        knot.outputFrame - previousOutputFrame,
        value.targetSampleRate,
      )
    ) return false;
    previousSourceFrame = knot.sourceFrame;
    previousSourceIndex = knot.sourceIndex;
    previousOutputFrame = knot.outputFrame;
  }

  let previousPitchEnd = value.sourceStartFrame;
  for (const candidate of value.pitchRegions) {
    if (
      !record(candidate)
      || !hasExactKeys(candidate, AUDIO_WARP_PITCH_REGION_KEYS)
      || !safeIntegerIn(candidate.sourceStartFrame, value.sourceStartFrame, sourceEndFrame)
      || !safeIntegerIn(candidate.sourceFrameCount, 1, Number.MAX_SAFE_INTEGER)
    ) return false;
    const regionEnd = checkedSafeSum(candidate.sourceStartFrame, candidate.sourceFrameCount);
    const calculatedCents =
      ((candidate.targetPitchCents as number) - (candidate.sourcePitchCents as number))
      * (candidate.correctionAmount as number);
    const expectedRegionStartIndex = convertedFrameOrNull(
      candidate.sourceStartFrame - value.sourceStartFrame,
      value.sourceSampleRate,
      value.targetSampleRate,
    );
    const expectedRegionEndIndex = regionEnd === null
      ? null
      : convertedFrameOrNull(
          regionEnd - value.sourceStartFrame,
          value.sourceSampleRate,
          value.targetSampleRate,
        );
    const expectedTransitionFrames = convertedFrameOrNull(
      candidate.transitionFrames as number,
      value.sourceSampleRate,
      value.targetSampleRate,
    );
    if (
      regionEnd === null
      || regionEnd > sourceEndFrame
      || candidate.sourceStartFrame < previousPitchEnd
      || !finiteIn(candidate.sourcePitchCents, 0, 12_700)
      || !finiteIn(candidate.targetPitchCents, 0, 12_700)
      || !finiteIn(candidate.correctionAmount, 0, 1)
      || !safeIntegerIn(
        candidate.transitionFrames,
        0,
        Math.floor(candidate.sourceFrameCount / 2),
      )
      || !safeIntegerIn(
        candidate.sourceStartIndex,
        0,
        value.sourceFrameCountAtTargetRate,
      )
      || !safeIntegerIn(
        candidate.sourceFrameCountAtTargetRate,
        1,
        value.sourceFrameCountAtTargetRate,
      )
      || !safeIntegerIn(
        candidate.transitionFramesAtTargetRate,
        0,
        candidate.sourceFrameCountAtTargetRate,
      )
      || !finiteIn(candidate.cents, -300, 300)
      || candidate.cents !== calculatedCents
      || expectedRegionStartIndex !== candidate.sourceStartIndex
      || expectedRegionEndIndex === null
      || expectedRegionEndIndex - expectedRegionStartIndex
        !== candidate.sourceFrameCountAtTargetRate
      || expectedTransitionFrames !== candidate.transitionFramesAtTargetRate
    ) return false;
    previousPitchEnd = regionEnd;
  }
  return true;
}

type CompileOptions = Readonly<{ targetSampleRate?: number }>;

/**
 * Compile all edited direct clips. Ordinary projects deliberately return []
 * and continue through the existing decoded AudioBuffer path.
 */
export function compileAudioWarpRenderRequests(
  project: Project,
  optionsOrRate: CompileOptions | number = {},
): AudioWarpRenderRequest[] {
  return [...compileAudioWarpRenderRequestIndex(project, optionsOrRate).requests];
}

/** Compile once while retaining the clip-to-content-addressed-request identity. */
export function compileAudioWarpRenderRequestIndex(
  project: Project,
  optionsOrRate: CompileOptions | number = {},
): AudioWarpRenderRequestIndex {
  const targetSampleRate = typeof optionsOrRate === 'number'
    ? optionsOrRate
    : optionsOrRate.targetSampleRate ?? 48_000;
  if (
    !Number.isSafeInteger(targetSampleRate)
    || targetSampleRate < 8_000
    || targetSampleRate > 384_000
  ) {
    throw new AudioWarpPlanError('invalid-target-rate', null, 'Target sample rate is invalid.');
  }

  const edited = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => (
      clip.type === 'audio'
      && clip.audioWarp !== undefined
      && (
        clip.audioWarp.timingEnabled
        || (
          clip.audioWarp.pitchEnabled
          && clip.audioWarp.pitchRegions.some((region) => effectivePitchCents(region) !== 0)
        )
      )
    )),
  );
  if (edited.length === 0) {
    return Object.freeze({ requests: Object.freeze([]), byClipId: new Map() });
  }

  const validation = validateProject(project);
  if (!validation.valid) {
    throw new AudioWarpPlanError(
      'invalid-project',
      edited[0]?.id ?? null,
      validation.errors[0]
        ? `${validation.errors[0].path}: ${validation.errors[0].message}`
        : 'Project is invalid.',
    );
  }
  const tempo = createProjectMusicalTime(project).tempo;
  const assets = new Map(project.audioAssets.map((asset) => [asset.id, asset]));
  const byKey = new Map<string, AudioWarpRenderRequest>();
  const byClipId = new Map<string, AudioWarpRenderRequest>();
  for (const clip of edited) {
    const asset = assets.get(clip.audioAssetId ?? '');
    if (asset?.availability !== 'ready') {
      throw new AudioWarpPlanError('invalid-edit', clip.id, 'Edited clip needs a ready asset.');
    }
    const request = compileOne(
      clip as typeof clip & Required<Pick<typeof clip, 'audioWarp' | 'sourceStartFrame' | 'sourceFrameCount'>>,
      asset,
      targetSampleRate,
      tempo.beatToSeconds,
      project.tempoMap,
    );
    if (!byKey.has(request.cacheKey)) byKey.set(request.cacheKey, request);
    byClipId.set(clip.id, byKey.get(request.cacheKey)!);
  }
  return Object.freeze({
    requests: Object.freeze([...byKey.values()]),
    byClipId,
  });
}

function compileOne(
  clip: Project['tracks'][number]['clips'][number] & {
    audioWarp: NonNullable<Project['tracks'][number]['clips'][number]['audioWarp']>;
    sourceStartFrame: number;
    sourceFrameCount: number;
  },
  asset: ReadyAudioAsset,
  targetSampleRate: number,
  beatToSeconds: (beat: number) => number,
  tempoMap: readonly TempoMapEvent[],
): AudioWarpRenderRequest {
  const warp = clip.audioWarp;
  if (
    warp.markers.length < 2
    || warp.markers.length > MAX_AUDIO_WARP_MARKERS
    || warp.pitchRegions.length > MAX_AUDIO_PITCH_REGIONS
    || clip.sourceFrameCount / asset.sampleRate > MAX_AUDIO_WARP_RENDER_SECONDS
  ) {
    throw new AudioWarpPlanError('invalid-edit', clip.id, 'Elastic Audio edit exceeds its limits.');
  }
  if (
    asset.mediaType !== 'audio/wav'
    || asset.sampleRate !== 48_000
    || (asset.channelCount !== 1 && asset.channelCount !== 2)
  ) {
    throw new AudioWarpPlanError(
      'unsupported-source',
      clip.id,
      'Elastic Audio requires canonical 48 kHz mono or stereo PCM16 WAV.',
    );
  }
  const clipStartSeconds = beatToSeconds(clip.startBeat);
  const knots = compileTimingKnots(
    clip,
    asset,
    targetSampleRate,
    beatToSeconds,
    clipStartSeconds,
    tempoMap,
  );
  assertCompiledKnots(knots, targetSampleRate, clip.id);
  const outputFrameCount = knots.at(-1)!.outputFrame;
  const derivedBytes = checkedProduct(outputFrameCount, asset.channelCount, 4, clip.id);
  if (derivedBytes > MAX_DERIVED_AUDIO_PCM_BYTES) {
    throw new AudioWarpPlanError(
      'resource-limit',
      clip.id,
      'Derived Elastic Audio PCM exceeds 128 MiB.',
    );
  }

  const pitchRegions = warp.pitchEnabled
    ? warp.pitchRegions
      .filter((region) => effectivePitchCents(region) !== 0)
      .map((region) => {
        const sourceStartIndex = convertFrame(
          region.sourceStartFrame - clip.sourceStartFrame,
          asset.sampleRate,
          targetSampleRate,
          clip.id,
        );
        const sourceEndIndex = convertFrame(
          region.sourceStartFrame + region.sourceFrameCount - clip.sourceStartFrame,
          asset.sampleRate,
          targetSampleRate,
          clip.id,
        );
        const sourceFrameCountAtTargetRate = sourceEndIndex - sourceStartIndex;
        if (sourceFrameCountAtTargetRate <= 0) {
          throw new AudioWarpPlanError(
            'invalid-edit',
            clip.id,
            'A pitch region is shorter than one target-rate frame.',
          );
        }
        return Object.freeze({
          ...region,
          sourceStartIndex,
          sourceFrameCountAtTargetRate,
          transitionFramesAtTargetRate: convertFrame(
            region.transitionFrames,
            asset.sampleRate,
            targetSampleRate,
            clip.id,
          ),
          cents: effectivePitchCents(region),
        });
      })
    : [];
  const identity = {
    algorithmVersion: AUDIO_WARP_RENDER_ALGORITHM_VERSION,
    formantMode: warp.formantMode,
    checksumSha256: asset.checksumSha256,
    sourceWindow: [clip.sourceStartFrame, clip.sourceFrameCount],
    sourceSampleRate: asset.sampleRate,
    targetSampleRate,
    channelCount: asset.channelCount,
    knots: knots.map(({ sourceFrame, sourceIndex, outputFrame }) =>
      [sourceFrame, sourceIndex, outputFrame]),
    pitchRegions: pitchRegions.map((region) => [
      region.sourceStartFrame,
      region.sourceFrameCount,
      region.sourcePitchCents,
      region.targetPitchCents,
      region.correctionAmount,
      region.transitionFrames,
      region.sourceStartIndex,
      region.sourceFrameCountAtTargetRate,
    ]),
  };
  const cacheKey = stableAudioWarpCacheKey(identity);
  const request: AudioWarpRenderRequest = Object.freeze({
    algorithmVersion: AUDIO_WARP_RENDER_ALGORITHM_VERSION,
    formantMode: warp.formantMode,
    assetId: asset.id,
    checksumSha256: asset.checksumSha256,
    sourceSampleRate: asset.sampleRate,
    sourceStartFrame: clip.sourceStartFrame,
    sourceFrameCount: clip.sourceFrameCount,
    sourceStartIndex: convertFrame(
      clip.sourceStartFrame,
      asset.sampleRate,
      targetSampleRate,
      clip.id,
    ),
    sourceFrameCountAtTargetRate: convertFrame(
      clip.sourceFrameCount,
      asset.sampleRate,
      targetSampleRate,
      clip.id,
    ),
    targetSampleRate,
    channelCount: asset.channelCount,
    outputFrameCount,
    knots: Object.freeze(knots),
    pitchRegions: Object.freeze(pitchRegions),
    cacheKey,
  });
  if (!isValidAudioWarpRenderRequest(request)) {
    throw new AudioWarpPlanError(
      'invalid-edit',
      clip.id,
      'Compiled Elastic Audio request failed its runtime invariants.',
    );
  }
  return request;
}

/**
 * Persisted timing points interpolate in beat space. The shared Project Model
 * partition adds every tempo boundary as an implicit render knot so DSP and
 * schema validation use exactly the same local timing segments.
 */
function compileTimingKnots(
  clip: Project['tracks'][number]['clips'][number] & {
    audioWarp: NonNullable<Project['tracks'][number]['clips'][number]['audioWarp']>;
    sourceStartFrame: number;
    sourceFrameCount: number;
  },
  asset: ReadyAudioAsset,
  targetSampleRate: number,
  beatToSeconds: (beat: number) => number,
  clipStartSeconds: number,
  tempoMap: readonly TempoMapEvent[],
): CompiledAudioWarpKnot[] {
  const { audioWarp: warp } = clip;
  const compileKnot = (
    sourceFrame: number,
    targetBeatOffset: number,
    timingEnabled: boolean,
  ): CompiledAudioWarpKnot => Object.freeze({
    sourceFrame,
    sourceIndex: convertFramePosition(
      sourceFrame - clip.sourceStartFrame,
      asset.sampleRate,
      targetSampleRate,
      clip.id,
    ),
    outputFrame: timingEnabled
      ? roundedFrame(
          beatToSeconds(clip.startBeat + targetBeatOffset) - clipStartSeconds,
          targetSampleRate,
          clip.id,
        )
      : convertFramePosition(
          sourceFrame - clip.sourceStartFrame,
          asset.sampleRate,
          targetSampleRate,
          clip.id,
        ),
  });

  if (!warp.timingEnabled) {
    return [
      compileKnot(warp.markers[0]!.sourceFrame, 0, false),
      compileKnot(warp.markers.at(-1)!.sourceFrame, warp.markers.at(-1)!.targetBeatOffset, false),
    ];
  }

  const knots: CompiledAudioWarpKnot[] = [
    compileKnot(
      warp.markers[0]!.sourceFrame,
      warp.markers[0]!.targetBeatOffset,
      true,
    ),
  ];
  let segmentCount = 0;
  for (const segment of iterateAudioWarpTimingSegments(
    warp,
    clip.startBeat,
    tempoMap,
  )) {
    segmentCount += 1;
    if (audioWarpTimingSegmentIssues(segment, asset.sampleRate).length > 0) {
      throw new AudioWarpPlanError(
        'invalid-edit',
        clip.id,
        'Elastic Audio timing segments exceed duration or stretch limits.',
      );
    }
    knots.push(compileKnot(
      segment.sourceEndFrame,
      segment.targetEndBeatOffset,
      true,
    ));
  }
  if (segmentCount === 0) {
    throw new AudioWarpPlanError(
      'invalid-edit',
      clip.id,
      'Elastic Audio timing segments could not be compiled.',
    );
  }
  return knots;
}

function effectivePitchCents(region: AudioPitchRegion): number {
  return (region.targetPitchCents - region.sourcePitchCents) * region.correctionAmount;
}

export function stableAudioWarpCacheKey(value: unknown): string {
  return `audio-warp:${JSON.stringify(value)}`;
}

function roundedFrame(seconds: number, rate: number, clipId: string): number {
  const exact = seconds * rate;
  const rounded = Math.round(exact);
  if (!Number.isFinite(exact) || !Number.isSafeInteger(rounded) || rounded < 0) {
    throw new AudioWarpPlanError('invalid-edit', clipId, 'Target knot frame is unsafe.');
  }
  return rounded;
}

function convertFrame(frame: number, fromRate: number, toRate: number, clipId: string): number {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new AudioWarpPlanError('invalid-edit', clipId, 'Source frame is unsafe.');
  }
  return convertFramePosition(frame, fromRate, toRate, clipId);
}

function convertFramePosition(
  frame: number,
  fromRate: number,
  toRate: number,
  clipId: string,
): number {
  if (!Number.isFinite(frame) || frame < 0) {
    throw new AudioWarpPlanError('invalid-edit', clipId, 'Source frame position is invalid.');
  }
  return roundedFrame(frame / fromRate, toRate, clipId);
}

function assertCompiledKnots(
  knots: readonly CompiledAudioWarpKnot[],
  targetSampleRate: number,
  clipId: string,
): void {
  for (let index = 0; index < knots.length; index += 1) {
    const knot = knots[index]!;
    if (
      (index === 0 && (knot.sourceIndex !== 0 || knot.outputFrame !== 0))
      || (index > 0 && (
        knot.sourceIndex <= knots[index - 1]!.sourceIndex
        || knot.outputFrame <= knots[index - 1]!.outputFrame
        || !compiledTimingSegmentWithinLimits(
          knot.sourceIndex - knots[index - 1]!.sourceIndex,
          knot.outputFrame - knots[index - 1]!.outputFrame,
          targetSampleRate,
        )
      ))
    ) {
      throw new AudioWarpPlanError(
        'invalid-edit',
        clipId,
        'Compiled knots exceed duration or stretch limits.',
      );
    }
  }
}

/**
 * Each endpoint is rounded once, so a segment delta can differ from its exact
 * pre-rounding span by less than one frame. Accept only requests for which a
 * contract-valid exact segment is still possible within that rounding bound.
 */
function compiledTimingSegmentWithinLimits(
  sourceIndexDelta: number,
  outputFrameDelta: number,
  targetSampleRate: number,
): boolean {
  if (
    !Number.isSafeInteger(sourceIndexDelta)
    || !Number.isSafeInteger(outputFrameDelta)
    || sourceIndexDelta <= 0
    || outputFrameDelta <= 0
  ) return false;
  const roundingToleranceFrames = 1;
  const minimumSegmentFrames = MIN_AUDIO_WARP_SEGMENT_SECONDS * targetSampleRate;
  if (
    sourceIndexDelta + roundingToleranceFrames < minimumSegmentFrames
    || outputFrameDelta + roundingToleranceFrames < minimumSegmentFrames
  ) return false;
  return outputFrameDelta + roundingToleranceFrames
      >= MIN_AUDIO_WARP_STRETCH
        * Math.max(0, sourceIndexDelta - roundingToleranceFrames)
    && Math.max(0, outputFrameDelta - roundingToleranceFrames)
      <= MAX_AUDIO_WARP_STRETCH
        * (sourceIndexDelta + roundingToleranceFrames);
}

function checkedProduct(
  first: number,
  second: number,
  third: number,
  clipId: string,
): number {
  const result = first * second * third;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AudioWarpPlanError('resource-limit', clipId, 'Derived PCM size overflowed.');
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && keys.every((key) => expected.includes(key));
}

function safeIntegerIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function finiteIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isFinite(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function checkedSafeSum(left: number, right: number): number | null {
  if (
    !Number.isSafeInteger(left)
    || !Number.isSafeInteger(right)
    || left < 0
    || right < 0
    || left > Number.MAX_SAFE_INTEGER - right
  ) return null;
  return left + right;
}

function convertedFrameOrNull(
  frame: unknown,
  fromRate: unknown,
  toRate: unknown,
): number | null {
  if (
    !Number.isFinite(frame)
    || (frame as number) < 0
    || !safeIntegerIn(fromRate, 1, Number.MAX_SAFE_INTEGER)
    || !safeIntegerIn(toRate, 1, Number.MAX_SAFE_INTEGER)
  ) return null;
  const exact = (frame as number) / fromRate * toRate;
  const rounded = Math.round(exact);
  return Number.isFinite(exact) && Number.isSafeInteger(rounded) && rounded >= 0
    ? rounded
    : null;
}
