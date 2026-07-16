import { describe, it, expect } from 'vitest';
import {
  beatsPerBar,
  barToBeat,
  beatToBar,
  beatToSeconds,
  compileDrumStepProjector,
  compileMusicalTime,
  projectLengthBeats,
  createEmptyProject,
  drumStepToBeatOnTimeline,
  projectDrumStep,
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

  it('keeps fixed 4/4 drum-step projection compatible', () => {
    const project = createEmptyProject({ lengthBars: 4, timeSignature: [4, 4] });
    const musicalTime = compileMusicalTime(project);

    expect(drumStepToBeatOnTimeline(16, 16, 2, musicalTime)).toEqual({
      beat: 6,
      beatsPerBar: 4,
    });
    expect(drumStepToBeatOnTimeline(31, 16, 2, musicalTime)).toEqual({
      beat: 9.75,
      beatsPerBar: 4,
    });
  });

  it('projects drum bars through variable signatures, including the exact boundary', () => {
    const project = createEmptyProject({ lengthBars: 4, timeSignature: [4, 4] });
    project.lengthBeats = 13;
    project.timeSignatureMap = [
      { ...project.timeSignatureMap[0]!, beat: 0, numerator: 4, denominator: 4 },
      { id: 'three-four', beat: 4, numerator: 3, denominator: 4 },
    ];
    const musicalTime = compileMusicalTime(project);

    expect(drumStepToBeatOnTimeline(16, 16, 0, musicalTime)).toEqual({
      beat: 4,
      beatsPerBar: 3,
    });
    expect(drumStepToBeatOnTimeline(31, 16, 0, musicalTime)).toEqual({
      beat: 6.8125,
      beatsPerBar: 3,
    });
    // A clip beginning midway through the old signature finishes its first
    // local bar before adopting the new signature at its next local bar.
    expect(drumStepToBeatOnTimeline(31, 16, 2, musicalTime)).toEqual({
      beat: 8.8125,
      beatsPerBar: 3,
    });
  });

  it('reuses compiled clip-local thresholds across a large signature map', () => {
    const project = createEmptyProject({ lengthBars: 256, timeSignature: [1, 4] });
    project.lengthBeats = 256;
    project.timeSignatureMap = Array.from({ length: 257 }, (_, index) => ({
      id: `signature-${index}`,
      beat: index,
      numerator: 1,
      denominator: 4,
    }));
    const musicalTime = compileMusicalTime(project);
    const projector = compileDrumStepProjector(16, 0, musicalTime);

    expect(projector.segments).toHaveLength(257);
    const projected = Array.from({ length: 20_000 }, (_, stepIndex) =>
      projectDrumStep(projector, stepIndex));
    expect(projected[4_095]).toEqual({ beat: 255.9375, beatsPerBar: 1 });
    expect(projected[19_999]).toEqual({ beat: 1249.9375, beatsPerBar: 1 });
    for (const stepIndex of [0, 15, 16, 31, 4_095, 19_999]) {
      expect(projected[stepIndex]).toEqual(
        drumStepToBeatOnTimeline(stepIndex, 16, 0, musicalTime),
      );
    }
  });
});
