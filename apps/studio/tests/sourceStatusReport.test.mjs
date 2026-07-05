import { describe, expect, it } from 'vitest';
import {
  classifySourcePath,
  createSourceStatusReport,
  parseStatusLine,
  renderSourceStatusMarkdown,
} from '../scripts/createSourceStatusReport.mjs';

describe('release source status report', () => {
  it('parses git status short lines into path and state', () => {
    expect(parseStatusLine(' M apps/studio/src/main.tsx')).toMatchObject({
      code: ' M',
      path: 'apps/studio/src/main.tsx',
      state: 'modified',
    });
    expect(parseStatusLine('?? docs/releases/0.1.0-rc.1/')).toMatchObject({
      code: '??',
      path: 'docs/releases/0.1.0-rc.1/',
      state: 'untracked',
    });
  });

  it('classifies release, product, test, and workspace paths', () => {
    expect(classifySourcePath('apps/studio/src/main.tsx')).toBe('Product source');
    expect(classifySourcePath('apps/studio/scripts/createReleaseManifest.mjs')).toBe('Release automation');
    expect(classifySourcePath('docs/releases/0.1.0-rc.1/')).toBe('Release evidence');
    expect(classifySourcePath('apps/studio/tests/sourceStatusReport.test.mjs')).toBe('Tests and QA');
    expect(classifySourcePath('pnpm-lock.yaml')).toBe('Workspace config');
  });

  it('summarizes dirty entries by category with recommended actions', () => {
    const report = createSourceStatusReport({
      commit: 'a'.repeat(40),
      shortCommit: 'aaaaaaa',
      branch: 'main',
      generatedAt: '2026-07-01T00:00:00.000Z',
      statusLines: [
        ' M apps/studio/src/main.tsx',
        '?? apps/studio/scripts/createSourceStatusReport.mjs',
        '?? docs/releases/0.1.0-rc.1/',
        ' M packages/theory-engine/package.json',
      ],
    });

    expect(report.isDirty).toBe(true);
    expect(report.total).toBe(4);
    expect(report.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'Product source', total: 1, modified: 1 }),
        expect.objectContaining({ category: 'Release automation', total: 1, untracked: 1 }),
        expect.objectContaining({ category: 'Release evidence', total: 1, untracked: 1 }),
        expect.objectContaining({ category: 'Packages', total: 1, modified: 1 }),
      ]),
    );
    expect(report.reviewPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'product-runtime',
          title: 'Product and desktop runtime',
          categories: ['Product source', 'Packages'],
          total: 2,
          modified: 2,
          untracked: 0,
          other: 0,
          completionCriteria: expect.arrayContaining([
            'Changed behavior is covered by passing tests, E2E coverage, or a documented QA note.',
          ]),
          categoryBreakdown: [
            expect.objectContaining({ category: 'Product source', total: 1, modified: 1 }),
            expect.objectContaining({ category: 'Packages', total: 1, modified: 1 }),
          ],
          entryPreview: expect.arrayContaining([
            expect.objectContaining({
              raw: ' M apps/studio/src/main.tsx',
              path: 'apps/studio/src/main.tsx',
              category: 'Product source',
            }),
          ]),
          remainingEntries: 0,
        }),
        expect.objectContaining({
          id: 'release-readiness',
          title: 'Release readiness',
          categories: ['Release automation', 'Release evidence'],
          total: 2,
          modified: 0,
          untracked: 2,
          other: 0,
          completionCriteria: expect.arrayContaining([
            '`pnpm release:verify:publish` passes after the clean manifest is regenerated.',
          ]),
          categoryBreakdown: [
            expect.objectContaining({ category: 'Release automation', total: 1, untracked: 1 }),
            expect.objectContaining({ category: 'Release evidence', total: 1, untracked: 1 }),
          ],
          entryPreview: expect.arrayContaining([
            expect.objectContaining({
              raw: '?? apps/studio/scripts/createSourceStatusReport.mjs',
              path: 'apps/studio/scripts/createSourceStatusReport.mjs',
              category: 'Release automation',
            }),
          ]),
          remainingEntries: 0,
        }),
      ]),
    );
  });

  it('renders publish follow-up for dirty and clean reports', () => {
    const dirtyReport = createSourceStatusReport({
      commit: 'a'.repeat(40),
      shortCommit: 'aaaaaaa',
      branch: 'main',
      generatedAt: '2026-07-01T00:00:00.000Z',
      statusLines: [' M apps/studio/src/main.tsx'],
    });
    const cleanReport = createSourceStatusReport({
      commit: 'a'.repeat(40),
      shortCommit: 'aaaaaaa',
      branch: 'main',
      generatedAt: '2026-07-01T00:00:00.000Z',
      statusLines: [],
    });

    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('Source worktree: dirty');
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('## Review Plan');
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('## Review Bundle Completion Criteria');
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('## Review Bundle Path Preview');
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('## Review Bundle Category Breakdown');
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain(
      '| Bundle | Entries | Modified | Untracked | Other | Categories | Recommended action |',
    );
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain(
      '| Product and desktop runtime | 1 | 1 | 0 | 0 | Product source |',
    );
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('Product and desktop runtime');
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain(
      'Changed behavior is covered by passing tests, E2E coverage, or a documented QA note.',
    );
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('- ` M apps/studio/src/main.tsx` (Product source)');
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('| Product source | 1 | 1 | 0 | 0 |');
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('pnpm release:verify:publish');
    expect(renderSourceStatusMarkdown(dirtyReport)).toContain('Product source');
    expect(renderSourceStatusMarkdown(cleanReport)).toContain('Source worktree: clean');
    expect(renderSourceStatusMarkdown(cleanReport)).toContain(
      '| clean | 0 | 0 | 0 | 0 | clean | No review bundles required. |',
    );
    expect(renderSourceStatusMarkdown(cleanReport)).toContain('No review bundles required.');
    expect(renderSourceStatusMarkdown(cleanReport)).toContain('No bundle completion criteria required.');
    expect(renderSourceStatusMarkdown(cleanReport)).toContain('No review bundle path preview required.');
    expect(renderSourceStatusMarkdown(cleanReport)).toContain('No review bundle category breakdown required.');
    expect(renderSourceStatusMarkdown(cleanReport)).toContain('No source cleanup required.');
  });
});
