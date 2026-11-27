// P23 acceptance tests (WAV render of the cutoff lane). Written BEFORE the implementation; do not edit.
//
// Contract (apps/studio, renderProjectToWav in src/audio/wav.ts):
// - A `track-filter-cutoff` lane on an instrument track is read exactly like volume / pan lanes
//   (same read gate, same command windows, same tempo-change splitting), but its values are octave
//   offsets: the render schedules `value * 1200` CENTS on the `detune` AudioParam of that track's
//   synth-voice lowpass BiquadFilterNode, including voices that start after a lane point.
//   `hold` points become `setValueAtTime`, `linear` points become linear ramps in time.
// - A lane whose points are all 0 renders byte-identical to no lane at all (a detune of 0 is a no-op).
// - Lane values never touch the track's volume or pan.
// See v12-helpers.ts for the recording OfflineAudioContext used here (no real audio under vitest).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateProject } from '@cts/project-model';
import { renderProjectToWav } from '../../src/audio/wav';
import {
  blobSha256,
  cutoffLane,
  installRecordingOfflineContext,
  melodyOnlyProject,
  trackNamed,
} from './v12-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SECONDS_PER_BEAT = 0.5; // 120 bpm
const MAX_OCTAVES = Math.log2(10);

async function render(project: Parameters<typeof renderProjectToWav>[0]) {
  const recording = installRecordingOfflineContext();
  const lease = await renderProjectToWav(project);
  const bytes = await blobSha256(lease.blob);
  lease.release();
  return { recording, bytes };
}

function lowpassFilters(recording: ReturnType<typeof installRecordingOfflineContext>) {
  return recording.filters().filter((filter) => filter.plain.get('type') === 'lowpass');
}

describe('P23 v12 WAV render', () => {
  it('render_cutoffLaneAllZero_isByteIdenticalToNoLane', async () => {
    const notes = [
      { pitch: 60, startBeat: 0, durationBeats: 1 },
      { pitch: 64, startBeat: 2, durationBeats: 1 },
    ];
    const none = await render(melodyOnlyProject(notes));
    // Positive control: the harness really distinguishes renders (a real cutoff change differs).
    const melody = (p: ReturnType<typeof melodyOnlyProject>) => trackNamed(p, 'Melody').id;
    const probe = melodyOnlyProject(notes);
    probe.automationLanes = [cutoffLane(melody(probe), [{ beat: 0, value: 1, interpolation: 'hold' }])];
    expect((await render(probe)).bytes).not.toEqual(none.bytes);

    const zero = melodyOnlyProject(notes);
    zero.automationLanes = [cutoffLane(melody(zero), [
      { beat: 0, value: 0, interpolation: 'hold' },
      { beat: 2, value: 0, interpolation: 'linear' },
      { beat: 4, value: 0, interpolation: 'hold' },
    ])];
    // The lane is a valid v12 lane (fails until the target type exists).
    expect(validateProject(zero).ok).toBe(true);
    const withZeroLane = await render(zero);
        expect(withZeroLane.bytes).toEqual(none.bytes);
    // The all-zero lane must not disturb the track's volume or pan either.
    expect(withZeroLane.recording.normalizedLog()).toEqual(none.recording.normalizedLog());
  });

  it('render_cutoffLane_appliesAsDetuneCents_1200PerOctave', async () => {
    const project = melodyOnlyProject([
      { pitch: 60, startBeat: 0, durationBeats: 1 }, // 0.0 .. 0.5 s: lane value +1 octave
      { pitch: 64, startBeat: 3, durationBeats: 0.5 }, // 1.5 .. 1.75 s: lane value -0.5 octave
    ]);
    project.automationLanes = [cutoffLane(trackNamed(project, 'Melody').id, [
      { beat: 0, value: 1, interpolation: 'hold' },
      { beat: 2, value: -0.5, interpolation: 'hold' },
    ])];
    expect(validateProject(project).ok).toBe(true);
    const { recording } = await render(project);
    const filters = lowpassFilters(recording);
    expect(filters).toHaveLength(2);
    const [first, second] = filters;
    expect(first!.detune.valueAt(0.25)).toBeCloseTo(1 * 1200, 6);
    expect(second!.detune.valueAt(3 * SECONDS_PER_BEAT + 0.05)).toBeCloseTo(-0.5 * 1200, 6);
  });

  it('render_cutoffLane_atPlusLog2Of10_isAbout3986Cents', async () => {
    const project = melodyOnlyProject([{ pitch: 60, startBeat: 0, durationBeats: 1 }]);
    project.automationLanes = [cutoffLane(trackNamed(project, 'Melody').id, [
      { beat: 0, value: MAX_OCTAVES, interpolation: 'hold' },
    ])];
    expect(validateProject(project).ok).toBe(true);
    const { recording } = await render(project);
    const [filter] = lowpassFilters(recording);
    expect(filter!.detune.valueAt(0.25)).toBeCloseTo(1200 * MAX_OCTAVES, 6);
  });

  it('render_cutoffLane_linearPoints_rampInOctavesOverTime', async () => {
    const project = melodyOnlyProject([{ pitch: 60, startBeat: 0, durationBeats: 4 }]);
    project.automationLanes = [cutoffLane(trackNamed(project, 'Melody').id, [
      { beat: 0, value: 0, interpolation: 'linear' },
      { beat: 4, value: 1, interpolation: 'hold' },
    ])];
    expect(validateProject(project).ok).toBe(true);
    const { recording } = await render(project);
    const [filter] = lowpassFilters(recording);
    // Beat 2 = 1.0 s is halfway: +0.5 octave = 600 cents (linear in the offset = log curve in Hz).
    expect(filter!.detune.valueAt(1.0)).toBeCloseTo(600, 6);
    expect(filter!.detune.valueAt(0.5)).toBeCloseTo(300, 6);
  });

  it('render_cutoffLane_leavesVolumeAndPanUntouched', async () => {
    const notes = [{ pitch: 60, startBeat: 0, durationBeats: 1 }];
    const none = await render(melodyOnlyProject(notes));
    const project = melodyOnlyProject(notes);
    project.automationLanes = [cutoffLane(trackNamed(project, 'Melody').id, [
      { beat: 0, value: 1, interpolation: 'hold' },
    ])];
    expect(validateProject(project).ok).toBe(true);
    const lane = (await render(project)).recording;
    const panAndGain = (log: string[]) => log.filter((line) => /\.(pan|gain)\./.test(line));
    expect(panAndGain(lane.normalizedLog())).toEqual(panAndGain(none.recording.normalizedLog()));
  });
});
