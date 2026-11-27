import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// .omc is git-ignored local agent state, never part of a checkout in CI.
const ignoredDirs = new Set([
  '.git',
  '.omc',
  'node_modules',
  'dist',
  'target',
  'coverage',
  '.next',
  '.turbo',
  '.vite',
]);

const maxTextFileSizeBytes = 1024 * 1024;
// Signing material files fail outright; .pem is scanned for private key blocks because public certificates are legitimate.
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
  '.pem',
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

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isIgnoredDirectory(repoRoot, name, path) {
  if (ignoredDirs.has(name)) return true;
  const relativePath = relative(repoRoot, path).replaceAll('\\', '/');
  return relativePath.startsWith('docs/releases/') && relativePath.split('/').length > 4;
}

async function listFiles(repoRoot, root, { allowTarget = false } = {}) {
  if (!(await exists(root))) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!allowTarget && isIgnoredDirectory(repoRoot, entry.name, path)) continue;
      files.push(...(await listFiles(repoRoot, path, { allowTarget })));
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
  return value.trim().replace(/[,;}\]]+$/, '').trim().replace(/^['"]|['"]$/g, '').trim();
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
    String.raw`\b${name}\b['"]?\s*(?:=|:)\s*([^\r\n#]+)`,
    'g',
  );
}

function checkPrivateKeyBlocks(path, text, issues) {
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
}

function checkSecretAssignments(path, text, issues) {
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

export async function checkReleaseSecrets(repoRoot = defaultRepoRoot) {
  const releaseEvidenceDir = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'release');
  const issues = [];
  const rootFiles = await listFiles(repoRoot, repoRoot);
  const releaseFiles = await listFiles(repoRoot, releaseEvidenceDir, { allowTarget: true });
  const files = [...new Set([...rootFiles, ...releaseFiles])];

  for (const file of files) {
    const path = relative(repoRoot, file).replaceAll('\\', '/');
    const extension = extname(file).toLowerCase();
    if (forbiddenSecretFileExtensions.has(extension)) {
      issues.push({
        path,
        line: 1,
        message: `private signing material file must not be committed or archived: ${basename(file)}`,
      });
      continue;
    }

    const fileStat = await stat(file);
    if (fileStat.size > maxTextFileSizeBytes) continue;

    const buffer = await readFile(file);
    if (buffer.includes(0)) continue;
    const text = buffer.toString('utf8');
    // A PEM private key block fails in any text file, whatever its extension.
    checkPrivateKeyBlocks(path, text, issues);
    if (isTextCandidate(file)) checkSecretAssignments(path, text, issues);
  }

  return issues;
}

async function main() {
  const issues = await checkReleaseSecrets();

  if (issues.length > 0) {
    console.error(`Release secret policy check failed: ${issues.length} issue(s).`);
    for (const issue of issues) {
      console.error(`FAIL ${issue.path}:${issue.line} ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Release secret policy check passed: no private signing keys, certificates, or secret values detected.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
