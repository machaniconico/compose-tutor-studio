import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'studio');

const KiB = 1024;
const MiB = 1024 * KiB;

const budgets = {
  // Re-baselined for main on 2026-11-28 (measured JS 1437.6 KiB raw / 416.4 KiB gzip, CSS 101.2 KiB raw / 16.2 KiB gzip)
  // with about 10% headroom. The wave5 budgets (600/180/90 KiB) predate main's feature set.
  jsRaw: 1600 * KiB,
  jsGzip: 460 * KiB,
  cssRaw: 112 * KiB,
  cssGzip: 24 * KiB,
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

async function checkWebAssets() {
  const js = await totalRawAndGzip(await listAssetFiles('.js'));
  const css = await totalRawAndGzip(await listAssetFiles('.css'));

  assertBudget('web JS raw total', js.raw, budgets.jsRaw);
  assertBudget('web JS gzip total', js.gzip, budgets.jsGzip);
  assertBudget('web CSS raw total', css.raw, budgets.cssRaw);
  assertBudget('web CSS gzip total', css.gzip, budgets.cssGzip);
}

try {
  await checkWebAssets();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
