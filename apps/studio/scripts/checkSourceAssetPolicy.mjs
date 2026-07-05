import { readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');

const ignoredDirs = new Set([
  '.git',
  '.omc',
  '.next',
  '.pnpm-store',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'target',
  'test-results',
]);

const controlledAssetExtensions = new Set([
  '.avi',
  '.flac',
  '.gif',
  '.icns',
  '.ico',
  '.jpg',
  '.jpeg',
  '.mid',
  '.midi',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.p12',
  '.pfx',
  '.png',
  '.wav',
  '.webp',
  '.zip',
]);

const allowedAssetPaths = new Set([
  'apps/studio/src-tauri/icons/icon.ico',
  'apps/studio/src-tauri/icons/icon.png',
]);

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

async function main() {
  const files = await listFiles(repoRoot);
  const issues = [];

  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (!controlledAssetExtensions.has(extension)) continue;

    const relativePath = relativeFromRepo(file);
    if (allowedAssetPaths.has(relativePath)) continue;

    issues.push(relativePath);
  }

  if (issues.length > 0) {
    console.error(`Source asset policy check failed: ${issues.length} unexpected asset file(s).`);
    for (const issue of issues) {
      console.error(`FAIL ${issue}`);
    }
    console.error('Add only original/owned assets, then explicitly whitelist required app assets.');
    process.exitCode = 1;
    return;
  }

  console.log('Source asset policy check passed: no unexpected image, audio, video, archive, or signing asset files detected.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
