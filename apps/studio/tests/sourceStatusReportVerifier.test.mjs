import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSourceStatusReport, renderSourceStatusMarkdown } from '../scripts/createSourceStatusReport.mjs';
import { validateSourceStatusReport } from '../scripts/verifySourceStatusReport.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(appRoot, 'scripts', 'verifySourceStatusReport.mjs');
const tempRoots = [];

const sourceControl = {
  commit: 'a'.repeat(40),
  shortCommit: 'aaaaaaa',
  branch: 'main',
  status: [' M apps/studio/src/main.tsx', '?? apps/studio/scripts/verifySourceStatusReport.mjs'],
  isDirty: true,
};

function fixture() {
  const report = createSourceStatusReport({
    commit: sourceControl.commit,
    shortCommit: sourceControl.shortCommit,
    branch: sourceControl.branch,
    statusLines: sourceControl.status,
    generatedAt: '2026-07-01T00:00:00.000Z',
  });

  return {
    manifest: { sourceControl },
    report,
    markdown: renderSourceStatusMarkdown(report),
  };
}

function writeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cts-source-status-'));
  tempRoots.push(dir);
  const paths = {
    manifest: join(dir, 'release-manifest.json'),
    report: join(dir, 'release-source-status-report.json'),
    markdown: join(dir, 'release-source-status-report.md'),
  };
  writeFileSync(paths.manifest, `${JSON.stringify(files.manifest, null, 2)}\n`, 'utf8');
  writeFileSync(paths.report, `${JSON.stringify(files.report, null, 2)}\n`, 'utf8');
  writeFileSync(paths.markdown, files.markdown, 'utf8');
  return paths;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('release source status verifier', () => {
  it('accepts a report that matches release-manifest sourceControl', () => {
    expect(validateSourceStatusReport(fixture())).toEqual([]);
  });

  it('rejects stale totals from an older source status report', () => {
    const files = fixture();
    files.manifest.sourceControl = {
      ...files.manifest.sourceControl,
      status: [...files.manifest.sourceControl.status, ' M docs/11_release_gate.md'],
    };

    expect(validateSourceStatusReport(files)).toContain('Report total does not match release-manifest.json source status.');
  });

  it('rejects stale path categorization', () => {
    const files = fixture();
    files.report.entries[0] = { ...files.report.entries[0], category: 'Docs' };

    expect(validateSourceStatusReport(files)).toContain('Report entry category is stale for apps/studio/src/main.tsx: Docs');
  });

  it('rejects stale review plan totals', () => {
    const files = fixture();
    files.report.reviewPlan[0] = { ...files.report.reviewPlan[0], total: 999 };

    expect(validateSourceStatusReport(files)).toContain(
      'Report reviewPlan product-runtime.total is 999, expected 1.',
    );
  });

  it('rejects stale review plan completion criteria', () => {
    const files = fixture();
    files.report.reviewPlan[0] = { ...files.report.reviewPlan[0], completionCriteria: ['Check this later.'] };

    expect(validateSourceStatusReport(files)).toContain(
      'Report reviewPlan product-runtime.completionCriteria does not match expected bundle.',
    );
  });

  it('rejects stale review plan category breakdown', () => {
    const files = fixture();
    files.report.reviewPlan[0] = {
      ...files.report.reviewPlan[0],
      categoryBreakdown: [{ ...files.report.reviewPlan[0].categoryBreakdown[0], total: 99 }],
    };

    expect(validateSourceStatusReport(files)).toContain(
      'Report reviewPlan product-runtime.categoryBreakdown[0].total is stale.',
    );
  });

  it('rejects stale review plan path preview', () => {
    const files = fixture();
    files.report.reviewPlan[0] = {
      ...files.report.reviewPlan[0],
      entryPreview: [{ ...files.report.reviewPlan[0].entryPreview[0], raw: ' M apps/studio/src/other.tsx' }],
    };

    expect(validateSourceStatusReport(files)).toContain(
      'Report reviewPlan product-runtime.entryPreview[0].raw is stale.',
    );
  });

  it('rejects stale review plan remaining path preview count', () => {
    const files = fixture();
    files.report.reviewPlan[0] = { ...files.report.reviewPlan[0], remainingEntries: 99 };

    expect(validateSourceStatusReport(files)).toContain(
      'Report reviewPlan product-runtime.remainingEntries is 99, expected 0.',
    );
  });

  it('rejects markdown missing the verifier follow-up', () => {
    const files = fixture();
    files.markdown = files.markdown.replace('- Run `pnpm release:source-status:verify` to confirm this report still matches the release manifest.\n', '');

    expect(validateSourceStatusReport(files)).toContain(
      'release-source-status-report.md is missing pnpm release:source-status:verify.',
    );
  });

  it('rejects markdown missing review bundle details', () => {
    const files = fixture();
    files.markdown = files.markdown.replaceAll('Product and desktop runtime', 'Product runtime omitted');

    expect(validateSourceStatusReport(files)).toContain(
      'release-source-status-report.md is missing review bundle Product and desktop runtime.',
    );
  });

  it('rejects markdown missing review bundle state counts', () => {
    const files = fixture();
    files.markdown = files.markdown.replace(
      '| Product and desktop runtime | 1 | 1 | 0 | 0 |',
      '| Product and desktop runtime | 1 | 0 | 0 | 0 |',
    );

    expect(validateSourceStatusReport(files)).toContain(
      'release-source-status-report.md is missing review bundle counts for Product and desktop runtime.',
    );
  });

  it('rejects markdown missing review bundle completion criteria', () => {
    const files = fixture();
    const criterion = files.report.reviewPlan[0].completionCriteria[0];
    files.markdown = files.markdown.replace(`- ${criterion}\n`, '');

    expect(validateSourceStatusReport(files)).toContain(
      `release-source-status-report.md is missing completion criterion for Product and desktop runtime: ${criterion}`,
    );
  });

  it('rejects markdown missing review bundle category breakdown', () => {
    const files = fixture();
    const summary = files.report.reviewPlan[0].categoryBreakdown[0];
    files.markdown = files.markdown.replace(
      `| ${summary.category} | ${summary.total} | ${summary.modified} | ${summary.untracked} | ${summary.other} | ${summary.recommendedAction} |\n`,
      '',
    );

    expect(validateSourceStatusReport(files)).toContain(
      `release-source-status-report.md is missing category breakdown for Product and desktop runtime: ${summary.category}`,
    );
  });

  it('rejects markdown missing review bundle path preview', () => {
    const files = fixture();
    const entry = files.report.reviewPlan[0].entryPreview[0];
    files.markdown = files.markdown.replace(`- \`${entry.raw}\` (${entry.category})\n`, '');

    expect(validateSourceStatusReport(files)).toContain(
      `release-source-status-report.md is missing path preview for Product and desktop runtime: ${entry.raw}`,
    );
  });

  it('exposes a CLI that verifies candidate files', () => {
    const paths = writeFixture(fixture());
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--manifest', paths.manifest, '--report', paths.report, '--markdown', paths.markdown],
      { cwd: appRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Release source status verification passed');
  });
});
