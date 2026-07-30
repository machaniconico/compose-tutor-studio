import {
  MAX_AUDIO_WARP_STRETCH,
  MAX_AUDIO_PITCH_REGIONS,
  MAX_AUDIO_PITCH_SHIFT_CENTS,
  MAX_AUDIO_WARP_MARKERS,
  MIN_AUDIO_WARP_SEGMENT_SECONDS,
  MIN_AUDIO_WARP_STRETCH,
} from './limits';
import type {
  AudioClip,
  AudioPitchRegion,
  AudioWarp,
  AudioWarpMarker,
  TempoMapEvent,
} from './types';

/** New edits opt into formant preservation; migrations explicitly choose off. */
export function createLinearAudioWarp(
  clip: Pick<AudioClip, 'sourceStartFrame' | 'sourceFrameCount' | 'lengthBeats'>,
): AudioWarp {
  return {
    algorithm: 'wsola-v1',
    formantMode: 'preserve',
    timingEnabled: true,
    pitchEnabled: true,
    markers: [
      { sourceFrame: clip.sourceStartFrame, targetBeatOffset: 0 },
      {
        sourceFrame: clip.sourceStartFrame + clip.sourceFrameCount,
        targetBeatOffset: clip.lengthBeats,
      },
    ],
    pitchRegions: [],
  };
}

export type AudioWarpEditErrorCode =
  | 'invalid-marker'
  | 'marker-limit'
  | 'endpoint-marker'
  | 'invalid-pitch-region'
  | 'pitch-region-limit'
  | 'region-not-found';

export type AudioWarpEditResult = Readonly<
  | { ok: true; changed: boolean; audioWarp: AudioWarp }
  | { ok: false; error: Readonly<{ code: AudioWarpEditErrorCode; message: string }> }
>;

export type PartitionedAudioWarp = Readonly<{
  left: AudioWarp;
  right: AudioWarp;
}>;

export type AudioWarpTimingSegment = Readonly<{
  /** Index of the persisted marker that closes this segment. */
  markerIndex: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
  targetStartBeatOffset: number;
  targetEndBeatOffset: number;
  bpm: number;
}>;

export type AudioWarpTimingSegmentIssue =
  | 'source-segment-too-short'
  | 'target-segment-too-short'
  | 'stretch-out-of-range';

const fail = (code: AudioWarpEditErrorCode, message: string): AudioWarpEditResult => ({
  ok: false,
  error: { code, message },
});

function cloneWarp(warp: AudioWarp): AudioWarp {
  return {
    ...warp,
    markers: warp.markers.map((marker) => ({ ...marker })),
    pitchRegions: warp.pitchRegions.map((region) => ({ ...region })),
  };
}

export function audioWarpsEqual(left: AudioWarp, right: AudioWarp): boolean {
  return left.algorithm === right.algorithm
    && left.formantMode === right.formantMode
    && left.timingEnabled === right.timingEnabled
    && left.pitchEnabled === right.pitchEnabled
    && left.markers.length === right.markers.length
    && left.pitchRegions.length === right.pitchRegions.length
    && left.markers.every((marker, index) => {
      const other = right.markers[index];
      return marker.sourceFrame === other?.sourceFrame
        && marker.targetBeatOffset === other.targetBeatOffset;
    })
    && left.pitchRegions.every((region, index) => {
      const other = right.pitchRegions[index];
      return region.sourceStartFrame === other?.sourceStartFrame
        && region.sourceFrameCount === other.sourceFrameCount
        && region.sourcePitchCents === other.sourcePitchCents
        && region.targetPitchCents === other.targetPitchCents
        && region.correctionAmount === other.correctionAmount
        && region.transitionFrames === other.transitionFrames;
    });
}

function accepted(previous: AudioWarp, next: AudioWarp): AudioWarpEditResult {
  return audioWarpsEqual(previous, next)
    ? { ok: true, changed: false, audioWarp: previous }
    : { ok: true, changed: true, audioWarp: next };
}

