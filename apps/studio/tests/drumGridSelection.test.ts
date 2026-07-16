import { describe, expect, it } from 'vitest';
import { compileMusicalTime, type Clip, type Track } from '@cts/project-model';
import {
  drumClipBarCount,
  drumClipBarLayouts,
  findDrumClip,
  isDrumBeatStart,
  isDrumStepWithinClip,
  lastDrumStepInBar,
} from '../src/features/drums/DrumGrid';

function drumClip(id: string): Clip {
  return {
    id,
    trackId: `track-${id}`,
    type: 'drum',
    startBeat: 0,
    lengthBeats: 4,
    loop: false,
    stepsPerBar: 16,
    drumEvents: [],
  };
}

function drumTrack(id: string, clip: Clip): Track {
  return {
    id: `track-${id}`,
    name: id,
    type: 'drum',
    role: 'general',
    clips: [{ ...clip, trackId: `track-${id}` }],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
}

describe('findDrumClip', () => {
  it('finds the selected clip across all drum tracks before using a fallback', () => {
    const first = drumClip('default');
    const selected = drumClip('imported');
    const tracks = [drumTrack('default', first), drumTrack('imported', selected)];

    expect(findDrumClip(tracks, 'imported')?.id).toBe('imported');
  });

  it('uses the first drum clip only when the selected id is absent', () => {
    const first = drumClip('default');
    const second = drumClip('imported');
    const tracks = [drumTrack('default', first), drumTrack('imported', second)];

    expect(findDrumClip(tracks, 'missing')?.id).toBe('default');
    expect(findDrumClip(tracks, null)?.id).toBe('default');
  });
});

describe('drumClipBarCount', () => {
  it('keeps the first step of a partial second bar reachable in the grid', () => {
    const stepsPerBar = 16;
    const firstStepInSecondBar = 16;
    const musicalTime = compileMusicalTime({
      lengthBeats: 8,
      tempoMap: [{ id: 'tempo', beat: 0, bpm: 120 }],
      timeSignatureMap: [{ id: 'signature', beat: 0, numerator: 4, denominator: 4 }],
    });
    const barLayouts = drumClipBarLayouts(0, 4.25, musicalTime);
    const visibleStepIndexes = Array.from(
      { length: drumClipBarCount(0, 4.25, musicalTime) * stepsPerBar },
      (_, stepIndex) => stepIndex,
    );

    expect(drumClipBarCount(0, 4, musicalTime)).toBe(1);
    expect(drumClipBarCount(0, 4.25, musicalTime)).toBe(2);
    expect(visibleStepIndexes).toContain(firstStepInSecondBar);
    expect(isDrumStepWithinClip(16, stepsPerBar, barLayouts, 4.25)).toBe(true);
    expect(isDrumStepWithinClip(17, stepsPerBar, barLayouts, 4.25)).toBe(false);
    expect(lastDrumStepInBar(0, stepsPerBar, barLayouts, 4.25)).toBe(15);
    expect(lastDrumStepInBar(1, stepsPerBar, barLayouts, 4.25)).toBe(0);
    expect(
      Array.from({ length: stepsPerBar }, (_, step) => step)
        .filter((step) => isDrumBeatStart(step, stepsPerBar, 4)),
    ).toEqual([0, 4, 8, 12]);
  });

  it('uses the signature active at each clip-local bar start', () => {
    const stepsPerBar = 16;
    const musicalTime = compileMusicalTime({
      lengthBeats: 13,
      tempoMap: [{ id: 'tempo', beat: 0, bpm: 120 }],
      timeSignatureMap: [
        { id: 'signature-four-four', beat: 0, numerator: 4, denominator: 4 },
        { id: 'signature-three-four', beat: 4, numerator: 3, denominator: 4 },
      ],
    });
    const barLayouts = drumClipBarLayouts(2, 7.25, musicalTime);

    expect(barLayouts.map(({ startBeatInClip, beatsInBar }) => [startBeatInClip, beatsInBar]))
      .toEqual([[0, 4], [4, 3], [7, 3]]);
    expect(drumClipBarCount(2, 7.25, musicalTime)).toBe(3);
    expect(isDrumStepWithinClip(31, stepsPerBar, barLayouts, 7.25)).toBe(true);
    expect(isDrumStepWithinClip(32, stepsPerBar, barLayouts, 7.25)).toBe(true);
    expect(isDrumStepWithinClip(33, stepsPerBar, barLayouts, 7.25)).toBe(true);
    expect(isDrumStepWithinClip(34, stepsPerBar, barLayouts, 7.25)).toBe(false);
    expect(lastDrumStepInBar(2, stepsPerBar, barLayouts, 7.25)).toBe(1);
    expect(
      Array.from({ length: stepsPerBar }, (_, step) => step)
        .filter((step) => isDrumBeatStart(step, stepsPerBar, 3)),
    ).toEqual([0, 5, 11]);
  });
});
