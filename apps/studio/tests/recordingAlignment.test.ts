import { describe, expect, it } from 'vitest';
import {
  compileMusicalTime,
  createEmptyProject,
  type MusicalTimeIndex,
} from '@cts/project-model';
import {
  planSynchronizedRecordingPlacement,
  type RecordingAlignmentErrorCode,
  type SynchronizedRecordingPlacementInput,
} from '../src/audio/recordingAlignment';

function constantTempo(): MusicalTimeIndex {
  return compileMusicalTime(createEmptyProject({ lengthBars: 4 }));
}

function variableTempo(): MusicalTimeIndex {
  const project = createEmptyProject({ lengthBars: 4 });
  project.tempoMap = [
    { ...project.tempoMap[0]!, beat: 0, bpm: 120 },
    { id: 'tempo-slow', beat: 4, bpm: 60 },
  ];
  return compileMusicalTime(project);
}

function placementInput(
  overrides: Partial<SynchronizedRecordingPlacementInput> = {},
): SynchronizedRecordingPlacementInput {
  return {
    musicalTime: constantTempo(),
    playbackAnchorBeat: 4,
    playbackAnchorFrame: 96_000,
    captureFirstFrame: 96_000,
    captureFrameCount: 48_000,
    captureSampleRate: 48_000,
    canonicalFrameCount: 48_000,
    canonicalSampleRate: 48_000,
    ...overrides,
  };
}

function expectFailure(
  input: SynchronizedRecordingPlacementInput,
  code: RecordingAlignmentErrorCode,
): void {
  const result = planSynchronizedRecordingPlacement(input);
  expect(result).toMatchObject({ ok: false, error: { code } });
}

describe('synchronized recording alignment', () => {
  it('places positive automatic and manual compensation earlier', () => {
    const result = planSynchronizedRecordingPlacement(placementInput({
      automaticEstimatedLatencySeconds: 0.1,
      manualOffsetMilliseconds: 20,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placement).toMatchObject({
      startBeat: 3.76,
      sourceStartFrame: 0,
      sourceFrameCount: 48_000,
      captureStartOffsetSeconds: 0,
      uncompensatedStartSeconds: 2,
      compensatedStartSeconds: 1.88,
      placedStartSeconds: 1.88,
      clampedAtProjectStart: false,
    });
    expect(result.placement.latencyCompensationSeconds).toBeCloseTo(0.12, 12);
  });

  it('includes the shared-clock capture offset and lets a negative manual value place later', () => {
    const result = planSynchronizedRecordingPlacement(placementInput({
      captureFirstFrame: 96_480,
      automaticEstimatedLatencySeconds: 0.05,
      manualOffsetMilliseconds: -100,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placement.captureStartOffsetSeconds).toBeCloseTo(0.01, 12);
    expect(result.placement.latencyCompensationSeconds).toBeCloseTo(-0.05, 12);
    expect(result.placement.compensatedStartSeconds).toBeCloseTo(2.06, 12);
    expect(result.placement.startBeat).toBe(4.12);
    expect(result.placement.sourceStartFrame).toBe(0);
  });

  it('maps the compensated time through variable tempo instead of using one BPM', () => {
    const result = planSynchronizedRecordingPlacement(placementInput({
      musicalTime: variableTempo(),
      playbackAnchorBeat: 4.5,
      playbackAnchorFrame: 120_000,
      captureFirstFrame: 120_000,
      automaticEstimatedLatencySeconds: 0.75,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Beat 4.5 is 2.5 s; 1.75 s maps back to beat 3.5 before the tempo change.
    expect(result.placement).toMatchObject({
      startBeat: 3.5,
      compensatedStartSeconds: 1.75,
      clampedAtProjectStart: false,
    });
  });

  it('clamps at beat zero and trims at the canonical rather than capture sample rate', () => {
    const result = planSynchronizedRecordingPlacement(placementInput({
      playbackAnchorBeat: 0,
      playbackAnchorFrame: 100_000,
      captureFirstFrame: 100_441,
      captureSampleRate: 44_100,
      canonicalFrameCount: 9_600,
      canonicalSampleRate: 48_000,
      automaticEstimatedLatencySeconds: 0.11,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placement.captureStartOffsetSeconds).toBeCloseTo(0.01, 12);
    expect(result.placement.compensatedStartSeconds).toBeCloseTo(-0.1, 12);
    expect(result.placement).toMatchObject({
      startBeat: 0,
      sourceStartFrame: 4_800,
      sourceFrameCount: 4_800,
      placedStartSeconds: 0,
      clampedAtProjectStart: true,
    });
  });

  it('uses a deterministic ceil so a fractional pre-zero frame is never retained', () => {
    const result = planSynchronizedRecordingPlacement(placementInput({
      playbackAnchorBeat: 0,
      playbackAnchorFrame: 0,
      captureFirstFrame: 0,
      automaticEstimatedLatencySeconds: 0.5 / 48_000,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placement.sourceStartFrame).toBe(1);
    expect(result.placement.sourceFrameCount).toBe(47_999);
  });

  it('returns a typed failure when project-start compensation removes the whole take', () => {
    expectFailure(placementInput({
      playbackAnchorBeat: 0,
      playbackAnchorFrame: 0,
      captureFirstFrame: 0,
      canonicalFrameCount: 4_800,
      automaticEstimatedLatencySeconds: 0.1,
    }), 'all-frames-trimmed');
  });

  it('rejects invalid clocks, ranges, rates, latency and musical time without throwing', () => {
    expectFailure(placementInput({ playbackAnchorBeat: 17 }), 'invalid-anchor');
    expectFailure(placementInput({ playbackAnchorFrame: -1 }), 'invalid-anchor');
    expectFailure(placementInput({ captureFrameCount: 0 }), 'invalid-capture-range');
    expectFailure(placementInput({
      captureFirstFrame: Number.MAX_SAFE_INTEGER,
      captureFrameCount: 1,
    }), 'invalid-capture-range');
    expectFailure(placementInput({ captureSampleRate: 0 }), 'invalid-sample-rate');
    expectFailure(placementInput({ canonicalSampleRate: 48_000.5 }), 'invalid-sample-rate');
    expectFailure(placementInput({ canonicalFrameCount: 0 }), 'invalid-canonical-range');
    expectFailure(placementInput({ automaticEstimatedLatencySeconds: -0.1 }), 'invalid-latency');
    expectFailure(placementInput({ manualOffsetMilliseconds: Number.NaN }), 'invalid-latency');
    expectFailure(placementInput({
      musicalTime: {
        tempoSegments: [],
        timeSignatureSegments: [],
        lengthBeats: 16,
      },
    }), 'invalid-musical-time');
  });
});
