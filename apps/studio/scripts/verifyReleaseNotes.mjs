import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const defaultNotesPath = join(appRoot, 'src-tauri', 'target', 'release', 'release', 'release-notes-draft.md');

const requiredSections = [
  '## Overview',
  '## Download',
  '## System Requirements',
  '## Third-party Notices',
  '## Installation Notice',
  '## Confirmed Features',
  '## Diagnostics And Privacy',
  '## Known Limitations',
  '## Uninstall',
  '## Release Owner Checklist',
];

const requiredDownloadTypes = ['NSIS installer', 'MSI installer', 'Portable exe'];

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function parseArgs(argv) {
  const options = {
    allowDraft: false,
    path: process.env.CTS_RELEASE_NOTES_PATH || defaultNotesPath,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-draft') {
      options.allowDraft = true;
    } else if (arg === '--path') {
      index += 1;
      if (!argv[index]) throw new Error('--path requires a file path.');
      options.path = argv[index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.path = isAbsolute(options.path) ? options.path : resolve(repoRoot, options.path);
  return options;
}

function normalizeCell(value) {
  return value.replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

function sectionText(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`Missing section: ${heading}`);

  const next = text.slice(start + 1).search(/\n##\s+/);
  return next >= 0 ? text.slice(start, start + 1 + next) : text.slice(start);
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseFirstTable(section, label) {
  const lines = section.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*\|.*\|\s*$/.test(line));
  if (headerIndex < 0 || !lines[headerIndex + 1]) throw new Error(`Missing table in ${label}.`);

  const headers = splitTableRow(lines[headerIndex]);
  const rows = [];

  for (const line of lines.slice(headerIndex + 2)) {
    if (!/^\s*\|.*\|\s*$/.test(line)) break;
    const cells = splitTableRow(line);
    const row = {};
    headers.forEach((header, index) => {
      row[normalizeCell(header)] = normalizeCell(cells[index] ?? '');
    });
    rows.push(row);
  }

  if (rows.length === 0) throw new Error(`Table in ${label} has no rows.`);
  return rows;
}

function isBlank(value) {
  return value.trim() === '';
}

function validateReleaseNotes(text, { allowDraft }) {
  const errors = [];
  const require = (condition, message) => {
    if (!condition) errors.push(message);
  };

  require(/^# Compose Tutor Studio \d+\.\d+\.\d+ for Windows/m.test(text), 'Title must include product, version, and Windows.');

  for (const section of requiredSections) {
    require(text.includes(section), `Missing release notes section: ${section}.`);
  }

  require(text.includes('SHA256SUMS.txt'), 'Release notes must mention SHA256SUMS.txt.');
  require(text.includes('release-manifest.json'), 'Release notes must mention release-manifest.json.');
  require(text.includes('release-signing-report.json'), 'Release notes must mention release-signing-report.json.');
  require(text.includes('THIRD_PARTY_NOTICES.md'), 'Release notes must mention THIRD_PARTY_NOTICES.md.');
  require(text.includes('SmartScreen'), 'Release notes must mention SmartScreen for unsigned builds.');
  require(text.includes('[local-path]'), 'Release notes must explain local-path redaction.');
  require(text.includes('app version'), 'Release notes must mention diagnostic app version.');
  require(text.includes('user agent'), 'Release notes must mention diagnostic user agent.');
  require(text.includes('manual copy diagnostic report'), 'Release notes must mention the manual diagnostic copy fallback.');

  const downloadRows = parseFirstTable(sectionText(text, '## Download'), 'download');
  const downloadTypes = new Map(downloadRows.map((row) => [row.Type, row]));

  for (const type of requiredDownloadTypes) {
    const row = downloadTypes.get(type);
    require(Boolean(row), `Download table is missing ${type}.`);
    if (row) {
      require(!isBlank(row.File), `${type} file is blank.`);
      require(!isBlank(row.Purpose), `${type} purpose is blank.`);
      require(/^[a-f0-9]{64}$/i.test(row['SHA-256'] ?? ''), `${type} SHA-256 is missing or invalid.`);
    }
  }

  const limitationRows = parseFirstTable(sectionText(text, '## Known Limitations'), 'known limitations');
  for (const row of limitationRows) {
    const cells = [row.Limitation ?? '', row.Impact ?? '', row['Workaround or follow-up'] ?? ''];
    const blankRow = cells.every(isBlank);
    if (allowDraft) continue;
    require(!blankRow, 'Known limitations table still contains a blank placeholder row.');
    require(cells.every((cell) => !isBlank(cell)), `Known limitation row is incomplete: ${cells.join(' / ')}`);
  }

  const checklist = sectionText(text, '## Release Owner Checklist');
  for (const phrase of [
    'pnpm release:verify',
    'pnpm release:notes',
    'pnpm release:notes:verify',
    'pnpm release:qa-log:verify',
    'pnpm release:archive',
    'pnpm release:archive:verify',
    'pnpm release:source-status',
    'pnpm release:source-status:verify',
    'release-source-status-report.json',
    'pnpm release:signing',
    'pnpm release:signing:verify',
    'release-signing-report.json',
    'pnpm check:privacy',
    'pnpm check:secrets',
    'pnpm check:assets',
    'pnpm release:notices',
    'pnpm release:notices:verify',
    'THIRD_PARTY_NOTICES.md',
    'pnpm release:verify:publish',
    'SHA-256',
    'sourceControl',
    'dirty/clean state',
    'Known limitations',
  ]) {
    require(checklist.includes(phrase), `Release owner checklist is missing ${phrase}.`);
  }

  if (!allowDraft) {
    for (const phrase of [
      'Generated from',
      'release notes draft',
      'Before publishing',
      'replace download URLs',
      'remove any limitation rows',
    ]) {
      require(!text.includes(phrase), `Publishable release notes still contain draft text: ${phrase}.`);
    }

    require(!/\|\s*\|\s*\|\s*\|/.test(text), 'Publishable release notes still contain an empty table row.');
  }

  return errors;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const text = await readFile(options.path, 'utf8');
  const errors = validateReleaseNotes(text, options);

  if (errors.length > 0) {
    console.error(`Release notes verification failed: ${relativeFromRepo(options.path)}`);
    for (const error of errors) console.error(`FAIL ${error}`);
    process.exitCode = 1;
    return;
  }

  const mode = options.allowDraft ? 'draft structure' : 'publishable';
  console.log(`Release notes verification passed (${mode}): ${relativeFromRepo(options.path)}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
