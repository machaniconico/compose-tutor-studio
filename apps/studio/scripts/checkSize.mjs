import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktop = process.argv.includes('--desktop');

const KiB = 1024;
const MiB = 1024 * KiB;

const budgets = {
  jsRaw: 600 * KiB,
  jsGzip: 180 * KiB,
  cssRaw: 90 * KiB,
  cssGzip: 24 * KiB,
  desktopExe: 30 * MiB,
  msiInstaller: 20 * MiB,
  nsisInstaller: 20 * MiB,
};

function formatBytes(value) {
  if (value >= MiB) return `${(value / MiB).toFixed(2)} MiB`;
  return `${(value / KiB).toFixed(1)} KiB`;
}

function pass(label, actual, budget) {
  console.log(`PASS ${label}: ${formatBytes(actual)} / ${formatBytes(budget)}`);
}

function fail(label, actual, budget) {
  throw new Error(`${label} is ${formatBytes(actual)}, over budget ${formatBytes(budget)}`);
}

function assertBudget(label, actual, budget) {
  if (actual > budget) fail(label, actual, budget);
  pass(label, actual, budget);
}

async function listAssetFiles(extension) {
  const assetsDir = join(root, 'dist', 'assets');
  let entries;
  try {
    entries = await readdir(assetsDir, { withFileTypes: true });
  } catch {
    throw new Error(`Missing ${assetsDir}. Run pnpm build before size checks.`);
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(assetsDir, entry.name));
  if (files.length === 0) {
    throw new Error(`No ${extension} assets found in ${assetsDir}. Run pnpm build before size checks.`);
  }
  return files;
}

async function totalRawAndGzip(files) {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const contents = await readFile(file);
    raw += contents.byteLength;
    gzip += gzipSync(contents).byteLength;
  }
  return { raw, gzip };
}

async function fileSize(path, hint) {
  try {
    return (await stat(path)).size;
  } catch {
    throw new Error(`Missing ${path}. ${hint}`);
  }
}

async function findSingleFile(dir, extension, hint) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`Missing ${dir}. ${hint}`);
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(dir, entry.name));
  if (files.length !== 1) {
    throw new Error(`Expected one ${extension} artifact in ${dir}, found ${files.length}. ${hint}`);
  }
  return files[0];
}

async function checkWebAssets() {
  const js = await totalRawAndGzip(await listAssetFiles('.js'));
  const css = await totalRawAndGzip(await listAssetFiles('.css'));

  assertBudget('web JS raw total', js.raw, budgets.jsRaw);
  assertBudget('web JS gzip total', js.gzip, budgets.jsGzip);
  assertBudget('web CSS raw total', css.raw, budgets.cssRaw);
  assertBudget('web CSS gzip total', css.gzip, budgets.cssGzip);
}

async function checkDesktopArtifacts() {
  const hint = 'Run pnpm build:desktop before desktop size checks.';
  const releaseDir = join(root, 'src-tauri', 'target', 'release');
  const exe = join(releaseDir, 'cts-studio.exe');
  const msi = await findSingleFile(join(releaseDir, 'bundle', 'msi'), '.msi', hint);
  const nsis = await findSingleFile(join(releaseDir, 'bundle', 'nsis'), '.exe', hint);

  assertBudget('desktop exe', await fileSize(exe, hint), budgets.desktopExe);
  assertBudget('MSI installer', await fileSize(msi, hint), budgets.msiInstaller);
  assertBudget('NSIS installer', await fileSize(nsis, hint), budgets.nsisInstaller);
}

try {
  await checkWebAssets();
  if (requireDesktop) {
    await checkDesktopArtifacts();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
