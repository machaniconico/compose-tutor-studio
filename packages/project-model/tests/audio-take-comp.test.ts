import { describe, expect, it } from 'vitest';
import {
  MAX_AUDIO_TAKES_PER_FOLDER,
  addAudioClipToTakeFolder,
  appendAudioTrackClip,
  createAudioTrackClip,
  createEmptyProject,
  compileMusicalTime,
  createRecordedAudioTakeFolder,
  deleteAudioClip,
  deleteUnusedAudioTake,
  duplicateTrack,
  encodeProjectJson,
  groupAudioClipsIntoTakeFolder,
  moveAudioCompBoundary,
  paintAudioCompRange,
  removeTrack,
  secondsBetweenBeats,
  validateProject,
  type AudioTakeCompIdFactory,
  type AudioTakeCompMutationResult,
  type Project,
  type ReadyAudioAsset,
} from '../src/index';

const clock = () => new Date('2026-07-29T00:00:00.000Z');

function readyAsset(index: number): ReadyAudioAsset {
  return {
    id: `take-asset-${index}`,
    availability: 'ready',
    checksumSha256: index.toString(16).padStart(64, '0'),
    originalName: `Take ${index}.wav`,
    mediaType: 'audio/wav',
    byteLength: 384_044,
    sampleRate: 48_000,
    channelCount: 2,
    frameCount: 192_000,
  };
}

function recordedAsset(index: number, frameCount = 96_000): ReadyAudioAsset {
  return {
    ...readyAsset(index),
    id: `recorded-asset-${index}`,
    originalName: `Recorded Take ${index}.wav`,
    frameCount,
  };
}

function sequenceFactory(label = 'comp'): AudioTakeCompIdFactory {
  let index = 0;
  return (kind) => `${kind}-${label}-${++index}`;
}

