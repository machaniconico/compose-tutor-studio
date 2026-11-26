import { describe, it, expect } from 'vitest';
import {
  createEmptyProject,
  serializeProject,
  deserializeProject,
  migrateProject,
  instantiateTemplate,
  findProjectSoundingLimitProblem,
  MAX_SOUNDING_EVENTS,
  soundingEvents,
  validateProject,
} from '../src/index';
import { makeProject, makeTrack, midiClip } from './acceptance/helpers';

const clock = () => new Date('2026-06-11T00:00:00.000Z');

describe('serialization', () => {
  it('round-trips an empty project', () => {
    const project = createEmptyProject({ clock });
    const json = serializeProject(project);
    const restored = deserializeProject(json);
    expect(restored).toEqual(project);
  });

  it('deserializes JSON with a UTF-8 BOM', () => {
    const project = createEmptyProject({ clock });
    const restored = deserializeProject(`\uFEFF${serializeProject(project)}`);
    expect(restored).toEqual(project);
  });

  it('round-trips a template project including chords and drums', () => {
    const project = instantiateTemplate('8bar-pop', clock);
    const restored = deserializeProject(serializeProject(project));
    expect(restored).toEqual(project);
    expect(restored.chordTrack).toEqual(project.chordTrack);
  });

  it('preserves every note when repairing overlaps in a project at the input limit', () => {
    const empty = midiClip('empty', 't', 0, 1, []);
    const full = midiClip('full', 't', 0, 1, []);
    full.notes = Array.from({ length: MAX_SOUNDING_EVENTS - 3 }, (_, index) => ({
      id: `note-${index}`, pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100,
    }));
    const project = makeProject([makeTrack('t', 'instrument', [empty, full])]);
    expect(findProjectSoundingLimitProblem(project)).toBeUndefined();
    expect(validateProject(project).errors.map((error) => error.path)).toEqual(['tracks[0].clips[1].startBeat']);

    const restored = deserializeProject(serializeProject(project));
    expect(validateProject(restored).errors).toEqual([]);
    expect(restored.tracks.map((track) => track.clips.map((clip) => [clip.id, clip.startBeat])))
      .toEqual([[['empty', 0]], [['full', 0]]]);
    expect(soundingEvents(restored).events).toHaveLength(full.notes.length);
    expect(deserializeProject(serializeProject(restored))).toEqual(restored);
  });

  it('loads a current-version track with a null name and preserves its audible notes', () => {
    const project = makeProject([makeTrack('t', 'instrument', [
      midiClip('clip', 't', 0, 1, [[0, 1, 60]]),
    ])]);
    const restored = deserializeProject(JSON.stringify({
      ...project,
      tracks: project.tracks.map((track) => ({ ...track, name: null })),
    }));
    expect(validateProject(restored).errors).toEqual([]);
    expect(soundingEvents(restored).events).toEqual(soundingEvents(project).events);
    expect(restored.tracks[0]?.name).toBe('名前のないトラック');
  });

  it('rejects invalid JSON input', () => {
    expect(() => deserializeProject('null')).toThrow();
    expect(() => deserializeProject('123')).toThrow();
  });

  it('rejects a future schema version', () => {
    const project = createEmptyProject({ clock });
    const future = serializeProject({ ...project, schemaVersion: 999 });
    expect(() => deserializeProject(future)).toThrow(/newer/);
  });

  it('passes through a current-version project without migration', () => {
    const project = createEmptyProject({ clock });
    const raw = JSON.parse(serializeProject(project)) as Record<string, unknown>;
    const migrated = migrateProject(raw);
    expect(migrated.schemaVersion).toBe(3);
  });

  it('throws when no migration path exists for an old version', () => {
    // schemaVersion 0 has no registered migration to 1 yet.
    expect(() => migrateProject({ schemaVersion: 0 })).toThrow(/No migration/);
  });
});
