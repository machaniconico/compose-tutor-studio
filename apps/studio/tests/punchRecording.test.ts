import { describe, expect, it } from 'vitest';
import {
  compileMusicalTime,
  createEmptyProject,
  secondsBetweenBeats,
} from '@cts/project-model';
import {
  MAX_PUNCH_RECORDING_SECONDS,
  MIN_PUNCH_RECORDING_SECONDS,
  extractPunchRecording,
  planPunchRecording,
  type PunchRecordingPlan,
} from '../src/audio/punchRecording';

const clock = () => new Date('2026-07-29T00:00:00.000Z');

function musicalTime() {
  return compileMusicalTime(createEmptyProject({ clock }));
}

describe('planPunchRecording', () => {
  it('plans fixed-tempo pre-roll, punch, post-roll, and a positive latency tail', () => {
    const result = planPunchRecording({
      musicalTime: musicalTime(),
      playbackStartBeat: 2,
      punchInBeat: 4,
      punchOutBeat: 8,
      playbackEndBeat: 10,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0.01,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({
      punchDurationSeconds: 2,
      playbackDurationSeconds: 4,
      captureStartOffsetFrames: 48_000,
      punchEndOffsetFrames: 144_000,
      playbackEndOffsetFrames: 192_000,
      punchFrameCount: 96_000,
      outputFrameCount: 96_000,
      latencyFrames: 480,
      captureSourceStartFrame: 480,
      captureSourceEndFrameExclusive: 96_480,
      captureSourceFrameCount: 96_000,
      leadingSilenceFrames: 0,
      effectiveCaptureFrameCount: 96_480,
    });
  });

  it('rounds variable-tempo boundaries cumulatively from one playback anchor', () => {
    const project = createEmptyProject({ clock });
    project.tempoMap.push({ id: 'punch-variable-tempo', beat: 5, bpm: 137 });
    const index = compileMusicalTime(project);
    const result = planPunchRecording({
      musicalTime: index,
      playbackStartBeat: 4,
      punchInBeat: 4.5,
      punchOutBeat: 6,
      playbackEndBeat: 7,
      sampleRate: 44_100,
      latencyCompensationSeconds: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const punchInBoundary = Math.round(
      secondsBetweenBeats(index, 4, 4.5) * 44_100,
    );
    const punchOutBoundary = Math.round(
      secondsBetweenBeats(index, 4, 6) * 44_100,
    );
    const playbackEndBoundary = Math.round(
      secondsBetweenBeats(index, 4, 7) * 44_100,
    );
    expect(result.plan).toMatchObject({
      captureStartOffsetFrames: punchInBoundary,
      punchEndOffsetFrames: punchOutBoundary,
      playbackEndOffsetFrames: playbackEndBoundary,
      punchFrameCount: punchOutBoundary - punchInBoundary,
      outputFrameCount: punchOutBoundary - punchInBoundary,
    });
  });

  it('pads negative compensation without reading before the punch capture', () => {
    const result = planPunchRecording({
      musicalTime: musicalTime(),
      playbackStartBeat: 0,
      punchInBeat: 2,
      punchOutBeat: 6,
      playbackEndBeat: 8,
      sampleRate: 48_000,
      latencyCompensationSeconds: -0.025,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({
      latencyFrames: -1_200,
      punchFrameCount: 96_000,
      outputFrameCount: 96_000,
      captureSourceStartFrame: 0,
      captureSourceEndFrameExclusive: 94_800,
      captureSourceFrameCount: 94_800,
      leadingSilenceFrames: 1_200,
      effectiveCaptureFrameCount: 96_000,
    });
  });

  it('accepts zero-length pre-roll and post-roll while keeping a non-empty punch', () => {
    const result = planPunchRecording({
      musicalTime: musicalTime(),
      playbackStartBeat: 4,
      punchInBeat: 4,
      punchOutBeat: 8,
      playbackEndBeat: 8,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.captureStartOffsetFrames).toBe(0);
    expect(result.plan.punchEndOffsetFrames)
      .toBe(result.plan.playbackEndOffsetFrames);
  });

  it('enforces the inclusive half-second and 60-second capture boundaries', () => {
    const index = compileMusicalTime(createEmptyProject({ clock, lengthBars: 32 }));
    const base = {
      musicalTime: index,
      playbackStartBeat: 0,
      punchInBeat: 0,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0,
    };
    const minimum = planPunchRecording({
      ...base,
      punchOutBeat: 1,
      playbackEndBeat: 1,
    });
    expect(minimum.ok && minimum.plan.effectiveCaptureFrameCount)
      .toBe(MIN_PUNCH_RECORDING_SECONDS * 48_000);

    const tooShort = planPunchRecording({
      ...base,
      punchOutBeat: 0.998,
      playbackEndBeat: 0.998,
    });
    expect(tooShort).toMatchObject({
      ok: false,
      error: { code: 'duration-limit' },
    });

    const maximum = planPunchRecording({
      ...base,
      punchOutBeat: 120,
      playbackEndBeat: 120,
    });
    expect(maximum.ok && maximum.plan.effectiveCaptureFrameCount)
      .toBe(MAX_PUNCH_RECORDING_SECONDS * 48_000);

    const positiveTailOverMaximum = planPunchRecording({
      ...base,
      punchOutBeat: 120,
      playbackEndBeat: 120,
      latencyCompensationSeconds: 1 / 48_000,
    });
    expect(positiveTailOverMaximum).toMatchObject({
      ok: false,
      error: { code: 'duration-limit' },
    });
  });

  it('returns distinct typed failures for range, ordering, project bounds, rate, and latency', () => {
    const index = musicalTime();
    const base = {
      musicalTime: index,
      playbackStartBeat: 0,
      punchInBeat: 2,
      punchOutBeat: 6,
      playbackEndBeat: 8,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0,
    };
    const cases = [
      [{ ...base, punchInBeat: Number.NaN }, 'invalid-range'],
      [{ ...base, playbackStartBeat: -1 }, 'project-bounds'],
      [{ ...base, playbackEndBeat: index.lengthBeats + 1 }, 'project-bounds'],
      [{ ...base, playbackStartBeat: 3 }, 'invalid-order'],
      [{ ...base, punchOutBeat: 2 }, 'invalid-order'],
      [{ ...base, playbackEndBeat: 5 }, 'invalid-order'],
      [{ ...base, sampleRate: 0 }, 'invalid-sample-rate'],
      [{ ...base, sampleRate: 192_001 }, 'invalid-sample-rate'],
      [{ ...base, latencyCompensationSeconds: Number.NaN }, 'invalid-latency'],
      [{ ...base, latencyCompensationSeconds: -3 }, 'invalid-latency'],
      [{ ...base, latencyCompensationSeconds: Number.MAX_VALUE }, 'invalid-latency'],
    ] as const;

    for (const [input, code] of cases) {
      expect(planPunchRecording(input)).toMatchObject({
        ok: false,
        error: { code },
      });
    }

    expect(planPunchRecording({
      ...base,
      musicalTime: { ...index, tempoSegments: [] },
    })).toMatchObject({
      ok: false,
      error: { code: 'invalid-musical-time' },
    });
  });

  it('is deterministic and does not mutate the compiled musical-time map', () => {
    const index = musicalTime();
    const before = structuredClone(index);
    const input = {
      musicalTime: index,
      playbackStartBeat: 1,
      punchInBeat: 2,
      punchOutBeat: 5,
      playbackEndBeat: 7,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0.007,
    };

    expect(planPunchRecording(input)).toEqual(planPunchRecording(input));
    expect(index).toEqual(before);
  });
});

describe('extractPunchRecording', () => {
  function planned(latencyCompensationSeconds: number): PunchRecordingPlan {
    const result = planPunchRecording({
      musicalTime: musicalTime(),
      playbackStartBeat: 0,
      punchInBeat: 0,
      punchOutBeat: 1,
      playbackEndBeat: 1,
      sampleRate: 8_000,
      latencyCompensationSeconds,
    });
    if (!result.ok) throw new Error(result.error.code);
    return result.plan;
  }

  it('copies the later source window for positive latency into exact-length output', () => {
    const plan = planned(2 / 8_000);
    const capture = Float32Array.from(
      { length: plan.effectiveCaptureFrameCount },
      (_, index) => index,
    );
    const before = capture.slice();
    const result = extractPunchRecording(plan, [capture]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toMatchObject({
      frameCount: 4_000,
      sampleRate: 8_000,
      durationSeconds: 0.5,
    });
    expect(result.output.channels[0]).not.toBe(capture);
    expect(result.output.channels[0]?.[0]).toBe(2);
    expect(result.output.channels[0]?.at(-1)).toBe(4_001);
    expect(capture).toEqual(before);
  });

  it('prepends silence and copies only retained source for negative latency', () => {
    const plan = planned(-2 / 8_000);
    const left = Float32Array.from(
      { length: plan.effectiveCaptureFrameCount },
      (_, index) => index + 1,
    );
    const right = Float32Array.from(
      { length: plan.effectiveCaptureFrameCount },
      (_, index) => -(index + 1),
    );
    const result = extractPunchRecording(plan, [left, right]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.channels).toHaveLength(2);
    expect(Array.from(result.output.channels[0]!.slice(0, 4)))
      .toEqual([0, 0, 1, 2]);
    expect(result.output.channels[0]?.at(-1)).toBe(3_998);
    expect(Array.from(result.output.channels[1]!.slice(0, 4)))
      .toEqual([0, 0, -1, -2]);
  });

  it('rejects missing, short, long, or inconsistent capture data', () => {
    const plan = planned(0);
    expect(extractPunchRecording(plan, [])).toMatchObject({
      ok: false,
      error: { code: 'invalid-capture' },
    });
    expect(extractPunchRecording(
      plan,
      [new Float32Array(plan.effectiveCaptureFrameCount - 1)],
    )).toMatchObject({
      ok: false,
      error: { code: 'invalid-capture' },
    });
    expect(extractPunchRecording(
      plan,
      [new Float32Array(plan.effectiveCaptureFrameCount + 1)],
    )).toMatchObject({
      ok: false,
      error: { code: 'invalid-capture' },
    });
    expect(extractPunchRecording(
      { ...plan, outputFrameCount: plan.outputFrameCount - 1 },
      [new Float32Array(plan.effectiveCaptureFrameCount)],
    )).toMatchObject({
      ok: false,
      error: { code: 'invalid-plan' },
    });
  });
});
