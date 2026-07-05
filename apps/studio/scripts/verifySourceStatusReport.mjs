import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySourcePath, createReviewPlan, parseStatusLine } from './createSourceStatusReport.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const defaultManifestPath = join(releaseOutputDir, 'release-manifest.json');
const defaultReportPath = join(releaseOutputDir, 'release-source-status-report.json');
const defaultMarkdownPath = join(releaseOutputDir, 'release-source-status-report.md');
const commitPattern = /^[a-f0-9]{40}$/;
const shortCommitPattern = /^[a-f0-9]{7,40}$/;

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function summaryFromEntries(entries) {
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
  return [...summaries.values()].sort((left, right) => left.category.localeCompare(right.category));
}

function pushIf(errors, condition, message) {
  if (!condition) errors.push(message);
}

function markdownSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start === -1) return '';
  const next = markdown.indexOf('\n## ', start + marker.length);
  return markdown.slice(start, next === -1 ? undefined : next);
}

function markdownSubsection(markdown, heading) {
  const marker = `### ${heading}`;
  const start = markdown.indexOf(marker);
  if (start === -1) return '';
  const next = markdown.indexOf('\n### ', start + marker.length);
  return markdown.slice(start, next === -1 ? undefined : next);
}

function validateSourceControl(sourceControl, errors) {
  pushIf(errors, isObject(sourceControl), 'release-manifest.json is missing sourceControl.');
  if (!isObject(sourceControl)) return [];

  pushIf(
    errors,
    typeof sourceControl.commit === 'string' && commitPattern.test(sourceControl.commit),
    'release-manifest.json sourceControl.commit must be a 40-character git SHA.',
  );
  pushIf(
    errors,
    typeof sourceControl.shortCommit === 'string' && shortCommitPattern.test(sourceControl.shortCommit),
    'release-manifest.json sourceControl.shortCommit must be a git short SHA.',
  );
  pushIf(
    errors,
    typeof sourceControl.branch === 'string' && sourceControl.branch.length > 0,
    'release-manifest.json sourceControl.branch is missing.',
  );
  pushIf(
    errors,
    typeof sourceControl.isDirty === 'boolean',
    'release-manifest.json sourceControl.isDirty must be a boolean.',
  );
  pushIf(errors, Array.isArray(sourceControl.status), 'release-manifest.json sourceControl.status must be an array.');

  const status = Array.isArray(sourceControl.status) ? sourceControl.status : [];
  for (const line of status) {
    pushIf(errors, typeof line === 'string' && line.length > 0, 'sourceControl.status entries must be non-empty strings.');
  }
  if (typeof sourceControl.isDirty === 'boolean') {
    pushIf(
      errors,
      (status.length > 0) === sourceControl.isDirty,
      'release-manifest.json sourceControl.isDirty does not match status entries.',
    );
  }
  return status;
}

function validateReportShape(report, errors) {
  pushIf(errors, isObject(report), 'release-source-status-report.json must be an object.');
  if (!isObject(report)) return [];

  pushIf(errors, typeof report.generatedAt === 'string' && !Number.isNaN(Date.parse(report.generatedAt)), 'Report generatedAt must be an ISO date string.');
  pushIf(errors, typeof report.commit === 'string', 'Report commit is missing.');
  pushIf(errors, typeof report.shortCommit === 'string', 'Report shortCommit is missing.');
  pushIf(errors, typeof report.branch === 'string' && report.branch.length > 0, 'Report branch is missing.');
  pushIf(errors, typeof report.isDirty === 'boolean', 'Report isDirty must be a boolean.');
  pushIf(errors, Number.isInteger(report.total) && report.total >= 0, 'Report total must be a non-negative integer.');
  pushIf(errors, Array.isArray(report.summaries), 'Report summaries must be an array.');
  pushIf(errors, Array.isArray(report.reviewPlan), 'Report reviewPlan must be an array.');
  pushIf(errors, Array.isArray(report.entries), 'Report entries must be an array.');

  return Array.isArray(report.entries) ? report.entries : [];
}