function interpolate(
  markers: readonly AudioWarpMarker[],
  value: number,
  input: 'sourceFrame' | 'targetBeatOffset',
  output: 'sourceFrame' | 'targetBeatOffset',
): number {
  if (markers.length < 2 || !Number.isFinite(value)) return Number.NaN;
  if (value <= markers[0]![input]) return markers[0]![output];
  const last = markers[markers.length - 1]!;
  if (value >= last[input]) return last[output];
  let high = 1;
  while (markers[high]![input] < value) high += 1;
  const left = markers[high - 1]!;
  const right = markers[high]!;
  const fraction = (value - left[input]) / (right[input] - left[input]);
  return left[output] + fraction * (right[output] - left[output]);
}

/** Map an absolute source frame to a clip-local beat offset. */
export function sourceFrameToBeat(
  warp: Pick<AudioWarp, 'markers'>,
  sourceFrame: number,
): number {
  return interpolate(warp.markers, sourceFrame, 'sourceFrame', 'targetBeatOffset');
}

/** Invert a clip-local beat offset to an absolute (possibly fractional) source frame. */
export function beatToSourceFrame(
  warp: Pick<AudioWarp, 'markers'>,
  targetBeatOffset: number,
): number {
  return interpolate(warp.markers, targetBeatOffset, 'targetBeatOffset', 'sourceFrame');
}

/**
 * Split persisted timing-marker intervals at every tempo-map boundary.
 *
 * Audio Warp interpolation is linear in beat space while rendering is linear
 * in seconds. A tempo change therefore creates an implicit DSP segment even
 * when the user did not persist a marker there.
 */
export function* iterateAudioWarpTimingSegments(
  warp: Pick<AudioWarp, 'markers'>,
  clipStartBeat: number,
  tempoMap: readonly TempoMapEvent[],
): Generator<AudioWarpTimingSegment, void, undefined> {
  if (
    !Number.isFinite(clipStartBeat)
    || warp.markers.length < 2
    || tempoMap.length === 0
  ) return;

  let tempoIndex = 0;
  for (let markerIndex = 1; markerIndex < warp.markers.length; markerIndex += 1) {
    const left = warp.markers[markerIndex - 1]!;
    const right = warp.markers[markerIndex]!;
    if (
      !Number.isFinite(left.sourceFrame)
      || !Number.isFinite(right.sourceFrame)
      || !Number.isFinite(left.targetBeatOffset)
      || !Number.isFinite(right.targetBeatOffset)
      || right.sourceFrame <= left.sourceFrame
      || right.targetBeatOffset <= left.targetBeatOffset
    ) return;

    const absoluteStartBeat = clipStartBeat + left.targetBeatOffset;
    const absoluteEndBeat = clipStartBeat + right.targetBeatOffset;
    while (
      tempoIndex + 1 < tempoMap.length
      && tempoMap[tempoIndex + 1]!.beat <= absoluteStartBeat
    ) {
      tempoIndex += 1;
    }

    let segmentStartBeat = absoluteStartBeat;
    let segmentStartFrame = left.sourceFrame;
    while (segmentStartBeat < absoluteEndBeat) {
      const tempo = tempoMap[tempoIndex];
      if (
        tempo === undefined
        || !Number.isFinite(tempo.beat)
        || !Number.isFinite(tempo.bpm)
        || tempo.bpm <= 0
      ) return;
      const nextTempoBeat = tempoMap[tempoIndex + 1]?.beat
        ?? Number.POSITIVE_INFINITY;
      const segmentEndBeat = Math.min(absoluteEndBeat, nextTempoBeat);
      if (segmentEndBeat <= segmentStartBeat) return;
      const segmentEndFrame = segmentEndBeat === absoluteEndBeat
        ? right.sourceFrame
        : beatToSourceFrame(warp, segmentEndBeat - clipStartBeat);
      yield Object.freeze({
        markerIndex,
        sourceStartFrame: segmentStartFrame,
        sourceEndFrame: segmentEndFrame,
        targetStartBeatOffset: segmentStartBeat - clipStartBeat,
        targetEndBeatOffset: segmentEndBeat - clipStartBeat,
        bpm: tempo.bpm,
      });
      segmentStartBeat = segmentEndBeat;
      segmentStartFrame = segmentEndFrame;
      if (segmentEndBeat === nextTempoBeat) tempoIndex += 1;
    }
  }
}

