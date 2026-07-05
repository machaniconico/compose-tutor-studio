import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const manifestPath = join(releaseOutputDir, 'release-manifest.json');
const installerMetadataReportPath = join(releaseOutputDir, 'release-installer-metadata-report.json');
const jsonOutputPath = join(releaseOutputDir, 'release-installer-smoke-plan.json');
const markdownOutputPath = join(releaseOutputDir, 'release-installer-smoke-plan.md');

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function assertFile(path) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error(`${relativeFromRepo(path)} is not a file.`);
}

function artifactByKind(manifest, kind) {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind);
  if (!artifact) throw new Error(`Missing ${kind} in release manifest.`);
  return artifact;
}

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cleanCell(value) {
  return String(value).replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
}

function step(id, purpose, command, expected) {
  return {
    id,
    purpose,
    shell: 'PowerShell',
    command,
    expected,
  };
}

function buildSteps({ manifest, artifacts, metadata }) {
  const productCode = metadata.MsiInstaller.ProductCode;
  const productName = manifest.productName;
  const nsisPath = resolve(repoRoot, artifacts.nsis.path);
  const msiPath = resolve(repoRoot, artifacts.msi.path);
  const installRootSuffix = `Programs\\${productName}`;
  const installedExeSuffix = `${installRootSuffix}\\${productName}.exe`;

  return [
    step(
      'PRE-001',
      'Confirm the candidate artifacts and installer metadata match the release manifest before touching the machine.',
      'pnpm release:verify; pnpm release:installers:verify',
      'Both commands pass for the same candidate build.',
    ),
    step(
      'REL-MAN-001-NSIS-INSTALL',
      'Install the NSIS candidate in a clean Windows VM or disposable test account.',
      `Start-Process -FilePath ${psSingleQuote(nsisPath)} -Wait -PassThru`,
      'Installer completes without error and the app can be found from Start or the install directory.',
    ),
    step(
      'REL-MAN-001-NSIS-SILENT-OPTIONAL',
      'Optional unattended NSIS install check for repeatable QA environments.',
      `Start-Process -FilePath ${psSingleQuote(nsisPath)} -ArgumentList '/S' -Wait -PassThru`,
      'Process exits successfully. If this differs from the interactive install, record the difference in the QA log.',
    ),
    step(
      'REL-MAN-001-NSIS-LAUNCH-PROBE',
      'Probe the default per-user Tauri NSIS install location and launch if present.',
      `$exe = Join-Path $env:LOCALAPPDATA ${psSingleQuote(installedExeSuffix)}; if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe } else { Write-Host "Expected exe not found: $exe" }`,
      'Compose Tutor Studio opens. If installed elsewhere, launch from Start and note the actual path.',
    ),
    step(
      'REL-MAN-001-NSIS-UNINSTALL',
      'Uninstall the NSIS candidate after launch checks.',
      `$uninstaller = Join-Path $env:LOCALAPPDATA ${psSingleQuote(`${installRootSuffix}\\uninstall.exe`)}; if (Test-Path -LiteralPath $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru } else { Write-Host 'Use Windows Settings > Installed apps to uninstall.' }`,
      'The app is removed and no stale Start/menu shortcut remains for this candidate.',
    ),
    step(
      'REL-MAN-002-MSI-INSTALL',
      'Install the MSI candidate in a clean Windows VM or disposable test account.',
      `Start-Process msiexec.exe -ArgumentList '/i', ${psSingleQuote(msiPath)}, '/qn', '/norestart', 'ALLUSERS=2', 'MSIINSTALLPERUSER=1', '/L*v', ${psSingleQuote(resolve(releaseOutputDir, 'msi-install-smoke.log'))} -Wait -PassThru`,
      'msiexec exits successfully and the app can be launched from the installed location or Start.',
    ),
    step(
      'REL-MAN-002-MSI-UNINSTALL',
      'Uninstall the MSI candidate by ProductCode after launch checks.',
      `Start-Process msiexec.exe -ArgumentList '/x', ${psSingleQuote(productCode)}, '/qn', '/norestart', '/L*v', ${psSingleQuote(resolve(releaseOutputDir, 'msi-uninstall-smoke.log'))} -Wait -PassThru`,
      'msiexec exits successfully and the app is removed from Windows installed apps.',
    ),
  ];
}

function renderMarkdown(report) {
  const rows = report.steps
    .map(
      (entry) =>
        `| ${entry.id} | ${cleanCell(entry.purpose)} | \`${cleanCell(entry.command)}\` | ${cleanCell(entry.expected)} |`,
    )
    .join('\n');

  return `# Release Installer Smoke Plan

Generated at: ${report.generatedAt}

Manifest: \`${report.manifestPath}\`

Installer metadata report: \`${report.installerMetadataReportPath}\`

Overall result: ${report.result}

This plan is candidate-specific and does not install, launch, or uninstall anything by itself. Run these commands only in a clean Windows VM, disposable test account, or explicitly approved QA machine. Record the actual result in the candidate QA log.

| Artifact | File | SHA-256 |
|---|---|---|
| NSIS installer | \`${report.artifacts.nsis.path}\` | \`${report.artifacts.nsis.sha256}\` |
| MSI installer | \`${report.artifacts.msi.path}\` | \`${report.artifacts.msi.sha256}\` |
| Portable exe | \`${report.artifacts.portable.path}\` | \`${report.artifacts.portable.sha256}\` |

MSI ProductCode: \`${report.msiProductCode}\`

| ID | Purpose | Command | Expected result |
|---|---|---|---|
${rows}
`;
}

async function main() {
  const manifest = await readJson(manifestPath);
  const metadataReport = await readJson(installerMetadataReportPath);
  if (metadataReport.result !== 'Pass') {
    throw new Error('Run pnpm release:installers:verify and resolve failures before creating the smoke plan.');
  }

  const artifacts = {
    portable: artifactByKind(manifest, 'portable-exe'),
    msi: artifactByKind(manifest, 'msi-installer'),
    nsis: artifactByKind(manifest, 'nsis-installer'),
  };

  for (const artifact of Object.values(artifacts)) {
    await assertFile(resolve(repoRoot, artifact.path));
  }

  const report = {
    productName: manifest.productName,
    version: manifest.version,
    platform: manifest.platform,
    generatedAt: new Date().toISOString(),
    result: 'Pass',
    planOnly: true,
    manifestPath: relativeFromRepo(manifestPath),
    installerMetadataReportPath: relativeFromRepo(installerMetadataReportPath),
    msiProductCode: metadataReport.metadata.MsiInstaller.ProductCode,
    artifacts,
    steps: buildSteps({
      manifest,
      artifacts,
      metadata: metadataReport.metadata,
    }),
  };

  await mkdir(releaseOutputDir, { recursive: true });
  await writeFile(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownOutputPath, renderMarkdown(report), 'utf8');

  console.log(`Created ${relativeFromRepo(jsonOutputPath)}`);
  console.log(`Created ${relativeFromRepo(markdownOutputPath)}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