function validateEntries({ entries, statusLines, errors }) {
  const sourceCounts = countValues(statusLines);
  const reportCounts = countValues(entries.map((entry) => entry?.raw));

  for (const line of statusLines) {
    const expectedCount = sourceCounts.get(line);
    const actualCount = reportCounts.get(line) ?? 0;
    pushIf(errors, actualCount === expectedCount, `Report entries do not match source status line: ${line}`);
  }

  for (const entry of entries) {
    if (!isObject(entry)) {
      errors.push('Report entries must be objects.');
      continue;
    }
    for (const field of ['code', 'path', 'state', 'raw', 'category', 'recommendedAction']) {
      pushIf(errors, typeof entry[field] === 'string' && entry[field].length > 0, `Report entry is missing ${field}.`);
    }
    if (typeof entry.raw !== 'string') continue;

    const parsed = parseStatusLine(entry.raw);
    pushIf(errors, entry.code === parsed.code, `Report entry code does not match raw status: ${entry.raw}`);
    pushIf(errors, entry.path === parsed.path, `Report entry path does not match raw status: ${entry.raw}`);
    pushIf(errors, entry.state === parsed.state, `Report entry state does not match raw status: ${entry.raw}`);
    pushIf(
      errors,
      entry.category === classifySourcePath(parsed.path),
      `Report entry category is stale for ${parsed.path}: ${entry.category}`,
    );
  }

  for (const raw of reportCounts.keys()) {
    if (typeof raw === 'string') {
      pushIf(errors, sourceCounts.has(raw), `Report contains an entry not present in release-manifest.json: ${raw}`);
    }
  }
}

function validateSummaries(report, entries, errors) {
  if (!Array.isArray(report.summaries)) return;
  const expected = summaryFromEntries(entries);
  const actualByCategory = new Map(report.summaries.map((summary) => [summary?.category, summary]));

  pushIf(errors, report.summaries.length === expected.length, 'Report summaries do not match entry categories.');

  for (const expectedSummary of expected) {
    const actual = actualByCategory.get(expectedSummary.category);
    pushIf(errors, Boolean(actual), `Report summary is missing ${expectedSummary.category}.`);
    if (!isObject(actual)) continue;
    for (const field of ['total', 'modified', 'untracked', 'other']) {
      pushIf(
        errors,
        actual[field] === expectedSummary[field],
        `Report summary ${expectedSummary.category}.${field} is ${actual[field]}, expected ${expectedSummary[field]}.`,
      );
    }
    pushIf(
      errors,
      actual.recommendedAction === expectedSummary.recommendedAction,
      `Report summary ${expectedSummary.category} recommendedAction does not match entries.`,
    );
  }
}

