import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
  addTrack,
  buildClipIndex,
  createEmptyProject,
  decodeProject,
  duplicateClip,
  findClip,
  migrateProject,
  preflightScheduleEventBudget,
  resolveClipContent,
  resolveClipSource,
  resizeClip,
  setMidiClipLoop,
  splitClip,
  unlinkClip,
  updateNote,
  validateProject,
  type Clip,
  type Project,
} from '../src/index';

const t0 = () => new Date('2026-07-12T00:00:00.000Z');
const t1 = () => new Date('2026-07-12T01:00:00.000Z');

function midiPattern(): { project: Project; source: Clip; noteId: string } {
  const project = createEmptyProject({ lengthBars: 8, clock: t0 });
  const track = project.tracks.find((candidate) => candidate.type === 'instrument');
  const source = track?.clips[0];
  if (!track || !source) throw new Error('instrument fixture is missing');
  const noteId = 'source-note';
  const patterned: Project = {
    ...project,
    tracks: project.tracks.map((candidate) =>
      candidate.id === track.id
        ? {
            ...candidate,
            clips: [
              {
                ...source,
                lengthBeats: 4,
                notes: [
                  {
                    id: noteId,
                    pitch: 60,
                    startBeat: 0,
                    durationBeats: 1,
                    velocity: 100,
                  },
                ],
              },
            ],
          }
        : candidate,
    ),
  };
  return {
    project: patterned,
    source: findClip(patterned, source.id)!.clip,
    noteId,
  };
}

type LinkedFixture = {
  project: Project;
  source: Clip;
  alias: Clip;
  trackIndex: number;
  aliasPath: string;
};

function linkedFixture(type: 'midi' | 'drum' = 'midi'): LinkedFixture {
  const base = type === 'midi'
    ? midiPattern()
    : (() => {
        const project = createEmptyProject({ lengthBars: 8, clock: t0 });
        const track = project.tracks.find((candidate) => candidate.type === 'drum');
        const source = track?.clips[0];
        if (!track || !source) throw new Error('drum fixture is missing');
        source.lengthBeats = 4;
        return { project, source };
      })();
  const aliasId = type === 'midi' ? 'validation-midi-alias' : 'validation-drum-alias';
  const linked = duplicateClip(
    base.project,
    base.source.id,
    { id: aliasId, startBeat: 4, linked: true },
    t1,
  );
  if (!linked.ok) throw new Error(`linked ${type} fixture could not be created`);
  const located = findClip(linked.project, linked.clipId);
  if (!located) throw new Error(`linked ${type} fixture alias is missing`);
  const trackIndex = linked.project.tracks.findIndex(
    (track) => track.id === located.track.id,
  );
  const aliasIndex = located.track.clips.findIndex((clip) => clip.id === linked.clipId);
  return {
    project: linked.project,
    source: findClip(linked.project, base.source.id)!.clip,
    alias: located.clip,
    trackIndex,
    aliasPath: `tracks[${trackIndex}].clips[${aliasIndex}]`,
  };
}