function expectSuccess(result: AudioTakeCompMutationResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function expectFailure(result: AudioTakeCompMutationResult, code: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected Audio take mutation failure');
  expect(result.error.code).toBe(code);
  return result;
}

function audioFixture(count = 3): {
  project: Project;
  trackId: string;
  clipIds: string[];
  assetIds: string[];
} {
  const base = createEmptyProject({ clock });
  const first = createAudioTrackClip(base, readyAsset(1), {
    startBeat: 0,
    sourceFrameCount: 96_000,
    fadeInFrames: 120,
    fadeOutFrames: 240,
    gainDb: -1,
    idFactory: (() => {
      let index = 0;
      return (kind) => `${kind}-fixture-first-${++index}`;
    })(),
  });
  if (!first.ok) throw new Error(first.error.message);
  let project = first.project;
  const clipIds = [first.clipId];
  const assetIds = [first.audioAssetId];
  for (let index = 2; index <= count; index += 1) {
    const appended = appendAudioTrackClip(project, first.trackId, readyAsset(index), {
      startBeat: 0,
      sourceFrameCount: 96_000,
      fadeInFrames: index * 100,
      fadeOutFrames: index * 200,
      gainDb: -index,
      idFactory: () => `clip-fixture-${index}`,
    });
    if (!appended.ok) throw new Error(appended.error.message);
    project = appended.project;
    clipIds.push(appended.clipId);
    assetIds.push(appended.audioAssetId);
  }
  return { project, trackId: first.trackId, clipIds, assetIds };
}

describe('Audio take grouping and adding', () => {
  it('groups matching ready Audio Clips without losing source, fade, or gain metadata', () => {
    const fixture = audioFixture();
    const before = structuredClone(fixture.project);
    const result = expectSuccess(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: sequenceFactory('group') },
    ));
    const folder = result.project.audioTakeFolders[0]!;

    expect(fixture.project).toEqual(before);
    expect(folder).toMatchObject({
      id: 'folder-group-1',
      trackId: fixture.trackId,
      startBeat: 0,
      lengthBeats: 4,
      crossfadeMs: 5,
    });
    expect(folder.takes).toEqual([
      expect.objectContaining({
        id: 'take-group-2',
        audioAssetId: fixture.assetIds[0],
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 0,
        sourceFrameCount: 96_000,
        fadeInFrames: 120,
        fadeOutFrames: 240,
        gainDb: -1,
      }),
      expect.objectContaining({
        id: 'take-group-3',
        audioAssetId: fixture.assetIds[1],
        fadeInFrames: 200,
        fadeOutFrames: 400,
        gainDb: -2,
      }),
      expect.objectContaining({
        id: 'take-group-4',
        audioAssetId: fixture.assetIds[2],
        fadeInFrames: 300,
        fadeOutFrames: 600,
        gainDb: -3,
      }),
    ]);
    expect(folder.compSegments).toEqual([{
      id: 'segment-group-5',
      takeId: 'take-group-2',
      offsetBeats: 0,
      lengthBeats: 4,
    }]);
    expect(result.project.tracks.find((track) => track.id === fixture.trackId)?.clips).toEqual([]);
    expect(result.project.audioAssets.map((asset) => asset.id)).toEqual(fixture.assetIds);
    expect(validateProject(result.project).ok).toBe(true);
    expect(encodeProjectJson(result.project).ok).toBe(true);
  });

  it('rejects mismatched, duplicated, looped, short-source, and hostile-id inputs atomically', () => {
    const fixture = audioFixture();
    const before = structuredClone(fixture.project);
    expectFailure(
      groupAudioClipsIntoTakeFolder(fixture.project, [fixture.clipIds[0]!, fixture.clipIds[0]!]),
      'invalid-clip-selection',
    );

    const looped = structuredClone(fixture.project);
    looped.tracks.find((track) => track.id === fixture.trackId)!.clips[1]!.loop = true;
    expectFailure(
      groupAudioClipsIntoTakeFolder(looped, fixture.clipIds),
      'ineligible-clip',
    );

    const moved = structuredClone(fixture.project);
    moved.tracks.find((track) => track.id === fixture.trackId)!.clips[1]!.startBeat = 1;
    expectFailure(
      groupAudioClipsIntoTakeFolder(moved, fixture.clipIds),
      'ineligible-clip',
    );

    const short = structuredClone(fixture.project);
    short.tracks.find((track) => track.id === fixture.trackId)!.clips[1]!.sourceFrameCount = 95_999;
    expect(groupAudioClipsIntoTakeFolder(
      short,
      fixture.clipIds,
      { idFactory: sequenceFactory('one-frame-tolerance') },
    ).ok).toBe(true);

    short.tracks.find((track) => track.id === fixture.trackId)!.clips[1]!.sourceFrameCount = 95_998;
    expectFailure(
      groupAudioClipsIntoTakeFolder(short, fixture.clipIds),
      'ineligible-clip',
    );

    expectFailure(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: () => fixture.project.id },
    ), 'duplicate-id');
    expectFailure(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: () => { throw new Error('hostile'); } },
    ), 'id-factory-failed');
    const malformedSource = structuredClone(fixture.project) as unknown as Record<
      string,
      unknown
    >;
    delete malformedSource.audioTakeFolders;
    expectFailure(groupAudioClipsIntoTakeFolder(
      malformedSource as unknown as Project,
      fixture.clipIds,
    ), 'project-not-adoptable');
    expect(fixture.project).toEqual(before);
  });

  it('uses the compiled variable-tempo duration for the one-frame source gate', () => {
    const fixture = audioFixture(2);
    fixture.project.tempoMap.push({
      id: 'tempo-variable-source-gate',
      beat: 2,
      bpm: 60,
    });
    const requiredFrames = Math.round(
      secondsBetweenBeats(
        compileMusicalTime(fixture.project),
        0,
        4,
      ) * 48_000,
    );
    const clips = fixture.project.tracks.find(
      (track) => track.id === fixture.trackId,
    )!.clips;
    clips.forEach((clip) => {
      if (clip.type === 'audio') clip.sourceFrameCount = requiredFrames;
    });
    if (clips[1]?.type !== 'audio') throw new Error('audio fixture missing');
    clips[1].sourceFrameCount = requiredFrames - 1;

    expect(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: sequenceFactory('variable-tempo-one-frame') },
    ).ok).toBe(true);

    clips[1].sourceFrameCount = requiredFrames - 2;
    expectFailure(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: sequenceFactory('variable-tempo-two-frames') },
    ), 'ineligible-clip');
  });

  it('adds a matching clip as a take and leaves the existing comp byte-for-byte unchanged', () => {
    const fixture = audioFixture();
    const grouped = expectSuccess(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds.slice(0, 2),
      { idFactory: sequenceFactory('base') },
    ));
    const folder = grouped.project.audioTakeFolders[0]!;
    const compBefore = JSON.stringify(folder.compSegments);
    const result = expectSuccess(addAudioClipToTakeFolder(
      grouped.project,
      folder.id,
      fixture.clipIds[2]!,
      { idFactory: () => 'take-appended' },
    ));
    const changed = result.project.audioTakeFolders[0]!;

    expect(JSON.stringify(changed.compSegments)).toBe(compBefore);
    expect(changed.compSegments).toBe(folder.compSegments);
    expect(changed.takes.at(-1)).toEqual(expect.objectContaining({
      id: 'take-appended',
      audioAssetId: fixture.assetIds[2],
      fadeInFrames: 300,
      fadeOutFrames: 600,
      gainDb: -3,
    }));
    expect(result.project.tracks.find((track) => track.id === fixture.trackId)?.clips)
      .toEqual([]);
  });

  it('rejects a second folder for the same track window and keeps the source clips', () => {
    const fixture = audioFixture(4);
    const grouped = expectSuccess(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds.slice(0, 2),
      { idFactory: sequenceFactory('first-window') },
    ));
    const remainingClipIds = fixture.clipIds.slice(2);
    const before = structuredClone(grouped.project);

    expectFailure(groupAudioClipsIntoTakeFolder(
      grouped.project,
      remainingClipIds,
      { idFactory: sequenceFactory('duplicate-window') },
    ), 'ineligible-clip');
    expect(grouped.project).toEqual(before);
    expect(
      grouped.project.tracks.find((track) => track.id === fixture.trackId)?.clips
        .map((clip) => clip.id),
    ).toEqual(remainingClipIds);

    const invalid = structuredClone(grouped.project);
    invalid.audioTakeFolders.push({
      ...structuredClone(invalid.audioTakeFolders[0]!),
      id: 'duplicate-window-folder',
      takes: invalid.audioTakeFolders[0]!.takes.map((take, index) => ({
        ...take,
        id: `duplicate-window-take-${index}`,
      })),
      compSegments: invalid.audioTakeFolders[0]!.compSegments.map(
        (segment, index) => ({
          ...segment,
          id: `duplicate-window-segment-${index}`,
          takeId: `duplicate-window-take-0`,
        }),
      ),
    });
    expect(validateProject(invalid).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'audioTakeFolders[1]',
        message: expect.stringContaining('Only one Audio take folder'),
      }),
    ]));
  });
});