function validateReviewPlan(report, entries, errors) {
  if (!Array.isArray(report.reviewPlan)) return;
  const expected = createReviewPlan(summaryFromEntries(entries), entries);
  const actualById = new Map(report.reviewPlan.map((bundle) => [bundle?.id, bundle]));

  pushIf(errors, report.reviewPlan.length === expected.length, 'Report reviewPlan does not match dirty entry bundles.');

  for (const expectedBundle of expected) {
    const actual = actualById.get(expectedBundle.id);
    pushIf(errors, Boolean(actual), `Report reviewPlan is missing ${expectedBundle.id}.`);
    if (!isObject(actual)) continue;

    for (const field of ['title', 'recommendedAction']) {
      pushIf(
        errors,
        actual[field] === expectedBundle[field],
        `Report reviewPlan ${expectedBundle.id}.${field} does not match expected bundle.`,
      );
    }
    for (const field of ['total', 'modified', 'untracked', 'other']) {
      pushIf(
        errors,
        actual[field] === expectedBundle[field],
        `Report reviewPlan ${expectedBundle.id}.${field} is ${actual[field]}, expected ${expectedBundle[field]}.`,
      );
    }
    pushIf(
      errors,
      Array.isArray(actual.categories) &&
        actual.categories.length === expectedBundle.categories.length &&
        actual.categories.every((category, index) => category === expectedBundle.categories[index]),
      `Report reviewPlan ${expectedBundle.id}.categories does not match expected bundle.`,
    );
    pushIf(
      errors,
      Array.isArray(actual.completionCriteria) &&
        actual.completionCriteria.length === expectedBundle.completionCriteria.length &&
        actual.completionCriteria.every((criterion, index) => criterion === expectedBundle.completionCriteria[index]),
      `Report reviewPlan ${expectedBundle.id}.completionCriteria does not match expected bundle.`,
    );
    pushIf(
      errors,
      Array.isArray(actual.categoryBreakdown) &&
        actual.categoryBreakdown.length === expectedBundle.categoryBreakdown.length,
      `Report reviewPlan ${expectedBundle.id}.categoryBreakdown length does not match expected bundle.`,
    );
    if (Array.isArray(actual.categoryBreakdown)) {
      for (const [index, expectedSummary] of expectedBundle.categoryBreakdown.entries()) {
        const actualSummary = actual.categoryBreakdown[index];
        if (!isObject(actualSummary)) {
          errors.push(`Report reviewPlan ${expectedBundle.id}.categoryBreakdown[${index}] must be an object.`);
          continue;
        }
        for (const field of ['category', 'total', 'modified', 'untracked', 'other', 'recommendedAction']) {
          pushIf(
            errors,
            actualSummary[field] === expectedSummary[field],
            `Report reviewPlan ${expectedBundle.id}.categoryBreakdown[${index}].${field} is stale.`,
          );
        }
      }
    }
    pushIf(
      errors,
      Number.isInteger(actual.remainingEntries) && actual.remainingEntries === expectedBundle.remainingEntries,
      `Report reviewPlan ${expectedBundle.id}.remainingEntries is ${actual.remainingEntries}, expected ${expectedBundle.remainingEntries}.`,
    );
    pushIf(
      errors,
      Array.isArray(actual.entryPreview) && actual.entryPreview.length === expectedBundle.entryPreview.length,
      `Report reviewPlan ${expectedBundle.id}.entryPreview length does not match expected bundle.`,
    );
    if (Array.isArray(actual.entryPreview)) {
      for (const [index, expectedEntry] of expectedBundle.entryPreview.entries()) {
        const actualEntry = actual.entryPreview[index];
        if (!isObject(actualEntry)) {
          errors.push(`Report reviewPlan ${expectedBundle.id}.entryPreview[${index}] must be an object.`);
          continue;
        }
        for (const field of ['raw', 'path', 'state', 'category']) {
          pushIf(
            errors,
            actualEntry[field] === expectedEntry[field],
            `Report reviewPlan ${expectedBundle.id}.entryPreview[${index}].${field} is stale.`,
          );
        }
      }
    }
  }
}