describe('splitClip', () => {
  it('splits at an absolute whole tick and keeps note ids, durations and the original project', () => {
    const { project, source } = midiPattern();
    source.startBeat = 4;
    source.notes!.push({ id: 'right-note', pitch: 64, startBeat: 2, durationBeats: 1, velocity: 90 });
    const result = splitClip(project, source.id, (5 * 480 + 1) / 480, t1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const left = findClip(result.project, source.id)!.clip;
    const right = findClip(result.project, result.rightClipId)!.clip;
    expect(left.notes).toEqual([source.notes![0]]);
    expect(right.notes).toEqual([{ ...source.notes![1], startBeat: 2 - left.lengthBeats }]);
    expect(left.startBeat + left.lengthBeats).toBe(right.startBeat);
    expect(right.startBeat + right.lengthBeats).toBe(8);
    expect(source.notes).toHaveLength(2);
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('accepts all whole-tick triplet positions at nonzero clip starts', () => {
    expect(splitClipAtTriplet(480, 1 + 2 / 3)).toBe(true);
    for (const startTick of [0, 480, 1920, 1680, 100, 3360]) {
      for (const step of [160, 40]) {
        for (let offset = step; offset < 8 * 480; offset += step) {
          const at = (startTick + offset) / 480;
          expect(splitClipAtTriplet(startTick, at), `start tick ${startTick}, cut ${at}`).toBe(true);
        }
      }
    }

    function splitClipAtTriplet(startTick: number, at: number): boolean {
      const { project, source } = midiPattern();
      Object.assign(source, { startBeat: startTick / 480, lengthBeats: 8, notes: [] });
      return splitClip(project, source.id, at, t1).ok;
    }
  });

  it('rejects clip edges, off-grid positions, hostile values and cuts through notes', () => {
    const { project, source } = midiPattern();
    for (const at of [0, 4, 5, 1 / 960, NaN, Infinity, '2', Symbol(), {
      valueOf() { throw new Error('no coercion'); },
    }]) {
      expect(splitClip(project, source.id, at)).toMatchObject({
        ok: false, project, code: 'split-invalid-position',
      });
    }
    expect(splitClip(project, source.id, 0.5)).toMatchObject({
      ok: false, project, code: 'split-crossing-note',
    });
    source.startBeat = 1 / 960;
    expect(splitClip(project, source.id, 2)).toMatchObject({
      ok: false, project, code: 'split-off-grid-start',
    });
    const inherited = Object.create(project) as Project;
    expect(splitClip(inherited, source.id, 2).ok).toBe(false);
    expect(splitClip(null as unknown as Project, source.id, 2).ok).toBe(false);
  });

  it('keeps linked copies, their source and looping clips intact', () => {
    const { project, source, alias } = linkedFixture();
    expect(splitClip(project, source.id, 2)).toMatchObject({ ok: false, code: 'split-linked-clip' });
    expect(splitClip(project, alias.id, 6)).toMatchObject({ ok: false, code: 'split-linked-clip' });
    const single = midiPattern();
    single.source.loop = true;
    expect(splitClip(single.project, single.source.id, 2)).toMatchObject({
      ok: false, code: 'split-looping-clip',
    });
  });

  it('recognizes a whole-tick drum step at a triplet cut', () => {
    const project = createEmptyProject({ lengthBars: 8, clock: t0 });
    const drum = project.tracks.find((track) => track.type === 'drum')!.clips[0]!;
    Object.assign(drum, { startBeat: 1, lengthBeats: 4, stepsPerBar: 12, drumEvents: [] });
    expect(splitClip(project, drum.id, 800 / 480)).toMatchObject({ ok: true });
  });

  it('requires a drum step and reindexes the candidate against the cut', () => {
    const project = createEmptyProject({ lengthBars: 8, clock: t0 });
    const drum = project.tracks.find((track) => track.type === 'drum')!.clips[0]!;
    drum.drumEvents = [{ id: 'late-hit', lane: 'snare', stepIndex: 9, velocity: 88 }];
    expect(splitClip(project, drum.id, 1 / 480)).toMatchObject({ ok: false, code: 'split-drum-grid' });
    const result = splitClip(project, drum.id, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project, drum.id)?.clip.drumEvents).toEqual([]);
    expect(findClip(result.project, result.rightClipId)?.clip.drumEvents).toEqual([
      { ...drum.drumEvents[0], stepIndex: 1 },
    ]);
  });
});

describe('linked clip content', () => {
  it('stores one payload owner and resolves an alias at its own placement', () => {
    const { project, source, noteId } = midiPattern();
    const result = duplicateClip(
      project,
      source.id,
      { id: 'linked-a-prime', startBeat: 4, linked: true },
      t1,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alias = findClip(result.project, result.clipId)!.clip;
    expect(alias).toEqual({
      id: 'linked-a-prime',
      trackId: source.trackId,
      type: 'midi',
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      aliasOf: source.id,
    });
    expect(resolveClipContent(result.project, alias)).toMatchObject({
      id: alias.id,
      startBeat: 4,
      aliasOf: source.id,
      notes: [expect.objectContaining({ id: noteId, pitch: 60 })],
    });
    expect(validateProject(result.project)).toMatchObject({ ok: true });

    const edited = updateNote(result.project, alias.id, noteId, { pitch: 64 }, t1);
    expect(findClip(edited, source.id)?.clip.notes?.[0]?.pitch).toBe(64);
    expect(
      resolveClipContent(edited, findClip(edited, alias.id)!.clip)?.notes?.[0]?.pitch,
    ).toBe(64);
  });

  it('deep-copies independent content with fresh nested ids', () => {
    const { project, source, noteId } = midiPattern();
    const result = duplicateClip(
      project,
      source.id,
      { id: 'independent-a-prime', startBeat: 4, linked: false },
      t1,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const copy = findClip(result.project, result.clipId)!.clip;
    expect(copy.aliasOf).toBeUndefined();
    expect(copy.notes).toHaveLength(1);
    expect(copy.notes?.[0]?.id).not.toBe(noteId);

    const edited = updateNote(result.project, source.id, noteId, { pitch: 67 }, t1);
    expect(findClip(edited, copy.id)?.clip.notes?.[0]?.pitch).toBe(60);
  });

  it('rejects an injected clip id that collides with any project entity id', () => {
    const { project, source } = midiPattern();
    const before = structuredClone(project);

    expect(duplicateClip(
      project,
      source.id,
      { id: project.tempoMap[0]!.id, startBeat: 4, linked: true },
      t1,
    )).toEqual({ ok: false, reason: 'duplicate-id' });
    expect(project).toEqual(before);

    const bus = addTrack(project, 'bus', {
      idFactory: () => 'clip-collision-bus',
    });
    expect(bus.ok).toBe(true);
    if (!bus.ok) return;
    bus.project.audioRouting.sends.push({
      id: 'clip-collision-send',
      sourceTrackId: source.trackId,
      targetBusId: bus.trackId,
      position: 'post-fader',
      gain: 1,
      enabled: true,
    });
    expect(duplicateClip(
      bus.project,
      source.id,
      { id: 'clip-collision-send', startBeat: 4, linked: true },
      t1,
    )).toEqual({ ok: false, reason: 'duplicate-id' });
  });

  it('rejects a duplicate that would cross the persisted effective-event limit', () => {
    const { project, source } = midiPattern();
    const track = project.tracks.find((candidate) => candidate.id === source.trackId);
    if (!track) throw new Error('instrument fixture is missing');
    source.notes = Array.from({ length: 196 }, (_, index) => ({
      id: `limit-note-${index}`,
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 100,
    }));
    track.clips = [
      source,
      ...Array.from({ length: 1_019 }, (_, index): Clip => ({
        id: `limit-alias-${index}`,
        trackId: track.id,
        type: 'midi',
        startBeat: 0,
        lengthBeats: source.lengthBeats,
        loop: false,
        aliasOf: source.id,
      })),
    ];
    const before = structuredClone(project);

    expect(duplicateClip(
      project,
      source.id,
      { id: 'over-limit-alias', startBeat: 4, linked: true },
      t1,
    )).toEqual({ ok: false, reason: 'event-limit' });
    expect(project).toEqual(before);
  });

  it('unlinks atomically by materializing fresh independent event ids', () => {
    const { project, source, noteId } = midiPattern();
    const linked = duplicateClip(
      project,
      source.id,
      { id: 'linked-a-prime', startBeat: 4, linked: true },
      t1,
    );
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;

    const unlinked = unlinkClip(linked.project, linked.clipId, t1);
    expect(unlinked.ok).toBe(true);
    if (!unlinked.ok) return;
    const copy = findClip(unlinked.project, linked.clipId)!.clip;
    expect(copy.aliasOf).toBeUndefined();
    expect(copy.notes?.[0]?.id).not.toBe(noteId);

    const edited = updateNote(unlinked.project, source.id, noteId, { pitch: 69 }, t1);
    expect(findClip(edited, copy.id)?.clip.notes?.[0]?.pitch).toBe(60);
    expect(validateProject(edited)).toMatchObject({ ok: true });
  });

  it('rejects an out-of-range destination without touching the project', () => {
    const { project, source } = midiPattern();
    expect(
      duplicateClip(project, source.id, { startBeat: 31, linked: true }, t1),
    ).toEqual({ ok: false, reason: 'invalid-destination' });
  });

  it('resizes an unlinked pattern but locks linked lengths', () => {
    const { project, source } = midiPattern();
    const resized = resizeClip(project, source.id, { lengthBeats: 3 }, t1);
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    expect(findClip(resized.project, source.id)?.clip.lengthBeats).toBe(3);

    const linked = duplicateClip(
      project,
      source.id,
      { id: 'linked-a-prime', startBeat: 4, linked: true },
      t1,
    );
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(resizeClip(linked.project, linked.clipId, { lengthBeats: 2 }, t1)).toEqual({
      ok: false,
      reason: 'linked-length-locked',
    });
    expect(resizeClip(linked.project, source.id, { lengthBeats: 2 }, t1)).toEqual({
      ok: false,
      reason: 'linked-dependents',
    });
  });

  it('checks drum content bounds with each local bar signature', () => {
    const project = createEmptyProject({ lengthBars: 4, clock: t0 });
    project.lengthBeats = 13;
    project.timeSignatureMap = [
      { ...project.timeSignatureMap[0]!, beat: 0, numerator: 4, denominator: 4 },
      { id: 'resize-three-four', beat: 4, numerator: 3, denominator: 4 },
    ];
    const drumClip = project.tracks.find((track) => track.type === 'drum')?.clips[0];
    if (!drumClip) throw new Error('drum fixture is missing');
    drumClip.startBeat = 2;
    drumClip.lengthBeats = 7.25;
    drumClip.drumEvents = [{
      id: 'resize-variable-hit',
      lane: 'kick',
      stepIndex: 31,
      velocity: 100,
    }];

    expect(resizeClip(project, drumClip.id, {}, t1)).toMatchObject({ ok: true });

    drumClip.drumEvents[0]!.stepIndex = 34;
    expect(resizeClip(project, drumClip.id, {}, t1)).toEqual({
      ok: false,
      reason: 'content-out-of-range',
    });
  });

  it('sets loop on one linked MIDI instance without changing its source', () => {
    const { project, source, alias } = linkedFixture();

    const result = setMidiClipLoop(project, alias.id, true, t1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findClip(result.project, source.id)?.clip.loop).toBe(false);
    expect(findClip(result.project, alias.id)?.clip.loop).toBe(true);
    expect(resolveClipContent(
      result.project,
      findClip(result.project, alias.id)!.clip,
    )?.loop).toBe(true);
    expect(validateProject(result.project)).toMatchObject({ ok: true });
  });

  it('rejects clip-loop changes for non-MIDI and unresolved instances', () => {
    const drum = linkedFixture('drum');
    expect(setMidiClipLoop(drum.project, drum.source.id, true)).toEqual({
      ok: false,
      reason: 'unsupported-clip-type',
    });

    const midi = linkedFixture();
    const broken: Project = {
      ...midi.project,
      tracks: midi.project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === midi.alias.id ? { ...clip, aliasOf: 'missing-source' } : clip,
        ),
      })),
    };
    expect(setMidiClipLoop(broken, midi.alias.id, true)).toEqual({
      ok: false,
      reason: 'invalid-alias',
    });
  });
});

