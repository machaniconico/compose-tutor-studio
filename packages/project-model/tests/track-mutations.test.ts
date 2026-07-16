import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRUM_TRACK_PRESET,
  DEFAULT_SYNTH_TRACK_PRESET,
  MAX_PROJECT_TRACKS,
  MAX_TRACK_NAME_CODE_POINTS,
  addTrack,
  createAudioTrackClip,
  createEmptyProject,
  duplicateTrack,
  encodeProjectJson,
  moveTrack,
  projectLengthBeats,
  removeTrack,
  renameTrack,
  setTrackSynthPreset,
  validateProject,
  type Project,
  type ReadyAudioAsset,
  type Track,
  type TrackIdFactory,
  type TrackMutationResult,
} from '../src/index';

const fixedClock = () => new Date('2026-07-16T00:00:00.000Z');

function base(): Project {
  return createEmptyProject({ clock: fixedClock });
}

function expectSuccess(result: TrackMutationResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function expectFailure(result: TrackMutationResult, code: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected track mutation failure');
  expect(result.error.code).toBe(code);
  return result;
}

function sequenceFactory(label = 'new'): TrackIdFactory {
  let count = 0;
  return (kind) => `${kind}-${label}-${++count}`;
}

function readyAudioAsset(id = 'track-removal-asset'): ReadyAudioAsset {
  return {
    id,
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: 'track-removal.wav',
    mediaType: 'audio/wav',
    byteLength: 192_044,
    sampleRate: 48_000,
    channelCount: 2,
    frameCount: 48_000,
  };
}

function richSourceProject(): Project {
  const project = base();
  const source = project.tracks[0]!;
  const replacement: Track = {
    ...source,
    instrument: { type: 'synth', preset: 'pad', params: { cutoff: 0.7 } },
    effects: [
      { id: 'source-effect', type: 'delay', enabled: true, params: { mix: 0.25 } },
    ],
    clips: [
      {
        id: 'source-midi-alias',
        trackId: source.id,
        type: 'midi',
        startBeat: 4,
        lengthBeats: 4,
        loop: false,
        aliasOf: 'source-midi',
      },
      {
        id: 'source-midi',
        trackId: source.id,
        type: 'midi',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        notes: [
          { id: 'source-note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
        ],
      },
      {
        id: 'source-drum',
        trackId: source.id,
        type: 'drum',
        startBeat: 8,
        lengthBeats: 4,
        loop: false,
        stepsPerBar: 16,
        drumEvents: [
          { id: 'source-drum-event', lane: 'kick', stepIndex: 0, velocity: 110, probability: 0.8 },
        ],
        drumGroove: {
          swing: 0.2,
          probability: 0.9,
          humanizeVelocity: 4,
          seed: 17,
        },
      },
      {
        id: 'source-audio',
        trackId: source.id,
        type: 'audio',
        startBeat: 12,
        lengthBeats: 4,
        loop: false,
        audioAssetId: 'shared-audio-asset',
        sourceStartFrame: 0,
        sourceFrameCount: 0,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      },
    ],
  };
  const next = {
    ...project,
    audioAssets: [{
      id: 'shared-audio-asset',
      availability: 'unresolved' as const,
      legacyAssetId: 'legacy-shared-audio-asset',
      reason: 'legacy-reference' as const,
    }],
    tracks: project.tracks.map((track, index) => (index === 0 ? replacement : track)),
  };
  expect(validateProject(next).ok).toBe(true);
  return next;
}

function ownedIds(track: Track): Set<string> {
  const ids = new Set<string>([track.id]);
  for (const effect of track.effects) ids.add(effect.id);
  for (const clip of track.clips) {
    ids.add(clip.id);
    for (const note of clip.notes ?? []) ids.add(note.id);
    for (const event of clip.drumEvents ?? []) ids.add(event.id);
  }
  return ids;
}

describe('addTrack', () => {
  it('adds a full-song synth track before the first master without stamping updatedAt', () => {
    const project = base();
    const masterIndex = project.tracks.findIndex((track) => track.type === 'master');
    const result = expectSuccess(addTrack(project, 'instrument', {
      idFactory: sequenceFactory('instrument'),
    }));
    const added = result.project.tracks[masterIndex]!;

    expect(result.changed).toBe(true);
    expect(result.trackId).toBe('track-instrument-1');
    expect(added).toMatchObject({
      id: 'track-instrument-1',
      name: 'Instrument',
      type: 'instrument',
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      instrument: { type: 'synth', preset: DEFAULT_SYNTH_TRACK_PRESET },
    });
    expect(added.clips).toEqual([{
      id: 'clip-instrument-2',
      trackId: added.id,
      type: 'midi',
      startBeat: 0,
      lengthBeats: projectLengthBeats(project),
      loop: false,
      notes: [],
    }]);
    expect(result.project.updatedAt).toBe(project.updatedAt);
    expect(project.tracks).toHaveLength(5);
    expect(encodeProjectJson(result.project).ok).toBe(true);
  });

  it('adds a drum track with a deterministic unique name and canonical defaults', () => {
    const project = base();
    const result = expectSuccess(addTrack(project, 'drum', {
      idFactory: sequenceFactory('drum'),
    }));
    const added = result.project.tracks.find((track) => track.id === result.trackId)!;

    expect(added.name).toBe('Drums 2');
    expect(added.instrument).toEqual({ type: 'drumkit', preset: DEFAULT_DRUM_TRACK_PRESET });
    expect(added.clips[0]).toMatchObject({
      type: 'drum',
      startBeat: 0,
      lengthBeats: projectLengthBeats(project),
      stepsPerBar: 16,
      drumEvents: [],
    });
  });

  it('inserts before the first master and appends when no master exists', () => {
    const project = base();
    const originalMaster = project.tracks.at(-1)!;
    const earlierMaster = { ...originalMaster, id: 'earlier-master' };
    const multipleMasters = {
      ...project,
      tracks: [...project.tracks.slice(0, 2), earlierMaster, ...project.tracks.slice(2)],
    };
    const beforeFirst = expectSuccess(addTrack(multipleMasters, 'instrument', {
      idFactory: sequenceFactory('multi'),
    }));
    expect(beforeFirst.project.tracks[2]!.id).toBe(beforeFirst.trackId);
    expect(beforeFirst.project.tracks[3]!.id).toBe('earlier-master');

    const withoutMaster = {
      ...project,
      tracks: project.tracks.filter((track) => track.type !== 'master'),
    };
    const appended = expectSuccess(addTrack(withoutMaster, 'instrument', {
      idFactory: sequenceFactory('none'),
    }));
    expect(appended.project.tracks.at(-1)!.id).toBe(appended.trackId);
  });

  it('rejects the track cap before requesting ids', () => {
    const project = base();
    const filler = Array.from(
      { length: MAX_PROJECT_TRACKS - project.tracks.length },
      (_, index): Track => ({
        id: `filler-${index}`,
        name: `Filler ${index}`,
        type: 'bus',
        role: 'general',
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      }),
    );
    const atLimit = { ...project, tracks: [...filler, ...project.tracks] };
    let calls = 0;
    const result = addTrack(atLimit, 'instrument', {
      idFactory: (kind) => `${kind}-${++calls}`,
    });

    expectFailure(result, 'track-limit');
    expect(calls).toBe(0);
  });

  it.each([' chords ', 'BASS', ' MeLoDy '])('allows legacy-looking names without assigning a learning role: %s', (name) => {
    const project = base();
    let calls = 0;
    const result = expectSuccess(addTrack(project, 'instrument', {
      name,
      idFactory: (kind) => `${kind}-${++calls}`,
    }));
    expect(result.project.tracks.find((track) => track.id === result.trackId)).toMatchObject({
      name: name.trim(),
      role: 'general',
    });
    expect(calls).toBe(2);
  });
});

describe('renameTrack', () => {
  it('trims the name, keeps the input immutable, and treats the same name as a no-op', () => {
    const project = base();
    const trackId = project.tracks[3]!.id;
    const renamed = expectSuccess(renameTrack(project, trackId, '  Harmony  '));

    expect(renamed.changed).toBe(true);
    expect(renamed.project.tracks[3]!.name).toBe('Harmony');
    expect(project.tracks[3]!.name).toBe('Drums');
    expect(renamed.project.updatedAt).toBe(project.updatedAt);

    const noOp = expectSuccess(renameTrack(renamed.project, trackId, ' Harmony '));
    expect(noOp.changed).toBe(false);
    expect(noOp.project).toBe(renamed.project);
  });

  it('counts Unicode code points and rejects blank or overlong names', () => {
    const project = base();
    const trackId = project.tracks[3]!.id;
    const exact = '🎵'.repeat(MAX_TRACK_NAME_CODE_POINTS);
    const exactResult = expectSuccess(renameTrack(project, trackId, exact));
    expect(Array.from(exactResult.project.tracks[3]!.name)).toHaveLength(MAX_TRACK_NAME_CODE_POINTS);

    expectFailure(renameTrack(project, trackId, ' \n\t '), 'invalid-track-name');
    expectFailure(renameTrack(project, trackId, `${exact}🎵`), 'invalid-track-name');
    expectFailure(renameTrack(project, 'missing-track', 'Name'), 'track-not-found');
    expectFailure(renameTrack(project, project.tracks.at(-1)!.id, 'Output'), 'master-protected');
  });

  it.each(['Chords', 'Bass', 'Melody'])('renames the %s learning-role track without changing its role', (name) => {
    const project = base();
    const track = project.tracks.find((candidate) => candidate.name === name)!;
    const renamed = expectSuccess(renameTrack(project, track.id, `${name} renamed`));
    expect(renamed.project.tracks.find((candidate) => candidate.id === track.id)).toMatchObject({
      name: `${name} renamed`,
      role: track.role,
    });
  });

  it.each([' chords ', 'BASS', ' MeLoDy '])('allows another track to use a learning-looking name %s', (name) => {
    const project = base();
    const renamed = expectSuccess(renameTrack(project, project.tracks[3]!.id, name));
    expect(renamed.project.tracks[3]).toMatchObject({ name: name.trim(), role: 'general' });
  });
});

describe('duplicateTrack', () => {
  it('duplicates all owned ids, remaps forward aliases, and deep-copies nested data', () => {
    const project = richSourceProject();
    const source = project.tracks[0]!;
    const result = expectSuccess(duplicateTrack(project, source.id, {
      idFactory: sequenceFactory('copy'),
    }));
    const duplicate = result.project.tracks[1]!;

    expect(duplicate.id).toBe(result.trackId);
    expect(duplicate.name).toBe('Chords Copy');
    expect(duplicate.role).toBe('general');
    expect(result.project.tracks[0]).toBe(source);
    expect(project.tracks).toHaveLength(5);
    expect(result.project.updatedAt).toBe(project.updatedAt);

    const sourceIds = ownedIds(source);
    const duplicateIds = ownedIds(duplicate);
    expect([...duplicateIds].every((id) => !sourceIds.has(id))).toBe(true);
    expect(duplicateIds.size).toBe(sourceIds.size);
    expect(duplicate.clips[0]!.aliasOf).toBe(duplicate.clips[1]!.id);
    expect(duplicate.clips.every((clip) => clip.trackId === duplicate.id)).toBe(true);
    expect(duplicate.clips[3]!.audioAssetId).toBe(source.clips[3]!.audioAssetId);

    expect(duplicate.instrument).not.toBe(source.instrument);
    expect(duplicate.instrument!.params).not.toBe(source.instrument!.params);
    expect(duplicate.effects).not.toBe(source.effects);
    expect(duplicate.effects[0]!.params).not.toBe(source.effects[0]!.params);
    expect(duplicate.clips[2]!.drumGroove).not.toBe(source.clips[2]!.drumGroove);
    expect(duplicate.clips[1]!.notes).not.toBe(source.clips[1]!.notes);
    expect(duplicate.clips[2]!.drumEvents).not.toBe(source.clips[2]!.drumEvents);

    duplicate.instrument!.params!.cutoff = 0.1;
    duplicate.effects[0]!.params.mix = 0.9;
    duplicate.clips[2]!.drumGroove!.swing = 0.5;
    expect(source.instrument!.params!.cutoff).toBe(0.7);
    expect(source.effects[0]!.params.mix).toBe(0.25);
    expect(source.clips[2]!.drumGroove!.swing).toBe(0.2);
    expect(validateProject(result.project).ok).toBe(true);
    expect(encodeProjectJson(result.project).ok).toBe(true);
  });

  it('inserts after its source but before an adjacent master', () => {
    const project = base();
    const source = project.tracks.at(-2)!;
    const master = project.tracks.at(-1)!;
    const result = expectSuccess(duplicateTrack(project, source.id, {
      idFactory: sequenceFactory('adjacent'),
    }));

    expect(result.project.tracks.at(-3)!.id).toBe(source.id);
    expect(result.project.tracks.at(-2)!.id).toBe(result.trackId);
    expect(result.project.tracks.at(-1)!.id).toBe(master.id);
  });

  it('protects master, the track cap, and global id uniqueness', () => {
    const project = base();
    const master = project.tracks.find((track) => track.type === 'master')!;
    expectFailure(duplicateTrack(project, master.id), 'master-protected');
    expectFailure(duplicateTrack(project, 'missing'), 'track-not-found');
    expectFailure(duplicateTrack(project, project.tracks[0]!.id, {
      idFactory: () => project.id,
    }), 'duplicate-id');
  });

  it('never throws when an injected id factory throws or returns an invalid id', () => {
    const project = base();
    const trackId = project.tracks[0]!.id;
    const throwing = () => duplicateTrack(project, trackId, {
      idFactory: () => { throw new Error('boom'); },
    });
    expect(throwing).not.toThrow();
    expectFailure(throwing(), 'id-factory-failed');
    expectFailure(duplicateTrack(project, trackId, { idFactory: () => '' }), 'id-factory-failed');
  });
});

describe('moveTrack and removeTrack', () => {
  it('moves one position, returns boundary no-ops, and never crosses master', () => {
    const project = base();
    const firstId = project.tracks[0]!.id;
    const secondId = project.tracks[1]!.id;
    const moved = expectSuccess(moveTrack(project, secondId, 'up'));
    expect(moved.changed).toBe(true);
    expect(moved.project.tracks[0]!.id).toBe(secondId);
    expect(moved.project.tracks[1]!.id).toBe(firstId);
    expect(project.tracks[0]!.id).toBe(firstId);

    const atTop = expectSuccess(moveTrack(project, firstId, 'up'));
    expect(atTop.changed).toBe(false);
    expect(atTop.project).toBe(project);

    const beforeMaster = project.tracks.at(-2)!;
    const blocked = expectSuccess(moveTrack(project, beforeMaster.id, 'down'));
    expect(blocked.changed).toBe(false);
    expect(blocked.project).toBe(project);
    expectFailure(moveTrack(project, project.tracks.at(-1)!.id, 'up'), 'master-protected');
  });

  it('honors every master boundary while retaining no-master compatibility', () => {
    const project = base();
    const master = project.tracks.at(-1)!;
    const secondMaster = { ...master, id: 'second-master' };
    const between = project.tracks[1]!;
    const segmented = {
      ...project,
      tracks: [project.tracks[0]!, master, between, secondMaster, ...project.tracks.slice(2, -1)],
    };
    expect(expectSuccess(moveTrack(segmented, between.id, 'up')).changed).toBe(false);
    expect(expectSuccess(moveTrack(segmented, between.id, 'down')).changed).toBe(false);

    const withoutMaster = {
      ...project,
      tracks: project.tracks.filter((track) => track.type !== 'master'),
    };
    const last = withoutMaster.tracks.at(-1)!;
    expect(expectSuccess(moveTrack(withoutMaster, last.id, 'up')).changed).toBe(true);
  });

  it('removes only user-managed tracks without stamping the timestamp', () => {
    const project = base();
    const added = expectSuccess(addTrack(project, 'instrument', {
      name: 'Counterline',
      idFactory: sequenceFactory('remove'),
    }));
    const projectWithUserTrack = added.project;
    const userTrack = projectWithUserTrack.tracks.find((track) => track.id === added.trackId)!;
    const result = expectSuccess(removeTrack(projectWithUserTrack, userTrack.id));

    expect(result.project.tracks.some((track) => track.id === userTrack.id)).toBe(false);
    expect(projectWithUserTrack.tracks.some((track) => track.id === userTrack.id)).toBe(true);
    expect(result.project.updatedAt).toBe(projectWithUserTrack.updatedAt);
    expectFailure(removeTrack(project, project.tracks.at(-1)!.id), 'master-protected');
    expectFailure(removeTrack(project, 'missing'), 'track-not-found');
  });

  it('prunes AudioAsset metadata on audio-track removal but preserves shared references', () => {
    const created = createAudioTrackClip(base(), readyAudioAsset(), {
      trackName: 'Imported audio',
      idFactory: sequenceFactory('audio'),
    }, fixedClock);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const shared = expectSuccess(duplicateTrack(created.project, created.trackId, {
      idFactory: sequenceFactory('shared-audio'),
    }));
    const firstRemoval = expectSuccess(removeTrack(shared.project, created.trackId));
    expect(firstRemoval.project.audioAssets).toEqual(created.project.audioAssets);
    expect(validateProject(firstRemoval.project).ok).toBe(true);

    const lastRemoval = expectSuccess(removeTrack(firstRemoval.project, shared.trackId));
    expect(lastRemoval.project.audioAssets).toEqual([]);
    expect(validateProject(lastRemoval.project).ok).toBe(true);
    expect(encodeProjectJson(lastRemoval.project).ok).toBe(true);
  });

  it.each([
    ['Chords', ' cHoRdS '],
    ['Bass', ' BASS '],
    ['Melody', ' melody '],
  ])(
    'protects the schema-v3 %s learning role from removal regardless of name',
    (name, variant) => {
      const project = base();
      const track = project.tracks.find((candidate) => candidate.name === name)!;
      const withVariant = {
        ...project,
        tracks: project.tracks.map((candidate) =>
          candidate.id === track.id ? { ...candidate, name: variant } : candidate,
        ),
      };
      const result = removeTrack(withVariant, track.id);

      expectFailure(result, 'learning-track-protected');
      expect(withVariant.tracks.find((candidate) => candidate.id === track.id)?.name).toBe(variant);
    },
  );
});

describe('setTrackSynthPreset and adoption safety', () => {
  it('accepts only an injected canonical synth allow-list and preserves params', () => {
    const project = richSourceProject();
    const trackId = project.tracks[0]!.id;
    const allowed = ['softPad', 'brightPluck'] as const;
    const result = expectSuccess(setTrackSynthPreset(project, trackId, 'brightPluck', allowed));

    expect(result.changed).toBe(true);
    expect(result.project.tracks[0]!.instrument).toEqual({
      type: 'synth',
      preset: 'brightPluck',
      params: { cutoff: 0.7 },
    });
    expect(project.tracks[0]!.instrument!.preset).toBe('pad');
    expect(result.project.updatedAt).toBe(project.updatedAt);

    const noOp = expectSuccess(setTrackSynthPreset(result.project, trackId, 'brightPluck', allowed));
    expect(noOp.changed).toBe(false);
    expect(noOp.project).toBe(result.project);
    expectFailure(setTrackSynthPreset(project, trackId, 'unknown', allowed), 'invalid-preset');
    expectFailure(
      setTrackSynthPreset(project, project.tracks[3]!.id, 'softPad', allowed),
      'unsupported-track-type',
    );
  });

  it('returns a clear failure when the input project is not codec-adoptable', () => {
    const project = { ...base(), bpm: 5 };
    const result = renameTrack(project, project.tracks[0]!.id, 'New name');
    const failure = expectFailure(result, 'project-not-adoptable');
    expect(failure.error.issues?.some((issue) => issue.path === 'bpm')).toBe(true);
  });
});
