# Compose Tutor Studio 0.1.0 rc.1

This folder archives release-candidate evidence generated from the desktop release artifacts.

Generated at: 2026-06-30T18:57:18.567Z

Archive name: `0.1.0-rc.1`

Source manifest generated at: 2026-06-30T18:56:28.032Z

Source commit: `5e9096d8a1557f930acf34fa47df4b426db57811`

Source branch: `wave5/desktop`

Source worktree: dirty

## Source Status Summary

| Area | Total | Modified | Untracked | Other |
|---|---:|---:|---:|---:|
| CI | 1 | 0 | 1 | 0 |
| Desktop runtime | 5 | 4 | 1 | 0 |
| Docs | 7 | 2 | 5 | 0 |
| Packages | 4 | 4 | 0 | 0 |
| Release archive | 1 | 0 | 1 | 0 |
| Release scripts | 1 | 0 | 1 | 0 |
| Studio app | 18 | 10 | 8 | 0 |
| Studio tests | 20 | 4 | 16 | 0 |
| Studio workspace | 2 | 2 | 0 | 0 |
| Workspace config | 3 | 3 | 0 | 0 |

## Source Status

```text
M apps/studio/package.json
 M apps/studio/src-tauri/.gitignore
 M apps/studio/src-tauri/Cargo.lock
 M apps/studio/src-tauri/Cargo.toml
 M apps/studio/src-tauri/tauri.conf.json
 M apps/studio/src/audio/playback.ts
 M apps/studio/src/features/export/ExportMenu.tsx
 M apps/studio/src/features/export/download.ts
 M apps/studio/src/features/projectMenu/ProjectMenu.tsx
 M apps/studio/src/features/startScreen/StartScreen.tsx
 M apps/studio/src/features/startScreen/startScreen.css
 M apps/studio/src/features/transport/TransportBar.tsx
 M apps/studio/src/main.tsx
 M apps/studio/src/state/persistence.ts
 M apps/studio/src/styles.css
 M apps/studio/tests/exportHelpers.test.ts
 M apps/studio/tests/persistence.test.ts
 M apps/studio/tests/store.test.ts
 M apps/studio/tests/transportShortcuts.test.ts
 M apps/studio/vite.config.ts
 M docs/07_desktop_build.md
 M docs/08_qa_test_plan.md
 M package.json
 M packages/midi-io/package.json
 M packages/project-model/package.json
 M packages/theory-engine/package.json
 M packages/tutorial-engine/package.json
 M pnpm-lock.yaml
 M pnpm-workspace.yaml
?? .github/
?? apps/studio/e2e/
?? apps/studio/playwright.config.ts
?? apps/studio/scripts/
?? apps/studio/src-tauri/icons/icon.ico
?? apps/studio/src/env.d.ts
?? apps/studio/src/features/common/ErrorBoundary.tsx
?? apps/studio/src/features/export/exportFailureMessages.ts
?? apps/studio/src/features/export/projectFileImport.ts
?? apps/studio/src/features/projectMenu/projectFailureMessages.ts
?? apps/studio/src/features/support/
?? apps/studio/src/platform/
?? apps/studio/src/state/projectSaveGuard.ts
?? apps/studio/tests/diagnostics.test.ts
?? apps/studio/tests/errorBoundary.test.ts
?? apps/studio/tests/fileDialogs.test.ts
?? apps/studio/tests/firstSongSmoke.test.ts
?? apps/studio/tests/playbackFailure.test.ts
?? apps/studio/tests/projectFailureMessages.test.ts
?? apps/studio/tests/projectFileImport.test.ts
?? apps/studio/tests/releaseArchiveVerifier.test.mjs
?? apps/studio/tests/releaseArtifactVerifier.test.mjs
?? apps/studio/tests/releaseNotesVerifier.test.mjs
?? apps/studio/tests/releaseQaLogVerifier.test.mjs
?? apps/studio/tests/sourceStatusReport.test.mjs
?? apps/studio/tests/sourceStatusReportVerifier.test.mjs
?? apps/studio/tests/supportEvents.test.ts
?? docs/11_release_gate.md
?? docs/12_release_qa_log.md
?? docs/13_distribution_release_notes.md
?? docs/14_signing_and_update_plan.md
?? docs/15_privacy_network_policy.md
?? docs/releases/
```

