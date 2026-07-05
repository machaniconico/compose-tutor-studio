import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const jsonOutputPath = join(releaseOutputDir, 'release-source-status-report.json');
const markdownOutputPath = join(releaseOutputDir, 'release-source-status-report.md');
const reviewBundleEntryPreviewLimit = 5;

const categoryActions = {
  'Product source': 'Review as a product change and commit with the matching feature or fix.',
  'Desktop runtime': 'Review as desktop runtime, Tauri, installer, or dependency configuration.',
  'Release automation': 'Review as release tooling or release policy change before publishing.',
  'Release evidence': 'Regenerate after the final clean build, then archive candidate-specific evidence.',
  'Tests and QA': 'Review as validation coverage for the candidate.',
  'CI': 'Review as CI/release workflow change.',
  'Docs': 'Review as user, QA, or release documentation.',
  'Packages': 'Review as shared package behavior or package metadata.',
  'Workspace config': 'Review as workspace-level configuration or dependency metadata.',
};

const reviewBundleDefinitions = [
  {
    id: 'product-runtime',
    title: 'Product and desktop runtime',
    categories: ['Product source', 'Desktop runtime', 'Packages', 'Workspace config'],
    recommendedAction:
      'Review user-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata as one app change set.',
    completionCriteria: [
      'User-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata have been reviewed together.',
      'Changed behavior is covered by passing tests, E2E coverage, or a documented QA note.',
      'No accidental dependency, installer, or workspace metadata drift remains in the bundle.',
    ],
  },
  {
    id: 'validation',
    title: 'Validation coverage',
    categories: ['Tests and QA'],
    recommendedAction:
      'Review unit, integration, and E2E coverage against the product/runtime changes before trusting the candidate.',
    completionCriteria: [
      'Tests fail for the intended regression or directly exercise the changed behavior.',
      'E2E and smoke coverage are rerun after the final source cleanup.',
      'Validation-only files are either committed with their related behavior or intentionally separated for review.',
    ],
  },
  {
    id: 'release-readiness',
    title: 'Release readiness',
    categories: ['CI', 'Release automation', 'Release evidence', 'Docs'],
    recommendedAction:
      'Review CI, release policy, generated evidence, archive contents, and distribution docs after product changes are settled.',
    completionCriteria: [
      'Generated release evidence is recreated after the final clean build.',
      'CI, release scripts, and distribution docs match the current publish flow.',
      '`pnpm release:verify:publish` passes after the clean manifest is regenerated.',
    ],
  },
];

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    timeout: 5000,
  });
  return stdout.trim();
}

export function parseStatusLine(line) {
  const code = line.slice(0, 2);
  const path = code === '??' ? line.slice(3).trim() : line.slice(2).trim();
  let state = 'other';
  if (code === '??') state = 'untracked';
  else if (code.includes('D')) state = 'deleted';
  else if (code.includes('A')) state = 'added';
  else if (code.includes('M')) state = 'modified';
  else if (code.includes('R')) state = 'renamed';

  return {
    code,
    path,
    state,
    raw: line,
  };
}

export function classifySourcePath(path) {
  if (path.startsWith('docs/releases/')) return 'Release evidence';
  if (path.startsWith('apps/studio/src-tauri/target/release/release/')) return 'Release evidence';
  if (path.startsWith('apps/studio/scripts/')) return 'Release automation';
  if (
    path === 'docs/07_desktop_build.md' ||
    path === 'docs/08_qa_test_plan.md' ||
    path === 'docs/11_release_gate.md' ||
    path === 'docs/12_release_qa_log.md' ||
    path === 'docs/13_distribution_release_notes.md' ||
    path === 'docs/14_signing_and_update_plan.md' ||
    path === 'docs/15_privacy_network_policy.md'
  ) {
    return 'Release automation';
  }
  if (path.startsWith('.github/')) return 'CI';
  if (
    path.startsWith('apps/studio/tests/') ||
    path.startsWith('apps/studio/e2e/') ||
    path === 'apps/studio/playwright.config.ts'
  ) {
    return 'Tests and QA';
  }
  if (
    path.startsWith('apps/studio/src-tauri/') ||
    path === 'apps/studio/package.json' ||
    path === 'apps/studio/vite.config.ts'
  ) {
    return 'Desktop runtime';
  }
  if (path.startsWith('apps/studio/src/')) return 'Product source';
  if (path.startsWith('packages/')) return 'Packages';
  if (path.startsWith('docs/')) return 'Docs';
  return 'Workspace config';
}

