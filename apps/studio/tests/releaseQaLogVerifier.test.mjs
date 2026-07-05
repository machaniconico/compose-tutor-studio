import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(appRoot, 'scripts', 'verifyReleaseQaLog.mjs');
const tempRoots = [];

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

const defaultManualNotes = {
  'REL-MAN-001':
    'Windows 11 VM release-installer-smoke-plan REL-MAN-001 used Start-Process setup.exe and the app launched.',
  'REL-MAN-002': 'Windows 11 VM release-installer-smoke-plan REL-MAN-002 used MSI msiexec ProductCode and launch passed.',
  'REL-MAN-003': 'Windows 11 VM Start screen opened Sample Song, and playback produced audible sound.',
  'REL-MAN-004': 'Windows 11 VM created a New Project, saved it to Documents, restarted the app, and restored the melody.',
  'REL-MAN-005': 'Exported the project file, changed the title to Evening Study, imported it back, and the title matched.',
  'REL-MAN-006': 'Automated MIDI export evidence passed.',
  'REL-MAN-007': 'Exported a WAV file and played it in Windows Media Player with audible playback.',
  'REL-MAN-008': 'Windows native file dialog opened for export save path and import open path in Explorer.',
  'REL-MAN-009':
    'Support screen diagnostic copied. Unhandled-error screen diagnostic copied. Clipboard denial showed the manual copy report.',
  'REL-MAN-010': 'Offline workflow passed with no external requests.',
  'REL-MAN-011': 'SHA256SUMS.txt matched all release artifact hashes.',
};

function passRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

function writeQaLog({ manualNotes = {}, sourceReviewRows = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cts-qa-log-'));
  tempRoots.push(dir);
  const file = join(dir, 'release-qa-log.md');
  const notes = { ...defaultManualNotes, ...manualNotes };
  const hash = 'a'.repeat(64);

  const gateRows = automatedGateCommands.map((command) => passRow([`\`${command}\``, 'Pass', 'Fixture evidence']));
  const manualRows = Object.entries(notes).map(([id, note]) => passRow([id, 'Fixture check', 'Pass', note]));
  const sourceRows =
    sourceReviewRows ??
    [
      passRow([
        'Clean source',
        '0',
        'clean',
        'Pass',
        'No dirty entries in release manifest sourceControl.',
      ]),
    ];

  const text = `# Release QA Log

## 1. Candidate Build

| Item | Record |
|---|---|
| Product | Compose Tutor Studio |
| Version | 0.1.0 |
| Release candidate | rc.1 |
| QA date | 2026-07-01 |
| Tester | QA fixture |
| Source branch or commit | fixture-commit clean |
| OS / edition | Windows 11 Pro 24H2 |
| Machine type | VM |
| Install state | Clean install |

## 2. Source Review Plan

| Bundle | Entries | Categories | Review status | Notes |
|---|---:|---|---|---|
${sourceRows.join('\n')}

## 3. Distribution Artifacts

| Type | File | SHA-256 | Size | Result |
|---|---|---|---|---|
| Portable exe | cts-studio.exe | ${hash} | 123 bytes | Pass |

## 4. Automated Gate Results

| Command | Result | Notes |
|---|---|---|
${gateRows.join('\n')}

## 5. Windows Installer Manual QA

| ID | Check | Result | Notes |
|---|---|---|---|
${manualRows.join('\n')}

## 6. Known Limitations

| Limitation | User impact | Release note entry | Planned follow-up |
|---|---|---|---|
| Unsigned build | Windows may warn before launch | Known limitations mention unsigned build | Code signing phase |

## 7. Distribution Decision

| Item | Result |
|---|---|
| Artifacts verified | Pass |
| Ready to distribute | Yes |

Sign-off:
- QA: Fixture tester
- Engineering: Fixture engineer
- Release owner: Fixture owner
`;

  writeFileSync(file, text, 'utf8');
  return file;
}

function verifyQaLog(path) {
  return spawnSync(process.execPath, [scriptPath, '--path', path], {
    cwd: appRoot,
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('release QA log verifier', () => {
  it('accepts a release-ready fixture with concrete manual evidence', () => {
    const result = verifyQaLog(writeQaLog());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Release QA log verification passed');
  });

  it('rejects template-only manual QA notes marked as Pass', () => {
    const result = verifyQaLog(
      writeQaLog({
        manualNotes: {
          'REL-MAN-003': 'スタート画面、サンプル曲名、再生して音が出た結果を記録する',
        },
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Manual QA evidence note is required: REL-MAN-003.');
  });

  it('rejects dirty source review bundles in release-ready logs', () => {
    const result = verifyQaLog(
      writeQaLog({
        sourceReviewRows: [
          passRow([
            'Product and desktop runtime',
            '29',
            'Product source, Desktop runtime',
            'Not run',
            'Review app behavior before publishing.',
          ]),
        ],
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Source review plan still contains dirty entries: Product and desktop runtime.',
    );
  });

  it('rejects manual QA notes missing native file dialog evidence', () => {
    const result = verifyQaLog(
      writeQaLog({
        manualNotes: {
          'REL-MAN-008': 'Windows 11 VM exported and imported a project file successfully.',
        },
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Manual QA evidence note for REL-MAN-008 must mention the OS/native file dialog.');
  });
});
