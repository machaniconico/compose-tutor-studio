import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');

const sourceFiles = [
  { sourceName: 'release-manifest.json', destinationName: 'release-manifest.json', required: true },
  { sourceName: 'SHA256SUMS.txt', destinationName: 'SHA256SUMS.txt', required: true },
  { sourceName: 'release-source-status-report.json', destinationName: 'release-source-status-report.json', required: true },
  { sourceName: 'release-source-status-report.md', destinationName: 'release-source-status-report.md', required: true },
  { sourceName: 'release-gates-report.json', destinationName: 'release-gates-report.json', required: false },
  { sourceName: 'release-gates-report.md', destinationName: 'release-gates-report.md', required: false },
  { sourceName: 'release-installer-metadata-report.json', destinationName: 'release-installer-metadata-report.json', required: true },
  { sourceName: 'release-installer-metadata-report.md', destinationName: 'release-installer-metadata-report.md', required: true },
  { sourceName: 'release-installer-smoke-plan.json', destinationName: 'release-installer-smoke-plan.json', required: true },
  { sourceName: 'release-installer-smoke-plan.md', destinationName: 'release-installer-smoke-plan.md', required: true },
  { sourceName: 'release-signing-report.json', destinationName: 'release-signing-report.json', required: true },
  { sourceName: 'release-signing-report.md', destinationName: 'release-signing-report.md', required: true },
  { sourceName: 'THIRD_PARTY_NOTICES.json', destinationName: 'THIRD_PARTY_NOTICES.json', required: true },
  { sourceName: 'THIRD_PARTY_NOTICES.md', destinationName: 'THIRD_PARTY_NOTICES.md', required: true },
  { sourceName: 'release-qa-log-draft.md', destinationName: 'release-qa-log.md', required: true },
  { sourceName: 'release-notes-draft.md', destinationName: 'release-notes.md', required: true },
];

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function copyTextFile(source, destination) {
  await writeFile(destination, await readFile(source, 'utf8'), 'utf8');
}

function sourceStatusPath(line) {
  return line.startsWith('?? ') ? line.slice(3).trim() : line.slice(2).trim();
}

function sourceStatusState(line) {
  const code = line.slice(0, 2);
  if (code === '??') return 'untracked';
  if (code.includes('M')) return 'modified';
  return 'other';
}

function sourceStatusArea(line) {
  const path = sourceStatusPath(line);
  if (path.startsWith('.github/')) return 'CI';
  if (path.startsWith('apps/studio/src-tauri/')) return 'Desktop runtime';
  if (path.startsWith('apps/studio/scripts/')) return 'Release scripts';
  if (
    path.startsWith('apps/studio/e2e/') ||
    path.startsWith('apps/studio/tests/') ||
    path === 'apps/studio/playwright.config.ts'
  ) {
    return 'Studio tests';
  }
  if (path.startsWith('apps/studio/src/')) return 'Studio app';
  if (path.startsWith('apps/studio/')) return 'Studio workspace';
  if (path.startsWith('packages/')) return 'Packages';
  if (path.startsWith('docs/releases/')) return 'Release archive';
  if (path.startsWith('docs/')) return 'Docs';
  return 'Workspace config';
}

function renderSourceStatusSummary(sourceStatus) {
  const header = '| Area | Total | Modified | Untracked | Other |\n|---|---:|---:|---:|---:|';
  if (sourceStatus.length === 0) return `${header}\n| clean | 0 | 0 | 0 | 0 |`;

  const summaries = new Map();
  for (const line of sourceStatus) {
    const area = sourceStatusArea(line);
    const state = sourceStatusState(line);
    const summary = summaries.get(area) ?? { total: 0, modified: 0, untracked: 0, other: 0 };
    summary.total += 1;
    if (state === 'modified') summary.modified += 1;
    else if (state === 'untracked') summary.untracked += 1;
    else summary.other += 1;
    summaries.set(area, summary);
  }

  const rows = [...summaries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([area, summary]) =>
        `| ${area} | ${summary.total} | ${summary.modified} | ${summary.untracked} | ${summary.other} |`,
    );

  return [header, ...rows].join('\n');
}

