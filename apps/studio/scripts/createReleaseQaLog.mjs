import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const manifestPath = join(releaseOutputDir, 'release-manifest.json');
const gateReportPath = join(releaseOutputDir, 'release-gates-report.json');
const sourceStatusReportPath = join(releaseOutputDir, 'release-source-status-report.json');
const signingReportPath = join(releaseOutputDir, 'release-signing-report.json');
const tauriConfigPath = join(appRoot, 'src-tauri', 'tauri.conf.json');
const outputPath = join(releaseOutputDir, 'release-qa-log-draft.md');
const expectedMsiUpgradeCode = 'a776024f-6b69-5d06-8534-15426c9c632a';

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

const automatedGateCommands = [
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

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function formatBytes(value) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function todayInTokyo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readOptionalJson(path) {
  try {
    return await readJson(path);
  } catch {
    return null;
  }
}

function artifactRow(label, artifact, result) {
  return `| ${label} | \`${artifact.path}\` | \`${artifact.sha256}\` | ${formatBytes(artifact.sizeBytes)} | ${result} |`;
}

function artifactByKind(manifest, kind) {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind);
  if (!artifact) throw new Error(`Missing ${kind} in release manifest.`);
  return artifact;
}

function signingSummary(signingReport) {
  if (!signingReport) return 'Not run';
  if (signingReport.signingState === 'signed') return 'Signed';
  if (signingReport.signingState === 'unsigned-limited') return 'Unsigned limited distribution';
  if (signingReport.signingState === 'mixed') return 'Mixed signed/unsigned';
  return signingReport.signingState || 'Unknown';
}

function sourceControlLabel(manifest) {
  const sourceControl = manifest.sourceControl;
  if (!sourceControl) return '';
  const dirtyLabel = sourceControl.isDirty ? `dirty: ${sourceControl.status.length} change(s)` : 'clean';
  return `${sourceControl.branch}@${sourceControl.shortCommit} (${dirtyLabel})`;
}

function cleanNote(value) {
  return value.replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
}

function durationNote(durationMs) {
  if (!Number.isFinite(durationMs)) return '';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
}

function gateEntry(command, gateReport) {
  return gateReport?.commands?.find((entry) => entry.command === command) ?? null;
}

function gatePassed(command, gateReport) {
  return gateEntry(command, gateReport)?.result === 'Pass';
}

function gateDecision(command, gateReport) {
  return gatePassed(command, gateReport) ? 'Pass' : 'Not run';
}

function allReleaseGateCommandsPassed(gateReport) {
  return (
    gateReport?.result === 'Pass' &&
    releaseGateReportCommands.every((command) => gatePassed(command, gateReport))
  );
}

function tauriUpdaterEnabled(tauriConfig) {
  return Boolean(tauriConfig?.plugins?.updater || tauriConfig?.bundle?.createUpdaterArtifacts);
}

function msiUpgradeCodeIsFixed(tauriConfig) {
  return tauriConfig?.bundle?.windows?.wix?.upgradeCode === expectedMsiUpgradeCode;
}

function signingOrUpdaterPlanDecision(signingReport, tauriConfig) {
  const signingEnabled = signingReport?.signingState === 'signed' || signingReport?.signingState === 'mixed';
  return signingEnabled || tauriUpdaterEnabled(tauriConfig) ? 'Not run' : 'Pass';
}

function renderGateRow(command, gateReport) {
  if (command === 'pnpm release:gates:report') {
    if (!gateReport) return `| \`${command}\` | Not run |  |`;
    return `| \`${command}\` | ${gateReport.result} | Generated \`${relativeFromRepo(gateReportPath)}\` at ${gateReport.generatedAt} |`;
  }

  if (command === 'pnpm release:qa-log') {
    return `| \`${command}\` | Pass | Generated this draft |`;
  }

  const gate = gateEntry(command, gateReport);
  if (!gate) return `| \`${command}\` | Not run |  |`;

  const details = [
    gate.finishedAt ? `Finished ${gate.finishedAt}` : '',
    durationNote(gate.durationMs),
    gate.result === 'Fail' ? `Exit ${gate.exitCode}` : '',
  ].filter(Boolean);

  return `| \`${command}\` | ${gate.result} | ${cleanNote(details.join('; '))} |`;
}

