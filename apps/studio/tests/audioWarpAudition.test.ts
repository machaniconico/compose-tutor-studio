import { describe, expect, it } from 'vitest';
import {
  createAudioTrackClip,
  type AudioClip,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { projectForAudioWarpAudition } from '../src/audio/audioWarpAudition';
import { compileAudioWarpRenderRequestIndex } from '../src/audio/audioWarpPlan';
import { createDefaultProject } from '../src/state/defaultProject';

const asset: ReadyAudioAsset = {
  id: 'asset-audition',
  availability: 'ready',
  checksumSha256: 'a'.repeat(64),
  originalName: 'audition.wav',
  mediaType: 'audio/wav',
  byteLength: 96_044,
  sampleRate: 48_000,
  channelCount: 1,
  frameCount: 48_000,
};

function fixture(): Readonly<{ project: Project; clip: AudioClip }> {
  const created = createAudioTrackClip(createDefaultProject('A/B audition'), asset, {
    idFactory: (kind) => `${kind}-audition`,
  });
  if (!created.ok) throw new Error(created.error.code);
  const project: Project = {
    ...created.project,
    tracks: created.project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => clip.id !== created.clipId
        ? clip
        : {
            ...clip,
            audioWarp: {
              algorithm: 'wsola-v1',
              timingEnabled: true,
              pitchEnabled: true,
              markers: [
                { sourceFrame: 0, targetBeatOffset: 0 },
                { sourceFrame: 24_000, targetBeatOffset: 0.75 },
                { sourceFrame: 48_000, targetBeatOffset: 2 },
              ],
              pitchRegions: [{
                sourceStartFrame: 4_800,
                sourceFrameCount: 19_200,
                sourcePitchCents: 6_930,
                targetPitchCents: 7_000,
                correctionAmount: 0.75,
                transitionFrames: 480,
              }],
            },
          }),
    })),
  };
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate): candidate is AudioClip =>
      candidate.id === created.clipId && candidate.type === 'audio');
  if (!clip) throw new Error('audio clip missing');
  return { project, clip };
}

describe('runtime Elastic Audio A/B audition', () => {
  it('bypasses only pitch correction while preserving timing and input identity', () => {
    const { project, clip } = fixture();
    const audition = projectForAudioWarpAudition(project, clip.id);
    const auditionClip = audition.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clip.id);

    expect(audition).not.toBe(project);
    expect(auditionClip?.audioWarp).toMatchObject({
      timingEnabled: true,
      pitchEnabled: false,
      markers: clip.audioWarp?.markers,
      pitchRegions: clip.audioWarp?.pitchRegions,
    });
    expect(clip.audioWarp?.pitchEnabled).toBe(true);
    expect(projectForAudioWarpAudition(project, 'missing-clip')).toBe(project);
    expect(projectForAudioWarpAudition(project, null)).toBe(project);
  });

  it('keeps the production timing plan exact and removes only compiled pitch work', () => {
    const { project, clip } = fixture();
    const corrected = compileAudioWarpRenderRequestIndex(project).byClipId.get(clip.id);
    const beforePitch = compileAudioWarpRenderRequestIndex(
      projectForAudioWarpAudition(project, clip.id),
    ).byClipId.get(clip.id);

    expect(corrected).toBeDefined();
    expect(beforePitch).toBeDefined();
    expect(beforePitch?.knots).toEqual(corrected?.knots);
    expect(beforePitch?.outputFrameCount).toBe(corrected?.outputFrameCount);
    expect(corrected?.pitchRegions).toHaveLength(1);
    expect(beforePitch?.pitchRegions).toEqual([]);
    expect(beforePitch?.cacheKey).not.toBe(corrected?.cacheKey);
  });
});
