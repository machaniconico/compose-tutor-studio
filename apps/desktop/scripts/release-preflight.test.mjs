import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateLicenseExpression,
  finalizeCandidate,
  requireEnvironment,
  stagePlatformArtifact,
  validateBuiltRendererAssets,
  validateDesktopSecurityPolicy,
  validateNoHiddenNetworkCalls,
  validateReleaseIdentity,
} from './release-preflight.mjs';

const sha = '0'.repeat(40);
const runtimeTestOnlyMarkers = [
  'WDIO_EMBEDDED_SERVER',
  'CTS_NATIVE_TEST_CLOSE_GRACE_MS',
  'CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_PATH',
  'CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_TOKEN',
  'cts-native-e2e-close-request',
  'tauri-plugin-wdio-webdriver',
  'tauri_plugin_wdio_webdriver',
  'com.composetutor.studio.test',
];
const productionPermissions = [
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
];
const productionCargoToml = `
[lib]
name = "compose_tutor_studio_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[features]
native-test = ["dep:tauri-plugin-wdio-webdriver"]

[build-dependencies]
tauri-build = { version = "2.6.3", features = [] }

[dependencies]
atomicwrites = "=0.4.4"
crc32fast = "=1.5.0"
fs4 = { version = "=1.1.0", default-features = false, features = ["sync"] }
rusqlite = { version = "=0.40.1", default-features = false, features = ["bundled"] }
serde = { version = "=1.0.228", features = ["derive"] }
serde_json = "=1.0.150"
sha2 = "=0.10.9"
tauri = { version = "2.11.5", features = [] }
tauri-plugin-dialog = { version = "=2.7.1", default-features = false, features = ["gtk3"] }
tauri-plugin-wdio-webdriver = { version = "1.2.0", optional = true }
thiserror = "=2.0.18"

[target.'cfg(unix)'.dependencies]
libc = "=0.2.186"

[target.'cfg(target_os = "linux")'.dependencies]
webkit2gtk = { version = "=2.0.2", features = ["v2_40"] }

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Storage_FileSystem"] }

[dev-dependencies]
tempfile = "3"
`;

function secureTauriConfig(version) {
  return {
    productName: 'Compose Tutor Studio',
    version,
    identifier: 'com.composetutor.studio',
    build: {
      beforeBuildCommand: 'pnpm --dir ../studio build',
      frontendDist: '../../studio/dist',
      removeUnusedCommands: true,
    },
    app: {
      withGlobalTauri: false,
      windows: [{
        label: 'main',
        create: false,
        url: 'index.html',
        generalAutofillEnabled: false,
        allowLinkPreview: false,
        useHttpsScheme: true,
      }],
      security: {
        capabilities: ['main'],
        assetProtocol: { enable: false, scope: [] },
        csp: {
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
        },
        devCsp: {
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
        },
        freezePrototype: true,
        dangerousDisableAssetCspModification: false,
        headers: {
          'X-Content-Type-Options': 'nosniff',
          'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
        },
      },
    },
    bundle: {
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
      windows: { minimumWebview2Version: '105.0.1343.25' },
      macOS: {
        minimumSystemVersion: '12.4',
        hardenedRuntime: true,
        entitlements: 'Entitlements.plist',
        infoPlist: 'Info.plist',
      },
      linux: { appimage: { bundleMediaFramework: true } },
    },
  };
}

async function createReleaseSource(version = '1.2.3') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cts-release-source-'));
  await mkdir(path.join(root, 'apps/desktop/src-tauri/capabilities'), { recursive: true });
  await mkdir(path.join(root, 'apps/desktop/src-tauri/src'), { recursive: true });
  await mkdir(path.join(root, 'apps/studio/src'), { recursive: true });
  await mkdir(path.join(root, 'apps/studio/public'), { recursive: true });
  const libraryPackages = [
    'midi-io',
    'project-model',
    'project-persistence',
    'theory-engine',
    'tutorial-engine',
  ];
  for (const packageName of libraryPackages) {
    await mkdir(path.join(root, `packages/${packageName}/src`), { recursive: true });
    await copyFile(
      new URL(`../../../packages/${packageName}/package.json`, import.meta.url),
      path.join(root, `packages/${packageName}/package.json`),
    );
  }
  for (const [sourceUrl, destination] of [
    [new URL('../../../package.json', import.meta.url), path.join(root, 'package.json')],
    [new URL('../../studio/package.json', import.meta.url), path.join(root, 'apps/studio/package.json')],
    [new URL('../package.json', import.meta.url), path.join(root, 'apps/desktop/package.json')],
  ]) {
    const manifest = JSON.parse(await readFile(sourceUrl, 'utf8'));
    manifest.version = version;
    await writeFile(destination, JSON.stringify(manifest));
  }
  await Promise.all([
    copyFile(
      new URL('../../../pnpm-workspace.yaml', import.meta.url),
      path.join(root, 'pnpm-workspace.yaml'),
    ),
    copyFile(new URL('../../../pnpm-lock.yaml', import.meta.url), path.join(root, 'pnpm-lock.yaml')),
    copyFile(
      new URL('../src-tauri/Info.plist', import.meta.url),
      path.join(root, 'apps/desktop/src-tauri/Info.plist'),
    ),
    copyFile(
      new URL('../src-tauri/Entitlements.plist', import.meta.url),
      path.join(root, 'apps/desktop/src-tauri/Entitlements.plist'),
    ),
  ]);
  await writeFile(
    path.join(root, 'apps/studio/index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
  );
  await writeFile(path.join(root, 'apps/studio/src/main.tsx'), 'export {};\n');
  await writeFile(
    path.join(root, 'apps/studio/vite.config.ts'),
    await readFile(new URL('../../studio/vite.config.ts', import.meta.url)),
  );
  await writeFile(
    path.join(root, 'apps/studio/public/_redirects'),
    await readFile(new URL('../../studio/public/_redirects', import.meta.url)),
  );
  await writeFile(
    path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'),
    JSON.stringify(secureTauriConfig(version)),
  );
  await writeFile(
    path.join(root, 'apps/desktop/src-tauri/capabilities/main.json'),
    JSON.stringify({ identifier: 'main', windows: ['main'], permissions: productionPermissions }),
  );
  await writeFile(
    path.join(root, 'apps/desktop/src-tauri/Cargo.toml'),
    `[package]\nname = "desktop"\nversion = "${version}"\n${productionCargoToml}`,
  );
  await writeFile(
    path.join(root, 'apps/desktop/src-tauri/build.rs'),
    await readFile(new URL('../src-tauri/build.rs', import.meta.url)),
  );
  return root;
}

test('validates the actual repository security policy and production sources', async () => {
  await validateDesktopSecurityPolicy();
  await validateNoHiddenNetworkCalls();
});