/** Validate exact, pre-frame-rounding timing-segment limits. */
export function audioWarpTimingSegmentIssues(
  segment: AudioWarpTimingSegment,
  sourceSampleRate: number,
): readonly AudioWarpTimingSegmentIssue[] {
  const numericTolerance = 1e-12;
  const sourceSeconds =
    (segment.sourceEndFrame - segment.sourceStartFrame) / sourceSampleRate;
  const targetSeconds =
    (segment.targetEndBeatOffset - segment.targetStartBeatOffset) * 60 / segment.bpm;
  const stretch = targetSeconds / sourceSeconds;
  const issues: AudioWarpTimingSegmentIssue[] = [];
  if (
    !Number.isFinite(sourceSeconds)
    || sourceSeconds + numericTolerance < MIN_AUDIO_WARP_SEGMENT_SECONDS
  ) issues.push('source-segment-too-short');
  if (
    !Number.isFinite(targetSeconds)
    || targetSeconds + numericTolerance < MIN_AUDIO_WARP_SEGMENT_SECONDS
  ) issues.push('target-segment-too-short');
  if (
    !Number.isFinite(stretch)
    || stretch + numericTolerance < MIN_AUDIO_WARP_STRETCH
    || stretch - numericTolerance > MAX_AUDIO_WARP_STRETCH
  ) issues.push('stretch-out-of-range');
  return Object.freeze(issues);
}

function canonicalMarkers(markers: readonly AudioWarpMarker[]): readonly AudioWarpMarker[] {
  return [...markers]
    .map((marker) => ({ ...marker }))
    .sort((left, right) => left.sourceFrame - right.sourceFrame);
}

export function addAudioWarpTimingPoint(
  warp: AudioWarp,
  marker: AudioWarpMarker,
): AudioWarpEditResult {
  if (warp.markers.length >= MAX_AUDIO_WARP_MARKERS) {
    return fail('marker-limit', `Audio Warp supports at most ${MAX_AUDIO_WARP_MARKERS} markers.`);
  }
  if (!Number.isSafeInteger(marker.sourceFrame) || !Number.isFinite(marker.targetBeatOffset)) {
    return fail('invalid-marker', 'A timing point needs an integer source frame and finite beat.');
  }
  if (warp.markers.some((item) =>
    item.sourceFrame === marker.sourceFrame
    || item.targetBeatOffset === marker.targetBeatOffset
  )) {
    return fail('invalid-marker', 'A timing point cannot share a source frame or beat.');
  }
  return accepted(warp, { ...cloneWarp(warp), markers: canonicalMarkers([...warp.markers, marker]) });
}

export function moveAudioWarpTimingPoint(
  warp: AudioWarp,
  index: number,
  marker: AudioWarpMarker,
): AudioWarpEditResult {
  if (!Number.isInteger(index) || index <= 0 || index >= warp.markers.length - 1) {
    return fail('endpoint-marker', 'Source-window endpoint timing points cannot be moved.');
  }
  if (!Number.isSafeInteger(marker.sourceFrame) || !Number.isFinite(marker.targetBeatOffset)) {
    return fail('invalid-marker', 'A timing point needs an integer source frame and finite beat.');
  }
  const markers = warp.markers.map((item, itemIndex) =>
    itemIndex === index ? { ...marker } : { ...item },
  );
  if (
    markers[index - 1]!.sourceFrame >= marker.sourceFrame
    || marker.sourceFrame >= markers[index + 1]!.sourceFrame
    || markers[index - 1]!.targetBeatOffset >= marker.targetBeatOffset
    || marker.targetBeatOffset >= markers[index + 1]!.targetBeatOffset
  ) {
    return fail('invalid-marker', 'A timing point must stay between its neighbours.');
  }
  return accepted(warp, { ...cloneWarp(warp), markers });
}

export function removeAudioWarpTimingPoint(
  warp: AudioWarp,
  index: number,
): AudioWarpEditResult {
  if (!Number.isInteger(index) || index <= 0 || index >= warp.markers.length - 1) {
    return fail('endpoint-marker', 'Source-window endpoint timing points cannot be removed.');
  }
  return accepted(warp, {
    ...cloneWarp(warp),
    markers: warp.markers.filter((_, itemIndex) => itemIndex !== index).map((item) => ({ ...item })),
  });
}

