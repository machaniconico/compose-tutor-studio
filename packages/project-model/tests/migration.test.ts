import { describe, it, expect } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  PROJECT_TEMPLATES,
  createDefaultProject,
  createEmptyProject,
  deserializeProject,
  instantiateTemplate,
  migrateProject,
  serializeProject,
  validateProject,
} from '../src/index';
import type { Project, TemplateId } from '../src/index';
import { createDefaultProject as createStudioDefaultProject } from '../../../apps/studio/src/state/defaultProject';
import { createSampleProject } from '../../../apps/studio/src/state/sampleProject';
import { buildScheduleEvents, type SchedulePayload } from '../../../apps/studio/src/audio/events';
import { renderScheduleEvents, songSoundEndBeat } from '../../../apps/studio/src/audio/wav';

function note(id: string, startBeat: number, durationBeats: number) {
  return { id, pitch: 60, startBeat, durationBeats, velocity: 100 };
}

function instrumentTrack(id: string, name: string, clips: unknown[] = []) {
  return { id, name, type: 'instrument', clips, volume: 0.8, pan: 0, mute: false, solo: false, effects: [] };
}

/** A hand-written v1 file: values are spelled out, never produced by the code under test. */
function v1Project(): Record<string, unknown> {
  return {
    id: 'project-v1',
    schemaVersion: 1,
    title: '古い曲',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    tracks: [
      instrumentTrack('t-chords', 'Chords'),
      instrumentTrack('t-bass', 'BASS', [
        {
          id: 'c-over',
          trackId: 't-bass',
          type: 'midi',
          startBeat: 0,
          lengthBeats: 4,
          loop: false,
          notes: [note('n1', 0, 1), note('n2', 5, 1.5)],
        },
        {
          id: 'c-fits',
          trackId: 't-bass',
          type: 'midi',
          startBeat: 8,
          lengthBeats: 8,
          loop: false,
          notes: [note('n3', 0, 2)],
        },
      ]),
      instrumentTrack('t-melody', 'melody'),
      instrumentTrack('t-lead', 'Lead Synth'),
      instrumentTrack('t-chord', 'chord'),
      instrumentTrack('t-pad', 'Pad'),
      instrumentTrack('t-bassoon', 'Bassoon'),
      {
        ...instrumentTrack('t-drums', 'リズム', [
          {
            id: 'c-drum',
            trackId: 't-drums',
            type: 'drum',
            startBeat: 0,
            lengthBeats: 4,
            loop: false,
            stepsPerBar: 16,
            drumEvents: [{ id: 'd1', lane: 'kick', stepIndex: 19, velocity: 100 }],
          },
        ]),
        type: 'drum',
      },
      {
        id: 't-master',
        name: 'Master',
        type: 'master',
        clips: [],
        volume: 0.9,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
    ],
    chordTrack: [],
    sections: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function migratedTrack(project: Project, id: string) {
  const track = project.tracks.find((t) => t.id === id);
  if (!track) throw new Error(`missing track ${id}`);
  return track;
}

describe('legacy live and WAV timing', () => {
  it.each([1, 2])('ignores stored swing in a v%i file and keeps the full note', (schemaVersion) => {
    const raw = {
      ...v1Project(),
      schemaVersion,
      swing: 60,
      tracks: [instrumentTrack('t-keys', 'Keys', [{
        id: 'c-swing', trackId: 't-keys', type: 'midi', startBeat: 0,
        lengthBeats: 1, loop: false, notes: [note('n-swing', 0.75, 0.25)],
      }])],
    };
    expect(validateProject(raw as unknown as Project).errors).toEqual([]);

    const project = deserializeProject(JSON.stringify(raw));
    const live = buildScheduleEvents(project);
    expect(live).toMatchObject([{ beat: 0.75, payload: { kind: 'note', durationBeats: 0.25 } }]);
    expect(renderScheduleEvents(project)).toEqual([{ ...live[0], time: 0.375 }]);

    const saved = serializeProject(project);
    const reloaded = deserializeProject(saved);
    expect(serializeProject(reloaded)).toBe(saved);
    expect(buildScheduleEvents(reloaded)).toEqual(live);

    const native = deserializeProject(JSON.stringify({ ...raw, schemaVersion: 3 }));
    expect(buildScheduleEvents(native)).toMatchObject([{ beat: 0.9, payload: { cut: true } }]);
  });

  it.each([
    { timeSignature: [6, 8], lengthBars: 33, convertedBars: 66, end: 198, onset: 193.25 },
    { timeSignature: [6, 16], lengthBars: 64, convertedBars: 256, end: 384, onset: 383.25 },
  ])('keeps a v1 song and its final notes through $convertedBars converted bars', ({
    timeSignature, lengthBars, convertedBars, end, onset,
  }) => {
    const raw = {
      ...v1Project(),
      timeSignature,
      lengthBars,
      sections: [{ id: 's-all', name: 'A', type: 'verse', startBar: 0, lengthBars }],
      tracks: [instrumentTrack('t-keys', 'Keys', [{
        id: 'c-final', trackId: 't-keys', type: 'midi', startBeat: onset,
        lengthBeats: 0.5, loop: false, notes: [note('n-final', 0, 0.5)],
      }])],
    };
    expect(validateProject(raw as unknown as Project).errors).toEqual([]);

    const project = deserializeProject(JSON.stringify(raw));
    const live = buildScheduleEvents(project);
    expect(live).toMatchObject([{ beat: onset, payload: { kind: 'note', durationBeats: 0.5 } }]);
    expect(renderScheduleEvents(project)).toEqual([{ ...live[0], time: onset / 2 }]);
    expect(songSoundEndBeat(project)).toBe(end);
    expect(project.lengthBars).toBe(convertedBars);
    expect(project.sections[0]?.lengthBars).toBe(convertedBars);
    expect(validateProject(project).errors).toEqual([]);

    const saved = serializeProject(project);
    const reloaded = deserializeProject(saved);
    expect(serializeProject(reloaded)).toBe(saved);
    expect(buildScheduleEvents(reloaded)).toEqual(live);
    expect(songSoundEndBeat(reloaded)).toBe(end);
  });
});

describe('migrateProject v1 -> v2', () => {
  it('upgrades a v1 project to a valid current project', () => {
    const migrated = migrateProject(v1Project()) as unknown as Project;

    expect(migrated.schemaVersion).toBe(3);
    expect(migratedTrack(migrated, 't-master').volume).toBe(1);
    expect(validateProject(migrated).errors).toEqual([]);
  });

  it('extends lengthBeats to the last note end and keeps longer clips unchanged', () => {
    const migrated = migrateProject(v1Project()) as unknown as Project;
    const [over, fits] = migratedTrack(migrated, 't-bass').clips;

    expect(over?.lengthBeats).toBe(6.5);
    expect(fits?.lengthBeats).toBe(8);
  });

  it('extends lengthBeats to the end of the last drum step', () => {
    const migrated = migrateProject(v1Project()) as unknown as Project;

    // Step 19 of a 16-step 4/4 bar starts at beat 4.75 and ends at beat 5.
    expect(migratedTrack(migrated, 't-drums').clips[0]?.lengthBeats).toBe(5);
  });

  describe('legacy 6/8 files (v1 counted a bar as 6 beats, v2 as 3)', () => {
    /** Where v1 playback put a drum step: `step * numerator / stepsPerBar` beats. */
    const v1HitBeat = (stepIndex: number, stepsPerBar: number, numerator: number) =>
      (stepIndex * numerator) / stepsPerBar;

    function sixEight(drumEvents: Array<Record<string, unknown>>, stepsPerBar = 16) {
      const raw = v1Project();
      raw.timeSignature = [6, 8];
      raw.sections = [
        { id: 's-a', name: 'A', type: 'verse', startBar: 0, lengthBars: 2 },
        { id: 's-b', name: 'B', type: 'chorus', startBar: 2, lengthBars: 6 },
      ];
      const tracks = raw.tracks as Array<{ id: string; clips: Array<Record<string, unknown>> }>;
      const drumClip = tracks.find((track) => track.id === 't-drums')!.clips[0]!;
      drumClip.lengthBeats = 3;
      drumClip.stepsPerBar = stepsPerBar;
      drumClip.drumEvents = drumEvents;
      return raw;
    }

    it('keeps every drum hit at the beat it was heard at (step 16 stays on beat 6)', () => {
      const raw = sixEight([
        { id: 'd1', lane: 'kick', stepIndex: 16, velocity: 100 },
        { id: 'd2', lane: 'snare', stepIndex: 19, velocity: 90 },
      ]);
      const oldHitBeats = [v1HitBeat(16, 16, 6), v1HitBeat(19, 16, 6)];
      expect(oldHitBeats).toEqual([6, 7.125]);

      const migrated = migrateProject(raw) as unknown as Project;
      const drums = migratedTrack(migrated, 't-drums').clips[0]!;
      const playedBeats = buildScheduleEvents(migrated)
        .filter((event) => (event.payload as SchedulePayload).kind === 'drum')
        .map((event) => event.beat);

      expect(playedBeats).toEqual(oldHitBeats);
      // 16 steps over 6 beats = 8 steps over 3 beats: same step numbers, half the grid.
      expect(drums.stepsPerBar).toBe(8);
      expect(drums.drumEvents?.map((e) => e.stepIndex)).toEqual([16, 19]);
      // Step 19 ends at beat 7.5, so the clip grows to cover it.
      expect(drums.lengthBeats).toBe(7.5);
    });

    it('keeps the song length and the sections at their beat span (8 bars of 6 beats -> 16 bars of 3)', () => {
      const migrated = migrateProject(sixEight([])) as unknown as Project;
      expect(migrated.lengthBars).toBe(16);
      expect(migrated.sections.map((s) => [s.startBar, s.lengthBars])).toEqual([
        [0, 4],
        [4, 12],
      ]);
      expect(validateProject(migrated).errors).toEqual([]);
    });

    it('refines the grid instead of rounding when the step count does not halve evenly', () => {
      // 9 steps over 6 beats: step 4 was heard at beat 2.666..., which has no place on a 4.5-step grid.
      const raw = sixEight([{ id: 'd1', lane: 'kick', stepIndex: 4, velocity: 100 }], 9);
      const migrated = migrateProject(raw) as unknown as Project;
      const drums = migratedTrack(migrated, 't-drums').clips[0]!;
      expect(drums.stepsPerBar).toBe(36);
      expect(drums.drumEvents?.map((e) => e.stepIndex)).toEqual([32]);
      const playedBeats = buildScheduleEvents(migrated)
        .filter((event) => (event.payload as SchedulePayload).kind === 'drum')
        .map((event) => event.beat);
      expect(playedBeats).toEqual([v1HitBeat(4, 9, 6)]);
    });

    it('leaves x/4 files untouched apart from the v2 fields', () => {
      const migrated = migrateProject(v1Project()) as unknown as Project;
      expect(migrated.lengthBars).toBe(8);
      expect(migratedTrack(migrated, 't-drums').clips[0]?.stepsPerBar).toBe(16);
    });
  });

  it('keeps playback events unchanged for clips that start after beat 0', () => {
    const raw = v1Project();
    const tracks = raw.tracks as Array<{ id: string; clips: Array<Record<string, unknown>> }>;
    const clipById = new Map(tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip])));
    clipById.get('c-over')!.startBeat = 8;
    clipById.get('c-drum')!.startBeat = 4;
    // v1 playback ignored lengthBeats; today's playback honors it (US-007), so
    // the v1 sound is reproduced by lifting the length limit on a copy.
    const v1Sound = structuredClone(raw) as unknown as Project;
    for (const clip of v1Sound.tracks.flatMap((track) => track.clips)) clip.lengthBeats = Infinity;
    const beforeMigration = buildScheduleEvents(v1Sound);

    const migrated = migrateProject(raw) as unknown as Project;

    expect(buildScheduleEvents(migrated)).toEqual(beforeMigration);
    expect(beforeMigration.map((event) => event.beat)).toEqual([8, 13, 8, 8.75]);
    // lengthBeats stays relative to the clip start, so the offset is not added.
    expect(migratedTrack(migrated, 't-bass').clips[0]?.lengthBeats).toBe(6.5);
    expect(migratedTrack(migrated, 't-drums').clips[0]?.lengthBeats).toBe(5);
  });

  it('turns off the loop of a v1 loop clip, so each note still sounds once', () => {
    // v1 playback ignored loop and the loop period: C@0 and D@3 sounded once each.
    const raw = v1Project();
    raw.tracks = [
      instrumentTrack('t-keys', 'Keys', [
        {
          id: 'c-loop',
          trackId: 't-keys',
          type: 'midi',
          startBeat: 0,
          lengthBeats: 4,
          contentLengthBeats: 2,
          loop: true,
          notes: [
            { id: 'c', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
            { id: 'd', pitch: 62, startBeat: 3, durationBeats: 1, velocity: 100 },
          ],
        },
      ]),
    ];

    const migrated = migrateProject(raw) as unknown as Project;
    const heard = buildScheduleEvents(migrated).map((event) => [
      event.beat,
      (event.payload as Extract<SchedulePayload, { kind: 'note' }>).pitch,
    ]);

    expect(heard).toEqual([
      [0, 60],
      [3, 62],
    ]);
    const clip = migratedTrack(migrated, 't-keys').clips[0]!;
    expect(clip).toMatchObject({ loop: false, lengthBeats: 4 });
    expect(clip.contentLengthBeats).toBeUndefined();
  });

  it('removes the link of a v1 linked clip, so it still sounds its own notes', () => {
    // v1 playback ignored aliasOf: the clip at beat 8 sounded its own E.
    const raw = v1Project();
    raw.tracks = [
      instrumentTrack('t-keys', 'Keys', [
        {
          id: 'c-src',
          trackId: 't-keys',
          type: 'midi',
          startBeat: 0,
          lengthBeats: 4,
          loop: false,
          notes: [{ id: 'c', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
        },
        {
          id: 'c-alias',
          trackId: 't-keys',
          type: 'midi',
          startBeat: 8,
          lengthBeats: 4,
          loop: false,
          aliasOf: 'c-src',
          notes: [{ id: 'e', pitch: 64, startBeat: 0, durationBeats: 1, velocity: 100 }],
        },
      ]),
    ];

    const migrated = migrateProject(raw) as unknown as Project;
    const heard = buildScheduleEvents(migrated).map((event) => [
      event.beat,
      (event.payload as Extract<SchedulePayload, { kind: 'note' }>).pitch,
    ]);

    expect(heard).toEqual([
      [0, 60],
      [8, 64],
    ]);
    expect(migratedTrack(migrated, 't-keys').clips[1]!.aliasOf).toBeUndefined();
  });

  it('leaves saved v3 clip settings as written: v3 length, loop and links are the sound', () => {
    // A v3 file already means "length, loop and links are honored" (docs/06), so
    // loading it must not stretch the clip: the note at beat 5 of a 4-beat clip
    // stays cut, and the loop is kept.
    const saved = {
      ...(migrateProject(v1Project()) as Record<string, unknown>),
      tracks: [
        instrumentTrack('t-keys', 'Keys', [
          {
            id: 'c-v2',
            trackId: 't-keys',
            type: 'midi',
            startBeat: 0,
            lengthBeats: 4,
            contentLengthBeats: 2,
            loop: true,
            notes: [
              { id: 'c', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
              { id: 'late', pitch: 62, startBeat: 5, durationBeats: 1, velocity: 100 },
            ],
          },
        ]),
      ],
    };

    const reloaded = deserializeProject(JSON.stringify(saved));

    expect(reloaded.tracks[0]!.clips[0]).toEqual(saved.tracks[0]!.clips[0]);
    expect(buildScheduleEvents(reloaded).map((event) => event.beat)).toEqual([0, 2]);
  });

  it('migrates a clip with 150,000 notes', () => {
    const raw = v1Project();
    const [bassTrack] = (raw.tracks as Array<{ id: string; clips: unknown[] }>).filter(
      (track) => track.id === 't-bass',
    );
    const notes = Array.from({ length: 150_000 }, (_, index) => note(`bulk-${index}`, index, 1));
    bassTrack!.clips = [
      { id: 'c-bulk', trackId: 't-bass', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, notes },
    ];

    const migrated = migrateProject(raw) as unknown as Project;

    expect(migratedTrack(migrated, 't-bass').clips[0]?.lengthBeats).toBe(150_000);
  });

  it('defaults a missing stepsPerBar to 16 like playback', () => {
    const raw = v1Project();
    const drums = (raw.tracks as Array<{ id: string; clips: Array<Record<string, unknown>> }>).find(
      (t) => t.id === 't-drums',
    );
    delete drums?.clips[0]?.stepsPerBar;
    const migrated = migrateProject(raw) as unknown as Project;

    expect(migratedTrack(migrated, 't-drums').clips[0]?.lengthBeats).toBe(5);
  });

  it('infers roles from names case-insensitively and from the drum track type', () => {
    const migrated = migrateProject(v1Project()) as unknown as Project;
    const role = (id: string) => migratedTrack(migrated, id).role;

    expect(role('t-chords')).toBe('chords');
    expect(role('t-chord')).toBe('chords');
    expect(role('t-bass')).toBe('bass');
    expect(role('t-melody')).toBe('melody');
    expect(role('t-lead')).toBe('melody');
    expect(role('t-drums')).toBe('drums');
  });

  it('leaves the role unset when the name gives no match', () => {
    const migrated = migrateProject(v1Project()) as unknown as Project;

    expect(migratedTrack(migrated, 't-pad')).not.toHaveProperty('role');
    expect(migratedTrack(migrated, 't-bassoon')).not.toHaveProperty('role');
    expect(migratedTrack(migrated, 't-master')).not.toHaveProperty('role');
  });

  it('does not mutate its input', () => {
    const raw = v1Project();
    const before = JSON.stringify(raw);
    migrateProject(raw);

    expect(JSON.stringify(raw)).toBe(before);
  });

  it('is idempotent', () => {
    const once = migrateProject(v1Project());
    const twice = migrateProject(structuredClone(once));

    expect(twice).toEqual(once);
  });

  it('does not throw on a v1 file with malformed tracks or clips', () => {
    expect(migrateProject({ schemaVersion: 1 }).schemaVersion).toBe(3);
    const migrated = migrateProject({
      schemaVersion: 1,
      tracks: [null, { type: 'instrument', name: 7, clips: [null, { lengthBeats: 4, notes: [null] }] }],
    });
    expect(migrated.schemaVersion).toBe(3);
  });

  it('rejects a file from a newer schema version', () => {
    expect(() => migrateProject({ schemaVersion: 4 })).toThrow(/newer/);
  });

  it('migrates through deserializeProject', () => {
    const project = deserializeProject(JSON.stringify(v1Project()));

    expect(project.schemaVersion).toBe(3);
  });
});

describe('migrateProject v2 -> v3', () => {
  /**
   * A hand-written v2 file. v2 live playback ignored clip length, loop and
   * links: each clip sounded its own notes once, even past the clip end.
   */
  function v2File(): string {
    return JSON.stringify({
      id: 'project-v2',
      schemaVersion: 2,
      title: 'v2 の曲',
      bpm: 120,
      key: 'C',
      scale: 'major',
      timeSignature: [4, 4],
      lengthBars: 8,
      tracks: [
        instrumentTrack('t-keys', 'Keys', [
          {
            id: 'short',
            trackId: 't-keys',
            type: 'midi',
            startBeat: 0,
            lengthBeats: 4,
            loop: false,
            notes: [
              { id: 'in', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
              { id: 'late', pitch: 64, startBeat: 5, durationBeats: 1, velocity: 100 },
            ],
          },
          {
            id: 'looped',
            trackId: 't-keys',
            type: 'midi',
            startBeat: 8,
            lengthBeats: 8,
            contentLengthBeats: 2,
            loop: true,
            notes: [{ id: 'once', pitch: 67, startBeat: 0, durationBeats: 1, velocity: 100 }],
          },
          {
            id: 'linked',
            trackId: 't-keys',
            type: 'midi',
            startBeat: 16,
            lengthBeats: 4,
            loop: false,
            aliasOf: 'short',
            notes: [{ id: 'own', pitch: 72, startBeat: 1, durationBeats: 1, velocity: 100 }],
          },
        ]),
        { id: 't-master', name: 'Master', type: 'master', clips: [], volume: 1, pan: 0, mute: false, solo: false, effects: [] },
      ],
      chordTrack: [],
      sections: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
  }

  function v3Heard(project: Project): Array<[number, number, number]> {
    return buildScheduleEvents(project)
      .map((event): [number, number, number] => {
        const payload = event.payload as Extract<SchedulePayload, { kind: 'note' }>;
        return [event.beat, payload.pitch, payload.durationBeats];
      })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  it('keeps the late note and plays each clip’s own notes once', () => {
    const file = v2File();
    const project = deserializeProject(file);

    expect(project.schemaVersion).toBe(3);
    expect(v3Heard(project)).toEqual([
      [0, 60, 1],
      [5, 64, 1],
      [8, 67, 1],
      [17, 72, 1],
    ]);
  });

  it('lengthens the plain clip and clears the legacy loop and link settings', () => {
    const [short, looped, linked] = deserializeProject(v2File()).tracks[0]!.clips;

    expect(short!.lengthBeats).toBe(6);
    expect(looped).toMatchObject({ lengthBeats: 8, loop: false });
    expect(looped).not.toHaveProperty('contentLengthBeats');
    expect(linked).toMatchObject({ lengthBeats: 4, loop: false });
    expect(linked).not.toHaveProperty('aliasOf');
    expect(linked!.notes).toHaveLength(1);
  });

  it('disables playback looping when a legacy file omitted loop', () => {
    const file = JSON.parse(v2File()) as { tracks: Array<{ clips: Array<{ loop?: boolean }> }> };
    const plainClip = file.tracks[0]!.clips[0]!;
    delete plainClip.loop;

    const project = deserializeProject(JSON.stringify(file));
    expect(project.tracks[0]!.clips[0]!.loop).toBe(false);
    expect(project.tracks[0]!.clips[0]!.legacyClipSettings).toBeUndefined();
  });

  it('keeps the playback of a migrated linked loop through a save and reload', () => {
    const file = JSON.parse(v2File()) as { tracks: Array<{ clips: unknown[] }> };
    file.tracks[0]!.clips.push({
      id: 'loop-link',
      trackId: 't-keys',
      type: 'midi',
      startBeat: 24,
      lengthBeats: 4,
      contentLengthBeats: 1,
      loop: true,
      aliasOf: 'source',
      notes: [{ id: 'own', pitch: 50, startBeat: 2, durationBeats: 1, velocity: 100 }],
    });
    file.tracks[0]!.clips.push({
      id: 'source',
      trackId: 't-keys',
      type: 'midi',
      startBeat: 28,
      lengthBeats: 1,
      loop: false,
      notes: [{ id: 'src', pitch: 48, startBeat: 0, durationBeats: 1, velocity: 100 }],
    });
    const legacy = JSON.stringify(file);

    const migrated = deserializeProject(legacy);
    const reloaded = deserializeProject(serializeProject(migrated));

    const clip = reloaded.tracks[0]!.clips.find((c) => c.id === 'loop-link')!;
    expect(clip).toMatchObject({ loop: false, lengthBeats: 4 });
    expect(clip).not.toHaveProperty('aliasOf');
    expect(clip).not.toHaveProperty('contentLengthBeats');
    expect(v3Heard(reloaded)).toEqual(v3Heard(migrated));
    expect(v3Heard(reloaded).filter(([beat]) => beat >= 24 && beat < 28)).toEqual([
      [26, 50, 1],
    ]);
  });
});

describe('generated projects', () => {
  const clock = () => new Date('2026-06-11T00:00:00.000Z');

  it('uses schema version 3', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
  });

  it.each<[string, () => Project]>([
    ['studio default project', () => createStudioDefaultProject('テスト')],
    ['studio sample project', () => createSampleProject()],
    ['factory.ts default project', () => createDefaultProject()],
    ['factories.ts empty project', () => createEmptyProject({ clock })],
    ...(Object.keys(PROJECT_TEMPLATES) as TemplateId[]).map((id): [string, () => Project] => [
      `template ${id}`,
      () => instantiateTemplate(id, clock),
    ]),
  ])('%s is current and has a unity master', (_name, create) => {
    const project = create();

    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(project.tracks.find((t) => t.type === 'master')?.volume).toBe(1);
  });
});