test('pins microphone authority and native permission disclosures fail closed', async () => {
  const headerRoot = await createReleaseSource();
  const headerTauriPath = path.join(headerRoot, 'apps/desktop/src-tauri/tauri.conf.json');
  const headerTauri = JSON.parse(await readFile(headerTauriPath, 'utf8'));
  headerTauri.app.security.headers['Permissions-Policy'] =
    'camera=(), microphone=(*), geolocation=(), payment=(), usb=()';
  await writeFile(headerTauriPath, JSON.stringify(headerTauri));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: headerRoot }),
    /Tauri production headers.*allowlist/,
  );

  const infoRoot = await createReleaseSource();
  await writeFile(
    path.join(infoRoot, 'apps/desktop/src-tauri/Info.plist'),
    '<?xml version="1.0"?><plist><dict></dict></plist>\n',
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: infoRoot }),
    /Info\.plist does not match the reviewed production build input/,
  );

  const entitlementRoot = await createReleaseSource();
  await rm(path.join(entitlementRoot, 'apps/desktop/src-tauri/Entitlements.plist'));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: entitlementRoot }),
    /Entitlements\.plist is missing/,
  );

  const bundleRoot = await createReleaseSource();
  const bundleTauriPath = path.join(bundleRoot, 'apps/desktop/src-tauri/tauri.conf.json');
  const bundleTauri = JSON.parse(await readFile(bundleTauriPath, 'utf8'));
  bundleTauri.bundle.macOS.entitlements = 'Unreviewed.entitlements';
  await writeFile(bundleTauriPath, JSON.stringify(bundleTauri));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: bundleRoot }),
    /Tauri production bundle identity.*allowlist/,
  );

  const cargoRoot = await createReleaseSource();
  const cargoPath = path.join(cargoRoot, 'apps/desktop/src-tauri/Cargo.toml');
  await writeFile(
    cargoPath,
    (await readFile(cargoPath, 'utf8')).replace(
      'webkit2gtk = { version = "=2.0.2", features = ["v2_40"] }',
      'webkit2gtk = { version = "=2.0.2" }',
    ),
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir: cargoRoot }),
    /Cargo production manifest identity.*allowlist/,
  );
});

test('accepts only an exact stable tag with matching source versions', async () => {
  const rootDir = await createReleaseSource();
  const result = await validateReleaseIdentity({
    rootDir,
    tag: 'v1.2.3',
    sha,
    ref: 'refs/tags/v1.2.3',
    event: 'workflow_dispatch',
    confirmed: 'true',
  });
  assert.equal(result.version, '1.2.3');
  await assert.rejects(
    validateReleaseIdentity({
      rootDir,
      tag: 'v1.2.3-rc.1',
      sha,
      ref: 'refs/tags/v1.2.3-rc.1',
      event: 'push',
      confirmed: 'false',
    }),
    /stable semantic version/,
  );

  const mismatchedStudioRoot = await createReleaseSource();
  const studioPackagePath = path.join(mismatchedStudioRoot, 'apps/studio/package.json');
  const studioPackage = JSON.parse(await readFile(studioPackagePath, 'utf8'));
  studioPackage.version = '1.2.4';
  await writeFile(studioPackagePath, JSON.stringify(studioPackage));
  await assert.rejects(
    validateReleaseIdentity({
      rootDir: mismatchedStudioRoot,
      tag: 'v1.2.3',
      sha,
      ref: 'refs/tags/v1.2.3',
      event: 'push',
      confirmed: 'false',
    }),
    /studioPackage version 1\.2\.4 does not match v1\.2\.3/,
  );
});

test('fails release preflight when network or broad native authority is added', async () => {
  const rootDir = await createReleaseSource();
  const tauriPath = path.join(rootDir, 'apps/desktop/src-tauri/tauri.conf.json');
  const capabilityPath = path.join(rootDir, 'apps/desktop/src-tauri/capabilities/main.json');
  const tauri = JSON.parse(await readFile(tauriPath, 'utf8'));
  tauri.app.security.csp['connect-src'] += ' https:';
  await writeFile(tauriPath, JSON.stringify(tauri));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir }),
    /production CSP.*allowlist/,
  );

  await writeFile(tauriPath, JSON.stringify(secureTauriConfig('1.2.3')));
  const capability = JSON.parse(await readFile(capabilityPath, 'utf8'));
  capability.permissions.push('core:default');
  await writeFile(capabilityPath, JSON.stringify(capability));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir }),
    /capability permissions.*allowlist/,
  );

  capability.permissions = productionPermissions.filter(
    (permission) => permission !== 'allow-file-open-audio',
  );
  await writeFile(capabilityPath, JSON.stringify(capability));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir }),
    /capability permissions.*allowlist/,
  );

  await writeFile(capabilityPath, JSON.stringify({
    identifier: 'main',
    windows: ['main'],
    permissions: productionPermissions,
  }));
  const unsafeWindow = secureTauriConfig('1.2.3');
  unsafeWindow.app.windows[0].additionalBrowserArgs =
    '--remote-debugging-port=9222 --disable-web-security';
  await writeFile(tauriPath, JSON.stringify(unsafeWindow));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir }),
    /main window security identity.*allowlist/,
  );

  const isolationPattern = secureTauriConfig('1.2.3');
  isolationPattern.app.security.pattern = {
    use: 'isolation',
    options: { dir: '../unreviewed-isolation-app' },
  };
  await writeFile(tauriPath, JSON.stringify(isolationPattern));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir }),
    /Tauri production security identity.*allowlist/,
  );
});