/** Marker-named aliases for callers that expose the persisted terminology. */
export const addAudioWarpMarker = addAudioWarpTimingPoint;
export const moveAudioWarpMarker = moveAudioWarpTimingPoint;
export const removeAudioWarpMarker = removeAudioWarpTimingPoint;

export function resetAudioWarpTimingPoints(warp: AudioWarp): AudioWarpEditResult {
  return accepted(warp, {
    ...cloneWarp(warp),
    markers: [
      { ...warp.markers[0]! },
      { ...warp.markers[warp.markers.length - 1]! },
    ],
  });
}

function validPitchRegion(region: AudioPitchRegion): boolean {
  return Number.isSafeInteger(region.sourceStartFrame)
    && Number.isSafeInteger(region.sourceFrameCount)
    && region.sourceFrameCount > 0
    && Number.isFinite(region.sourcePitchCents)
    && Number.isFinite(region.targetPitchCents)
    && region.sourcePitchCents >= 0
    && region.sourcePitchCents <= 12_700
    && region.targetPitchCents >= 0
    && region.targetPitchCents <= 12_700
    && Number.isFinite(region.correctionAmount)
    && region.correctionAmount >= 0
    && region.correctionAmount <= 1
    && Math.abs(
      (region.targetPitchCents - region.sourcePitchCents) * region.correctionAmount,
    ) <= MAX_AUDIO_PITCH_SHIFT_CENTS
    && Number.isSafeInteger(region.transitionFrames)
    && region.transitionFrames >= 0
    && region.transitionFrames <= Math.floor(region.sourceFrameCount / 2);
}

function canonicalPitchRegions(
  regions: readonly AudioPitchRegion[],
): readonly AudioPitchRegion[] | null {
  if (regions.length > MAX_AUDIO_PITCH_REGIONS || regions.some((region) => !validPitchRegion(region))) {
    return null;
  }
  const canonical = [...regions]
    .map((region) => ({ ...region }))
    .sort((left, right) => left.sourceStartFrame - right.sourceStartFrame);
  for (let index = 1; index < canonical.length; index += 1) {
    const previous = canonical[index - 1]!;
    if (previous.sourceStartFrame + previous.sourceFrameCount > canonical[index]!.sourceStartFrame) {
      return null;
    }
  }
  return canonical;
}

export function replaceAudioPitchRegions(
  warp: AudioWarp,
  regions: readonly AudioPitchRegion[],
): AudioWarpEditResult {
  const canonical = canonicalPitchRegions(regions);
  if (canonical === null) {
    return fail(
      regions.length > MAX_AUDIO_PITCH_REGIONS ? 'pitch-region-limit' : 'invalid-pitch-region',
      'Pitch regions must be canonical, non-overlapping, and within the supported correction range.',
    );
  }
  return accepted(warp, { ...cloneWarp(warp), pitchRegions: canonical });
}

export function splitAudioPitchRegion(
  warp: AudioWarp,
  index: number,
  splitSourceFrame: number,
): AudioWarpEditResult {
  const region = warp.pitchRegions[index];
  if (!region) return fail('region-not-found', 'The pitch region does not exist.');
  const end = region.sourceStartFrame + region.sourceFrameCount;
  if (!Number.isSafeInteger(splitSourceFrame)
    || splitSourceFrame <= region.sourceStartFrame
    || splitSourceFrame >= end) {
    return fail('invalid-pitch-region', 'The split frame must be inside the pitch region.');
  }
  const leftCount = splitSourceFrame - region.sourceStartFrame;
  const rightCount = end - splitSourceFrame;
  return replaceAudioPitchRegions(warp, [
    ...warp.pitchRegions.slice(0, index),
    { ...region, sourceFrameCount: leftCount, transitionFrames: Math.min(region.transitionFrames, Math.floor(leftCount / 2)) },
    { ...region, sourceStartFrame: splitSourceFrame, sourceFrameCount: rightCount, transitionFrames: Math.min(region.transitionFrames, Math.floor(rightCount / 2)) },
    ...warp.pitchRegions.slice(index + 1),
  ]);
}

