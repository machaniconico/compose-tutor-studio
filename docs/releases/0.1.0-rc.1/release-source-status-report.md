# Release Source Status Report

Generated at: 2026-06-30T18:56:28.702Z

Commit: `5e9096d8a1557f930acf34fa47df4b426db57811`

Branch: `wave5/desktop`

Source worktree: dirty

Dirty entries: 62

JSON report: `apps/studio/src-tauri/target/release/release/release-source-status-report.json`

## Review Plan

| Bundle | Entries | Categories | Recommended action |
|---|---:|---|---|
| Product and desktop runtime | 32 | Product source, Desktop runtime, Packages, Workspace config | Review user-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata as one app change set. |
| Validation coverage | 20 | Tests and QA | Review unit, integration, and E2E coverage against the product/runtime changes before trusting the candidate. |
| Release readiness | 10 | CI, Release automation, Release evidence | Review CI, release policy, generated evidence, archive contents, and distribution docs after product changes are settled. |

## Summary

| Category | Total | Modified | Untracked | Other | Recommended action |
|---|---:|---:|---:|---:|---|
| CI | 1 | 0 | 1 | 0 | Review as CI/release workflow change. |
| Desktop runtime | 7 | 6 | 1 | 0 | Review as desktop runtime, Tauri, installer, or dependency configuration. |
| Packages | 4 | 4 | 0 | 0 | Review as shared package behavior or package metadata. |
| Product source | 18 | 10 | 8 | 0 | Review as a product change and commit with the matching feature or fix. |
| Release automation | 8 | 2 | 6 | 0 | Review as release tooling or release policy change before publishing. |
| Release evidence | 1 | 0 | 1 | 0 | Regenerate after the final clean build, then archive candidate-specific evidence. |
| Tests and QA | 20 | 4 | 16 | 0 | Review as validation coverage for the candidate. |
| Workspace config | 3 | 3 | 0 | 0 | Review as workspace-level configuration or dependency metadata. |

## Entries

