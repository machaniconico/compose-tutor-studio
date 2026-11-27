import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// ids.ts は import 時に randomUUID で nonce を決める。固定値へ差し替えて決定論化する。
vi.hoisted(() => {
  const fixed = '00000000-0000-4000-8000-000000000000';
  const c = globalThis.crypto;
  Object.defineProperty(c, 'randomUUID', { value: () => fixed, configurable: true });
});

import { encodeProjectJson } from '../../src/project-codec';
import { CURRENT_SCHEMA_VERSION } from '../../src/factories';
import { buildCase, EXPECTED_DIR, goldenCases } from './cases';
import { checkGolden } from './golden-io';

const cases = goldenCases();

describe('golden: v11 encodeProjectJson bytes', () => {
  beforeAll(() => {
    expect(CURRENT_SCHEMA_VERSION).toBe(11);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: encoded bytes are pinned', (name, c) => {
    const encoded = encodeProjectJson(buildCase(c));
    if (!encoded.ok) throw new Error(`encode failed: ${JSON.stringify(encoded.error)}`);
    expect(JSON.parse(encoded.json).schemaVersion).toBe(11);
    checkGolden(join(EXPECTED_DIR, `${name}.json`), `${encoded.json}\n`);
    const sha = createHash('sha256').update(encoded.json).digest('hex');
    checkGolden(join(EXPECTED_DIR, `${name}.sha256`), `${sha}\n`);
  });

  it('encoding is deterministic across repeated builds', () => {
    for (const c of cases) {
      const a = encodeProjectJson(buildCase(c));
      const b = encodeProjectJson(buildCase(c));
      expect(a.ok && b.ok && a.json === b.json).toBe(true);
    }
  });

  it('covers every template, the default projects, 3+ v10 fixtures and v1/v2 migrations', () => {
    const names = cases.map((c) => c.name);
    expect(names.filter((n) => n.startsWith('template-')).length).toBeGreaterThanOrEqual(7);
    expect(names).toEqual(expect.arrayContaining(['default-factory', 'default-empty', 'migrated-v1-legacy', 'migrated-v2-legacy']));
    expect(names.filter((n) => n.startsWith('fixture-v10-')).length).toBeGreaterThanOrEqual(3);
  });
});