## Archived Files

| Archived file | Source |
|---|---|
| `docs/releases/0.1.0-rc.1/release-manifest.json` | `apps/studio/src-tauri/target/release/release/release-manifest.json` |
| `docs/releases/0.1.0-rc.1/SHA256SUMS.txt` | `apps/studio/src-tauri/target/release/release/SHA256SUMS.txt` |
| `docs/releases/0.1.0-rc.1/release-source-status-report.json` | `apps/studio/src-tauri/target/release/release/release-source-status-report.json` |
| `docs/releases/0.1.0-rc.1/release-source-status-report.md` | `apps/studio/src-tauri/target/release/release/release-source-status-report.md` |
| `docs/releases/0.1.0-rc.1/release-gates-report.json` | `apps/studio/src-tauri/target/release/release/release-gates-report.json` |
| `docs/releases/0.1.0-rc.1/release-gates-report.md` | `apps/studio/src-tauri/target/release/release/release-gates-report.md` |
| `docs/releases/0.1.0-rc.1/release-installer-metadata-report.json` | `apps/studio/src-tauri/target/release/release/release-installer-metadata-report.json` |
| `docs/releases/0.1.0-rc.1/release-installer-metadata-report.md` | `apps/studio/src-tauri/target/release/release/release-installer-metadata-report.md` |
| `docs/releases/0.1.0-rc.1/release-installer-smoke-plan.json` | `apps/studio/src-tauri/target/release/release/release-installer-smoke-plan.json` |
| `docs/releases/0.1.0-rc.1/release-installer-smoke-plan.md` | `apps/studio/src-tauri/target/release/release/release-installer-smoke-plan.md` |
| `docs/releases/0.1.0-rc.1/release-signing-report.json` | `apps/studio/src-tauri/target/release/release/release-signing-report.json` |
| `docs/releases/0.1.0-rc.1/release-signing-report.md` | `apps/studio/src-tauri/target/release/release/release-signing-report.md` |
| `docs/releases/0.1.0-rc.1/THIRD_PARTY_NOTICES.json` | `apps/studio/src-tauri/target/release/release/THIRD_PARTY_NOTICES.json` |
| `docs/releases/0.1.0-rc.1/THIRD_PARTY_NOTICES.md` | `apps/studio/src-tauri/target/release/release/THIRD_PARTY_NOTICES.md` |
| `docs/releases/0.1.0-rc.1/release-qa-log.md` | `apps/studio/src-tauri/target/release/release/release-qa-log-draft.md` |
| `docs/releases/0.1.0-rc.1/release-notes.md` | `apps/studio/src-tauri/target/release/release/release-notes-draft.md` |

## Required Follow-up

- Run `pnpm release:verify:publish` after the source tree is clean and before publishing.
- Do not publish this archive while `Source worktree` is dirty. Resolve or commit the `Source Status` entries, rerun `pnpm release:manifest`, and archive fresh evidence.
- Fill in `release-qa-log.md` after Windows installer manual QA.
- Run `pnpm release:qa-log:verify -- --path docs/releases/0.1.0-rc.1/release-qa-log.md` before publishing.
- Run `pnpm release:notes:verify -- --path docs/releases/0.1.0-rc.1/release-notes.md` before publishing.
- Remove draft text and known limitation placeholders from `release-notes.md` before publishing.
- Keep `release-signing-report.json` aligned with the exact files uploaded for distribution.
- Keep `release-installer-metadata-report.json` aligned with the exact files uploaded for distribution.
- Use `release-installer-smoke-plan.md` when running NSIS/MSI manual QA in a clean Windows environment.
- Keep `THIRD_PARTY_NOTICES.md` available next to the downloads or linked from the release page.
- Keep `release-manifest.json` and `SHA256SUMS.txt` aligned with the exact files uploaded for distribution.
