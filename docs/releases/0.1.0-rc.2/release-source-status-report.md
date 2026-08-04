# Release Source Status Report

Generated at: 2026-07-06T21:43:04.696Z

Commit: `0c179c2848a52500b985e1ff435f5169d4fe798a`

Branch: `wave5/desktop`

Source worktree: dirty

Dirty entries: 12

JSON report: `apps/studio/src-tauri/target/release/release/release-source-status-report.json`

## Review Plan

| Bundle | Entries | Modified | Untracked | Other | Categories | Recommended action |
|---|---:|---:|---:|---:|---|---|
| Product and desktop runtime | 6 | 6 | 0 | 0 | Product source | Review user-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata as one app change set. |
| Validation coverage | 5 | 5 | 0 | 0 | Tests and QA | Review unit, integration, and E2E coverage against the product/runtime changes before trusting the candidate. |
| Release readiness | 1 | 0 | 1 | 0 | Release evidence | Review CI, release policy, generated evidence, archive contents, and distribution docs after product changes are settled. |

## Review Bundle Completion Criteria

### Product and desktop runtime

- User-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata have been reviewed together.
- Changed behavior is covered by passing tests, E2E coverage, or a documented QA note.
- No accidental dependency, installer, or workspace metadata drift remains in the bundle.

### Validation coverage

- Tests fail for the intended regression or directly exercise the changed behavior.
- E2E and smoke coverage are rerun after the final source cleanup.
- Validation-only files are either committed with their related behavior or intentionally separated for review.

### Release readiness

- Generated release evidence is recreated after the final clean build.
- CI, release scripts, and distribution docs match the current publish flow.
- `pnpm release:verify:publish` passes after the clean manifest is regenerated.

## Review Bundle Path Preview

### Product and desktop runtime

- ` M apps/studio/src/features/export/projectFileImport.ts` (Product source)
- ` M apps/studio/src/features/projectMenu/ProjectMenu.tsx` (Product source)
- ` M apps/studio/src/features/projectMenu/projectFailureMessages.ts` (Product source)
- ` M apps/studio/src/features/support/SupportMenu.tsx` (Product source)
- ` M apps/studio/src/platform/diagnostics.ts` (Product source)
- ... and 1 more

### Validation coverage

- `M apps/studio/e2e/first-launch.spec.ts` (Tests and QA)
- ` M apps/studio/tests/diagnostics.test.ts` (Tests and QA)
- ` M apps/studio/tests/persistence.test.ts` (Tests and QA)
- ` M apps/studio/tests/projectFailureMessages.test.ts` (Tests and QA)
- ` M apps/studio/tests/supportMenu.test.ts` (Tests and QA)

### Release readiness

- `?? docs/releases/0.1.0-rc.2/` (Release evidence)

## Review Bundle Category Breakdown

### Product and desktop runtime

| Category | Total | Modified | Untracked | Other | Recommended action |
|---|---:|---:|---:|---:|---|
| Product source | 6 | 6 | 0 | 0 | Review as a product change and commit with the matching feature or fix. |

### Validation coverage

| Category | Total | Modified | Untracked | Other | Recommended action |
|---|---:|---:|---:|---:|---|
| Tests and QA | 5 | 5 | 0 | 0 | Review as validation coverage for the candidate. |

### Release readiness

| Category | Total | Modified | Untracked | Other | Recommended action |
|---|---:|---:|---:|---:|---|
| Release evidence | 1 | 0 | 1 | 0 | Regenerate after the final clean build, then archive candidate-specific evidence. |

## Summary

| Category | Total | Modified | Untracked | Other | Recommended action |
|---|---:|---:|---:|---:|---|
| Product source | 6 | 6 | 0 | 0 | Review as a product change and commit with the matching feature or fix. |
| Release evidence | 1 | 0 | 1 | 0 | Regenerate after the final clean build, then archive candidate-specific evidence. |
| Tests and QA | 5 | 5 | 0 | 0 | Review as validation coverage for the candidate. |

## Entries

| Git code | State | Category | Path | Recommended action |
|---|---|---|---|---|
| `M ` | modified | Tests and QA | `apps/studio/e2e/first-launch.spec.ts` | Review as validation coverage for the candidate. |
| ` M` | modified | Product source | `apps/studio/src/features/export/projectFileImport.ts` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/features/projectMenu/ProjectMenu.tsx` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/features/projectMenu/projectFailureMessages.ts` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/features/support/SupportMenu.tsx` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/platform/diagnostics.ts` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Product source | `apps/studio/src/state/persistence.ts` | Review as a product change and commit with the matching feature or fix. |
| ` M` | modified | Tests and QA | `apps/studio/tests/diagnostics.test.ts` | Review as validation coverage for the candidate. |
| ` M` | modified | Tests and QA | `apps/studio/tests/persistence.test.ts` | Review as validation coverage for the candidate. |
| ` M` | modified | Tests and QA | `apps/studio/tests/projectFailureMessages.test.ts` | Review as validation coverage for the candidate. |
| ` M` | modified | Tests and QA | `apps/studio/tests/supportMenu.test.ts` | Review as validation coverage for the candidate. |
| `??` | untracked | Release evidence | `docs/releases/0.1.0-rc.2/` | Regenerate after the final clean build, then archive candidate-specific evidence. |

## Publish Follow-up

- Before publishing, resolve every dirty entry and rerun `pnpm release:manifest`.
- Run `pnpm release:source-status` again and confirm this report is clean.
- Run `pnpm release:source-status:verify` to confirm this report still matches the release manifest.
- Run `pnpm release:verify:publish` after the clean manifest is generated.
