import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const manifestPath = join(releaseOutputDir, 'release-manifest.json');
const installerMetadataReportPath = join(releaseOutputDir, 'release-installer-metadata-report.json');
const jsonPlanPath = join(releaseOutputDir, 'release-installer-smoke-plan.json');
const markdownPlanPath = join(releaseOutputDir, 'release-installer-smoke-plan.md');

const requiredStepIds = [
  'PRE-001',
  'REL-MAN-001-NSIS-INSTALL',
  'REL-MAN-001-NSIS-SILENT-OPTIONAL',
  'REL-MAN-001-NSIS-LAUNCH-PROBE',
  'REL-MAN-001-NSIS-UNINSTALL',
  'REL-MAN-002-MSI-INSTALL',
  'REL-MAN-002-MSI-UNINSTALL',
];

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
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) fail(`${relativeFromRepo(path)} is not a file.`);
  } catch {
    fail(`Missing ${relativeFromRepo(path)}.`);
  }
}

function artifactByKind(manifest, kind) {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind);
  if (!artifact) fail(`Missing ${kind} in release manifest.`);
  return artifact;
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertContains(label, text, value) {
  if (!text.includes(value)) fail(`${label} is missing ${value}`);
}

function assertValidProductCode(productCode) {
  if (!/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(productCode ?? '')) {
    fail(`MSI ProductCode is not a GUID in braces: ${productCode ?? '(missing)'}`);
  }
}

function assertArtifact(planArtifact, manifestArtifact, label) {
  assertEqual(`${label} kind`, planArtifact.kind, manifestArtifact.kind);
  assertEqual(`${label} fileName`, planArtifact.fileName, manifestArtifact.fileName);
  assertEqual(`${label} path`, planArtifact.path, manifestArtifact.path);
  assertEqual(`${label} sizeBytes`, planArtifact.sizeBytes, manifestArtifact.sizeBytes);
  assertEqual(`${label} sha256`, planArtifact.sha256, manifestArtifact.sha256);
}

function assertStepShape(step) {
  if (!step || typeof step !== 'object') fail('Smoke plan step is not an object.');
  for (const field of ['id', 'purpose', 'shell', 'command', 'expected']) {
    if (typeof step[field] !== 'string' || step[field].trim() === '') {
      fail(`Smoke plan step ${step.id ?? '(unknown)'} is missing ${field}.`);
    }
  }
  assertEqual(`Smoke plan step ${step.id} shell`, step.shell, 'PowerShell');
}

function assertSmokeSteps(plan, manifest, metadataReport) {
  if (!Array.isArray(plan.steps)) fail('Smoke plan steps must be an array.');
  const stepsById = new Map();

  for (const step of plan.steps) {
    assertStepShape(step);
    if (stepsById.has(step.id)) fail(`Duplicate smoke plan step id: ${step.id}`);
    stepsById.set(step.id, step);
  }

  for (const id of requiredStepIds) {
    if (!stepsById.has(id)) fail(`Smoke plan is missing ${id}.`);
  }

  const nsis = artifactByKind(manifest, 'nsis-installer');
  const msi = artifactByKind(manifest, 'msi-installer');
  const nsisAbsolutePath = resolve(repoRoot, nsis.path);
  const msiAbsolutePath = resolve(repoRoot, msi.path);
  const productCode = metadataReport.metadata?.MsiInstaller?.ProductCode ?? '';

  assertContains('PRE-001 command', stepsById.get('PRE-001').command, 'pnpm release:verify');
  assertContains('PRE-001 command', stepsById.get('PRE-001').command, 'pnpm release:installers:verify');
  assertContains('NSIS install command', stepsById.get('REL-MAN-001-NSIS-INSTALL').command, nsisAbsolutePath);
  assertContains('NSIS silent command', stepsById.get('REL-MAN-001-NSIS-SILENT-OPTIONAL').command, '/S');
  assertContains('NSIS launch probe command', stepsById.get('REL-MAN-001-NSIS-LAUNCH-PROBE').command, manifest.productName);
  assertContains('NSIS uninstall command', stepsById.get('REL-MAN-001-NSIS-UNINSTALL').command, 'uninstall.exe');
  assertContains('MSI install command', stepsById.get('REL-MAN-002-MSI-INSTALL').command, 'msiexec.exe');
  assertContains('MSI install command', stepsById.get('REL-MAN-002-MSI-INSTALL').command, msiAbsolutePath);
  assertContains('MSI install command', stepsById.get('REL-MAN-002-MSI-INSTALL').command, '/L*v');
  assertContains('MSI uninstall command', stepsById.get('REL-MAN-002-MSI-UNINSTALL').command, productCode);
  assertContains('MSI uninstall command', stepsById.get('REL-MAN-002-MSI-UNINSTALL').command, '/x');
}

function assertMarkdownCoverage(markdown, plan, manifest) {
  assertContains('release-installer-smoke-plan.md', markdown, 'Release Installer Smoke Plan');
  assertContains('release-installer-smoke-plan.md', markdown, 'does not install, launch, or uninstall anything by itself');
  assertContains('release-installer-smoke-plan.md', markdown, plan.msiProductCode);

  for (const artifact of manifest.artifacts) {
    assertContains('release-installer-smoke-plan.md', markdown, artifact.path);
    assertContains('release-installer-smoke-plan.md', markdown, artifact.sha256);
  }

  for (const id of requiredStepIds) {
    assertContains('release-installer-smoke-plan.md', markdown, id);
  }
}

async function main() {
  await assertFile(jsonPlanPath);
  await assertFile(markdownPlanPath);

  const manifest = await readJson(manifestPath);
  const metadataReport = await readJson(installerMetadataReportPath);
  const plan = await readJson(jsonPlanPath);
  const markdown = await readFile(markdownPlanPath, 'utf8');

  assertEqual('Smoke plan result', plan.result, 'Pass');
  assertEqual('Smoke plan planOnly', plan.planOnly, true);
  assertEqual('Smoke plan productName', plan.productName, manifest.productName);
  assertEqual('Smoke plan version', plan.version, manifest.version);
  assertEqual('Smoke plan platform', plan.platform, manifest.platform);
  assertEqual('Smoke plan manifestPath', plan.manifestPath, relativeFromRepo(manifestPath));
  assertEqual('Smoke plan installerMetadataReportPath', plan.installerMetadataReportPath, relativeFromRepo(installerMetadataReportPath));

  const metadataProductCode = metadataReport.metadata?.MsiInstaller?.ProductCode ?? '';
  assertValidProductCode(plan.msiProductCode);
  assertEqual('Smoke plan MSI ProductCode', plan.msiProductCode, metadataProductCode);

  assertArtifact(plan.artifacts?.portable ?? {}, artifactByKind(manifest, 'portable-exe'), 'portable artifact');
  assertArtifact(plan.artifacts?.msi ?? {}, artifactByKind(manifest, 'msi-installer'), 'MSI artifact');
  assertArtifact(plan.artifacts?.nsis ?? {}, artifactByKind(manifest, 'nsis-installer'), 'NSIS artifact');
  assertSmokeSteps(plan, manifest, metadataReport);
  assertMarkdownCoverage(markdown, plan, manifest);

  console.log(`Release installer smoke plan verification passed: ${relativeFromRepo(jsonPlanPath)}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
