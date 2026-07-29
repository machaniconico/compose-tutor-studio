import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  barToBeatAt,
  beatToBarPosition,
  beatToSecondsAt,
  compileMusicalTime,
  createEmptyProject,
  createTrack,
  decodeProject,
  encodeProjectJson,
  migrateProject,
  secondsBetweenBeats,
  secondsToBeatAt,
  validateProject,
  type Project,
} from '../src/index';

const clock = () => new Date('2026-07-16T00:00:00.000Z');

function toLegacyRecord(project: Project, schemaVersion: 1 | 2): Record<string, unknown> {
  const legacy = structuredClone(project) as unknown as Record<string, unknown>;
  legacy.schemaVersion = schemaVersion;
  delete legacy.lengthBeats;
  delete legacy.tempoMap;
  delete legacy.timeSignatureMap;
  delete legacy.audioAssets;
  delete legacy.audioTakeFolders;
  delete legacy.automationLanes;
  delete legacy.automationReadState;
  delete legacy.audioRouting;
  for (const track of legacy.tracks as Array<Record<string, unknown>>) {
    delete track.role;
    for (const clip of track.clips as Array<Record<string, unknown>>) {
      delete clip.sourceStartFrame;
      delete clip.sourceFrameCount;
      delete clip.fadeInFrames;
      delete clip.fadeOutFrames;
      delete clip.gainDb;
    }
  }
  return legacy;
}

describe('schema-v3 migration', () => {
  it.each(['Chord', 'Chords', 'コード'])(
    'preserves the legacy %s chord-backing route as the semantic chords role',
    (legacyName) => {
      const source = createEmptyProject({ clock });
      const chordTrack = source.tracks.find((track) => track.role === 'learning.chords');
      if (!chordTrack) throw new Error('Chords fixture missing');
      chordTrack.name = legacyName;

      const decoded = decodeProject(toLegacyRecord(source, 2));

      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.project.tracks.find((track) => track.id === chordTrack.id)?.role)
        .toBe('learning.chords');
    },
  );

  it('deterministically assigns roles, collision-free ids, and unresolved legacy audio assets', () => {
    const source = createEmptyProject({ clock });
    const originalMelody = source.tracks.find((track) => track.role === 'learning.melody');
    if (!originalMelody) throw new Error('Melody fixture missing');
    const earlierMelody = structuredClone(originalMelody);
    earlierMelody.id = 'legacy-earlier-melody';
    earlierMelody.name = '  mElOdY\n';
    earlierMelody.clips = earlierMelody.clips.map((clip, index) => ({
      ...clip,
      id: `legacy-earlier-melody-clip-${index}`,
      trackId: earlierMelody.id,
    }));
    source.tracks.splice(source.tracks.indexOf(originalMelody), 0, earlierMelody);

    const audioOwner = source.tracks[0]!;
    audioOwner.clips.push(
      {
        id: 'legacy-audio-shared-a',
        trackId: audioOwner.id,
        type: 'audio',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        audioAssetId: 'legacy-song.wav',
      },
      {
        id: 'legacy-audio-shared-b',
        trackId: audioOwner.id,
        type: 'audio',
        startBeat: 4,
        lengthBeats: 4,
        loop: false,
        audioAssetId: 'legacy-song.wav',
      },
      {
        id: 'legacy-audio-missing',
        trackId: audioOwner.id,
        type: 'audio',
        startBeat: 8,
        lengthBeats: 4,
        loop: false,
      },
      {
        id: 'legacy-audio-empty',
        trackId: audioOwner.id,
        type: 'audio',
        startBeat: 12,
        lengthBeats: 4,
        loop: false,
        audioAssetId: '',
      },
    );
    source.sections = [
      { id: 'migrated-tempo-1', name: 'A', type: 'verse', startBar: 0, lengthBars: 1 },
      { id: 'migrated-signature-1', name: 'B', type: 'chorus', startBar: 1, lengthBars: 1 },
      { id: 'migrated-audio-1', name: 'C', type: 'bridge', startBar: 2, lengthBars: 1 },
    ];

    const legacy = toLegacyRecord(source, 2);
    const untouched = structuredClone(legacy);
    const first = migrateProject(legacy);
    const second = migrateProject(legacy);

    expect(first).toEqual(second);
    expect(legacy).toEqual(untouched);
    expect(first).toMatchObject({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lengthBeats: 32,
      tempoMap: [{ id: 'migrated-tempo-2', beat: 0, bpm: 120 }],
      timeSignatureMap: [{
        id: 'migrated-signature-2',
        beat: 0,
        numerator: 4,
        denominator: 4,
      }],
      automationLanes: [],
      audioTakeFolders: [],
      audioRouting: expect.objectContaining({ sends: [] }),
    });

    const migratedTracks = first.tracks as Array<Record<string, unknown>>;
    expect(migratedTracks.find((track) => track.id === earlierMelody.id)?.role)
      .toBe('learning.melody');
    expect(migratedTracks.find((track) => track.id === originalMelody.id)?.role)
      .toBe('general');

    const assets = first.audioAssets as Array<Record<string, unknown>>;
    expect(assets).toEqual([
      {
        id: 'migrated-audio-2',
        availability: 'unresolved',
        legacyAssetId: 'legacy-song.wav',
        reason: 'legacy-reference',
      },
      {
        id: 'migrated-audio-3',
        availability: 'unresolved',
        reason: 'missing-reference',
      },
      {
        id: 'migrated-audio-4',
        availability: 'unresolved',
        reason: 'missing-reference',
      },
    ]);
    const migratedOwner = migratedTracks.find((track) => track.id === audioOwner.id)!;
    const audioClips = (migratedOwner.clips as Array<Record<string, unknown>>)
      .filter((clip) => clip.type === 'audio');
    expect(audioClips.map((clip) => clip.audioAssetId)).toEqual([
      'migrated-audio-2',
      'migrated-audio-2',
      'migrated-audio-3',
      'migrated-audio-4',
    ]);
    expect(audioClips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceStartFrame: 0,
        sourceFrameCount: 0,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      }),
    ]));

    const decoded = decodeProject(legacy);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded).toMatchObject({ sourceSchemaVersion: 2, migrated: true });
      expect(validateProject(decoded.project).ok).toBe(true);
    }
  });

  it('rejects v3 fields smuggled into a declared v2 payload', () => {
    const legacy = toLegacyRecord(createEmptyProject({ clock }), 2);
    legacy.tempoMap = [];
    const decoded = decodeProject(legacy);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.issues).toContainEqual({
        path: 'tempoMap',
        code: 'unknown-key',
        message: 'unknown property',
      });
    }
  });

  it('rejects explicit null for required v3 scalars and collections', () => {
    const input = structuredClone(createEmptyProject({ clock })) as unknown as Record<string, unknown>;
    input.lengthBeats = null;
    input.automationLanes = null;
    const tracks = input.tracks as Array<Record<string, unknown>>;
    tracks[0]!.role = null;

    const decoded = decodeProject(input);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'lengthBeats', code: 'invalid-type' }),
        expect.objectContaining({ path: 'automationLanes', code: 'invalid-type' }),
        expect.objectContaining({ path: 'tracks[0].role', code: 'invalid-type' }),
      ]));
    }
  });
});

