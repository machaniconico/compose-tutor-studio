import { describe, expect, it } from 'vitest';
import {
  MAX_AUDIO_ASSETS,
  MAX_CLIPS_PER_TRACK,
  MAX_PROJECT_TRACKS,
  appendAudioTrackClip,
  createAudioTrackClip,
  createEmptyProject,
  deleteAudioClip,
  duplicateAudioClip,
  encodeProjectJson,
  findClip,
  moveAudioClip,
  resizeClip,
  setAudioClipFades,
  setAudioClipGain,
  setAudioClipLoop,
  splitAudioClip,
  trimAudioClipLeft,
  trimAudioClipRight,
  validateProject,
  type AudioClip,
  type AudioClipIdFactory,
  type AudioClipMutationFailure,
  type Project,
  type ReadyAudioAsset,
  type Track,
} from '../src/index';

const t0 = () => new Date('2026-07-17T00:00:00.000Z');
const t1 = () => new Date('2026-07-17T01:00:00.000Z');

function readyAsset(overrides: Partial<ReadyAudioAsset> = {}): ReadyAudioAsset {
  return {
    id: 'asset-ready',
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: 'reference.wav',
    mediaType: 'audio/wav',
    byteLength: 384_044,
    sampleRate: 48_000,
    channelCount: 2,
    frameCount: 96_000,
    ...overrides,
  };
}

function sequenceFactory(label = 'audio'): AudioClipIdFactory {
  let count = 0;
  return (kind) => `${kind}-${label}-${++count}`;
}

function expectFailure(
  result: Readonly<{ ok: true }> | AudioClipMutationFailure,
  code: AudioClipMutationFailure['error']['code'],
): AudioClipMutationFailure {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected Audio Clip mutation failure');
  expect(result.error.code).toBe(code);
  return result;
}

function audioFixture(options: {
  project?: Project;
  asset?: ReadyAudioAsset;
  startBeat?: number;
  loop?: boolean;
  fadeInFrames?: number;
  fadeOutFrames?: number;
} = {}): { project: Project; track: Track; clip: AudioClip; asset: ReadyAudioAsset } {
  const project = options.project ?? createEmptyProject({ lengthBars: 2, clock: t0 });
  const asset = options.asset ?? readyAsset();
  const result = createAudioTrackClip(project, asset, {
    startBeat: options.startBeat ?? 0,
    loop: options.loop ?? false,
    fadeInFrames: options.fadeInFrames ?? 0,
    fadeOutFrames: options.fadeOutFrames ?? 0,
    idFactory: sequenceFactory('fixture'),
  }, t1);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const located = findClip(result.project, result.clipId);
  if (!located || located.clip.type !== 'audio') throw new Error('Audio Clip fixture missing');
  return {
    project: result.project,
    track: located.track,
    clip: located.clip as AudioClip,
    asset,
  };
}

function variableTempoProject(): Project {
  const project = createEmptyProject({ lengthBars: 2, clock: t0 });
  project.tempoMap = [
    { ...project.tempoMap[0]!, beat: 0, bpm: 120 },
    { id: 'tempo-slow', beat: 4, bpm: 60 },
  ];
  expect(validateProject(project).ok).toBe(true);
  return project;
}

