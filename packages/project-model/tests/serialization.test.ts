import { describe, it, expect } from 'vitest';
import {
  createEmptyProject,
  CURRENT_SCHEMA_VERSION,
  serializeProject,
  deserializeProject,
  migrateProject,
  instantiateTemplate,
  encodeProjectJson,
} from '../src/index';

const clock = () => new Date('2026-06-11T00:00:00.000Z');

describe('serialization', () => {
  it('round-trips an empty project', () => {
    const project = createEmptyProject({ clock });
    const json = serializeProject(project);
    const restored = deserializeProject(json);
    expect(restored).toEqual(project);
  });

  it('uses the canonical compact payload so every export remains importable', () => {
    const project = instantiateTemplate('8bar-pop', clock);
    const json = serializeProject(project);
    const canonical = encodeProjectJson(project);

    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    expect(json).toBe(canonical.json);
    expect(json).not.toContain('\n');
    expect(deserializeProject(json)).toEqual(project);
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
    const future = JSON.stringify({ ...project, schemaVersion: 999 });
    expect(() => deserializeProject(future)).toThrow(/future-schema-version/);
  });

  it('passes through a current-version project without migration', () => {
    const project = createEmptyProject({ clock });
    const raw = JSON.parse(serializeProject(project)) as Record<string, unknown>;
    const migrated = migrateProject(raw);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('throws when no migration path exists for an old version', () => {
    // Version zero was never a released schema and is rejected before lookup.
    expect(() => migrateProject({ schemaVersion: 0 })).toThrow(/positive safe integer/);
  });
});