function renderReadme({ manifest, releaseCandidate, archiveName, archivedFiles }) {
  const generatedAt = new Date().toISOString();
  const rows = archivedFiles
    .map((file) => `| \`${file.destination}\` | \`${file.source}\` |`)
    .join('\n');
  const sourceStatus = manifest.sourceControl?.status ?? [];
  const sourceStatusText =
    sourceStatus.length > 0 ? sourceStatus.join('\n') : 'clean';
  const sourceStatusSummary = renderSourceStatusSummary(sourceStatus);
  const publishSourceWarning = manifest.sourceControl?.isDirty
    ? '- Do not publish this archive while `Source worktree` is dirty. Resolve or commit the `Source Status` entries, rerun `pnpm release:manifest`, and archive fresh evidence.'
    : '- Confirm `Source worktree` is still clean immediately before publishing.';

  return `# ${manifest.productName} ${manifest.version} ${releaseCandidate}

This folder archives release-candidate evidence generated from the desktop release artifacts.

Generated at: ${generatedAt}

Archive name: \`${archiveName}\`

Source manifest generated at: ${manifest.generatedAt}

Source commit: \`${manifest.sourceControl?.commit ?? 'unknown'}\`

Source branch: \`${manifest.sourceControl?.branch ?? 'unknown'}\`

Source worktree: ${manifest.sourceControl?.isDirty ? 'dirty' : 'clean'}

## Source Status Summary

${sourceStatusSummary}

## Source Status

\`\`\`text
${sourceStatusText}
\`\`\`

## Archived Files

| Archived file | Source |
|---|---|
${rows}

## Required Follow-up

- Run \`pnpm release:verify:publish\` after the source tree is clean and before publishing.
${publishSourceWarning}
- Fill in \`release-qa-log.md\` after Windows installer manual QA.
- Run \`pnpm release:qa-log:verify -- --path ${relativeFromRepo(join(repoRoot, 'docs', 'releases', archiveName, 'release-qa-log.md'))}\` before publishing.
- Run \`pnpm release:notes:verify -- --path ${relativeFromRepo(join(repoRoot, 'docs', 'releases', archiveName, 'release-notes.md'))}\` before publishing.
- Remove draft text and known limitation placeholders from \`release-notes.md\` before publishing.
- Keep \`release-signing-report.json\` aligned with the exact files uploaded for distribution.
- Keep \`release-installer-metadata-report.json\` aligned with the exact files uploaded for distribution.
- Use \`release-installer-smoke-plan.md\` when running NSIS/MSI manual QA in a clean Windows environment.
- Keep \`THIRD_PARTY_NOTICES.md\` available next to the downloads or linked from the release page.
- Keep \`release-manifest.json\` and \`SHA256SUMS.txt\` aligned with the exact files uploaded for distribution.
`;
}

async function main() {
  const manifestPath = join(releaseOutputDir, 'release-manifest.json');
  const manifest = await readJson(manifestPath);
  const releaseCandidate = process.env.CTS_RELEASE_CANDIDATE || 'rc.1';
  const archiveName = sanitizeSegment(`${manifest.version}-${releaseCandidate}`);
  const archiveDir = join(repoRoot, 'docs', 'releases', archiveName);
  const overwrite = process.env.CTS_RELEASE_ARCHIVE_OVERWRITE === '1';

  if ((await exists(archiveDir)) && !overwrite) {
    throw new Error(
      `${relativeFromRepo(archiveDir)} already exists. Set CTS_RELEASE_ARCHIVE_OVERWRITE=1 to replace it.`,
    );
  }

  await mkdir(archiveDir, { recursive: true });

  const archivedFiles = [];
  for (const { sourceName, destinationName, required } of sourceFiles) {
    const source = join(releaseOutputDir, sourceName);
    if (!(await exists(source))) {
      if (required) throw new Error(`Missing ${relativeFromRepo(source)}.`);
      continue;
    }

    const destination = join(archiveDir, destinationName);
    await copyTextFile(source, destination);
    archivedFiles.push({
      source: relativeFromRepo(source),
      destination: relativeFromRepo(destination),
    });
  }

  const readmePath = join(archiveDir, 'README.md');
  await writeFile(
    readmePath,
    renderReadme({
      manifest,
      releaseCandidate,
      archiveName,
      archivedFiles,
    }),
    'utf8',
  );

  console.log(`Created release evidence archive at ${relativeFromRepo(archiveDir)}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
