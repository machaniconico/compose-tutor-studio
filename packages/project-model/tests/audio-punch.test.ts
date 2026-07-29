import { describe, expect, it } from 'vitest';
import {
  MAX_AUDIO_ASSETS,
  MAX_AUDIO_TAKE_FOLDERS,
  MAX_AUDIO_TAKES_PER_FOLDER,
  MAX_CLIPS_PER_TRACK,
  adoptRecordedAudioPunch,
  createAudioTrackClip,
  createEmptyProject,
  createRecordedAudioTakeFolder,
  encodeProjectJson,
  inspectAudioPunchTarget,
  validateProject,
  type AudioPunchIdFactory,
  type AudioPunchInspectionResult,
  type AudioPunchMutationErrorCode,
  type AudioPunchMutationResult,
  type AudioTakeCompIdFactory,
  type Project,
  type ReadyAudioAsset,
} from '../src/index';

const clock = () => new Date('2026-07-29T00:00:00.000Z');

function readyAsset(id: string, frameCount = 96_000): ReadyAudioAsset {
  return {
    id,
    availability: 'ready',
    checksumSha256: id.length.toString(16).padStart(64, '0'),
    originalName: `${id}.wav`,
    mediaType: 'audio/wav',
    byteLength: frameCount * 4 + 44,
    sampleRate: 48_000,
    channelCount: 2,
    frameCount,
  };
}

function sequenceFactory(label = 'punch'): AudioPunchIdFactory {
  let index = 0;
  return (kind) => `${kind}-${label}-${++index}`;
}

function takeFolderSequenceFactory(label: string): AudioTakeCompIdFactory {
  let index = 0;
  return (kind) => `${kind}-${label}-${++index}`;
}

