import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSourceStatusReport } from './verifySourceStatusReport.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');

const requiredFiles = [
  'README.md',
  'release-manifest.json',
  'SHA256SUMS.txt',
  'release-source-status-report.json',
  'release-source-status-report.md',
  'release-installer-metadata-report.json',
  'release-installer-metadata-report.md',
  'release-installer-smoke-plan.json',
  'release-installer-smoke-plan.md',
  'release-signing-report.json',
  'release-signing-report.md',
  'THIRD_PARTY_NOTICES.json',
  'THIRD_PARTY_NOTICES.md',
  'release-qa-log.md',
  'release-notes.md',
];

const optionalGateReportFiles = ['release-gates-report.json', 'release-gates-report.md'];
const commitPattern = /^[a-f0-9]{40}$/;
const shortCommitPattern = /^[a-f0-9]{7,40}$/;

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function assertFile(path) {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) throw new Error(`${relativeFromRepo(path)} is not a file.`);
  } catch {
    throw new Error(`Missing ${relativeFromRepo(path)}.`);
  }
}

async function fileExists(path) {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

function parseChecksums(text) {
  const entries = new Map();

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw new Error(`Invalid SHA256SUMS line ${index + 1}: ${line}`);

    const [, sha256, path] = match;
    if (entries.has(path)) throw new Error(`Duplicate SHA256SUMS path: ${path}`);
    entries.set(path, sha256);
  }

  return entries;
}

function assertContains(label, text, value) {
  if (!text.includes(value)) throw new Error(`${label} is missing ${value}`);
}

function assertArchiveArtifactCoverage({ manifest, checksums, qaLog, notes }) {
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('Archive release-manifest.json has no artifacts.');
  }

  for (const artifact of manifest.artifacts) {
    const checksum = checksums.get(artifact.path);
    if (checksum !== artifact.sha256) {
      throw new Error(
        `${artifact.path} checksum mismatch: manifest ${artifact.sha256}, SHA256SUMS ${checksum ?? 'missing'}`,
      );
    }

    assertContains('release-qa-log.md', qaLog, artifact.path);
    assertContains('release-qa-log.md', qaLog, artifact.sha256);
    assertContains('release-notes.md', notes, artifact.fileName);
    assertContains('release-notes.md', notes, artifact.sha256);
  }

  if (checksums.size !== manifest.artifacts.length) {
    throw new Error(
      `SHA256SUMS contains ${checksums.size} entries, manifest contains ${manifest.artifacts.length}.`,
    );
  }
}

function assertSigningReportCoverage({ manifest, signingReport }) {
  const signingArtifacts = new Map(
    signingReport.artifacts.map((artifact) => [`${artifact.kind}:${artifact.path}`, artifact]),
  );

  for (const artifact of manifest.artifacts) {
    const signingArtifact = signingArtifacts.get(`${artifact.kind}:${artifact.path}`);
    if (!signingArtifact) {
      throw new Error(`release-signing-report.json is missing ${artifact.path}.`);
    }
    if (signingArtifact.sha256 !== artifact.sha256) {
      throw new Error(`release-signing-report.json SHA-256 mismatch for ${artifact.path}.`);
    }
    const status = signingArtifact.signature?.status;
    if (status !== 'Valid' && status !== 'NotSigned') {
      throw new Error(`release-signing-report.json has unsafe status for ${artifact.path}: ${status}`);
    }
  }
}

function assertInstallerMetadataCoverage({ manifest, installerMetadataReport }) {
  if (installerMetadataReport.result !== 'Pass') {
    throw new Error('release-installer-metadata-report.json result is not Pass.');
  }
  if (installerMetadataReport.version !== manifest.version) {
    throw new Error('release-installer-metadata-report.json version does not match release-manifest.json.');
  }
  if (!Array.isArray(installerMetadataReport.checks) || installerMetadataReport.checks.length === 0) {
    throw new Error('release-installer-metadata-report.json has no checks.');
  }

  for (const check of installerMetadataReport.checks) {
    if (check.result !== 'Pass') {
      throw new Error(`release-installer-metadata-report.json has a failing check: ${check.label}`);
    }
  }
}

