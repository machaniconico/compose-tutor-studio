import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseDir = join(appRoot, 'src-tauri', 'target', 'release');
const outputDir = join(releaseDir, 'release');

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

async function findSingleFile(dir, extension, hint) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`Missing ${relativeFromRepo(dir)}. ${hint}`);
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(dir, entry.name));

  if (files.length !== 1) {
    throw new Error(
      `Expected one ${extension} artifact in ${relativeFromRepo(dir)}, found ${files.length}. ${hint}`,
    );
  }

  return files[0];
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function hashFile(path) {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    timeout: 5000,
  });
  return stdout.trim();
}

async function sourceControl() {
  const [commit, shortCommit, branch, statusText] = await Promise.all([
    gitOutput(['rev-parse', 'HEAD']),
    gitOutput(['rev-parse', '--short', 'HEAD']),
    gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOutput(['status', '--short']),
  ]);
  const status = statusText === '' ? [] : statusText.split(/\r?\n/);

  return {
    commit,
    shortCommit,
    branch,
    isDirty: status.length > 0,
    status,
  };
}

async function artifact(kind, path) {
  const fileStat = await stat(path);
  return {
    kind,
    fileName: basename(path),
    path: relativeFromRepo(path),
    sizeBytes: fileStat.size,
    sha256: await hashFile(path),
  };
}

async function main() {
  const hint = 'Run pnpm build:desktop before creating the release manifest.';
  const studioPackage = await readJson(join(appRoot, 'package.json'));
  const tauriConfig = await readJson(join(appRoot, 'src-tauri', 'tauri.conf.json'));

  const exe = join(releaseDir, 'cts-studio.exe');
  const msi = await findSingleFile(join(releaseDir, 'bundle', 'msi'), '.msi', hint);
  const nsis = await findSingleFile(join(releaseDir, 'bundle', 'nsis'), '.exe', hint);

  const artifacts = [
    await artifact('portable-exe', exe),
    await artifact('msi-installer', msi),
    await artifact('nsis-installer', nsis),
  ];

  const manifest = {
    productName: tauriConfig.productName,
    packageName: studioPackage.name,
    version: studioPackage.version,
    platform: 'windows-x64',
    generatedAt: new Date().toISOString(),
    sourceControl: await sourceControl(),
    artifacts,
  };

  await mkdir(outputDir, { recursive: true });

  const manifestPath = join(outputDir, 'release-manifest.json');
  const checksumsPath = join(outputDir, 'SHA256SUMS.txt');
  const checksums = artifacts.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n';

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(checksumsPath, checksums, 'utf8');

  console.log(`Created ${relativeFromRepo(manifestPath)}`);
  console.log(`Created ${relativeFromRepo(checksumsPath)}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
