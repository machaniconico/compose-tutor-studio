# Compose Tutor Studio 0.1.0 rc.2

This folder archives release-candidate evidence generated from the desktop release artifacts.

Generated at: 2026-07-06T21:43:56.434Z

Archive name: `0.1.0-rc.2`

Source manifest generated at: 2026-07-06T21:43:04.051Z

Source commit: `0c179c2848a52500b985e1ff435f5169d4fe798a`

Source branch: `wave5/desktop`

Source worktree: dirty

## Source Status Summary

| Area | Total | Modified | Untracked | Other |
|---|---:|---:|---:|---:|
| Release archive | 1 | 0 | 1 | 0 |
| Studio app | 6 | 6 | 0 | 0 |
| Studio tests | 5 | 5 | 0 | 0 |

## Source Status

```text
M apps/studio/e2e/first-launch.spec.ts
 M apps/studio/src/features/export/projectFileImport.ts
 M apps/studio/src/features/projectMenu/ProjectMenu.tsx
 M apps/studio/src/features/projectMenu/projectFailureMessages.ts
 M apps/studio/src/features/support/SupportMenu.tsx
 M apps/studio/src/platform/diagnostics.ts
 M apps/studio/src/state/persistence.ts
 M apps/studio/tests/diagnostics.test.ts
 M apps/studio/tests/persistence.test.ts
 M apps/studio/tests/projectFailureMessages.test.ts
 M apps/studio/tests/supportMenu.test.ts
?? docs/releases/0.1.0-rc.2/
```

## Archived Files

| Archived file | Source |
|---|---|
| `docs/releases/0.1.0-rc.2/release-manifest.json` | `apps/studio/src-tauri/target/release/release/release-manifest.json` |
| `docs/releases/0.1.0-rc.2/SHA256SUMS.txt` | `apps/studio/src-tauri/target/release/release/SHA256SUMS.txt` |
| `docs/releases/0.1.0-rc.2/release-source-status-report.json` | `apps/studio/src-tauri/target/release/release/release-source-status-report.json` |
| `docs/releases/0.1.0-rc.2/release-source-status-report.md` | `apps/studio/src-tauri/target/release/release/release-source-status-report.md` |
| `docs/releases/0.1.0-rc.2/release-gates-report.json` | `apps/studio/src-tauri/target/release/release/release-gates-report.json` |
| `docs/releases/0.1.0-rc.2/release-gates-report.md` | `apps/studio/src-tauri/target/release/release/release-gates-report.md` |
| `docs/releases/0.1.0-rc.2/release-installer-metadata-report.json` | `apps/studio/src-tauri/target/release/release/release-installer-metadata-report.json` |
| `docs/releases/0.1.0-rc.2/release-installer-metadata-report.md` | `apps/studio/src-tauri/target/release/release/release-installer-metadata-report.md` |
| `docs/releases/0.1.0-rc.2/release-installer-smoke-plan.json` | `apps/studio/src-tauri/target/release/release/release-installer-smoke-plan.json` |
| `docs/releases/0.1.0-rc.2/release-installer-smoke-plan.md` | `apps/studio/src-tauri/target/release/release/release-installer-smoke-plan.md` |
| `docs/releases/0.1.0-rc.2/release-signing-report.json` | `apps/studio/src-tauri/target/release/release/release-signing-report.json` |
| `docs/releases/0.1.0-rc.2/release-signing-report.md` | `apps/studio/src-tauri/target/release/release/release-signing-report.md` |
| `docs/releases/0.1.0-rc.2/THIRD_PARTY_NOTICES.json` | `apps/studio/src-tauri/target/release/release/THIRD_PARTY_NOTICES.json` |
| `docs/releases/0.1.0-rc.2/THIRD_PARTY_NOTICES.md` | `apps/studio/src-tauri/target/release/release/THIRD_PARTY_NOTICES.md` |
| `docs/releases/0.1.0-rc.2/release-qa-log.md` | `apps/studio/src-tauri/target/release/release/release-qa-log-draft.md` |
| `docs/releases/0.1.0-rc.2/release-notes.md` | `apps/studio/src-tauri/target/release/release/release-notes-draft.md` |

## Required Follow-up

- Run `pnpm release:verify:publish` after the source tree is clean and before publishing.
- Do not publish this archive while `Source worktree` is dirty. Resolve or commit the `Source Status` entries, rerun `pnpm release:manifest`, and archive fresh evidence.
- Fill in `release-qa-log.md` after Windows installer manual QA.
- Run `pnpm release:qa-log:verify -- --path docs/releases/0.1.0-rc.2/release-qa-log.md` before publishing.
- Run `pnpm release:notes:verify -- --path docs/releases/0.1.0-rc.2/release-notes.md` before publishing.
- Remove draft text and known limitation placeholders from `release-notes.md` before publishing.
- Keep `release-signing-report.json` aligned with the exact files uploaded for distribution.
- Keep `release-installer-metadata-report.json` aligned with the exact files uploaded for distribution.
- Use `release-installer-smoke-plan.md` when running NSIS/MSI manual QA in a clean Windows environment.
- Keep `THIRD_PARTY_NOTICES.md` available next to the downloads or linked from the release page.
- Keep `release-manifest.json` and `SHA256SUMS.txt` aligned with the exact files uploaded for distribution.