test('rejects production build hooks, remote assets, platform overrides, and new Cargo authority', async () => {
  const rootDir = await createReleaseSource();
  const tauriPath = path.join(rootDir, 'apps/desktop/src-tauri/tauri.conf.json');

  for (const [field, value] of [
    ['frontendDist', 'https://example.com/app'],
    ['beforeBuildCommand', 'node rewrite-production-source.mjs'],
    ['beforeBundleCommand', 'node rewrite-packaged-assets.mjs'],
    ['runner', 'network-enabled-runner'],
    ['features', ['dangerous-feature']],
  ]) {
    const tauri = secureTauriConfig('1.2.3');
    tauri.build[field] = value;
    await writeFile(tauriPath, JSON.stringify(tauri));
    await assert.rejects(
      validateDesktopSecurityPolicy({ rootDir }),
      /production build identity.*allowlist/,
    );
  }

  await writeFile(tauriPath, JSON.stringify(secureTauriConfig('1.2.3')));
  await writeFile(
    path.join(rootDir, 'apps/desktop/src-tauri/tauri.macos.conf.json'),
    JSON.stringify({ build: { frontendDist: 'https://example.com/app' } }),
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir }),
    /tauri\.macos\.conf\.json is forbidden/,
  );

  const json5Root = await createReleaseSource();
  await writeFile(
    path.join(json5Root, 'apps/desktop/src-tauri/tauri.windows.conf.json5'),
    '{ build: { frontendDist: "https://example.com/app" } }\n',
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: json5Root }),
    /tauri\.windows\.conf\.json5 is forbidden/,
  );

  const packageRoot = await createReleaseSource();
  const studioPackagePath = path.join(packageRoot, 'apps/studio/package.json');
  const studioPackage = JSON.parse(await readFile(studioPackagePath, 'utf8'));
  studioPackage.scripts.build = 'tsc --noEmit && vite build && node inject-network.mjs';
  await writeFile(studioPackagePath, JSON.stringify(studioPackage));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: packageRoot }),
    /Studio production package identity.*allowlist/,
  );

  for (const hook of ['prebuild', 'postbuild']) {
    const hookRoot = await createReleaseSource();
    const hookPackagePath = path.join(hookRoot, 'apps/studio/package.json');
    const hookPackage = JSON.parse(await readFile(hookPackagePath, 'utf8'));
    hookPackage.scripts[hook] = 'node unreviewed-build-hook.mjs';
    await writeFile(hookPackagePath, JSON.stringify(hookPackage));
    await assert.rejects(
      validateDesktopSecurityPolicy({ rootDir: hookRoot }),
      /Studio production package identity.*allowlist/,
    );
  }

  const viteDependencyRoot = await createReleaseSource();
  const viteDependencyPackagePath = path.join(viteDependencyRoot, 'apps/studio/package.json');
  const viteDependencyPackage = JSON.parse(await readFile(viteDependencyPackagePath, 'utf8'));
  viteDependencyPackage.devDependencies.vite = 'file:../unreviewed-vite';
  await writeFile(viteDependencyPackagePath, JSON.stringify(viteDependencyPackage));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: viteDependencyRoot }),
    /Studio production package identity.*allowlist/,
  );

  const tauriCliDependencyRoot = await createReleaseSource();
  const tauriCliPackagePath = path.join(tauriCliDependencyRoot, 'apps/desktop/package.json');
  const tauriCliPackage = JSON.parse(await readFile(tauriCliPackagePath, 'utf8'));
  tauriCliPackage.devDependencies['@tauri-apps/cli'] = 'file:../unreviewed-tauri-cli';
  await writeFile(tauriCliPackagePath, JSON.stringify(tauriCliPackage));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: tauriCliDependencyRoot }),
    /Desktop production package identity.*allowlist/,
  );

  const studioSubstitutionRoot = await createReleaseSource();
  const substitutedStudioPath = path.join(studioSubstitutionRoot, 'apps/studio/package.json');
  const substitutedStudio = JSON.parse(await readFile(substitutedStudioPath, 'utf8'));
  substitutedStudio.name = '@cts/reviewed-studio';
  await writeFile(substitutedStudioPath, JSON.stringify(substitutedStudio));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: studioSubstitutionRoot }),
    /Studio production package identity.*allowlist/,
  );

  const desktopSubstitutionRoot = await createReleaseSource();
  const substitutedDesktopPath = path.join(desktopSubstitutionRoot, 'apps/desktop/package.json');
  await writeFile(
    substitutedDesktopPath,
    JSON.stringify({ name: '@cts/reviewed-desktop', version: '1.2.3' }),
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: desktopSubstitutionRoot }),
    /Desktop production package identity.*allowlist/,
  );

  const duplicatePackageRoot = await createReleaseSource();
  await mkdir(path.join(duplicatePackageRoot, 'apps/duplicate-studio'), { recursive: true });
  await writeFile(
    path.join(duplicatePackageRoot, 'apps/duplicate-studio/package.json'),
    JSON.stringify({ name: '@cts/studio', version: '1.2.3', scripts: { build: 'node evil.mjs' } }),
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: duplicatePackageRoot }),
    /Production pnpm workspace package inventory.*allowlist/,
  );

  const workspaceConfigRoot = await createReleaseSource();
  await writeFile(
    path.join(workspaceConfigRoot, 'pnpm-workspace.yaml'),
    'packages:\n  - "apps/*"\n  - "packages/*"\nhooks:\n  readPackage: ./evil.cjs\n',
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: workspaceConfigRoot }),
    /pnpm-workspace\.yaml does not match the reviewed production build input/,
  );

  const pnpmFileRoot = await createReleaseSource();
  await writeFile(
    path.join(pnpmFileRoot, '.pnpmfile.cjs'),
    'module.exports = { hooks: { readPackage: (pkg) => pkg } };\n',
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: pnpmFileRoot }),
    /.pnpmfile\.cjs is forbidden/,
  );

  const lockfileRoot = await createReleaseSource();
  await writeFile(path.join(lockfileRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: lockfileRoot }),
    /pnpm-lock\.yaml does not match the reviewed production build input/,
  );

  const rootPnpmConfigRoot = await createReleaseSource();
  const rootPackagePath = path.join(rootPnpmConfigRoot, 'package.json');
  const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'));
  rootPackage.pnpm = { overrides: { vite: 'file:unreviewed-vite' } };
  await writeFile(rootPackagePath, JSON.stringify(rootPackage));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: rootPnpmConfigRoot }),
    /Root production package identity.*allowlist/,
  );

  const libraryManifestRoot = await createReleaseSource();
  const libraryManifestPath = path.join(
    libraryManifestRoot,
    'packages/project-model/package.json',
  );
  const libraryManifest = JSON.parse(await readFile(libraryManifestPath, 'utf8'));
  libraryManifest.exports['.'] = '../../unreviewed-runtime.mjs';
  await writeFile(libraryManifestPath, JSON.stringify(libraryManifest));
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: libraryManifestRoot }),
    /Production workspace manifest packages\/project-model\/package\.json.*allowlist/,
  );

  const viteConfigRoot = await createReleaseSource();
  await writeFile(
    path.join(viteConfigRoot, 'apps/studio/vite.config.js'),
    'export default { publicDir: "alternate-public" };\n',
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: viteConfigRoot }),
    /vite\.config\.js is forbidden/,
  );

  const changedViteConfigRoot = await createReleaseSource();
  await writeFile(
    path.join(changedViteConfigRoot, 'apps/studio/vite.config.ts'),
    'export default { plugins: [{ transform: () => "fetch(\\"https://attacker.invalid\\")" }] };\n',
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: changedViteConfigRoot }),
    /vite\.config\.ts does not match the reviewed production build input/,
  );

  for (const relativePath of [
    'postcss.config.cjs',
    'apps/.postcssrc.mjs',
    'apps/studio/postcss.config.js',
  ]) {
    const postcssRoot = await createReleaseSource();
    const configPath = path.join(postcssRoot, relativePath);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, 'module.exports = { plugins: [() => fetch("https://attacker.invalid")] };\n');
    await assert.rejects(
      validateDesktopSecurityPolicy({ rootDir: postcssRoot }),
      new RegExp(`${relativePath.replaceAll('.', '\\.')} is forbidden`),
    );
  }

  const appsPackageRoot = await createReleaseSource();
  await writeFile(
    path.join(appsPackageRoot, 'apps/package.json'),
    JSON.stringify({ postcss: { plugins: { './unreviewed-plugin.cjs': {} } } }),
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: appsPackageRoot }),
    /apps\/package\.json is forbidden/,
  );

  for (const mutateBundle of [
    (bundle) => { bundle.windows.signCommand = 'node unreviewed-signer.mjs'; },
    (bundle) => { bundle.windows.nsis = { installerHooks: 'unreviewed-installer.nsh' }; },
    (bundle) => { bundle.externalBin = ['unreviewed-native-helper']; },
  ]) {
    const bundleRoot = await createReleaseSource();
    const bundleTauriPath = path.join(bundleRoot, 'apps/desktop/src-tauri/tauri.conf.json');
    const bundleTauri = JSON.parse(await readFile(bundleTauriPath, 'utf8'));
    mutateBundle(bundleTauri.bundle);
    await writeFile(bundleTauriPath, JSON.stringify(bundleTauri));
    await assert.rejects(
      validateDesktopSecurityPolicy({ rootDir: bundleRoot }),
      /Tauri production bundle identity.*allowlist/,
    );
  }

  const cargoConfigRoot = await createReleaseSource();
  await mkdir(path.join(cargoConfigRoot, '.cargo'), { recursive: true });
  await writeFile(
    path.join(cargoConfigRoot, '.cargo/config.toml'),
    '[build]\nrustc-wrapper = "network-enabled-wrapper"\n',
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: cargoConfigRoot }),
    /.cargo\/config\.toml is forbidden/,
  );

  const parentCargoConfigRoot = await createReleaseSource();
  await mkdir(path.join(parentCargoConfigRoot, 'apps/.cargo'), { recursive: true });
  await writeFile(
    path.join(parentCargoConfigRoot, 'apps/.cargo/config.toml'),
    '[source.crates-io]\nreplace-with = "unreviewed"\n',
  );
  await assert.rejects(
    validateDesktopSecurityPolicy({ rootDir: parentCargoConfigRoot }),
    /apps\/.cargo\/config\.toml is forbidden/,
  );

  const cargoRoot = await createReleaseSource();
  const cargoPath = path.join(cargoRoot, 'apps/desktop/src-tauri/Cargo.toml');
  await writeFile(
    cargoPath,
    `${await readFile(cargoPath, 'utf8')}\n[dependencies.reqwest]\nversion = "0.13"\n`,
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir: cargoRoot }),
    /Cargo production manifest identity.*allowlist/,
  );

  const targetRoot = await createReleaseSource();
  const targetCargoPath = path.join(targetRoot, 'apps/desktop/src-tauri/Cargo.toml');
  await writeFile(
    targetCargoPath,
    (await readFile(targetCargoPath, 'utf8')).replace(
      'crate-type = ["staticlib", "cdylib", "rlib"]',
      'crate-type = ["staticlib", "cdylib", "rlib"]\npath = "hidden.rs"',
    ),
  );
  await writeFile(
    path.join(targetRoot, 'apps/desktop/src-tauri/hidden.rs'),
    'fn hidden() { let _ = std::net::TcpStream::connect("127.0.0.1:1"); }\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir: targetRoot }),
    /Cargo production manifest identity.*allowlist/,
  );

  const sourceGraphRoot = await createReleaseSource();
  await writeFile(
    path.join(sourceGraphRoot, 'apps/desktop/src-tauri/src/lib.rs'),
    '#[path = "../hidden.rs"]\nmod hidden;\n',
  );
  await writeFile(
    path.join(sourceGraphRoot, 'apps/desktop/src-tauri/hidden.rs'),
    'pub fn hidden() { let _ = std::net::TcpStream::connect("127.0.0.1:1"); }\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir: sourceGraphRoot }),
    /Rust path attribute escapes the reviewed source root/,
  );

  const includeRoot = await createReleaseSource();
  await writeFile(
    path.join(includeRoot, 'apps/desktop/src-tauri/src/lib.rs'),
    'include!("../hidden.rs");\n',
  );
  await writeFile(
    path.join(includeRoot, 'apps/desktop/src-tauri/hidden.rs'),
    'pub fn hidden() { let _ = std::net::TcpStream::connect("127.0.0.1:1"); }\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir: includeRoot }),
    /must not use include!/,
  );

  const conditionalPathRoot = await createReleaseSource();
  await writeFile(
    path.join(conditionalPathRoot, 'apps/desktop/src-tauri/src/lib.rs'),
    '#[cfg_attr(not(test), path = "../hidden.rs")]\nmod hidden;\n',
  );
  await writeFile(
    path.join(conditionalPathRoot, 'apps/desktop/src-tauri/hidden.rs'),
    'pub fn hidden() { let _ = std::net::TcpStream::connect("127.0.0.1:1"); }\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir: conditionalPathRoot }),
    /must not conditionally replace module paths/,
  );

  const buildScriptSymlinkRoot = await createReleaseSource();
  const buildScriptPath = path.join(buildScriptSymlinkRoot, 'apps/desktop/src-tauri/build.rs');
  await writeFile(
    path.join(buildScriptSymlinkRoot, 'apps/desktop/src-tauri/hidden-build.rs'),
    'fn main() { let _ = std::net::TcpStream::connect("127.0.0.1:1"); }\n',
  );
  await rm(buildScriptPath);
  await symlink('hidden-build.rs', buildScriptPath);
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir: buildScriptSymlinkRoot }),
    /build\.rs must remain a regular reviewed build input/,
  );

  const changedBuildScriptRoot = await createReleaseSource();
  await writeFile(
    path.join(changedBuildScriptRoot, 'apps/desktop/src-tauri/build.rs'),
    'fn main() { println!("cargo:warning=unreviewed build script"); }\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir: changedBuildScriptRoot }),
    /build\.rs does not match the reviewed production build input/,
  );
});

