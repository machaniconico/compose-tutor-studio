import { describe, expect, it } from 'vitest';
import {
  PORTABLE_PROJECT_BUNDLE_ERROR_CODES,
  PortableProjectBundleError,
  type PortableProjectBundleErrorCode,
} from '@cts/project-bundle';
import {
  portableProjectBundleFailure,
} from '../src/features/export/portableProjectBundleErrors';
import {
  NativeFileGatewayError,
} from '../src/platform/nativeFileGateway';

const EXHAUSTIVE_CODES: Record<PortableProjectBundleErrorCode, true> = {
  'too-large': true,
  'invalid-header': true,
  'unsupported-version': true,
  'invalid-manifest': true,
  'invalid-project': true,
  'non-canonical': true,
  'checksum-mismatch': true,
  'length-mismatch': true,
  'asset-metadata-conflict': true,
  'unresolved-asset': true,
  'too-many-assets': true,
  'asset-read-failed': true,
  'repository-missing': true,
  'repository-changed': true,
  'repository-unavailable': true,
  'repository-store-failed': true,
  'receipt-mismatch': true,
  'adoption-failed': true,
  'reservation-failed': true,
  'file-read-failed': true,
  'handoff-failed': true,
  'crypto-unavailable': true,
  'cancelled': true,
};

describe('portable project bundle beginner-facing errors', () => {
  it.each([
    {
      operation: 'import',
      nativeCode: 'invalid-file',
      expectedCode: 'file-read-failed',
      message: '選択したファイルを読み込めませんでした。',
    },
    {
      operation: 'import',
      nativeCode: 'read-failed',
      expectedCode: 'file-read-failed',
      message: '選択したファイルを読み込めませんでした。',
    },
    {
      operation: 'export',
      nativeCode: 'invalid-file',
      expectedCode: 'handoff-failed',
      message: 'ポータブルプロジェクトを保存先へ渡せませんでした。',
    },
    {
      operation: 'export',
      nativeCode: 'write-failed',
      expectedCode: 'handoff-failed',
      message: 'ポータブルプロジェクトを保存先へ渡せませんでした。',
    },
  ] as const)(
    'maps native $nativeCode during $operation without using the opposite operation copy',
    ({ operation, nativeCode, expectedCode, message }) => {
      expect(
        portableProjectBundleFailure(
          new NativeFileGatewayError(nativeCode),
          operation,
        ),
      ).toMatchObject({
        code: expectedCode,
        message,
      });
    },
  );

  it.each([
    ['import', 'file-read-failed'],
    ['export', 'handoff-failed'],
  ] as const)(
    'maps an unexpected %s boundary failure to the operation-safe fallback',
    (operation, expectedCode) => {
      expect(
        portableProjectBundleFailure(new Error('secret implementation detail'), operation),
      ).toMatchObject({ code: expectedCode });
    },
  );

  it.each(['import', 'export'] as const)(
    'preserves a typed native file-too-large failure during %s',
    (operation) => {
      expect(
        portableProjectBundleFailure(
          new NativeFileGatewayError('file-too-large'),
          operation,
        ),
      ).toMatchObject({
        code: 'too-large',
        message: 'ポータブルプロジェクトが大きすぎます（上限128MB）。',
      });
    },
  );

  it.each(['import', 'export'] as const)(
    'preserves a typed native unsupported-version failure during %s',
    (operation) => {
      expect(
        portableProjectBundleFailure(
          new NativeFileGatewayError('unsupported-version'),
          operation,
        ),
      ).toEqual({
        code: 'unsupported-version',
        message: 'このファイルは新しい形式で作成されています。',
        nextAction: 'アプリを更新してから、もう一度お試しください。',
      });
    },
  );

  it('has safe Japanese copy and a concrete next action for every non-cancel code', () => {
    expect(Object.keys(EXHAUSTIVE_CODES).sort())
      .toEqual([...PORTABLE_PROJECT_BUNDLE_ERROR_CODES].sort());
    for (const code of PORTABLE_PROJECT_BUNDLE_ERROR_CODES) {
      const raw = new PortableProjectBundleError(code, 'secret raw exception');
      raw.stack = 'secret stack';
      const failure = portableProjectBundleFailure(raw);
      if (code === 'cancelled') {
        expect(failure).toBeNull();
        continue;
      }
      expect(failure?.message).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
      expect(failure?.nextAction).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
      expect(failure?.message).not.toContain(code);
      expect(failure?.message).not.toContain('secret');
      expect(failure?.nextAction).not.toContain(code);
      expect(failure?.nextAction).not.toContain('secret');
    }
  });
});
