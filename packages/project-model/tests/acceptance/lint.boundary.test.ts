import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as projectModel from '../../src/index';

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const HELPERS = ['startsBeforeClipEnd', 'clipFirstPassEnd', 'CLIP_EDGE_TOLERANCE_BEATS'];
const ALLOWED = new Set(['clipExpand.ts', 'sounding.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'target' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('lint.boundary', () => {
  it('lint.boundary: clipExpand.ts と sounding.ts 以外に境界ヘルパーの import が無い', () => {
    const sources = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'apps/studio/src'))].filter(
      (f) => f.includes('/src/') && !f.includes('/tests/'),
    );
    expect(sources.some((f) => basename(f) === 'sounding.ts')).toBe(true);
    const offenders: string[] = [];
    for (const file of sources) {
      if (ALLOWED.has(basename(file))) continue;
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const name of HELPERS) if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${file.replace(ROOT, '')}: ${name}`);
    }
    expect(offenders).toEqual([]);
  });

  it('lint.boundary: 境界ヘルパーは project-model の index.ts から公開されない', () => {
    for (const name of HELPERS) expect(Object.keys(projectModel)).not.toContain(name);
  });
});