describe('linked clip validation', () => {
  type InvalidCase = {
    name: string;
    build: () => { project: Project; expected: Array<{ path: string; message: string }> };
  };

  const relationshipCases: InvalidCase[] = [
    {
      name: 'self reference',
      build: () => {
        const fixture = linkedFixture();
        fixture.alias.aliasOf = fixture.alias.id;
        return {
          project: fixture.project,
          expected: [{
            path: `${fixture.aliasPath}.aliasOf`,
            message: 'linked clip must not reference itself',
          }],
        };
      },
    },
    {
      name: 'dangling source',
      build: () => {
        const fixture = linkedFixture();
        fixture.alias.aliasOf = 'missing-source';
        return {
          project: fixture.project,
          expected: [{
            path: `${fixture.aliasPath}.aliasOf`,
            message: 'linked clip source "missing-source" does not exist',
          }],
        };
      },
    },
    {
      name: 'cross-track source',
      build: () => {
        const fixture = linkedFixture();
        const otherTrack = fixture.project.tracks.find(
          (track) => track.type === 'instrument' && track.id !== fixture.source.trackId,
        );
        const otherSource = otherTrack?.clips[0];
        if (!otherTrack || !otherSource) throw new Error('cross-track source is missing');
        otherSource.lengthBeats = fixture.alias.lengthBeats;
        fixture.alias.aliasOf = otherSource.id;
        return {
          project: fixture.project,
          expected: [{
            path: `${fixture.aliasPath}.aliasOf`,
            message: 'linked clip source must belong to the same track',
          }],
        };
      },
    },
    {
      name: 'cross-type source',
      build: () => {
        const fixture = linkedFixture();
        const track = fixture.project.tracks[fixture.trackIndex]!;
        const source: Clip = {
          id: 'cross-type-source',
          trackId: track.id,
          type: 'drum',
          startBeat: 8,
          lengthBeats: fixture.alias.lengthBeats,
          loop: false,
          drumEvents: [],
        };
        track.clips.push(source);
        fixture.alias.aliasOf = source.id;
        return {
          project: fixture.project,
          expected: [{
            path: `${fixture.aliasPath}.aliasOf`,
            message: 'linked clip source must have the same clip type',
          }],
        };
      },
    },
    {
      name: 'chained alias',
      build: () => {
        const fixture = linkedFixture();
        const track = fixture.project.tracks[fixture.trackIndex]!;
        const chainedIndex = track.clips.length;
        track.clips.push({
          id: 'chained-alias',
          trackId: track.id,
          type: 'midi',
          startBeat: 8,
          lengthBeats: fixture.alias.lengthBeats,
          loop: false,
          aliasOf: fixture.alias.id,
        });
        return {
          project: fixture.project,
          expected: [{
            path: `tracks[${fixture.trackIndex}].clips[${chainedIndex}].aliasOf`,
            message: 'linked clip must reference a canonical source directly',
          }],
        };
      },
    },
    {
      name: 'length mismatch',
      build: () => {
        const fixture = linkedFixture();
        fixture.alias.lengthBeats = 2;
        return {
          project: fixture.project,
          expected: [{
            path: `${fixture.aliasPath}.lengthBeats`,
            message: 'linked clip length must match its source',
          }],
        };
      },
    },
  ];

  it.each(relationshipCases)('rejects $name with the exact diagnostic', ({ build }) => {
    const { project, expected } = build();
    expect(validateProject(project).errors).toEqual(expected);
  });

  const payloadCases: InvalidCase[] = [
    {
      name: 'MIDI notes',
      build: () => {
        const fixture = linkedFixture();
        fixture.alias.notes = [];
        return {
          project: fixture.project,
          expected: [{
            path: `${fixture.aliasPath}.notes`,
            message: 'linked clip payload belongs to its source',
          }],
        };
      },
    },
    {
      name: 'drum events',
      build: () => {
        const fixture = linkedFixture('drum');
        fixture.alias.drumEvents = [];
        return {
          project: fixture.project,
          expected: [{
            path: `${fixture.aliasPath}.drumEvents`,
            message: 'linked clip payload belongs to its source',
          }],
        };
      },
    },
    {
      name: 'drum stepsPerBar',
      build: () => {
        const fixture = linkedFixture('drum');
        fixture.alias.stepsPerBar = 16;
        return {
          project: fixture.project,
          expected: [{
            path: `${fixture.aliasPath}.stepsPerBar`,
            message: 'linked clip payload belongs to its source',
          }],
        };
      },
    },
    {
      name: 'drum groove',
      build: () => {
        const fixture = linkedFixture('drum');
        fixture.alias.drumGroove = {
          swing: 0.2,
          probability: 0.9,
          humanizeVelocity: 4,
          seed: 1,
        };
        return {
          project: fixture.project,
          expected: [{
            path: `${fixture.aliasPath}.drumGroove`,
            message: 'linked clip payload belongs to its source',
          }],
        };
      },
    },
    {
      name: 'audio asset id',
      build: () => {
        const fixture = linkedFixture();
        fixture.alias.audioAssetId = 'asset-on-alias';
        return {
          project: fixture.project,
          expected: [
            {
              path: `${fixture.aliasPath}.audioAssetId`,
              message: 'linked clip payload belongs to its source',
            },
            {
              path: `${fixture.aliasPath}.audioAssetId`,
              message: 'audioAssetId is only allowed on audio clips',
            },
          ],
        };
      },
    },
  ];

  it.each(payloadCases)('rejects alias-owned $name with the exact diagnostic', ({ build }) => {
    const { project, expected } = build();
    expect(validateProject(project).errors).toEqual(expected);
  });

  it('rejects a maximum-length alias chain with bounded one-hop work', () => {
    const project = createEmptyProject({ lengthBars: 1, clock: t0 });
    const track = project.tracks.find((candidate) => candidate.type === 'instrument');
    if (!track) throw new Error('instrument fixture is missing');
    const chain = Array.from({ length: 1_024 }, (_, index): Clip => ({
      id: `chain-${index}`,
      trackId: track.id,
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      ...(index < 1_023 ? { aliasOf: `chain-${index + 1}` } : {
        notes: [{
          id: 'chain-terminal-note',
          pitch: 60,
          startBeat: 0,
          durationBeats: 1,
          velocity: 90,
        }],
      }),
    }));
    track.clips = chain;
    expect(validateProject(project).ok).toBe(false);

    let aliasReads = 0;
    for (const [index, clip] of chain.entries()) {
      const aliasOf = index < 1_023 ? `chain-${index + 1}` : undefined;
      Object.defineProperty(clip, 'aliasOf', {
        configurable: true,
        enumerable: aliasOf !== undefined,
        get: () => {
          aliasReads += 1;
          return aliasOf;
        },
      });
    }
    const index = buildClipIndex(project);
    expect(resolveClipSource(project, chain[0]!, index)).toBeNull();
    aliasReads = 0;

    expect(preflightScheduleEventBudget(project, {
      limit: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
      projection: 'resolved-stored',
      clipIndex: index,
    })).toEqual({
      ok: true,
      eventCount: 2,
      limit: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
    });
    expect(aliasReads).toBeLessThanOrEqual(chain.length * 2);
  });
});