test('rejects hidden renderer and Rust network APIs from production source', async () => {
  const rootDir = await createReleaseSource();
  const rendererPath = path.join(rootDir, 'apps/studio/src/hidden.ts');
  await writeFile(rendererPath, "export const hidden = () => fetch('https://example.com');\n");
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*fetch/,
  );

  await writeFile(rendererPath, "export const hidden = () => globalThis.fetch('https://example.com');\n");
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*fetch/,
  );

  await writeFile(rendererPath, 'export const hidden = fetch;\n');
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*fetch/,
  );

  await writeFile(rendererPath, "export const hidden = globalThis['fetch'];\n");
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*fetch/,
  );

  await writeFile(rendererPath, "export const hidden = () => import('node:https');\n");
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*network import/,
  );

  await writeFile(rendererPath, "export const hidden = require('node:https');\n");
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*network require/,
  );

  await writeFile(rendererPath, 'export const localOnly = true;\n');
  const javascriptPath = path.join(rootDir, 'apps/studio/src/hidden.mjs');
  await writeFile(
    javascriptPath,
    "new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.example.com:3478' }] });\n",
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*RTCPeerConnection/,
  );

  await writeFile(javascriptPath, "export const hidden = 'turn:turn.example.com:3478';\n");
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*remote URL.*turn:/,
  );
  await writeFile(javascriptPath, "export const hidden = '//attacker.invalid/collect';\n");
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*remote URL.*\/\/attacker\.invalid/,
  );
  await writeFile(javascriptPath, 'export const localOnly = true;\n');

  const redirectsPath = path.join(rootDir, 'apps/studio/public/_redirects');
  await writeFile(redirectsPath, '/* https://attacker.invalid/:splat 302\n');
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /_redirects does not match the production deployment allowlist/,
  );
  await writeFile(
    redirectsPath,
    await readFile(new URL('../../studio/public/_redirects', import.meta.url)),
  );

  const publicJavascriptPath = path.join(rootDir, 'apps/studio/public/hidden.mjs');
  await writeFile(
    publicJavascriptPath,
    "new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.example.com:3478' }] });\n",
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Studio production public directory.*allowlist/,
  );
  await rm(publicJavascriptPath);

  const mainPath = path.join(rootDir, 'apps/studio/src/main.tsx');
  await writeFile(mainPath, "import '../outside.mjs';\n");
  await writeFile(
    path.join(rootDir, 'apps/studio/outside.mjs'),
    "new RTCPeerConnection({ iceServers: [{ urls: 'stun:attacker.invalid' }] });\n",
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /module escapes the reviewed source root/,
  );
  await writeFile(
    mainPath,
    "export const hidden = import.meta.glob('../outside/*.mjs', { eager: true });\n",
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /import\.meta\.glob module discovery/,
  );
  await writeFile(mainPath, "import './hidden.svg';\n");
  await writeFile(
    path.join(rootDir, 'apps/studio/src/hidden.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>location="//attacker.invalid"</script></svg>\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /module uses an unreviewed module type.*hidden\.svg/,
  );
  await writeFile(mainPath, 'export {};\n');

  const indexPath = path.join(rootDir, 'apps/studio/index.html');
  await writeFile(
    indexPath,
    '<!doctype html><html><body><script type="module" src="/src/main.tsx"></script><script type="module" src="/hidden.mjs"></script></body></html>\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /must load only the reviewed \/src\/main\.tsx module entry/,
  );
  await writeFile(
    indexPath,
    '<!doctype html><html><body><script type="module" src="/src/main.tsx"></script></body></html>\n',
  );

  await writeFile(
    indexPath,
    '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=//attacker.invalid"></head><body><script type="module" src="/src/main.tsx"></script></body></html>\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /meta refresh navigation/,
  );
  await writeFile(
    indexPath,
    '<!doctype html><html><body><a href="//attacker.invalid">remote</a><script type="module" src="/src/main.tsx"></script></body></html>\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /protocol-relative remote URL/,
  );
  await writeFile(
    indexPath,
    '<!doctype html><html><body><script type="module" src="/src/main.tsx"></script></body></html>\n',
  );

  await writeFile(
    path.join(rootDir, 'packages/project-model/src/hidden.ts'),
    "export const hidden = () => fetch('https://example.com');\n",
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /packages.*Hidden network API|Hidden network API.*packages/,
  );

  await writeFile(
    path.join(rootDir, 'packages/project-model/src/hidden.ts'),
    'export const localOnly = true;\n',
  );
  await writeFile(
    path.join(rootDir, 'apps/desktop/src-tauri/src/hidden.rs'),
    'fn hidden() { let _ = std::net::TcpStream::connect("127.0.0.1:1"); }\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*std::net/,
  );

  await writeFile(
    path.join(rootDir, 'apps/desktop/src-tauri/src/hidden.rs'),
    'use libc::{socket, AF_INET, SOCK_STREAM};\nfn hidden() { unsafe { socket(AF_INET, SOCK_STREAM, 0); } }\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*libc imports/,
  );

  await writeFile(
    path.join(rootDir, 'apps/desktop/src-tauri/src/hidden.rs'),
    'use reqwest as transport;\nfn hidden() { let _ = transport::Client::new(); }\n',
  );
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /Hidden network API.*reqwest/,
  );
});

