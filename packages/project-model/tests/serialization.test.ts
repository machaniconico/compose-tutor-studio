import { describe, it, expect } from 'vitest';
import {
  createEmptyProject,
  serializeProject,
  deserializeProject,
  migrateProject,
  instantiateTemplate,
} from '../src/index';

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
    expect(migrated.schemaVersion).toBe(1);
  });

  it('throws when no migration path exists for an old version', () => {
    // schemaVersion 0 has no registered migration to 1 yet.
    expect(() => migrateProject({ schemaVersion: 0 })).toThrow(/No migration/);
  });
});
