import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '@cts/project-model';
import {
  drumClipBarCount,
  findDrumClip,
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
    const visibleStepIndexes = Array.from(
      { length: drumClipBarCount(4.25, 4) * stepsPerBar },
      (_, stepIndex) => stepIndex,
    );

    expect(drumClipBarCount(4, 4)).toBe(1);
    expect(drumClipBarCount(4.25, 4)).toBe(2);
    expect(visibleStepIndexes).toContain(firstStepInSecondBar);
    expect(isDrumStepWithinClip(16, stepsPerBar, 4, 4.25)).toBe(true);
    expect(isDrumStepWithinClip(17, stepsPerBar, 4, 4.25)).toBe(false);
    expect(lastDrumStepInBar(0, stepsPerBar, 4, 4.25)).toBe(15);
    expect(lastDrumStepInBar(1, stepsPerBar, 4, 4.25)).toBe(0);
  });
});
