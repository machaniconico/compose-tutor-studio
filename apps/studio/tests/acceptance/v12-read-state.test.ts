// P23 acceptance tests (automation Read state for the cutoff lane). Written BEFORE the implementation; do not edit.
//
// Contract (apps/studio, src/audio/automation.ts + renderProjectToWav):
// - `isAutomationReadEnabled(readState, lane)` already gates every lane type; a cutoff lane on a track
//   in `disabledTrackIds`, a bypassed cutoff lane, or `globalEnabled: false` is ignored: the render
//   schedules no non-zero detune and is byte-identical to the render without the lane.
// - `automationBaseValue(track, { type: 'track-filter-cutoff', ... })` is 0 (no offset), never the
//   track's pan; `automationCommandsInWindow` of a bypassed cutoff lane is [].
// - Positive control: the same lane with the gate open does reach the filter (+1 octave = 1200 cents).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateProject, type Project } from '@cts/project-model';
import {
  automationBaseValue,
  automationCommandsInWindow,
  isAutomationReadEnabled,
} from '../../src/audio/automation';
import { renderProjectToWav } from '../../src/audio/wav';
import {
  blobSha256,
  CUTOFF_TYPE,
  cutoffLane,
  installRecordingOfflineContext,
  melodyOnlyProject,
  trackNamed,
} from './v12-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOTES = [{ pitch: 60, startBeat: 0, durationBeats: 1 }];

function cutoffProject(): Project {
  const project = melodyOnlyProject(NOTES);
  project.automationLanes = [cutoffLane(trackNamed(project, 'Melody').id, [
    { beat: 0, value: 1, interpolation: 'hold' },
  ])];
  return project;
}

async function render(project: Project) {
  const recording = installRecordingOfflineContext();
  const lease = await renderProjectToWav(project);
  const bytes = await blobSha256(lease.blob);
  lease.release();
  const filters = recording.filters().filter((filter) => filter.plain.get('type') === 'lowpass');
  return { bytes, detuneAt: (time: number) => filters.map((filter) => filter.detune.valueAt(time)) };
}

describe('P23 v12 automation Read state', () => {
  it('readState_trackDisabledOrBypassed_cutoffLaneIgnored', async () => {
    const baseline = await render(melodyOnlyProject(NOTES));

    // Positive control: with the gate open the lane reaches the filter.
    const open = cutoffProject();
    expect(validateProject(open).ok).toBe(true);
    expect((await render(open)).detuneAt(0.25)).toEqual([1200]);

    const disabled = cutoffProject();
    disabled.automationReadState = {
      globalEnabled: true,
      disabledTrackIds: [trackNamed(disabled, 'Melody').id],
    };
    const bypassed = cutoffProject();
    bypassed.automationLanes[0]!.bypassed = true;
    const globalOff = cutoffProject();
    globalOff.automationReadState = { globalEnabled: false, disabledTrackIds: [] };

    for (const [label, project] of [
      ['track Read disabled', disabled],
      ['lane bypassed', bypassed],
      ['global Read off', globalOff],
    ] as const) {
      expect(validateProject(project).ok, label).toBe(true);
      const result = await render(project);
      expect(result.detuneAt(0.25), label).toEqual([0]);
      expect(result.bytes, label).toEqual(baseline.bytes);
    }
  });

  it('isAutomationReadEnabled_cutoffLane_followsTheSameGates', () => {
    const lane = cutoffLane('t', [{ beat: 0, value: 1, interpolation: 'hold' }]);
    expect(lane.target.type).toBe(CUTOFF_TYPE);
    expect(isAutomationReadEnabled({ globalEnabled: true, disabledTrackIds: [] }, lane)).toBe(true);
    expect(isAutomationReadEnabled({ globalEnabled: true, disabledTrackIds: ['t'] }, lane)).toBe(false);
    expect(isAutomationReadEnabled({ globalEnabled: false, disabledTrackIds: [] }, lane)).toBe(false);
    expect(
      isAutomationReadEnabled(
        { globalEnabled: true, disabledTrackIds: [] },
        { ...lane, bypassed: true },
      ),
    ).toBe(false);
  });

  it('automationBaseValue_cutoffTarget_isZeroOctaveOffset', () => {
    const project = melodyOnlyProject(NOTES);
    const melody = trackNamed(project, 'Melody');
    melody.pan = 0.7;
    melody.volume = 1.5;
    expect(automationBaseValue(melody, { type: CUTOFF_TYPE, trackId: melody.id })).toBe(0);
  });

  it('automationCommandsInWindow_bypassedCutoffLane_isEmpty', () => {
    const lane = cutoffLane('t', [{ beat: 1, value: 1, interpolation: 'linear' }], { bypassed: true });
    expect(automationCommandsInWindow(lane, 0, 0, 4)).toEqual([]);
    const live = cutoffLane('t', [{ beat: 1, value: 1, interpolation: 'linear' }]);
    expect(automationCommandsInWindow(live, 0, 0, 4)[0]).toMatchObject({ beat: 0, value: 0 });
  });
});