export function createReviewPlan(summaries, entries = []) {
  const byCategory = new Map(summaries.map((summary) => [summary.category, summary]));
  return reviewBundleDefinitions.flatMap((definition) => {
    const categories = definition.categories
      .map((category) => byCategory.get(category))
      .filter((summary) => summary && summary.total > 0);

    if (categories.length === 0) return [];
    const categoryNames = categories.map((summary) => summary.category);
    const bundleEntries = entries.filter((entry) => categoryNames.includes(entry.category));
    const entryPreview = bundleEntries.slice(0, reviewBundleEntryPreviewLimit).map((entry) => ({
      raw: entry.raw,
      path: entry.path,
      state: entry.state,
      category: entry.category,
    }));

    return [
      {
        id: definition.id,
        title: definition.title,
        categories: categoryNames,
        total: categories.reduce((sum, summary) => sum + summary.total, 0),
        modified: categories.reduce((sum, summary) => sum + summary.modified, 0),
        untracked: categories.reduce((sum, summary) => sum + summary.untracked, 0),
        other: categories.reduce((sum, summary) => sum + summary.other, 0),
        recommendedAction: definition.recommendedAction,
        completionCriteria: definition.completionCriteria,
        categoryBreakdown: categories.map((summary) => ({
          category: summary.category,
          total: summary.total,
          modified: summary.modified,
          untracked: summary.untracked,
          other: summary.other,
          recommendedAction: summary.recommendedAction,
        })),
        entryPreview,
        remainingEntries: Math.max(0, bundleEntries.length - entryPreview.length),
      },
    ];
  });
}

export function createSourceStatusReport({ commit, shortCommit, branch, statusLines, generatedAt }) {
  const entries = statusLines.map((line) => {
    const parsed = parseStatusLine(line);
    const category = classifySourcePath(parsed.path);
    return {
      ...parsed,
      category,
      recommendedAction: categoryActions[category],
    };
  });

  const summaries = new Map();
  for (const entry of entries) {
    const summary = summaries.get(entry.category) ?? {
      category: entry.category,
      total: 0,
      modified: 0,
      untracked: 0,
      other: 0,
      recommendedAction: entry.recommendedAction,
    };
    summary.total += 1;
    if (entry.state === 'modified') summary.modified += 1;
    else if (entry.state === 'untracked') summary.untracked += 1;
    else summary.other += 1;
    summaries.set(entry.category, summary);
  }
  const sortedSummaries = [...summaries.values()].sort((left, right) => left.category.localeCompare(right.category));

  return {
    generatedAt,
    commit,
    shortCommit,
    branch,
    isDirty: entries.length > 0,
    total: entries.length,
    summaries: sortedSummaries,
    reviewPlan: createReviewPlan(sortedSummaries, entries),
    entries,
  };
}

