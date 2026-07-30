import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  createEmptyProject,
  createTrack,
  decodeProject,
  duplicateAudioClip,
  encodeProjectJson,
  groupAudioClipsIntoTakeFolder,
  inspectAudioPunchTarget,
  migrateProject,
  moveAudioClip,
  setAudioClipLoop,
  splitAudioClip,
  trimAudioClipLeft,
  trimAudioClipRight,
  validateProject,
  type AudioClip,
  type AudioWarp,
  type Project,
} from '../src';

const clock = () => new Date('2026-01-01T00:00:00.000Z');

function fixture(): { project: Project; clip: AudioClip; warp: AudioWarp } {
  const project = createEmptyProject({ clock });
  const track = createTrack('Voice', 'audio');
  const clip: AudioClip = {
    id: 'audio-clip',
    trackId: track.id,
    type: 'audio',
    startBeat: 0,
    lengthBeats: 4,
    loop: false,
    audioAssetId: 'audio-asset',
    sourceStartFrame: 0,
    sourceFrameCount: 96_000,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    gainDb: 0,
  };
  const warp: AudioWarp = {
    algorithm: 'wsola-v1',
    timingEnabled: true,
    pitchEnabled: true,
    markers: [
      { sourceFrame: 0, targetBeatOffset: 0 },
      { sourceFrame: 48_000, targetBeatOffset: 1.5 },
      { sourceFrame: 96_000, targetBeatOffset: 4 },
    ],
    pitchRegions: [{
      sourceStartFrame: 2_000,
      sourceFrameCount: 48_000,
      sourcePitchCents: 6_875,
      targetPitchCents: 6_900,
      correctionAmount: 0.8,
      transitionFrames: 960,
    }],
  };
  clip.audioWarp = warp;
  track.clips.push(clip);
  project.tracks.push(track);
  project.audioAssets.push({
    id: 'audio-asset',
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: 'voice.wav',
    mediaType: 'audio/wav',
    byteLength: 192_044,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 96_000,
  });
  project.audioRouting.outputs.push({
    sourceTrackId: track.id,
    destination: { type: 'master' },
  });
  return { project, clip, warp };
}

