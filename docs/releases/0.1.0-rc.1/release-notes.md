# Compose Tutor Studio 0.1.0 for Windows

Generated from `apps/studio/src-tauri/target/release/release/release-manifest.json` at 2026-06-30T18:56:51.125Z.

This is a user-facing release notes draft. Before publishing, verify QA sign-off, run `pnpm release:notes:verify -- --path <release-notes-path>`, and remove any limitation rows that do not apply.

## Overview

Compose Tutor Studio is a composition learning app for making a short original song while learning chords, scales, and song structure. This Windows desktop release provides project save/load, MIDI/WAV export, native file dialogs, and local diagnostic logs.

## Download

| Type | File | Purpose | SHA-256 |
|---|---|---|---|
| NSIS installer | `Compose Tutor Studio_0.1.0_x64-setup.exe` | Recommended for most users | `7922bf279320a055c9d193f936765de51319b6dbfcd3848cb227aacd3e0d96f9` |
| MSI installer | `Compose Tutor Studio_0.1.0_x64_en-US.msi` | Useful for managed or validation environments | `0fdaf46073d5ddb05742a35ab600f245ceb54f1d10c80211dfaca02e5be652e8` |
| Portable exe | `cts-studio.exe` | Useful for launch checks without installing | `a98e6ae81d9d0dd7fec9996a5c1b3bfb9f00f6276b63611741904917413c4941` |

SHA-256 values must match `apps/studio/src-tauri/target/release/release/SHA256SUMS.txt`. Before publishing, run `pnpm release:verify` and confirm that `release-manifest.json`, `SHA256SUMS.txt`, and the distributed files match.

## System Requirements

- Windows 10 or Windows 11
- Microsoft Edge WebView2 Runtime
- An audio output device

## Third-party Notices

Third-party dependency notices are generated as `THIRD_PARTY_NOTICES.md`. Keep that file available next to the downloads or link it from the release page. Before publishing, run `pnpm release:notices` and `pnpm release:notices:verify`.

## Installation Notice

This build may be unsigned. If it is unsigned, Windows Defender SmartScreen or your browser may show a warning.

- The publisher may appear as an unknown publisher.
- Compare the downloaded file SHA-256 with the value on this page.
- Do not run files whose SHA-256 does not match this page.

If this build is code-signed, replace this section with the publisher name, certificate information, and verification steps. Do not describe an unsigned build as signed.

Signing status source: `release-signing-report.json`. The generated signing report says all artifacts are unsigned. Treat this as limited distribution.

## Confirmed Features

- Play the sample song from the start screen.
- Save a project and resume it after restarting the app.
- Export and re-import project files.
- Export MIDI files.
- Export WAV files.
- Use native OS file dialogs for MIDI/WAV/project export and MIDI/project import.
- Copy local diagnostic information from the Support dialog or when an unhandled error appears. If clipboard access is denied, both screens show a manual copy diagnostic report.

## Diagnostics And Privacy

Diagnostic logs stay on the user's device and are not sent automatically. Users can copy diagnostics from the Support dialog, or from the unhandled-error screen if the app fails to render. If clipboard access is denied, both screens show a manual copy diagnostic report with the same redacted content. Request only diagnostic information the user explicitly copies. Copied diagnostic reports include app version, generated time, user agent, diagnostic ID, and error kind. Local file paths are redacted as `[local-path]`. Normal app features do not use hidden network calls or telemetry. Run `pnpm check:privacy` before publishing.

## Known Limitations

| Limitation | Impact | Workaround or follow-up |
|---|---|---|
| This build may be unsigned | Windows may show a warning | Verify SHA-256 before running. Update this note after signing is introduced |
|  |  |  |

## Uninstall

Use Windows Settings > Installed apps to uninstall Compose Tutor Studio. If you used the portable exe, delete the downloaded exe.

## Release Owner Checklist

- A candidate-specific QA log based on `docs/12_release_qa_log.md` exists.
- CI uploaded `cts-windows-release-candidate-<commit-sha>` with the installers and release evidence.
- `pnpm release:qa-log:verify -- --path <qa-log-path>` passed.
- `pnpm release:archive` saved candidate-specific evidence under `docs/releases/`.
- `pnpm release:archive:verify` passed.
- `pnpm release:source-status` generated `release-source-status-report.json` / `release-source-status-report.md`.
- `pnpm release:source-status:verify` confirmed the source status report matches `release-manifest.json`.
- `pnpm release:installers:verify` passed.
- `pnpm release:installers:smoke:plan` generated candidate-specific installer QA steps.
- `pnpm release:installers:smoke:verify` passed.
- `pnpm release:signing` and `pnpm release:signing:verify` passed.
- `release-signing-report.json` matches the exact distributed files.
- `pnpm check:privacy` passed.
- `pnpm check:secrets` passed.
- `pnpm check:assets` passed.
- `pnpm release:notices` and `pnpm release:notices:verify` passed.
- `THIRD_PARTY_NOTICES.md` is linked or available next to the downloads.
- `pnpm release:verify` passed.
- `pnpm release:verify:publish` passed for the publish candidate.
- `release-manifest.json` sourceControl commit and dirty/clean state were reviewed.
- `pnpm release:notes:verify -- --path <release-notes-path>` passed.
- The SHA-256 values above match `SHA256SUMS.txt`.
- Unsigned builds clearly mention Windows warnings and SHA-256 verification.
- Signed builds mention the publisher name and certificate verification steps.
- If updater is enabled, the update channel and rollback policy are documented.
- Known limitations are not left blank before publishing.