function expectSuccess(result: AudioPunchMutationResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function expectFailure(
  result: AudioPunchMutationResult | AudioPunchInspectionResult,
  code: AudioPunchMutationErrorCode,
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected Audio punch mutation failure');
  expect(result.error.code).toBe(code);
  return result;
}

function spanningClipFixture(): {
  project: Project;
  trackId: string;
  clipId: string;
  sourceAssetId: string;
} {
  const created = createAudioTrackClip(
    createEmptyProject({ clock }),
    readyAsset('punch-source', 192_000),
    {
      startBeat: 0,
      sourceFrameCount: 192_000,
      fadeInFrames: 100,
      fadeOutFrames: 200,
      gainDb: -3,
      idFactory: (() => {
        let index = 0;
        return (kind) => `${kind}-punch-fixture-${++index}`;
      })(),
    },
  );
  if (!created.ok) throw new Error(created.error.message);
  return {
    project: created.project,
    trackId: created.trackId,
    clipId: created.clipId,
    sourceAssetId: created.audioAssetId,
  };
}

function emptyAudioTrackFixture(): {
  project: Project;
  trackId: string;
} {
  const fixture = spanningClipFixture();
  return {
    trackId: fixture.trackId,
    project: {
      ...fixture.project,
      audioAssets: [],
      tracks: fixture.project.tracks.map((track) => (
        track.id === fixture.trackId ? { ...track, clips: [] } : track
      )),
    },
  };
}

describe('recorded Audio punch adoption', () => {
  it('preflights permission-free eligibility with the same typed mode and source proof', () => {
    const empty = emptyAudioTrackFixture();
    expect(inspectAudioPunchTarget(empty.project, {
      trackId: empty.trackId,
      punchInBeat: 4,
      punchOutBeat: 8,
    })).toEqual({
      ok: true,
      mode: 'empty-window',
      trackId: empty.trackId,
      punchInBeat: 4,
      punchOutBeat: 8,
      folderId: null,
      sourceClipId: null,
    });

    const spanning = spanningClipFixture();
    expect(inspectAudioPunchTarget(spanning.project, {
      trackId: spanning.trackId,
      punchInBeat: 2,
      punchOutBeat: 6,
    })).toEqual({
      ok: true,
      mode: 'created-folder',
      trackId: spanning.trackId,
      punchInBeat: 2,
      punchOutBeat: 6,
      folderId: null,
      sourceClipId: spanning.clipId,
    });

    const partial = inspectAudioPunchTarget(spanning.project, {
      trackId: spanning.trackId,
      punchInBeat: 6,
      punchOutBeat: 10,
    });
    expectFailure(partial, 'ambiguous-overlap');
  });

  it('atomically adopts an exact-window raw clip when the armed Audio Track window is empty', () => {
    const fixture = emptyAudioTrackFixture();
    const before = structuredClone(fixture.project);
    const asset = readyAsset('punch-empty-recording');
    const result = expectSuccess(adoptRecordedAudioPunch(fixture.project, {
      trackId: fixture.trackId,
      asset,
      punchInBeat: 4,
      punchOutBeat: 8,
      idFactory: sequenceFactory('empty'),
    }, clock));

    expect(fixture.project).toEqual(before);
    expect(result).toMatchObject({
      changed: true,
      mode: 'empty-window',
      trackId: fixture.trackId,
      audioAssetId: asset.id,
      folderId: null,
      createdClipId: 'clip-empty-1',
      createdTakeId: null,
      preservedOuterClipIds: [],
    });
    expect(result.project.audioAssets).toEqual([asset]);
    expect(result.project.tracks.find((track) => track.id === fixture.trackId)?.clips).toEqual([{
      id: 'clip-empty-1',
      trackId: fixture.trackId,
      type: 'audio',
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      audioAssetId: asset.id,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      gainDb: 0,
    }]);
    expect(validateProject(result.project).ok).toBe(true);
    expect(encodeProjectJson(result.project).ok).toBe(true);
  });

  it('preserves both outer source windows and converts the old middle plus recording into a selected take folder', () => {
    const fixture = spanningClipFixture();
    const before = structuredClone(fixture.project);
    const asset = readyAsset('punch-middle-recording');
    const result = expectSuccess(adoptRecordedAudioPunch(fixture.project, {
      trackId: fixture.trackId,
      asset,
      punchInBeat: 2,
      punchOutBeat: 6,
      idFactory: sequenceFactory('middle'),
    }, clock));

    expect(fixture.project).toEqual(before);
    expect(result.mode).toBe('created-folder');
    expect(result.createdClipId).toBeNull();
    expect(result.folderId).toBe('folder-middle-2');
    expect(result.createdTakeId).toBe('take-middle-4');
    expect(result.preservedOuterClipIds).toEqual([
      fixture.clipId,
      'clip-middle-1',
    ]);

    const track = result.project.tracks.find((candidate) => candidate.id === fixture.trackId)!;
    expect(track.clips).toEqual([
      expect.objectContaining({
        id: fixture.clipId,
        startBeat: 0,
        lengthBeats: 2,
        audioAssetId: fixture.sourceAssetId,
        sourceStartFrame: 0,
        sourceFrameCount: 48_000,
        fadeInFrames: 100,
        fadeOutFrames: 0,
        gainDb: -3,
      }),
      expect.objectContaining({
        id: 'clip-middle-1',
        startBeat: 6,
        lengthBeats: 2,
        audioAssetId: fixture.sourceAssetId,
        sourceStartFrame: 144_000,
        sourceFrameCount: 48_000,
        fadeInFrames: 0,
        fadeOutFrames: 200,
        gainDb: -3,
      }),
    ]);

    const folder = result.project.audioTakeFolders.find(
      (candidate) => candidate.id === result.folderId,
    )!;
    expect(folder).toMatchObject({
      trackId: fixture.trackId,
      startBeat: 2,
      lengthBeats: 4,
      crossfadeMs: 5,
    });
    expect(folder.takes).toEqual([
      expect.objectContaining({
        id: 'take-middle-3',
        audioAssetId: fixture.sourceAssetId,
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 48_000,
        sourceFrameCount: 96_000,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: -3,
      }),
      expect.objectContaining({
        id: 'take-middle-4',
        audioAssetId: asset.id,
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 0,
        sourceFrameCount: 96_000,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      }),
    ]);
    expect(folder.compSegments).toEqual([{
      id: 'segment-middle-5',
      takeId: 'take-middle-4',
      offsetBeats: 0,
      lengthBeats: 4,
    }]);
    expect(result.project.audioAssets.at(-1)).toEqual(asset);
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('does not create an empty outer fragment when a punch boundary equals a clip edge', () => {
    const fixture = spanningClipFixture();
    const result = expectSuccess(adoptRecordedAudioPunch(fixture.project, {
      trackId: fixture.trackId,
      asset: readyAsset('punch-boundary-recording'),
      punchInBeat: 0,
      punchOutBeat: 4,
      idFactory: sequenceFactory('boundary'),
    }, clock));

    expect(result.mode).toBe('created-folder');
    expect(result.preservedOuterClipIds).toEqual([fixture.clipId]);
    const track = result.project.tracks.find((candidate) => candidate.id === fixture.trackId)!;
    expect(track.clips).toEqual([
      expect.objectContaining({
        id: fixture.clipId,
        startBeat: 4,
        lengthBeats: 4,
        sourceStartFrame: 96_000,
        sourceFrameCount: 96_000,
        fadeInFrames: 0,
        fadeOutFrames: 200,
      }),
    ]);
    const folder = result.project.audioTakeFolders[0]!;
    expect(folder.takes[0]).toEqual(expect.objectContaining({
      audioAssetId: fixture.sourceAssetId,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
      fadeInFrames: 100,
      fadeOutFrames: 0,
    }));
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('appends a full-window take to one exact folder and selects only the new take', () => {
    const fixture = emptyAudioTrackFixture();
    const initial = createRecordedAudioTakeFolder(fixture.project, {
      target: { kind: 'existing-audio-track', trackId: fixture.trackId },
      assets: [
        readyAsset('folder-take-one'),
        readyAsset('folder-take-two'),
      ],
      startBeat: 4,
      lengthBeats: 4,
      idFactory: (() => {
        let index = 0;
        return (kind) => `${kind}-existing-${++index}`;
      })(),
    }, clock);
    if (!initial.ok) throw new Error(initial.error.message);
    const before = structuredClone(initial.project);
    const asset = readyAsset('folder-new-punch');
    const result = expectSuccess(adoptRecordedAudioPunch(initial.project, {
      trackId: fixture.trackId,
      asset,
      punchInBeat: 4,
      punchOutBeat: 8,
      idFactory: sequenceFactory('append'),
    }, clock));

    expect(initial.project).toEqual(before);
    expect(result).toMatchObject({
      mode: 'appended-folder',
      folderId: initial.folderId,
      createdClipId: null,
      createdTakeId: 'take-append-1',
      preservedOuterClipIds: [],
    });
    const folder = result.project.audioTakeFolders.find(
      (candidate) => candidate.id === initial.folderId,
    )!;
    expect(folder.takes).toHaveLength(3);
    expect(folder.takes.at(-1)).toEqual(expect.objectContaining({
      id: 'take-append-1',
      audioAssetId: asset.id,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
    }));
    expect(folder.compSegments).toEqual([{
      id: 'segment-append-2',
      takeId: 'take-append-1',
      offsetBeats: 0,
      lengthBeats: 4,
    }]);
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('rejects partial, multiple, looped, unavailable, mismatched-folder, and short-source material atomically', () => {
    const fixture = spanningClipFixture();
    const asset = readyAsset('punch-rejected-recording');
    const variants: Array<Readonly<{
      project: Project;
      punchInBeat: number;
      punchOutBeat: number;
      code: AudioPunchMutationErrorCode;
    }>> = [];

    variants.push({
      project: fixture.project,
      punchInBeat: 6,
      punchOutBeat: 10,
      code: 'ambiguous-overlap',
    });

    const multiple = structuredClone(fixture.project);
    multiple.tracks.find((track) => track.id === fixture.trackId)!.clips.push({
      ...multiple.tracks.find((track) => track.id === fixture.trackId)!.clips[0]!,
      id: 'second-overlapping-clip',
    });
    variants.push({
      project: multiple,
      punchInBeat: 2,
      punchOutBeat: 6,
      code: 'ambiguous-overlap',
    });

    const looped = structuredClone(fixture.project);
    looped.tracks.find((track) => track.id === fixture.trackId)!.clips[0]!.loop = true;
    variants.push({
      project: looped,
      punchInBeat: 2,
      punchOutBeat: 6,
      code: 'ineligible-source',
    });

    const unavailable = structuredClone(fixture.project);
    unavailable.audioAssets = [{
      id: fixture.sourceAssetId,
      availability: 'unresolved',
      reason: 'missing-reference',
    }];
    Object.assign(
      unavailable.tracks.find((track) => track.id === fixture.trackId)!.clips[0]!,
      {
        sourceStartFrame: 0,
        sourceFrameCount: 0,
        fadeInFrames: 0,
        fadeOutFrames: 0,
      },
    );
    variants.push({
      project: unavailable,
      punchInBeat: 2,
      punchOutBeat: 6,
      code: 'ineligible-source',
    });

    const short = structuredClone(fixture.project);
    Object.assign(
      short.tracks.find((track) => track.id === fixture.trackId)!.clips[0]!,
      { sourceFrameCount: 100_000, fadeOutFrames: 0 },
    );
    variants.push({
      project: short,
      punchInBeat: 2,
      punchOutBeat: 6,
      code: 'source-too-short',
    });

    const folderFixture = emptyAudioTrackFixture();
    const folderProject = createRecordedAudioTakeFolder(folderFixture.project, {
      target: { kind: 'existing-audio-track', trackId: folderFixture.trackId },
      assets: [readyAsset('mismatch-take-one'), readyAsset('mismatch-take-two')],
      startBeat: 4,
      lengthBeats: 4,
      idFactory: takeFolderSequenceFactory('mismatch-fixture'),
    }, clock);
    if (!folderProject.ok) throw new Error(folderProject.error.message);
    variants.push({
      project: folderProject.project,
      punchInBeat: 5,
      punchOutBeat: 7,
      code: 'mismatched-folder',
    });

    for (const variant of variants) {
      const before = structuredClone(variant.project);
      expectFailure(adoptRecordedAudioPunch(variant.project, {
        trackId: variant.project === folderProject.project
          ? folderFixture.trackId
          : fixture.trackId,
        asset,
        punchInBeat: variant.punchInBeat,
        punchOutBeat: variant.punchOutBeat,
      }, clock), variant.code);
      expect(variant.project).toEqual(before);
    }
  });

  it('rejects invalid assets, ranges, ids, entity limits, and malformed projects without mutation', () => {
    const fixture = emptyAudioTrackFixture();
    const before = structuredClone(fixture.project);
    const input = {
      trackId: fixture.trackId,
      punchInBeat: 4,
      punchOutBeat: 8,
    } as const;

    expectFailure(adoptRecordedAudioPunch(fixture.project, {
      ...input,
      asset: readyAsset('one-frame-short', 95_998),
    }, clock), 'source-too-short');
    expectFailure(adoptRecordedAudioPunch(fixture.project, {
      ...input,
      asset: readyAsset(fixture.project.id),
    }, clock), 'duplicate-id');
    expectFailure(adoptRecordedAudioPunch(fixture.project, {
      ...input,
      asset: {
        ...readyAsset('invalid-recorded-metadata'),
        checksumSha256: 'not-a-checksum',
      },
    }, clock), 'audio-asset-not-ready');
    expectFailure(adoptRecordedAudioPunch(fixture.project, {
      ...input,
      asset: readyAsset('hostile-id-factory'),
      idFactory: () => { throw new Error('hostile'); },
    }, clock), 'id-factory-failed');
    expectFailure(adoptRecordedAudioPunch(fixture.project, {
      ...input,
      asset: readyAsset('colliding-generated-id'),
      idFactory: () => fixture.project.id,
    }, clock), 'duplicate-id');
    expectFailure(adoptRecordedAudioPunch(fixture.project, {
      ...input,
      punchOutBeat: 4,
      asset: readyAsset('empty-punch-range'),
    }, clock), 'invalid-range');
    expectFailure(adoptRecordedAudioPunch(fixture.project, {
      ...input,
      punchOutBeat: 4.5,
      asset: readyAsset('too-short-punch-range', 12_000),
    }, clock), 'invalid-range');
    expectFailure(adoptRecordedAudioPunch(fixture.project, {
      ...input,
      trackId: 'missing-track',
      asset: readyAsset('missing-track-recording'),
    }, clock), 'track-not-found');

    const malformed = structuredClone(fixture.project) as unknown as Record<string, unknown>;
    delete malformed.audioTakeFolders;
    expectFailure(adoptRecordedAudioPunch(malformed as unknown as Project, {
      ...input,
      asset: readyAsset('malformed-project-recording'),
    }, clock), 'project-not-adoptable');

    const folderFixture = emptyAudioTrackFixture();
    const folderProject = createRecordedAudioTakeFolder(folderFixture.project, {
      target: { kind: 'existing-audio-track', trackId: folderFixture.trackId },
      assets: [readyAsset('limit-take-one'), readyAsset('limit-take-two')],
      startBeat: 4,
      lengthBeats: 4,
      idFactory: takeFolderSequenceFactory('limit-fixture'),
    }, clock);
    if (!folderProject.ok) throw new Error(folderProject.error.message);
    const maxedFolder = structuredClone(folderProject.project);
    const folder = maxedFolder.audioTakeFolders[0]!;
    const template = folder.takes[0]!;
    folder.takes = Array.from({ length: MAX_AUDIO_TAKES_PER_FOLDER }, (_, index) => ({
      ...template,
      id: index === 0 ? template.id : `take-limit-existing-${index}`,
    }));
    expect(validateProject(maxedFolder).ok).toBe(true);
    expectFailure(adoptRecordedAudioPunch(maxedFolder, {
      trackId: folderFixture.trackId,
      asset: readyAsset('over-take-limit-recording'),
      punchInBeat: 4,
      punchOutBeat: 8,
    }, clock), 'take-limit');

    expect(fixture.project).toEqual(before);
  });

  it('preflights AudioAsset, Clip, and new-folder capacity limits before adoption', () => {
    const empty = emptyAudioTrackFixture();
    const assetLimited: Project = {
      ...empty.project,
      audioAssets: Array.from(
        { length: MAX_AUDIO_ASSETS },
        (_, index) => readyAsset(`capacity-asset-${index}`, 48_000),
      ),
    };
    expect(validateProject(assetLimited).ok).toBe(true);
    expectFailure(inspectAudioPunchTarget(assetLimited, {
      trackId: empty.trackId,
      punchInBeat: 4,
      punchOutBeat: 8,
    }), 'audio-asset-limit');

    const clipFixture = spanningClipFixture();
    const clipLimited = structuredClone(clipFixture.project);
    const clipTrack = clipLimited.tracks.find(
      (track) => track.id === clipFixture.trackId,
    )!;
    const clipTemplate = clipTrack.clips[0]!;
    clipTrack.clips = Array.from({ length: MAX_CLIPS_PER_TRACK }, (_, index) => ({
      ...clipTemplate,
      id: index === 0 ? clipTemplate.id : `capacity-clip-${index}`,
      startBeat: 0,
      lengthBeats: 1,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    }));
    expect(validateProject(clipLimited).ok).toBe(true);
    expectFailure(inspectAudioPunchTarget(clipLimited, {
      trackId: clipFixture.trackId,
      punchInBeat: 4,
      punchOutBeat: 8,
    }), 'clip-limit');

    const folderFixture = spanningClipFixture();
    const targetTrack = folderFixture.project.tracks.find(
      (track) => track.id === folderFixture.trackId,
    )!;
    const auxiliaryTrack = {
      ...targetTrack,
      id: 'capacity-folder-track',
      name: 'Folder capacity',
      clips: [],
    };
    const masterIndex = folderFixture.project.tracks.findIndex(
      (track) => track.type === 'master',
    );
    const folderLimited: Project = {
      ...folderFixture.project,
      tracks: [
        ...folderFixture.project.tracks.slice(0, masterIndex),
        auxiliaryTrack,
        ...folderFixture.project.tracks.slice(masterIndex),
      ],
      audioRouting: {
        ...folderFixture.project.audioRouting,
        outputs: [
          ...folderFixture.project.audioRouting.outputs,
          {
            sourceTrackId: auxiliaryTrack.id,
            destination: { type: 'master' },
          },
        ],
      },
      audioTakeFolders: Array.from(
        { length: MAX_AUDIO_TAKE_FOLDERS },
        (_, index) => ({
          id: `capacity-folder-${index}`,
          trackId: auxiliaryTrack.id,
          startBeat: 8 + index / 2_048,
          lengthBeats: 0.5,
          crossfadeMs: 5,
          takes: [
            {
              id: `capacity-folder-${index}-take-1`,
              audioAssetId: folderFixture.sourceAssetId,
              offsetBeats: 0,
              lengthBeats: 0.5,
              sourceStartFrame: 0,
              sourceFrameCount: 12_000,
              fadeInFrames: 0,
              fadeOutFrames: 0,
              gainDb: 0,
            },
            {
              id: `capacity-folder-${index}-take-2`,
              audioAssetId: folderFixture.sourceAssetId,
              offsetBeats: 0,
              lengthBeats: 0.5,
              sourceStartFrame: 0,
              sourceFrameCount: 12_000,
              fadeInFrames: 0,
              fadeOutFrames: 0,
              gainDb: 0,
            },
          ],
          compSegments: [{
            id: `capacity-folder-${index}-segment`,
            takeId: `capacity-folder-${index}-take-1`,
            offsetBeats: 0,
            lengthBeats: 0.5,
          }],
        }),
      ),
    };
    expect(validateProject(folderLimited).ok).toBe(true);
    expectFailure(inspectAudioPunchTarget(folderLimited, {
      trackId: folderFixture.trackId,
      punchInBeat: 2,
      punchOutBeat: 6,
    }), 'folder-limit');
  });
});