function assertInstallerSmokePlanCoverage({ manifest, installerSmokePlan }) {
  if (installerSmokePlan.result !== 'Pass' || installerSmokePlan.planOnly !== true) {
    throw new Error('release-installer-smoke-plan.json must be a passing plan-only report.');
  }
  if (installerSmokePlan.version !== manifest.version) {
    throw new Error('release-installer-smoke-plan.json version does not match release-manifest.json.');
  }
  if (!Array.isArray(installerSmokePlan.steps) || installerSmokePlan.steps.length === 0) {
    throw new Error('release-installer-smoke-plan.json has no steps.');
  }

  const stepIds = new Set(installerSmokePlan.steps.map((step) => step.id));
  for (const id of ['REL-MAN-001-NSIS-INSTALL', 'REL-MAN-002-MSI-INSTALL', 'REL-MAN-002-MSI-UNINSTALL']) {
    if (!stepIds.has(id)) throw new Error(`release-installer-smoke-plan.json is missing ${id}.`);
  }
}

function assertSourceControl(sourceControl) {
  if (typeof sourceControl !== 'object' || sourceControl === null) {
    throw new Error('release-manifest.json is missing sourceControl.');
  }
  if (typeof sourceControl.commit !== 'string' || !commitPattern.test(sourceControl.commit)) {
    throw new Error('release-manifest.json sourceControl.commit must be a 40-character git SHA.');
  }
  if (
    typeof sourceControl.shortCommit !== 'string' ||
    !shortCommitPattern.test(sourceControl.shortCommit)
  ) {
    throw new Error('release-manifest.json sourceControl.shortCommit must be a git short SHA.');
  }
  if (typeof sourceControl.branch !== 'string' || sourceControl.branch.length === 0) {
    throw new Error('release-manifest.json sourceControl.branch is missing.');
  }
  if (typeof sourceControl.isDirty !== 'boolean') {
    throw new Error('release-manifest.json sourceControl.isDirty must be a boolean.');
  }
  if (!Array.isArray(sourceControl.status)) {
    throw new Error('release-manifest.json sourceControl.status must be an array.');
  }
  for (const line of sourceControl.status) {
    if (typeof line !== 'string' || line.length === 0) {
      throw new Error('release-manifest.json sourceControl.status entries must be non-empty strings.');
    }
  }
  if ((sourceControl.status.length > 0) !== sourceControl.isDirty) {
    throw new Error('release-manifest.json sourceControl.isDirty does not match status entries.');
  }
}

function assertGateReportPass(gateReport) {
  if (gateReport.result !== 'Pass') {
    throw new Error('release-gates-report.json result is not Pass.');
  }
  if (!Array.isArray(gateReport.commands) || gateReport.commands.length === 0) {
    throw new Error('release-gates-report.json has no commands.');
  }

  for (const entry of gateReport.commands) {
    if (entry.result !== 'Pass') {
      throw new Error(`release-gates-report.json has a failing gate: ${entry.command ?? '(unknown)'}.`);
    }
    if (entry.exitCode !== 0) {
      throw new Error(
        `release-gates-report.json has a non-zero exit code for ${entry.command ?? '(unknown)'}.`,
      );
    }
  }
}

