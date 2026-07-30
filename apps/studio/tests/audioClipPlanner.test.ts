import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  type AudioClip,
  type Project,
  type ReadyAudioAsset,
  type Track,
} from '@cts/project-model';
import {
  AudioClipPlanLimitError,
  MAX_AUDIO_CLIP_PLANS_PER_WINDOW,
  MAX_AUDIO_CLIP_REGIONS,
  audioClipGainToLinear,
  createAudioClipPlaybackIndex,
  planAudioClipPlaybackWindow,
  planAudioClipTailSources,
} from '../src/audio/audioClipPlanner';
import { createProjectMusicalTime } from '../src/audio/musicalTime';

const asset: ReadyAudioAsset = {
  id: 'asset-1',
  availability: 'ready',
  checksumSha256: 'a'.repeat(64),
  originalName: 'fixture.wav',
  mediaType: 'audio/wav',
  byteLength: 192_044,
  sampleRate: 48_000,
  channelCount: 1,
  frameCount: 48_000 * 8,
};

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'clip-1',
    trackId: 'audio-track',
    type: 'audio',
    startBeat: 0,
    lengthBeats: 8,
    loop: false,
    audioAssetId: asset.id,
    sourceStartFrame: 48_000,
    sourceFrameCount: 48_000 * 3,
    fadeInFrames: 24_000,
    fadeOutFrames: 24_000,
    gainDb: -6,
    ...overrides,
  };
}