describe('project schema v1 to v2 clip migration', () => {
  it('drops the formerly inert alias marker without changing clip payload', () => {
    const { project } = midiPattern();
    const legacy = structuredClone(project) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.swing;
    delete legacy.hiHatChoke;
    const tracks = legacy.tracks as Array<{ clips: Array<Record<string, unknown>> }>;
    delete legacy.lengthBeats;
    delete legacy.tempoMap;
    delete legacy.timeSignatureMap;
    delete legacy.audioAssets;
    delete legacy.audioTakeFolders;
    delete legacy.automationLanes;
    delete legacy.automationReadState;
    delete legacy.audioRouting;
    for (const track of tracks as Array<Record<string, unknown>>) delete track.role;
    tracks[1]!.clips[0]!.aliasOf = 'formerly-ignored';

    const migrated = migrateProject(legacy);
    const migratedTracks = migrated.tracks as Array<{
      clips: Array<Record<string, unknown>>;
    }>;
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migratedTracks[1]!.clips[0]!.aliasOf).toBeUndefined();
    expect(migratedTracks[1]!.clips[0]!.notes).toEqual(
      tracks[1]!.clips[0]!.notes,
    );
    expect(tracks[1]!.clips[0]!.aliasOf).toBe('formerly-ignored');

    const decoded = decodeProject(legacy);
    expect(decoded).toMatchObject({
      ok: true,
      sourceSchemaVersion: 1,
      migrated: true,
    });
    if (decoded.ok) {
      expect(decoded.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(decoded.project.tracks[1]?.clips[0]?.aliasOf).toBeUndefined();
    }
  });
});
