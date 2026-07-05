import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const manifestPath = join(releaseOutputDir, 'release-manifest.json');
const jsonOutputPath = join(releaseOutputDir, 'release-installer-metadata-report.json');
const markdownOutputPath = join(releaseOutputDir, 'release-installer-metadata-report.md');

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function artifactByKind(manifest, kind) {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind);
  if (!artifact) throw new Error(`Missing ${kind} in release manifest.`);
  return artifact;
}

function normalizeUpgradeCode(value) {
  return String(value ?? '').replace(/[{}]/g, '').toLowerCase();
}

function powershellScript() {
  return `
$ErrorActionPreference = 'Stop'

function Get-VersionInfoRecord($path) {
  $item = Get-Item -LiteralPath $path
  $info = $item.VersionInfo
  [pscustomobject]@{
    Path = [string]$path
    Exists = [bool](Test-Path -LiteralPath $path)
    FileDescription = [string]$info.FileDescription
    ProductName = [string]$info.ProductName
    ProductVersion = [string]$info.ProductVersion
    FileVersion = [string]$info.FileVersion
    CompanyName = [string]$info.CompanyName
  }
}

function Get-MsiProperty($database, $name) {
  $view = $database.OpenView("SELECT \`Value\` FROM \`Property\` WHERE \`Property\`='$name'")
  [void]$view.Execute()
  $record = $view.Fetch()
  $value = if ($record) { [string]$record.StringData(1) } else { '' }
  [void]$view.Close()
  return $value
}

function Get-MsiRecord($path) {
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($path, 0))
  try {
    [pscustomobject]@{
      Path = [string]$path
      Exists = [bool](Test-Path -LiteralPath $path)
      ProductName = Get-MsiProperty $database 'ProductName'
      ProductVersion = Get-MsiProperty $database 'ProductVersion'
      ProductCode = Get-MsiProperty $database 'ProductCode'
      UpgradeCode = Get-MsiProperty $database 'UpgradeCode'
      Manufacturer = Get-MsiProperty $database 'Manufacturer'
    }
  } finally {
    if ($database) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($database) }
    if ($installer) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($installer) }
  }
}

[pscustomobject]@{
  PortableExe = Get-VersionInfoRecord $env:CTS_PORTABLE_EXE
  NsisInstaller = Get-VersionInfoRecord $env:CTS_NSIS_INSTALLER
  MsiInstaller = Get-MsiRecord $env:CTS_MSI_INSTALLER
} | ConvertTo-Json -Compress -Depth 5
`;
}

async function readWindowsMetadata(artifacts) {
  if (process.platform !== 'win32') {
    throw new Error('Installer metadata verification requires Windows.');
  }

  const encodedCommand = Buffer.from(powershellScript(), 'utf16le').toString('base64');
  const candidates = process.env.CTS_INSTALLER_METADATA_POWERSHELL
    ? [process.env.CTS_INSTALLER_METADATA_POWERSHELL]
    : ['pwsh.exe', 'powershell.exe'];

  let stdout = '';
  let lastError = null;
  for (const executable of candidates) {
    try {
      const result = await execFileAsync(executable, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedCommand,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CTS_PORTABLE_EXE: resolve(repoRoot, artifacts.portable.path),
          CTS_MSI_INSTALLER: resolve(repoRoot, artifacts.msi.path),
          CTS_NSIS_INSTALLER: resolve(repoRoot, artifacts.nsis.path),
        },
        maxBuffer: 1024 * 1024,
        timeout: 30000,
        windowsHide: true,
      });
      stdout = result.stdout;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!stdout) throw lastError ?? new Error('PowerShell did not return installer metadata.');
  return JSON.parse(stdout.trim());
}