function validateMarkdown({ manifest, report, markdown, errors }) {
  pushIf(errors, typeof markdown === 'string' && markdown.length > 0, 'release-source-status-report.md is empty.');
  if (typeof markdown !== 'string') return;

  const statusLines = manifest.sourceControl?.status ?? [];
  const state = report.isDirty ? 'dirty' : 'clean';
  const categoryBreakdownMarkdown = markdownSection(markdown, 'Review Bundle Category Breakdown');
  for (const phrase of [
    'Release Source Status Report',
    'release-source-status-report.json',
    'Review Plan',
    'Review Bundle Completion Criteria',
    'Review Bundle Path Preview',
    'Review Bundle Category Breakdown',
    'pnpm release:source-status',
    'pnpm release:source-status:verify',
    'pnpm release:verify:publish',
    `Commit: \`${report.commit}\``,
    `Branch: \`${report.branch}\``,
    `Source worktree: ${state}`,
    `Dirty entries: ${report.total}`,
  ]) {
    pushIf(errors, markdown.includes(phrase), `release-source-status-report.md is missing ${phrase}.`);
  }

  if (statusLines.length === 0) {
    pushIf(errors, markdown.includes('No source cleanup required.'), 'Clean report markdown must say no source cleanup is required.');
    pushIf(errors, markdown.includes('No review bundles required.'), 'Clean report markdown must say no review bundles are required.');
    pushIf(
      errors,
      markdown.includes('No bundle completion criteria required.'),
      'Clean report markdown must say no bundle completion criteria are required.',
    );
    pushIf(
      errors,
      markdown.includes('No review bundle path preview required.'),
      'Clean report markdown must say no review bundle path preview is required.',
    );
    pushIf(
      errors,
      markdown.includes('No review bundle category breakdown required.'),
      'Clean report markdown must say no review bundle category breakdown is required.',
    );
  } else {
    for (const bundle of report.reviewPlan ?? []) {
      if (isObject(bundle) && typeof bundle.title === 'string') {
        pushIf(errors, markdown.includes(bundle.title), `release-source-status-report.md is missing review bundle ${bundle.title}.`);
        const rowPrefix = `| ${bundle.title} | ${bundle.total} | ${bundle.modified} | ${bundle.untracked} | ${bundle.other} |`;
        pushIf(errors, markdown.includes(rowPrefix), `release-source-status-report.md is missing review bundle counts for ${bundle.title}.`);
        for (const criterion of bundle.completionCriteria ?? []) {
          if (typeof criterion === 'string') {
            pushIf(
              errors,
              markdown.includes(criterion),
              `release-source-status-report.md is missing completion criterion for ${bundle.title}: ${criterion}`,
            );
          }
        }
        for (const summary of bundle.categoryBreakdown ?? []) {
          if (isObject(summary) && typeof summary.category === 'string') {
            const rowPrefix = `| ${summary.category} | ${summary.total} | ${summary.modified} | ${summary.untracked} | ${summary.other} |`;
            const bundleCategoryMarkdown = markdownSubsection(categoryBreakdownMarkdown, bundle.title);
            pushIf(
              errors,
              bundleCategoryMarkdown.includes(rowPrefix),
              `release-source-status-report.md is missing category breakdown for ${bundle.title}: ${summary.category}`,
            );
          }
        }
        for (const entry of bundle.entryPreview ?? []) {
          if (isObject(entry) && typeof entry.raw === 'string' && typeof entry.category === 'string') {
            const previewLine = `- \`${entry.raw}\` (${entry.category})`;
            pushIf(
              errors,
              markdown.includes(previewLine),
              `release-source-status-report.md is missing path preview for ${bundle.title}: ${entry.raw}`,
            );
          }
        }
        if (Number.isInteger(bundle.remainingEntries) && bundle.remainingEntries > 0) {
          const remainingLine = `- ... and ${bundle.remainingEntries} more`;
          pushIf(
            errors,
            markdown.includes(remainingLine),
            `release-source-status-report.md is missing remaining path preview count for ${bundle.title}.`,
          );
        }
      }
    }
    for (const entry of report.entries ?? []) {
      if (isObject(entry) && typeof entry.path === 'string') {
        pushIf(errors, markdown.includes(entry.path), `release-source-status-report.md is missing ${entry.path}.`);
      }
    }
  }
}

export function validateSourceStatusReport({ manifest, report, markdown }) {
  const errors = [];
  const statusLines = validateSourceControl(manifest?.sourceControl, errors);
  const entries = validateReportShape(report, errors);
  if (!isObject(report) || !isObject(manifest?.sourceControl)) return errors;

  pushIf(errors, report.commit === manifest.sourceControl.commit, 'Report commit does not match release-manifest.json.');
  pushIf(
    errors,
    report.shortCommit === manifest.sourceControl.shortCommit,
    'Report shortCommit does not match release-manifest.json.',
  );
  pushIf(errors, report.branch === manifest.sourceControl.branch, 'Report branch does not match release-manifest.json.');
  pushIf(
    errors,
    report.isDirty === manifest.sourceControl.isDirty,
    'Report dirty state does not match release-manifest.json.',
  );
  pushIf(errors, report.total === statusLines.length, 'Report total does not match release-manifest.json source status.');
  pushIf(errors, entries.length === statusLines.length, 'Report entries length does not match release-manifest.json source status.');

  validateEntries({ entries, statusLines, errors });
  validateSummaries(report, entries, errors);
  validateReviewPlan(report, entries, errors);
  validateMarkdown({ manifest, report, markdown, errors });
  return errors;
}

function parseArgs(args) {
  const options = {
    manifestPath: defaultManifestPath,
    reportPath: defaultReportPath,
    markdownPath: defaultMarkdownPath,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--manifest') options.manifestPath = resolve(args[++index] ?? '');
    else if (arg === '--report') options.reportPath = resolve(args[++index] ?? '');
    else if (arg === '--markdown') options.markdownPath = resolve(args[++index] ?? '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [manifest, report, markdown] = await Promise.all([
    readJson(options.manifestPath),
    readJson(options.reportPath),
    readFile(options.markdownPath, 'utf8'),
  ]);
  const errors = validateSourceStatusReport({ manifest, report, markdown });
  if (errors.length > 0) {
    throw new Error(`Release source status verification failed:\n- ${errors.join('\n- ')}`);
  }

  console.log(`Release source status verification passed: ${relativeFromRepo(options.reportPath)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
