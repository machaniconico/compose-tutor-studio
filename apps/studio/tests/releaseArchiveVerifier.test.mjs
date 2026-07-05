import { describe, expect, it } from 'vitest';
import { assertQaLogSourceReviewCoverage } from '../scripts/verifyReleaseArchive.mjs';

const dirtySourceStatusReport = {
  isDirty: true,
  total: 46,
  reviewPlan: [
    {
      title: 'Product and desktop runtime',
      total: 29,
      categories: ['Product source', 'Desktop runtime', 'Packages', 'Workspace config'],
      recommendedAction:
        'Review user-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata as one app change set.',
    },
    {
      title: 'Validation coverage',
      total: 17,
      categories: ['Tests and QA'],
      recommendedAction:
        'Review unit, integration, and E2E coverage against the product/runtime changes before trusting the candidate.',
    },
  ],
};

describe('release archive verifier source review coverage', () => {
  it('accepts QA logs that include every dirty source review bundle', () => {
    const qaLog = `# Release QA Log

## 2. Source Review Plan

- \`apps/studio/src-tauri/target/release/release/release-source-status-report.json\`
- \`apps/studio/src-tauri/target/release/release/release-source-status-report.md\`

| Bundle | Entries | Categories | Review status | Notes |
|---|---:|---|---|---|
| Product and desktop runtime | 29 | Product source, Desktop runtime, Packages, Workspace config | Not run | Review user-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata as one app change set. |
| Validation coverage | 17 | Tests and QA | Not run | Review unit, integration, and E2E coverage against the product/runtime changes before trusting the candidate. |
`;

    expect(() =>
      assertQaLogSourceReviewCoverage({
        sourceStatusReport: dirtySourceStatusReport,
        qaLog,
      }),
    ).not.toThrow();
  });

  it('rejects QA logs missing a dirty source review bundle', () => {
    const qaLog = `# Release QA Log

## 2. Source Review Plan

- \`apps/studio/src-tauri/target/release/release/release-source-status-report.json\`
- \`apps/studio/src-tauri/target/release/release/release-source-status-report.md\`

| Bundle | Entries | Categories | Review status | Notes |
|---|---:|---|---|---|
| Product and desktop runtime | 29 | Product source, Desktop runtime, Packages, Workspace config | Not run | Review user-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata as one app change set. |
`;

    expect(() =>
      assertQaLogSourceReviewCoverage({
        sourceStatusReport: dirtySourceStatusReport,
        qaLog,
      }),
    ).toThrow('release-qa-log.md is missing Validation coverage');
  });

  it('accepts clean-source QA logs with a clean source row', () => {
    const qaLog = `# Release QA Log

## 2. Source Review Plan

- \`apps/studio/src-tauri/target/release/release/release-source-status-report.json\`
- \`apps/studio/src-tauri/target/release/release/release-source-status-report.md\`

| Bundle | Entries | Categories | Review status | Notes |
|---|---:|---|---|---|
| Clean source | 0 | clean | Pass | No dirty entries in release manifest sourceControl. |
`;

    expect(() =>
      assertQaLogSourceReviewCoverage({
        sourceStatusReport: { isDirty: false, total: 0, reviewPlan: [] },
        qaLog,
      }),
    ).not.toThrow();
  });
});
