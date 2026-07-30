import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  createEmptyProject,
  createLinearAudioWarp,
  createTrack,
  decodeProject,
  migrateProject,
  type AudioClip,
} from '../src';

function currentProject() {
  const project = createEmptyProject({
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  const track = createTrack('Voice', 'audio');
  const clip: AudioClip = {
    id: 'clip',
    trackId: track.id,
    type: 'audio',
    startBeat: 0,
    lengthBeats: 1,
    loop: false,
    audioAssetId: 'asset',
    sourceStartFrame: 0,
    sourceFrameCount: 48_000,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    gainDb: 0,
    audioWarp: createLinearAudioWarp({
      sourceStartFrame: 0,
      sourceFrameCount: 48_000,
      lengthBeats: 1,
    }),
  };
  track.clips.push(clip);
  project.tracks.push(track);
  project.audioAssets.push({
    id: 'asset',
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: 'voice.wav',
    mediaType: 'audio/wav',
    byteLength: 96_044,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 48_000,
  });
  project.audioRouting.outputs.push({
    sourceTrackId: track.id,
    destination: { type: 'master' },
  });
  return project;
}

function warpRecord(project: ReturnType<typeof currentProject>): Record<string, unknown> {
  return project.tracks.at(-1)!.clips[0]!.audioWarp as unknown as Record<string, unknown>;
}

describe('schema-v10 formantMode', () => {
  it('migrates v9 immutably with off and rejects v9 field smuggling', () => {
    const current = currentProject();
    const v9 = structuredClone(current) as unknown as Record<string, unknown>;
    v9.schemaVersion = 9;
    const legacyWarp = warpRecord(v9 as unknown as ReturnType<typeof currentProject>);
    delete legacyWarp.formantMode;
    const before = structuredClone(v9);

    const migrated = migrateProject(v9);
    expect(CURRENT_SCHEMA_VERSION).toBe(10);
    expect(v9).toEqual(before);
    expect(warpRecord(migrated as unknown as ReturnType<typeof currentProject>).formantMode)
      .toBe('off');

    legacyWarp.formantMode = 'preserve';
    const rejected = decodeProject(v9);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.issues).toContainEqual(expect.objectContaining({
        path: expect.stringContaining('audioWarp.formantMode'),
        code: 'unknown-key',
      }));
    }
  });

  it.each([
    ['missing field', (warp: Record<string, unknown>) => delete warp.formantMode],
    ['unknown value', (warp: Record<string, unknown>) => { warp.formantMode = 'robot'; }],
    ['unknown key', (warp: Record<string, unknown>) => { warp.formantStrength = 1; }],
  ])('rejects v10 %s', (_name, mutate) => {
    const project = currentProject();
    mutate(warpRecord(project));
    expect(decodeProject(project).ok).toBe(false);
  });

  it('defaults only a newly created linear warp to preserve', () => {
    expect(createLinearAudioWarp({
      sourceStartFrame: 12,
      sourceFrameCount: 100,
      lengthBeats: 2,
    }).formantMode).toBe('preserve');
  });
});
