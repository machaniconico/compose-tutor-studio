import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');

const sourceRoots = [
  join(appRoot, 'src'),
  join(appRoot, 'src-tauri', 'src'),
  join(repoRoot, 'packages'),
];

const packageJsonPaths = [
  join(repoRoot, 'package.json'),
  join(appRoot, 'package.json'),
  join(repoRoot, 'packages', 'midi-io', 'package.json'),
  join(repoRoot, 'packages', 'project-model', 'package.json'),
  join(repoRoot, 'packages', 'theory-engine', 'package.json'),
  join(repoRoot, 'packages', 'tutorial-engine', 'package.json'),
];

const tauriConfigPath = join(appRoot, 'src-tauri', 'tauri.conf.json');
const tauriCapabilitiesPath = join(appRoot, 'src-tauri', 'capabilities', 'default.json');
const cargoTomlPath = join(appRoot, 'src-tauri', 'Cargo.toml');

const maxFileSizeBytes = 100 * 1024;
const checkedExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.rs']);
const ignoredDirs = new Set(['node_modules', 'dist', 'target', '.git', 'coverage']);

const forbiddenSourcePatterns = [
  [/\bfetch\s*\(/, 'browser fetch call'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest usage'],
  [/\bWebSocket\b/, 'WebSocket usage'],
  [/\bEventSource\b/, 'EventSource usage'],
  [/\bsendBeacon\b/, 'navigator.sendBeacon usage'],
  [/@tauri-apps\/plugin-http\b/, 'Tauri HTTP plugin import'],
  [/\b(import|require)\s*\(?\s*['"]https?:\/\//, 'remote code import'],
  [/\bhttps?:\/\/(?!localhost\b|127\.0\.0\.1\b|\[::1\])/, 'non-local URL literal in source'],
  [/\b(reqwest|ureq|hyper|tungstenite|tokio-tungstenite)\b/, 'Rust networking crate usage'],
  [/\b(std::net|TcpStream|UdpSocket)\b/, 'Rust standard networking usage'],
];

const forbiddenPackages = new Set([
  '@tauri-apps/plugin-http',
  '@tauri-apps/plugin-updater',
  'axios',
  'graphql-request',
  'ky',
  'node-fetch',
  'socket.io-client',
  'undici',
  'ws',
]);

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function extension(path) {
  const match = path.match(/\.[^.]+$/);
  return match?.[0] ?? '';
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root) {
  if (!(await exists(root))) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile() && checkedExtensions.has(extension(entry.name))) {
      files.push(path);
    }
  }

  return files;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function checkSourceFiles(issues) {
  const files = (await Promise.all(sourceRoots.map((root) => listFiles(root)))).flat();

  for (const file of files) {
    const fileStat = await stat(file);
    if (fileStat.size > maxFileSizeBytes) continue;

    const text = await readFile(file, 'utf8');
    for (const [pattern, label] of forbiddenSourcePatterns) {
      const match = pattern.exec(text);
      if (match) {
        issues.push({
          path: file,
          line: lineNumberForIndex(text, match.index),
          message: `${label}: ${match[0]}`,
        });
      }
    }
  }
}

async function checkPackageDependencies(issues) {
  for (const path of packageJsonPaths) {
    if (!(await exists(path))) continue;
    const packageJson = await readJson(path);
    const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies'];

    for (const group of dependencyGroups) {
      const dependencies = packageJson[group] ?? {};
      for (const name of Object.keys(dependencies)) {
        if (forbiddenPackages.has(name)) {
          issues.push({
            path,
            line: 1,
            message: `forbidden network-capable dependency in ${group}: ${name}`,
          });
        }
      }
    }
  }
}

async function checkCargoDependencies(issues) {
  const text = await readFile(cargoTomlPath, 'utf8');
  for (const crateName of ['reqwest', 'ureq', 'hyper', 'tungstenite', 'tokio-tungstenite']) {
    const pattern = new RegExp(`^\\s*${crateName}\\s*=`, 'm');
    const match = pattern.exec(text);
    if (match) {
      issues.push({
        path: cargoTomlPath,
        line: lineNumberForIndex(text, match.index),
        message: `forbidden network-capable Rust dependency: ${crateName}`,
      });
    }
  }
}

async function checkTauriConfig(issues) {
  const tauriConfig = await readJson(tauriConfigPath);
  const devUrl = tauriConfig.build?.devUrl ?? '';

  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/.test(devUrl)) {
    issues.push({
      path: tauriConfigPath,
      line: 1,
      message: `build.devUrl must stay local-only, got ${devUrl || '(blank)'}`,
    });
  }

  if (tauriConfig.plugins?.updater || tauriConfig.bundle?.createUpdaterArtifacts) {
    issues.push({
      path: tauriConfigPath,
      line: 1,
      message: 'Tauri updater is enabled without an explicit privacy/network review.',
    });
  }
}

async function checkTauriCapabilities(issues) {
  const capabilities = await readJson(tauriCapabilitiesPath);
  const permissions = capabilities.permissions ?? [];

  for (const permission of permissions) {
    const value = typeof permission === 'string' ? permission : JSON.stringify(permission);
    if (/(^|:)(http|updater|websocket)\b/i.test(value)) {
      issues.push({
        path: tauriCapabilitiesPath,
        line: 1,
        message: `network-capable Tauri permission is not allowed without review: ${value}`,
      });
    }
  }
}

async function main() {
  const issues = [];

  await checkSourceFiles(issues);
  await checkPackageDependencies(issues);
  await checkCargoDependencies(issues);
  await checkTauriConfig(issues);
  await checkTauriCapabilities(issues);

  if (issues.length > 0) {
    console.error(`Privacy/network policy check failed: ${issues.length} issue(s).`);
    for (const issue of issues) {
      console.error(`FAIL ${relativeFromRepo(issue.path)}:${issue.line} ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Privacy/network policy check passed: no hidden network calls or network-capable permissions detected.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
