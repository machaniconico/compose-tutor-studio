import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER,
  MAX_AUDIO_TAKE_FOLDERS,
  MAX_AUDIO_TAKES_PER_FOLDER,
  MIN_EVENT_DURATION_BEATS,
  createEmptyProject,
  decodeProject,
  migrateProject,
  validateProject,
  type AudioTakeFolder,
  type Project,
  type ReadyAudioAsset,
  type Track,
} from '../src/index';

const clock = () => new Date('2026-07-29T00:00:00.000Z');

function audioTrack(id = 'schema-v5-audio-track'): Track {
  return {
    id,
    name: 'Vocals',
    type: 'audio',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
}

function asset(id: string): ReadyAudioAsset {
  return {
    id,
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: `${id}.wav`,
    mediaType: 'audio/wav',
    byteLength: 384_044,
    sampleRate: 48_000,
    channelCount: 2,
    frameCount: 192_000,
  };
}

function projectWithFolder(): Project {
  const project = createEmptyProject({ clock });
  const track = audioTrack();
  const masterIndex = project.tracks.findIndex((candidate) => candidate.type === 'master');
  project.tracks.splice(masterIndex, 0, track);
  project.audioRouting.outputs.push({
    sourceTrackId: track.id,
    destination: { type: 'master' },
  });
  project.audioAssets.push(asset('schema-v5-asset-a'), asset('schema-v5-asset-b'));
  const folder: AudioTakeFolder = {
    id: 'schema-v5-folder',
    trackId: track.id,
    startBeat: 0,
    lengthBeats: 4,
    crossfadeMs: 5,
    takes: [
      {
        id: 'schema-v5-take-a',
        audioAssetId: 'schema-v5-asset-a',
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 0,
        sourceFrameCount: 96_000,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      },
      {
        id: 'schema-v5-take-b',
        audioAssetId: 'schema-v5-asset-b',
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 48_000,
        sourceFrameCount: 96_000,
        fadeInFrames: 120,
        fadeOutFrames: 240,
        gainDb: -3,
      },
    ],
    compSegments: [
      {
        id: 'schema-v5-segment-a',
        takeId: 'schema-v5-take-a',
        offsetBeats: 0,
        lengthBeats: 2,
      },
      {
        id: 'schema-v5-segment-b',
        takeId: 'schema-v5-take-b',
        offsetBeats: 2,
        lengthBeats: 2,
      },
    ],
  };
  project.audioTakeFolders.push(folder);
  return project;
}

function schemaV4Record(project: Project): Record<string, unknown> {
  const legacy = structuredClone(project) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 4;
  delete legacy.audioTakeFolders;
  delete legacy.automationReadState;
  return legacy;
}

function boundedFolder(
  folderIndex: number,
  trackId: string,
  startBeat: number,
  lengthBeats: number,
): AudioTakeFolder {
  const firstTakeId = `bounded-take-${folderIndex}-a`;
  const secondTakeId = `bounded-take-${folderIndex}-b`;
  return {
    id: `bounded-folder-${folderIndex}`,
    trackId,
    startBeat,
    lengthBeats,
    crossfadeMs: 0,
    takes: [
      {
        id: firstTakeId,
        audioAssetId: 'schema-v5-asset-a',
        offsetBeats: 0,
        lengthBeats,
        sourceStartFrame: 0,
        sourceFrameCount: 192_000,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      },
      {
        id: secondTakeId,
        audioAssetId: 'schema-v5-asset-b',
        offsetBeats: 0,
        lengthBeats,
        sourceStartFrame: 0,
        sourceFrameCount: 192_000,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      },
    ],
    compSegments: [{
      id: `bounded-segment-${folderIndex}`,
      takeId: firstTakeId,
      offsetBeats: 0,
      lengthBeats,
    }],
  };
}

describe('schema-v5 Audio take folders', () => {
  it('migrates v4 deterministically by adding only the required empty collection', () => {
    const current = createEmptyProject({ clock });
    const legacy = schemaV4Record(current);
    const before = structuredClone(legacy);

    const first = migrateProject(legacy);
    const second = migrateProject(legacy);
    expect(legacy).toEqual(before);
    expect(first).toEqual(second);
    expect(first).toEqual({
      ...legacy,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      audioTakeFolders: [],
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    });

    const decoded = decodeProject(legacy);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded).toMatchObject({ sourceSchemaVersion: 4, migrated: true });
    expect(decoded.project.audioTakeFolders).toEqual([]);
  });

  it('round-trips the exact take schema and rejects missing, unknown, and smuggled keys', () => {
    const project = projectWithFolder();
    expect(validateProject(project).ok).toBe(true);
    const decoded = decodeProject(project);
    expect(decoded.ok && decoded.project).toEqual(project);

    const missing = structuredClone(project) as unknown as Record<string, unknown>;
    delete missing.audioTakeFolders;
    const missingResult = decodeProject(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.error.issues).toContainEqual(expect.objectContaining({
        path: 'audioTakeFolders',
        code: 'required',
      }));
    }

    const unknown = structuredClone(project) as unknown as {
      audioTakeFolders: Array<{ takes: Array<Record<string, unknown>> }>;
    };
    unknown.audioTakeFolders[0]!.takes[0]!.name = 'not-in-schema';
    const unknownResult = decodeProject(unknown);
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) {
      expect(unknownResult.error.issues).toContainEqual(expect.objectContaining({
        path: 'audioTakeFolders[0].takes[0].name',
        code: 'unknown-key',
      }));
    }

    const smuggled = schemaV4Record(project);
    smuggled.audioTakeFolders = [];
    const smuggledResult = decodeProject(smuggled);
    expect(smuggledResult.ok).toBe(false);
    if (!smuggledResult.ok) {
      expect(smuggledResult.error.issues).toContainEqual(expect.objectContaining({
        path: 'audioTakeFolders',
        code: 'unknown-key',
      }));
    }
  });

  it('rejects wrong tracks, unresolved assets, bad source windows, gaps, overlaps, and noncanonical adjacency', () => {
    const cases: Array<[string, (project: Project) => void, string]> = [
      ['non-Audio track', (project) => {
        project.audioTakeFolders[0]!.trackId = project.tracks[0]!.id;
      }, 'audioTakeFolders[0].trackId'],
      ['unresolved asset', (project) => {
        project.audioAssets[0] = {
          id: 'schema-v5-asset-a',
          availability: 'unresolved',
          reason: 'missing-reference',
        };
      }, 'audioTakeFolders[0].takes[0].audioAssetId'],
      ['source overflow', (project) => {
        project.audioTakeFolders[0]!.takes[1]!.sourceFrameCount = 192_000;
      }, 'audioTakeFolders[0].takes[1].sourceFrameCount'],
      ['gap', (project) => {
        project.audioTakeFolders[0]!.compSegments[1]!.offsetBeats = 2.5;
        project.audioTakeFolders[0]!.compSegments[1]!.lengthBeats = 1.5;
      }, 'audioTakeFolders[0].compSegments[1].offsetBeats'],
      ['overlap', (project) => {
        project.audioTakeFolders[0]!.compSegments[1]!.offsetBeats = 1.5;
        project.audioTakeFolders[0]!.compSegments[1]!.lengthBeats = 2.5;
      }, 'audioTakeFolders[0].compSegments[1].offsetBeats'],
      ['adjacent same take', (project) => {
        project.audioTakeFolders[0]!.compSegments[1]!.takeId = 'schema-v5-take-a';
      }, 'audioTakeFolders[0].compSegments[1].takeId'],
      ['not exact cover', (project) => {
        project.audioTakeFolders[0]!.compSegments[1]!.lengthBeats = 1;
      }, 'audioTakeFolders[0].compSegments'],
    ];

    for (const [, mutate, expectedPath] of cases) {
      const project = projectWithFolder();
      mutate(project);
      expect(validateProject(project).errors).toContainEqual(expect.objectContaining({
        path: expectedPath,
      }));
    }
  });

  it('requires variable-tempo take source duration with exactly one frame of tolerance', () => {
    const project = projectWithFolder();
    project.tempoMap.push({
      id: 'schema-v5-variable-tempo',
      beat: 2,
      bpm: 60,
    });
    project.audioTakeFolders[0]!.takes.forEach((take) => {
      take.sourceFrameCount = 143_999;
    });

    expect(validateProject(project).ok).toBe(true);

    project.audioTakeFolders[0]!.takes[0]!.sourceFrameCount = 143_998;
    expect(validateProject(project).errors).toContainEqual(expect.objectContaining({
      path: 'audioTakeFolders[0].takes[0].sourceFrameCount',
      message: expect.stringContaining('one frame'),
    }));
  });

  it('includes folder, take, and segment ids in project-wide duplicate detection', () => {
    const project = projectWithFolder();
    project.audioTakeFolders[0]!.takes[0]!.id = project.id;
    project.audioTakeFolders[0]!.compSegments[0]!.id = project.audioTakeFolders[0]!.id;
    expect(validateProject(project).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'audioTakeFolders[0].takes[0].id',
        message: expect.stringContaining('duplicate id'),
      }),
      expect.objectContaining({
        path: 'audioTakeFolders[0].compSegments[0].id',
        message: expect.stringContaining('duplicate id'),
      }),
    ]));
  });

  it('accepts exact folder, take, and segment limits and rejects each limit plus one', () => {
    const folderBoundary = projectWithFolder();
    const folderTrackId = folderBoundary.audioTakeFolders[0]!.trackId;
    folderBoundary.audioTakeFolders = Array.from(
      { length: MAX_AUDIO_TAKE_FOLDERS },
      (_, index) => boundedFolder(
        index,
        folderTrackId,
        index * MIN_EVENT_DURATION_BEATS,
        MIN_EVENT_DURATION_BEATS,
      ),
    );
    expect(validateProject(folderBoundary).ok).toBe(true);
    folderBoundary.audioTakeFolders.push(boundedFolder(
      MAX_AUDIO_TAKE_FOLDERS,
      folderTrackId,
      MAX_AUDIO_TAKE_FOLDERS * MIN_EVENT_DURATION_BEATS,
      MIN_EVENT_DURATION_BEATS,
    ));
    expect(validateProject(folderBoundary).errors).toContainEqual(
      expect.objectContaining({ path: 'audioTakeFolders' }),
    );

    const takeBoundary = projectWithFolder();
    const takeFolder = takeBoundary.audioTakeFolders[0]!;
    takeFolder.takes = Array.from(
      { length: MAX_AUDIO_TAKES_PER_FOLDER },
      (_, index) => ({
        ...takeFolder.takes[index % 2]!,
        id: `boundary-take-${index}`,
        sourceStartFrame: 0,
      }),
    );
    takeFolder.compSegments = [{
      id: 'boundary-take-segment',
      takeId: takeFolder.takes[0]!.id,
      offsetBeats: 0,
      lengthBeats: takeFolder.lengthBeats,
    }];
    expect(validateProject(takeBoundary).ok).toBe(true);
    takeFolder.takes.push({
      ...takeFolder.takes[0]!,
      id: `boundary-take-${MAX_AUDIO_TAKES_PER_FOLDER}`,
    });
    expect(validateProject(takeBoundary).errors).toContainEqual(
      expect.objectContaining({ path: 'audioTakeFolders[0].takes' }),
    );

    const segmentBoundary = projectWithFolder();
    const segmentFolder = segmentBoundary.audioTakeFolders[0]!;
    segmentFolder.lengthBeats =
      MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER * MIN_EVENT_DURATION_BEATS;
    segmentFolder.takes = segmentFolder.takes.map((take) => ({
      ...take,
      offsetBeats: 0,
      lengthBeats: segmentFolder.lengthBeats,
      sourceStartFrame: 0,
      sourceFrameCount: 192_000,
    }));
    segmentFolder.compSegments = Array.from(
      { length: MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER },
      (_, index) => ({
        id: `boundary-comp-segment-${index}`,
        takeId: segmentFolder.takes[index % 2]!.id,
        offsetBeats: index * MIN_EVENT_DURATION_BEATS,
        lengthBeats: MIN_EVENT_DURATION_BEATS,
      }),
    );
    expect(validateProject(segmentBoundary).ok).toBe(true);
    const overSegmentBoundary = structuredClone(segmentBoundary);
    const overFolder = overSegmentBoundary.audioTakeFolders[0]!;
    overFolder.lengthBeats += MIN_EVENT_DURATION_BEATS;
    overFolder.takes = overFolder.takes.map((take) => ({
      ...take,
      lengthBeats: overFolder.lengthBeats,
    }));
    overFolder.compSegments.push({
      id: `boundary-comp-segment-${MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER}`,
      takeId: overFolder.takes[0]!.id,
      offsetBeats:
        MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER * MIN_EVENT_DURATION_BEATS,
      lengthBeats: MIN_EVENT_DURATION_BEATS,
    });
    expect(validateProject(overSegmentBoundary).errors).toContainEqual(
      expect.objectContaining({
        path: 'audioTakeFolders[0].compSegments',
      }),
    );
  });
});
