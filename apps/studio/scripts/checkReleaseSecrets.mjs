import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseEvidenceDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');

const ignoredDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'target',
  'coverage',
  '.next',
  '.turbo',
  '.vite',
]);

const maxTextFileSizeBytes = 1024 * 1024;
const forbiddenSecretFileExtensions = new Set(['.p12', '.pfx', '.key', '.keystore']);
const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.lock',
  '.md',
  '.mjs',
  '.rs',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const sensitiveVariableNames = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'WINDOWS_SIGNING_CERTIFICATE',
  'WINDOWS_SIGNING_CERTIFICATE_PASSWORD',
  'CERTIFICATE_PASSWORD',
  'SIGNING_CERTIFICATE_PASSWORD',
  'SIGNING_PRIVATE_KEY',
];

const privateKeyPatterns = [
  new RegExp('-----BEGIN [A-Z ]*PRIVATE' + ' KEY-----'),
  new RegExp('-----BEGIN ENCRYPTED PRIVATE' + ' KEY-----'),
  new RegExp('-----BEGIN OPENSSH PRIVATE' + ' KEY-----'),
  new RegExp('-----BEGIN PGP PRIVATE' + ' KEY BLOCK-----'),
];

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isIgnoredDirectory(name, path) {
  if (ignoredDirs.has(name)) return true;
  const relativePath = relativeFromRepo(path);
  return relativePath.startsWith('docs/releases/') && relativePath.split('/').length > 4;
}

async function listFiles(root, { allowTarget = false } = {}) {
  if (!(await exists(root))) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!allowTarget && isIgnoredDirectory(entry.name, path)) continue;
      files.push(...(await listFiles(path, { allowTarget })));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

function isTextCandidate(path) {
  const name = basename(path);
  if (name.startsWith('.env')) return true;
  return textExtensions.has(extname(name).toLowerCase());
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, '').trim();
}

function looksLikePlaceholder(value) {
  const normalized = unquote(value);
  if (normalized === '') return true;
  if (/^<[^>]+>$/.test(normalized)) return true;
  if (/^\$\{\{\s*secrets\./i.test(normalized)) return true;
  if (/^(todo|tbd|changeme|example|placeholder|dummy|redacted)$/i.test(normalized)) return true;
  if (/^(your-|replace-|set-in-ci|not-set)/i.test(normalized)) return true;
  return false;
}

function secretAssignmentPattern(name) {
  return new RegExp(
    String.raw`\b${name}\b\s*(?:=|:)\s*([^\r\n#]+)`,
    'g',
  );
}

function checkTextFile(path, text, issues) {
  for (const pattern of privateKeyPatterns) {
    const match = pattern.exec(text);
    if (match) {
      issues.push({
        path,
        line: lineNumberForIndex(text, match.index),
        message: `private key block detected: ${match[0]}`,
      });
    }
  }

  for (const name of sensitiveVariableNames) {
    const pattern = secretAssignmentPattern(name);
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? '';
      if (looksLikePlaceholder(value)) continue;
      issues.push({
        path,
        line: lineNumberForIndex(text, match.index),
        message: `possible secret value assigned to ${name}`,
      });
    }
  }
}

async function main() {
  const issues = [];
  const rootFiles = await listFiles(repoRoot);
  const releaseFiles = await listFiles(releaseEvidenceDir, { allowTarget: true });
  const files = [...new Set([...rootFiles, ...releaseFiles])];

  for (const path of files) {
    const extension = extname(path).toLowerCase();
    if (forbiddenSecretFileExtensions.has(extension)) {
      issues.push({
        path,
        line: 1,
        message: `private signing material file must not be committed or archived: ${basename(path)}`,
      });
      continue;
    }

    if (!isTextCandidate(path)) continue;
    const fileStat = await stat(path);
    if (fileStat.size > maxTextFileSizeBytes) continue;

    const text = await readFile(path, 'utf8');
    checkTextFile(path, text, issues);
  }

  if (issues.length > 0) {
    console.error(`Release secret policy check failed: ${issues.length} issue(s).`);
    for (const issue of issues) {
      console.error(`FAIL ${relativeFromRepo(issue.path)}:${issue.line} ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Release secret policy check passed: no private signing keys, certificates, or secret values detected.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