describe('recorded Audio take-folder adoption', () => {
  it('atomically appends ordered ready assets and a full first-take comp to an existing track', () => {
    const fixture = audioFixture(2);
    const trackBefore = fixture.project.tracks.find(
      (track) => track.id === fixture.trackId,
    )!;
    const clipsBefore = trackBefore.clips;
    const routingBefore = fixture.project.audioRouting;
    const before = structuredClone(fixture.project);
    const assets = [recordedAsset(11), recordedAsset(12)];
    const result = createRecordedAudioTakeFolder(fixture.project, {
      target: { kind: 'existing-audio-track', trackId: fixture.trackId },
      assets,
      startBeat: 4,
      lengthBeats: 4,
      idFactory: sequenceFactory('recorded-existing'),
    }, clock);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(fixture.project).toEqual(before);
    expect(result.trackId).toBe(fixture.trackId);
    expect(result.audioAssetIds).toEqual(assets.map((asset) => asset.id));
    expect(result.project.tracks).toBe(fixture.project.tracks);
    expect(result.project.tracks.find((track) => track.id === fixture.trackId))
      .toBe(trackBefore);
    expect(trackBefore.clips).toBe(clipsBefore);
    expect(result.project.audioRouting).toBe(routingBefore);
    expect(result.project.audioAssets.slice(-2)).toEqual(assets);

    const folder = result.project.audioTakeFolders.at(-1)!;
    expect(folder).toMatchObject({
      id: 'folder-recorded-existing-1',
      trackId: fixture.trackId,
      startBeat: 4,
      lengthBeats: 4,
      crossfadeMs: 5,
    });
    expect(folder.takes).toEqual([
      expect.objectContaining({
        id: 'take-recorded-existing-2',
        audioAssetId: assets[0]!.id,
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 0,
        sourceFrameCount: 96_000,
      }),
      expect.objectContaining({
        id: 'take-recorded-existing-3',
        audioAssetId: assets[1]!.id,
      }),
    ]);
    expect(folder.compSegments).toEqual([{
      id: 'segment-recorded-existing-4',
      takeId: folder.takes[0]!.id,
      offsetBeats: 0,
      lengthBeats: 4,
    }]);
    expect(validateProject(result.project).ok).toBe(true);
    expect(encodeProjectJson(result.project).ok).toBe(true);
  });

  it('creates exactly one empty Audio Track and one Master output for a new target', () => {
    const project = createEmptyProject({ clock });
    const tracksBefore = project.tracks;
    const outputsBefore = project.audioRouting.outputs;
    const assets = [recordedAsset(21), recordedAsset(22), recordedAsset(23)];
    const result = createRecordedAudioTakeFolder(project, {
      target: { kind: 'new-track', trackName: '  Lead cycles  ' },
      assets,
      startBeat: 0,
      lengthBeats: 4,
      idFactory: sequenceFactory('recorded-new'),
    }, clock);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.trackId).toBe('track-recorded-new-1');
    const masterIndex = result.project.tracks.findIndex((track) => track.type === 'master');
    const track = result.project.tracks[masterIndex - 1]!;
    expect(track).toEqual({
      id: 'track-recorded-new-1',
      name: 'Lead cycles',
      type: 'audio',
      role: 'general',
      clips: [],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    });
    expect(result.project.tracks.filter((candidate) => !tracksBefore.includes(candidate)))
      .toEqual([track]);
    expect(result.project.audioRouting.outputs.slice(0, outputsBefore.length))
      .toEqual(outputsBefore);
    expect(result.project.audioRouting.outputs.at(-1)).toEqual({
      sourceTrackId: track.id,
      destination: { type: 'master' },
    });
    expect(result.project.audioTakeFolders[0]).toMatchObject({
      id: 'folder-recorded-new-2',
      trackId: track.id,
      takes: [
        { id: 'take-recorded-new-3', audioAssetId: assets[0]!.id },
        { id: 'take-recorded-new-4', audioAssetId: assets[1]!.id },
        { id: 'take-recorded-new-5', audioAssetId: assets[2]!.id },
      ],
      compSegments: [{
        id: 'segment-recorded-new-6',
        takeId: 'take-recorded-new-3',
      }],
    });
    expect(result.project.tracks.flatMap((candidate) => candidate.clips).some(
      (clip) => assets.some((asset) => asset.id === clip.audioAssetId),
    )).toBe(false);
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('rejects invalid assets, targets, ranges, names, limits, and ids without mutation', () => {
    const fixture = audioFixture(2);
    const before = structuredClone(fixture.project);
    const validInput = {
      target: { kind: 'existing-audio-track' as const, trackId: fixture.trackId },
      assets: [recordedAsset(31), recordedAsset(32)],
      startBeat: 0,
      lengthBeats: 4,
    };
    const failures = [
      createRecordedAudioTakeFolder(fixture.project, {
        ...validInput,
        assets: [recordedAsset(31)],
      }),
      createRecordedAudioTakeFolder(fixture.project, {
        ...validInput,
        assets: Array.from(
          { length: MAX_AUDIO_TAKES_PER_FOLDER + 1 },
          (_, index) => recordedAsset(1_000 + index),
        ),
      }),
      createRecordedAudioTakeFolder(fixture.project, {
        ...validInput,
        assets: [recordedAsset(31, 95_998), recordedAsset(32)],
      }),
      createRecordedAudioTakeFolder(fixture.project, {
        ...validInput,
        assets: [recordedAsset(31), recordedAsset(31)],
      }),
      createRecordedAudioTakeFolder(fixture.project, {
        ...validInput,
        target: { kind: 'existing-audio-track', trackId: 'missing-track' },
      }),
      createRecordedAudioTakeFolder(fixture.project, {
        ...validInput,
        target: {
          kind: 'existing-audio-track',
          trackId: fixture.project.tracks[0]!.id,
        },
      }),
      createRecordedAudioTakeFolder(fixture.project, {
        ...validInput,
        startBeat: fixture.project.lengthBeats,
      }),
      createRecordedAudioTakeFolder(fixture.project, {
        ...validInput,
        target: { kind: 'new-track', trackName: '   ' },
      }),
      createRecordedAudioTakeFolder(fixture.project, {
        ...validInput,
        idFactory: () => fixture.project.id,
      }),
    ];

    expect(failures.map((result) => result.ok ? 'ok' : result.error.code)).toEqual([
      'take-limit',
      'take-limit',
      'audio-asset-not-ready',
      'duplicate-id',
      'track-not-found',
      'unsupported-track-type',
      'invalid-range',
      'invalid-track-name',
      'duplicate-id',
    ]);
    expect(fixture.project).toEqual(before);
  });

  it('accepts one-frame source rounding tolerance and rejects a second folder on the same window', () => {
    const fixture = audioFixture(2);
    const oneFrameShort = createRecordedAudioTakeFolder(fixture.project, {
      target: { kind: 'existing-audio-track', trackId: fixture.trackId },
      assets: [recordedAsset(41, 95_999), recordedAsset(42, 95_999)],
      startBeat: 0,
      lengthBeats: 4,
      idFactory: sequenceFactory('recorded-tolerance'),
    }, clock);
    expect(oneFrameShort.ok).toBe(true);
    if (!oneFrameShort.ok) return;

    const second = createRecordedAudioTakeFolder(oneFrameShort.project, {
      target: { kind: 'existing-audio-track', trackId: fixture.trackId },
      assets: [recordedAsset(43), recordedAsset(44)],
      startBeat: 0,
      lengthBeats: 4,
      idFactory: sequenceFactory('recorded-duplicate-window'),
    }, clock);
    expectFailure(second, 'ineligible-clip');
    expect(oneFrameShort.project.audioTakeFolders).toHaveLength(1);
    expect(oneFrameShort.project.audioAssets.some(
      (asset) => asset.id === 'recorded-asset-43',
    )).toBe(false);
  });
});

describe('Audio comp painting, boundaries, and take deletion', () => {
  it('splits, replaces, and merges to a canonical exact-cover comp', () => {
    const fixture = audioFixture();
    const grouped = expectSuccess(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: sequenceFactory('paint-base') },
    ));
    const folder = grouped.project.audioTakeFolders[0]!;
    const painted = expectSuccess(paintAudioCompRange(
      grouped.project,
      folder.id,
      {
        takeId: folder.takes[1]!.id,
        offsetBeats: 1,
        lengthBeats: 2,
        idFactory: sequenceFactory('paint'),
      },
    ));
    const segments = painted.project.audioTakeFolders[0]!.compSegments;
    expect(segments.map(({ takeId, offsetBeats, lengthBeats }) => ({
      takeId,
      offsetBeats,
      lengthBeats,
    }))).toEqual([
      { takeId: folder.takes[0]!.id, offsetBeats: 0, lengthBeats: 1 },
      { takeId: folder.takes[1]!.id, offsetBeats: 1, lengthBeats: 2 },
      { takeId: folder.takes[0]!.id, offsetBeats: 3, lengthBeats: 1 },
    ]);
    expect(validateProject(painted.project).ok).toBe(true);

    const allSecond = expectSuccess(paintAudioCompRange(
      painted.project,
      folder.id,
      folder.takes[1]!.id,
      0,
      4,
    ));
    expect(allSecond.project.audioTakeFolders[0]!.compSegments).toEqual([
      expect.objectContaining({
        takeId: folder.takes[1]!.id,
        offsetBeats: 0,
        lengthBeats: 4,
      }),
    ]);
    const noOp = expectSuccess(paintAudioCompRange(
      allSecond.project,
      folder.id,
      folder.takes[1]!.id,
      0,
      4,
    ));
    expect(noOp.changed).toBe(false);
    expect(noOp.project).toBe(allSecond.project);
  });

  it('moves only one shared boundary and preserves Project identity for an exact no-op', () => {
    const fixture = audioFixture();
    const grouped = expectSuccess(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: sequenceFactory('boundary-base') },
    ));
    const folder = grouped.project.audioTakeFolders[0]!;
    const painted = expectSuccess(paintAudioCompRange(
      grouped.project,
      folder.id,
      folder.takes[1]!.id,
      1,
      2,
      sequenceFactory('boundary-paint'),
    ));
    const before = painted.project.audioTakeFolders[0]!.compSegments;
    const moved = expectSuccess(moveAudioCompBoundary(
      painted.project,
      folder.id,
      before[0]!.id,
      0.5,
    ));
    const after = moved.project.audioTakeFolders[0]!.compSegments;
    expect(after[0]).toEqual({ ...before[0]!, lengthBeats: 0.5 });
    expect(after[1]).toEqual({ ...before[1]!, offsetBeats: 0.5, lengthBeats: 2.5 });
    expect(after[2]).toBe(before[2]);
    expect(validateProject(moved.project).ok).toBe(true);

    const noOp = expectSuccess(moveAudioCompBoundary(
      moved.project,
      folder.id,
      after[0]!.id,
      0.5,
    ));
    expect(noOp.changed).toBe(false);
    expect(noOp.project).toBe(moved.project);
    expectFailure(
      moveAudioCompBoundary(moved.project, folder.id, after[0]!.id, 0),
      'invalid-range',
    );
  });

  it('rejects deleting an active take and garbage-collects only truly unreferenced assets', () => {
    const fixture = audioFixture();
    const grouped = expectSuccess(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: sequenceFactory('delete') },
    ));
    const folder = grouped.project.audioTakeFolders[0]!;
    expectFailure(
      deleteUnusedAudioTake(grouped.project, folder.id, folder.takes[0]!.id),
      'take-in-use',
    );
    const deleted = expectSuccess(deleteUnusedAudioTake(
      grouped.project,
      folder.id,
      folder.takes[2]!.id,
    ));
    expect(deleted.project.audioTakeFolders[0]!.takes).toHaveLength(2);
    expect(deleted.project.audioAssets.some((asset) => asset.id === fixture.assetIds[2]))
      .toBe(false);
  });

  it('keeps asset metadata while either a regular clip or another take still references it', () => {
    const fixture = audioFixture();
    const grouped = expectSuccess(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: sequenceFactory('shared-assets') },
    ));
    const folder = grouped.project.audioTakeFolders[0]!;
    const withRegularClip = structuredClone(grouped.project);
    withRegularClip.tracks.find((track) => track.id === fixture.trackId)!.clips.push({
      id: 'regular-shared-asset-clip',
      trackId: fixture.trackId,
      type: 'audio',
      startBeat: 8,
      lengthBeats: 4,
      loop: false,
      audioAssetId: fixture.assetIds[2]!,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      gainDb: 0,
    });
    expect(validateProject(withRegularClip).ok).toBe(true);
    const deletedTake = expectSuccess(deleteUnusedAudioTake(
      withRegularClip,
      folder.id,
      folder.takes[2]!.id,
    ));
    expect(deletedTake.project.audioAssets.some((asset) => asset.id === fixture.assetIds[2]))
      .toBe(true);

    const deletedClip = deleteAudioClip(
      deletedTake.project,
      'regular-shared-asset-clip',
      clock,
    );
    expect(deletedClip.ok).toBe(true);
    if (!deletedClip.ok) return;
    expect(deletedClip.project.audioAssets.some((asset) => asset.id === fixture.assetIds[2]))
      .toBe(false);

    const sharedByTakes = structuredClone(grouped.project);
    sharedByTakes.audioTakeFolders[0]!.takes[2]!.audioAssetId = fixture.assetIds[1]!;
    const removedDuplicateReference = expectSuccess(deleteUnusedAudioTake(
      sharedByTakes,
      folder.id,
      folder.takes[2]!.id,
    ));
    expect(removedDuplicateReference.project.audioAssets.some(
      (asset) => asset.id === fixture.assetIds[1],
    )).toBe(true);
  });
});