| Git code | State | Category | Path | Recommended action |
|---|---|---|---|---|
| `M ` | modified | Desktop runtime | `apps/studio/package.json` | Review as desktop runtime, Tauri, installer, or dependency configuration. |
| ` M` | modified | Desktop runtime | `apps/studio/src-tauri/.gitignore` | Review as desktop runtime, Tauri, installer, or dependency configuration. |
| ` M` | modified | Desktop runtime | `apps/studio/src-tauri/Cargo.lock` | Review as desktop runtime, Tauri, installer, or dependency configuration. |
| ` M` | modified | Desktop runtime | `apps/studio/src-tauri/Cargo.toml` | Review as desktop runtime, Tauri, installer, or dependency configuration. |
| ` M` | modified | Desktop runtime | `apps/studio/src-tauri/tauri.conf.json` | Review as desktop runtime, Tauri, installer, or dependency configuration. |
| ` M` | modified | Product source | `apps/studio/src/audio/playback.ts` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/features/export/ExportMenu.tsx` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/features/export/download.ts` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/features/projectMenu/ProjectMenu.tsx` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/features/startScreen/StartScreen.tsx` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/features/startScreen/startScreen.css` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/features/transport/TransportBar.tsx` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/main.tsx` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/state/persistence.ts` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/styles.css` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Tests and QA | `apps/studio/tests/exportHelpers.test.ts` | Review as validation coverage for the candidate. |
| ` M` | modified | Tests and QA | `apps/studio/tests/persistence.test.ts` | Review as validation coverage for the candidate. |
| ` M` | modified | Tests and QA | `apps/studio/tests/store.test.ts` | Review as validation coverage for the candidate. |
| ` M` | modified | Tests and QA | `apps/studio/tests/transportShortcuts.test.ts` | Review as validation coverage for the candidate. |
| ` M` | modified | Desktop runtime | `apps/studio/vite.config.ts` | Review as desktop runtime, Tauri, installer, or dependency configuration. |
| ` M` | modified | Release automation | `docs/07_desktop_build.md` | Review as release tooling or release policy change before publishing. |
| ` M` | modified | Release automation | `docs/08_qa_test_plan.md` | Review as release tooling or release policy change before publishing. |
| ` M` | modified | Workspace config | `package.json` | Review as workspace-level configuration or dependency metadata. |
| ` M` | modified | Packages | `packages/midi-io/package.json` | Review as shared package behavior or package metadata. |
| ` M` | modified | Packages | `packages/project-model/package.json` | Review as shared package behavior or package metadata. |
| ` M` | modified | Packages | `packages/theory-engine/package.json` | Review as shared package behavior or package metadata. |
| ` M` | modified | Packages | `packages/tutorial-engine/package.json` | Review as shared package behavior or package metadata. |
| ` M` | modified | Workspace config | `pnpm-lock.yaml` | Review as workspace-level configuration or dependency metadata. |
| ` M` | modified | Workspace config | `pnpm-workspace.yaml` | Review as workspace-level configuration or dependency metadata. |
| `??` | untracked | CI | `.github/` | Review as CI/release workflow change. |
| `??` | untracked | Tests and QA | `apps/studio/e2e/` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/playwright.config.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Release automation | `apps/studio/scripts/` | Review as release tooling or release policy change before publishing. |
| `??` | untracked | Desktop runtime | `apps/studio/src-tauri/icons/icon.ico` | Review as desktop runtime, Tauri, installer, or dependency configuration. |
| `??` | untracked | Product source | `apps/studio/src/env.d.ts` | Review as a product change and commit with the matching feature or fix. |
| `??` | untracked | Product source | `apps/studio/src/features/common/ErrorBoundary.tsx` | Review as a product change and commit with the matching feature or fix. |
| `??` | untracked | Product source | `apps/studio/src/features/export/exportFailureMessages.ts` | Review as a product change and commit with the matching feature or fix. |
| `??` | untracked | Product source | `apps/studio/src/features/export/projectFileImport.ts` | Review as a product change and commit with the matching feature or fix. |
| `??` | untracked | Product source | `apps/studio/src/features/projectMenu/projectFailureMessages.ts` | Review as a product change and commit with the matching feature or fix. |
| `??` | untracked | Product source | `apps/studio/src/features/support/` | Review as a product change and commit with the matching feature or fix. |
| `??` | untracked | Product source | `apps/studio/src/platform/` | Review as a product change and commit with the matching feature or fix. |
| `??` | untracked | Product source | `apps/studio/src/state/projectSaveGuard.ts` | Review as a product change and commit with the matching feature or fix. |
| `??` | untracked | Tests and QA | `apps/studio/tests/diagnostics.test.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/errorBoundary.test.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/fileDialogs.test.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/firstSongSmoke.test.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/playbackFailure.test.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/projectFailureMessages.test.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/projectFileImport.test.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/releaseArchiveVerifier.test.mjs` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/releaseArtifactVerifier.test.mjs` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/releaseNotesVerifier.test.mjs` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/releaseQaLogVerifier.test.mjs` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/sourceStatusReport.test.mjs` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/sourceStatusReportVerifier.test.mjs` | Review as validation coverage for the candidate. |
| `??` | untracked | Tests and QA | `apps/studio/tests/supportEvents.test.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Release automation | `docs/11_release_gate.md` | Review as release tooling or release policy change before publishing. |
| `??` | untracked | Release automation | `docs/12_release_qa_log.md` | Review as release tooling or release policy change before publishing. |
| `??` | untracked | Release automation | `docs/13_distribution_release_notes.md` | Review as release tooling or release policy change before publishing. |
| `??` | untracked | Release automation | `docs/14_signing_and_update_plan.md` | Review as release tooling or release policy change before publishing. |
| `??` | untracked | Release automation | `docs/15_privacy_network_policy.md` | Review as release tooling or release policy change before publishing. |
| `??` | untracked | Release evidence | `docs/releases/` | Regenerate after the final clean build, then archive candidate-specific evidence. |

## Publish Follow-up

- Before publishing, resolve every dirty entry and rerun `pnpm release:manifest`.
- Run `pnpm release:source-status` again and confirm this report is clean.
- Run `pnpm release:source-status:verify` to confirm this report still matches the release manifest.
- Run `pnpm release:verify:publish` after the clean manifest is generated.
