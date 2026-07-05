import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(appRoot, 'scripts', 'verifyReleaseNotes.mjs');
const tempRoots = [];

const hashes = {
  nsis: 'a'.repeat(64),
  msi: 'b'.repeat(64),
  portable: 'c'.repeat(64),
};

function releaseNotes({
  nsisHash = hashes.nsis,
  diagnosticsText = diagnosticsSection(),
  limitationRow = '| Unsigned build | Windows may show SmartScreen warning | Verify SHA-256 before running |',
} = {}) {
  return `# Compose Tutor Studio 0.1.0 for Windows

## Overview

Compose Tutor Studio is a composition learning app for creating a short original song with local project files, MIDI export, WAV export, and native file dialogs.

## Download

| Type | File | Purpose | SHA-256 |
|---|---|---|---|
| NSIS installer | Compose Tutor Studio_0.1.0_x64-setup.exe | Recommended installer | ${nsisHash} |
| MSI installer | Compose Tutor Studio_0.1.0_x64_en-US.msi | Managed installation | ${hashes.msi} |
| Portable exe | cts-studio.exe | Portable launch check | ${hashes.portable} |

Verify downloads against SHA256SUMS.txt and release-manifest.json before running the installers.

## System Requirements

- Windows 10 or Windows 11
- Microsoft Edge WebView2 Runtime
- Audio output device

## Third-party Notices

THIRD_PARTY_NOTICES.md is included with the release evidence and linked from the download page.

## Installation Notice

This build may be unsigned, so Windows Defender SmartScreen can show an unknown publisher warning.
Signing status source: release-signing-report.json. The signing report says the artifacts are unsigned for limited distribution.

## Confirmed Features

- Play the sample song from the start screen.
- Save and restore a project after restarting.
- Export and re-import project files.
- Export MIDI and WAV files.
- Use native OS file dialogs for export and import.

${diagnosticsText}

## Known Limitations

| Limitation | Impact | Workaround or follow-up |
|---|---|---|
${limitationRow}

## Uninstall

Use Windows Settings > Installed apps to uninstall Compose Tutor Studio.

## Release Owner Checklist

- pnpm release:verify passed for the candidate.
- pnpm release:notes generated this page.
- pnpm release:notes:verify passed on this page.
- pnpm release:qa-log:verify passed on the candidate QA log.
- pnpm release:archive saved docs/releases evidence.
- pnpm release:archive:verify passed.
- pnpm release:source-status generated release-source-status-report.json and release-source-status-report.md.
- pnpm release:source-status:verify confirmed release-source-status-report.json matches release-manifest.json.
- pnpm release:signing and pnpm release:signing:verify passed.
- release-signing-report.json matches the distributed files.
- pnpm check:privacy passed.
- pnpm check:secrets passed.
- pnpm check:assets passed.
- pnpm release:notices and pnpm release:notices:verify passed.
- THIRD_PARTY_NOTICES.md is linked beside downloads.
- pnpm release:verify:publish passed for the candidate.
- SHA-256 values match SHA256SUMS.txt.
- release-manifest.json sourceControl commit and dirty/clean state were reviewed.
- Known limitations were reviewed.
`;
}

function diagnosticsSection() {
  return `## Diagnostics And Privacy

Diagnostic reports stay local unless the user copies them. Copied reports include app version, generated time, user agent, diagnostic ID, and error kind. Local file paths are redacted as [local-path]. If clipboard access is denied, the app shows a manual copy diagnostic report.`;
}

function writeNotes(text) {
  const dir = mkdtempSync(join(tmpdir(), 'cts-release-notes-'));
  tempRoots.push(dir);
  const file = join(dir, 'release-notes.md');
  writeFileSync(file, text, 'utf8');
  return file;
}

function verifyNotes(text) {
  return spawnSync(process.execPath, [scriptPath, '--path', writeNotes(text)], {
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

describe('release notes verifier', () => {
  it('accepts publishable release notes with hashes, signing status, diagnostics, and limitations', () => {
    const result = verifyNotes(releaseNotes());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Release notes verification passed');
  });

  it('rejects download rows with invalid SHA-256 values', () => {
    const result = verifyNotes(releaseNotes({ nsisHash: 'not-a-sha' }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('NSIS installer SHA-256 is missing or invalid.');
  });

  it('rejects notes missing diagnostic manual-copy guidance', () => {
    const result = verifyNotes(
      releaseNotes({
        diagnosticsText: `## Diagnostics And Privacy

Diagnostic reports stay local unless the user copies them. Copied reports include app version, generated time, user agent, diagnostic ID, and error kind. Local file paths are redacted as [local-path].`,
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Release notes must mention the manual diagnostic copy fallback.');
  });

  it('rejects incomplete known limitation rows in publishable notes', () => {
    const result = verifyNotes(releaseNotes({ limitationRow: '| Unsigned build | Windows may show SmartScreen warning |  |' }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Known limitation row is incomplete');
  });
});