export function assertQaLogSourceReviewCoverage({ sourceStatusReport, qaLog }) {
  assertContains('release-qa-log.md', qaLog, '## 2. Source Review Plan');
  assertContains('release-qa-log.md', qaLog, 'release-source-status-report.json');
  assertContains('release-qa-log.md', qaLog, 'release-source-status-report.md');

  if (sourceStatusReport.isDirty === false || sourceStatusReport.total === 0) {
    assertContains('release-qa-log.md', qaLog, 'Clean source');
    assertContains('release-qa-log.md', qaLog, '| Clean source | 0 | clean | Pass |');
    return;
  }

  if (!Array.isArray(sourceStatusReport.reviewPlan) || sourceStatusReport.reviewPlan.length === 0) {
    throw new Error('release-source-status-report.json has dirty source but no reviewPlan.');
  }

  for (const bundle of sourceStatusReport.reviewPlan) {
    assertContains('release-qa-log.md', qaLog, bundle.title);
    assertContains('release-qa-log.md', qaLog, String(bundle.total));
    assertContains('release-qa-log.md', qaLog, bundle.categories.join(', '));
    assertContains('release-qa-log.md', qaLog, bundle.recommendedAction);
  }
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

async function archiveNameFromCurrentManifest() {
  const manifest = await readJson(join(releaseOutputDir, 'release-manifest.json'));
  const releaseCandidate = process.env.CTS_RELEASE_CANDIDATE || 'rc.1';
  return sanitizeSegment(`${manifest.version}-${releaseCandidate}`);
}

async function main() {
  const archiveName = process.env.CTS_RELEASE_ARCHIVE || (await archiveNameFromCurrentManifest());
  const archiveDir = join(repoRoot, 'docs', 'releases', archiveName);

  for (const file of requiredFiles) {
    await assertFile(join(archiveDir, file));
  }

  const hasGateReport = await fileExists(join(archiveDir, 'release-gates-report.json'));
  if (hasGateReport) {
    for (const file of optionalGateReportFiles) {
      await assertFile(join(archiveDir, file));
    }
  }

  const manifest = await readJson(join(archiveDir, 'release-manifest.json'));
  const checksums = parseChecksums(await readFile(join(archiveDir, 'SHA256SUMS.txt'), 'utf8'));
  const installerMetadataReport = await readJson(join(archiveDir, 'release-installer-metadata-report.json'));
  const installerMetadataReportMarkdown = await readFile(join(archiveDir, 'release-installer-metadata-report.md'), 'utf8');
  const installerSmokePlan = await readJson(join(archiveDir, 'release-installer-smoke-plan.json'));
  const installerSmokePlanMarkdown = await readFile(join(archiveDir, 'release-installer-smoke-plan.md'), 'utf8');
  const signingReport = await readJson(join(archiveDir, 'release-signing-report.json'));
  const signingReportMarkdown = await readFile(join(archiveDir, 'release-signing-report.md'), 'utf8');
  const qaLog = await readFile(join(archiveDir, 'release-qa-log.md'), 'utf8');
  const notes = await readFile(join(archiveDir, 'release-notes.md'), 'utf8');
  const thirdPartyNotices = await readFile(join(archiveDir, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const readme = await readFile(join(archiveDir, 'README.md'), 'utf8');

  assertSourceControl(manifest.sourceControl);
  assertContains('README.md', readme, `Archive name: \`${archiveName}\``);
  assertContains('README.md', readme, `Source commit: \`${manifest.sourceControl.commit}\``);
  assertContains('README.md', readme, `Source branch: \`${manifest.sourceControl.branch}\``);
  assertContains(
    'README.md',
    readme,
    `Source worktree: ${manifest.sourceControl.isDirty ? 'dirty' : 'clean'}`,
  );
  assertContains('README.md', readme, '## Source Status Summary');
  assertContains('README.md', readme, renderSourceStatusSummary(manifest.sourceControl.status));
  assertContains('README.md', readme, '## Source Status');
  if (manifest.sourceControl.status.length === 0) {
    assertContains('README.md', readme, 'clean');
    assertContains('README.md', readme, 'Source worktree` is still clean');
  } else {
    assertContains('README.md', readme, 'Do not publish this archive while `Source worktree` is dirty');
    for (const statusLine of manifest.sourceControl.status) {
      assertContains('README.md', readme, statusLine);
    }
  }
  assertContains('README.md', readme, 'pnpm release:verify:publish');
  const sourceStatusReport = await readJson(join(archiveDir, 'release-source-status-report.json'));
  const sourceStatusReportMarkdown = await readFile(join(archiveDir, 'release-source-status-report.md'), 'utf8');
  const sourceStatusErrors = validateSourceStatusReport({
    manifest,
    report: sourceStatusReport,
    markdown: sourceStatusReportMarkdown,
  });
  if (sourceStatusErrors.length > 0) {
    throw new Error(`release-source-status-report verification failed:\n- ${sourceStatusErrors.join('\n- ')}`);
  }
  if (sourceStatusReport.commit !== manifest.sourceControl.commit) {
    throw new Error('release-source-status-report.json commit does not match release-manifest.json.');
  }
  if (sourceStatusReport.branch !== manifest.sourceControl.branch) {
    throw new Error('release-source-status-report.json branch does not match release-manifest.json.');
  }
  if (sourceStatusReport.isDirty !== manifest.sourceControl.isDirty) {
    throw new Error('release-source-status-report.json dirty state does not match release-manifest.json.');
  }
  if (sourceStatusReport.total !== manifest.sourceControl.status.length) {
    throw new Error('release-source-status-report.json total does not match release-manifest.json source status.');
  }
  for (const statusLine of manifest.sourceControl.status) {
    if (!sourceStatusReport.entries?.some((entry) => entry.raw === statusLine)) {
      throw new Error(`release-source-status-report.json is missing source status entry: ${statusLine}`);
    }
  }
  assertContains('release-source-status-report.md', sourceStatusReportMarkdown, 'Release Source Status Report');
  assertContains('release-source-status-report.md', sourceStatusReportMarkdown, 'pnpm release:verify:publish');
  assertQaLogSourceReviewCoverage({ sourceStatusReport, qaLog });
  assertContains('release-qa-log.md', qaLog, manifest.version);
  assertContains('release-notes.md', notes, manifest.version);
  assertContains('release-qa-log.md', qaLog, 'release-signing-report.json');
  assertContains('release-qa-log.md', qaLog, 'release-installer-metadata-report.json');
  assertContains('release-qa-log.md', qaLog, 'release-installer-smoke-plan.json');
  assertContains('release-notes.md', notes, 'release-signing-report.json');
  assertContains('README.md', readme, 'release-signing-report.json');
  assertContains('README.md', readme, 'release-installer-metadata-report.json');
  assertContains('README.md', readme, 'release-installer-smoke-plan.md');
  assertContains('release-installer-metadata-report.md', installerMetadataReportMarkdown, 'Release Installer Metadata Report');
  assertContains('release-installer-smoke-plan.md', installerSmokePlanMarkdown, 'Release Installer Smoke Plan');
  assertContains('release-installer-smoke-plan.md', installerSmokePlanMarkdown, 'REL-MAN-001-NSIS-INSTALL');
  assertContains('release-installer-smoke-plan.md', installerSmokePlanMarkdown, 'REL-MAN-002-MSI-INSTALL');
  assertContains('release-signing-report.md', signingReportMarkdown, 'Release Signing Report');
  assertContains('release-notes.md', notes, 'THIRD_PARTY_NOTICES.md');
  assertContains('THIRD_PARTY_NOTICES.md', thirdPartyNotices, 'Third Party Notices');
  assertContains('README.md', readme, 'THIRD_PARTY_NOTICES.md');
  if (hasGateReport) {
    const gateReport = await readJson(join(archiveDir, 'release-gates-report.json'));
    assertGateReportPass(gateReport);
    assertContains('release-qa-log.md', qaLog, 'pnpm release:gates:report');
    assertContains('release-qa-log.md', qaLog, 'release-gates-report.json');
  }
  if (signingReport.version !== manifest.version) {
    throw new Error('release-signing-report.json version does not match release-manifest.json.');
  }
  if (!Array.isArray(signingReport.artifacts) || signingReport.artifacts.length !== manifest.artifacts.length) {
    throw new Error('release-signing-report.json artifact coverage does not match release-manifest.json.');
  }
  assertSigningReportCoverage({ manifest, signingReport });
  assertInstallerMetadataCoverage({ manifest, installerMetadataReport });
  assertInstallerSmokePlanCoverage({ manifest, installerSmokePlan });
  assertArchiveArtifactCoverage({ manifest, checksums, qaLog, notes });

  console.log(`Release archive verification passed: ${relativeFromRepo(archiveDir)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
