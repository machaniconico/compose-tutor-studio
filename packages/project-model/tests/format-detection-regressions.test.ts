import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeProject,
  decodeProjectJson,
  detectProjectFormat,
  migrateProject,
  ProjectMigrationError,
} from '../src/index';

const wave5Json = readFileSync(
  new URL('./fixtures/wave5-v3/project-full.json', import.meta.url),
  'utf8',
);

describe('project format boundaries', () => {
  it('rejects both wave5 fixtures at the public migration entry point', () => {
    const baseOnly = readFileSync(
      new URL('./fixtures/wave5-v3/project-base-only.json', import.meta.url),
      'utf8',
    );
    for (const json of [wave5Json, baseOnly]) {
      expect(() => migrateProject(JSON.parse(json))).toThrow(ProjectMigrationError);
    }
  });

  it('classifies integer and decimal v3 wave5 JSON alike', () => {
    const decimal = wave5Json.replace('"schemaVersion": 3', '"schemaVersion": 3.0');
    expect(decimal).not.toBe(wave5Json);
    for (const json of [wave5Json, decimal]) {
      expect(detectProjectFormat(JSON.parse(json))).toBe('wave5-v3');
      expect(decodeProjectJson(json)).toMatchObject({
        ok: false,
        error: { code: 'legacy-wave5-format' },
      });
    }
  });

  it('continues to decode main v3 JSON with an integral decimal version in TypeScript', () => {
    const mainJson = readFileSync(new URL('./fixtures/main/project-v3.json', import.meta.url), 'utf8');
    const decimal = mainJson.replace('"schemaVersion": 3', '"schemaVersion": 3.0');
    expect(decimal).not.toBe(mainJson);
    expect(detectProjectFormat(JSON.parse(decimal))).toBe('main');
    const integerResult = decodeProjectJson(mainJson);
    expect(integerResult.ok).toBe(true);
    expect(JSON.stringify(decodeProjectJson(decimal))).toBe(JSON.stringify(integerResult));
  });

  it('returns an error when the input is a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(decodeProject(proxy)).toMatchObject({
      ok: false,
      error: { code: 'invalid-project' },
    });
  });

  it('returns an error when a legacy project property throws during validation', () => {
    const hostile = {
      schemaVersion: 2,
      get title(): string {
        throw new Error('unreadable title');
      },
    };
    expect(decodeProject(hostile)).toMatchObject({
      ok: false,
      error: { code: 'invalid-project' },
    });
  });

  it.each([
    { name: 'null', raw: null },
    { name: 'array', raw: [] },
    { name: 'array with a version', raw: Object.assign([], { schemaVersion: 3 }) },
    { name: 'undefined', raw: undefined },
    { name: 'number', raw: 3 },
    { name: 'string', raw: 'v3' },
    { name: 'boolean', raw: true },
  ])('leaves $name to the existing decoder', ({ raw }) => {
    expect(detectProjectFormat(raw)).toBe('main');
    expect(decodeProject(raw)).toMatchObject({ ok: false, error: { code: 'invalid-root' } });
  });
});
