import { describe, it, expect } from 'vitest';
import {
  beatsPerBar,
  barToBeat,
  beatToBar,
  beatToSeconds,
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
