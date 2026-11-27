/**
 * P02 acceptance tests: wave5 v3 file detection (R3).
 * Spec: docs/14_wave5_port_plan.md section 1 principle 5, and the P02 list under
 * "R3 の受け入れ基準". The implementer must NOT edit this file; a wrong test goes
 * back to the acceptance-criteria author.
 *
 * API CONTRACT (what the implementation must provide)
 *   - `detectProjectFormat(raw: unknown): 'main' | 'wave5-v3' | 'invalid-project'`
 *     exported from `@cts/project-model` (packages/project-model/src/index.ts).
 *   - It is pure and never throws for any input.
 *   - Only `schemaVersion === 3` is inspected. Any other value (or a non-object)
 *     returns 'main'. The decision is made on schemaVersion before anything else.
 *   - For schemaVersion === 3 it counts how many of the five main-v3 required keys
 *     (lengthBeats, tempoMap, timeSignatureMap, audioAssets, automationLanes) are OWN
 *     properties (Object.prototype.hasOwnProperty semantics; inherited keys do not
 *     count). 5 -> 'main', 0 -> 'wave5-v3', 1..4 -> 'invalid-project'.
 *   - `decodeProject` calls it BEFORE `inspectLegacyProjectStructure` / `migrateProject`.
 *       'wave5-v3'        -> { ok: false, error: { code: 'legacy-wave5-format', issues: [...] } }
 *                            (same shape as the existing ProjectDecodeResult failure:
 *                            `issues` is an array of ProjectCodecIssue) and
 *                            migrateProject is never invoked.
 *       'invalid-project' -> { ok: false, error: { code: 'invalid-project', issues: [...] } }
 *       'main'            -> the existing path, result byte-for-byte unchanged.
 *   - `ProjectDecodeErrorCode` gains the member 'legacy-wave5-format'.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as migrations from '../../src/migrations';
import { decodeProject, detectProjectFormat } from '../../src/index';

function fixture(relative: string): Record<string, unknown> {
  const url = new URL(`../fixtures/${relative}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as Record<string, unknown>;
}

const MAP_KEYS = [
  'lengthBeats',
  'tempoMap',
  'timeSignatureMap',
  'audioAssets',
  'automationLanes',
] as const;

const MAP_KEY_VALUES: Record<(typeof MAP_KEYS)[number], unknown> = {
  lengthBeats: 32,
  tempoMap: [],
  timeSignatureMap: [],
  audioAssets: [],
  automationLanes: [],
};

/** Every subset of the five keys with size 1..4 (30 subsets). */
function partialKeySubsets(): (typeof MAP_KEYS)[number][][] {
  const subsets: (typeof MAP_KEYS)[number][][] = [];
  for (let mask = 1; mask < (1 << MAP_KEYS.length) - 1; mask++) {
    subsets.push(MAP_KEYS.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
}

function v3WithKeys(keys: readonly (typeof MAP_KEYS)[number][]): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...fixture('wave5-v3/project-base-only.json') };
  for (const key of keys) raw[key] = MAP_KEY_VALUES[key];
  return raw;
}

describe('P02 detectProjectFormat', () => {
  it('detect_mainV3_withAllFiveMapKeys_isMain', () => {
    expect(detectProjectFormat(fixture('main/project-v3.json'))).toBe('main');
  });

  it('detect_v3_withNoMapKeys_isWave5V3', () => {
    expect(detectProjectFormat(fixture('wave5-v3/project-full.json'))).toBe('wave5-v3');
  });

  describe('detect_v3_withOneToFourMapKeys_isRejectedAsInvalidProject', () => {
    it('covers all 30 combinations of 1 to 4 keys', () => {
      expect(partialKeySubsets()).toHaveLength(30);
    });

    it.each(partialKeySubsets().map((keys) => [keys.join('+'), keys] as const))(
      'rejects v3 with only %s',
      (_label, keys) => {
        expect(detectProjectFormat(v3WithKeys(keys))).toBe('invalid-project');
      },
    );
  });

  describe('detect_inheritedKeysOnPrototype_areNotCounted', () => {
    const inherited = Object.fromEntries(MAP_KEYS.map((key) => [key, MAP_KEY_VALUES[key]]));

    it('treats a v3 object whose five keys are only inherited as wave5-v3', () => {
      const raw = Object.assign(Object.create(inherited) as object, {
        ...fixture('wave5-v3/project-base-only.json'),
      });
      expect(detectProjectFormat(raw)).toBe('wave5-v3');
    });

    it('counts only own keys when some keys are inherited and some are own', () => {
      const raw = Object.assign(Object.create(inherited) as object, {
        ...fixture('wave5-v3/project-base-only.json'),
        lengthBeats: 32,
        tempoMap: [],
      });
      expect(detectProjectFormat(raw)).toBe('invalid-project');
    });

    it('does not treat a complete own-key v3 object as wave5 even when prototype is polluted', () => {
      const raw = Object.assign(Object.create({ extra: 1 }) as object, fixture('main/project-v3.json'));
      expect(detectProjectFormat(raw)).toBe('main');
    });
  });

  describe('detect_nonV3Versions_areAlwaysMain', () => {
    it.each([1, 2, 4, 5, 6, 7, 8, 9, 10])(
      'returns main for schemaVersion %i even with no map keys',
      (version) => {
        expect(detectProjectFormat({ schemaVersion: version })).toBe('main');
      },
    );

    it.each([1, 2, 4, 5, 6, 7, 8, 9, 10])(
      'returns main for schemaVersion %i even with a partial set of map keys',
      (version) => {
        expect(
          detectProjectFormat({ schemaVersion: version, lengthBeats: 32, tempoMap: [] }),
        ).toBe('main');
      },
    );
  });
});

describe('P02 decodeProject with wave5 v3 input', () => {
  it('decode_wave5V3_returnsLegacyWave5FormatCode_andNeverCallsMigrateProject', () => {
    const spy = vi.spyOn(migrations, 'migrateProject');
    try {
      const result = decodeProject(fixture('wave5-v3/project-full.json'));
      expect(result).toMatchObject({ ok: false, error: { code: 'legacy-wave5-format' } });
      if (!result.ok) expect(Array.isArray(result.error.issues)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('decode_controlMainV9_callsMigrateProject_soTheSpyIsProvenToObserve', () => {
    const spy = vi.spyOn(migrations, 'migrateProject');
    try {
      const result = decodeProject(fixture('main/project-v9.json'));
      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('decode_wave5V3_withOnlyBaseFields_isStillDetected', () => {
    const raw = fixture('wave5-v3/project-base-only.json');
    expect(raw).not.toHaveProperty('swing');
    expect(raw.tracks).toSatisfy((tracks: Record<string, unknown>[]) =>
      tracks.every((track) => !('role' in track)),
    );
    expect(decodeProject(raw)).toMatchObject({
      ok: false,
      error: { code: 'legacy-wave5-format' },
    });
  });
});

describe('decode_everyMainFixture_v1ToV10_resultUnchanged', () => {
  // Captured with the decoder BEFORE the P02 change (fixtures/main/decoded-by-pre-change-decoder.json).
  const expected = fixture('main/decoded-by-pre-change-decoder.json');

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('v%i decodes exactly as before', (version) => {
    const actual = JSON.parse(
      JSON.stringify(decodeProject(fixture(`main/project-v${version}.json`))),
    ) as unknown;
    expect(actual).toEqual(expected[`v${version}`]);
  });
});