describe('createAudioTrackClip', () => {
  it('atomically adopts ready metadata and inserts a natural-rate Audio Track before Master', () => {
    const project = createEmptyProject({ lengthBars: 1, clock: t0 });
    const before = structuredClone(project);
    const asset = readyAsset();
    const result = createAudioTrackClip(project, asset, {
      startBeat: 0,
      trackName: 'Reference',
      gainDb: -3,
      fadeInFrames: 480,
      fadeOutFrames: 960,
      idFactory: sequenceFactory('create'),
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(project).toEqual(before);
    expect(result).toMatchObject({
      changed: true,
      trackId: 'track-create-1',
      clipId: 'clip-create-2',
      audioAssetId: asset.id,
    });
    const masterIndex = result.project.tracks.findIndex((track) => track.type === 'master');
    const track = result.project.tracks[masterIndex - 1]!;
    expect(track).toMatchObject({
      id: result.trackId,
      name: 'Reference',
      type: 'audio',
      role: 'general',
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    });
    expect(track.clips).toEqual([{
      id: result.clipId,
      trackId: result.trackId,
      type: 'audio',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      audioAssetId: asset.id,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
      fadeInFrames: 480,
      fadeOutFrames: 960,
      gainDb: -3,
    }]);
    expect(result.project.audioAssets.at(-1)).toEqual(asset);
    expect(result.project.updatedAt).toBe('2026-07-17T01:00:00.000Z');
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('projects source seconds through a variable tempo map without time stretching', () => {
    const project = variableTempoProject();
    const result = createAudioTrackClip(project, readyAsset(), {
      startBeat: 3,
      idFactory: sequenceFactory('tempo'),
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clip = findClip(result.project, result.clipId)!.clip;
    // 0.5 s reaches beat 4 at 120 BPM; the remaining 1.5 s reaches beat 5.5 at 60 BPM.
    expect(clip.lengthBeats).toBe(2.5);
    expect(clip.sourceFrameCount).toBe(96_000);
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('adopts an explicit source window and derives its natural length from that window', () => {
    const project = variableTempoProject();
    const result = createAudioTrackClip(project, readyAsset(), {
      startBeat: 3,
      sourceStartFrame: 24_000,
      sourceFrameCount: 48_000,
      fadeInFrames: 12_000,
      fadeOutFrames: 12_000,
      idFactory: sequenceFactory('source-window'),
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project, result.clipId)?.clip).toMatchObject({
      startBeat: 3,
      // The selected second crosses beat 4 after 0.5 s, then advances 0.5 beat at 60 BPM.
      lengthBeats: 1.5,
      sourceStartFrame: 24_000,
      sourceFrameCount: 48_000,
      fadeInFrames: 12_000,
      fadeOutFrames: 12_000,
    });
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('defaults an omitted source count to the ready asset remainder', () => {
    const result = createAudioTrackClip(createEmptyProject({ clock: t0 }), readyAsset(), {
      sourceStartFrame: 24_000,
      idFactory: sequenceFactory('source-remainder'),
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project, result.clipId)?.clip).toMatchObject({
      sourceStartFrame: 24_000,
      sourceFrameCount: 72_000,
      lengthBeats: 3,
    });
  });

  it('rejects empty, fractional and out-of-asset source windows atomically', () => {
    const project = createEmptyProject({ clock: t0 });
    const before = structuredClone(project);
    const invalidRanges = [
      { sourceStartFrame: -1 },
      { sourceStartFrame: 0.5 },
      { sourceStartFrame: 96_000 },
      { sourceFrameCount: 0 },
      { sourceFrameCount: 1.5 },
      { sourceStartFrame: 48_000, sourceFrameCount: 48_001 },
    ] as const;

    for (const range of invalidRanges) {
      expectFailure(
        createAudioTrackClip(project, readyAsset(), range),
        'invalid-source-range',
      );
    }
    expectFailure(
      createAudioTrackClip(project, readyAsset(), {
        sourceFrameCount: 24_000,
        fadeInFrames: 12_001,
        fadeOutFrames: 12_000,
      }),
      'invalid-fades',
    );
    expect(project).toEqual(before);
  });

  it('extends the project to the next active-signature bar boundary', () => {
    const project = createEmptyProject({ lengthBars: 2, clock: t0 });
    project.lengthBeats = 7;
    project.timeSignatureMap = [
      { ...project.timeSignatureMap[0]!, beat: 0, numerator: 4, denominator: 4 },
      { id: 'signature-three-four', beat: 4, numerator: 3, denominator: 4 },
    ];
    project.tracks = project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({ ...clip, lengthBeats: 7 })),
    }));
    expect(validateProject(project).ok).toBe(true);

    const result = createAudioTrackClip(project, readyAsset({ frameCount: 48_000 }), {
      startBeat: 6,
      idFactory: sequenceFactory('bar'),
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project, result.clipId)?.clip).toMatchObject({
      startBeat: 6,
      lengthBeats: 2,
    });
    expect(result.project).toMatchObject({ lengthBars: 3, lengthBeats: 10 });
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('rejects id collisions, hostile factories, invalid metadata and candidate fields atomically', () => {
    const project = createEmptyProject({ clock: t0 });
    const before = structuredClone(project);

    expectFailure(
      createAudioTrackClip(project, readyAsset({ id: project.tempoMap[0]!.id })),
      'duplicate-id',
    );
    expectFailure(
      createAudioTrackClip(project, readyAsset(), { idFactory: () => project.id }),
      'duplicate-id',
    );
    expectFailure(
      createAudioTrackClip(project, readyAsset(), { idFactory: () => { throw new Error('boom'); } }),
      'id-factory-failed',
    );
    expectFailure(
      createAudioTrackClip(project, readyAsset({ checksumSha256: 'not-a-checksum' })),
      'project-not-adoptable',
    );
    expectFailure(
      createAudioTrackClip(project, readyAsset(), { trackName: ' '.repeat(3) }),
      'invalid-track-name',
    );
    expectFailure(
      createAudioTrackClip(project, readyAsset(), { fadeInFrames: 80_000, fadeOutFrames: 80_000 }),
      'invalid-fades',
    );
    expect(project).toEqual(before);
  });

  it('enforces asset, track and project-length limits without partial insertion', () => {
    const assetLimited = createEmptyProject({ clock: t0 });
    assetLimited.audioAssets = Array.from({ length: MAX_AUDIO_ASSETS }, (_, index) =>
      readyAsset({ id: `asset-limit-${index}` }),
    );
    expect(validateProject(assetLimited).ok).toBe(true);
    const assetBefore = structuredClone(assetLimited);
    expectFailure(createAudioTrackClip(assetLimited, readyAsset()), 'audio-asset-limit');
    expect(assetLimited).toEqual(assetBefore);

    const trackLimited = createEmptyProject({ clock: t0 });
    const extraTracks = Array.from(
      { length: MAX_PROJECT_TRACKS - trackLimited.tracks.length },
      (_, index): Track => ({
        id: `limit-track-${index}`,
        name: `Limit ${index}`,
        type: 'audio',
        role: 'general',
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      }),
    );
    trackLimited.tracks = [...trackLimited.tracks, ...extraTracks];
    trackLimited.audioRouting.outputs.push(...extraTracks.map((track) => ({
      sourceTrackId: track.id,
      destination: { type: 'master' as const },
    })));
    expect(validateProject(trackLimited).ok).toBe(true);
    const trackBefore = structuredClone(trackLimited);
    expectFailure(createAudioTrackClip(trackLimited, readyAsset()), 'track-limit');
    expect(trackLimited).toEqual(trackBefore);

    const fixture = audioFixture({ project: createEmptyProject({ lengthBars: 256, clock: t0 }) });
    const lengthBefore = structuredClone(fixture.project);
    expectFailure(moveAudioClip(fixture.project, fixture.clip.id, 1_023, t1), 'project-length-limit');
    expect(fixture.project).toEqual(lengthBefore);
  });
});

describe('appendAudioTrackClip', () => {
  it('adopts one ready asset on an existing Audio Track without creating routing or resetting mixer state', () => {
    const fixture = audioFixture();
    fixture.track.name = 'Armed Vocal';
    fixture.track.color = '#123456';
    fixture.track.volume = 0.7;
    fixture.track.pan = -0.25;
    fixture.track.mute = true;
    fixture.track.solo = true;
    const projectBefore = structuredClone(fixture.project);
    const targetIndex = fixture.project.tracks.findIndex((track) => track.id === fixture.track.id);
    const targetBefore = fixture.project.tracks[targetIndex]!;
    const otherTracksBefore = fixture.project.tracks.filter((track) => track.id !== fixture.track.id);
    const effectsBefore = targetBefore.effects;
    const routingBefore = fixture.project.audioRouting;
    const asset = readyAsset({
      id: 'asset-recorded-take',
      checksumSha256: 'b'.repeat(64),
      originalName: 'recorded-take.wav',
      frameCount: 48_000,
      byteLength: 192_044,
    });

    const result = appendAudioTrackClip(fixture.project, fixture.track.id, asset, {
      startBeat: 5,
      gainDb: -6,
      fadeInFrames: 240,
      fadeOutFrames: 480,
      idFactory: sequenceFactory('append'),
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fixture.project).toEqual(projectBefore);
    expect(result).toMatchObject({
      changed: true,
      trackId: fixture.track.id,
      clipId: 'clip-append-1',
      audioAssetId: asset.id,
    });
    expect(result.project.tracks).toHaveLength(fixture.project.tracks.length);
    expect(result.project.audioRouting).toBe(routingBefore);
    expect(result.project.audioRouting.outputs).toBe(routingBefore.outputs);
    expect(result.project.audioRouting.sends).toBe(routingBefore.sends);
    const appendedTrack = result.project.tracks[targetIndex]!;
    expect(appendedTrack).not.toBe(targetBefore);
    expect(appendedTrack).toMatchObject({
      id: fixture.track.id,
      name: 'Armed Vocal',
      color: '#123456',
      volume: 0.7,
      pan: -0.25,
      mute: true,
      solo: true,
    });
    expect(appendedTrack.effects).toBe(effectsBefore);
    expect(appendedTrack.clips[0]).toBe(targetBefore.clips[0]);
    expect(appendedTrack.clips[1]).toEqual({
      id: result.clipId,
      trackId: fixture.track.id,
      type: 'audio',
      startBeat: 5,
      lengthBeats: 2,
      loop: false,
      audioAssetId: asset.id,
      sourceStartFrame: 0,
      sourceFrameCount: 48_000,
      fadeInFrames: 240,
      fadeOutFrames: 480,
      gainDb: -6,
    });
    for (const otherTrack of otherTracksBefore) {
      expect(result.project.tracks.find((track) => track.id === otherTrack.id)).toBe(otherTrack);
    }
    expect(result.project.audioAssets.slice(0, -1)).toEqual(fixture.project.audioAssets);
    expect(result.project.audioAssets.at(-1)).toBe(asset);
    expect(result.project.updatedAt).toBe('2026-07-17T01:00:00.000Z');
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('uses elapsed seconds across a variable tempo boundary', () => {
    const fixture = audioFixture({ project: variableTempoProject() });
    const asset = readyAsset({
      id: 'asset-variable-tempo-take',
      checksumSha256: 'c'.repeat(64),
    });

    const result = appendAudioTrackClip(fixture.project, fixture.track.id, asset, {
      startBeat: 3,
      idFactory: sequenceFactory('append-tempo'),
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project, result.clipId)?.clip).toMatchObject({
      startBeat: 3,
      // 0.5 s reaches beat 4 at 120 BPM; 1.5 s reaches beat 5.5 at 60 BPM.
      lengthBeats: 2.5,
      sourceFrameCount: 96_000,
    });
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('appends only the requested source window and rejects an overflowing window atomically', () => {
    const fixture = audioFixture({ project: variableTempoProject() });
    const before = structuredClone(fixture.project);
    const asset = readyAsset({
      id: 'asset-source-window-take',
      checksumSha256: 'e'.repeat(64),
    });

    const result = appendAudioTrackClip(fixture.project, fixture.track.id, asset, {
      startBeat: 3,
      sourceStartFrame: 24_000,
      sourceFrameCount: 48_000,
      idFactory: sequenceFactory('append-source-window'),
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fixture.project).toEqual(before);
    expect(findClip(result.project, result.clipId)?.clip).toMatchObject({
      startBeat: 3,
      lengthBeats: 1.5,
      sourceStartFrame: 24_000,
      sourceFrameCount: 48_000,
    });
    expectFailure(
      appendAudioTrackClip(
        fixture.project,
        fixture.track.id,
        readyAsset({ id: 'asset-invalid-source-window-take' }),
        { sourceStartFrame: 95_000, sourceFrameCount: 1_001 },
      ),
      'invalid-source-range',
    );
    expect(fixture.project).toEqual(before);
  });

  it('extends the project to a bar boundary while keeping the existing Track and routing graph', () => {
    const fixture = audioFixture({ project: createEmptyProject({ lengthBars: 1, clock: t0 }) });
    const routingBefore = fixture.project.audioRouting;
    const asset = readyAsset({
      id: 'asset-extension-take',
      checksumSha256: 'd'.repeat(64),
      frameCount: 48_000,
      byteLength: 192_044,
    });

    const result = appendAudioTrackClip(fixture.project, fixture.track.id, asset, {
      startBeat: 5,
      idFactory: sequenceFactory('append-extension'),
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project, result.clipId)?.clip).toMatchObject({
      startBeat: 5,
      lengthBeats: 2,
    });
    expect(result.project).toMatchObject({ lengthBars: 2, lengthBeats: 8 });
    expect(result.project.audioRouting).toBe(routingBefore);
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('rejects missing and non-Audio targets without adopting the asset', () => {
    const project = createEmptyProject({ clock: t0 });
    const before = structuredClone(project);
    const instrument = project.tracks.find((track) => track.type === 'instrument')!;
    const master = project.tracks.find((track) => track.type === 'master')!;

    expectFailure(
      appendAudioTrackClip(project, 'missing-audio-track', readyAsset()),
      'track-not-found',
    );
    expectFailure(
      appendAudioTrackClip(project, instrument.id, readyAsset()),
      'unsupported-track-type',
    );
    expectFailure(
      appendAudioTrackClip(project, master.id, readyAsset()),
      'unsupported-track-type',
    );
    expect(project).toEqual(before);
  });

  it('enforces asset and per-Track clip limits without partial insertion', () => {
    const assetLimited = audioFixture();
    assetLimited.project.audioAssets = [
      assetLimited.asset,
      ...Array.from({ length: MAX_AUDIO_ASSETS - 1 }, (_, index) => readyAsset({
        id: `append-asset-limit-${index}`,
        checksumSha256: index.toString(16).padStart(64, '0'),
      })),
    ];
    expect(validateProject(assetLimited.project).ok).toBe(true);
    const assetBefore = structuredClone(assetLimited.project);
    expectFailure(
      appendAudioTrackClip(
        assetLimited.project,
        assetLimited.track.id,
        readyAsset({ id: 'asset-over-limit' }),
      ),
      'audio-asset-limit',
    );
    expect(assetLimited.project).toEqual(assetBefore);

    const clipLimited = audioFixture();
    clipLimited.track.clips = Array.from({ length: MAX_CLIPS_PER_TRACK }, (_, index) => ({
      ...clipLimited.clip,
      id: index === 0 ? clipLimited.clip.id : `append-clip-limit-${index}`,
    }));
    expect(validateProject(clipLimited.project).ok).toBe(true);
    const clipBefore = structuredClone(clipLimited.project);
    expectFailure(
      appendAudioTrackClip(
        clipLimited.project,
        clipLimited.track.id,
        readyAsset({ id: 'asset-clip-over-limit' }),
      ),
      'clip-limit',
    );
    expect(clipLimited.project).toEqual(clipBefore);
  });

  it('rejects asset and generated Clip id collisions, invalid fields, and timeline overflow atomically', () => {
    const fixture = audioFixture({ project: createEmptyProject({ lengthBars: 256, clock: t0 }) });
    const before = structuredClone(fixture.project);

    expectFailure(
      appendAudioTrackClip(
        fixture.project,
        fixture.track.id,
        readyAsset({ id: fixture.clip.id }),
      ),
      'duplicate-id',
    );
    expectFailure(
      appendAudioTrackClip(
        fixture.project,
        fixture.track.id,
        readyAsset({ id: 'asset-generated-collision' }),
        { idFactory: () => fixture.project.id },
      ),
      'duplicate-id',
    );
    expectFailure(
      appendAudioTrackClip(
        fixture.project,
        fixture.track.id,
        readyAsset({ id: 'asset-hostile-factory' }),
        { idFactory: () => { throw new Error('boom'); } },
      ),
      'id-factory-failed',
    );
    expectFailure(
      appendAudioTrackClip(
        fixture.project,
        fixture.track.id,
        readyAsset({ id: 'asset-invalid-fades' }),
        { fadeInFrames: 80_000, fadeOutFrames: 80_000 },
      ),
      'invalid-fades',
    );
    expectFailure(
      appendAudioTrackClip(
        fixture.project,
        fixture.track.id,
        readyAsset({ id: 'asset-timeline-overflow' }),
        { startBeat: 1_023, idFactory: sequenceFactory('overflow') },
      ),
      'project-length-limit',
    );
    expect(fixture.project).toEqual(before);
  });
});

describe('Audio Clip timeline and source editing', () => {
  it('moves only the timeline window and extends at a bar boundary', () => {
    const fixture = audioFixture({ project: createEmptyProject({ lengthBars: 1, clock: t0 }) });
    const beforeSource = {
      sourceStartFrame: fixture.clip.sourceStartFrame,
      sourceFrameCount: fixture.clip.sourceFrameCount,
    };
    const result = moveAudioClip(fixture.project, fixture.clip.id, 5, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project, fixture.clip.id)?.clip).toMatchObject({
      startBeat: 5,
      lengthBeats: 4,
      ...beforeSource,
    });
    expect(result.project).toMatchObject({ lengthBars: 3, lengthBeats: 12 });
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('left-trims non-looping source at rate 1.0 and can restore available head frames', () => {
    const fixture = audioFixture({ fadeInFrames: 60_000, fadeOutFrames: 20_000 });
    const trimmed = trimAudioClipLeft(fixture.project, fixture.clip.id, 1, t1);

    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    expect(findClip(trimmed.project, fixture.clip.id)?.clip).toMatchObject({
      startBeat: 1,
      lengthBeats: 3,
      sourceStartFrame: 24_000,
      sourceFrameCount: 72_000,
      // Preserve the far outer fade first, then clamp the new left-edge fade.
      fadeInFrames: 52_000,
      fadeOutFrames: 20_000,
    });

    const restored = trimAudioClipLeft(trimmed.project, fixture.clip.id, 0, t1);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(findClip(restored.project, fixture.clip.id)?.clip).toMatchObject({
      startBeat: 0,
      lengthBeats: 4,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
    });
    expect(validateProject(restored.project).ok).toBe(true);
  });

  it('right-trims non-looping source in frames and restores it only to the asset tail', () => {
    const fixture = audioFixture({ fadeInFrames: 20_000, fadeOutFrames: 60_000 });
    const shortened = trimAudioClipRight(fixture.project, fixture.clip.id, 3, t1);

    expect(shortened.ok).toBe(true);
    if (!shortened.ok) return;
    expect(findClip(shortened.project, fixture.clip.id)?.clip).toMatchObject({
      lengthBeats: 3,
      sourceFrameCount: 72_000,
      fadeInFrames: 20_000,
      fadeOutFrames: 52_000,
    });
    const restored = trimAudioClipRight(shortened.project, fixture.clip.id, 4, t1);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(findClip(restored.project, fixture.clip.id)?.clip.sourceFrameCount).toBe(96_000);
    const silentTail = trimAudioClipRight(restored.project, fixture.clip.id, 5, t1);
    expect(silentTail.ok).toBe(true);
    if (!silentTail.ok) return;
    expect(findClip(silentTail.project, fixture.clip.id)?.clip).toMatchObject({
      lengthBeats: 5,
      sourceFrameCount: 96_000,
    });
    expect(validateProject(silentTail.project).ok).toBe(true);
  });

  it('trims a non-looping silent tail without cutting audible source frames', () => {
    const fixture = audioFixture({ project: variableTempoProject() });
    const moved = moveAudioClip(fixture.project, fixture.clip.id, 4, t1);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    const tailTrimmed = trimAudioClipRight(moved.project, fixture.clip.id, 7, t1);
    expect(tailTrimmed.ok).toBe(true);
    if (!tailTrimmed.ok) return;
    expect(findClip(tailTrimmed.project, fixture.clip.id)?.clip).toMatchObject({
      startBeat: 4,
      lengthBeats: 3,
      sourceFrameCount: 96_000,
    });

    const audibleTrimmed = trimAudioClipRight(tailTrimmed.project, fixture.clip.id, 5, t1);
    expect(audibleTrimmed.ok).toBe(true);
    if (!audibleTrimmed.ok) return;
    expect(findClip(audibleTrimmed.project, fixture.clip.id)?.clip.sourceFrameCount).toBe(48_000);

    const restored = trimAudioClipRight(audibleTrimmed.project, fixture.clip.id, 7, t1);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(findClip(restored.project, fixture.clip.id)?.clip.sourceFrameCount).toBe(96_000);
  });

  it('uses variable-tempo elapsed seconds for both trim edges', () => {
    const fixture = audioFixture({ project: variableTempoProject(), startBeat: 3 });
    expect(fixture.clip.lengthBeats).toBe(2.5);

    const left = trimAudioClipLeft(fixture.project, fixture.clip.id, 4, t1);
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(findClip(left.project, fixture.clip.id)?.clip).toMatchObject({
      startBeat: 4,
      lengthBeats: 1.5,
      sourceStartFrame: 24_000,
      sourceFrameCount: 72_000,
    });

    const rightFixture = audioFixture({ project: variableTempoProject(), startBeat: 3 });
    const right = trimAudioClipRight(rightFixture.project, rightFixture.clip.id, 5, t1);
    expect(right.ok).toBe(true);
    if (!right.ok) return;
    expect(findClip(right.project, rightFixture.clip.id)?.clip).toMatchObject({
      lengthBeats: 2,
      sourceFrameCount: 72_000,
    });
  });

  it('keeps loop source range stable for right trim and rejects phase-unsafe left trim', () => {
    const fixture = audioFixture({
      project: createEmptyProject({ lengthBars: 1, clock: t0 }),
      loop: true,
      fadeInFrames: 60_000,
      fadeOutFrames: 20_000,
    });
    const shortened = trimAudioClipRight(fixture.project, fixture.clip.id, 1, t1);
    expect(shortened.ok).toBe(true);
    if (!shortened.ok) return;
    expect(findClip(shortened.project, fixture.clip.id)?.clip).toMatchObject({
      loop: true,
      lengthBeats: 1,
      sourceFrameCount: 96_000,
      fadeInFrames: 24_000,
      fadeOutFrames: 0,
    });

    const extended = trimAudioClipRight(shortened.project, fixture.clip.id, 10, t1);
    expect(extended.ok).toBe(true);
    if (!extended.ok) return;
    expect(findClip(extended.project, fixture.clip.id)?.clip).toMatchObject({
      loop: true,
      lengthBeats: 10,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
    });
    expect(extended.project).toMatchObject({ lengthBars: 3, lengthBeats: 12 });
    expectFailure(
      trimAudioClipLeft(extended.project, fixture.clip.id, 1, t1),
      'looped-left-trim-unsupported',
    );
  });

  it('preserves persisted fades across variable-tempo move and independent copy', () => {
    const project = createEmptyProject({ lengthBars: 2, clock: t0 });
    project.tempoMap = [
      { ...project.tempoMap[0]!, beat: 0, bpm: 120 },
      { id: 'tempo-fast', beat: 4, bpm: 240 },
    ];
    const fixture = audioFixture({
      project,
      fadeInFrames: 40_000,
      fadeOutFrames: 40_000,
    });
    const moved = moveAudioClip(fixture.project, fixture.clip.id, 4, t1);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(findClip(moved.project, fixture.clip.id)?.clip).toMatchObject({
      fadeInFrames: 40_000,
      fadeOutFrames: 40_000,
    });

    const copied = duplicateAudioClip(moved.project, fixture.clip.id, {
      startBeat: 0,
      id: 'fade-preserving-copy',
    }, t1);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(findClip(copied.project, 'fade-preserving-copy')?.clip).toMatchObject({
      fadeInFrames: 40_000,
      fadeOutFrames: 40_000,
    });
  });

  it('sets bounded gain, fades and loop state with no-op identity', () => {
    const fixture = audioFixture();
    const gain = setAudioClipGain(fixture.project, fixture.clip.id, -12, t1);
    expect(gain.ok).toBe(true);
    if (!gain.ok) return;
    expect(findClip(gain.project, fixture.clip.id)?.clip.gainDb).toBe(-12);
    const gainNoop = setAudioClipGain(gain.project, fixture.clip.id, -12, t1);
    expect(gainNoop).toMatchObject({ ok: true, changed: false, project: gain.project });
    expectFailure(setAudioClipGain(gain.project, fixture.clip.id, 25, t1), 'invalid-gain');

    const fades = setAudioClipFades(gain.project, fixture.clip.id, {
      fadeInFrames: 24_000,
      fadeOutFrames: 48_000,
    }, t1);
    expect(fades.ok).toBe(true);
    if (!fades.ok) return;
    expect(findClip(fades.project, fixture.clip.id)?.clip).toMatchObject({
      fadeInFrames: 24_000,
      fadeOutFrames: 48_000,
    });
    expectFailure(setAudioClipFades(fades.project, fixture.clip.id, {
      fadeInFrames: 48_001,
      fadeOutFrames: 48_000,
    }), 'invalid-fades');

    const looped = setAudioClipLoop(fades.project, fixture.clip.id, true, t1);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;
    expect(findClip(looped.project, fixture.clip.id)?.clip.loop).toBe(true);
    expect(validateProject(looped.project).ok).toBe(true);
  });

  it('rejects invalid input projects and generic audio resize without mutation', () => {
    const fixture = audioFixture();
    const before = structuredClone(fixture.project);
    expect(resizeClip(fixture.project, fixture.clip.id, { lengthBeats: 2 }, t1)).toEqual({
      ok: false,
      reason: 'unsupported-audio-clip',
    });
    expect(fixture.project).toEqual(before);

    const invalid = structuredClone(fixture.project);
    invalid.lengthBars = 0;
    const invalidBefore = structuredClone(invalid);
    expectFailure(moveAudioClip(invalid, fixture.clip.id, 1, t1), 'project-not-adoptable');
    expect(invalid).toEqual(invalidBefore);
  });

  it('rejects non-looping trim movements smaller than one source frame', () => {
    const fixture = audioFixture();
    expectFailure(
      trimAudioClipLeft(fixture.project, fixture.clip.id, 0.000_000_01, t1),
      'invalid-source-range',
    );
    expectFailure(
      trimAudioClipRight(fixture.project, fixture.clip.id, 3.999_999_99, t1),
      'invalid-source-range',
    );
  });
});

describe('Audio Clip split, duplicate and delete', () => {
  it('splits source ranges and keeps fades only at the two original outer edges', () => {
    const fixture = audioFixture({ fadeInFrames: 1_000, fadeOutFrames: 2_000 });
    const before = structuredClone(fixture.project);
    const result = splitAudioClip(fixture.project, fixture.clip.id, {
      splitBeat: 1,
      rightClipId: 'audio-right',
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fixture.project).toEqual(before);
    expect(result.rightClipId).toBe('audio-right');
    const track = result.project.tracks.find((candidate) => candidate.id === fixture.track.id)!;
    expect(track.clips).toEqual([
      expect.objectContaining({
        id: fixture.clip.id,
        startBeat: 0,
        lengthBeats: 1,
        sourceStartFrame: 0,
        sourceFrameCount: 24_000,
        fadeInFrames: 1_000,
        fadeOutFrames: 0,
      }),
      expect.objectContaining({
        id: 'audio-right',
        startBeat: 1,
        lengthBeats: 3,
        sourceStartFrame: 24_000,
        sourceFrameCount: 72_000,
        fadeInFrames: 0,
        fadeOutFrames: 2_000,
      }),
    ]);
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('rejects looped, silent-tail, colliding and over-limit splits atomically', () => {
    const looped = audioFixture({ loop: true });
    expectFailure(
      splitAudioClip(looped.project, looped.clip.id, { splitBeat: 1 }),
      'looped-split-unsupported',
    );

    const tempoProject = variableTempoProject();
    const movedFixture = audioFixture({ project: tempoProject });
    const moved = moveAudioClip(movedFixture.project, movedFixture.clip.id, 4, t1);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    // Four beats at 60 BPM is a 4-second window over a 2-second source.
    expectFailure(
      splitAudioClip(moved.project, movedFixture.clip.id, { splitBeat: 7 }),
      'invalid-source-range',
    );

    const fixture = audioFixture();
    expectFailure(splitAudioClip(fixture.project, fixture.clip.id, {
      splitBeat: 1,
      rightClipId: fixture.asset.id,
    }), 'duplicate-id');

    const fullTrack = fixture.project.tracks.find((track) => track.id === fixture.track.id)!;
    fullTrack.clips = Array.from({ length: MAX_CLIPS_PER_TRACK }, (_, index) => ({
      ...fixture.clip,
      id: index === 0 ? fixture.clip.id : `full-clip-${index}`,
    }));
    expect(validateProject(fixture.project).ok).toBe(true);
    const before = structuredClone(fixture.project);
    expectFailure(
      splitAudioClip(fixture.project, fixture.clip.id, { splitBeat: 1 }),
      'clip-limit',
    );
    expect(fixture.project).toEqual(before);
  });

  it('duplicates independently while sharing immutable asset metadata and extending the song', () => {
    const fixture = audioFixture({ project: createEmptyProject({ lengthBars: 1, clock: t0 }) });
    const result = duplicateAudioClip(fixture.project, fixture.clip.id, {
      startBeat: 6,
      id: 'audio-copy',
    }, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const original = findClip(result.project, fixture.clip.id)!.clip;
    const copy = findClip(result.project, 'audio-copy')!.clip;
    expect(copy).toEqual({ ...original, id: 'audio-copy', startBeat: 6 });
    expect(copy.aliasOf).toBeUndefined();
    expect(result.project.audioAssets).toEqual([fixture.asset]);
    expect(result.project).toMatchObject({ lengthBars: 3, lengthBeats: 12 });
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('deletes only the clip and prunes its now-unreferenced asset metadata', () => {
    const fixture = audioFixture();
    const result = deleteAudioClip(fixture.project, fixture.clip.id, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.tracks.find((track) => track.id === fixture.track.id)?.clips).toEqual([]);
    expect(result.project.audioAssets).toEqual([]);
    expect(validateProject(result.project).ok).toBe(true);
    expect(encodeProjectJson(result.project).ok).toBe(true);
    expectFailure(deleteAudioClip(result.project, fixture.clip.id, t1), 'clip-not-found');
  });

  it('retains shared asset metadata until the last Audio Clip reference is deleted', () => {
    const fixture = audioFixture();
    const duplicated = duplicateAudioClip(fixture.project, fixture.clip.id, {
      startBeat: 4,
      id: 'shared-audio-copy',
    }, t1);
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;

    const firstDelete = deleteAudioClip(duplicated.project, fixture.clip.id, t1);
    expect(firstDelete.ok).toBe(true);
    if (!firstDelete.ok) return;
    expect(firstDelete.project.audioAssets).toEqual([fixture.asset]);
    expect(findClip(firstDelete.project, 'shared-audio-copy')).not.toBeNull();

    const lastDelete = deleteAudioClip(firstDelete.project, 'shared-audio-copy', t1);
    expect(lastDelete.ok).toBe(true);
    if (!lastDelete.ok) return;
    expect(lastDelete.project.audioAssets).toEqual([]);
    expect(validateProject(lastDelete.project).ok).toBe(true);
  });

  it('can delete a valid unresolved legacy Audio Clip without requiring decoded bytes', () => {
    const fixture = audioFixture();
    const unresolved: Project = {
      ...fixture.project,
      audioAssets: [{
        id: fixture.asset.id,
        availability: 'unresolved',
        reason: 'missing-reference',
      }],
      tracks: fixture.project.tracks.map((track) => ({
        ...track,
        ...(track.id === fixture.track.id ? { type: 'instrument' as const } : {}),
        clips: track.clips.map((clip) =>
          clip.id === fixture.clip.id
            ? {
                ...clip,
                sourceStartFrame: 0,
                sourceFrameCount: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
              }
            : clip,
        ),
      })),
    };
    expect(validateProject(unresolved).ok).toBe(true);

    const result = deleteAudioClip(unresolved, fixture.clip.id, t1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.tracks.find((track) => track.id === fixture.track.id)?.clips).toEqual([]);
    expect(result.project.audioAssets).toEqual([]);
    expect(validateProject(result.project).ok).toBe(true);
    expect(encodeProjectJson(result.project).ok).toBe(true);
  });
});