test('pins the only local Elastic Audio Worker bootstrap exactly', async () => {
  const rootDir = await createReleaseSource();
  const workerPath = path.join(
    rootDir,
    'apps/studio/src/audio/audioWarpThread.ts',
  );
  await mkdir(path.dirname(workerPath), { recursive: true });
  await copyFile(
    new URL('../../studio/src/audio/audioWarpThread.ts', import.meta.url),
    workerPath,
  );
  await validateNoHiddenNetworkCalls({ rootDir });

  const reviewed = await readFile(workerPath, 'utf8');
  await writeFile(workerPath, `${reviewed}\nexport const unreviewed = true;\n`);
  await assert.rejects(
    validateNoHiddenNetworkCalls({ rootDir }),
    /reviewed local Elastic Audio Worker bootstrap does not match/,
  );
});

test('rejects network primitives injected into final renderer assets', async () => {
  const distDir = await mkdtemp(path.join(os.tmpdir(), 'cts-renderer-assets-'));
  await mkdir(path.join(distDir, 'assets'), { recursive: true });
  const redirectsPath = path.join(distDir, '_redirects');
  await writeFile(
    redirectsPath,
    await readFile(new URL('../../studio/public/_redirects', import.meta.url)),
  );
  await writeFile(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-safe.js"></script></head><body></body></html>\n',
  );
  const entryPath = path.join(distDir, 'assets/index-safe.js');
  await writeFile(entryPath, 'globalThis.__CTS_SAFE__ = true;\n');
  await assert.rejects(
    validateBuiltRendererAssets({ distDir }),
    /Unsupported renderer-assets profile/,
  );
  await validateBuiltRendererAssets({ distDir, profile: 'production' });

  await writeFile(
    entryPath,
    "new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.example.com:3478' }] });\n",
  );
  await assert.rejects(
    validateBuiltRendererAssets({ distDir, profile: 'production' }),
    /Built renderer contains a forbidden network primitive.*RTCPeerConnection/,
  );

  await writeFile(entryPath, "globalThis.endpoint = 'https://attacker.invalid/collect';\n");
  await assert.rejects(
    validateBuiltRendererAssets({ distDir, profile: 'production' }),
    /Built renderer contains an unreviewed remote URL/,
  );

  await writeFile(entryPath, "globalThis.endpoint = '//attacker.invalid/collect';\n");
  await assert.rejects(
    validateBuiltRendererAssets({ distDir, profile: 'production' }),
    /protocol-relative remote URL/,
  );
  await writeFile(entryPath, 'globalThis.__CTS_SAFE__ = true;\n');

  await writeFile(redirectsPath, '/* https://attacker.invalid/:splat 302\n');
  await assert.rejects(
    validateBuiltRendererAssets({ distDir, profile: 'production' }),
    /_redirects does not match the production deployment allowlist/,
  );
  await writeFile(
    redirectsPath,
    await readFile(new URL('../../studio/public/_redirects', import.meta.url)),
  );

  const hiddenHtmlPath = path.join(distDir, 'hidden.html');
  await writeFile(hiddenHtmlPath, '<script>location="//attacker.invalid"</script>\n');
  await assert.rejects(
    validateBuiltRendererAssets({ distDir, profile: 'production' }),
    /Built renderer HTML inventory.*allowlist/,
  );
  await rm(hiddenHtmlPath);

  const mixedCaseHtmlPath = path.join(distDir, 'hidden.HTML');
  await writeFile(mixedCaseHtmlPath, '<script type="module" src="/assets/index-safe.js"></script>\n');
  await assert.rejects(
    validateBuiltRendererAssets({ distDir, profile: 'production' }),
    /Built renderer HTML inventory.*allowlist/,
  );
  await rm(mixedCaseHtmlPath);

  const hiddenSvgPath = path.join(distDir, 'assets/hidden.svg');
  await writeFile(
    hiddenSvgPath,
    '<svg xmlns="http://www.w3.org/2000/svg"><script>location="//attacker.invalid"</script></svg>\n',
  );
  await assert.rejects(
    validateBuiltRendererAssets({ distDir, profile: 'production' }),
    /unreviewed file type.*hidden\.svg/,
  );
  await rm(hiddenSvgPath);

  const indexPath = path.join(distDir, 'index.html');
  await writeFile(
    indexPath,
    '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=//attacker.invalid"><script type="module" crossorigin src="/assets/index-safe.js"></script></head></html>\n',
  );
  await assert.rejects(
    validateBuiltRendererAssets({ distDir, profile: 'production' }),
    /meta refresh navigation/,
  );
  await writeFile(
    indexPath,
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-safe.js"></script></head><body></body></html>\n',
  );

  await rm(entryPath);
  await assert.rejects(
    validateBuiltRendererAssets({ distDir, profile: 'production' }),
    /module entry is missing/,
  );
});