function resultLabel(ok) {
  return ok ? 'Pass' : 'Fail';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addEqualCheck(checks, label, actual, expected) {
  checks.push({
    label,
    actual: String(actual ?? ''),
    expected: String(expected ?? ''),
    result: resultLabel(String(actual ?? '') === String(expected ?? '')),
  });
}

function addNonEmptyCheck(checks, label, actual) {
  checks.push({
    label,
    actual: String(actual ?? ''),
    expected: 'non-empty',
    result: resultLabel(String(actual ?? '').trim().length > 0),
  });
}

function addFilenameCheck(checks, label, fileName, pattern) {
  checks.push({
    label,
    actual: fileName,
    expected: pattern.toString(),
    result: resultLabel(pattern.test(fileName)),
  });
}

function buildChecks({ manifest, tauriConfig, artifacts, metadata }) {
  const checks = [];
  const productName = manifest.productName;
  const version = manifest.version;
  const upgradeCode = tauriConfig.bundle?.windows?.wix?.upgradeCode ?? '';
  const productPattern = escapeRegExp(productName);
  const versionPattern = escapeRegExp(version);

  addFilenameCheck(checks, 'portable exe file name', artifacts.portable.fileName, /^cts-studio\.exe$/);
  addFilenameCheck(
    checks,
    'MSI installer file name includes product, version, architecture, and locale',
    artifacts.msi.fileName,
    new RegExp(`^${productPattern}_${versionPattern}_x64_en-US\\.msi$`),
  );
  addFilenameCheck(
    checks,
    'NSIS installer file name includes product, version, architecture, and setup suffix',
    artifacts.nsis.fileName,
    new RegExp(`^${productPattern}_${versionPattern}_x64-setup\\.exe$`),
  );

  for (const [label, info] of [
    ['portable exe', metadata.PortableExe],
    ['NSIS installer', metadata.NsisInstaller],
  ]) {
    addEqualCheck(checks, `${label} ProductName`, info.ProductName, productName);
    addEqualCheck(checks, `${label} FileDescription`, info.FileDescription, productName);
    addEqualCheck(checks, `${label} ProductVersion`, info.ProductVersion, version);
    addEqualCheck(checks, `${label} FileVersion`, info.FileVersion, version);
  }

  addEqualCheck(checks, 'MSI ProductName', metadata.MsiInstaller.ProductName, productName);
  addEqualCheck(checks, 'MSI ProductVersion', metadata.MsiInstaller.ProductVersion, version);
  checks.push({
    label: 'MSI ProductCode',
    actual: metadata.MsiInstaller.ProductCode,
    expected: 'Windows Installer product code GUID',
    result: resultLabel(/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(
      metadata.MsiInstaller.ProductCode ?? '',
    )),
  });
  checks.push({
    label: 'MSI UpgradeCode',
    actual: normalizeUpgradeCode(metadata.MsiInstaller.UpgradeCode),
    expected: normalizeUpgradeCode(upgradeCode),
    result: resultLabel(normalizeUpgradeCode(metadata.MsiInstaller.UpgradeCode) === normalizeUpgradeCode(upgradeCode)),
  });
  addNonEmptyCheck(checks, 'MSI Manufacturer', metadata.MsiInstaller.Manufacturer);

  return checks;
}

function renderMarkdown(report) {
  const rows = report.checks
    .map((check) => `| ${check.label} | ${check.result} | \`${check.actual}\` | \`${check.expected}\` |`)
    .join('\n');

  return `# Release Installer Metadata Report

Generated at: ${report.generatedAt}

Manifest: \`${report.manifestPath}\`

Overall result: ${report.result}

| Check | Result | Actual | Expected |
|---|---|---|---|
${rows}
`;
}

async function main() {
  const manifest = await readJson(manifestPath);
  const tauriConfig = await readJson(join(appRoot, 'src-tauri', 'tauri.conf.json'));
  const artifacts = {
    portable: artifactByKind(manifest, 'portable-exe'),
    msi: artifactByKind(manifest, 'msi-installer'),
    nsis: artifactByKind(manifest, 'nsis-installer'),
  };
  const metadata = await readWindowsMetadata(artifacts);
  const checks = buildChecks({ manifest, tauriConfig, artifacts, metadata });
  const result = checks.every((check) => check.result === 'Pass') ? 'Pass' : 'Fail';
  const report = {
    productName: manifest.productName,
    version: manifest.version,
    platform: manifest.platform,
    generatedAt: new Date().toISOString(),
    manifestPath: relativeFromRepo(manifestPath),
    result,
    metadata,
    checks,
  };

  await mkdir(releaseOutputDir, { recursive: true });
  await writeFile(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownOutputPath, renderMarkdown(report), 'utf8');

  console.log(`Created ${relativeFromRepo(jsonOutputPath)}`);
  console.log(`Created ${relativeFromRepo(markdownOutputPath)}`);

  for (const check of checks) {
    console.log(`${check.result} ${check.label}`);
  }

  if (result !== 'Pass') process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
