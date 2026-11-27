// ゴールデン対象プロジェクトの組み立て(project-model / studio の両テストが共有する)。
// ID は決定論的にする: 乱数 nonce を固定し、カウンタを各ケースの直前にリセットする。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _resetIdCounter } from '../../src/ids';
import { createEmptyProject } from '../../src/factories';
import { createDefaultProject } from '../../src/factory';
import { decodeProjectJson } from '../../src/project-codec';
import { PROJECT_TEMPLATES, instantiateTemplate, type TemplateId } from '../../src/templates';
import type { Project } from '../../src/types';

export const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(GOLDEN_DIR, 'fixtures');
export const EXPECTED_DIR = join(GOLDEN_DIR, 'expected');

const FIXED_CLOCK = () => new Date('2026-01-01T00:00:00.000Z');

export type GoldenCase = Readonly<{ name: string; build: () => Project }>;

function decodeFixture(file: string): Project {
  const result = decodeProjectJson(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
  if (!result.ok) {
    throw new Error(`fixture ${file} failed to decode: ${JSON.stringify(result.error)}`);
  }
  return result.project;
}

/** 既定・全テンプレート・手作り v10 見本・v1/v2 移行結果。名前はソート済みで安定。 */
export function goldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = [
    { name: 'default-factory', build: () => createDefaultProject() },
    { name: 'default-empty', build: () => createEmptyProject({ clock: FIXED_CLOCK }) },
  ];
  for (const id of Object.keys(PROJECT_TEMPLATES).sort() as TemplateId[]) {
    cases.push({ name: `template-${id}`, build: () => instantiateTemplate(id, FIXED_CLOCK) });
  }
  for (const file of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const name = file.replace(/\.json$/, '');
    // v1/v2 は migrate → decode → encode の経路。v10 見本は decode → encode。
    cases.push({
      name: /^v\d+-legacy$/.test(name) ? `migrated-${name}` : `fixture-${name}`,
      build: () => decodeFixture(file),
    });
  }
  return cases;
}

/** ケースを組み立てる直前に ID カウンタを戻す。 */
export function buildCase(c: GoldenCase): Project {
  _resetIdCounter();
  return c.build();
}
