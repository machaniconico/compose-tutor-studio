import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = path.resolve(path.dirname(scriptPath), '..');
const defaultRepoRoot = path.resolve(desktopDir, '..', '..');
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/i;
const testOnlyMarkers = [
  'WDIO_EMBEDDED_SERVER',
  'CTS_NATIVE_TEST_CLOSE_GRACE_MS',
  'CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_PATH',
  'CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_TOKEN',
  'cts-native-e2e-close-request',
  'tauri-plugin-wdio-webdriver',
  'tauri_plugin_wdio_webdriver',
  'com.composetutor.studio.test',
];
const allowedLicenseIds = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Unicode-3.0',
  'Unlicense',
  'Zlib',
]);
const allowedLicenseExceptions = new Set(['LLVM-exception']);
const releaseLimits = {
  linux: 512 * 1024 * 1024,
  macos: 128 * 1024 * 1024,
  windows: 128 * 1024 * 1024,
};
const productionCsp = Object.freeze({
  'default-src': "'self'",
  'base-uri': "'none'",
  'object-src': "'none'",
  'form-action': "'none'",
  'frame-src': "'none'",
  'frame-ancestors': "'none'",
  'script-src': "'self'",
  'style-src': "'self' 'unsafe-inline'",
  'img-src': "'self' data: blob:",
  'font-src': "'self' data:",
  'media-src': "'self' data: blob:",
  'worker-src': "'self' blob:",
  'connect-src': 'ipc: http://ipc.localhost https://ipc.localhost',
});
const developmentCsp = Object.freeze({
  'default-src': "'self'",
  'base-uri': "'none'",
  'object-src': "'none'",
  'form-action': "'none'",
  'frame-src': "'none'",
  'frame-ancestors': "'none'",
  'script-src': "'self' 'unsafe-eval'",
  'style-src': "'self' 'unsafe-inline'",
  'img-src': "'self' data: blob:",
  'font-src': "'self' data:",
  'media-src': "'self' data: blob:",
  'worker-src': "'self' blob:",
  'connect-src': "'self' ipc: http://ipc.localhost https://ipc.localhost ws://127.0.0.1:5173",
});
const productionCapabilityPermissions = Object.freeze([
  'allow-audio-asset-store',
  'allow-audio-asset-read',
  'allow-audio-asset-verify',
  'allow-persistence-initialize',
  'allow-persistence-list',
  'allow-persistence-load',
  'allow-persistence-get-project-state',
  'allow-persistence-load-branch',
  'allow-persistence-load-most-recent',
  'allow-persistence-stage-crash-draft',
  'allow-persistence-save',
  'allow-persistence-remove',
  'allow-persistence-get-legacy-migration-status',
  'allow-persistence-backup-legacy-snapshot',
  'allow-persistence-import-legacy-project',
  'allow-persistence-complete-legacy-migration',
  'allow-persistence-get-erase-all-status',
  'allow-persistence-prepare-erase-all',
  'allow-persistence-complete-erase-all',
  'allow-file-open-project',
  'allow-file-open-midi',
  'allow-file-open-audio',
  'allow-file-export-project',
  'allow-file-export-midi',
  'allow-file-export-wav',
  'allow-app-claim-close-request',
  'allow-app-finish-close',
  'core:webview:allow-clear-all-browsing-data',
  'core:event:allow-listen',
  'core:event:allow-unlisten',
]);
const productionCargoManifestIdentity = Object.freeze({
  packageBuild: undefined,
  packageAutobins: undefined,
  packageAutoexamples: undefined,
  packageAutotests: undefined,
  packageAutobenches: undefined,
  packageDefaultRun: undefined,
  lib: {
    name: 'compose_tutor_studio_desktop_lib',
    'crate-type': ['staticlib', 'cdylib', 'rlib'],
  },
  bin: undefined,
  example: undefined,
  test: undefined,
  bench: undefined,
  features: {
    'native-test': ['dep:tauri-plugin-wdio-webdriver'],
  },
  dependencies: {
    atomicwrites: '=0.4.4',
    crc32fast: '=1.5.0',
    fs4: { version: '=1.1.0', 'default-features': false, features: ['sync'] },
    rusqlite: { version: '=0.40.1', 'default-features': false, features: ['bundled'] },
    serde: { version: '=1.0.228', features: ['derive'] },
    serde_json: '=1.0.150',
    sha2: '=0.10.9',
    tauri: { version: '2.11.5', features: [] },
    'tauri-plugin-dialog': {
      version: '=2.7.1',
      'default-features': false,
      features: ['gtk3'],
    },
    'tauri-plugin-wdio-webdriver': { version: '1.2.0', optional: true },
    thiserror: '=2.0.18',
  },
  buildDependencies: {
    'tauri-build': { version: '2.6.3', features: [] },
  },
  target: {
    'cfg(unix)': { dependencies: { libc: '=0.2.186' } },
    'cfg(target_os = "linux")': {
      dependencies: {
        webkit2gtk: { version: '=2.0.2', features: ['v2_40'] },
      },
    },
    'cfg(windows)': {
      dependencies: {
        'windows-sys': {
          version: '=0.61.2',
          features: ['Win32_Foundation', 'Win32_Storage_FileSystem'],
        },
      },
    },
  },
  patch: undefined,
  replace: undefined,
  workspaceDependencies: undefined,
});
const allowedLibcSymbols = new Set([
  'O_DIRECTORY',
  'O_NOFOLLOW',
  'S_IFMT',
  'S_IFREG',
  'c_int',
  'fstat',
  'stat',
]);
const allowedWindowsSysPrefixes = Object.freeze([
  'Win32::Foundation',
  'Win32::Storage::FileSystem',
]);
const forbiddenRendererNetworkGlobals = new Set([
  'EventSource',
  'RTCDataChannel',
  'RTCPeerConnection',
  'SharedWorker',
  'Worker',
  'WebSocket',
  'WebTransport',
  'XMLHttpRequest',
  'fetch',
  'importScripts',
  'sendBeacon',
  'serviceWorker',
  'webkitRTCPeerConnection',
]);
const rendererSourceExtensions = Object.freeze([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
const allowedBuiltRemoteUrls = Object.freeze([
  'http://ipc.localhost',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/XML/1998/namespace',
  'https://ipc.localhost',
  'https://react.dev/errors/',
]);
const productionRootPackageIdentity = Object.freeze({
  name: 'compose-tutor-studio',
  private: true,
  description:
    'Education-integrated composition app: learn chords, scales, and song structure while making an 8-16 bar original song.',
  scripts: {
    dev: 'pnpm --dir apps/studio dev',
    'dev:desktop': 'pnpm --dir apps/desktop dev',
    build: 'pnpm -r build',
    'desktop:check': 'pnpm --dir apps/desktop check:rust',
    'desktop:test': 'pnpm --dir apps/desktop test:rust',
    'desktop:lint': 'pnpm --dir apps/desktop lint:rust',
    'desktop:typecheck:native': 'pnpm --dir apps/desktop typecheck:native',
    'desktop:test:size': 'pnpm --dir apps/desktop test:size',
    'desktop:test:release-policy': 'pnpm --dir apps/desktop test:release-policy',
    'desktop:size:check': 'pnpm --dir apps/desktop size:check',
    'desktop:e2e:native': 'pnpm --dir apps/desktop e2e:native',
    'desktop:build:smoke': 'pnpm --dir apps/desktop build:smoke',
    'desktop:build:bundle': 'pnpm --dir apps/desktop build:bundle',
    'docs:combine': 'node scripts/generate-combined-spec.mjs',
    'docs:combine:check': 'node scripts/generate-combined-spec.mjs --check',
    e2e: 'pnpm --dir apps/studio e2e',
    test: 'pnpm --workspace-concurrency=2 -r test --maxWorkers=2',
    typecheck: 'pnpm --workspace-concurrency=2 -r typecheck',
    verify: 'pnpm typecheck && pnpm test && pnpm build && pnpm e2e',
    'verify:desktop':
      'pnpm desktop:lint && pnpm desktop:test && pnpm desktop:typecheck:native && pnpm desktop:test:size && pnpm desktop:test:release-policy && pnpm desktop:e2e:native && pnpm desktop:build:smoke && pnpm desktop:size:check',
  },
  packageManager: 'pnpm@11.13.1',
  devDependencies: {
    typescript: '^5.8.0',
    vitest: '^3.1.0',
  },
});
const productionStudioPackageIdentity = Object.freeze({
  name: '@cts/studio',
  private: true,
  type: 'module',
  scripts: {
    dev: 'vite',
    build:
      'tsc --noEmit && vite build --config vite.config.ts && node ../desktop/scripts/release-preflight.mjs renderer-assets --input dist --profile production',
    'build:e2e':
      'tsc --noEmit && vite build --config vite.config.ts --mode e2e && node ../desktop/scripts/release-preflight.mjs renderer-assets --input test-results/e2e-build --profile e2e',
    e2e: 'playwright test && pnpm e2e:fatal',
    'e2e:fatal': 'pnpm build:e2e && playwright test --config playwright.fatal.config.ts',
    'e2e:ui': 'playwright test --ui',
    preview: 'vite preview',
    test: 'vitest run',
    typecheck: 'tsc --noEmit && tsc -p tsconfig.e2e.json --noEmit',
  },
  dependencies: {
    '@cts/midi-io': 'workspace:*',
    '@cts/project-model': 'workspace:*',
    '@cts/project-persistence': 'workspace:*',
    '@cts/theory-engine': 'workspace:*',
    '@cts/tutorial-engine': 'workspace:*',
    '@tauri-apps/api': '2.11.1',
    react: '^19.1.0',
    'react-dom': '^19.1.0',
    zustand: '^5.0.0',
  },
  devDependencies: {
    '@playwright/test': '1.61.1',
    '@types/node': '^20.19.43',
    '@types/react': '^19.1.0',
    '@types/react-dom': '^19.1.0',
    '@vitejs/plugin-react': '^5.0.0',
    typescript: '^5.8.0',
    vite: '^7.0.0',
    vitest: '^3.1.0',
  },
});
const productionDesktopPackageIdentity = Object.freeze({
  name: '@cts/desktop',
  private: true,
  scripts: {
    dev: 'tauri dev',
    'typecheck:native': 'tsc -p tsconfig.json --noEmit',
    'test:size': 'node --test scripts/check-size.test.mjs',
    'test:release-policy': 'node --test scripts/release-preflight.test.mjs',
    'size:check': 'node scripts/check-size.mjs',
    'check:rust': 'cargo check --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked',
    'test:rust': 'cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked',
    'lint:rust':
      'cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings',
    'build:smoke':
      'tauri build --no-bundle --ci && node scripts/release-preflight.mjs renderer-assets --input ../studio/dist --profile production',
    'build:bundle':
      'tauri build --ci && node scripts/release-preflight.mjs renderer-assets --input ../studio/dist --profile production',
    'build:native-test': 'node scripts/native-test.mjs --build-only',
    'e2e:native': 'node scripts/native-test.mjs',
    icon: 'tauri icon src-tauri/app-icon.svg --output src-tauri/icons',
  },
  devDependencies: {
    '@tauri-apps/cli': '2.11.4',
    '@types/mocha': '10.0.10',
    '@types/node': '^20.19.43',
    '@wdio/cli': '9.27.1',
    '@wdio/globals': '9.27.1',
    '@wdio/local-runner': '9.27.1',
    '@wdio/mocha-framework': '9.27.1',
    '@wdio/native-types': '2.4.0',
    '@wdio/spec-reporter': '9.27.1',
    '@wdio/tauri-service': '1.2.0',
    '@wdio/types': '9.27.1',
    'smol-toml': '1.7.0',
    typescript: '^5.8.0',
    webdriverio: '9.27.1',
  },
});

function libraryPackageIdentity(name, dependencies) {
  return {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    exports: { '.': './src/index.ts' },
    scripts: {
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
      build: 'tsc --noEmit',
    },
    ...(dependencies ? { dependencies } : {}),
    devDependencies: {
      typescript: '^5.8.0',
      vitest: '^3.1.0',
    },
  };
}

const productionLibraryPackageIdentities = Object.freeze({
  'packages/midi-io/package.json': libraryPackageIdentity('@cts/midi-io', {
    '@cts/project-model': 'workspace:*',
  }),
  'packages/project-model/package.json': libraryPackageIdentity('@cts/project-model'),
  'packages/project-persistence/package.json': libraryPackageIdentity('@cts/project-persistence', {
    '@cts/project-model': 'workspace:*',
  }),
  'packages/theory-engine/package.json': libraryPackageIdentity('@cts/theory-engine'),
  'packages/tutorial-engine/package.json': libraryPackageIdentity('@cts/tutorial-engine', {
    '@cts/project-model': 'workspace:*',
  }),
});
const productionBuildIdentity = Object.freeze({
  frontendDist: '../../studio/dist',
  beforeBuildCommand: 'pnpm --dir ../studio build',
  beforeBundleCommand: undefined,
  runner: undefined,
  features: undefined,
  removeUnusedCommands: true,
});
const productionBundleIdentity = Object.freeze({
  active: true,
  targets: 'all',
  createUpdaterArtifacts: false,
  category: 'Music',
  shortDescription: 'Learn music theory while composing an original song.',
  longDescription: 'A beginner-friendly composition studio with integrated music theory tutorials.',
  icon: [
    'icons/32x32.png',
    'icons/128x128.png',
    'icons/128x128@2x.png',
    'icons/icon.icns',
    'icons/icon.ico',
  ],
  windows: {
    minimumWebview2Version: '105.0.1343.25',
  },
  macOS: {
    minimumSystemVersion: '12.4',
    hardenedRuntime: true,
    entitlements: 'Entitlements.plist',
    infoPlist: 'Info.plist',
  },
  linux: {
    appimage: {
      bundleMediaFramework: true,
    },
  },
});
const forbiddenTauriConfigNames = Object.freeze([
  'Tauri.linux.toml',
  'Tauri.macos.toml',
  'Tauri.toml',
  'Tauri.windows.toml',
  'tauri.linux.conf.json',
  'tauri.linux.conf.json5',
  'tauri.macos.conf.json',
  'tauri.macos.conf.json5',
  'tauri.conf.json5',
  'tauri.windows.conf.json',
  'tauri.windows.conf.json5',
]);
const forbiddenCargoConfigPaths = Object.freeze([
  '.cargo/config',
  '.cargo/config.toml',
  'apps/.cargo/config',
  'apps/.cargo/config.toml',
  'apps/desktop/.cargo/config',
  'apps/desktop/.cargo/config.toml',
  'apps/desktop/src-tauri/.cargo/config',
  'apps/desktop/src-tauri/.cargo/config.toml',
]);
const alternateViteConfigNames = Object.freeze([
  'vite.config.cjs',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.jsx',
  'vite.config.mjs',
  'vite.config.mts',
]);
const postcssConfigNames = Object.freeze([
  '.postcssrc',
  '.postcssrc.cjs',
  '.postcssrc.cts',
  '.postcssrc.js',
  '.postcssrc.json',
  '.postcssrc.mjs',
  '.postcssrc.mts',
  '.postcssrc.ts',
  '.postcssrc.yaml',
  '.postcssrc.yml',
  'postcss.config.cjs',
  'postcss.config.cts',
  'postcss.config.js',
  'postcss.config.mjs',
  'postcss.config.mts',
  'postcss.config.ts',
]);
const forbiddenPostcssConfigPaths = Object.freeze([
  'apps/package.json',
  ...['', 'apps', 'apps/studio'].flatMap((directory) =>
    postcssConfigNames.map((name) => (directory ? `${directory}/${name}` : name)),
  ),
]);
const forbiddenPnpmConfigPaths = Object.freeze([
  '.npmrc',
  '.pnpmrc',
  '.pnpmfile.cjs',
  '.pnpmfile.js',
  'pnpmfile.cjs',
  'apps/.npmrc',
  'apps/.pnpmfile.cjs',
  'apps/desktop/.npmrc',
  'apps/desktop/.pnpmfile.cjs',
  'apps/studio/.npmrc',
  'apps/studio/.pnpmfile.cjs',
  'packages/.npmrc',
  'packages/.pnpmfile.cjs',
  ...Object.keys(productionLibraryPackageIdentities).flatMap((manifestPath) => {
    const packageRoot = path.dirname(manifestPath);
    return [`${packageRoot}/.npmrc`, `${packageRoot}/.pnpmfile.cjs`];
  }),
]);
const productionViteConfigSha256 =
  '459066c044ee244af72e720aaca9cbb59d7c90b469e84fee8ac784e9348c841b';
const productionBuildScriptSha256 =
  'fa2a85733d26d47475bce20bea09227d2d3e1691ac0acc8770f4c977afd0e3be';
const productionPnpmWorkspaceSha256 =
  'e4e2e1627c84ee9d6115222d07c5d3e9dd15c6412196602942cdb7131bdb6b6d';
const productionPnpmLockSha256 =
  '3fb7ac10607b7a777db9f94fffd5d3eebeaba88ecabbfe6a68b8bdacb42934e8';
const productionInfoPlistSha256 =
  '33fe001fcd59ffb037152843f269503897cf1fad46b22a569dd2e78f96380dbf';
const productionEntitlementsSha256 =
  '289696af9834a7ee41aca4c1cd3aa95fc38f9ae2e83655b1d4b86c1ccab771ee';
const productionRedirectsSource = `# Cloudflare Pages SPA fallback.
# Compose Tutor Studio は単一ページ (クライアントルーターなし) なので、
# 未知のパスは常に index.html を 200 で返してアプリを起動させる。
/*    /index.html   200
`;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command) fail('A command is required');
  const flags = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = rest[index + 1];
    if (!name || next === undefined || next.startsWith('--')) {
      fail(`Flag --${name || '<empty>'} requires a value`);
    }
    if (Object.hasOwn(flags, name)) fail(`Flag --${name} was provided more than once`);
    flags[name] = next;
    index += 1;
  }
  return { command, flags, positional };
}

function requiredFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) fail(`--${name} is required`);
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireExact(label, actual, expected) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label} does not match the production security allowlist`);
  }
}

function normalizedTextSha256(source) {
  return createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex');
}

async function requirePinnedTextFile(filePath, expectedSha256, label) {
  let fileState;
  try {
    fileState = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} is missing`);
    throw error;
  }
  if (!fileState.isFile() || fileState.isSymbolicLink()) {
    fail(`${label} must remain a regular reviewed build input`);
  }
  const source = await readFile(filePath, 'utf8');
  if (normalizedTextSha256(source) !== expectedSha256) {
    fail(`${label} does not match the reviewed production build input`);
  }
  return source;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

async function sourceFiles(root, extensions) {
  const files = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`Production source must not contain symlinks: ${target}`);
      } else if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push(target);
      }
    }
  };
  await visit(root);
  return files.sort();
}

function validateNoRemoteNavigationMarkup(source, label) {
  if (/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b/i.test(source)) {
    fail(`${label} must not contain a meta refresh navigation`);
  }
  if (
    /["'`]\s*\/\/[A-Za-z0-9]/.test(source) ||
    /\b(?:href|src|action|formaction)\s*=\s*\/\/[A-Za-z0-9]/i.test(source) ||
    /\burl\s*\(\s*["']?\s*\/\/[A-Za-z0-9]/i.test(source)
  ) {
    fail(`${label} must not contain a protocol-relative remote URL`);
  }
}

async function requirePinnedPublicDirectory(rootDir) {
  const publicRoot = path.join(rootDir, 'apps/studio/public');
  const files = await walkFiles(publicRoot, { maxEntries: 100 });
  const relativeFiles = files
    .map((filePath) => path.relative(publicRoot, filePath).split(path.sep).join('/'))
    .sort();
  requireExact('Studio production public directory', relativeFiles, ['_redirects']);
  const redirectsPath = path.join(publicRoot, '_redirects');
  const redirectsState = await lstat(redirectsPath);
  if (!redirectsState.isFile() || redirectsState.isSymbolicLink()) {
    fail('apps/studio/public/_redirects must remain a regular reviewed deployment input');
  }
  const redirectsSource = (await readFile(redirectsPath, 'utf8')).replaceAll('\r\n', '\n');
  if (redirectsSource !== productionRedirectsSource) {
    fail('apps/studio/public/_redirects does not match the production deployment allowlist');
  }
}

async function requirePinnedPnpmWorkspace(rootDir) {
  await Promise.all([
    requirePinnedTextFile(
      path.join(rootDir, 'pnpm-workspace.yaml'),
      productionPnpmWorkspaceSha256,
      'pnpm-workspace.yaml',
    ),
    requirePinnedTextFile(
      path.join(rootDir, 'pnpm-lock.yaml'),
      productionPnpmLockSha256,
      'pnpm-lock.yaml',
    ),
  ]);
  for (const relativePath of forbiddenPnpmConfigPaths) {
    try {
      await lstat(path.join(rootDir, relativePath));
      fail(`${relativePath} is forbidden because it can rewrite the pnpm dependency graph`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const discoveredManifests = [];
  for (const parentName of ['apps', 'packages']) {
    const parentRoot = path.join(rootDir, parentName);
    for (const entry of await readdir(parentRoot, { withFileTypes: true })) {
      const packageRoot = path.join(parentRoot, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`Production workspace package roots must not be symlinks: ${packageRoot}`);
      }
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(packageRoot, 'package.json');
      try {
        const manifestState = await lstat(manifestPath);
        if (!manifestState.isFile() || manifestState.isSymbolicLink()) {
          fail(`Production workspace manifest must be a regular file: ${manifestPath}`);
        }
        discoveredManifests.push(
          path.relative(rootDir, manifestPath).split(path.sep).join('/'),
        );
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  const expectedManifests = [
    'apps/desktop/package.json',
    'apps/studio/package.json',
    ...Object.keys(productionLibraryPackageIdentities),
  ].sort();
  requireExact(
    'Production pnpm workspace package inventory',
    discoveredManifests.sort(),
    expectedManifests,
  );
  for (const [relativePath, identity] of Object.entries(productionLibraryPackageIdentities)) {
    requireExact(
      `Production workspace manifest ${relativePath}`,
      await readJson(path.join(rootDir, relativePath)),
      identity,
    );
  }
}

function validateProductionIndexHtml(source, label) {
  const scripts = source.match(/<script\b[\s\S]*?<\/script\s*>/gi) ?? [];
  if (
    scripts.length !== 1 ||
    !/^<script\s+type=["']module["']\s+src=["']\/src\/main\.tsx["']\s*>\s*<\/script\s*>$/i.test(
      scripts[0],
    )
  ) {
    fail(`${label} must load only the reviewed /src/main.tsx module entry`);
  }
  if (/<base\b|\bon\w+\s*=|\bjavascript:|\b(?:https?|wss?|stun|turn|turns):/i.test(source)) {
    fail(`${label} contains a forbidden executable or remote entry`);
  }
  validateNoRemoteNavigationMarkup(source, label);
}

function reviewedBuiltModuleEntry(source, label, expectedEntryNames) {
  validateNoRemoteNavigationMarkup(source, label);
  const scripts = source.match(/<script\b[\s\S]*?<\/script\s*>/gi) ?? [];
  const entryNames = expectedEntryNames.join('|');
  const entryPattern = new RegExp(
    `^<script\\s+type=["']module["']\\s+crossorigin\\s+src=["']\\/(assets\\/(?:${entryNames})-[A-Za-z0-9_-]+\\.js)["']\\s*>\\s*<\\/script\\s*>$`,
    'i',
  );
  const entryMatch = scripts.length === 1 ? entryPattern.exec(scripts[0]) : null;
  if (!entryMatch) {
    fail(`${label} must contain exactly one reviewed local module entry`);
  }
  return entryMatch[1];
}

export async function validateBuiltRendererAssets({ distDir, profile } = {}) {
  if (typeof distDir !== 'string' || !path.isAbsolute(distDir)) {
    fail('renderer-assets requires an absolute dist directory');
  }
  if (!['production', 'e2e'].includes(profile)) {
    fail(`Unsupported renderer-assets profile: ${profile}`);
  }
  const indexPath = path.join(distDir, 'index.html');
  const indexSource = await readFile(indexPath, 'utf8');
  const indexEntry = reviewedBuiltModuleEntry(
    indexSource,
    'Built renderer index.html',
    profile === 'production' ? ['index'] : ['app'],
  );

  const files = await walkFiles(distDir, { maxEntries: 2_000 });
  const relativeFiles = files.map((filePath) =>
    path.relative(distDir, filePath).split(path.sep).join('/'),
  );
  const htmlFiles = relativeFiles
    .filter((relativePath) => path.extname(relativePath).toLowerCase() === '.html')
    .sort();
  const expectedHtmlFiles =
    profile === 'production'
      ? ['index.html']
      : ['e2e/fixtures/fatal-boundary.html', 'index.html'];
  requireExact('Built renderer HTML inventory', htmlFiles, expectedHtmlFiles);
  const reviewedEntries = [indexEntry];
  if (profile === 'e2e') {
    const fatalFixturePath = path.join(distDir, 'e2e/fixtures/fatal-boundary.html');
    reviewedEntries.push(
      reviewedBuiltModuleEntry(
        await readFile(fatalFixturePath, 'utf8'),
        'Built renderer fatal-boundary fixture',
        ['fatal-boundary'],
      ),
    );
  }
  for (const entry of reviewedEntries) {
    if (!relativeFiles.includes(entry)) {
      fail(`Built renderer module entry is missing: ${entry}`);
    }
  }
  if (!relativeFiles.includes('_redirects')) {
    fail('Built renderer is missing the reviewed _redirects deployment input');
  }
  let inspectedBytes = 0;
  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();
    const relativePath = path.relative(distDir, filePath).split(path.sep).join('/');
    if (extension === '') {
      if (relativePath !== '_redirects') {
        fail(`Built renderer contains an unreviewed extensionless file: ${relativePath}`);
      }
      const redirectsSource = (await readFile(filePath, 'utf8')).replaceAll('\r\n', '\n');
      if (redirectsSource !== productionRedirectsSource) {
        fail('Built renderer _redirects does not match the production deployment allowlist');
      }
      inspectedBytes += Buffer.byteLength(redirectsSource);
      continue;
    }
    if (!['.css', '.html', '.js'].includes(extension)) {
      fail(`Built renderer contains an unreviewed file type: ${relativePath}`);
    }
    const fileState = await stat(filePath);
    inspectedBytes += fileState.size;
    if (fileState.size > 16 * 1024 * 1024 || inspectedBytes > 64 * 1024 * 1024) {
      fail('Built renderer source exceeds the release inspection budget');
    }
    const source = await readFile(filePath, 'utf8');
    if (extension === '.html') {
      validateNoRemoteNavigationMarkup(source, `Built renderer ${relativePath}`);
    }
    const forbidden = /\b(?:EventSource|RTCDataChannel|RTCPeerConnection|WebSocket|WebTransport|XMLHttpRequest|importScripts|sendBeacon|webkitRTCPeerConnection)\b|\b(?:SharedWorker|Worker)\s*\(|\bnavigator\s*(?:\.\s*serviceWorker|\[\s*["']serviceWorker["']\s*\])|\b(?:stun|turn|turns):/i.exec(
      source,
    );
    if (forbidden) {
      fail(
        `Built renderer contains a forbidden network primitive in ${relativePath}: ${forbidden[0]}`,
      );
    }
    if (
      /["'`]\s*\/\/[A-Za-z0-9]/.test(source) ||
      /\burl\s*\(\s*["']?\s*\/\/[A-Za-z0-9]/i.test(source)
    ) {
      fail(`Built renderer contains a protocol-relative remote URL in ${relativePath}`);
    }
    for (const match of source.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`<>()\\]+/gi)) {
      if (
        !allowedBuiltRemoteUrls.some(
          (allowed) => match[0] === allowed || (allowed.endsWith('/') && match[0].startsWith(allowed)),
        )
        ) {
        fail(
          `Built renderer contains an unreviewed remote URL in ${relativePath}: ${match[0]}`,
        );
      }
    }
  }
  return { files: files.length, inspectedBytes };
}

export async function validateNoHiddenNetworkCalls({ rootDir = defaultRepoRoot } = {}) {
  const [importedTypeScript, importedToml] = await Promise.all([
    import('typescript'),
    import('smol-toml'),
  ]);
  const ts = importedTypeScript.default ?? importedTypeScript;
  const cargoPath = path.join(rootDir, 'apps/desktop/src-tauri/Cargo.toml');
  let cargoManifest;
  try {
    cargoManifest = importedToml.parse(await readFile(cargoPath, 'utf8'));
  } catch {
    fail('Cargo.toml must remain valid TOML before its security policy can be checked');
  }
  requireExact(
    'Cargo production manifest identity',
    {
      packageBuild: cargoManifest.package?.build,
      packageAutobins: cargoManifest.package?.autobins,
      packageAutoexamples: cargoManifest.package?.autoexamples,
      packageAutotests: cargoManifest.package?.autotests,
      packageAutobenches: cargoManifest.package?.autobenches,
      packageDefaultRun: cargoManifest.package?.['default-run'],
      lib: cargoManifest.lib,
      bin: cargoManifest.bin,
      example: cargoManifest.example,
      test: cargoManifest.test,
      bench: cargoManifest.bench,
      features: cargoManifest.features,
      dependencies: cargoManifest.dependencies,
      buildDependencies: cargoManifest['build-dependencies'],
      target: cargoManifest.target,
      patch: cargoManifest.patch,
      replace: cargoManifest.replace,
      workspaceDependencies: cargoManifest.workspace?.dependencies,
    },
    productionCargoManifestIdentity,
  );
  await requirePinnedPublicDirectory(rootDir);
  await requirePinnedViteConfig(rootDir);

  const typescriptRoots = [
    path.join(rootDir, 'apps/studio/src'),
    path.join(rootDir, 'apps/studio/public'),
  ];
  const packagesRoot = path.join(rootDir, 'packages');
  let packageEntries = [];
  try {
    packageEntries = await readdir(packagesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of packageEntries) {
    if (entry.isSymbolicLink()) {
      fail(`Production package source roots must not be symlinks: ${path.join(packagesRoot, entry.name)}`);
    }
    if (entry.isDirectory()) typescriptRoots.push(path.join(packagesRoot, entry.name, 'src'));
  }
  const rustRoot = path.join(rootDir, 'apps/desktop/src-tauri/src');
  const forbiddenModules = new Set([
    'axios',
    'got',
    'http',
    'https',
    'node:http',
    'node:https',
    'undici',
    'ws',
  ]);
  const typescriptFiles = (
    await Promise.all(
      typescriptRoots.map(async (sourceRoot) =>
        (await sourceFiles(sourceRoot, rendererSourceExtensions)).map((filePath) => ({
          filePath,
          sourceRoot,
        })),
      ),
    )
  ).flat().sort((left, right) => left.filePath.localeCompare(right.filePath));
  const viteConfigPath = path.join(rootDir, 'apps/studio/vite.config.ts');
  typescriptFiles.push({
    filePath: viteConfigPath,
    sourceRoot: path.join(rootDir, 'apps/studio'),
  });
  validateProductionIndexHtml(
    await readFile(path.join(rootDir, 'apps/studio/index.html'), 'utf8'),
    'apps/studio/index.html',
  );
  for (const { filePath, sourceRoot } of typescriptFiles) {
    const source = await readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : filePath.endsWith('.jsx')
          ? ts.ScriptKind.JSX
          : ['.js', '.mjs', '.cjs'].includes(path.extname(filePath))
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
    );
    let violation = null;
    const inspectModuleSpecifier = (specifier, kind) => {
      if (forbiddenModules.has(specifier)) {
        violation = `network ${kind} ${specifier}`;
        return;
      }
      if (/^(?:https?|wss?|stun|turn|turns):/i.test(specifier) || specifier.startsWith('//')) {
        violation = `network ${kind} ${specifier}`;
        return;
      }
      if (specifier.startsWith('.')) {
        const sourceSpecifier = specifier.split(/[?#]/, 1)[0];
        const extension = path.extname(sourceSpecifier).toLowerCase();
        if (
          extension &&
          !rendererSourceExtensions.includes(extension) &&
          !['.css', '.json'].includes(extension)
        ) {
          violation = `${kind} uses an unreviewed module type: ${specifier}`;
          return;
        }
        const target = path.resolve(path.dirname(filePath), sourceSpecifier);
        if (!pathIsInside(sourceRoot, target)) {
          violation = `${kind} escapes the reviewed source root: ${specifier}`;
        }
      } else if (specifier.startsWith('/')) {
        violation = `${kind} uses an unreviewed absolute source path: ${specifier}`;
      }
    };
    const isImportMeta = (node) =>
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === 'meta';
    const visit = (node) => {
      if (violation) return;
      if (
        ts.isPropertyAccessExpression(node) &&
        isImportMeta(node.expression) &&
        ['glob', 'globEager'].includes(node.name.text)
      ) {
        violation = `import.meta.${node.name.text} module discovery`;
        return;
      }
      if (
        ts.isElementAccessExpression(node) &&
        isImportMeta(node.expression) &&
        ts.isStringLiteral(node.argumentExpression) &&
        ['glob', 'globEager'].includes(node.argumentExpression.text)
      ) {
        violation = `import.meta.${node.argumentExpression.text} module discovery`;
        return;
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        inspectModuleSpecifier(node.moduleSpecifier.text, 'module');
        if (violation) return;
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        inspectModuleSpecifier(node.moduleReference.expression.text, 'module');
        if (violation) return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      ) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
          violation = 'non-literal require';
          return;
        }
        inspectModuleSpecifier(node.arguments[0].text, 'require');
        if (violation) return;
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
          violation = 'non-literal dynamic import';
          return;
        }
        inspectModuleSpecifier(node.arguments[0].text, 'import');
        if (violation) return;
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        forbiddenRendererNetworkGlobals.has(node.name.text)
      ) {
        violation = `network property ${node.name.text}`;
        return;
      }
      if (
        ts.isIdentifier(node) &&
        forbiddenRendererNetworkGlobals.has(node.text)
      ) {
        violation = `network global ${node.text}`;
        return;
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        forbiddenRendererNetworkGlobals.has(node.argumentExpression.text)
      ) {
        violation = `network property ${node.argumentExpression.text}`;
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'fetch') ||
          (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'fetch'))
      ) {
        violation = 'fetch()';
        return;
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        forbiddenRendererNetworkGlobals.has(node.expression.text)
      ) {
        violation = `new ${node.expression.text}()`;
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'sendBeacon'
      ) {
        violation = 'sendBeacon()';
        return;
      }
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        (/^(?:https?|wss?):\/\//i.test(node.text) ||
          /^(?:stun|turn|turns):/i.test(node.text) ||
          node.text.startsWith('//'))
      ) {
        violation = `remote URL ${node.text}`;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (violation) {
      fail(`Hidden network API is forbidden in ${path.relative(rootDir, filePath)}: ${violation}`);
    }
  }

  const rustNetworkPattern = /\b(?:std|tokio)\s*::\s*net\b|\bstd\s*::\s*os\s*::\s*(?:unix|windows)\s*::\s*net\b|\b(?:reqwest|hyper|ureq|curl|isahc|socket2|surf)\b|\b(?:TcpStream|TcpListener|UdpSocket|UnixStream|UnixDatagram)\b/;
  const rustFiles = await sourceFiles(rustRoot, ['.rs']);
  const buildScript = path.join(rootDir, 'apps/desktop/src-tauri/build.rs');
  await requirePinnedTextFile(
    buildScript,
    productionBuildScriptSha256,
    'apps/desktop/src-tauri/build.rs',
  );
  rustFiles.push(buildScript);
  const rustSourceRootPrefix = `${path.resolve(rustRoot)}${path.sep}`;
  for (const filePath of rustFiles.sort()) {
    const source = await readFile(filePath, 'utf8');
    if (/\binclude\s*!\s*\(/.test(source)) {
      fail(
        `Production Rust source must not use include! in ${path.relative(rootDir, filePath)}`,
      );
    }
    if (/#\s*\[\s*cfg_attr\b[^\]]*\bpath\s*=/s.test(source)) {
      fail(
        `Production Rust source must not conditionally replace module paths in ${path.relative(rootDir, filePath)}`,
      );
    }
    const pathAttributeMarkers = source.match(/#\s*\[\s*path\b/g) ?? [];
    const pathAttributes = [
      ...source.matchAll(/#\s*\[\s*path\s*=\s*"([^"]+)"\s*\]/g),
    ];
    if (pathAttributeMarkers.length !== pathAttributes.length) {
      fail(
        `Production Rust path attributes must use a reviewed plain string in ${path.relative(rootDir, filePath)}`,
      );
    }
    for (const attribute of pathAttributes) {
      const target = path.resolve(path.dirname(filePath), attribute[1]);
      if (!target.startsWith(rustSourceRootPrefix) || path.extname(target) !== '.rs') {
        fail(
          `Production Rust path attribute escapes the reviewed source root in ${path.relative(rootDir, filePath)}`,
        );
      }
      const targetState = await lstat(target);
      if (!targetState.isFile() || targetState.isSymbolicLink()) {
        fail(`Production Rust path attribute must reference a regular source file: ${target}`);
      }
    }
    const match = rustNetworkPattern.exec(source);
    if (match) {
      fail(
        `Hidden network API is forbidden in ${path.relative(rootDir, filePath)}: ${match[0]}`,
      );
    }
    if (/\b(?:use\s+(?:::)?|extern\s+crate\s+)libc\b|\blibc\s*::\s*\{/.test(source)) {
      fail(
        `Hidden network API is forbidden in ${path.relative(rootDir, filePath)}: libc imports must use reviewed qualified symbols`,
      );
    }
    for (const symbol of source.matchAll(/\blibc\s*::\s*([A-Za-z_]\w*)/g)) {
      if (!allowedLibcSymbols.has(symbol[1])) {
        fail(
          `Hidden network API is forbidden in ${path.relative(rootDir, filePath)}: unreviewed libc symbol ${symbol[1]}`,
        );
      }
    }
    if (/\buse\s+(?:::)?windows_sys\s+as\b|\bwindows_sys\s*::\s*\{/.test(source)) {
      fail(
        `Hidden network API is forbidden in ${path.relative(rootDir, filePath)}: windows-sys aliases are forbidden`,
      );
    }
    for (const modulePath of source.matchAll(
      /\bwindows_sys\s*::\s*([A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)/g,
    )) {
      const normalized = modulePath[1].replace(/\s+/g, '');
      if (
        !allowedWindowsSysPrefixes.some(
          (prefix) => normalized === prefix || normalized.startsWith(`${prefix}::`),
        )
      ) {
        fail(
          `Hidden network API is forbidden in ${path.relative(rootDir, filePath)}: unreviewed windows-sys module ${normalized}`,
        );
      }
    }
  }
  return true;
}

async function requireNoPlatformTauriOverrides(tauriRoot) {
  for (const name of forbiddenTauriConfigNames) {
    try {
      await lstat(path.join(tauriRoot, name));
      fail(`${name} is forbidden because Tauri can merge it into the production configuration`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function requireNoRepositoryCargoConfig(rootDir) {
  for (const relativePath of forbiddenCargoConfigPaths) {
    try {
      await lstat(path.join(rootDir, relativePath));
      fail(`${relativePath} is forbidden because it can replace Cargo sources or build tools`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function requirePinnedViteConfig(rootDir) {
  const studioRoot = path.join(rootDir, 'apps/studio');
  await requirePinnedTextFile(
    path.join(studioRoot, 'vite.config.ts'),
    productionViteConfigSha256,
    'apps/studio/vite.config.ts',
  );
  for (const name of alternateViteConfigNames) {
    try {
      await lstat(path.join(studioRoot, name));
      fail(`${name} is forbidden because production pins vite.config.ts`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  for (const relativePath of forbiddenPostcssConfigPaths) {
    try {
      await lstat(path.join(rootDir, relativePath));
      fail(`${relativePath} is forbidden because Vite can auto-load it during production builds`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export async function validateDesktopSecurityPolicy({
  rootDir = defaultRepoRoot,
  tauriConfig: providedTauriConfig,
} = {}) {
  const tauriRoot = path.join(rootDir, 'apps/desktop/src-tauri');
  const tauriConfig = providedTauriConfig ?? await readJson(path.join(tauriRoot, 'tauri.conf.json'));
  const capability = await readJson(path.join(tauriRoot, 'capabilities/main.json'));
  const rootPackage = await readJson(path.join(rootDir, 'package.json'));
  const studioPackage = await readJson(path.join(rootDir, 'apps/studio/package.json'));
  const desktopPackage = await readJson(path.join(rootDir, 'apps/desktop/package.json'));
  const security = tauriConfig.app?.security;
  const windows = tauriConfig.app?.windows;

  await requireNoPlatformTauriOverrides(tauriRoot);
  await requireNoRepositoryCargoConfig(rootDir);
  await Promise.all([
    requirePinnedTextFile(
      path.join(tauriRoot, 'Info.plist'),
      productionInfoPlistSha256,
      'apps/desktop/src-tauri/Info.plist',
    ),
    requirePinnedTextFile(
      path.join(tauriRoot, 'Entitlements.plist'),
      productionEntitlementsSha256,
      'apps/desktop/src-tauri/Entitlements.plist',
    ),
  ]);
  await requirePinnedViteConfig(rootDir);
  await requirePinnedPublicDirectory(rootDir);
  await requirePinnedPnpmWorkspace(rootDir);
  requireExact(
    'Tauri production application identity',
    {
      productName: tauriConfig.productName,
      identifier: tauriConfig.identifier,
    },
    {
      productName: 'Compose Tutor Studio',
      identifier: 'com.composetutor.studio',
    },
  );
  requireExact(
    'Tauri production build identity',
    {
      frontendDist: tauriConfig.build?.frontendDist,
      beforeBuildCommand: tauriConfig.build?.beforeBuildCommand,
      beforeBundleCommand: tauriConfig.build?.beforeBundleCommand,
      runner: tauriConfig.build?.runner,
      features: tauriConfig.build?.features,
      removeUnusedCommands: tauriConfig.build?.removeUnusedCommands,
    },
    productionBuildIdentity,
  );
  requireExact(
    'Root production package identity',
    rootPackage,
    {
      ...productionRootPackageIdentity,
      version: tauriConfig.version,
    },
  );
  requireExact(
    'Studio production package identity',
    studioPackage,
    {
      ...productionStudioPackageIdentity,
      version: tauriConfig.version,
    },
  );
  requireExact(
    'Desktop production package identity',
    desktopPackage,
    {
      ...productionDesktopPackageIdentity,
      version: tauriConfig.version,
    },
  );
  if (tauriConfig.app?.withGlobalTauri !== false) {
    fail('Tauri global API must remain disabled');
  }
  if (!Array.isArray(windows) || windows.length !== 1) {
    fail('Production must define exactly one Tauri window');
  }
  const [mainWindow] = windows;
  requireExact(
    'Tauri main window security identity',
    {
      label: mainWindow?.label,
      create: mainWindow?.create,
      url: mainWindow?.url,
      generalAutofillEnabled: mainWindow?.generalAutofillEnabled,
      allowLinkPreview: mainWindow?.allowLinkPreview,
      useHttpsScheme: mainWindow?.useHttpsScheme,
      proxyUrl: mainWindow?.proxyUrl,
      devtools: mainWindow?.devtools,
      additionalBrowserArgs: mainWindow?.additionalBrowserArgs,
      browserExtensionsEnabled: mainWindow?.browserExtensionsEnabled,
    },
    {
      label: 'main',
      create: false,
      url: 'index.html',
      generalAutofillEnabled: false,
      allowLinkPreview: false,
      useHttpsScheme: true,
      proxyUrl: undefined,
      devtools: undefined,
      additionalBrowserArgs: undefined,
      browserExtensionsEnabled: undefined,
    },
  );
  requireExact('Tauri production capabilities', security?.capabilities, ['main']);
  requireExact('Tauri asset protocol', security?.assetProtocol, { enable: false, scope: [] });
  requireExact('Tauri production CSP', security?.csp, productionCsp);
  requireExact('Tauri production headers', security?.headers, {
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
  });
  if (security?.freezePrototype !== true) fail('Tauri prototype freezing must remain enabled');
  if (security?.dangerousDisableAssetCspModification !== false) {
    fail('Tauri asset CSP modification must not be disabled');
  }
  requireExact(
    'Tauri production security identity',
    security,
    {
      capabilities: ['main'],
      assetProtocol: { enable: false, scope: [] },
      csp: productionCsp,
      devCsp: developmentCsp,
      freezePrototype: true,
      dangerousDisableAssetCspModification: false,
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
      },
    },
  );
  requireExact('Tauri production bundle identity', tauriConfig.bundle, productionBundleIdentity);
  if (tauriConfig.plugins !== undefined) fail('Tauri plugins require an explicit security policy review');

  requireExact(
    'Tauri capability identity',
    {
      identifier: capability.identifier,
      windows: capability.windows,
      remote: capability.remote,
    },
    { identifier: 'main', windows: ['main'], remote: undefined },
  );
  const permissions = capability.permissions;
  if (!Array.isArray(permissions) || new Set(permissions).size !== permissions.length) {
    fail('Tauri capability permissions must be a unique array');
  }
  requireExact(
    'Tauri capability permissions',
    [...permissions].sort(),
    [...productionCapabilityPermissions].sort(),
  );
  return { csp: productionCsp, permissions: productionCapabilityPermissions };
}

function readCargoPackageVersion(source) {
  let inPackageSection = false;
  for (const line of source.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*$/)?.[1];
    if (section) {
      inPackageSection = section === 'package';
      continue;
    }
    if (inPackageSection) {
      const version = line.match(/^\s*version\s*=\s*"([^"]+)"\s*$/)?.[1];
      if (version) return version;
    }
  }
  fail('Could not read [package].version from Cargo.toml');
}

export async function validateReleaseIdentity({
  rootDir = defaultRepoRoot,
  tag,
  sha,
  ref,
  event,
  confirmed,
}) {
  const match = stableTagPattern.exec(tag ?? '');
  if (!match) fail('Release tag must be a stable semantic version such as v1.2.3');
  if (!shaPattern.test(sha ?? '')) fail('Release SHA must be a full 40-character Git commit SHA');
  if (ref !== `refs/tags/${tag}`) fail('Release workflow must run from the exact release tag ref');
  if (!['push', 'workflow_dispatch'].includes(event)) fail(`Unsupported release event: ${event}`);
  if (event === 'workflow_dispatch' && confirmed !== 'true') {
    fail('Manual release requires confirm_signed_release=true');
  }

  const version = tag.slice(1);
  const rootPackage = await readJson(path.join(rootDir, 'package.json'));
  const studioPackage = await readJson(path.join(rootDir, 'apps/studio/package.json'));
  const desktopPackage = await readJson(path.join(rootDir, 'apps/desktop/package.json'));
  const tauriConfig = await readJson(path.join(rootDir, 'apps/desktop/src-tauri/tauri.conf.json'));
  const cargoVersion = readCargoPackageVersion(
    await readFile(path.join(rootDir, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8'),
  );
  const versions = {
    rootPackage: rootPackage.version,
    studioPackage: studioPackage.version,
    desktopPackage: desktopPackage.version,
    tauriConfig: tauriConfig.version,
    cargoPackage: cargoVersion,
  };
  for (const [source, candidate] of Object.entries(versions)) {
    if (candidate !== version) fail(`${source} version ${candidate ?? '<missing>'} does not match ${tag}`);
  }
  await validateDesktopSecurityPolicy({ rootDir, tauriConfig });
  return { tag, version, sha: sha.toLowerCase(), versions };
}

export function requireEnvironment(names, environment = process.env) {
  if (names.length === 0) fail('require-env needs at least one variable name');
  const invalidNames = names.filter((name) => !/^[A-Z][A-Z0-9_]*$/.test(name));
  if (invalidNames.length > 0) fail(`Invalid environment variable names: ${invalidNames.join(', ')}`);
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) fail(`Required release values are missing: ${missing.join(', ')}`);
  return names;
}

function normalizeLicenseExpression(expression) {
  return expression
    .replace(/\s*\/\s*/g, ' OR ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evaluateLicenseExpression(expression) {
  if (typeof expression !== 'string' || !expression.trim()) {
    return { allowed: false, normalized: 'NOASSERTION', rejected: ['NOASSERTION'] };
  }
  const normalized = normalizeLicenseExpression(expression);
  const rejected = new Set();
  const tokens = normalized.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9.+-]+/gi) ?? [];
  const residue = normalized
    .replace(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9.+-]+/gi, '')
    .replace(/\s/g, '');
  if (residue || tokens.length === 0) {
    return { allowed: false, normalized, rejected: ['invalid-expression'] };
  }
  let position = 0;
  const peek = () => tokens[position]?.toUpperCase();
  const take = () => tokens[position++];
  const parsePrimary = () => {
    if (peek() === '(') {
      take();
      const value = parseOr();
      if (peek() !== ')') fail(`Invalid license expression: ${normalized}`);
      take();
      return value;
    }
    const identifier = take();
    if (!identifier || ['AND', 'OR', 'WITH', ')'].includes(identifier.toUpperCase())) {
      fail(`Invalid license expression: ${normalized}`);
    }
    let accepted = allowedLicenseIds.has(identifier);
    if (!accepted) rejected.add(identifier);
    if (peek() === 'WITH') {
      take();
      const exception = take();
      if (!exception || !allowedLicenseExceptions.has(exception)) {
        rejected.add(exception ?? 'missing-exception');
        accepted = false;
      }
    }
    return accepted;
  };
  const parseAnd = () => {
    let value = parsePrimary();
    while (peek() === 'AND') {
      take();
      const right = parsePrimary();
      value = value && right;
    }
    return value;
  };
  function parseOr() {
    let value = parseAnd();
    while (peek() === 'OR') {
      take();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }
  let allowed;
  try {
    allowed = parseOr();
    if (position !== tokens.length) fail(`Invalid license expression: ${normalized}`);
  } catch {
    return { allowed: false, normalized, rejected: ['invalid-expression'] };
  }
  return { allowed, normalized, rejected: [...rejected].sort() };
}

function flattenPnpmLicenses(report, scope) {
  const components = [];
  for (const [groupLicense, packages] of Object.entries(report)) {
    for (const entry of packages) {
      for (const version of entry.versions ?? []) {
        const license = entry.license || groupLicense || null;
        components.push({
          ecosystem: 'npm',
          name: entry.name,
          version,
          license,
          homepage: entry.homepage ?? null,
          scope,
        });
      }
    }
  }
  return components;
}

function cargoRuntimePackageIds(metadata) {
  const nodes = new Map((metadata.resolve?.nodes ?? []).map((node) => [node.id, node]));
  const rootId = metadata.resolve?.root;
  if (!rootId || !nodes.has(rootId)) fail('Cargo metadata did not identify the desktop root package');
  const visited = new Set([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const node = nodes.get(queue.shift());
    for (const dependency of node?.deps ?? []) {
      const kinds = dependency.dep_kinds ?? [];
      const isRuntime = kinds.length === 0 || kinds.some((entry) => entry.kind !== 'dev');
      if (isRuntime && !visited.has(dependency.pkg)) {
        visited.add(dependency.pkg);
        queue.push(dependency.pkg);
      }
    }
  }
  return visited;
}

function sanitizeCargoComponents(metadata, runtimeIds) {
  return metadata.packages
    .filter((entry) => entry.source)
    .map((entry) => ({
      ecosystem: 'cargo',
      name: entry.name,
      version: entry.version,
      license: entry.license,
      homepage: entry.homepage ?? entry.repository ?? null,
      scope: runtimeIds.has(entry.id) ? 'runtime' : 'build',
    }));
}

function componentKey(component) {
  return `${component.ecosystem}:${component.name}@${component.version}`;
}

function deduplicateComponents(components) {
  const deduplicated = new Map();
  for (const component of components) {
    const key = componentKey(component);
    const existing = deduplicated.get(key);
    if (!existing || (existing.scope !== 'runtime' && component.scope === 'runtime')) {
      deduplicated.set(key, component);
    }
  }
  return [...deduplicated.values()].sort((left, right) =>
    componentKey(left).localeCompare(componentKey(right)),
  );
}

function purlFor(component) {
  const name = component.name.startsWith('@') && component.name.includes('/')
    ? `${encodeURIComponent(component.name.split('/')[0])}/${encodeURIComponent(component.name.split('/').slice(1).join('/'))}`
    : encodeURIComponent(component.name);
  return `pkg:${component.ecosystem}/${name}@${component.version}`;
}

function spdxIdFor(component) {
  return `SPDXRef-Package-${createHash('sha256').update(componentKey(component)).digest('hex').slice(0, 20)}`;
}

function spdxDeclaredLicense(expression) {
  if (typeof expression !== 'string' || !expression.trim() || /^unknown$/i.test(expression.trim())) {
    return 'NOASSERTION';
  }
  return normalizeLicenseExpression(expression);
}

function createSpdxDocument({ components, repository, tag, sha, version, createdAt }) {
  const rootId = 'SPDXRef-Package-ComposeTutorStudio';
  const packages = [
    {
      name: 'Compose Tutor Studio',
      SPDXID: rootId,
      versionInfo: version,
      downloadLocation: `https://github.com/${repository}/tree/${sha}`,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    },
    ...components.map((component) => {
      return {
        name: component.name,
        SPDXID: spdxIdFor(component),
        versionInfo: component.version,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: spdxDeclaredLicense(component.license),
        copyrightText: 'NOASSERTION',
        externalRefs: [
          {
            referenceCategory: 'PACKAGE-MANAGER',
            referenceType: 'purl',
            referenceLocator: purlFor(component),
          },
        ],
      };
    }),
  ];
  const relationships = components
    .filter((component) => component.scope === 'runtime')
    .map((component) => ({
      spdxElementId: rootId,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: spdxIdFor(component),
    }));
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `compose-tutor-studio-${tag}`,
    documentNamespace: `https://github.com/${repository}/releases/tag/${tag}/sbom-${sha}`,
    creationInfo: {
      creators: ['Tool: compose-tutor-studio/release-preflight.mjs'],
      created: createdAt,
      comment: `Deterministic lock-derived build SBOM for commit ${sha}`,
    },
    documentDescribes: [rootId],
    packages,
    relationships,
  };
}

async function runJson(command, args, options) {
  const { stdout } = await execFileAsync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function generateMetadata({
  rootDir = defaultRepoRoot,
  outputDir,
  tag,
  sha,
  repository,
}) {
  const match = stableTagPattern.exec(tag ?? '');
  if (!match || !shaPattern.test(sha ?? '')) fail('metadata requires a stable tag and full commit SHA');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
    fail('metadata requires an owner/repository name');
  }
  const [allJsReport, runtimeJsReport, cargoMetadata] = await Promise.all([
    runJson('pnpm', ['licenses', 'list', '--json'], { cwd: rootDir }),
    runJson('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: rootDir }),
    runJson(
      'cargo',
      [
        'metadata',
        '--manifest-path',
        'apps/desktop/src-tauri/Cargo.toml',
        '--format-version',
        '1',
        '--locked',
      ],
      { cwd: rootDir },
    ),
  ]);
  const { stdout: commitTimestamp } = await execFileAsync(
    'git',
    ['show', '-s', '--format=%cI', sha],
    { cwd: rootDir, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  const commitDate = new Date(commitTimestamp.trim());
  if (Number.isNaN(commitDate.getTime())) {
    fail('Could not derive an SPDX creation time from the release commit');
  }
  const createdAt = commitDate.toISOString();
  const runtimeIds = cargoRuntimePackageIds(cargoMetadata);
  const allComponents = deduplicateComponents([
    ...flattenPnpmLicenses(allJsReport, 'build'),
    ...flattenPnpmLicenses(runtimeJsReport, 'runtime'),
    ...sanitizeCargoComponents(cargoMetadata, runtimeIds),
  ]);
  const runtimeComponents = allComponents.filter((component) => component.scope === 'runtime');
  const rejected = runtimeComponents
    .map((component) => ({ component, policy: evaluateLicenseExpression(component.license) }))
    .filter(({ policy }) => !policy.allowed);
  if (rejected.length > 0) {
    fail(
      `Runtime license policy rejected: ${rejected
        .map(({ component, policy }) => `${componentKey(component)} (${policy.rejected.join(', ')})`)
        .join('; ')}`,
    );
  }

  const version = tag.slice(1);
  const inventory = {
    schemaVersion: 1,
    policy: {
      mode: 'runtime-fail-closed',
      allowedLicenseIds: [...allowedLicenseIds].sort(),
      allowedExceptions: [...allowedLicenseExceptions].sort(),
      note: 'Build-only dependencies remain in the SBOM; unknown build-only licenses do not certify runtime distribution.',
    },
    release: { tag, version, sha: sha.toLowerCase(), repository },
    projectLicense: 'NOASSERTION',
    runtimeComponents: runtimeComponents.map((component) => ({
      ...component,
      license: evaluateLicenseExpression(component.license).normalized,
      purl: purlFor(component),
    })),
    buildOnlyUnknownLicenses: allComponents
      .filter(
        (component) =>
          component.scope === 'build' && !evaluateLicenseExpression(component.license).allowed,
      )
      .map((component) => ({
        ecosystem: component.ecosystem,
        name: component.name,
        version: component.version,
        license: component.license ?? 'NOASSERTION',
      })),
  };
  const cargoInventory = sanitizeCargoComponents(cargoMetadata, runtimeIds)
    .sort((left, right) => componentKey(left).localeCompare(componentKey(right)))
    .map((component) => ({
      ...component,
      license: component.license
        ? evaluateLicenseExpression(component.license).normalized
        : 'NOASSERTION',
      purl: purlFor(component),
    }));
  const sbom = createSpdxDocument({
    components: allComponents,
    repository,
    tag,
    sha: sha.toLowerCase(),
    version,
    createdAt,
  });
  const notices = [
    '# Third-party runtime notices',
    '',
    `Release: ${tag} (${sha.toLowerCase()})`,
    '',
    'The project source license is intentionally not asserted here. Product ownership must choose it before public distribution.',
    '',
    '| Component | Ecosystem | Version | Declared license |',
    '|---|---|---:|---|',
    ...inventory.runtimeComponents.map(
      (component) =>
        `| ${component.name.replaceAll('|', '\\|')} | ${component.ecosystem} | ${component.version} | ${component.license} |`,
    ),
    '',
  ].join('\n');

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'runtime-licenses.json'), `${JSON.stringify(inventory, null, 2)}\n`),
    writeFile(path.join(outputDir, 'cargo-dependencies.json'), `${JSON.stringify(cargoInventory, null, 2)}\n`),
    writeFile(path.join(outputDir, 'build-sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`),
    writeFile(path.join(outputDir, 'THIRD_PARTY_NOTICES.md'), notices),
  ]);
  return { componentCount: allComponents.length, runtimeCount: runtimeComponents.length };
}

async function walkFiles(root, { maxEntries = 10_000 } = {}) {
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`Release input must not contain symlinks: ${absolute}`);
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) files.push(absolute);
      if (files.length + queue.length > maxEntries) fail(`Release input exceeds ${maxEntries} entries`);
    }
  }
  return files;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function nativeFileMode(_filePath, fileInfo) {
  return fileInfo.mode;
}

function resolvedLinuxFileMode(filePath, fileInfo, resolveFileMode) {
  const mode = resolveFileMode(filePath, fileInfo);
  if (!Number.isSafeInteger(mode) || mode < 0) {
    fail(`Linux file mode could not be determined for ${filePath}`);
  }
  return mode;
}

function assertNoTestOnlyMarkers(executableBytes, label) {
  for (const marker of testOnlyMarkers) {
    if (executableBytes.includes(Buffer.from(marker))) {
      fail(`${label} contains test-only marker: ${marker}`);
    }
  }
}

async function extractAppImageToTemporaryDirectory(appImagePath) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'cts-appimage-identity-'));
  try {
    await execFileAsync(appImagePath, ['--appimage-extract'], {
      cwd: temporaryDirectory,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    });
    const root = path.join(temporaryDirectory, 'squashfs-root');
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      fail('AppImage extraction did not produce a regular squashfs-root directory');
    }
    return {
      root,
      cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    fail(`AppImage extraction failed during packaged executable verification: ${message}`);
  }
}

async function findNamedEntries(root, name, { maxEntries = 50_000 } = {}) {
  const matches = [];
  const queue = [root];
  let entryCount = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });
    entryCount += entries.length;
    if (entryCount > maxEntries) {
      fail(`Extracted AppImage exceeds ${maxEntries} entries`);
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.name === name) matches.push(absolute);
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(absolute);
    }
  }
  return matches;
}

async function verifyLinuxPackagedExecutable({
  extractionRoot,
  executableName,
  standaloneBytes,
  standaloneSha256,
  resolveFileMode,
}) {
  const extractionInfo = await lstat(extractionRoot);
  if (!extractionInfo.isDirectory() || extractionInfo.isSymbolicLink()) {
    fail('Extracted AppImage root must be a regular directory');
  }
  const candidates = await findNamedEntries(extractionRoot, executableName);
  if (candidates.length !== 1) {
    fail(`Expected exactly one extracted Linux product executable, found ${candidates.length}`);
  }
  const packagedExecutable = candidates[0];
  const expectedRelativePath = `usr/bin/${executableName}`;
  const relativePath = path.relative(extractionRoot, packagedExecutable).split(path.sep).join('/');
  if (relativePath !== expectedRelativePath) {
    fail(`Extracted Linux product executable is at an unexpected path: ${relativePath}`);
  }
  const packagedInfo = await lstat(packagedExecutable);
  const packagedMode = resolvedLinuxFileMode(
    packagedExecutable,
    packagedInfo,
    resolveFileMode,
  );
  if (
    packagedInfo.isSymbolicLink() ||
    !packagedInfo.isFile() ||
    (packagedMode & 0o111) === 0
  ) {
    fail('Extracted Linux product executable must be a regular executable file');
  }
  if (packagedInfo.size < 64 * 1024 || packagedInfo.size > 64 * 1024 * 1024) {
    fail(`Extracted Linux product executable has an invalid size: ${packagedInfo.size}`);
  }
  const packagedBytes = await readFile(packagedExecutable);
  assertNoTestOnlyMarkers(packagedBytes, 'Extracted Linux product executable');
  const packagedSha256 = createHash('sha256').update(packagedBytes).digest('hex');
  if (
    packagedBytes.length !== standaloneBytes.length ||
    packagedSha256 !== standaloneSha256
  ) {
    fail(
      'Extracted Linux product executable is not byte-identical to the standalone production executable',
    );
  }
  return {
    path: relativePath,
    bytes: packagedBytes.length,
    sha256: packagedSha256,
    testOnlyMarkers: 'absent',
    identity: { algorithm: 'sha256', matchesStandalone: true },
  };
}

async function verifyAppImageFile(filePath, fileInfo, resolveFileMode) {
  const fileMode = resolvedLinuxFileMode(filePath, fileInfo, resolveFileMode);
  if ((fileMode & 0o111) === 0) fail('AppImage does not have an executable mode bit');
  const header = Buffer.alloc(11);
  const handle = await open(filePath, 'r');
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) fail('AppImage is too short to contain its format header');
  } finally {
    await handle.close();
  }
  const isElf = header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const isAppImage =
    header[8] === 0x41 && header[9] === 0x49 && (header[10] === 0x01 || header[10] === 0x02);
  if (!isElf || !isAppImage) fail('Linux artifact does not contain ELF and AppImage magic bytes');
  return fileMode;
}

function platformPaths(rootDir, platform) {
  const target = path.join(rootDir, 'apps/desktop/src-tauri/target');
  if (platform === 'macos') {
    return {
      releaseRoot: path.join(target, 'universal-apple-darwin/release'),
      bundleRoot: path.join(target, 'universal-apple-darwin/release/bundle'),
      extension: '.dmg',
      artifactDirectory: 'dmg',
      executableName: 'compose-tutor-studio-desktop',
    };
  }
  if (platform === 'windows') {
    return {
      releaseRoot: path.join(target, 'release'),
      bundleRoot: path.join(target, 'release/bundle'),
      extension: '.exe',
      artifactDirectory: 'nsis',
      executableName: 'compose-tutor-studio-desktop.exe',
    };
  }
  if (platform === 'linux') {
    return {
      releaseRoot: path.join(target, 'release'),
      bundleRoot: path.join(target, 'release/bundle'),
      extension: '.AppImage',
      artifactDirectory: 'appimage',
      executableName: 'compose-tutor-studio-desktop',
    };
  }
  fail(`Unsupported release platform: ${platform}`);
}

export async function stagePlatformArtifact({
  rootDir = defaultRepoRoot,
  outputDir,
  platform,
  tag,
  sha,
  verification,
  appImageExtractor = extractAppImageToTemporaryDirectory,
  linuxFileMode = nativeFileMode,
}) {
  if (!stableTagPattern.test(tag ?? '') || !shaPattern.test(sha ?? '')) {
    fail('stage requires a stable tag and full commit SHA');
  }
  if (!/^[a-z0-9-]{3,80}$/.test(verification ?? '')) fail('Invalid verification label');
  const locations = platformPaths(rootDir, platform);
  const executable = path.join(locations.releaseRoot, locations.executableName);
  const executableInfo = await stat(executable);
  if (!executableInfo.isFile() || executableInfo.size < 64 * 1024) {
    fail(`Production executable is missing or implausibly small: ${executable}`);
  }
  if (executableInfo.size > 64 * 1024 * 1024) {
    fail('Production executable exceeds 64 MiB scan bound');
  }
  const executableBytes = await readFile(executable);
  if (executableBytes.length !== executableInfo.size) {
    fail('Production executable changed while it was being scanned');
  }
  assertNoTestOnlyMarkers(executableBytes, 'Production executable');
  const executableSha256 = createHash('sha256').update(executableBytes).digest('hex');

  const artifactRoot = path.join(locations.bundleRoot, locations.artifactDirectory);
  const sourceFiles = await walkFiles(artifactRoot);
  const artifacts = sourceFiles.filter((file) =>
    file.toLowerCase().endsWith(locations.extension.toLowerCase()),
  );
  if (artifacts.length !== 1) {
    fail(`Expected exactly one ${platform} ${locations.extension} artifact, found ${artifacts.length}`);
  }
  const suspiciousName = sourceFiles.find((file) =>
    /(?:wdio|native[-_]test)/i.test(path.basename(file)),
  );
  if (suspiciousName) fail(`Release bundle contains a test-only filename: ${suspiciousName}`);
  const source = artifacts[0];
  const artifactInfo = await stat(source);
  if (artifactInfo.size < 64 * 1024) fail(`Release artifact is implausibly small: ${artifactInfo.size}`);
  if (artifactInfo.size > releaseLimits[platform]) {
    fail(`Release artifact exceeds ${releaseLimits[platform]} byte ${platform} limit`);
  }
  const artifactMode =
    platform === 'linux'
      ? await verifyAppImageFile(source, artifactInfo, linuxFileMode)
      : undefined;

  let packagedExecutable;
  let verifiedAppImageSha256;
  if (platform === 'linux') {
    verifiedAppImageSha256 = await sha256File(source);
    const extraction = await appImageExtractor(source);
    if (
      !extraction ||
      typeof extraction.root !== 'string' ||
      typeof extraction.cleanup !== 'function'
    ) {
      fail('AppImage extractor returned an invalid extraction result');
    }
    try {
      packagedExecutable = await verifyLinuxPackagedExecutable({
        extractionRoot: extraction.root,
        executableName: locations.executableName,
        standaloneBytes: executableBytes,
        standaloneSha256: executableSha256,
        resolveFileMode: linuxFileMode,
      });
    } finally {
      await extraction.cleanup();
    }
  }

  const platformOutput = path.join(outputDir, platform);
  await rm(platformOutput, { recursive: true, force: true });
  await mkdir(platformOutput, { recursive: true });
  const destination = path.join(platformOutput, path.basename(source));
  await copyFile(source, destination);
  if (platform === 'linux') await chmod(destination, artifactMode & 0o777);
  const stagedArtifactSha256 = await sha256File(destination);
  if (platform === 'linux' && stagedArtifactSha256 !== verifiedAppImageSha256) {
    await rm(platformOutput, { recursive: true, force: true });
    fail('AppImage changed while its packaged executable identity was being verified');
  }
  const inventory = {
    schemaVersion: 1,
    platform,
    release: { tag, sha: sha.toLowerCase() },
    verification,
    artifact: {
      filename: path.basename(destination),
      bytes: artifactInfo.size,
      sha256: stagedArtifactSha256,
      ...(platform === 'linux' ? { format: 'elf-appimage', executableMode: true } : {}),
    },
    executable: {
      bytes: executableInfo.size,
      sha256: executableSha256,
      testOnlyMarkers: 'absent',
    },
    ...(platform === 'linux' ? { packagedExecutable } : {}),
  };
  await writeFile(
    path.join(platformOutput, 'artifact-inventory.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  return inventory;
}

export async function finalizeCandidate({ inputDir, tag, sha }) {
  if (!stableTagPattern.test(tag ?? '') || !shaPattern.test(sha ?? '')) {
    fail('finalize requires a stable tag and full commit SHA');
  }
  await rm(path.join(inputDir, 'SHA256SUMS'), { force: true });
  await rm(path.join(inputDir, 'release-manifest.json'), { force: true });
  const expectedTopLevel = new Set(['linux', 'macos', 'metadata', 'windows']);
  const topLevel = await readdir(inputDir, { withFileTypes: true });
  if (
    topLevel.length !== expectedTopLevel.size ||
    topLevel.some((entry) => !entry.isDirectory() || !expectedTopLevel.has(entry.name))
  ) {
    fail('Release candidate contains missing or unexpected top-level entries');
  }
  const expectedVerification = {
    linux: 'appimage-executable-sha256-identical',
    macos: 'signed-notarized-stapled-universal',
    windows: 'authenticode-sha256-rfc3161',
  };
  const expectedExtensions = { linux: '.AppImage', macos: '.dmg', windows: '.exe' };
  for (const [platform, verification] of Object.entries(expectedVerification)) {
    const inventoryPath = path.join(inputDir, platform, 'artifact-inventory.json');
    const inventory = await readJson(inventoryPath);
    const artifactFilename = inventory.artifact?.filename;
    if (
      inventory.schemaVersion !== 1 ||
      inventory.platform !== platform ||
      inventory.release?.tag !== tag ||
      inventory.release?.sha !== sha.toLowerCase() ||
      inventory.verification !== verification ||
      inventory.executable?.testOnlyMarkers !== 'absent' ||
      !Number.isSafeInteger(inventory.executable?.bytes) ||
      inventory.executable.bytes < 64 * 1024 ||
      inventory.executable.bytes > 64 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(inventory.executable?.sha256 ?? '') ||
      typeof artifactFilename !== 'string' ||
      path.basename(artifactFilename) !== artifactFilename ||
      !artifactFilename.toLowerCase().endsWith(expectedExtensions[platform].toLowerCase()) ||
      !Number.isSafeInteger(inventory.artifact?.bytes) ||
      inventory.artifact.bytes < 64 * 1024 ||
      inventory.artifact.bytes > releaseLimits[platform] ||
      !/^[a-f0-9]{64}$/.test(inventory.artifact?.sha256 ?? '') ||
      (platform === 'linux' &&
        (inventory.artifact?.format !== 'elf-appimage' ||
          inventory.artifact?.executableMode !== true ||
          inventory.packagedExecutable?.path !==
            'usr/bin/compose-tutor-studio-desktop' ||
          inventory.packagedExecutable?.bytes !== inventory.executable?.bytes ||
          inventory.packagedExecutable?.sha256 !== inventory.executable?.sha256 ||
          inventory.packagedExecutable?.testOnlyMarkers !== 'absent' ||
          inventory.packagedExecutable?.identity?.algorithm !== 'sha256' ||
          inventory.packagedExecutable?.identity?.matchesStandalone !== true))
    ) {
      fail(`Invalid ${platform} artifact inventory`);
    }
    const platformEntries = await readdir(path.join(inputDir, platform));
    if (
      platformEntries.length !== 2 ||
      !platformEntries.includes('artifact-inventory.json') ||
      !platformEntries.includes(artifactFilename)
    ) {
      fail(`Unexpected files in ${platform} release directory`);
    }
    const artifactPath = path.join(inputDir, platform, artifactFilename);
    const artifactState = await lstat(artifactPath);
    if (!artifactState.isFile() || artifactState.isSymbolicLink()) fail(`Invalid ${platform} artifact`);
    if (artifactState.size !== inventory.artifact.bytes) fail(`${platform} artifact size changed`);
    if ((await sha256File(artifactPath)) !== inventory.artifact.sha256) {
      fail(`${platform} artifact checksum changed`);
    }
  }
  for (const required of [
    'metadata/build-sbom.spdx.json',
    'metadata/cargo-dependencies.json',
    'metadata/runtime-licenses.json',
    'metadata/THIRD_PARTY_NOTICES.md',
  ]) {
    const requiredState = await stat(path.join(inputDir, required));
    if (!requiredState.isFile() || requiredState.size === 0) fail(`Missing release metadata: ${required}`);
  }
  const metadataEntries = (await readdir(path.join(inputDir, 'metadata'))).sort();
  const expectedMetadataEntries = [
    'THIRD_PARTY_NOTICES.md',
    'build-sbom.spdx.json',
    'cargo-dependencies.json',
    'runtime-licenses.json',
  ];
  if (JSON.stringify(metadataEntries) !== JSON.stringify(expectedMetadataEntries)) {
    fail('Release metadata directory contains missing or unexpected files');
  }
  const licenseInventory = await readJson(path.join(inputDir, 'metadata/runtime-licenses.json'));
  if (
    licenseInventory.schemaVersion !== 1 ||
    licenseInventory.release?.tag !== tag ||
    licenseInventory.release?.sha !== sha.toLowerCase() ||
    licenseInventory.release?.version !== tag.slice(1) ||
    licenseInventory.projectLicense !== 'NOASSERTION' ||
    !Array.isArray(licenseInventory.runtimeComponents) ||
    licenseInventory.runtimeComponents.length === 0 ||
    licenseInventory.runtimeComponents.some(
      (component) =>
        !component.purl || !evaluateLicenseExpression(component.license).allowed,
    )
  ) {
    fail('Runtime license inventory does not match the release identity');
  }
  const cargoInventory = await readJson(path.join(inputDir, 'metadata/cargo-dependencies.json'));
  if (!Array.isArray(cargoInventory) || cargoInventory.length === 0) {
    fail('Cargo dependency inventory is empty or invalid');
  }
  const sbom = await readJson(path.join(inputDir, 'metadata/build-sbom.spdx.json'));
  const expectedNamespace = `https://github.com/${licenseInventory.release.repository}/releases/tag/${tag}/sbom-${sha.toLowerCase()}`;
  if (
    sbom.spdxVersion !== 'SPDX-2.3' ||
    sbom.SPDXID !== 'SPDXRef-DOCUMENT' ||
    sbom.name !== `compose-tutor-studio-${tag}` ||
    sbom.documentNamespace !== expectedNamespace ||
    !Array.isArray(sbom.packages) ||
    sbom.packages.length < licenseInventory.runtimeComponents.length
  ) {
    fail('Build SBOM is empty, malformed, or belongs to a different release');
  }
  const files = (await walkFiles(inputDir)).sort((left, right) =>
    path.relative(inputDir, left).localeCompare(path.relative(inputDir, right)),
  );
  const payload = [];
  for (const file of files) {
    const relative = path.relative(inputDir, file).split(path.sep).join('/');
    const fileState = await stat(file);
    payload.push({ path: relative, bytes: fileState.size, sha256: await sha256File(file) });
  }
  const checksumText = `${payload.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`;
  await writeFile(path.join(inputDir, 'SHA256SUMS'), checksumText);
  const manifest = {
    schemaVersion: 1,
    release: { tag, version: tag.slice(1), sha: sha.toLowerCase() },
    publication: 'not-published',
    payload,
    checksums: 'SHA256SUMS',
  };
  await writeFile(
    path.join(inputDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function main(argv) {
  const { command, flags, positional } = parseArguments(argv);
  if (command === 'preflight') {
    const result = await validateReleaseIdentity({
      tag: requiredFlag(flags, 'tag'),
      sha: requiredFlag(flags, 'sha'),
      ref: requiredFlag(flags, 'ref'),
      event: requiredFlag(flags, 'event'),
      confirmed: requiredFlag(flags, 'confirmed'),
    });
    console.log(`Release identity verified: ${result.tag} @ ${result.sha}`);
    return;
  }
  if (command === 'require-env') {
    requireEnvironment(positional);
    console.log(`Verified ${positional.length} required release values`);
    return;
  }
  if (command === 'renderer-assets') {
    const result = await validateBuiltRendererAssets({
      distDir: path.resolve(requiredFlag(flags, 'input')),
      profile: requiredFlag(flags, 'profile'),
    });
    console.log(
      `Verified ${result.files} built renderer files (${result.inspectedBytes} inspected bytes)`,
    );
    return;
  }
  if (command === 'metadata') {
    const result = await generateMetadata({
      outputDir: path.resolve(requiredFlag(flags, 'out')),
      tag: requiredFlag(flags, 'tag'),
      sha: requiredFlag(flags, 'sha'),
      repository: requiredFlag(flags, 'repository'),
    });
    console.log(`Generated SBOM for ${result.componentCount} build components (${result.runtimeCount} runtime)`);
    return;
  }
  if (command === 'stage') {
    const result = await stagePlatformArtifact({
      outputDir: path.resolve(requiredFlag(flags, 'out')),
      platform: requiredFlag(flags, 'platform'),
      tag: requiredFlag(flags, 'tag'),
      sha: requiredFlag(flags, 'sha'),
      verification: requiredFlag(flags, 'verification'),
    });
    console.log(`Staged ${result.platform} artifact ${result.artifact.filename}`);
    return;
  }
  if (command === 'finalize') {
    const result = await finalizeCandidate({
      inputDir: path.resolve(requiredFlag(flags, 'input')),
      tag: requiredFlag(flags, 'tag'),
      sha: requiredFlag(flags, 'sha'),
    });
    console.log(`Finalized ${result.payload.length} checksummed release payload files`);
    return;
  }
  fail(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