function project(
  clip: AudioClip,
  tempoMap: Project['tempoMap'] = [{ id: 'tempo-0', beat: 0, bpm: 120 }],
): Project {
  const track: Track = {
    id: 'audio-track',
    name: 'Audio',
    type: 'audio',
    role: 'general',
    clips: [clip],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
  return {
    id: 'audio-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Audio planner test',
    bpm: tempoMap[0]?.bpm ?? 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 4,
    lengthBeats: 16,
    tempoMap,
    timeSignatureMap: [{
      id: 'meter-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [asset],
    audioTakeFolders: [],
    automationLanes: [],
    automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    audioRouting: {
      outputs: [{ sourceTrackId: track.id, destination: { type: 'master' } }],
      sends: [],
    },
    tracks: [track],
    chordTrack: [],
    sections: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
}

describe('audio clip playback planner', () => {
  it('plans warped seek, fades, duration, tail, and buffer identity on derived time', () => {
    const fixture = project(audioClip({
      audioWarp: {
        algorithm: 'wsola-v1',
        formantMode: 'off' as const,
        timingEnabled: true,
        pitchEnabled: false,
        markers: [
          { sourceFrame: 48_000, targetBeatOffset: 0 },
          { sourceFrame: 192_000, targetBeatOffset: 8 },
        ],
        pitchRegions: [],
      },
    }));
    const plans = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 2,
      windowEndBeat: fixture.lengthBeats,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      startBeat: 2,
      endBeat: 8,
      sourceOffsetSeconds: 1,
      durationSeconds: 3,
      playbackBufferKey: {
        kind: 'derived',
        assetId: asset.id,
        sampleRate: 48_000,
        frameCount: 192_000,
      },
    });
    expect(plans[0]?.gainPoints).toEqual([
      { offsetSeconds: 0, value: audioClipGainToLinear(-6) },
      { offsetSeconds: 2 + 1 / 3, value: audioClipGainToLinear(-6) },
      { offsetSeconds: 3, value: 0 },
    ]);
    expect(planAudioClipTailSources(fixture, {
      startBeat: 0,
      endBeat: fixture.lengthBeats,
    })).toEqual([{ trackId: 'audio-track', endSeconds: 4 }]);
  });

  it('uses the selected source range and stops at the earlier source end', () => {
    const fixture = project(audioClip());
    const plans = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: fixture.lengthBeats,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      startBeat: 0,
      endBeat: 6,
      sourceOffsetSeconds: 1,
      durationSeconds: 3,
      loopStartSeconds: null,
      loopEndSeconds: null,
      playbackBufferKey: {
        kind: 'source',
        assetId: asset.id,
        checksumSha256: asset.checksumSha256,
      },
    });
    expect(plans[0]?.gainPoints).toEqual([
      { offsetSeconds: 0, value: 0 },
      { offsetSeconds: 0.5, value: audioClipGainToLinear(-6) },
      { offsetSeconds: 2.5, value: audioClipGainToLinear(-6) },
      { offsetSeconds: 3, value: 0 },
    ]);
  });

  it('plans only the selected take segment after source clips become a folder', () => {
    const fixture = project(audioClip());
    fixture.tracks[0]!.clips = [];
    fixture.audioTakeFolders = [{
      id: 'take-folder-1',
      trackId: 'audio-track',
      startBeat: 0,
      lengthBeats: 8,
      crossfadeMs: 5,
      takes: [
        {
          id: 'take-1',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 0,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          gainDb: 0,
        },
        {
          id: 'take-2',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 48_000 * 4,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          gainDb: -3,
        },
      ],
      compSegments: [{
        id: 'comp-1',
        takeId: 'take-2',
        offsetBeats: 0,
        lengthBeats: 8,
      }],
    }];

    const plans = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: fixture.lengthBeats,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      trackId: 'audio-track',
      assetId: asset.id,
      sourceOffsetSeconds: 4,
      durationSeconds: 4,
      startBeat: 0,
      endBeat: 8,
    });
    expect(plans[0]?.occurrenceId).toContain('take-folder-1');
    expect(plans[0]?.occurrenceId).toContain('comp-1');
    expect(plans[0]?.gainPoints[0]?.value).toBeCloseTo(
      audioClipGainToLinear(-3),
      10,
    );
    expect(planAudioClipTailSources(fixture, {
      startBeat: 0,
      endBeat: fixture.lengthBeats,
    })).toEqual([{ trackId: 'audio-track', endSeconds: 4 }]);
  });

  it('uses one centered linear crossfade window at a take splice', () => {
    const fixture = project(audioClip());
    fixture.tracks[0]!.clips = [];
    fixture.audioTakeFolders = [{
      id: 'take-folder-crossfade',
      trackId: 'audio-track',
      startBeat: 0,
      lengthBeats: 8,
      crossfadeMs: 10,
      takes: [
        {
          id: 'take-left',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 0,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          gainDb: 0,
        },
        {
          id: 'take-right',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 48_000 * 4,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          gainDb: 0,
        },
      ],
      compSegments: [
        {
          id: 'comp-left',
          takeId: 'take-left',
          offsetBeats: 0,
          lengthBeats: 4,
        },
        {
          id: 'comp-right',
          takeId: 'take-right',
          offsetBeats: 4,
          lengthBeats: 4,
        },
      ],
    }];

    const plans = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: fixture.lengthBeats,
    });

    expect(plans).toHaveLength(2);
    const left = plans.find((plan) => plan.clipId.includes('comp-left'));
    const right = plans.find((plan) => plan.clipId.includes('comp-right'));
    expect(left?.endBeat).toBeCloseTo(4.01, 10);
    expect(right?.startBeat).toBeCloseTo(3.99, 10);
    expect(left?.gainPoints.at(-1)?.value).toBe(0);
    expect(right?.gainPoints[0]?.value).toBe(0);
    expect(left?.gainPoints.at(-2)?.offsetSeconds).toBeCloseTo(1.995, 10);
    expect(right?.gainPoints[1]?.offsetSeconds).toBeCloseTo(0.01, 10);
  });

  it('keeps a persisted outer fade independent from a short variable-tempo splice', () => {
    const fixture = project(audioClip(), [
      { id: 'tempo-0', beat: 0, bpm: 120 },
      { id: 'tempo-1', beat: 0.2, bpm: 60 },
    ]);
    fixture.tracks[0]!.clips = [];
    fixture.audioTakeFolders = [{
      id: 'short-folder',
      trackId: 'audio-track',
      startBeat: 0,
      lengthBeats: 1,
      crossfadeMs: 10,
      takes: [
        {
          id: 'short-first-take',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 1,
          sourceStartFrame: 0,
          sourceFrameCount: 48_000,
          fadeInFrames: 48_000,
          fadeOutFrames: 0,
          gainDb: 0,
        },
        {
          id: 'short-second-take',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 1,
          sourceStartFrame: 48_000,
          sourceFrameCount: 48_000,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          gainDb: 0,
        },
      ],
      compSegments: [
        {
          id: 'short-first-segment',
          takeId: 'short-first-take',
          offsetBeats: 0,
          lengthBeats: 0.2,
        },
        {
          id: 'short-second-segment',
          takeId: 'short-second-take',
          offsetBeats: 0.2,
          lengthBeats: 0.8,
        },
      ],
    }];

    const plans = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 1,
    });
    const outgoing = plans.find((plan) => plan.clipId.includes('short-first-segment'));
    const incoming = plans.find((plan) => plan.clipId.includes('short-second-segment'));

    const outgoingOffsets = outgoing?.gainPoints.map((point) => point.offsetSeconds);
    expect(outgoingOffsets).toHaveLength(3);
    [0, 0.095, 0.105].forEach((expected, index) => {
      expect(outgoingOffsets?.[index]).toBeCloseTo(expected, 10);
    });
    expect(outgoing?.gainPoints[1]?.value).toBeCloseTo(0.095, 10);
    expect(outgoing?.gainPoints[2]?.value).toBe(0);
    expect(incoming?.gainPoints.slice(0, 2)).toEqual([
      { offsetSeconds: 0, value: 0 },
      { offsetSeconds: 0.01, value: 1 },
    ]);
  });

  it('samples the original fade-in envelope for an interior comp slice', () => {
    const fixture = project(audioClip());
    fixture.tracks[0]!.clips = [];
    fixture.audioTakeFolders = [{
      id: 'interior-fade-in-folder',
      trackId: 'audio-track',
      startBeat: 0,
      lengthBeats: 8,
      crossfadeMs: 0,
      takes: [
        {
          id: 'outer-take',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 48_000 * 4,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          gainDb: 0,
        },
        {
          id: 'faded-take',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 0,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 48_000 * 4,
          fadeOutFrames: 0,
          gainDb: 0,
        },
      ],
      compSegments: [
        {
          id: 'before-interior-fade-in',
          takeId: 'outer-take',
          offsetBeats: 0,
          lengthBeats: 2,
        },
        {
          id: 'interior-fade-in',
          takeId: 'faded-take',
          offsetBeats: 2,
          lengthBeats: 2,
        },
        {
          id: 'after-interior-fade-in',
          takeId: 'outer-take',
          offsetBeats: 4,
          lengthBeats: 4,
        },
      ],
    }];

    const plans = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 8,
    });
    const interior = plans.find(
      (plan) => plan.clipId.includes('"interior-fade-in"'),
    );

    expect(interior?.sourceOffsetSeconds).toBe(1);
    expect(interior?.durationSeconds).toBe(1);
    expect(interior?.gainPoints).toEqual([
      { offsetSeconds: 0, value: 0.25 },
      { offsetSeconds: 1, value: 0.5 },
    ]);
  });

  it('samples the original fade-out envelope for an interior comp slice', () => {
    const fixture = project(audioClip());
    fixture.tracks[0]!.clips = [];
    fixture.audioTakeFolders = [{
      id: 'interior-fade-out-folder',
      trackId: 'audio-track',
      startBeat: 0,
      lengthBeats: 8,
      crossfadeMs: 0,
      takes: [
        {
          id: 'outer-take',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 48_000 * 4,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          gainDb: 0,
        },
        {
          id: 'faded-take',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 0,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 0,
          fadeOutFrames: 48_000 * 4,
          gainDb: 0,
        },
      ],
      compSegments: [
        {
          id: 'before-interior-fade-out',
          takeId: 'outer-take',
          offsetBeats: 0,
          lengthBeats: 2,
        },
        {
          id: 'interior-fade-out',
          takeId: 'faded-take',
          offsetBeats: 2,
          lengthBeats: 2,
        },
        {
          id: 'after-interior-fade-out',
          takeId: 'outer-take',
          offsetBeats: 4,
          lengthBeats: 4,
        },
      ],
    }];

    const plans = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 8,
    });
    const interior = plans.find(
      (plan) => plan.clipId.includes('"interior-fade-out"'),
    );

    expect(interior?.sourceOffsetSeconds).toBe(1);
    expect(interior?.durationSeconds).toBe(1);
    expect(interior?.gainPoints).toEqual([
      { offsetSeconds: 0, value: 0.75 },
      { offsetSeconds: 1, value: 0.5 },
    ]);
  });

  it('keeps ordinary and comp occurrences distinct for adversarial persisted ids', () => {
    const collidingClipId = JSON.stringify(['comp', 'f', 's', 't']);
    const fixture = project(audioClip({
      id: collidingClipId,
      sourceStartFrame: 0,
      sourceFrameCount: 48_000 * 4,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      gainDb: 0,
    }));
    fixture.audioTakeFolders = [{
      id: 'f',
      trackId: 'audio-track',
      startBeat: 0,
      lengthBeats: 8,
      crossfadeMs: 5,
      takes: [
        {
          id: 't',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 0,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          gainDb: 0,
        },
        {
          id: 'unused',
          audioAssetId: asset.id,
          offsetBeats: 0,
          lengthBeats: 8,
          sourceStartFrame: 48_000 * 4,
          sourceFrameCount: 48_000 * 4,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          gainDb: 0,
        },
      ],
      compSegments: [{
        id: 's',
        takeId: 't',
        offsetBeats: 0,
        lengthBeats: 8,
      }],
    }];

    const plans = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 8,
    });

    expect(plans).toHaveLength(2);
    expect(new Set(plans.map((plan) => plan.occurrenceId))).toHaveProperty('size', 2);
  });

  it('resumes a one-shot clip from the current source offset and fade value', () => {
    const fixture = project(audioClip());
    const [plan] = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 1,
      windowEndBeat: 1.2,
    });

    expect(plan?.startBeat).toBe(1);
    expect(plan?.endBeat).toBe(6);
    expect(plan?.sourceOffsetSeconds).toBeCloseTo(1.5, 10);
    expect(plan?.durationSeconds).toBeCloseTo(2.5, 10);
    expect(plan?.gainPoints[0]?.value).toBeCloseTo(audioClipGainToLinear(-6), 10);
  });

  it('returns a stable occurrence id across adjacent lookahead windows', () => {
    const fixture = project(audioClip());
    const first = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 0.2,
    });
    const second = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0.2,
      windowEndBeat: 0.4,
    });

    expect(first[0]?.occurrenceId).toBe(second[0]?.occurrenceId);
    expect(second[0]?.sourceOffsetSeconds).toBeCloseTo(1.1, 10);
  });

  it('uses native source-range looping and keeps fade on the clip outer edges', () => {
    const fixture = project(audioClip({
      lengthBeats: 10,
      loop: true,
      sourceStartFrame: 24_000,
      sourceFrameCount: 48_000,
      fadeInFrames: 4_800,
      fadeOutFrames: 9_600,
    }));
    const [plan] = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 5,
      windowEndBeat: 5.2,
    });

    expect(plan).toMatchObject({
      startBeat: 5,
      endBeat: 10,
      sourceOffsetSeconds: 1,
      durationSeconds: 2.5,
      loopStartSeconds: 0.5,
      loopEndSeconds: 1.5,
    });
    expect(plan?.gainPoints[0]?.value).toBeCloseTo(audioClipGainToLinear(-6), 10);
    expect(plan?.gainPoints.at(-1)).toEqual({ offsetSeconds: 2.5, value: 0 });
  });

  it('maps source seconds through tempo changes without time stretching', () => {
    const fixture = project(
      audioClip({
        startBeat: 1,
        lengthBeats: 8,
        sourceStartFrame: 0,
        sourceFrameCount: 48_000 * 3,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      }),
      [
        { id: 'tempo-0', beat: 0, bpm: 120 },
        { id: 'tempo-1', beat: 2, bpm: 60 },
      ],
    );
    const tempo = createProjectMusicalTime(fixture).tempo;
    const [plan] = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 2.5,
      windowEndBeat: 2.75,
      tempo,
    });

    // Clip starts at 0.5s; beat 2.5 is 1.5s, therefore source offset is 1s.
    expect(plan?.sourceOffsetSeconds).toBeCloseTo(1, 10);
    expect(plan?.durationSeconds).toBeCloseTo(2, 10);
    // Three source seconds from beat 1 finish at absolute 3.5s = beat 4.5.
    expect(plan?.endBeat).toBeCloseTo(4.5, 10);
  });

  it('splits at transport-loop boundaries and restarts each pass at wrapped phase', () => {
    const fixture = project(audioClip({
      startBeat: 0,
      lengthBeats: 8,
      sourceStartFrame: 0,
      sourceFrameCount: 48_000 * 4,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      gainDb: 0,
    }));
    const loop = { startBeat: 1, endBeat: 3 };
    const firstPass = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 2.9,
      windowEndBeat: 3.1,
      transportLoop: loop,
    });

    expect(firstPass).toHaveLength(2);
    expect(firstPass[0]).toMatchObject({
      startBeat: 2.9,
      endBeat: 3,
      sourceOffsetSeconds: 1.45,
    });
    expect(firstPass[1]).toMatchObject({
      startBeat: 3,
      endBeat: 5,
      sourceOffsetSeconds: 0.5,
      durationSeconds: 1,
    });
    expect(firstPass[0]?.occurrenceId).not.toBe(firstPass[1]?.occurrenceId);
  });

  it('returns no occurrence at the half-open clip end', () => {
    const fixture = project(audioClip());
    expect(planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 6,
      windowEndBeat: 6.2,
    })).toEqual([]);
  });

  it('fails closed before materializing an excessive number of transport cycles', () => {
    const fixture = project(audioClip({ loop: true }));

    expect(() => planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 1,
      windowEndBeat: 2,
      transportLoop: { startBeat: 1, endBeat: 1.001 },
      maxPlans: 4,
    })).toThrow(AudioClipPlanLimitError);
  });

  it('returns immediately for projects without Audio Clips even with a tiny loop', () => {
    const fixture = project(audioClip());
    fixture.tracks = [];

    expect(planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 1,
      windowEndBeat: 2,
      transportLoop: { startBeat: 1, endBeat: 1.000_000_000_001 },
      maxPlans: 1,
    })).toEqual([]);
  });

  it('budgets candidate regions across transport passes before nested planning', () => {
    const fixture = project(audioClip({ loop: true }));
    fixture.tracks[0]?.clips.push(audioClip({ id: 'clip-2', loop: true }));

    expect(() => planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 1,
      windowEndBeat: 4,
      transportLoop: { startBeat: 1, endBeat: 2 },
      maxPlans: 4,
    })).toThrow(AudioClipPlanLimitError);
  });

  it('stops compiling at region 10,001 even when every clip is outside the tick', () => {
    const fixture = project(audioClip());
    fixture.tracks[0]!.clips = Array.from(
      { length: MAX_AUDIO_CLIP_REGIONS + 1 },
      (_, index) => audioClip({
        id: `sparse-clip-${index}`,
        startBeat: 8,
        lengthBeats: 1,
      }),
    );

    expect(() => planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 0.1,
    })).toThrowError(expect.objectContaining({
      limit: MAX_AUDIO_CLIP_REGIONS,
      observed: MAX_AUDIO_CLIP_REGIONS + 1,
    }) as AudioClipPlanLimitError);
  });

  it('reuses one compiled interval index across scheduler ticks', () => {
    const fixture = project(audioClip());
    const index = createAudioClipPlaybackIndex(fixture);
    const track = fixture.tracks[0]!;
    Object.defineProperty(track, 'clips', {
      configurable: true,
      get: () => {
        throw new Error('playback tick must not collect clips again');
      },
    });

    const first = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 0.2,
      index,
    });
    const second = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0.2,
      windowEndBeat: 0.4,
      index,
    });

    expect(index.regionCount).toBe(1);
    expect(first[0]?.occurrenceId).toBe(second[0]?.occurrenceId);
  });

  it('aggregates natural-tail ends without the playback occurrence cap', () => {
    const fixture = project(audioClip());
    fixture.tracks[0]!.clips = Array.from(
      { length: MAX_AUDIO_CLIP_PLANS_PER_WINDOW + 1 },
      (_, index) => audioClip({ id: `clip-${index}` }),
    );

    expect(planAudioClipTailSources(fixture, {
      startBeat: 0,
      endBeat: fixture.lengthBeats,
    })).toEqual([{ trackId: 'audio-track', endSeconds: 3 }]);
  });
});
