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
const jsonOutputPath = join(releaseOutputDir, 'release-signing-report.json');
const markdownOutputPath = join(releaseOutputDir, 'release-signing-report.md');

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function signingRequirement() {
  return process.env.CTS_RELEASE_REQUIRE_SIGNED === '1';
}

function signingState(statuses) {
  const uniqueStatuses = new Set(statuses);
  if (uniqueStatuses.size === 1 && uniqueStatuses.has('Valid')) return 'signed';
  if (uniqueStatuses.size === 1 && uniqueStatuses.has('NotSigned')) return 'unsigned-limited';
  if ([...uniqueStatuses].some((status) => status !== 'Valid' && status !== 'NotSigned')) {
    return 'invalid-signature';
  }
  return 'mixed';
}

function statusGuidance(state) {
  if (state === 'signed') {
    return 'All release artifacts have a valid Authenticode signature. Keep hashes aligned after signing.';
  }
  if (state === 'unsigned-limited') {
    return 'Artifacts are unsigned. Limit distribution and show SmartScreen/SHA-256 guidance to users.';
  }
  if (state === 'mixed') {
    return 'Some artifacts are signed and others are unsigned. Do not publish until the release notes match the real artifact set.';
  }
  return 'At least one artifact has an invalid or untrusted signature. Do not publish this candidate.';
}

function powershellScript() {
  return `
Import-Module Microsoft.PowerShell.Security
$path = $env:CTS_SIGNATURE_FILE
$sig = Get-AuthenticodeSignature -FilePath $path
[pscustomobject]@{
  Path = [string]$path
  Exists = [bool](Test-Path -LiteralPath $path)
  Status = [string]$sig.Status
  StatusMessage = [string]$sig.StatusMessage
  SignerSubject = [string]$sig.SignerCertificate.Subject
  SignerIssuer = [string]$sig.SignerCertificate.Issuer
  SignerThumbprint = [string]$sig.SignerCertificate.Thumbprint
  TimeStamperSubject = [string]$sig.TimeStamperCertificate.Subject
} | ConvertTo-Json -Compress
`;
}

async function readAuthenticodeSignature(absolutePath) {
  if (process.platform !== 'win32') {
    return {
      status: 'UnsupportedPlatform',
      statusMessage: 'Authenticode signing can only be checked on Windows.',
      signerSubject: '',
      signerIssuer: '',
      signerThumbprint: '',
      timeStamperSubject: '',
    };
  }

  const encodedCommand = Buffer.from(powershellScript(), 'utf16le').toString('base64');
  const candidates = process.env.CTS_SIGNATURE_POWERSHELL
    ? [process.env.CTS_SIGNATURE_POWERSHELL]
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
          CTS_SIGNATURE_FILE: absolutePath,
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

  if (!stdout) throw lastError ?? new Error('PowerShell did not return signature data.');

  const parsed = JSON.parse(stdout.trim());
  const status = parsed.Status || 'UnknownError';
  return {
    status,
    checkedPath: parsed.Path || absolutePath,
    fileExists: Boolean(parsed.Exists),
    statusMessage: status === 'NotSigned' ? 'File is not digitally signed.' : parsed.StatusMessage || '',
    signerSubject: parsed.SignerSubject || '',
    signerIssuer: parsed.SignerIssuer || '',
    signerThumbprint: parsed.SignerThumbprint || '',
    timeStamperSubject: parsed.TimeStamperSubject || '',
  };
}

async function artifactSigningEntry(artifact) {
  const absolutePath = resolve(repoRoot, artifact.path);
  const signature = await readAuthenticodeSignature(absolutePath);
  return {
    kind: artifact.kind,
    fileName: artifact.fileName,
    path: artifact.path,
    sha256: artifact.sha256,
    signature,
  };
}

function signerLabel(entry) {
  return entry.signature.signerSubject || '(none)';
}

function renderMarkdown(report) {
  const rows = report.artifacts
    .map(
      (entry) =>
        `| ${entry.kind} | \`${entry.fileName}\` | ${entry.signature.status} | ${signerLabel(entry)} | \`${entry.sha256}\` |`,
    )
    .join('\n');

  return `# Release Signing Report

Generated at: ${report.generatedAt}

Manifest: \`${report.manifestPath}\`

Require signed artifacts: ${report.requireSigned ? 'yes' : 'no'}

Overall signing state: ${report.signingState}

Guidance: ${report.guidance}

| Artifact | File | Authenticode status | Signer | SHA-256 |
|---|---|---|---|---|
${rows}
`;
}

async function main() {
  const manifest = await readJson(manifestPath);
  const artifacts = [];

  for (const artifact of manifest.artifacts) {
    artifacts.push(await artifactSigningEntry(artifact));
  }

  const state = signingState(artifacts.map((entry) => entry.signature.status));
  const report = {
    productName: manifest.productName,
    version: manifest.version,
    platform: manifest.platform,
    generatedAt: new Date().toISOString(),
    manifestPath: relativeFromRepo(manifestPath),
    requireSigned: signingRequirement(),
    signingState: state,
    guidance: statusGuidance(state),
    artifacts,
  };

  await mkdir(releaseOutputDir, { recursive: true });
  await writeFile(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownOutputPath, renderMarkdown(report), 'utf8');

  console.log(`Created ${relativeFromRepo(jsonOutputPath)}`);
  console.log(`Created ${relativeFromRepo(markdownOutputPath)}`);

  if (report.requireSigned && state !== 'signed') {
    console.error('Release requires signed artifacts, but the signing report is not fully signed.');
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
