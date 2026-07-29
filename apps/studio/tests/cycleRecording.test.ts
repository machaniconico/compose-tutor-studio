import { describe, expect, it } from 'vitest';
import {
  MAX_AUDIO_TAKES_PER_FOLDER,
  compileMusicalTime,
  createEmptyProject,
} from '@cts/project-model';
import {
  MAX_CYCLE_RECORDING_SECONDS,
  MIN_CYCLE_RECORDING_SECONDS,
  planCycleRecording,
} from '../src/audio/cycleRecording';

const clock = () => new Date('2026-07-29T00:00:00.000Z');

function musicalTime() {
  return compileMusicalTime(createEmptyProject({ clock }));
}

describe('planCycleRecording', () => {
  it('plans fixed-tempo half-open pass windows with a positive latency tail', () => {
    const result = planCycleRecording({
      musicalTime: musicalTime(),
      loopStartBeat: 4,
      loopEndBeat: 8,
      passCount: 3,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0.01,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({
      loopDurationSeconds: 2,
      latencyCompensationFrames: 480,
      cycleFrameCount: 288_000,
      effectiveCaptureFrameCount: 288_480,
      passBoundariesFrames: [0, 96_000, 192_000, 288_000],
    });
    expect(result.plan.passes).toEqual([
      expect.objectContaining({
        passIndex: 0,
        cycleStartFrame: 0,
        cycleEndFrameExclusive: 96_000,
        captureSourceStartFrame: 480,
        captureSourceEndFrameExclusive: 96_480,
        captureSourceFrameCount: 96_000,
        leadingSilenceFrames: 0,
        outputFrameCount: 96_000,
      }),
      expect.objectContaining({
        passIndex: 1,
        captureSourceStartFrame: 96_480,
        captureSourceEndFrameExclusive: 192_480,
      }),
      expect.objectContaining({
        passIndex: 2,
        captureSourceStartFrame: 192_480,
        captureSourceEndFrameExclusive: 288_480,
      }),
    ]);
    expect(result.plan.passes[0]!.captureSourceEndFrameExclusive)
      .toBe(result.plan.passes[1]!.captureSourceStartFrame);
  });

  it('uses cumulative rounding across a variable-tempo loop without drift', () => {
    const project = createEmptyProject({ clock });
    project.tempoMap.push({ id: 'cycle-variable-tempo', beat: 5, bpm: 137 });
    const result = planCycleRecording({
      musicalTime: compileMusicalTime(project),
      loopStartBeat: 4,
      loopEndBeat: 6,
      passCount: 5,
      sampleRate: 44_100,
      latencyCompensationSeconds: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const exactFrames = result.plan.loopDurationSeconds * 44_100;
    expect(result.plan.passBoundariesFrames).toEqual(
      Array.from({ length: 6 }, (_, index) => Math.round(exactFrames * index)),
    );
    expect(result.plan.cycleFrameCount).toBe(Math.round(exactFrames * 5));
    expect(result.plan.passes.reduce(
      (total, pass) => total + pass.outputFrameCount,
      0,
    )).toBe(result.plan.cycleFrameCount);
    expect(new Set(result.plan.passes.map((pass) => pass.outputFrameCount)).size)
      .toBeLessThanOrEqual(2);
  });

  it('pads negative compensation with silence without borrowing an adjacent pass', () => {
    const result = planCycleRecording({
      musicalTime: musicalTime(),
      loopStartBeat: 0,
      loopEndBeat: 1,
      passCount: 2,
      sampleRate: 48_000,
      latencyCompensationSeconds: -0.025,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.latencyCompensationFrames).toBe(-1_200);
    expect(result.plan.effectiveCaptureFrameCount).toBe(48_000);
    expect(result.plan.passes).toEqual([
      expect.objectContaining({
        captureSourceStartFrame: 0,
        captureSourceEndFrameExclusive: 22_800,
        captureSourceFrameCount: 22_800,
        leadingSilenceFrames: 1_200,
        outputFrameCount: 24_000,
      }),
      expect.objectContaining({
        captureSourceStartFrame: 24_000,
        captureSourceEndFrameExclusive: 46_800,
        captureSourceFrameCount: 22_800,
        leadingSilenceFrames: 1_200,
        outputFrameCount: 24_000,
      }),
    ]);
    expect(result.plan.passes[0]!.captureSourceEndFrameExclusive)
      .toBeLessThan(result.plan.passes[1]!.captureSourceStartFrame);
  });

  it('accepts the inclusive 60-second capture boundary and rejects a positive tail over it', () => {
    const project = createEmptyProject({ clock, bpm: 120 });
    const index = compileMusicalTime(project);
    const exact = planCycleRecording({
      musicalTime: index,
      loopStartBeat: 0,
      loopEndBeat: 30,
      passCount: 4,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0,
    });
    expect(exact.ok && exact.plan.effectiveCaptureFrameCount)
      .toBe(MAX_CYCLE_RECORDING_SECONDS * 48_000);

    const over = planCycleRecording({
      musicalTime: index,
      loopStartBeat: 0,
      loopEndBeat: 30,
      passCount: 4,
      sampleRate: 48_000,
      latencyCompensationSeconds: 1 / 48_000,
    });
    expect(over).toMatchObject({ ok: false, error: { code: 'duration-limit' } });
  });

  it('matches the microphone settle boundary at an inclusive half second', () => {
    const base = {
      musicalTime: musicalTime(),
      loopStartBeat: 0,
      passCount: 2,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0,
    };
    const exact = planCycleRecording({ ...base, loopEndBeat: 0.5 });
    expect(exact.ok && exact.plan.effectiveCaptureFrameCount)
      .toBe(MIN_CYCLE_RECORDING_SECONDS * 48_000);

    const short = planCycleRecording({ ...base, loopEndBeat: 0.499 });
    expect(short).toMatchObject({
      ok: false,
      error: { code: 'duration-limit' },
    });
  });

  it('enforces pass limits and rejects invalid loops, rates, latency, and empty sources', () => {
    const base = {
      musicalTime: musicalTime(),
      loopStartBeat: 0,
      loopEndBeat: 4,
      passCount: 2,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0,
    };
    const cases = [
      [{ ...base, passCount: 1 }, 'invalid-pass-count'],
      [{ ...base, passCount: MAX_AUDIO_TAKES_PER_FOLDER + 1 }, 'invalid-pass-count'],
      [{ ...base, loopEndBeat: 0 }, 'invalid-loop'],
      [{ ...base, loopStartBeat: -1 }, 'invalid-loop'],
      [{ ...base, loopEndBeat: base.musicalTime.lengthBeats + 1 }, 'invalid-loop'],
      [{ ...base, sampleRate: 0 }, 'invalid-sample-rate'],
      [{ ...base, sampleRate: 192_001 }, 'invalid-sample-rate'],
      [{ ...base, latencyCompensationSeconds: Number.NaN }, 'invalid-latency'],
      [{ ...base, latencyCompensationSeconds: -2 }, 'invalid-latency'],
    ] as const;

    for (const [input, code] of cases) {
      expect(planCycleRecording(input)).toMatchObject({
        ok: false,
        error: { code },
      });
    }
  });

  it('is deterministic and does not mutate the musical-time input', () => {
    const index = musicalTime();
    const before = structuredClone(index);
    const input = {
      musicalTime: index,
      loopStartBeat: 2,
      loopEndBeat: 6,
      passCount: 3,
      sampleRate: 48_000,
      latencyCompensationSeconds: 0.007,
    };

    expect(planCycleRecording(input)).toEqual(planCycleRecording(input));
    expect(index).toEqual(before);
  });
});
