import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceStatusReport } from './createSourceStatusReport.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const manifestPath = join(releaseOutputDir, 'release-manifest.json');
const checksumsPath = join(releaseOutputDir, 'SHA256SUMS.txt');

const expectedArtifactKinds = new Set(['portable-exe', 'msi-installer', 'nsis-installer']);
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const shortCommitPattern = /^[a-f0-9]{7,40}$/;
const dirtyStatusPreviewLimit = 20;
const dirtyBundlePreviewLimit = 5;

function parseArgs(argv) {
  const options = {
    requireCleanSource: process.env.CTS_RELEASE_REQUIRE_CLEAN_SOURCE === '1',
  };

  for (const arg of argv) {
    if (arg === '--require-clean-source') {
      options.requireCleanSource = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function hashFile(path) {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

function assertSafeArtifactPath(path) {
  if (isAbsolute(path)) {
    fail(`Artifact path must be repo-relative: ${path}`);
  }

  const normalized = normalize(path);
  if (normalized.startsWith('..')) {
    fail(`Artifact path escapes the repository: ${path}`);
  }
}

function parseChecksums(text) {
  const entries = new Map();

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;

    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) {
      fail(`Invalid SHA256SUMS line ${index + 1}: ${line}`);
    }

    const [, sha256, path] = match;
    if (entries.has(path)) {
      fail(`Duplicate SHA256SUMS path: ${path}`);
    }
    entries.set(path, sha256);
  }

  return entries;
}

export function formatDirtySourceMessage(sourceControl) {
  const status = Array.isArray(sourceControl?.status) ? sourceControl.status : [];
  const preview = status.slice(0, dirtyStatusPreviewLimit);
  const remaining = Math.max(0, status.length - preview.length);
  const report = createSourceStatusReport({
    commit: sourceControl?.commit ?? '',
    shortCommit: sourceControl?.shortCommit ?? '',
    branch: sourceControl?.branch ?? '',
    generatedAt: '',
    statusLines: status,
  });
  const lines = [
    'Manifest sourceControl is dirty. Commit, stash, or discard changes before publishing, then rerun `pnpm release:manifest` and `pnpm release:verify:publish`.',
    `Dirty entries: ${status.length}.`,
  ];

  if (report.reviewPlan.length > 0) {
    lines.push('Dirty review bundles:');
    for (const bundle of report.reviewPlan) {
      lines.push(
        `- ${bundle.title}: ${bundle.total} entries (${bundle.modified} modified, ${bundle.untracked} untracked, ${bundle.other} other)`,
      );
    }
    lines.push('Dirty categories by review bundle:');
    for (const bundle of report.reviewPlan) {
      lines.push(`- ${bundle.title}:`);
      for (const summary of bundle.categoryBreakdown) {
        lines.push(
          `  - ${summary.category}: ${summary.total} entries (${summary.modified} modified, ${summary.untracked} untracked, ${summary.other} other)`,
        );
      }
    }
    lines.push('Review completion criteria:');
    for (const bundle of report.reviewPlan) {
      lines.push(`- ${bundle.title}:`);
      for (const criterion of bundle.completionCriteria) lines.push(`  - ${criterion}`);
    }
    lines.push('Dirty paths by review bundle:');
    for (const bundle of report.reviewPlan) {
      const bundleEntries = report.entries.filter((entry) => bundle.categories.includes(entry.category));
      const bundlePreview = bundleEntries.slice(0, dirtyBundlePreviewLimit);
      const bundleRemaining = Math.max(0, bundleEntries.length - bundlePreview.length);
      lines.push(`- ${bundle.title}:`);
      for (const entry of bundlePreview) lines.push(`  - ${entry.raw}`);
      if (bundleRemaining > 0) lines.push(`  - ... and ${bundleRemaining} more`);
    }
  }

  if (preview.length > 0) {
    lines.push('Dirty status preview:');
    for (const entry of preview) lines.push(`- ${entry}`);
    if (remaining > 0) lines.push(`- ... and ${remaining} more`);
  }

  return lines.join('\n');
}

function assertManifestShape(manifest, { requireCleanSource }) {
  if (manifest.platform !== 'windows-x64') {
    fail(`Unexpected manifest platform: ${manifest.platform}`);
  }

  if (!Array.isArray(manifest.artifacts)) {
    fail('Manifest artifacts must be an array.');
  }

  if (manifest.artifacts.length !== expectedArtifactKinds.size) {
    fail(`Expected ${expectedArtifactKinds.size} artifacts, found ${manifest.artifacts.length}.`);
  }

  const kinds = new Set(manifest.artifacts.map((artifact) => artifact.kind));
  for (const kind of expectedArtifactKinds) {
    if (!kinds.has(kind)) fail(`Missing ${kind} artifact in manifest.`);
  }

  assertSourceControl(manifest.sourceControl, { requireCleanSource });
}

export function assertSourceControl(sourceControl, { requireCleanSource }) {
  if (typeof sourceControl !== 'object' || sourceControl === null) {
    fail('Manifest is missing sourceControl.');
  }

  if (typeof sourceControl.commit !== 'string' || !commitPattern.test(sourceControl.commit)) {
    fail('Manifest sourceControl.commit must be a 40-character git SHA.');
  }
  if (
    typeof sourceControl.shortCommit !== 'string' ||
    !shortCommitPattern.test(sourceControl.shortCommit)
  ) {
    fail('Manifest sourceControl.shortCommit must be a git short SHA.');
  }
  if (typeof sourceControl.branch !== 'string' || sourceControl.branch.length === 0) {
    fail('Manifest sourceControl.branch is missing.');
  }
  if (typeof sourceControl.isDirty !== 'boolean') {
    fail('Manifest sourceControl.isDirty must be a boolean.');
  }
  if (!Array.isArray(sourceControl.status)) {
    fail('Manifest sourceControl.status must be an array.');
  }
  for (const line of sourceControl.status) {
    if (typeof line !== 'string' || line.length === 0) {
      fail('Manifest sourceControl.status entries must be non-empty strings.');
    }
  }
  if ((sourceControl.status.length > 0) !== sourceControl.isDirty) {
    fail('Manifest sourceControl.isDirty does not match status entries.');
  }
  if (requireCleanSource && sourceControl.isDirty) {
    fail(formatDirtySourceMessage(sourceControl));
  }
}

async function verifyArtifact(artifact, checksumEntries) {
  if (!expectedArtifactKinds.has(artifact.kind)) {
    fail(`Unexpected artifact kind: ${artifact.kind}`);
  }
  if (typeof artifact.path !== 'string' || artifact.path.length === 0) {
    fail(`Artifact ${artifact.kind} is missing a path.`);
  }
  if (typeof artifact.sizeBytes !== 'number' || artifact.sizeBytes <= 0) {
    fail(`Artifact ${artifact.kind} has invalid sizeBytes.`);
  }
  if (typeof artifact.sha256 !== 'string' || !sha256Pattern.test(artifact.sha256)) {
    fail(`Artifact ${artifact.kind} has invalid sha256.`);
  }

  assertSafeArtifactPath(artifact.path);

  const absolutePath = resolve(repoRoot, artifact.path);
  const actualRelativePath = relativeFromRepo(absolutePath);
  if (actualRelativePath !== artifact.path) {
    fail(`Artifact path is not canonical: expected ${actualRelativePath}, got ${artifact.path}`);
  }

  const fileStat = await stat(absolutePath);
  if (fileStat.size !== artifact.sizeBytes) {
    fail(
      `${artifact.path} size mismatch: manifest ${artifact.sizeBytes}, actual ${fileStat.size}`,
    );
  }

  const actualHash = await hashFile(absolutePath);
  if (actualHash !== artifact.sha256) {
    fail(`${artifact.path} SHA-256 mismatch: manifest ${artifact.sha256}, actual ${actualHash}`);
  }

  const checksumHash = checksumEntries.get(artifact.path);
  if (!checksumHash) {
    fail(`SHA256SUMS is missing ${artifact.path}`);
  }
  if (checksumHash !== artifact.sha256) {
    fail(
      `${artifact.path} SHA256SUMS mismatch: manifest ${artifact.sha256}, sums ${checksumHash}`,
    );
  }

  console.log(`PASS ${artifact.kind}: ${artifact.path}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await readJson(manifestPath);
  const checksumEntries = parseChecksums(await readFile(checksumsPath, 'utf8'));

  assertManifestShape(manifest, options);

  for (const artifact of manifest.artifacts) {
    await verifyArtifact(artifact, checksumEntries);
  }

  if (checksumEntries.size !== manifest.artifacts.length) {
    fail(
      `SHA256SUMS contains ${checksumEntries.size} entries, manifest contains ${manifest.artifacts.length}.`,
    );
  }

  console.log(`Release artifact verification passed: ${manifest.artifacts.length} artifacts.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