function renderGateRows(gateReport) {
  return automatedGateCommands.map((command) => renderGateRow(command, gateReport)).join('\n');
}

function renderSourceReviewPlanRows(sourceStatusReport) {
  if (!sourceStatusReport) {
    return '| Source status report | Not run |  | Not run | Run `pnpm release:source-status` and `pnpm release:source-status:verify`. |';
  }

  if (sourceStatusReport.isDirty === false || sourceStatusReport.total === 0) {
    return '| Clean source | 0 | clean | Pass | No dirty entries in release manifest sourceControl. |';
  }

  const reviewPlan = Array.isArray(sourceStatusReport.reviewPlan) ? sourceStatusReport.reviewPlan : [];
  if (reviewPlan.length === 0) {
    return `| Dirty source | ${sourceStatusReport.total ?? 'unknown'} | unknown | Not run | Regenerate \`release-source-status-report.json\` so review bundles are available. |`;
  }

  return reviewPlan
    .map((bundle) =>
      [
        bundle.title,
        bundle.total,
        Array.isArray(bundle.categories) ? bundle.categories.join(', ') : '',
        'Not run',
        bundle.recommendedAction,
      ]
        .map((cell) => cleanNote(String(cell ?? '')))
        .join(' | '),
    )
    .map((row) => `| ${row} |`)
    .join('\n');
}

function renderManualQaRows(gateReport) {
  const e2ePassed = gatePassed('pnpm test:e2e', gateReport);
  const midiExportResult = e2ePassed ? 'Pass' : 'Not run';
  const midiExportNote = e2ePassed
    ? '`pnpm test:e2e` confirmed the downloaded MIDI file has MThd/MTrk headers and non-empty content.'
    : '';
  const wavExportNote = e2ePassed
    ? '`pnpm test:e2e` confirmed the downloaded WAV file has RIFF/WAVE headers and non-empty PCM data. OS player playback remains manual.'
    : '';
  const offlineResult =
    gatePassed('pnpm check:privacy', gateReport) && e2ePassed
      ? 'Pass'
      : 'Not run';
  const offlineNote =
    offlineResult === 'Pass'
      ? '`pnpm check:privacy` found no hidden network capability, and `pnpm test:e2e` confirmed the offline core workflow made no external requests.'
      : '';
  const sha256Result = gatePassed('pnpm release:verify', gateReport) ? 'Pass' : 'Not run';
  const sha256Note =
    sha256Result === 'Pass'
      ? '`pnpm release:verify` confirmed manifest, SHA256SUMS.txt, file sizes, and actual artifact hashes.'
      : '';

  return [
    ['REL-MAN-001', 'NSIS installer を起動してインストールする', 'Not run', ''],
    ['REL-MAN-002', 'MSI を別環境またはクリーン状態で実行する', 'Not run', ''],
    ['REL-MAN-003', '初回起動でスタート画面からサンプル曲を再生する', 'Not run', 'スタート画面、サンプル曲名、再生して音が出た結果を記録する'],
    ['REL-MAN-004', '新規プロジェクトを作成して保存し、アプリを閉じて再起動する', 'Not run', '新規プロジェクト名、保存先、再起動後に復元した内容を記録する'],
    ['REL-MAN-005', 'プロジェクトファイルを書き出し、別タイトルに変更してから読み込み直す', 'Not run', '書き出したプロジェクトファイル、別タイトル、読み込み後のタイトルを記録する'],
    ['REL-MAN-006', 'MIDI を書き出し、外部アプリまたはファイルサイズで確認する', midiExportResult, midiExportNote],
    ['REL-MAN-007', 'WAV を書き出し、OS 標準プレイヤーで開く', 'Not run', wavExportNote],
    ['REL-MAN-008', '書き出し/読み込みで OS 標準ファイルダイアログを使う', 'Not run', '書き出しと読み込みの OS 標準ファイルダイアログで選択した場所を記録する'],
    [
      'REL-MAN-009',
      '上部のサポート画面と、未処理エラー画面を開くテストビルドまたは一時的な例外で診断ログを確認する',
      'Not run',
      'サポート画面、未処理エラー画面、クリップボード拒否時の手動コピー用診断情報をそれぞれ確認する',
    ],
    ['REL-MAN-010', 'オフライン状態で主要機能を使う', offlineResult, offlineNote],
    ['REL-MAN-011', '`SHA256SUMS.txt` の SHA-256 と配布予定ファイルを照合する', sha256Result, sha256Note],
  ]
    .map(([id, check, result, note]) => `| ${id} | ${check} | ${result} | ${note} |`)
    .join('\n');
}

