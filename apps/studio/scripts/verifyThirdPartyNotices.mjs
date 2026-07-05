import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const jsonPath = join(releaseOutputDir, 'THIRD_PARTY_NOTICES.json');
const markdownPath = join(releaseOutputDir, 'THIRD_PARTY_NOTICES.md');

const requiredNpmPackages = [
  '@tauri-apps/api',
  '@tauri-apps/plugin-dialog',
  '@tauri-apps/plugin-fs',
  'react',
  'react-dom',
  'zustand',
];

const blockedLicenseTokens = new Set(['AGPL-1.0', 'AGPL-3.0', 'GPL-1.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0']);
const knownLicenseTokens = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'Zlib',
]);

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

async function assertFile(path, errors) {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) errors.push(`${relativeFromRepo(path)} is not a file.`);
  } catch {
    errors.push(`Missing ${relativeFromRepo(path)}.`);
  }
}

function licenseTokens(license) {
  return license
    .replace(/[()]/g, ' ')
    .replace(/\//g, ' OR ')
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function validateLicense(entry, errors) {
  if (!entry.license || entry.license === 'UNKNOWN') {
    errors.push(`${entry.name}@${entry.version} has an unknown license.`);
    return;
  }

  if (entry.license.startsWith('license-file:')) return;

  for (const token of licenseTokens(entry.license)) {
    if (blockedLicenseTokens.has(token) || /^(A?GPL|LGPL)-/.test(token)) {
      errors.push(`${entry.name}@${entry.version} uses blocked license token ${token}.`);
    } else if (!knownLicenseTokens.has(token)) {
      errors.push(`${entry.name}@${entry.version} uses unreviewed license token ${token}.`);
    }
  }
}

async function main() {
  const errors = [];
  await assertFile(jsonPath, errors);
  await assertFile(markdownPath, errors);
  if (errors.length > 0) throw new Error(errors.join('\n'));

  const inventory = JSON.parse(await readFile(jsonPath, 'utf8'));
  const markdown = await readFile(markdownPath, 'utf8');

  if (!Array.isArray(inventory.npm) || inventory.npm.length === 0) {
    errors.push('THIRD_PARTY_NOTICES.json has no npm entries.');
  }

  if (!Array.isArray(inventory.cargo) || inventory.cargo.length === 0) {
    errors.push('THIRD_PARTY_NOTICES.json has no Rust crate entries.');
  }

  const npmNames = new Set((inventory.npm ?? []).map((entry) => entry.name));
  for (const packageName of requiredNpmPackages) {
    if (!npmNames.has(packageName)) errors.push(`Missing runtime npm package notice: ${packageName}.`);
  }

  for (const entry of [...(inventory.npm ?? []), ...(inventory.cargo ?? [])]) {
    validateLicense(entry, errors);
    if (!markdown.includes(entry.name) || !markdown.includes(entry.version)) {
      errors.push(`THIRD_PARTY_NOTICES.md does not mention ${entry.name}@${entry.version}.`);
    }
  }

  if (!markdown.includes('does not replace legal review')) {
    errors.push('THIRD_PARTY_NOTICES.md must keep the legal review disclaimer.');
  }

  if (errors.length > 0) {
    console.error(`Third-party notices verification failed: ${errors.length} issue(s).`);
    for (const error of errors) console.error(`FAIL ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Third-party notices verification passed: ${inventory.npm.length} npm package(s), ${inventory.cargo.length} Rust crate(s).`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