describe('Track lifecycle with Audio take folders', () => {
  it('duplicates owned folders with fresh ids while sharing assets, then cascades removal safely', () => {
    const fixture = audioFixture();
    const grouped = expectSuccess(groupAudioClipsIntoTakeFolder(
      fixture.project,
      fixture.clipIds,
      { idFactory: sequenceFactory('track-base') },
    ));
    let index = 0;
    const duplicated = duplicateTrack(grouped.project, fixture.trackId, {
      idFactory: (kind) => `${kind}-duplicate-${++index}`,
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    const duplicateFolder = duplicated.project.audioTakeFolders.find(
      (folder) => folder.trackId === duplicated.trackId,
    )!;
    const sourceFolder = grouped.project.audioTakeFolders[0]!;
    expect(duplicateFolder).toBeDefined();
    expect(duplicateFolder.id).not.toBe(sourceFolder.id);
    expect(duplicateFolder.takes.map((take) => take.id))
      .not.toEqual(sourceFolder.takes.map((take) => take.id));
    expect(duplicateFolder.takes.map((take) => take.audioAssetId))
      .toEqual(sourceFolder.takes.map((take) => take.audioAssetId));
    expect(duplicated.project.audioAssets).toBe(grouped.project.audioAssets);

    const removedSource = removeTrack(duplicated.project, fixture.trackId);
    expect(removedSource.ok).toBe(true);
    if (!removedSource.ok) return;
    expect(removedSource.project.audioTakeFolders).toEqual([duplicateFolder]);
    expect(removedSource.project.audioAssets.map((asset) => asset.id)).toEqual(fixture.assetIds);

    const removedDuplicate = removeTrack(removedSource.project, duplicated.trackId);
    expect(removedDuplicate.ok).toBe(true);
    if (!removedDuplicate.ok) return;
    expect(removedDuplicate.project.audioTakeFolders).toEqual([]);
    expect(removedDuplicate.project.audioAssets).toEqual([]);
  });
});