function renderDecisionRows(gateReport, signingReport, tauriConfig) {
  const rows = [
    ['自動ゲートがすべて成功している', allReleaseGateCommandsPassed(gateReport) ? 'Pass' : 'Not run'],
    ['重大な手動QA項目が成功している', 'Not run'],
    ['既知の制限が release note に書かれている', 'Not run'],
    ['`pnpm check:privacy` が成功している', gateDecision('pnpm check:privacy', gateReport)],
    ['`pnpm check:secrets` が成功している', gateDecision('pnpm check:secrets', gateReport)],
    ['`pnpm check:assets` が成功している', gateDecision('pnpm check:assets', gateReport)],
    ['`pnpm release:installers:verify` が成功している', gateDecision('pnpm release:installers:verify', gateReport)],
    ['コード署名なしの警告を配布ページに明記している', 'Not run'],
    ['`docs/13_distribution_release_notes.md` を元に配布ページを作成している', 'Not run'],
    ['配布ページに SHA-256 を記載している', 'Not run'],
    ['`pnpm release:archive` で候補ビルド別の証跡を `docs/releases/` に保存している', 'Not run'],
    ['`pnpm release:archive:verify` で保存済み証跡の SHA-256 整合性を確認している', 'Not run'],
    ['CI artifact `cts-windows-release-candidate-<commit-sha>` に配布成果物と release 証跡が保存されている', 'Not run'],
    ['`pnpm release:qa-log:verify -- --path <qa-log-path>` が成功している', 'Not run'],
    ['`pnpm release:notes:verify -- --path <release-notes-path>` が成功している', 'Not run'],
    ['`pnpm release:notices:verify` が成功している', gateDecision('pnpm release:notices:verify', gateReport)],
    ['`pnpm release:signing:verify` が成功している', gateDecision('pnpm release:signing:verify', gateReport)],
    [
      '署名または updater を有効化した場合、`docs/14_signing_and_update_plan.md` の追加チェックを実施している',
      signingOrUpdaterPlanDecision(signingReport, tauriConfig),
    ],
    [
      `MSI \`upgradeCode\` が \`${expectedMsiUpgradeCode}\` のまま固定されている`,
      msiUpgradeCodeIsFixed(tauriConfig) ? 'Pass' : 'Not run',
    ],
    ['配布してよい', 'No'],
  ];

  return rows.map(([item, result]) => `| ${item} | ${result} |`).join('\n');
}

