import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const manifestPath = join(releaseOutputDir, 'release-manifest.json');
const jsonReportPath = join(releaseOutputDir, 'release-signing-report.json');
const markdownReportPath = join(releaseOutputDir, 'release-signing-report.md');

const allowedStatuses = new Set(['Valid', 'NotSigned']);
const sha256Pattern = /^[a-f0-9]{64}$/;

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function assertFile(path) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) fail(`${relativeFromRepo(path)} is not a file.`);
}

function requireSigned() {
  return process.env.CTS_RELEASE_REQUIRE_SIGNED === '1';
}

function allowMixed() {
  return process.env.CTS_RELEASE_ALLOW_MIXED_SIGNATURES === '1';
}

function expectedSigningState(statuses) {
  const uniqueStatuses = new Set(statuses);
  if (uniqueStatuses.size === 1 && uniqueStatuses.has('Valid')) return 'signed';
  if (uniqueStatuses.size === 1 && uniqueStatuses.has('NotSigned')) return 'unsigned-limited';
  if ([...uniqueStatuses].some((status) => !allowedStatuses.has(status))) return 'invalid-signature';
  return 'mixed';
}

function artifactKey(artifact) {
  return `${artifact.kind}:${artifact.path}`;
}

function assertContains(label, text, value) {
  if (!text.includes(value)) fail(`${label} is missing ${value}`);
}

async function main() {
  await assertFile(jsonReportPath);
  await assertFile(markdownReportPath);

  const manifest = await readJson(manifestPath);
  const report = await readJson(jsonReportPath);
  const markdown = await readFile(markdownReportPath, 'utf8');

  if (report.productName !== manifest.productName) {
    fail(`Report productName mismatch: ${report.productName} != ${manifest.productName}`);
  }
  if (report.version !== manifest.version) {
    fail(`Report version mismatch: ${report.version} != ${manifest.version}`);
  }
  if (report.platform !== manifest.platform) {
    fail(`Report platform mismatch: ${report.platform} != ${manifest.platform}`);
  }
  if (!Array.isArray(report.artifacts)) {
    fail('Signing report artifacts must be an array.');
  }
  if (report.artifacts.length !== manifest.artifacts.length) {
    fail(
      `Signing report has ${report.artifacts.length} artifacts; manifest has ${manifest.artifacts.length}.`,
    );
  }

  const manifestArtifacts = new Map(manifest.artifacts.map((artifact) => [artifactKey(artifact), artifact]));
  const statuses = [];

  for (const entry of report.artifacts) {
    const manifestArtifact = manifestArtifacts.get(artifactKey(entry));
    if (!manifestArtifact) fail(`Signing report has an unknown artifact: ${artifactKey(entry)}`);
    if (entry.fileName !== manifestArtifact.fileName) {
      fail(`${entry.path} fileName mismatch: ${entry.fileName} != ${manifestArtifact.fileName}`);
    }
    if (entry.sha256 !== manifestArtifact.sha256 || !sha256Pattern.test(entry.sha256)) {
      fail(`${entry.path} SHA-256 does not match the release manifest.`);
    }

    const status = entry.signature?.status ?? '';
    statuses.push(status);
    if (!allowedStatuses.has(status)) fail(`${entry.path} has unsafe signature status: ${status}`);

    assertContains('release-signing-report.md', markdown, entry.fileName);
    assertContains('release-signing-report.md', markdown, entry.sha256);
    assertContains('release-signing-report.md', markdown, status);
  }

  const expectedState = expectedSigningState(statuses);
  if (report.signingState !== expectedState) {
    fail(`Signing state mismatch: report ${report.signingState}, expected ${expectedState}`);
  }

  if (expectedState === 'mixed' && !allowMixed()) {
    fail('Signing report mixes signed and unsigned artifacts. Set CTS_RELEASE_ALLOW_MIXED_SIGNATURES=1 only for explicit transition tests.');
  }
  if (requireSigned() && expectedState !== 'signed') {
    fail('CTS_RELEASE_REQUIRE_SIGNED=1 requires every artifact to have a Valid Authenticode signature.');
  }

  assertContains('release-signing-report.md', markdown, 'Release Signing Report');
  assertContains('release-signing-report.md', markdown, `Overall signing state: ${report.signingState}`);

  console.log(`Release signing report verification passed: ${relativeFromRepo(jsonReportPath)}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
