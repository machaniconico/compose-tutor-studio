import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');

const checks = [];

function pass(label) {
  checks.push({ label, ok: true });
  console.log(`PASS ${label}`);
}

function fail(label, detail) {
  checks.push({ label, ok: false });
  console.error(`FAIL ${label}: ${detail}`);
}

async function readText(path) {
  return readFile(path, 'utf8');
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function assertEqual(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(label, `expected ${expected}, got ${actual}`);
}

async function assertFile(label, path) {
  if (await exists(path)) pass(label);
  else fail(label, `missing ${path}`);
}

function assertContains(label, text, pattern) {
  const matched = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
  if (matched) pass(label);
  else fail(label, `missing ${pattern.toString()}`);
}

function cargoVersion(cargoToml) {
  const match = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? null;
}

const releaseGateReportCommands = [
  'pnpm check',
  'pnpm check:privacy',
  'pnpm check:secrets',
  'pnpm check:assets',
  'pnpm build',
  'pnpm check:size',
  'pnpm test:e2e',
  'pnpm build:desktop',
  'pnpm check:size:desktop',
  'pnpm release:manifest',
  'pnpm release:source-status',
  'pnpm release:source-status:verify',
  'pnpm release:verify',
  'pnpm release:installers:verify',
  'pnpm release:installers:smoke:plan',
  'pnpm release:installers:smoke:verify',
  'pnpm release:signing',
  'pnpm release:signing:verify',
  'pnpm release:notices',
  'pnpm release:notices:verify',
  'pnpm release:notes',
  'pnpm release:notes:verify:draft',
  'pnpm check:release',
];

const qaLogAutomatedCommands = [
  'pnpm check',
  'pnpm check:privacy',
  'pnpm check:secrets',
  'pnpm check:assets',
  'pnpm build',
  'pnpm check:size',
  'pnpm test:e2e',
  'pnpm build:desktop',
  'pnpm check:size:desktop',
  'pnpm release:manifest',
  'pnpm release:source-status',
  'pnpm release:source-status:verify',
  'pnpm release:verify',
  'pnpm release:verify:publish',
  'pnpm release:installers:verify',
  'pnpm release:installers:smoke:plan',
  'pnpm release:installers:smoke:verify',
  'pnpm release:signing',
  'pnpm release:signing:verify',
  'pnpm release:notices',
  'pnpm release:notices:verify',
  'pnpm release:gates:report',
  'pnpm release:qa-log',
  'pnpm release:qa-log:verify:draft',
  'pnpm release:notes',
  'pnpm release:notes:verify:draft',
  'pnpm check:release',
];

function stringArrayConstant(text, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`const\\s+${escapedName}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function assertArrayEqual(label, actual, expected) {
  if (!actual) {
    fail(label, 'missing command array');
    return;
  }

  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) pass(label);
  else fail(label, `expected ${expectedJson}, got ${actualJson}`);
}

async function checkVersions() {
  const rootPackage = await readJson(join(repoRoot, 'package.json'));
  const studioPackage = await readJson(join(appRoot, 'package.json'));
  const tauriConfig = await readJson(join(appRoot, 'src-tauri', 'tauri.conf.json'));
  const cargoToml = await readText(join(appRoot, 'src-tauri', 'Cargo.toml'));

  assertEqual('root/studio package version match', studioPackage.version, rootPackage.version);
  assertEqual('Tauri version matches package version', tauriConfig.version, studioPackage.version);
  assertEqual('Cargo version matches package version', cargoVersion(cargoToml), studioPackage.version);
}

async function checkReleaseScripts() {
  const rootPackage = await readJson(join(repoRoot, 'package.json'));
  const studioPackage = await readJson(join(appRoot, 'package.json'));

  assertEqual(
    'root release manifest script',
    rootPackage.scripts?.['release:manifest'],
    'pnpm --filter @cts/studio release:manifest',
  );
  assertEqual(
    'root release source status script',
    rootPackage.scripts?.['release:source-status'],
    'pnpm --filter @cts/studio release:source-status',
  );
  assertEqual(
    'root release source status verify script',
    rootPackage.scripts?.['release:source-status:verify'],
    'pnpm --filter @cts/studio release:source-status:verify',
  );
  assertEqual(
    'root release notices script',
    rootPackage.scripts?.['release:notices'],
    'pnpm --filter @cts/studio release:notices',
  );
  assertEqual(
    'root release notices verify script',
    rootPackage.scripts?.['release:notices:verify'],
    'pnpm --filter @cts/studio release:notices:verify',
  );
  assertEqual(
    'root release signing script',
    rootPackage.scripts?.['release:signing'],
    'pnpm --filter @cts/studio release:signing',
  );
  assertEqual(
    'root release signing verify script',
    rootPackage.scripts?.['release:signing:verify'],
    'pnpm --filter @cts/studio release:signing:verify',
  );
  assertEqual(
    'root privacy check script',
    rootPackage.scripts?.['check:privacy'],
    'pnpm --filter @cts/studio check:privacy',
  );
  assertEqual(
    'root release secret check script',
    rootPackage.scripts?.['check:secrets'],
    'pnpm --filter @cts/studio check:secrets',
  );
  assertEqual(
    'root source asset policy script',
    rootPackage.scripts?.['check:assets'],
    'pnpm --filter @cts/studio check:assets',
  );
  assertEqual(
    'root release archive script',
    rootPackage.scripts?.['release:archive'],
    'pnpm --filter @cts/studio release:archive',
  );
  assertEqual(
    'root release archive verify script',
    rootPackage.scripts?.['release:archive:verify'],
    'pnpm --filter @cts/studio release:archive:verify',
  );
  assertEqual(
    'root release gates report script',
    rootPackage.scripts?.['release:gates:report'],
    'pnpm --filter @cts/studio release:gates:report',
  );
  assertEqual(
    'root release verify script',
    rootPackage.scripts?.['release:verify'],
    'pnpm --filter @cts/studio release:verify',
  );
  assertEqual(
    'root release publish verify script',
    rootPackage.scripts?.['release:verify:publish'],
    'pnpm --filter @cts/studio release:verify:publish',
  );
  assertEqual(
    'root release installer metadata verify script',
    rootPackage.scripts?.['release:installers:verify'],
    'pnpm --filter @cts/studio release:installers:verify',
  );
  assertEqual(
    'root release installer smoke plan script',
    rootPackage.scripts?.['release:installers:smoke:plan'],
    'pnpm --filter @cts/studio release:installers:smoke:plan',
  );
  assertEqual(
    'root release installer smoke plan verify script',
    rootPackage.scripts?.['release:installers:smoke:verify'],
    'pnpm --filter @cts/studio release:installers:smoke:verify',
  );
  assertEqual(
    'root release QA log script',
    rootPackage.scripts?.['release:qa-log'],
    'pnpm --filter @cts/studio release:qa-log',
  );
  assertEqual(
    'root release QA log verify script',
    rootPackage.scripts?.['release:qa-log:verify'],
    'pnpm --filter @cts/studio release:qa-log:verify',
  );
  assertEqual(
    'root release QA log draft verify script',
    rootPackage.scripts?.['release:qa-log:verify:draft'],
    'pnpm --filter @cts/studio release:qa-log:verify:draft',
  );
  assertEqual(
    'root release notes script',
    rootPackage.scripts?.['release:notes'],
    'pnpm --filter @cts/studio release:notes',
  );
  assertEqual(
    'root release notes verify script',
    rootPackage.scripts?.['release:notes:verify'],
    'pnpm --filter @cts/studio release:notes:verify',
  );
  assertEqual(
    'root release notes draft verify script',
    rootPackage.scripts?.['release:notes:verify:draft'],
    'pnpm --filter @cts/studio release:notes:verify:draft',
  );
  assertEqual(
    'studio release manifest script',
    studioPackage.scripts?.['release:manifest'],
    'node ./scripts/createReleaseManifest.mjs',
  );
  assertEqual(
    'studio release source status script',
    studioPackage.scripts?.['release:source-status'],
    'node ./scripts/createSourceStatusReport.mjs',
  );
  assertEqual(
    'studio release source status verify script',
    studioPackage.scripts?.['release:source-status:verify'],
    'node ./scripts/verifySourceStatusReport.mjs',
  );
  assertEqual(
    'studio release notices script',
    studioPackage.scripts?.['release:notices'],
    'node ./scripts/createThirdPartyNotices.mjs',
  );
  assertEqual(
    'studio release notices verify script',
    studioPackage.scripts?.['release:notices:verify'],
    'node ./scripts/verifyThirdPartyNotices.mjs',
  );
  assertEqual(
    'studio release signing script',
    studioPackage.scripts?.['release:signing'],
    'node ./scripts/createSigningReport.mjs',
  );
  assertEqual(
    'studio release signing verify script',
    studioPackage.scripts?.['release:signing:verify'],
    'node ./scripts/verifySigningReport.mjs',
  );
  assertEqual(
    'studio privacy check script',
    studioPackage.scripts?.['check:privacy'],
    'node ./scripts/checkNoHiddenNetwork.mjs',
  );
  assertEqual(
    'studio release secret check script',
    studioPackage.scripts?.['check:secrets'],
    'node ./scripts/checkReleaseSecrets.mjs',
  );
  assertEqual(
    'studio source asset policy script',
    studioPackage.scripts?.['check:assets'],
    'node ./scripts/checkSourceAssetPolicy.mjs',
  );
  assertEqual(
    'studio release archive script',
    studioPackage.scripts?.['release:archive'],
    'node ./scripts/archiveReleaseEvidence.mjs',
  );
  assertEqual(
    'studio release archive verify script',
    studioPackage.scripts?.['release:archive:verify'],
    'node ./scripts/verifyReleaseArchive.mjs',
  );
  assertEqual(
    'studio release gates report script',
    studioPackage.scripts?.['release:gates:report'],
    'node ./scripts/createReleaseGateReport.mjs',
  );
  assertEqual(
    'studio release verify script',
    studioPackage.scripts?.['release:verify'],
    'node ./scripts/verifyReleaseArtifacts.mjs',
  );
  assertEqual(
    'studio release publish verify script',
    studioPackage.scripts?.['release:verify:publish'],
    'node ./scripts/verifyReleaseArtifacts.mjs --require-clean-source',
  );
  assertEqual(
    'studio release installer metadata verify script',
    studioPackage.scripts?.['release:installers:verify'],
    'node ./scripts/verifyInstallerMetadata.mjs',
  );
  assertEqual(
    'studio release installer smoke plan script',
    studioPackage.scripts?.['release:installers:smoke:plan'],
    'node ./scripts/createInstallerSmokePlan.mjs',
  );
  assertEqual(
    'studio release installer smoke plan verify script',
    studioPackage.scripts?.['release:installers:smoke:verify'],
    'node ./scripts/verifyInstallerSmokePlan.mjs',
  );
  assertEqual(
    'studio release QA log script',
    studioPackage.scripts?.['release:qa-log'],
    'node ./scripts/createReleaseQaLog.mjs',
  );
  assertEqual(
    'studio release QA log verify script',
    studioPackage.scripts?.['release:qa-log:verify'],
    'node ./scripts/verifyReleaseQaLog.mjs',
  );
  assertEqual(
    'studio release QA log draft verify script',
    studioPackage.scripts?.['release:qa-log:verify:draft'],
    'node ./scripts/verifyReleaseQaLog.mjs --allow-draft',
  );
  assertEqual(
    'studio release notes script',
    studioPackage.scripts?.['release:notes'],
    'node ./scripts/createReleaseNotes.mjs',
  );
  assertEqual(
    'studio release notes verify script',
    studioPackage.scripts?.['release:notes:verify'],
    'node ./scripts/verifyReleaseNotes.mjs',
  );
  assertEqual(
    'studio release notes draft verify script',
    studioPackage.scripts?.['release:notes:verify:draft'],
    'node ./scripts/verifyReleaseNotes.mjs --allow-draft',
  );
  await assertFile('release manifest script exists', join(appRoot, 'scripts', 'createReleaseManifest.mjs'));
  await assertFile('release source status script exists', join(appRoot, 'scripts', 'createSourceStatusReport.mjs'));
  await assertFile('release source status verify script exists', join(appRoot, 'scripts', 'verifySourceStatusReport.mjs'));
  await assertFile('release notices script exists', join(appRoot, 'scripts', 'createThirdPartyNotices.mjs'));
  await assertFile('release notices verify script exists', join(appRoot, 'scripts', 'verifyThirdPartyNotices.mjs'));
  await assertFile('release signing script exists', join(appRoot, 'scripts', 'createSigningReport.mjs'));
  await assertFile('release signing verify script exists', join(appRoot, 'scripts', 'verifySigningReport.mjs'));
  await assertFile('privacy check script exists', join(appRoot, 'scripts', 'checkNoHiddenNetwork.mjs'));
  await assertFile('release secret check script exists', join(appRoot, 'scripts', 'checkReleaseSecrets.mjs'));
  await assertFile('source asset policy script exists', join(appRoot, 'scripts', 'checkSourceAssetPolicy.mjs'));
  await assertFile('release archive script exists', join(appRoot, 'scripts', 'archiveReleaseEvidence.mjs'));
  await assertFile('release archive verify script exists', join(appRoot, 'scripts', 'verifyReleaseArchive.mjs'));
  await assertFile('release gates report script exists', join(appRoot, 'scripts', 'createReleaseGateReport.mjs'));
  await assertFile('release verify script exists', join(appRoot, 'scripts', 'verifyReleaseArtifacts.mjs'));
  await assertFile('release installer metadata verify script exists', join(appRoot, 'scripts', 'verifyInstallerMetadata.mjs'));
  await assertFile('release installer smoke plan script exists', join(appRoot, 'scripts', 'createInstallerSmokePlan.mjs'));
  await assertFile('release installer smoke plan verify script exists', join(appRoot, 'scripts', 'verifyInstallerSmokePlan.mjs'));
  await assertFile('release QA log script exists', join(appRoot, 'scripts', 'createReleaseQaLog.mjs'));
  await assertFile('release QA log verify script exists', join(appRoot, 'scripts', 'verifyReleaseQaLog.mjs'));
  await assertFile('release notes script exists', join(appRoot, 'scripts', 'createReleaseNotes.mjs'));
  await assertFile('release notes verify script exists', join(appRoot, 'scripts', 'verifyReleaseNotes.mjs'));
}

async function checkReleaseCommandDefinitions() {
  const releaseGateReportScript = await readText(join(appRoot, 'scripts', 'createReleaseGateReport.mjs'));
  const createQaLogScript = await readText(join(appRoot, 'scripts', 'createReleaseQaLog.mjs'));
  const verifyQaLogScript = await readText(join(appRoot, 'scripts', 'verifyReleaseQaLog.mjs'));

  assertArrayEqual(
    'release gates report default commands match release checklist',
    stringArrayConstant(releaseGateReportScript, 'defaultGateCommands'),
    releaseGateReportCommands,
  );
  assertArrayEqual(
    'QA log release gate commands match release gates report',
    stringArrayConstant(createQaLogScript, 'releaseGateReportCommands'),
    releaseGateReportCommands,
  );
  assertArrayEqual(
    'QA log generated automated commands match verifier',
    stringArrayConstant(createQaLogScript, 'automatedGateCommands'),
    qaLogAutomatedCommands,
  );
  assertArrayEqual(
    'QA log verifier automated commands match generated QA log',
    stringArrayConstant(verifyQaLogScript, 'automatedGateCommands'),
    qaLogAutomatedCommands,
  );
}

async function checkTauriReleaseConfig() {
  const tauriConfig = await readJson(join(appRoot, 'src-tauri', 'tauri.conf.json'));
  const capabilities = await readJson(join(appRoot, 'src-tauri', 'capabilities', 'default.json'));

  assertContains('Tauri identifier is reverse-domain', tauriConfig.identifier, /^[a-z]+(\.[a-z0-9-]+){2,}$/);
  assertEqual('Tauri bundle is active', tauriConfig.bundle?.active, true);
  assertContains('Tauri bundle includes PNG icon', tauriConfig.bundle?.icon ?? [], 'icons/icon.png');
  assertContains('Tauri bundle includes ICO icon', tauriConfig.bundle?.icon ?? [], 'icons/icon.ico');
  assertContains(
    'MSI upgradeCode is fixed UUID',
    tauriConfig.bundle?.windows?.wix?.upgradeCode ?? '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  await assertFile('PNG icon exists', join(appRoot, 'src-tauri', 'icons', 'icon.png'));
  await assertFile('ICO icon exists', join(appRoot, 'src-tauri', 'icons', 'icon.ico'));
  assertContains('Dialog permission enabled', capabilities.permissions ?? [], 'dialog:default');
  assertContains('Filesystem permission enabled', capabilities.permissions ?? [], 'fs:default');
}

async function checkPinnedBuildWorkaround() {
  const cargoLock = await readText(join(appRoot, 'src-tauri', 'Cargo.lock'));
  assertContains('time crate pinned to 0.3.47', cargoLock, /name = "time"\r?\nversion = "0\.3\.47"/);
}

async function checkPnpmBuildApprovals() {
  const workspaceConfig = await readText(join(repoRoot, 'pnpm-workspace.yaml'));
  assertContains('pnpm workspace allows esbuild build scripts', workspaceConfig, /allowBuilds:\s*\r?\n\s+esbuild:\s+true/);
}

async function checkCiGates() {
  const ci = await readText(join(repoRoot, '.github', 'workflows', 'ci.yml'));
  for (const command of [
    'pnpm typecheck',
    'pnpm test',
    'pnpm check:privacy',
    'pnpm check:secrets',
    'pnpm check:assets',
    'pnpm build',
    'pnpm check:size',
    'pnpm test:e2e',
    'pnpm build:desktop',
    'pnpm check:size:desktop',
    'pnpm release:manifest',
    'pnpm release:source-status',
    'pnpm release:source-status:verify',
    'pnpm release:verify',
    'pnpm release:verify:publish',
    'pnpm release:installers:verify',
    'pnpm release:installers:smoke:plan',
    'pnpm release:installers:smoke:verify',
    'pnpm release:signing',
    'pnpm release:signing:verify',
    'pnpm release:notices',
    'pnpm release:notices:verify',
    'pnpm release:qa-log',
    'pnpm release:qa-log:verify:draft',
    'pnpm release:notes',
    'pnpm release:notes:verify:draft',
    'pnpm check:release',
  ]) {
    assertContains(`CI runs ${command}`, ci, command);
  }

  for (const phrase of [
    'actions/upload-artifact@v7',
    'cts-windows-release-candidate-${{ github.sha }}',
    'apps/studio/src-tauri/target/release/cts-studio.exe',
    'apps/studio/src-tauri/target/release/bundle/msi/*.msi',
    'apps/studio/src-tauri/target/release/bundle/nsis/*.exe',
    'apps/studio/src-tauri/target/release/release/**',
    'if-no-files-found: error',
    'retention-days: 30',
    'compression-level: 0',
    'include-hidden-files: false',
  ]) {
    assertContains(`CI uploads release candidate ${phrase}`, ci, phrase);
  }
}

async function checkReleaseDocs() {
  const releaseGate = await readText(join(repoRoot, 'docs', '11_release_gate.md'));
  const qaPlan = await readText(join(repoRoot, 'docs', '08_qa_test_plan.md'));
  const qaLog = await readText(join(repoRoot, 'docs', '12_release_qa_log.md'));
  const distributionNotes = await readText(join(repoRoot, 'docs', '13_distribution_release_notes.md'));
  const signingPlan = await readText(join(repoRoot, 'docs', '14_signing_and_update_plan.md'));
  const privacyPolicy = await readText(join(repoRoot, 'docs', '15_privacy_network_policy.md'));
  const desktopBuild = await readText(join(repoRoot, 'docs', '07_desktop_build.md'));

  for (const command of [
    'pnpm check',
    'pnpm check:privacy',
    'pnpm check:secrets',
    'pnpm check:assets',
    'pnpm build',
    'pnpm check:size',
    'pnpm test:e2e',
    'pnpm build:desktop',
    'pnpm check:size:desktop',
    'pnpm release:manifest',
    'pnpm release:source-status',
    'pnpm release:source-status:verify',
    'pnpm release:verify',
    'pnpm release:installers:verify',
    'pnpm release:installers:smoke:plan',
    'pnpm release:installers:smoke:verify',
    'pnpm release:signing',
    'pnpm release:signing:verify',
    'pnpm release:notices',
    'pnpm release:notices:verify',
    'pnpm release:qa-log',
    'pnpm release:qa-log:verify',
    'pnpm release:qa-log:verify:draft',
    'pnpm release:notes',
    'pnpm release:notes:verify',
    'pnpm release:notes:verify:draft',
    'pnpm check:release',
  ]) {
    assertContains(`release gate documents ${command}`, releaseGate, command);
  }

  for (const phrase of [
    'インストーラ',
    'サンプル曲',
    '保存',
    '再起動',
    '読み込み',
    '別タイトル',
    'OS 標準ファイルダイアログ',
    'MIDI',
    'WAV',
    '診断ログ',
    'サポート画面',
    '未処理エラー画面',
    'SHA-256',
  ]) {
    assertContains(`manual QA includes ${phrase}`, releaseGate, phrase);
  }

  assertContains('QA plan links release gate', qaPlan, 'docs/11_release_gate.md');
  assertContains('QA plan links QA log', qaPlan, 'docs/12_release_qa_log.md');
  assertContains('QA plan links distribution notes', qaPlan, 'docs/13_distribution_release_notes.md');
  assertContains('QA plan links signing plan', qaPlan, 'docs/14_signing_and_update_plan.md');
  assertContains('QA plan links privacy policy', qaPlan, 'docs/15_privacy_network_policy.md');
  assertContains('QA plan mentions QA log strict verify', qaPlan, 'pnpm release:qa-log:verify');
  assertContains('QA plan mentions release notes strict verify', qaPlan, 'pnpm release:notes:verify');
  assertContains('QA plan mentions release notices', qaPlan, 'pnpm release:notices');
  assertContains('QA plan mentions release notices verify', qaPlan, 'pnpm release:notices:verify');
  assertContains('QA plan mentions release signing', qaPlan, 'pnpm release:signing');
  assertContains('QA plan mentions release signing verify', qaPlan, 'pnpm release:signing:verify');
  assertContains('QA plan mentions installer metadata verify', qaPlan, 'pnpm release:installers:verify');
  assertContains('QA plan mentions installer smoke plan', qaPlan, 'pnpm release:installers:smoke:plan');
  assertContains('QA plan mentions installer smoke plan verify', qaPlan, 'pnpm release:installers:smoke:verify');
  assertContains('QA plan mentions privacy check', qaPlan, 'pnpm check:privacy');
  assertContains('QA plan mentions release secret check', qaPlan, 'pnpm check:secrets');
  assertContains('QA plan mentions source asset policy', qaPlan, 'pnpm check:assets');
  assertContains('desktop build docs mention release gate', desktopBuild, 'docs/11_release_gate.md');
  assertContains('desktop build docs mention pnpm build approvals', desktopBuild, 'allowBuilds');
  assertContains('desktop build docs mention pnpm ignored builds', desktopBuild, 'pnpm ignored-builds');
  assertContains('desktop build docs mention release manifest', desktopBuild, 'release-manifest.json');
  assertContains('desktop build docs mention sourceControl', desktopBuild, 'sourceControl');
  assertContains('desktop build docs mention source status report', desktopBuild, 'pnpm release:source-status');
  assertContains('desktop build docs mention source status verify', desktopBuild, 'pnpm release:source-status:verify');
  assertContains('desktop build docs mention source status report json', desktopBuild, 'release-source-status-report.json');
  assertContains('desktop build docs mention third-party notices', desktopBuild, 'THIRD_PARTY_NOTICES.md');
  assertContains('desktop build docs mention release notices', desktopBuild, 'pnpm release:notices');
  assertContains('desktop build docs mention release notices verify', desktopBuild, 'pnpm release:notices:verify');
  assertContains('desktop build docs mention release signing', desktopBuild, 'pnpm release:signing');
  assertContains('desktop build docs mention release signing verify', desktopBuild, 'pnpm release:signing:verify');
  assertContains('desktop build docs mention release signing report', desktopBuild, 'release-signing-report.json');
  assertContains('desktop build docs mention privacy check', desktopBuild, 'pnpm check:privacy');
  assertContains('desktop build docs mention release secret check', desktopBuild, 'pnpm check:secrets');
  assertContains('desktop build docs mention source asset policy', desktopBuild, 'pnpm check:assets');
  assertContains('desktop build docs link privacy policy', desktopBuild, 'docs/15_privacy_network_policy.md');
  assertContains('desktop build docs mention release verify', desktopBuild, 'pnpm release:verify');
  assertContains('desktop build docs mention publish verify', desktopBuild, 'pnpm release:verify:publish');
  assertContains('desktop build docs mention installer metadata verify', desktopBuild, 'pnpm release:installers:verify');
  assertContains('desktop build docs mention installer metadata report', desktopBuild, 'release-installer-metadata-report.json');
  assertContains('desktop build docs mention installer smoke plan', desktopBuild, 'pnpm release:installers:smoke:plan');
  assertContains('desktop build docs mention installer smoke plan verify', desktopBuild, 'pnpm release:installers:smoke:verify');
  assertContains('desktop build docs mention installer smoke plan report', desktopBuild, 'release-installer-smoke-plan.json');
  assertContains('desktop build docs mention release gates report', desktopBuild, 'pnpm release:gates:report');
  assertContains('desktop build docs mention release gates report json', desktopBuild, 'release-gates-report.json');
  assertContains('desktop build docs mention release QA log', desktopBuild, 'release-qa-log-draft.md');
  assertContains('desktop build docs mention release QA log draft verify', desktopBuild, 'pnpm release:qa-log:verify:draft');
  assertContains('desktop build docs mention release QA log strict verify', desktopBuild, 'pnpm release:qa-log:verify');
  assertContains('desktop build docs mention release notes', desktopBuild, 'release-notes-draft.md');
  assertContains('desktop build docs mention release notes draft verify', desktopBuild, 'pnpm release:notes:verify:draft');
  assertContains('desktop build docs mention release notes strict verify', desktopBuild, 'pnpm release:notes:verify');
  assertContains('desktop build docs mention release archive', desktopBuild, 'pnpm release:archive');
  assertContains('desktop build docs mention release archive verify', desktopBuild, 'pnpm release:archive:verify');
  assertContains('desktop build docs mention archive source status summary', desktopBuild, 'Source Status Summary');
  assertContains('desktop build docs mention archive source status', desktopBuild, 'Source Status');
  assertContains('desktop build docs mention upload artifact action', desktopBuild, 'actions/upload-artifact@v7');
  assertContains('desktop build docs mention CI release candidate artifact', desktopBuild, 'cts-windows-release-candidate-${{ github.sha }}');
  assertContains('desktop build docs mention upgradeCode', desktopBuild, 'upgradeCode');
  assertContains('release gate links QA log', releaseGate, 'docs/12_release_qa_log.md');
  assertContains('release gate links distribution notes', releaseGate, 'docs/13_distribution_release_notes.md');
  assertContains('release gate links signing plan', releaseGate, 'docs/14_signing_and_update_plan.md');
  assertContains('release gate mentions upload artifact action', releaseGate, 'actions/upload-artifact@v7');
  assertContains('release gate mentions CI release candidate artifact', releaseGate, 'cts-windows-release-candidate-${{ github.sha }}');
  assertContains('release gate mentions sourceControl', releaseGate, 'sourceControl');
  assertContains('release gate mentions source status report', releaseGate, 'pnpm release:source-status');
  assertContains('release gate mentions source status verify', releaseGate, 'pnpm release:source-status:verify');
  assertContains('release gate mentions source status report json', releaseGate, 'release-source-status-report.json');
  assertContains('release gate mentions publish verify', releaseGate, 'pnpm release:verify:publish');
  assertContains('QA log links distribution notes', qaLog, 'docs/13_distribution_release_notes.md');
  assertContains('QA log links signing plan', qaLog, 'docs/14_signing_and_update_plan.md');
  assertContains('QA log mentions CI release candidate artifact', qaLog, 'cts-windows-release-candidate-<commit-sha>');
  assertContains('QA log mentions release gates report', qaLog, 'release-gates-report.json');
  assertContains('QA log mentions release gates report command', qaLog, 'pnpm release:gates:report');
  assertContains('QA log mentions installer metadata verify', qaLog, 'pnpm release:installers:verify');
  assertContains('QA log mentions installer metadata report', qaLog, 'release-installer-metadata-report.json');
  assertContains('QA log mentions installer smoke plan', qaLog, 'pnpm release:installers:smoke:plan');
  assertContains('QA log mentions installer smoke plan verify', qaLog, 'pnpm release:installers:smoke:verify');
  assertContains('QA log mentions installer smoke plan report', qaLog, 'release-installer-smoke-plan.json');
  assertContains('QA log mentions release notices', qaLog, 'pnpm release:notices');
  assertContains('QA log mentions release notices verify', qaLog, 'pnpm release:notices:verify');
  assertContains('QA log mentions release signing', qaLog, 'pnpm release:signing');
  assertContains('QA log mentions release signing verify', qaLog, 'pnpm release:signing:verify');
  assertContains('QA log mentions release signing report', qaLog, 'release-signing-report.json');
  assertContains('QA log mentions third-party notices', qaLog, 'THIRD_PARTY_NOTICES.md');
  assertContains('QA log mentions privacy check', qaLog, 'pnpm check:privacy');
  assertContains('QA log mentions release secret check', qaLog, 'pnpm check:secrets');
  assertContains('QA log mentions source asset policy', qaLog, 'pnpm check:assets');
  assertContains('QA log mentions QA log verify', qaLog, 'pnpm release:qa-log:verify');
  assertContains('QA log mentions QA log draft verify', qaLog, 'pnpm release:qa-log:verify:draft');
  assertContains('QA log mentions release notes verify', qaLog, 'pnpm release:notes:verify');
  assertContains('QA log mentions release notes draft verify', qaLog, 'pnpm release:notes:verify:draft');
  assertContains('QA log mentions sourceControl', qaLog, 'sourceControl');
  assertContains('QA log mentions source status report', qaLog, 'pnpm release:source-status');
  assertContains('QA log mentions source status verify', qaLog, 'pnpm release:source-status:verify');
  assertContains('QA log mentions source status report json', qaLog, 'release-source-status-report.json');
  assertContains('QA log mentions publish verify', qaLog, 'pnpm release:verify:publish');
  assertContains('QA log explains machine-filled decisions', qaLog, '機械的に証明できる配布判定行');
  assertContains('QA log explains MIDI export artifact auto-pass', qaLog, 'MIDIヘッダー');
  assertContains('QA log explains WAV export artifact validation', qaLog, 'RIFF/WAVE');
  assertContains('QA log explains offline auto-pass', qaLog, 'pnpm test:e2e');
  assertContains('QA log explains SHA-256 auto-pass', qaLog, '自動で Pass');
  assertContains('QA log mentions sample song manual QA evidence', qaLog, 'サンプル曲名');
  assertContains('QA log mentions restart manual QA evidence', qaLog, '再起動後に復元');
  assertContains('QA log mentions changed title manual QA evidence', qaLog, '別タイトル');
  assertContains('QA log mentions native file dialog manual QA evidence', qaLog, 'OS 標準ファイルダイアログ');
  assertContains('QA log mentions support diagnostics manual QA', qaLog, 'サポート画面');
  assertContains('QA log mentions unhandled error diagnostics manual QA', qaLog, '未処理エラー画面');
  assertContains('QA log mentions manual diagnostic copy fallback', qaLog, '手動コピー用診断情報');
  assertContains('QA log explains manual QA evidence notes', qaLog, '手動QAの実行証跡');
  assertContains('QA log requires installer smoke plan evidence', qaLog, 'release-installer-smoke-plan.md');
  assertContains('release gate documents MIDI/WAV artifact validation', releaseGate, 'MIDI/WAV のダウンロードファイル');
  assertContains('release gate explains manual QA evidence notes', releaseGate, '手動QAの実行証跡');
  assertContains('release gate mentions clipboard fallback manual QA', releaseGate, 'クリップボード拒否時');
  assertContains('release gate requires installer smoke plan evidence', releaseGate, 'release-installer-smoke-plan.md/json');
  assertContains('distribution notes link signing plan', distributionNotes, 'docs/14_signing_and_update_plan.md');
  assertContains('distribution notes mention release notes verify', distributionNotes, 'pnpm release:notes:verify');
  assertContains('distribution notes mention release notes draft verify', distributionNotes, 'pnpm release:notes:verify:draft');
  assertContains('distribution notes mention release notices', distributionNotes, 'pnpm release:notices');
  assertContains('distribution notes mention release notices verify', distributionNotes, 'pnpm release:notices:verify');
  assertContains('distribution notes mention release signing', distributionNotes, 'pnpm release:signing');
  assertContains('distribution notes mention release signing verify', distributionNotes, 'pnpm release:signing:verify');
  assertContains('distribution notes mention release signing report', distributionNotes, 'release-signing-report.json');
  assertContains('distribution notes mention installer metadata verify', distributionNotes, 'pnpm release:installers:verify');
  assertContains('distribution notes mention installer smoke plan', distributionNotes, 'pnpm release:installers:smoke:plan');
  assertContains('distribution notes mention installer smoke plan verify', distributionNotes, 'pnpm release:installers:smoke:verify');
  assertContains('distribution notes mention CI release candidate artifact', distributionNotes, 'cts-windows-release-candidate-<commit-sha>');
  assertContains('distribution notes mention third-party notices', distributionNotes, 'THIRD_PARTY_NOTICES.md');
  assertContains('distribution notes mention privacy check', distributionNotes, 'pnpm check:privacy');
  assertContains('distribution notes mention release secret check', distributionNotes, 'pnpm check:secrets');
  assertContains('distribution notes mention source asset policy', distributionNotes, 'pnpm check:assets');
  assertContains('distribution notes mention sourceControl', distributionNotes, 'sourceControl');
  assertContains('distribution notes mention source status report', distributionNotes, 'pnpm release:source-status');
  assertContains('distribution notes mention source status verify', distributionNotes, 'pnpm release:source-status:verify');
  assertContains('distribution notes mention source status report json', distributionNotes, 'release-source-status-report.json');
  assertContains('distribution notes mention publish verify', distributionNotes, 'pnpm release:verify:publish');
  assertContains('distribution notes mention diagnostic app version', distributionNotes, 'アプリバージョン');
  assertContains('distribution notes mention diagnostic user agent', distributionNotes, 'user agent');
  assertContains('distribution notes mention support diagnostics', distributionNotes, 'サポート画面');
  assertContains('distribution notes mention no hidden network', distributionNotes, '隠れたネットワーク通信');

  for (const id of [
    'REL-MAN-001',
    'REL-MAN-002',
    'REL-MAN-003',
    'REL-MAN-004',
    'REL-MAN-005',
    'REL-MAN-006',
    'REL-MAN-007',
    'REL-MAN-008',
    'REL-MAN-009',
    'REL-MAN-010',
    'REL-MAN-011',
  ]) {
    assertContains(`QA log includes ${id}`, qaLog, id);
  }

  for (const phrase of [
    '候補ビルド',
    '配布成果物',
    '自動ゲート結果',
    'Windows インストーラ手動QA',
    '既知の制限',
    '配布判定',
    'Sign-off',
    '配布ページ',
  ]) {
    assertContains(`QA log includes ${phrase}`, qaLog, phrase);
  }

  for (const phrase of [
    'ダウンロード',
    'SHA-256',
    'release-manifest.json',
    'sourceControl',
    'release-source-status-report.json',
    'SHA256SUMS.txt',
    'release-notes-draft.md',
    'docs/releases',
    'release:archive',
    'release:archive:verify',
    'release-signing-report.json',
    'release-installer-metadata-report.json',
    'release-installer-smoke-plan.md',
    'cts-windows-release-candidate-<commit-sha>',
    'THIRD_PARTY_NOTICES.md',
    'pnpm release:signing',
    'pnpm release:signing:verify',
    'pnpm release:notices',
    'pnpm release:notices:verify',
    'pnpm check:privacy',
    'pnpm check:secrets',
    'pnpm check:assets',
    'アプリバージョン',
    'user agent',
    'サポート画面',
    '未処理エラー画面',
    '手動コピー用診断情報',
    'pnpm release:qa-log:verify',
    'pnpm release:notes:verify',
    'pnpm release:notes',
    'pnpm release:source-status',
    'pnpm release:source-status:verify',
    'pnpm release:verify',
    'pnpm release:verify:publish',
    'コード署名',
    'SmartScreen',
    '未署名ビルド',
    'updater',
    '診断ログ',
    'WebView2',
    'アンインストール',
    'リリース担当者チェック',
  ]) {
    assertContains(`distribution notes include ${phrase}`, distributionNotes, phrase);
  }

  for (const phrase of [
    'Windows code signing',
    'Tauri updater',
    'SmartScreen',
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'TAURI_WINDOWS_SIGNTOOL_PATH',
    'upgradeCode',
    'Phase 0',
    'Phase 1',
    'Phase 2',
    'Phase 3',
    'private key',
    'rollback',
    'SIGN-001',
    'SIGN-002',
    'SIGN-003',
    'SIGN-004',
    'SIGN-005',
    'SECRETS-001',
    'UPD-001',
    'UPD-002',
    'UPD-003',
    'UPD-004',
  ]) {
    assertContains(`signing plan includes ${phrase}`, signingPlan, phrase);
  }

  assertContains(
    'signing plan records fixed upgradeCode',
    signingPlan,
    'a776024f-6b69-5d06-8534-15426c9c632a',
  );

  for (const phrase of [
    'pnpm check:privacy',
    'fetch',
    'WebSocket',
    '@tauri-apps/plugin-http',
    'HTTP',
    'updater',
    'telemetry',
    'AI Coach',
    'opt-in',
    'docs/13_distribution_release_notes.md',
    'docs/12_release_qa_log.md',
    'pnpm check:secrets',
    'pnpm check:assets',
  ]) {
    assertContains(`privacy policy includes ${phrase}`, privacyPolicy, phrase);
  }
}

try {
  await checkVersions();
  await checkReleaseScripts();
  await checkReleaseCommandDefinitions();
  await checkTauriReleaseConfig();
  await checkPinnedBuildWorkaround();
  await checkPnpmBuildApprovals();
  await checkCiGates();
  await checkReleaseDocs();
} catch (error) {
  fail('release readiness script crashed', error instanceof Error ? error.message : String(error));
}

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
  console.error(`Release readiness failed: ${failed.length} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`Release readiness passed: ${checks.length} checks.`);
}