describe('schema-v3 audio and automation', () => {
  function projectWithReadyAudio(): Project {
    const project = createEmptyProject({ clock });
    const audio = createTrack('Reference', 'audio');
    audio.clips.push({
      id: 'ready-audio-clip',
      trackId: audio.id,
      type: 'audio',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      audioAssetId: 'ready-audio-asset',
      sourceStartFrame: 4_800,
      sourceFrameCount: 48_000,
      fadeInFrames: 480,
      fadeOutFrames: 960,
      gainDb: -3,
    });
    project.audioAssets.push({
      id: 'ready-audio-asset',
      availability: 'ready',
      checksumSha256: 'a'.repeat(64),
      originalName: 'reference.wav',
      mediaType: 'audio/wav',
      byteLength: 211_200,
      sampleRate: 48_000,
      channelCount: 2,
      frameCount: 96_000,
    });
    project.tracks.splice(project.tracks.length - 1, 0, audio);
    project.audioRouting.outputs.push({
      sourceTrackId: audio.id,
      destination: { type: 'master' },
    });
    return project;
  }

  it('round-trips a bounded ready asset and requires every audio-clip field', () => {
    const project = projectWithReadyAudio();
    expect(validateProject(project).ok).toBe(true);
    const encoded = encodeProjectJson(project);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeProject(JSON.parse(encoded.json) as unknown);
    expect(decoded.ok && decoded.project).toEqual(project);

    const missing = JSON.parse(encoded.json) as Record<string, unknown>;
    const tracks = missing.tracks as Array<Record<string, unknown>>;
    const audioTrack = tracks.find((track) => track.type === 'audio')!;
    delete (audioTrack.clips as Array<Record<string, unknown>>)[0]!.fadeOutFrames;
    const rejected = decodeProject(missing);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining('fadeOutFrames'),
          code: 'required',
        }),
      ]));
    }
  });

  it('enforces ready ranges but permits zero-range unresolved clips on a legacy track type', () => {
    const invalid = projectWithReadyAudio();
    const audioTrack = invalid.tracks.find((track) => track.type === 'audio')!;
    audioTrack.type = 'instrument';
    audioTrack.clips[0]!.sourceFrameCount = 100_000;
    audioTrack.clips[0]!.fadeInFrames = 80_000;
    audioTrack.clips[0]!.fadeOutFrames = 80_000;
    const invalidResult = validateProject(invalid);
    expect(invalidResult.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('only be used on audio tracks') }),
      expect.objectContaining({ message: expect.stringContaining('fit within the asset') }),
      expect.objectContaining({ message: expect.stringContaining('combined fades') }),
    ]));

    const unresolved = projectWithReadyAudio();
    const legacyTrack = unresolved.tracks.find((track) => track.type === 'audio')!;
    legacyTrack.type = 'instrument';
    const clip = legacyTrack.clips[0]!;
    clip.sourceStartFrame = 0;
    clip.sourceFrameCount = 0;
    clip.fadeInFrames = 0;
    clip.fadeOutFrames = 0;
    unresolved.audioAssets = [{
      id: 'ready-audio-asset',
      availability: 'unresolved',
      reason: 'missing-reference',
    }];
    expect(validateProject(unresolved).ok).toBe(true);
  });

  it('validates automation target references, ordering, and parameter bounds', () => {
    const project = createEmptyProject({ clock });
    const target = project.tracks[0]!;
    project.automationLanes = [{
      id: 'volume-lane',
      bypassed: false,
      target: { type: 'track-volume', trackId: target.id },
      points: [
        { id: 'volume-point-a', beat: 2, value: 0.5, interpolation: 'hold' },
        { id: 'volume-point-b', beat: 8, value: 1.5, interpolation: 'linear' },
      ],
    }];
    expect(validateProject(project).ok).toBe(true);
    expect(encodeProjectJson(project).ok).toBe(true);

    project.automationLanes[0]!.target.trackId = 'missing-track';
    project.automationLanes[0]!.points[1]!.beat = 1;
    project.automationLanes[0]!.points[1]!.value = 3;
    expect(validateProject(project).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'automationLanes[0].target.trackId' }),
      expect.objectContaining({ path: 'automationLanes[0].points[1].beat' }),
      expect.objectContaining({ path: 'automationLanes[0].points[1].value' }),
    ]));
  });

  it('rejects Master automation because schema-v3 playback exposes Track automation only', () => {
    const project = createEmptyProject({ clock });
    const master = project.tracks.find((track) => track.type === 'master');
    if (!master) throw new Error('Master fixture missing');
    project.automationLanes = [{
      id: 'master-volume-lane',
      bypassed: false,
      target: { type: 'track-volume', trackId: master.id },
      points: [{ id: 'master-volume-point', beat: 0, value: 0.5, interpolation: 'hold' }],
    }];

    expect(validateProject(project).errors).toContainEqual(expect.objectContaining({
      path: 'automationLanes[0].target.trackId',
      message: 'automation cannot target a Master track',
    }));
    expect(encodeProjectJson(project).ok).toBe(false);
  });
});