test('manual dispatch fails closed without explicit confirmation', async () => {
  const rootDir = await createReleaseSource();
  await assert.rejects(
    validateReleaseIdentity({
      rootDir,
      tag: 'v1.2.3',
      sha,
      ref: 'refs/tags/v1.2.3',
      event: 'workflow_dispatch',
      confirmed: 'false',
    }),
    /requires confirm_signed_release=true/,
  );
});

test('environment validation reports names without exposing values', () => {
  assert.deepEqual(requireEnvironment(['TOKEN'], { TOKEN: 'secret' }), ['TOKEN']);
  assert.throws(() => requireEnvironment(['TOKEN', 'CERT'], { TOKEN: 'secret' }), /CERT/);
});

test('runtime license policy accepts permissive alternatives and rejects unknown-only licenses', () => {
  assert.equal(evaluateLicenseExpression('(MIT OR Apache-2.0) AND Unicode-3.0').allowed, true);
  assert.equal(evaluateLicenseExpression('MIT OR LGPL-2.1-or-later').allowed, true);
  assert.equal(evaluateLicenseExpression('GPL-3.0-only').allowed, false);
  assert.equal(evaluateLicenseExpression('(MIT OR GPL-3.0-only) AND Proprietary').allowed, false);
  assert.equal(evaluateLicenseExpression(null).allowed, false);
});

async function createLinuxBuild(rootDir, marker = null) {
  const release = path.join(rootDir, 'apps/desktop/src-tauri/target/release');
  const bundle = path.join(release, 'bundle/appimage');
  const extractionRoot = path.join(rootDir, 'appimage-extract/squashfs-root');
  const virtualFileModes = new Map();
  const setLinuxFileMode = async (filePath, mode) => {
    if (process.platform === 'win32') {
      virtualFileModes.set(path.resolve(filePath), mode);
      return;
    }
    await chmod(filePath, mode);
  };
  const linuxFileMode =
    process.platform === 'win32'
      ? (filePath, fileInfo) =>
          virtualFileModes.get(path.resolve(filePath)) ?? fileInfo.mode
      : undefined;
  const packagedExecutable = path.join(
    extractionRoot,
    'usr/bin/compose-tutor-studio-desktop',
  );
  await mkdir(bundle, { recursive: true });
  const binary = Buffer.alloc(70 * 1024, 1);
  if (marker) binary.write(marker, 100, 'utf8');
  await writeFile(path.join(release, 'compose-tutor-studio-desktop'), binary);
  await mkdir(path.dirname(packagedExecutable), { recursive: true });
  await writeFile(packagedExecutable, binary);
  await setLinuxFileMode(packagedExecutable, 0o755);
  const appImage = Buffer.alloc(80 * 1024, 2);
  appImage.set([0x7f, 0x45, 0x4c, 0x46], 0);
  appImage.set([0x41, 0x49, 0x02], 8);
  const appImagePath = path.join(bundle, 'Compose_Tutor_Studio_1.2.3_amd64.AppImage');
  await writeFile(appImagePath, appImage);
  await setLinuxFileMode(appImagePath, 0o755);
  return {
    appImagePath,
    extractionRoot,
    packagedExecutable,
    appImageExtractor: async () => ({ root: extractionRoot, cleanup: async () => {} }),
    linuxFileMode,
    setLinuxFileMode,
  };
}

test('stages a bounded AppImage and records its checksums', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-stage-'));
  const outputDir = path.join(rootDir, 'output');
  const { appImageExtractor, linuxFileMode } = await createLinuxBuild(rootDir);
  const inventory = await stagePlatformArtifact({
    rootDir,
    outputDir,
    platform: 'linux',
    tag: 'v1.2.3',
    sha,
    verification: 'appimage-executable-sha256-identical',
    appImageExtractor,
    linuxFileMode,
  });
  assert.equal(inventory.artifact.bytes, 80 * 1024);
  assert.match(inventory.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(inventory.packagedExecutable.path, 'usr/bin/compose-tutor-studio-desktop');
  assert.equal(inventory.packagedExecutable.bytes, inventory.executable.bytes);
  assert.equal(inventory.packagedExecutable.sha256, inventory.executable.sha256);
  assert.deepEqual(inventory.packagedExecutable.identity, {
    algorithm: 'sha256',
    matchesStandalone: true,
  });
});

