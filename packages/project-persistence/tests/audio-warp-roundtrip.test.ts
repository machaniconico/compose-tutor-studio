import { describe, expect, it } from 'vitest';
import { createTrack, type AudioClip } from '@cts/project-model';
import { LocalStorageProjectRepository, type SaveRequest } from '../src';
import { makeProject, TestStorage } from './helpers';

describe('Audio Warp persistence', () => {
  it('survives browser save-close-reopen-load exactly', async () => {
    const storage = new TestStorage();
    const project = makeProject('Audio Warp roundtrip');
    const track = createTrack('Voice', 'audio');
    const clip: AudioClip = {
      id: 'warp-clip',
      trackId: track.id,
      type: 'audio',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      audioAssetId: 'warp-asset',
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      gainDb: 0,
      audioWarp: {
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
      },
    };
    track.clips.push(clip);
    project.tracks.push(track);
    project.audioAssets.push({
      id: 'warp-asset',
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
    const request: SaveRequest = {
      project,
      activationId: 'activation-warp',
      revision: 1,
      writeId: 'write-warp',
      expectedHeadVersion: null,
    };
    const writer = new LocalStorageProjectRepository({ storage });
    await expect(writer.initialize()).resolves.toMatchObject({ ok: true });
    await expect(writer.save(request)).resolves.toMatchObject({ ok: true });

    const reopened = new LocalStorageProjectRepository({ storage });
    await expect(reopened.initialize()).resolves.toMatchObject({ ok: true });
    const loaded = await reopened.load(project.id);
    expect(loaded).toMatchObject({ ok: true, value: expect.any(Object) });
    if (loaded.ok && loaded.value !== null) {
      const loadedClip = loaded.value.project.tracks.at(-1)!.clips[0] as AudioClip;
      expect(loadedClip.audioWarp).toEqual(clip.audioWarp);
    }
  });
});
