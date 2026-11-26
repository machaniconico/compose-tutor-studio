import { describe, expect, it } from 'vitest';
import { createDefaultProject, type Clip, type Project } from '@cts/project-model';
import {
  barStartAtX,
  canSplitAt,
  dropStartBeat,
  resizedLengthBeats,
  snapBeatToBar,
  songBarsFor,
  withSongLength,
  xToBeat,
} from '../src/features/arranger/arrangeMath';

function clip(id: string, startBeat: number, lengthBeats: number): Clip {
  return { id, trackId: 't', type: 'midi', startBeat, lengthBeats, loop: false, notes: [] };
}

function projectWithClips(clips: Clip[]): Project {
  const base = createDefaultProject({ title: 'テスト' });
  const [first, ...rest] = base.tracks;
  return { ...base, tracks: [{ ...first!, id: 't', clips }, ...rest.map((t) => ({ ...t, clips: [] }))] };
}

describe('x → beat with bar snapping', () => {
  it('converts pixels to beats and never goes before 0', () => {
    expect(xToBeat(56, 28)).toBe(2);
    expect(xToBeat(-10, 28)).toBe(0);
  });

  it('snaps a beat to the nearest bar start', () => {
    expect(snapBeatToBar(1.9, 4)).toBe(0);
    expect(snapBeatToBar(2, 4)).toBe(4);
    expect(snapBeatToBar(9.5, 4)).toBe(8);
    expect(snapBeatToBar(-3, 4)).toBe(0);
    expect(snapBeatToBar(4.4, 3)).toBe(3);
  });

  it('finds the start of the bar under a pointer x', () => {
    // 28px per beat, 4 beats per bar: bar 2 covers x 112..223.
    expect(barStartAtX(111, 28, 4)).toBe(0);
    expect(barStartAtX(112, 28, 4)).toBe(4);
    expect(barStartAtX(223, 28, 4)).toBe(4);
    expect(barStartAtX(-5, 28, 4)).toBe(0);
  });
});

describe('drop position', () => {
  it('lands on the snapped bar when it is free', () => {
    const project = projectWithClips([clip('a', 0, 4), clip('b', 8, 4)]);
    expect(dropStartBeat(project, 'a', 13, 4)).toBe(12);
  });

  it('moves to the nearest start that does not overlap another clip', () => {
    const project = projectWithClips([clip('a', 0, 4), clip('b', 8, 4)]);
    // Bar 3 (beat 8) is taken by b; just after b (12) and just before it (4) tie,
    // the earlier one wins.
    expect(dropStartBeat(project, 'a', 8, 4)).toBe(4);
    // A clip longer than the gap goes past b.
    const long = projectWithClips([clip('a', 0, 8), clip('b', 8, 4), clip('c', 20, 4)]);
    expect(dropStartBeat(long, 'a', 12, 4)).toBe(12);
    expect(dropStartBeat(long, 'a', 16, 4)).toBe(12);
  });

  it('keeps the clip where it is for an unknown clip id', () => {
    const project = projectWithClips([clip('a', 4, 4)]);
    expect(dropStartBeat(project, 'missing', 8, 4)).toBe(8);
  });
});

describe('resize', () => {
  it('rounds to whole beats and keeps at least 1 beat', () => {
    expect(resizedLengthBeats(4, 6.4)).toBe(2);
    expect(resizedLengthBeats(4, 6.6)).toBe(3);
    expect(resizedLengthBeats(4, 4.2)).toBe(1);
    expect(resizedLengthBeats(4, 0)).toBe(1);
  });

  it('stops at the next clip on the track', () => {
    expect(resizedLengthBeats(0, 10, 8)).toBe(8);
    expect(resizedLengthBeats(0, 6, 8)).toBe(6);
  });

  it('fills only the gap when the next clip is less than 1 beat away', () => {
    // Left part of a split at 28.25: [28, 28.25) with the right part from 28.25.
    expect(resizedLengthBeats(28, 29, 28.25)).toBe(0.25);
    expect(resizedLengthBeats(28, 40, 28.25)).toBe(0.25);
    expect(resizedLengthBeats(28, 27, 28.25)).toBe(0.25);
  });
});

describe('split availability', () => {
  it('allows only a beat strictly inside the clip', () => {
    const project = projectWithClips([clip('a', 4, 4)]);
    expect(canSplitAt(project, 'a', 6)).toBe(true);
    expect(canSplitAt(project, 'a', 4)).toBe(false);
    expect(canSplitAt(project, 'a', 8)).toBe(false);
    expect(canSplitAt(project, 'a', 2)).toBe(false);
    expect(canSplitAt(project, 'a', 9)).toBe(false);
    expect(canSplitAt(project, null, 6)).toBe(false);
    expect(canSplitAt(project, 'missing', 6)).toBe(false);
  });

  it('uses the step rounding of a drum clip, as the split itself does', () => {
    const drum: Clip = {
      id: 'd',
      trackId: 't',
      type: 'drum',
      startBeat: 28,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'h', stepIndex: 4, lane: 'kick', velocity: 100 }],
    };
    const project = projectWithClips([drum]);
    // 28.05 rounds to the clip start (step 0): nothing to split.
    expect(canSplitAt(project, 'd', 28.05)).toBe(false);
    expect(canSplitAt(project, 'd', 31.95)).toBe(false);
    expect(canSplitAt(project, 'd', 28.2)).toBe(true);
  });
});

describe('song length', () => {
  it('grows the bar count to cover the edited clip end, ignoring other clips', () => {
    const project = { ...projectWithClips([clip('a', 16, 5), clip('b', 260, 4)]), lengthBars: 4 };
    expect(songBarsFor(project, 21, 64)).toBe(6);
    expect(songBarsFor({ ...project, lengthBars: 8 }, 21, 64)).toBe(8);
    // A song already longer than the maximum keeps its length.
    expect(songBarsFor({ ...project, lengthBars: 65 }, 21, 64)).toBe(65);
    // The floor can be set below the current length (a drag that comes back).
    expect(songBarsFor({ ...project, lengthBars: 9 }, 21, 64, 4)).toBe(6);
  });

  it('refuses a clip that would end past both the maximum and the current length', () => {
    const project = { ...projectWithClips([clip('a', 0, 4), clip('b', 16, 5)]), lengthBars: 4 };
    expect(songBarsFor(project, 21, 5)).toBeNull();
    expect(songBarsFor({ ...project, lengthBars: 6 }, 21, 5)).toBe(6);
    expect(withSongLength(project, 21, 5)).toBeNull();
    expect(withSongLength(project, 21, 64)?.lengthBars).toBe(6);
    const covered = { ...project, lengthBars: 8 };
    expect(withSongLength(covered, 21, 64)).toBe(covered);
  });
});