test('uses the signed universal DMG and NSIS output paths for commercial platforms', async () => {
  for (const fixture of [
    {
      platform: 'macos',
      release: 'apps/desktop/src-tauri/target/universal-apple-darwin/release',
      artifactDirectory: 'bundle/dmg',
      executable: 'compose-tutor-studio-desktop',
      artifact: 'Compose Tutor Studio_1.2.3_universal.dmg',
      verification: 'signed-notarized-stapled-universal',
    },
    {
      platform: 'windows',
      release: 'apps/desktop/src-tauri/target/release',
      artifactDirectory: 'bundle/nsis',
      executable: 'compose-tutor-studio-desktop.exe',
      artifact: 'Compose Tutor Studio_1.2.3_x64-setup.exe',
      verification: 'authenticode-sha256-rfc3161',
    },
  ]) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), `cts-release-${fixture.platform}-`));
    const release = path.join(rootDir, fixture.release);
    const bundle = path.join(release, fixture.artifactDirectory);
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(release, fixture.executable), Buffer.alloc(70 * 1024, 3));
    await writeFile(path.join(bundle, fixture.artifact), Buffer.alloc(80 * 1024, 4));
    const inventory = await stagePlatformArtifact({
      rootDir,
      outputDir: path.join(rootDir, 'output'),
      platform: fixture.platform,
      tag: 'v1.2.3',
      sha,
      verification: fixture.verification,
    });
    assert.equal(inventory.artifact.filename, fixture.artifact);
  }
});

test('rejects an ambiguous platform bundle with multiple distribution artifacts', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-count-'));
  const { appImageExtractor, linuxFileMode } = await createLinuxBuild(rootDir);
  await writeFile(
    path.join(
      rootDir,
      'apps/desktop/src-tauri/target/release/bundle/appimage/duplicate.AppImage',
    ),
    Buffer.alloc(80 * 1024, 5),
  );
  await assert.rejects(
    stagePlatformArtifact({
      rootDir,
      outputDir: path.join(rootDir, 'output'),
      platform: 'linux',
      tag: 'v1.2.3',
      sha,
      verification: 'appimage-executable-sha256-identical',
      appImageExtractor,
      linuxFileMode,
    }),
    /exactly one linux .* artifact, found 2/,
  );
});

test('rejects a non-executable or malformed AppImage before staging', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-appimage-format-'));
  const fixture = await createLinuxBuild(rootDir);
  const { appImageExtractor, linuxFileMode } = fixture;
  const appImage = path.join(
    rootDir,
    'apps/desktop/src-tauri/target/release/bundle/appimage/Compose_Tutor_Studio_1.2.3_amd64.AppImage',
  );
  await fixture.setLinuxFileMode(appImage, 0o644);
  await assert.rejects(
    stagePlatformArtifact({
      rootDir,
      outputDir: path.join(rootDir, 'output'),
      platform: 'linux',
      tag: 'v1.2.3',
      sha,
      verification: 'appimage-executable-sha256-identical',
      appImageExtractor,
      linuxFileMode,
    }),
    /executable mode bit/,
  );
  await fixture.setLinuxFileMode(appImage, 0o755);
  await writeFile(appImage, Buffer.alloc(80 * 1024, 9));
  await assert.rejects(
    stagePlatformArtifact({
      rootDir,
      outputDir: path.join(rootDir, 'output'),
      platform: 'linux',
      tag: 'v1.2.3',
      sha,
      verification: 'appimage-executable-sha256-identical',
      appImageExtractor,
      linuxFileMode,
    }),
    /ELF and AppImage magic/,
  );
});

test('rejects a non-executable product binary extracted from an AppImage', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-packaged-mode-'));
  const fixture = await createLinuxBuild(rootDir);
  await fixture.setLinuxFileMode(fixture.packagedExecutable, 0o644);
  await assert.rejects(
    stagePlatformArtifact({
      rootDir,
      outputDir: path.join(rootDir, 'output'),
      platform: 'linux',
      tag: 'v1.2.3',
      sha,
      verification: 'appimage-executable-sha256-identical',
      appImageExtractor: fixture.appImageExtractor,
      linuxFileMode: fixture.linuxFileMode,
    }),
    /Extracted Linux product executable must be a regular executable file/,
  );
});

test('rejects a production executable containing any test-only runtime marker', async () => {
  for (const marker of runtimeTestOnlyMarkers) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-marker-'));
    const { appImageExtractor, linuxFileMode } = await createLinuxBuild(rootDir, marker);
    await assert.rejects(
      stagePlatformArtifact({
        rootDir,
        outputDir: path.join(rootDir, 'output'),
        platform: 'linux',
        tag: 'v1.2.3',
        sha,
        verification: 'appimage-executable-sha256-identical',
        appImageExtractor,
        linuxFileMode,
      }),
      new RegExp(`test-only marker: ${marker}`),
    );
  }
});

test('rejects every test-only runtime marker in the extracted AppImage executable', async () => {
  for (const marker of runtimeTestOnlyMarkers) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-packaged-marker-'));
    const { appImageExtractor, linuxFileMode, packagedExecutable } =
      await createLinuxBuild(rootDir);
    const packagedBytes = Buffer.alloc(70 * 1024, 1);
    packagedBytes.write(marker, 100, 'utf8');
    await writeFile(packagedExecutable, packagedBytes);
    await assert.rejects(
      stagePlatformArtifact({
        rootDir,
        outputDir: path.join(rootDir, 'output'),
        platform: 'linux',
        tag: 'v1.2.3',
        sha,
        verification: 'appimage-executable-sha256-identical',
        appImageExtractor,
        linuxFileMode,
      }),
      new RegExp(`Extracted Linux product executable contains test-only marker: ${marker}`),
    );
  }
});

test('rejects a packaged executable that is not byte-identical to the standalone executable', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-packaged-identity-'));
  const { appImageExtractor, linuxFileMode, packagedExecutable } =
    await createLinuxBuild(rootDir);
  await writeFile(packagedExecutable, Buffer.alloc(70 * 1024, 7));
  await assert.rejects(
    stagePlatformArtifact({
      rootDir,
      outputDir: path.join(rootDir, 'output'),
      platform: 'linux',
      tag: 'v1.2.3',
      sha,
      verification: 'appimage-executable-sha256-identical',
      appImageExtractor,
      linuxFileMode,
    }),
    /not byte-identical to the standalone production executable/,
  );
});

test('rejects an AppImage that changes after extraction and before staging', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-appimage-race-'));
  const fixture = await createLinuxBuild(rootDir);
  const mutatingExtractor = async () => {
    const changedAppImage = await readFile(fixture.appImagePath);
    changedAppImage[changedAppImage.length - 1] ^= 0xff;
    await writeFile(fixture.appImagePath, changedAppImage);
    await fixture.setLinuxFileMode(fixture.appImagePath, 0o755);
    return fixture.appImageExtractor();
  };
  await assert.rejects(
    stagePlatformArtifact({
      rootDir,
      outputDir: path.join(rootDir, 'output'),
      platform: 'linux',
      tag: 'v1.2.3',
      sha,
      verification: 'appimage-executable-sha256-identical',
      appImageExtractor: mutatingExtractor,
      linuxFileMode: fixture.linuxFileMode,
    }),
    /AppImage changed while its packaged executable identity was being verified/,
  );
});