export function mergeAudioPitchRegions(warp: AudioWarp, index: number): AudioWarpEditResult {
  const left = warp.pitchRegions[index];
  const right = warp.pitchRegions[index + 1];
  if (!left || !right) return fail('region-not-found', 'Two adjacent pitch regions are required.');
  if (
    left.sourceStartFrame + left.sourceFrameCount !== right.sourceStartFrame
    || left.sourcePitchCents !== right.sourcePitchCents
    || left.targetPitchCents !== right.targetPitchCents
    || left.correctionAmount !== right.correctionAmount
  ) {
    return fail('invalid-pitch-region', 'Only contiguous pitch regions with matching settings can merge.');
  }
  const sourceFrameCount = left.sourceFrameCount + right.sourceFrameCount;
  return replaceAudioPitchRegions(warp, [
    ...warp.pitchRegions.slice(0, index),
    {
      ...left,
      sourceFrameCount,
      transitionFrames: Math.min(
        Math.max(left.transitionFrames, right.transitionFrames),
        Math.floor(sourceFrameCount / 2),
      ),
    },
    ...warp.pitchRegions.slice(index + 2),
  ]);
}

export function retargetAudioPitchRegion(
  warp: AudioWarp,
  index: number,
  targetPitchCents: number,
  correctionAmount = warp.pitchRegions[index]?.correctionAmount,
): AudioWarpEditResult {
  const region = warp.pitchRegions[index];
  if (!region) return fail('region-not-found', 'The pitch region does not exist.');
  if (correctionAmount === undefined) {
    return fail('invalid-pitch-region', 'A correction amount is required.');
  }
  return replaceAudioPitchRegions(warp, warp.pitchRegions.map((item, itemIndex) =>
    itemIndex === index ? { ...item, targetPitchCents, correctionAmount } : item,
  ));
}

export function resetAudioPitchRegions(warp: AudioWarp): AudioWarpEditResult {
  return accepted(warp, { ...cloneWarp(warp), pitchRegions: [] });
}

function cropRegion(
  region: AudioPitchRegion,
  sourceStartFrame: number,
  sourceEndFrame: number,
): AudioPitchRegion | null {
  const start = Math.max(region.sourceStartFrame, sourceStartFrame);
  const end = Math.min(region.sourceStartFrame + region.sourceFrameCount, sourceEndFrame);
  if (end <= start) return null;
  const sourceFrameCount = end - start;
  return {
    ...region,
    sourceStartFrame: start,
    sourceFrameCount,
    transitionFrames: Math.min(region.transitionFrames, Math.floor(sourceFrameCount / 2)),
  };
}

/** Crop to absolute source frames and rebase target beats to zero. */
export function cropAudioWarp(
  warp: AudioWarp,
  sourceStartFrame: number,
  sourceEndFrame: number,
): AudioWarp {
  const startBeat = sourceFrameToBeat(warp, sourceStartFrame);
  const endBeat = sourceFrameToBeat(warp, sourceEndFrame);
  const interior = warp.markers.filter((marker) =>
    marker.sourceFrame > sourceStartFrame && marker.sourceFrame < sourceEndFrame
  );
  return {
    ...cloneWarp(warp),
    markers: [
      { sourceFrame: sourceStartFrame, targetBeatOffset: 0 },
      ...interior.map((marker) => ({
        sourceFrame: marker.sourceFrame,
        targetBeatOffset: marker.targetBeatOffset - startBeat,
      })),
      { sourceFrame: sourceEndFrame, targetBeatOffset: endBeat - startBeat },
    ],
    pitchRegions: warp.pitchRegions.flatMap((region) => {
      const cropped = cropRegion(region, sourceStartFrame, sourceEndFrame);
      return cropped ? [cropped] : [];
    }),
  };
}

export function partitionAudioWarp(
  warp: AudioWarp,
  splitSourceFrame: number,
): PartitionedAudioWarp {
  const first = warp.markers[0]!;
  const last = warp.markers[warp.markers.length - 1]!;
  return {
    left: cropAudioWarp(warp, first.sourceFrame, splitSourceFrame),
    right: cropAudioWarp(warp, splitSourceFrame, last.sourceFrame),
  };
}
