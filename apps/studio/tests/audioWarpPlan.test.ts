import { describe, expect, it } from 'vitest';
import {
  beatToSourceFrame,
  CURRENT_SCHEMA_VERSION,
  type AudioClip,
  type Project,
  type ReadyAudioAsset,
  type Track,
} from '@cts/project-model';
import {
  AudioWarpPlanError,
  compileAudioWarpRenderRequests,
  computeAudioWarpFormantResourcePlan,
} from '../src/audio/audioWarpPlan';
import { renderAudioWarp } from '../src/audio/audioWarpDsp';

function fixture(edited = true): Project {
  const asset: ReadyAudioAsset = {
    id: 'asset',
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: 'voice.wav',
    mediaType: 'audio/wav',
    byteLength: 38_444,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 19_200,
  };
  const clip: AudioClip = {
    id: 'clip',
    trackId: 'track',
    type: 'audio',
    startBeat: 1,
    lengthBeats: 0.72,
    loop: false,
    audioAssetId: asset.id,
    sourceStartFrame: 0,
    sourceFrameCount: 19_200,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    gainDb: 0,
    ...(edited ? {
      audioWarp: {
        algorithm: 'wsola-v1' as const,
        formantMode: 'off' as const,
        timingEnabled: true,
        pitchEnabled: true,
        markers: [
          { sourceFrame: 0, targetBeatOffset: 0 },
          { sourceFrame: 9_600, targetBeatOffset: 0.32 },
          { sourceFrame: 19_200, targetBeatOffset: 0.72 },
        ],
        pitchRegions: [{
          sourceStartFrame: 0,
          sourceFrameCount: 19_200,
          sourcePitchCents: 6_900,
          targetPitchCents: 7_000,
          correctionAmount: 0.5,
          transitionFrames: 0,
        }],
      },
    } : {}),
  };
  const track: Track = {
    id: 'track',
    name: 'Voice',
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
    id: 'project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Warp',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [
      { id: 'tempo-0', beat: 0, bpm: 120 },
      { id: 'tempo-1', beat: 1.4, bpm: 60 },
    ],
    timeSignatureMap: [{ id: 'meter', beat: 0, numerator: 4, denominator: 4 }],
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

describe('compileAudioWarpRenderRequests', () => {
  it('keeps no-edit projects on the decoded-buffer path', () => {
    expect(compileAudioWarpRenderRequests(fixture(false))).toEqual([]);
    const disabled = fixture();
    const warp = (disabled.tracks[0]!.clips[0] as AudioClip).audioWarp!;
    (warp as { timingEnabled: boolean }).timingEnabled = false;
    (warp as { pitchEnabled: boolean }).pitchEnabled = false;
    expect(compileAudioWarpRenderRequests(disabled)).toEqual([]);
  });

  it('injects tempo-boundary knots so interior source-to-beat mapping stays exact', () => {
    const project = fixture();
    const clip = project.tracks[0]!.clips[0] as AudioClip;
    const [request] = compileAudioWarpRenderRequests(project, 44_100);
    const localTempoBoundary = project.tempoMap[1]!.beat - clip.startBeat;
    const tempoBoundarySource = beatToSourceFrame(clip.audioWarp!, localTempoBoundary);
    expect(request?.knots).toEqual([
      { sourceFrame: 0, sourceIndex: 0, outputFrame: 0 },
      { sourceFrame: 9_600, sourceIndex: 8_820, outputFrame: 7_056 },
      {
        sourceFrame: tempoBoundarySource,
        sourceIndex: 10_584,
        outputFrame: 8_820,
      },
      { sourceFrame: 19_200, sourceIndex: 17_640, outputFrame: 22_932 },
    ]);
    expect(request?.outputFrameCount).toBe(22_932);
    expect(request?.pitchRegions[0]).toMatchObject({
      sourceStartIndex: 0,
      sourceFrameCountAtTargetRate: 17_640,
      cents: 50,
    });
  });

  it('rejects a tempo-boundary subsegment beyond local stretch limits', () => {
    const project = fixture();
    const clip = project.tracks[0]!.clips[0] as AudioClip;
    clip.lengthBeats = 0.1;
    clip.sourceFrameCount = 4_800;
    clip.audioWarp = {
      ...clip.audioWarp!,
      markers: [
        { sourceFrame: 0, targetBeatOffset: 0 },
        { sourceFrame: 4_800, targetBeatOffset: 0.1 },
      ],
      pitchRegions: [],
    };
    project.tempoMap = [
      { id: 'tempo-0', beat: 0, bpm: 120 },
      { id: 'tempo-1', beat: 1.09, bpm: 20 },
    ];

    expect(() => compileAudioWarpRenderRequests(project)).toThrowError(
      expect.objectContaining({ code: 'invalid-project', clipId: 'clip' }) as AudioWarpPlanError,
    );
  });

  it('filters zero-effective pitch regions and keeps an all-zero pitch edit on bypass', () => {
    const pitchOnly = fixture();
    const pitchOnlyWarp = (pitchOnly.tracks[0]!.clips[0] as AudioClip).audioWarp!;
    (pitchOnlyWarp as { timingEnabled: boolean }).timingEnabled = false;
    (pitchOnlyWarp.pitchRegions[0] as { correctionAmount: number }).correctionAmount = 0;
    expect(compileAudioWarpRenderRequests(pitchOnly)).toEqual([]);

    const timingAndZeroPitch = fixture();
    const timingWarp = (timingAndZeroPitch.tracks[0]!.clips[0] as AudioClip).audioWarp!;
    (timingWarp.pitchRegions[0] as { correctionAmount: number }).correctionAmount = 0;
    expect(compileAudioWarpRenderRequests(timingAndZeroPitch)[0]?.pitchRegions).toEqual([]);
  });

  it('normalizes disabled timing to endpoint knots with identical cache and PCM', () => {
    const firstProject = fixture();
    const firstWarp = (firstProject.tracks[0]!.clips[0] as AudioClip).audioWarp!;
    (firstWarp as { timingEnabled: boolean }).timingEnabled = false;

    const secondProject = fixture();
    const secondWarp = (secondProject.tracks[0]!.clips[0] as AudioClip).audioWarp!;
    (secondWarp as { timingEnabled: boolean }).timingEnabled = false;
    (secondWarp.markers as { sourceFrame: number; targetBeatOffset: number }[])[1] = {
      sourceFrame: 1_920,
      targetBeatOffset: 0.08,
    };

    const [first] = compileAudioWarpRenderRequests(firstProject);
    const [second] = compileAudioWarpRenderRequests(secondProject);
    expect(first?.knots).toEqual([
      { sourceFrame: 0, sourceIndex: 0, outputFrame: 0 },
      { sourceFrame: 19_200, sourceIndex: 19_200, outputFrame: 19_200 },
    ]);
    expect(second?.knots).toEqual(first?.knots);
    expect(second?.cacheKey).toBe(first?.cacheKey);

    const channel = Float32Array.from(
      { length: 19_200 },
      (_, frame) => Math.sin(2 * Math.PI * 440 * frame / 48_000),
    );
    const pcm = {
      sampleRate: 48_000,
      frameCount: 19_200,
      channelCount: 1 as const,
      channels: [channel],
    };
    expect([
      ...renderAudioWarp(second!, pcm).channels[0]!,
    ]).toEqual([
      ...renderAudioWarp(first!, pcm).channels[0]!,
    ]);
  });

  it('deduplicates content and excludes presentation fields and clip identity from its key', () => {
    const project = fixture();
    const clip = project.tracks[0]!.clips[0] as AudioClip;
    project.tracks[0]!.clips.push({
      ...clip,
      id: 'other-id',
      gainDb: -12,
      fadeInFrames: 100,
      fadeOutFrames: 100,
    });
    const requests = compileAudioWarpRenderRequests(project);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.cacheKey).not.toContain('other-id');
    expect(requests[0]?.cacheKey).not.toContain('gainDb');
  });

  it('fails malformed edited data instead of silently returning no edits', () => {
    const project = fixture();
    const marker = (project.tracks[0]!.clips[0] as AudioClip)
      .audioWarp!.markers[1] as { targetBeatOffset: number };
    marker.targetBeatOffset = 2;
    expect(() => compileAudioWarpRenderRequests(project)).toThrowError(
      expect.objectContaining({ code: 'invalid-project', clipId: 'clip' }) as AudioWarpPlanError,
    );
  });

  it('projects formant memory ceilings and work units with checked predicate order', () => {
    const expectedWorkUnits = (
      outputFrames: number,
      channelCount: 1 | 2,
      sampleRate: number,
    ) => {
      const blocks = Math.ceil(outputFrames / 1024);
      const maximumLag = Math.ceil(sampleRate / 70);
      const maximumHarmonics = Math.floor(5_000 / 70);
      return blocks * 11 * 2048 * (2 + 2 * channelCount)
        + outputFrames * maximumLag
        + blocks * 2048 * maximumHarmonics * channelCount
        + blocks * 8_192 * 13 * channelCount
        + outputFrames * maximumHarmonics * (4 + 4 * channelCount)
        + blocks * 2_000 * maximumHarmonics * 10;
    };
    for (const outputBytes of [134_217_727, 134_217_728]) {
      expect(computeAudioWarpFormantResourcePlan({
        sourceBytes: 0,
        outputBytes,
      }).reason).not.toBe('derived-ceiling');
    }
    expect(computeAudioWarpFormantResourcePlan({
      sourceBytes: 0,
      outputBytes: 134_217_729,
    })).toMatchObject({ accepted: false, reason: 'derived-ceiling' });
    expect(computeAudioWarpFormantResourcePlan({
      sourceBytes: 0,
      outputBytes: 134_217_728,
    })).toMatchObject({
      accepted: false,
      reason: 'shared-heavy',
      outputPeakBytes: 9 * 134_217_728,
      processingPeakBytes: 9 * 134_217_728 + 147_456,
    });
    expect(computeAudioWarpFormantResourcePlan({
      sourceBytes: 0,
      outputBytes: 134_217_732,
    })).toMatchObject({ accepted: false, reason: 'derived-ceiling' });

    const small = computeAudioWarpFormantResourcePlan({
      sourceBytes: 4,
      outputBytes: 4,
      outputFrames: 2_880_000,
      channelCount: 2,
      sampleRate: 48_000,
    });
    expect(small.processingPeakBytes).toBe(4 * 4 + 9 * 4 + 147_456);
    expect([
      small.sourcePeakBytes,
      small.outputPeakBytes,
      small.scratchBytes,
    ]).toEqual([4 * 4, 9 * 4, 147_456]);
    expect(small.workUnits).toBe(expectedWorkUnits(2_880_000, 2, 48_000));
    const boundaryOuter = 402_653_184 - small.processingPeakBytes;
    expect(computeAudioWarpFormantResourcePlan({
      sourceBytes: 4,
      outputBytes: 4,
      outerReservationBytes: boundaryOuter - 1,
    }).sharedPeakBytes).toBe(402_653_183);
    expect(computeAudioWarpFormantResourcePlan({
      sourceBytes: 4,
      outputBytes: 4,
      outerReservationBytes: boundaryOuter,
    })).toMatchObject({ accepted: true, sharedPeakBytes: 402_653_184 });
    expect(computeAudioWarpFormantResourcePlan({
      sourceBytes: 4,
      outputBytes: 4,
      outerReservationBytes: boundaryOuter + 1,
    })).toMatchObject({ accepted: false, reason: 'shared-heavy' });
    expect(computeAudioWarpFormantResourcePlan({
      sourceBytes: Number.MAX_SAFE_INTEGER,
      outputBytes: 4,
    })).toMatchObject({ accepted: false, reason: 'invalid-projection' });
    for (const projection of [
      { sourceBytes: 2_251_799_813_685_248, outputBytes: 0 },
      { sourceBytes: 0, outputBytes: Number.NaN },
      { sourceBytes: 0.5, outputBytes: 4 },
      { sourceBytes: 4, outputBytes: 4, outerReservationBytes: Number.MAX_SAFE_INTEGER },
      {
        sourceBytes: 4,
        outputBytes: 4,
        outputFrames: Number.MAX_SAFE_INTEGER,
        channelCount: 2,
        sampleRate: 48_000,
      },
    ]) {
      expect(computeAudioWarpFormantResourcePlan(projection))
        .toMatchObject({ accepted: false, reason: 'invalid-projection' });
    }
    const at441 = computeAudioWarpFormantResourcePlan({
      sourceBytes: 4,
      outputBytes: 4,
      outputFrames: 44_100 * 60,
      channelCount: 2,
      sampleRate: 44_100,
    });
    expect(at441.workUnits).toBe(expectedWorkUnits(44_100 * 60, 2, 44_100));
    expect(computeAudioWarpFormantResourcePlan({
      sourceBytes: 4,
      outputBytes: 4,
      outputFrames: 10,
      channelCount: 2,
      sampleRate: 32_000,
    })).toMatchObject({
      fftSize: 0,
      hopSize: 0,
      radix2Stages: 0,
      scratchBytes: 0,
      workUnits: 0,
    });
  });
});