describe('schema-v3 musical time maps', () => {
  it('converts tempo segments and actual variable-signature bars through an immutable index', () => {
    const project = createEmptyProject({ clock, lengthBars: 4 });
    project.lengthBeats = 14;
    project.lengthBars = 4;
    project.tracks.forEach((track) => {
      track.clips.forEach((clip) => {
        clip.lengthBeats = 14;
      });
    });
    project.tempoMap = [
      { ...project.tempoMap[0]!, beat: 0, bpm: 120 },
      { id: 'tempo-slow', beat: 4, bpm: 60 },
    ];
    project.timeSignatureMap = [
      { ...project.timeSignatureMap[0]!, beat: 0, numerator: 4, denominator: 4 },
      { id: 'signature-three-four', beat: 8, numerator: 3, denominator: 4 },
    ];
    project.automationLanes = [{
      id: 'map-aware-pan',
      bypassed: false,
      target: { type: 'track-pan', trackId: project.tracks[0]!.id },
      points: [{ id: 'map-aware-pan-point', beat: 9, value: -0.25, interpolation: 'linear' }],
    }];

    expect(validateProject(project).ok).toBe(true);
    const index = compileMusicalTime(project);
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.tempoSegments)).toBe(true);
    expect(beatToSecondsAt(index, 10)).toBe(8);
    expect(secondsToBeatAt(index, 8)).toBe(10);
    expect(secondsBetweenBeats(index, 2, 6)).toBe(3);
    expect([0, 1, 2, 3, 4].map((bar) => barToBeatAt(index, bar)))
      .toEqual([0, 4, 8, 11, 14]);
    expect(beatToBarPosition(index, 9)).toEqual({
      bar: 2,
      beatInBar: 1,
      timeSignature: [3, 4],
    });
    expect(() => barToBeatAt(index, 2.5)).toThrow(RangeError);

    const inconsistent = { ...project, lengthBars: 5 };
    expect(validateProject(inconsistent).errors).toContainEqual(
      expect.objectContaining({ path: 'lengthBars' }),
    );
  });
});