export function renderSourceStatusMarkdown(report) {
  const reviewRows =
    report.reviewPlan.length === 0
      ? '| clean | 0 | 0 | 0 | 0 | clean | No review bundles required. |'
      : report.reviewPlan
          .map(
            (bundle) =>
              `| ${bundle.title} | ${bundle.total} | ${bundle.modified} | ${bundle.untracked} | ${bundle.other} | ${bundle.categories.join(', ')} | ${bundle.recommendedAction} |`,
          )
          .join('\n');
  const summaryRows =
    report.summaries.length === 0
      ? '| clean | 0 | 0 | 0 | 0 | No source cleanup required. |'
      : report.summaries
          .map(
            (summary) =>
              `| ${summary.category} | ${summary.total} | ${summary.modified} | ${summary.untracked} | ${summary.other} | ${summary.recommendedAction} |`,
          )
          .join('\n');
  const entryRows =
    report.entries.length === 0
      ? '| clean | clean | clean | No source cleanup required. |'
      : report.entries
          .map(
            (entry) =>
              `| \`${entry.code}\` | ${entry.state} | ${entry.category} | \`${entry.path}\` | ${entry.recommendedAction} |`,
          )
          .join('\n');
  const completionCriteria =
    report.reviewPlan.length === 0
      ? 'No bundle completion criteria required.'
      : report.reviewPlan
          .map((bundle) => `### ${bundle.title}\n\n${bundle.completionCriteria.map((criterion) => `- ${criterion}`).join('\n')}`)
          .join('\n\n');
  const bundlePathPreview =
    report.reviewPlan.length === 0
      ? 'No review bundle path preview required.'
      : report.reviewPlan
          .map((bundle) => {
            const rows =
              bundle.entryPreview.length === 0
                ? '- No dirty paths in this bundle.'
                : [
                    ...bundle.entryPreview.map((entry) => `- \`${entry.raw}\` (${entry.category})`),
                    ...(bundle.remainingEntries > 0 ? [`- ... and ${bundle.remainingEntries} more`] : []),
                  ].join('\n');
            return `### ${bundle.title}\n\n${rows}`;
          })
          .join('\n\n');
  const bundleCategoryBreakdown =
    report.reviewPlan.length === 0
      ? 'No review bundle category breakdown required.'
      : report.reviewPlan
          .map((bundle) => {
            const rows = bundle.categoryBreakdown
              .map(
                (summary) =>
                  `| ${summary.category} | ${summary.total} | ${summary.modified} | ${summary.untracked} | ${summary.other} | ${summary.recommendedAction} |`,
              )
              .join('\n');
            return `### ${bundle.title}\n\n| Category | Total | Modified | Untracked | Other | Recommended action |\n|---|---:|---:|---:|---:|---|\n${rows}`;
          })
          .join('\n\n');

  return `# Release Source Status Report

Generated at: ${report.generatedAt}

Commit: \`${report.commit}\`

Branch: \`${report.branch}\`

Source worktree: ${report.isDirty ? 'dirty' : 'clean'}

Dirty entries: ${report.total}

JSON report: \`${relativeFromRepo(jsonOutputPath)}\`

## Review Plan

| Bundle | Entries | Modified | Untracked | Other | Categories | Recommended action |
|---|---:|---:|---:|---:|---|---|
${reviewRows}

## Review Bundle Completion Criteria

${completionCriteria}

## Review Bundle Path Preview

${bundlePathPreview}

## Review Bundle Category Breakdown

${bundleCategoryBreakdown}

## Summary

| Category | Total | Modified | Untracked | Other | Recommended action |
|---|---:|---:|---:|---:|---|
${summaryRows}

## Entries

| Git code | State | Category | Path | Recommended action |
|---|---|---|---|---|
${entryRows}

## Publish Follow-up

- Before publishing, resolve every dirty entry and rerun \`pnpm release:manifest\`.
- Run \`pnpm release:source-status\` again and confirm this report is clean.
- Run \`pnpm release:source-status:verify\` to confirm this report still matches the release manifest.
- Run \`pnpm release:verify:publish\` after the clean manifest is generated.
`;
}

async function buildCurrentReport() {
  const [commit, shortCommit, branch, statusText] = await Promise.all([
    gitOutput(['rev-parse', 'HEAD']),
    gitOutput(['rev-parse', '--short', 'HEAD']),
    gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOutput(['status', '--short']),
  ]);
  const statusLines = statusText === '' ? [] : statusText.split(/\r?\n/);
  return createSourceStatusReport({
    commit,
    shortCommit,
    branch,
    statusLines,
    generatedAt: new Date().toISOString(),
  });
}

async function main() {
  const report = await buildCurrentReport();
  await mkdir(releaseOutputDir, { recursive: true });
  await writeFile(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownOutputPath, renderSourceStatusMarkdown(report), 'utf8');

  console.log(`Created ${relativeFromRepo(jsonOutputPath)}`);
  console.log(`Created ${relativeFromRepo(markdownOutputPath)}`);
  console.log(`Source worktree: ${report.isDirty ? 'dirty' : 'clean'} (${report.total} entries)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
