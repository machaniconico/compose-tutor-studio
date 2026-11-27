// P20 acceptance tests (schema v11). Written BEFORE the implementation; implementers must not edit.
//
// API contract under test:
// - `Project.swing: number` (percent, 0..60, 0 = straight) and `Project.hiHatChoke: boolean`.
// - CURRENT_SCHEMA_VERSION >= 11 (version-agnostic; the v10 -> v11 step is exercised through MIGRATIONS).
// - migrateProject v10 -> v11 adds `swing: 0, hiHatChoke: false` and changes nothing else.
// - createDefaultProject / createEmptyProject / instantiateTemplate produce `swing: 0, hiHatChoke: true`.
// - validateProject rejects swing < 0, > 60, NaN, Infinity, non-number, and non-boolean hiHatChoke
//   (error path is `swing` / `hiHatChoke`).
// - decodeProject (strict codec): a v10 record that has a `swing` key is an `unknown-key` issue at
//   path `swing`; a v11 record missing `swing` (or `hiHatChoke`) is rejected (`required`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  PROJECT_TEMPLATES,
  createDefaultProject,
  createEmptyProject,
  decodeProject,
  instantiateTemplate,
  migrateProject,
  validateProject,
  type TemplateId,
} from '../../src';

const clock = () => new Date('2026-01-01T00:00:00.000Z');
const FIXTURES = join(import.meta.dirname, '..', 'golden', 'fixtures');
const FIXTURE_FILES = [
  'v1-legacy.json',
  'v2-legacy.json',
  'v10-automation-routing.json',
  'v10-drum-loop-alias.json',
  'v10-tempo-meter-map.json',
];

function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Record<string, unknown>;
}

/** A valid v11 record: the current factory project stamped as a v11 file (later versions add no field here). */
function v11Record(): Record<string, unknown> {
  const record = structuredClone(createEmptyProject({ clock })) as unknown as Record<string, unknown>;
  record.schemaVersion = 11;
  return record;
}

/** The same record shaped as a v10 file (no swing / hiHatChoke). */
function v10Record(): Record<string, unknown> {
  const record = v11Record();
  record.schemaVersion = 10;
  delete record.swing;
  delete record.hiHatChoke;
  return record;
}

describe('P20 v11 schema', () => {
  it('migrate_v10ToV11_addsSwingZeroAndChokeFalse_only', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    const step = MIGRATIONS.find((migration) => migration.from === 10);
    expect(step?.to).toBe(11);
    for (const file of ['v10-automation-routing.json', 'v10-drum-loop-alias.json', 'v10-tempo-meter-map.json']) {
      const v10 = fixture(file);
      expect(v10.schemaVersion).toBe(10);
      const before = structuredClone(v10);
      // The v10 -> v11 step itself, exactly as before.
      const stepped = step!.migrate(v10) as unknown as Record<string, unknown>;
      expect(v10).toEqual(before); // input is not mutated
      expect(stepped).toEqual({ ...before, schemaVersion: 11, swing: 0, hiHatChoke: false });
      // The full chain ends at the current version and keeps swing 0 / hiHatChoke false and every other key.
      const migrated = migrateProject(v10) as unknown as Record<string, unknown>;
      expect(v10).toEqual(before);
      expect(migrated).toMatchObject({
        ...before,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        swing: 0,
        hiHatChoke: false,
      });
    }
  });

  it('createProject_defaultsSwingZero_chokeTrue', () => {
    const projects = [
      createDefaultProject(),
      createEmptyProject({ clock }),
      ...(Object.keys(PROJECT_TEMPLATES) as TemplateId[]).map((id) => instantiateTemplate(id, clock)),
    ];
    for (const project of projects) {
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
      expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(project.swing).toBe(0);
      expect(project.hiHatChoke).toBe(true);
      expect(validateProject(project).ok).toBe(true);
    }
  });

  it('validate_swing_rejectsNegative_NaN_above60', () => {
    // Positive control: the boundary values are accepted, so a rejection below is about swing.
    for (const ok of [0, 30, 60]) {
      expect(validateProject({ ...createEmptyProject({ clock }), swing: ok }).ok).toBe(true);
    }
    for (const bad of [-1, -0.001, 60.001, 61, Number.NaN, Number.POSITIVE_INFINITY, '30' as unknown as number]) {
      const result = validateProject({ ...createEmptyProject({ clock }), swing: bad });
      expect(result.ok, `swing=${String(bad)}`).toBe(false);
      expect(result.errors.some((error) => error.path === 'swing')).toBe(true);
    }
  });

  it('validate_hiHatChoke_rejectsNonBoolean', () => {
    for (const ok of [true, false]) {
      expect(validateProject({ ...createEmptyProject({ clock }), hiHatChoke: ok }).ok).toBe(true);
    }
    for (const bad of [1, 0, 'true', null, undefined]) {
      const result = validateProject({ ...createEmptyProject({ clock }), hiHatChoke: bad as unknown as boolean });
      expect(result.ok, `hiHatChoke=${String(bad)}`).toBe(false);
      expect(result.errors.some((error) => error.path === 'hiHatChoke')).toBe(true);
    }
  });

  it('codec_v10File_withSwingKey_isUnknownKey', () => {
    // Positive control: a clean v10 file decodes (migrated to v11).
    const clean = decodeProject(v10Record());
    expect(clean.ok).toBe(true);
    if (clean.ok) {
      expect(clean.migrated).toBe(true);
      expect(clean.project.swing).toBe(0);
      expect(clean.project.hiHatChoke).toBe(false);
    }
    const smuggled = v10Record();
    smuggled.swing = 30;
    const result = decodeProject(smuggled);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: 'swing', code: 'unknown-key' }),
      );
    }
  });

  it('codec_v11File_missingSwing_isRejected', () => {
    // Positive control: a complete v11 file decodes (migrated only if the current version is later).
    const complete = decodeProject(v11Record());
    expect(complete.ok).toBe(true);
    if (complete.ok) expect(complete.migrated).toBe(CURRENT_SCHEMA_VERSION > 11);
    const missingSwing = v11Record();
    delete missingSwing.swing;
    const rejected = decodeProject(missingSwing);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.issues).toContainEqual(
        expect.objectContaining({ path: 'swing', code: 'required' }),
      );
    }
    const missingChoke = v11Record();
    delete missingChoke.hiHatChoke;
    expect(decodeProject(missingChoke).ok).toBe(false);
  });
});