test('rejects multiple product executable entries in an extracted AppImage', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-packaged-count-'));
  const fixture = await createLinuxBuild(rootDir);
  const { appImageExtractor, extractionRoot, linuxFileMode } = fixture;
  const duplicate = path.join(extractionRoot, 'opt/compose-tutor-studio-desktop');
  await mkdir(path.dirname(duplicate), { recursive: true });
  await writeFile(duplicate, Buffer.alloc(70 * 1024, 1));
  await fixture.setLinuxFileMode(duplicate, 0o755);
  await assert.rejects(
    stagePlatformArtifact({
      rootDir,
      outputDir: path.join(rootDir, 'output'),
      platform: 'linux',
      tag: 'v1.2.3',
      sha,
      verification: 'appimage-executable-sha256-identical',
      appImageExtractor,
      linuxFileMode,
    }),
    /exactly one extracted Linux product executable, found 2/,
  );
});

test('finalization verifies platform inventories and emits deterministic SHA256SUMS', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cts-release-final-'));
  const candidate = path.join(rootDir, 'candidate');
  const verifications = {
    linux: 'appimage-executable-sha256-identical',
    macos: 'signed-notarized-stapled-universal',
    windows: 'authenticode-sha256-rfc3161',
  };
  for (const [platform, verification] of Object.entries(verifications)) {
    const directory = path.join(candidate, platform);
    await mkdir(directory, { recursive: true });
    const extensions = { linux: '.AppImage', macos: '.dmg', windows: '.exe' };
    const filename = `${platform}${extensions[platform]}`;
    const contents = Buffer.alloc(70 * 1024, platform.charCodeAt(0));
    const artifactPath = path.join(directory, filename);
    await writeFile(artifactPath, contents);
    const { createHash } = await import('node:crypto');
    await writeFile(
      path.join(directory, 'artifact-inventory.json'),
      JSON.stringify({
        schemaVersion: 1,
        platform,
        release: { tag: 'v1.2.3', sha },
        verification,
        artifact: {
          filename,
          bytes: contents.length,
          sha256: createHash('sha256').update(contents).digest('hex'),
          ...(platform === 'linux' ? { format: 'elf-appimage', executableMode: true } : {}),
        },
        executable: {
          bytes: 70 * 1024,
          sha256: 'a'.repeat(64),
          testOnlyMarkers: 'absent',
        },
        ...(platform === 'linux'
          ? {
              packagedExecutable: {
                path: 'usr/bin/compose-tutor-studio-desktop',
                bytes: 70 * 1024,
                sha256: 'a'.repeat(64),
                testOnlyMarkers: 'absent',
                identity: { algorithm: 'sha256', matchesStandalone: true },
              },
            }
          : {}),
      }),
    );
  }
  const metadata = path.join(candidate, 'metadata');
  await mkdir(metadata, { recursive: true });
  await writeFile(
    path.join(metadata, 'build-sbom.spdx.json'),
    JSON.stringify({
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: 'compose-tutor-studio-v1.2.3',
      documentNamespace: `https://github.com/example/repo/releases/tag/v1.2.3/sbom-${sha}`,
      packages: [{ name: 'dependency' }],
    }),
  );
  await writeFile(path.join(metadata, 'cargo-dependencies.json'), '[{"name":"crate"}]');
  await writeFile(path.join(metadata, 'THIRD_PARTY_NOTICES.md'), '# notices');
  await writeFile(
    path.join(metadata, 'runtime-licenses.json'),
    JSON.stringify({
      schemaVersion: 1,
      release: { tag: 'v1.2.3', version: '1.2.3', sha, repository: 'example/repo' },
      projectLicense: 'NOASSERTION',
      runtimeComponents: [{ purl: 'pkg:npm/react@1.0.0', license: 'MIT' }],
    }),
  );
  const first = await finalizeCandidate({ inputDir: candidate, tag: 'v1.2.3', sha });
  const firstChecksums = await readFile(path.join(candidate, 'SHA256SUMS'), 'utf8');
  const second = await finalizeCandidate({ inputDir: candidate, tag: 'v1.2.3', sha });
  const secondChecksums = await readFile(path.join(candidate, 'SHA256SUMS'), 'utf8');
  assert.deepEqual(second, first);
  assert.equal(secondChecksums, firstChecksums);
  assert.match(firstChecksums, /metadata\/runtime-licenses\.json/);

  const linuxInventoryPath = path.join(candidate, 'linux/artifact-inventory.json');
  const linuxInventory = JSON.parse(await readFile(linuxInventoryPath, 'utf8'));
  await writeFile(linuxInventoryPath, JSON.stringify({ ...linuxInventory, schemaVersion: 2 }));
  await assert.rejects(
    finalizeCandidate({ inputDir: candidate, tag: 'v1.2.3', sha }),
    /Invalid linux artifact inventory/,
  );
  const linuxInventoryWithoutSchema = { ...linuxInventory };
  delete linuxInventoryWithoutSchema.schemaVersion;
  await writeFile(linuxInventoryPath, JSON.stringify(linuxInventoryWithoutSchema));
  await assert.rejects(
    finalizeCandidate({ inputDir: candidate, tag: 'v1.2.3', sha }),
    /Invalid linux artifact inventory/,
  );
  await writeFile(linuxInventoryPath, JSON.stringify(linuxInventory));

  const linuxInventoryWithoutPackagedExecutable = { ...linuxInventory };
  delete linuxInventoryWithoutPackagedExecutable.packagedExecutable;
  await writeFile(linuxInventoryPath, JSON.stringify(linuxInventoryWithoutPackagedExecutable));
  await assert.rejects(
    finalizeCandidate({ inputDir: candidate, tag: 'v1.2.3', sha }),
    /Invalid linux artifact inventory/,
  );
  await writeFile(
    linuxInventoryPath,
    JSON.stringify({
      ...linuxInventory,
      packagedExecutable: {
        ...linuxInventory.packagedExecutable,
        sha256: 'b'.repeat(64),
      },
    }),
  );
  await assert.rejects(
    finalizeCandidate({ inputDir: candidate, tag: 'v1.2.3', sha }),
    /Invalid linux artifact inventory/,
  );
  await writeFile(linuxInventoryPath, JSON.stringify(linuxInventory));

  const runtimeInventoryPath = path.join(candidate, 'metadata/runtime-licenses.json');
  const runtimeInventory = JSON.parse(await readFile(runtimeInventoryPath, 'utf8'));
  await writeFile(runtimeInventoryPath, JSON.stringify({ ...runtimeInventory, schemaVersion: 2 }));
  await assert.rejects(
    finalizeCandidate({ inputDir: candidate, tag: 'v1.2.3', sha }),
    /Runtime license inventory does not match/,
  );
  const runtimeInventoryWithoutSchema = { ...runtimeInventory };
  delete runtimeInventoryWithoutSchema.schemaVersion;
  await writeFile(runtimeInventoryPath, JSON.stringify(runtimeInventoryWithoutSchema));
  await assert.rejects(
    finalizeCandidate({ inputDir: candidate, tag: 'v1.2.3', sha }),
    /Runtime license inventory does not match/,
  );
});