describe('schema-v9 Audio Warp', () => {
  it('adds only the schema version while migrating v8 and rejects v8 smuggling', () => {
    const { project } = fixture();
    const v8 = structuredClone(project) as unknown as Record<string, unknown>;
    v8.schemaVersion = 8;
    const tracks = v8.tracks as Array<{ clips: Array<Record<string, unknown>> }>;
    delete tracks.at(-1)!.clips[0]!.audioWarp;
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
    expect(migrateProject(v8)).toEqual({ ...v8, schemaVersion: 9 });

    tracks.at(-1)!.clips[0]!.audioWarp = {};
    const smuggled = decodeProject(v8);
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) {
      expect(smuggled.error.issues).toContainEqual(expect.objectContaining({
        path: `tracks[${tracks.length - 1}].clips[0].audioWarp`,
        code: 'unknown-key',
      }));
    }
  });

  it('round-trips exact canonical metadata and rejects malformed endpoint paths', () => {
    const { project, warp } = fixture();
    const encoded = encodeProjectJson(project);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeProject(JSON.parse(encoded.json));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect((decoded.project.tracks.at(-1)!.clips[0] as AudioClip).audioWarp).toEqual(warp);
    }

    const malformed = structuredClone(project);
    const malformedClip = malformed.tracks.at(-1)!.clips[0] as AudioClip;
    malformedClip.audioWarp = {
      ...malformedClip.audioWarp!,
      markers: [
        { sourceFrame: 1, targetBeatOffset: 0 },
        ...malformedClip.audioWarp!.markers.slice(1),
      ],
    };
    const rejected = decodeProject(malformed);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.issues).toContainEqual(expect.objectContaining({
        path: `tracks[${malformed.tracks.length - 1}].clips[0].audioWarp.markers[0].sourceFrame`,
      }));
    }
  });

  it('rejects tempo-split timing segments beyond stretch and 40 ms limits', () => {
    const configureShortWarp = (project: Project, clip: AudioClip): void => {
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
    };

    const threeTimes = fixture();
    configureShortWarp(threeTimes.project, threeTimes.clip);
    threeTimes.project.tempoMap = [
      { id: 'tempo-0', beat: 0, bpm: 120 },
      { id: 'tempo-1', beat: 0.09, bpm: 20 },
    ];
    const threeTimesMessages = validateProject(threeTimes.project).errors.map(
      (error) => error.message,
    );
    expect(threeTimesMessages).toContain(
      'local stretch must be between 0.5x and 2x',
    );
    expect(threeTimesMessages).toContain(
      'source timing intervals must be at least 0.04 seconds',
    );
    expect(threeTimesMessages).toContain(
      'target timing intervals must be at least 0.04 seconds',
    );

    const shortOnly = fixture();
    configureShortWarp(shortOnly.project, shortOnly.clip);
    shortOnly.project.tempoMap = [
      { id: 'tempo-0', beat: 0, bpm: 120 },
      { id: 'tempo-1', beat: 0.099, bpm: 120 },
    ];
    const shortOnlyMessages = validateProject(shortOnly.project).errors.map(
      (error) => error.message,
    );
    expect(shortOnlyMessages).toContain(
      'source timing intervals must be at least 0.04 seconds',
    );
    expect(shortOnlyMessages).toContain(
      'target timing intervals must be at least 0.04 seconds',
    );
    expect(shortOnlyMessages).not.toContain(
      'local stretch must be between 0.5x and 2x',
    );
  });

  it('preserves independent edits through clip lifecycle and fails closed on lossy paths', () => {
    const { project, clip, warp } = fixture();
    const moved = moveAudioClip(project, clip.id, 1, clock);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect((moved.project.tracks.at(-1)!.clips[0] as AudioClip).audioWarp).toEqual(warp);

    const duplicated = duplicateAudioClip(project, clip.id, {
      startBeat: 4,
      id: 'audio-clip-copy',
    }, clock);
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    const duplicateWarp = (duplicated.project.tracks.at(-1)!.clips[1] as AudioClip).audioWarp;
    expect(duplicateWarp).toEqual(warp);
    expect(duplicateWarp).not.toBe(warp);
    expect(duplicateWarp!.markers).not.toBe(warp.markers);

    const leftTrim = trimAudioClipLeft(project, clip.id, 1.5, clock);
    expect(leftTrim.ok).toBe(true);
    if (leftTrim.ok) {
      const trimmed = leftTrim.project.tracks.at(-1)!.clips[0] as AudioClip;
      expect(trimmed.audioWarp?.markers[0]).toEqual({
        sourceFrame: 48_000,
        targetBeatOffset: 0,
      });
    }
    const rightTrim = trimAudioClipRight(project, clip.id, 1.5, clock);
    expect(rightTrim.ok).toBe(true);
    if (rightTrim.ok) {
      const trimmed = rightTrim.project.tracks.at(-1)!.clips[0] as AudioClip;
      expect(trimmed.audioWarp?.markers.at(-1)).toEqual({
        sourceFrame: 48_000,
        targetBeatOffset: 1.5,
      });
    }
    const split = splitAudioClip(project, clip.id, {
      splitBeat: 1.5,
      rightClipId: 'audio-clip-right',
    }, clock);
    expect(split.ok).toBe(true);
    if (split.ok) {
      const clips = split.project.tracks.at(-1)!.clips as AudioClip[];
      expect(clips[0]!.audioWarp?.markers.at(-1)?.sourceFrame).toBe(48_000);
      expect(clips[1]!.audioWarp?.markers[0]?.sourceFrame).toBe(48_000);
    }

    expect(setAudioClipLoop(project, clip.id, true, clock)).toMatchObject({
      ok: false,
      error: { code: 'edited-loop-unsupported' },
    });
    expect(groupAudioClipsIntoTakeFolder(
      duplicated.project,
      [clip.id, 'audio-clip-copy'],
    )).toMatchObject({
      ok: false,
      error: { code: 'edited-clip-unsupported' },
    });
    expect(inspectAudioPunchTarget(project, {
      trackId: clip.trackId,
      punchInBeat: 1,
      punchOutBeat: 2,
    })).toMatchObject({
      ok: false,
      error: { code: 'edited-clip-unsupported' },
    });
  });

  it('right-trims a 0.5x timing stretch at the exact half-source boundary', () => {
    const { project, clip } = fixture();
    clip.lengthBeats = 2;
    clip.audioWarp = {
      ...clip.audioWarp!,
      markers: [
        { sourceFrame: 0, targetBeatOffset: 0 },
        { sourceFrame: 96_000, targetBeatOffset: 2 },
      ],
      pitchRegions: [],
    };

    const result = trimAudioClipRight(project, clip.id, 1, clock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trimmed = result.project.tracks.at(-1)!.clips[0] as AudioClip;
    expect(trimmed).toMatchObject({
      lengthBeats: 1,
      sourceStartFrame: 0,
      sourceFrameCount: 48_000,
    });
    expect(trimmed.audioWarp?.markers.at(-1)).toEqual({
      sourceFrame: 48_000,
      targetBeatOffset: 1,
    });
  });

  it('uses natural-rate source ranges for trim and split while timing warp is disabled', () => {
    const { project, clip } = fixture();
    clip.audioWarp = {
      ...clip.audioWarp!,
      timingEnabled: false,
    };
    const withoutWarp = structuredClone(project);
    const plainClip = withoutWarp.tracks.at(-1)!.clips[0] as AudioClip;
    delete plainClip.audioWarp;

    const warpedLeft = trimAudioClipLeft(project, clip.id, 1, clock);
    const plainLeft = trimAudioClipLeft(withoutWarp, clip.id, 1, clock);
    expect(warpedLeft.ok).toBe(true);
    expect(plainLeft.ok).toBe(true);
    if (!warpedLeft.ok || !plainLeft.ok) return;
    const warpedLeftClip = warpedLeft.project.tracks.at(-1)!.clips[0] as AudioClip;
    const plainLeftClip = plainLeft.project.tracks.at(-1)!.clips[0] as AudioClip;
    expect({
      sourceStartFrame: warpedLeftClip.sourceStartFrame,
      sourceFrameCount: warpedLeftClip.sourceFrameCount,
    }).toEqual({
      sourceStartFrame: plainLeftClip.sourceStartFrame,
      sourceFrameCount: plainLeftClip.sourceFrameCount,
    });
    expect(warpedLeftClip).toMatchObject({
      sourceStartFrame: 24_000,
      sourceFrameCount: 72_000,
    });

    const warpedRight = trimAudioClipRight(project, clip.id, 2, clock);
    const plainRight = trimAudioClipRight(withoutWarp, clip.id, 2, clock);
    expect(warpedRight.ok).toBe(true);
    expect(plainRight.ok).toBe(true);
    if (!warpedRight.ok || !plainRight.ok) return;
    const warpedRightClip = warpedRight.project.tracks.at(-1)!.clips[0] as AudioClip;
    const plainRightClip = plainRight.project.tracks.at(-1)!.clips[0] as AudioClip;
    expect({
      sourceStartFrame: warpedRightClip.sourceStartFrame,
      sourceFrameCount: warpedRightClip.sourceFrameCount,
    }).toEqual({
      sourceStartFrame: plainRightClip.sourceStartFrame,
      sourceFrameCount: plainRightClip.sourceFrameCount,
    });
    expect(warpedRightClip).toMatchObject({
      sourceStartFrame: 0,
      sourceFrameCount: 48_000,
    });

    const warpedSplit = splitAudioClip(project, clip.id, {
      splitBeat: 2,
      rightClipId: 'audio-clip-right-disabled-warp',
    }, clock);
    const plainSplit = splitAudioClip(withoutWarp, clip.id, {
      splitBeat: 2,
      rightClipId: 'audio-clip-right-disabled-warp',
    }, clock);
    expect(warpedSplit.ok).toBe(true);
    expect(plainSplit.ok).toBe(true);
    if (!warpedSplit.ok || !plainSplit.ok) return;
    const warpedClips = warpedSplit.project.tracks.at(-1)!.clips as AudioClip[];
    const plainClips = plainSplit.project.tracks.at(-1)!.clips as AudioClip[];
    expect(warpedClips.map((item) => ({
      sourceStartFrame: item.sourceStartFrame,
      sourceFrameCount: item.sourceFrameCount,
    }))).toEqual(plainClips.map((item) => ({
      sourceStartFrame: item.sourceStartFrame,
      sourceFrameCount: item.sourceFrameCount,
    })));
    expect(warpedClips.map((item) => ({
      sourceStartFrame: item.sourceStartFrame,
      sourceFrameCount: item.sourceFrameCount,
    }))).toEqual([
      { sourceStartFrame: 0, sourceFrameCount: 48_000 },
      { sourceStartFrame: 48_000, sourceFrameCount: 48_000 },
    ]);
  });
});

export { fixture as audioWarpFixture };
