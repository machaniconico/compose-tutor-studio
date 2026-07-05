import { describe, expect, it } from 'vitest';
import {
  assertSourceControl,
  formatDirtySourceMessage,
} from '../scripts/verifyReleaseArtifacts.mjs';

const cleanSourceControl = {
  commit: 'a'.repeat(40),
  shortCommit: 'aaaaaaa',
  branch: 'main',
  isDirty: false,
  status: [],
};

describe('release artifact verifier sourceControl checks', () => {
  it('allows a clean sourceControl block when publish verification requires clean source', () => {
    expect(() => assertSourceControl(cleanSourceControl, { requireCleanSource: true })).not.toThrow();
  });

  it('formats dirty sourceControl failures with actionable status preview', () => {
    const message = formatDirtySourceMessage({
      ...cleanSourceControl,
      isDirty: true,
      status: [' M apps/studio/src/main.tsx', '?? apps/studio/tests/releaseArtifactVerifier.test.mjs'],
    });

    expect(message).toContain('Commit, stash, or discard changes before publishing');
    expect(message).toContain('pnpm release:manifest');
    expect(message).toContain('pnpm release:verify:publish');
    expect(message).toContain('Dirty entries: 2.');
    expect(message).toContain('Dirty review bundles:');
    expect(message).toContain('- Product and desktop runtime: 1 entries (1 modified, 0 untracked, 0 other)');
    expect(message).toContain('- Validation coverage: 1 entries (0 modified, 1 untracked, 0 other)');
    expect(message).toContain('Dirty categories by review bundle:');
    expect(message).toContain(
      '- Product and desktop runtime:\n  - Product source: 1 entries (1 modified, 0 untracked, 0 other)',
    );
    expect(message).toContain(
      '- Validation coverage:\n  - Tests and QA: 1 entries (0 modified, 1 untracked, 0 other)',
    );
    expect(message).toContain('Review completion criteria:');
    expect(message).toContain('Changed behavior is covered by passing tests, E2E coverage, or a documented QA note.');
    expect(message).toContain('Tests fail for the intended regression or directly exercise the changed behavior.');
    expect(message).toContain('Dirty paths by review bundle:');
    expect(message).toContain('- Product and desktop runtime:\n  -  M apps/studio/src/main.tsx');
    expect(message).toContain(
      '- Validation coverage:\n  - ?? apps/studio/tests/releaseArtifactVerifier.test.mjs',
    );
    expect(message).toContain('-  M apps/studio/src/main.tsx');
    expect(message).toContain('- ?? apps/studio/tests/releaseArtifactVerifier.test.mjs');
  });

  it('truncates long dirty sourceControl status lists', () => {
    const status = Array.from({ length: 22 }, (_, index) => ` M file-${index}.txt`);
    const message = formatDirtySourceMessage({
      ...cleanSourceControl,
      isDirty: true,
      status,
    });

    expect(message).toContain('Dirty entries: 22.');
    expect(message).toContain('- Product and desktop runtime: 22 entries (22 modified, 0 untracked, 0 other)');
    expect(message).toContain('  - Workspace config: 22 entries (22 modified, 0 untracked, 0 other)');
    expect(message).toContain('- Product and desktop runtime:\n  -  M file-0.txt');
    expect(message).toContain('  - ... and 17 more');
    expect(message).toContain('-  M file-19.txt');
    expect(message).not.toContain('-  M file-20.txt');
    expect(message).toContain('- ... and 2 more');
  });

  it('rejects dirty sourceControl when publish verification requires clean source', () => {
    expect(() =>
      assertSourceControl(
        {
          ...cleanSourceControl,
          isDirty: true,
          status: [' M package.json'],
        },
        { requireCleanSource: true },
      ),
    ).toThrow(/Dirty status preview:[\s\S]*package\.json/);
  });
});
