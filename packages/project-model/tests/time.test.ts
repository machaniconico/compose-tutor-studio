import { describe, it, expect } from 'vitest';
import {
  beatsPerBar,
  barToBeat,
  beatToBar,
  beatToSeconds,
  drumBeatToStep,
  drumStepsPerBar,
  projectLengthBeats,
  createEmptyProject,
} from '../src/index';

describe('beat/time math', () => {
  it('computes beats per bar for common time signatures', () => {
    expect(beatsPerBar([4, 4])).toBe(4);
    expect(beatsPerBar([3, 4])).toBe(3);
    expect(beatsPerBar([6, 8])).toBe(3);
    expect(beatsPerBar([5, 8])).toBe(2.5);
    expect(beatsPerBar([2, 2])).toBe(4);
    expect(beatsPerBar([2, 4])).toBe(2);
  });

  it('converts bar to beat and back', () => {
    expect(barToBeat(2, [4, 4])).toBe(8);
    expect(beatToBar(8, [4, 4])).toBe(2);
    expect(barToBeat(2, [6, 8])).toBe(6);
    expect(beatToBar(6, [6, 8])).toBe(2);
  });

  it('computes seconds per beat from bpm', () => {
    expect(beatToSeconds(120)).toBe(0.5);
    expect(beatToSeconds(60)).toBe(1);
  });

  it('computes total project length in beats', () => {
    const project = createEmptyProject({ lengthBars: 8, timeSignature: [4, 4] });
    expect(projectLengthBeats(project)).toBe(32);
    const project3 = createEmptyProject({ lengthBars: 4, timeSignature: [3, 4] });
    expect(projectLengthBeats(project3)).toBe(12);
  });
});

describe('drum grid rules', () => {
  it('gives every bar 4 whole steps per beat: 4/4=16, 3/4=12, 6/8=12, 2/4=8', () => {
    expect(drumStepsPerBar([4, 4])).toBe(16);
    expect(drumStepsPerBar([3, 4])).toBe(12);
    expect(drumStepsPerBar([6, 8])).toBe(12);
    expect(drumStepsPerBar([2, 4])).toBe(8);
  });

  it('maps beats to the nearest whole step, also on a grid that does not divide the bar', () => {
    // 4/4, 16 steps: 1 beat = 4 steps.
    expect([0, 1, 2, 3].map((b) => drumBeatToStep(b, 16, 4))).toEqual([0, 4, 8, 12]);
    expect(drumBeatToStep(0.5, 16, 4)).toBe(2);
    // 3/4, 12 steps: still 4 steps per beat.
    expect([0, 1, 2].map((b) => drumBeatToStep(b, 12, 3))).toEqual([0, 4, 8]);
    // 3/4 with a 16-step clip (loaded from an older file): whole steps, never 5.33.
    expect([0, 1, 2].map((b) => drumBeatToStep(b, 16, 3))).toEqual([0, 5, 11]);
    expect([0, 0.5, 1, 1.5, 2, 2.5].map((b) => drumBeatToStep(b, 16, 3))).toEqual([0, 3, 5, 8, 11, 13]);
  });
});
