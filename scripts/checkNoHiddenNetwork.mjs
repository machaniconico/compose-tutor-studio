// 注意: このスクリプトはソースを正規表現で走査するヒューリスティックであり、多層防御(defense in depth)の一つにすぎない。
// 隠れたネットワーク呼び出しが存在しないことを保証するものではない。
// 正本のリリースゲートは apps/desktop/scripts/release-preflight.mjs の `validateNoHiddenNetworkCalls` である。
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Files above this size are reported as failures instead of being skipped silently.
const maxFileSizeBytes = 5 * 1024 * 1024;
const checkedExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.rs', '.css', '.html', '.svg']);
const ignoredDirs = new Set(['node_modules', 'dist', 'target', '.git', 'coverage']);

const scriptExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
// Resource attributes whose value may be a protocol-relative URL (JSX / HTML / SVG).
const resourceAttributes = '(?:src|href|srcset|poster|action|formaction|data)';

// Optional third element: only apply the pattern to files with these extensions.
const forbiddenSourcePatterns = [
  [/\bfetch\s*(?:\?\.\s*)?\(/, 'browser fetch call'],
  [/['"`]\/\/[\w[]/, 'protocol-relative URL string literal', scriptExtensions],
  [new RegExp(`\\b${resourceAttributes}\\s*=\\s*\\{?\\s*['"\`]\\s*\\/\\/[\\w[]`, 'i'), 'protocol-relative resource attribute'],
  [new RegExp(`\\bsrcset\\s*=\\s*\\{?\\s*['"\`][^'"\`]*[\\s,]\\/\\/[\\w[]`, 'i'), 'protocol-relative srcset entry'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest usage'],
  [/\bWebSocket\b/, 'WebSocket usage'],
  [/\bEventSource\b/, 'EventSource usage'],
  [/\bsendBeacon\b/, 'navigator.sendBeacon usage'],
  [/@tauri-apps\/plugin-http\b/, 'Tauri HTTP plugin import'],
  [/\b(import|require)\s*\(?\s*['"]https?:\/\//, 'remote code import'],
  [/(@import\s+(url\(\s*)?|url\(\s*)['"]?\/\//, 'protocol-relative stylesheet URL'],
  [/\b(reqwest|ureq|hyper|tungstenite|tokio-tungstenite)\b/, 'Rust networking crate usage'],
  [/\b(std::net|TcpStream|UdpSocket)\b/, 'Rust standard networking usage'],
];

const urlLiteralPattern = /https?:\/\/[^\s'"`)>]*/g;
const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
// XML namespace URLs are never fetched; allowed only as xmlns / namespaceURI values or the first createElementNS argument.
const namespaceContextPattern =
  /(?:xmlns(?::[\w-]+)?\s*=\s*\{?\s*['"`]|createElementNS\s*\(\s*['"`]|namespaceURI\s*(?:=|[!=]==?)\s*['"`])$/;

// Hosts that can never reach a real server, allowed only inside test code so tests can assert rejection:
// tauri.localhost is the Windows WebView2 bundled-asset origin, example.com (and subdomains) and *.invalid are RFC 2606 reserved.
function isTestOnlyHostname(hostname) {
  return (
    hostname === 'tauri.localhost' ||
    hostname === 'example.com' ||
    hostname.endsWith('.example.com') ||
    hostname.endsWith('.invalid')
  );
}

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
  if ((await stat(root)).isFile()) return [root];

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

function isTestFile(repoRelativePath) {
  return (
    /\.test\.[^/]+$/.test(repoRelativePath) ||
    /(^|\/)(tests?|__tests__)\//.test(repoRelativePath) ||
    /(^|\/)tests\.rs$/.test(repoRelativePath)
  );
}

// Character ranges of `#[cfg(test)] mod name { ... }` blocks in a Rust source file.
function rustTestRanges(text) {
  const ranges = [];
  for (const attribute of text.matchAll(/#\[cfg\(test\)\]/g)) {
    const open = text.indexOf('{', attribute.index);
    const semicolon = text.indexOf(';', attribute.index);
    if (open === -1 || (semicolon !== -1 && semicolon < open)) continue;
    if (!/^\s*(pub\s+)?mod\s+\w+\s*$/.test(text.slice(attribute.index + attribute[0].length, open))) continue;
    let depth = 0;
    let end = text.length;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1;
      if (text[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    ranges.push([open, end]);
  }
  return ranges;
}

function checkUrlLiterals(repoRelativePath, text, issues) {
  const testFile = isTestFile(repoRelativePath);
  const testRanges = extension(repoRelativePath) === '.rs' ? rustTestRanges(text) : [];

  for (const match of text.matchAll(urlLiteralPattern)) {
    let hostname;
    try {
      hostname = new URL(match[0]).hostname;
    } catch {
      issues.push({ path: repoRelativePath, line: lineNumberForIndex(text, match.index), message: `unparseable URL literal in source: ${match[0]}` });
      continue;
    }
    if (localHostnames.has(hostname)) continue;
    if (
      hostname === 'www.w3.org' &&
      match[0].startsWith('http://') &&
      namespaceContextPattern.test(text.slice(Math.max(0, match.index - 80), match.index))
    ) {
      continue;
    }
    const inTest = testFile || testRanges.some(([start, end]) => match.index > start && match.index < end);
    if (inTest && isTestOnlyHostname(hostname)) continue;
    issues.push({
      path: repoRelativePath,
      line: lineNumberForIndex(text, match.index),
      message: `non-local URL literal in source: ${match[0]}`,
    });
  }
}

async function checkSourceFiles(repoRoot, issues) {
  const studioRoot = join(repoRoot, 'apps', 'studio');
  const sourceRoots = [
    join(studioRoot, 'src'),
    join(studioRoot, 'public'),
    join(studioRoot, 'index.html'),
    join(repoRoot, 'apps', 'desktop', 'src-tauri', 'src'),
    join(repoRoot, 'packages'),
  ];
  const files = (await Promise.all(sourceRoots.map((root) => listFiles(root)))).flat();

  for (const file of files) {
    const repoRelativePath = relative(repoRoot, file).replaceAll('\\', '/');
    const fileStat = await stat(file);
    if (fileStat.size > maxFileSizeBytes) {
      issues.push({ path: repoRelativePath, line: 1, message: `file exceeds the ${maxFileSizeBytes} byte scan limit` });
      continue;
    }

    const text = await readFile(file, 'utf8');
    for (const [pattern, label, onlyExtensions] of forbiddenSourcePatterns) {
      if (onlyExtensions && !onlyExtensions.has(extension(file))) continue;
      const match = pattern.exec(text);
      if (match) {
        issues.push({
          path: repoRelativePath,
          line: lineNumberForIndex(text, match.index),
          message: `${label}: ${match[0]}`,
        });
      }
    }
    checkUrlLiterals(repoRelativePath, text, issues);
  }
}

async function checkPackageDependencies(repoRoot, issues) {
  const packageDirs = [join(repoRoot, 'apps', 'studio'), join(repoRoot, 'apps', 'desktop')];
  if (await exists(join(repoRoot, 'packages'))) {
    for (const entry of await readdir(join(repoRoot, 'packages'), { withFileTypes: true })) {
      if (entry.isDirectory()) packageDirs.push(join(repoRoot, 'packages', entry.name));
    }
  }
  const packageJsonPaths = [join(repoRoot, 'package.json'), ...packageDirs.map((dir) => join(dir, 'package.json'))];

  for (const path of packageJsonPaths) {
    if (!(await exists(path))) continue;
    const packageJson = await readJson(path);
    const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies'];

    for (const group of dependencyGroups) {
      const dependencies = packageJson[group] ?? {};
      for (const name of Object.keys(dependencies)) {
        if (forbiddenPackages.has(name)) {
          issues.push({
            path: relative(repoRoot, path).replaceAll('\\', '/'),
            line: 1,
            message: `forbidden network-capable dependency in ${group}: ${name}`,
          });
        }
      }
    }
  }
}

async function checkCargoDependencies(repoRoot, issues) {
  const cargoTomlPath = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
  if (!(await exists(cargoTomlPath))) return;
  const text = await readFile(cargoTomlPath, 'utf8');
  for (const crateName of ['reqwest', 'ureq', 'hyper', 'tungstenite', 'tokio-tungstenite']) {
    const pattern = new RegExp(`^\\s*${crateName}\\s*=`, 'm');
    const match = pattern.exec(text);
    if (match) {
      issues.push({
        path: relative(repoRoot, cargoTomlPath).replaceAll('\\', '/'),
        line: lineNumberForIndex(text, match.index),
        message: `forbidden network-capable Rust dependency: ${crateName}`,
      });
    }
  }
}

async function checkTauriConfig(repoRoot, issues) {
  const tauriConfigPath = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
  if (!(await exists(tauriConfigPath))) return;
  const path = relative(repoRoot, tauriConfigPath).replaceAll('\\', '/');
  const tauriConfig = await readJson(tauriConfigPath);
  const devUrl = tauriConfig.build?.devUrl ?? '';

  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/.test(devUrl)) {
    issues.push({ path, line: 1, message: `build.devUrl must stay local-only, got ${devUrl || '(blank)'}` });
  }

  if (tauriConfig.plugins?.updater || tauriConfig.bundle?.createUpdaterArtifacts) {
    issues.push({ path, line: 1, message: 'Tauri updater is enabled without an explicit privacy/network review.' });
  }
}

async function checkTauriCapabilities(repoRoot, issues) {
  const capabilitiesDir = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'capabilities');
  if (!(await exists(capabilitiesDir))) return;

  for (const entry of await readdir(capabilitiesDir, { withFileTypes: true })) {
    if (!entry.isFile() || extension(entry.name) !== '.json') continue;
    const path = relative(repoRoot, join(capabilitiesDir, entry.name)).replaceAll('\\', '/');
    const capabilities = await readJson(join(capabilitiesDir, entry.name));

    if (capabilities.remote) {
      issues.push({ path, line: 1, message: 'remote capability URLs are not allowed without review' });
    }

    for (const permission of capabilities.permissions ?? []) {
      const identifier = typeof permission === 'string' ? permission : permission?.identifier;
      if (typeof identifier !== 'string') {
        issues.push({ path, line: 1, message: `permission entry without a string identifier: ${JSON.stringify(permission)}` });
        continue;
      }
      if (/(^|:)(http|updater|websocket)\b/i.test(identifier)) {
        issues.push({ path, line: 1, message: `network-capable Tauri permission is not allowed without review: ${identifier}` });
      }
    }
  }
}

export async function checkNoHiddenNetwork(repoRoot = defaultRepoRoot) {
  const issues = [];

  await checkSourceFiles(repoRoot, issues);
  await checkPackageDependencies(repoRoot, issues);
  await checkCargoDependencies(repoRoot, issues);
  await checkTauriConfig(repoRoot, issues);
  await checkTauriCapabilities(repoRoot, issues);

  return issues;
}

async function main() {
  const issues = await checkNoHiddenNetwork();

  if (issues.length > 0) {
    console.error(`Privacy/network policy check failed: ${issues.length} issue(s).`);
    for (const issue of issues) {
      console.error(`FAIL ${issue.path}:${issue.line} ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Privacy/network policy check passed: no hidden network calls or network-capable permissions detected.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