function renderQaLog(manifest, gateReport, sourceStatusReport, signingReport, tauriConfig) {
  const releaseCandidate = process.env.CTS_RELEASE_CANDIDATE || 'rc.1';
  const generatedAt = new Date().toISOString();
  const portableExe = artifactByKind(manifest, 'portable-exe');
  const msi = artifactByKind(manifest, 'msi-installer');
  const nsis = artifactByKind(manifest, 'nsis-installer');
  const artifactResult = gatePassed('pnpm release:verify', gateReport) ? 'Pass' : 'Not run';

  return `# Release QA Log Draft - ${manifest.productName} ${manifest.version} ${releaseCandidate}

Generated from \`${relativeFromRepo(manifestPath)}\` at ${generatedAt}.

This is a prefilled QA draft. Artifact rows and machine-verifiable distribution decisions are filled from release evidence. Manual QA, publish-page checks, CI artifact confirmation, strict publish verifications, and final sign-off remain \`Not run\` until a tester runs the Windows installer checks and signs off. For \`REL-MAN-001\`, \`REL-MAN-002\`, \`REL-MAN-003\`, \`REL-MAN-004\`, \`REL-MAN-005\`, \`REL-MAN-007\`, \`REL-MAN-008\`, and \`REL-MAN-009\`, a \`Pass\` result must include the tested environment, command/log evidence, and observed result in Notes. \`REL-MAN-001\` and \`REL-MAN-002\` must reference \`release-installer-smoke-plan.md\` / \`release-installer-smoke-plan.json\` or the saved PowerShell / \`msiexec\` log.

## 1. Candidate Build

| Item | Record |
|---|---|
| Product | ${manifest.productName} |
| Version | ${manifest.version} |
| Release candidate | ${releaseCandidate} |
| QA date | ${todayInTokyo()} |
| Tester |  |
| OS / edition | Windows 11 / Windows 10 |
| Machine type | Physical / VM |
| Install state | Clean install / Upgrade |
| Platform | ${manifest.platform} |
| Source branch or commit | ${sourceControlLabel(manifest)} |
| Source full commit | ${manifest.sourceControl?.commit ?? ''} |
| CI artifact | \`cts-windows-release-candidate-<commit-sha>\` |
| Release manifest generated at | ${manifest.generatedAt} |
| Signing state | ${signingSummary(signingReport)} |

## 2. Source Review Plan

Use this table before final QA sign-off. Dirty source bundles must be reviewed, committed, or otherwise resolved before publishing. The strict publish verifier still requires a clean source manifest.

Source status report:

- \`${relativeFromRepo(sourceStatusReportPath)}\`
- \`apps/studio/src-tauri/target/release/release/release-source-status-report.md\`

| Bundle | Entries | Categories | Review status | Notes |
|---|---:|---|---|---|
${renderSourceReviewPlanRows(sourceStatusReport)}

## 3. Distribution Artifacts

Run \`pnpm release:gates:report\`, \`pnpm release:qa-log\`, \`pnpm release:qa-log:verify:draft\`, and \`pnpm release:notes\` for the candidate build before copying this log to \`docs/releases/\`. After manual QA is complete, run \`pnpm release:qa-log:verify -- --path <qa-log-path>\` before publishing.

| Type | File | SHA-256 | Size | Result |
|---|---|---|---|---|
${artifactRow('Portable exe', portableExe, artifactResult)}
${artifactRow('MSI installer', msi, artifactResult)}
${artifactRow('NSIS installer', nsis, artifactResult)}

Manifest:

- \`${relativeFromRepo(manifestPath)}\`
- \`apps/studio/src-tauri/target/release/release/SHA256SUMS.txt\`
- \`${relativeFromRepo(gateReportPath)}\`
- \`${relativeFromRepo(sourceStatusReportPath)}\`
- \`apps/studio/src-tauri/target/release/release/release-installer-metadata-report.json\`
- \`apps/studio/src-tauri/target/release/release/release-installer-smoke-plan.json\`
- \`${relativeFromRepo(signingReportPath)}\`

Signing report:

- State: ${signingSummary(signingReport)}
- Guidance: ${signingReport?.guidance ?? 'Run `pnpm release:signing` and `pnpm release:signing:verify`.'}

## 4. Automated Gate Results

| Command | Result | Notes |
|---|---|---|
${renderGateRows(gateReport)}

## 5. Windows Installer Manual QA

Record each result as \`Pass\`, \`Fail\`, \`Blocked\`, or \`Not run\`. For \`Fail\` or \`Blocked\`, include reproduction steps, expected result, actual result, and related logs. For manual \`Pass\` rows, include the tested environment, command or saved log, and observed result.

| ID | Check | Result | Notes |
|---|---|---|---|
${renderManualQaRows(gateReport)}

## 6. Known Limitations

| Limitation | User impact | Release note entry | Planned follow-up |
|---|---|---|---|
|  |  | Not written |  |

## 7. Distribution Decision

| Item | Result |
|---|---|
${renderDecisionRows(gateReport, signingReport, tauriConfig)}

Sign-off:

- QA:
- Engineering:
- Release owner:
`;
}

async function main() {
  const manifest = await readJson(manifestPath);
  const gateReport = await readOptionalJson(gateReportPath);
  const sourceStatusReport = await readOptionalJson(sourceStatusReportPath);
  const signingReport = await readOptionalJson(signingReportPath);
  const tauriConfig = await readOptionalJson(tauriConfigPath);
  await mkdir(releaseOutputDir, { recursive: true });
  await writeFile(outputPath, renderQaLog(manifest, gateReport, sourceStatusReport, signingReport, tauriConfig), 'utf8');
  console.log(`Created ${relativeFromRepo(outputPath)}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
