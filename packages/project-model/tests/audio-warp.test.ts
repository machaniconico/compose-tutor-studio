import { describe, expect, it } from 'vitest';
import {
  addAudioWarpTimingPoint,
  audioWarpsEqual,
  beatToSourceFrame,
  cropAudioWarp,
  mergeAudioPitchRegions,
  moveAudioWarpTimingPoint,
  partitionAudioWarp,
  removeAudioWarpTimingPoint,
  replaceAudioPitchRegions,
  resetAudioPitchRegions,
  resetAudioWarpTimingPoints,
  retargetAudioPitchRegion,
  sourceFrameToBeat,
  splitAudioPitchRegion,
  type AudioWarp,
} from '../src';

function warp(): AudioWarp {
  return {
    algorithm: 'wsola-v1',
    formantMode: 'preserve',
    timingEnabled: true,
    pitchEnabled: true,
    markers: [
      { sourceFrame: 10_000, targetBeatOffset: 0 },
      { sourceFrame: 58_000, targetBeatOffset: 1.5 },
      { sourceFrame: 106_000, targetBeatOffset: 4 },
    ],
    pitchRegions: [{
      sourceStartFrame: 20_000,
      sourceFrameCount: 48_000,
      sourcePitchCents: 6_875,
      targetPitchCents: 6_900,
      correctionAmount: 1,
      transitionFrames: 960,
    }],
  };
}

describe('Audio Warp pure mapping and edits', () => {
  it('interpolates and inverts every frame boundary plus or minus one', () => {
    const edit = warp();
    for (const sourceFrame of [10_000, 10_001, 57_999, 58_000, 58_001, 105_999, 106_000]) {
      expect(beatToSourceFrame(edit, sourceFrameToBeat(edit, sourceFrame)))
        .toBeCloseTo(sourceFrame, 8);
    }
  });

  it('edits timing points immutably and reports exact no-ops', () => {
    const original = warp();
    const added = addAudioWarpTimingPoint(original, {
      sourceFrame: 34_000,
      targetBeatOffset: 0.75,
    });
    expect(added.ok && added.changed).toBe(true);
    expect(original.markers).toHaveLength(3);
    if (!added.ok) return;
    const moved = moveAudioWarpTimingPoint(
      added.audioWarp,
      1,
      added.audioWarp.markers[1]!,
    );
    expect(moved).toMatchObject({ ok: true, changed: false });
    const removed = removeAudioWarpTimingPoint(added.audioWarp, 1);
    expect(removed.ok && removed.changed).toBe(true);
    const reset = resetAudioWarpTimingPoints(added.audioWarp);
    expect(reset.ok && reset.audioWarp.markers).toHaveLength(2);
  });

  it('replaces, splits, retargets, merges, and resets pitch regions', () => {
    const original = warp();
    const replaced = replaceAudioPitchRegions(original, original.pitchRegions);
    expect(replaced).toMatchObject({ ok: true, changed: false });
    const split = splitAudioPitchRegion(original, 0, 44_000);
    expect(split.ok && split.audioWarp.pitchRegions).toHaveLength(2);
    if (!split.ok) return;
    const retargeted = retargetAudioPitchRegion(split.audioWarp, 1, 6_925, 0.5);
    expect(retargeted.ok && retargeted.changed).toBe(true);
    const merged = mergeAudioPitchRegions(split.audioWarp, 0);
    expect(merged.ok && merged.audioWarp.pitchRegions).toHaveLength(1);
    const reset = resetAudioPitchRegions(original);
    expect(reset.ok && reset.audioWarp.pitchRegions).toEqual([]);
  });

  it('crops and partitions with interpolated canonical boundaries', () => {
    const original = warp();
    const cropped = cropAudioWarp(original, 34_000, 82_000);
    expect(cropped.markers[0]).toEqual({ sourceFrame: 34_000, targetBeatOffset: 0 });
    expect(cropped.markers.at(-1)).toEqual({ sourceFrame: 82_000, targetBeatOffset: 2 });
    expect(cropped.formantMode).toBe('preserve');
    const partitioned = partitionAudioWarp(original, 58_000);
    expect(partitioned.left.formantMode).toBe('preserve');
    expect(partitioned.right.formantMode).toBe('preserve');
    expect(partitioned.left.markers.at(-1)?.sourceFrame).toBe(58_000);
    expect(partitioned.right.markers[0]).toEqual({
      sourceFrame: 58_000,
      targetBeatOffset: 0,
    });
  });

  it('includes formantMode in semantic equality', () => {
    const original = warp();
    expect(audioWarpsEqual(original, { ...original })).toBe(true);
    expect(audioWarpsEqual(original, { ...original, formantMode: 'off' })).toBe(false);
  });
});
