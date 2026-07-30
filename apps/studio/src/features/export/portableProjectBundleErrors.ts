import {
  PORTABLE_PROJECT_BUNDLE_ERROR_CODES,
  PortableProjectBundleError,
  type PortableProjectBundleErrorCode,
} from '@cts/project-bundle';
import {
  AudioAssetRepositoryError,
} from '../../platform/audioAssetRepository';
import {
  NativeFileGatewayError,
} from '../../platform/nativeFileGateway';

export type PortableProjectBundleFailure = Readonly<{
  code: PortableProjectBundleErrorCode;
  message: string;
  nextAction: string;
}>;

export type PortableProjectBundleOperation = 'import' | 'export';

const FAILURE_COPY: Record<
  Exclude<PortableProjectBundleErrorCode, 'cancelled'>,
  Readonly<{ message: string; nextAction: string }>
> = {
  'too-large': {
    message: 'ポータブルプロジェクトが大きすぎます（上限128MB）。',
    nextAction: '長い音声素材や使っていない音声素材を減らして、もう一度お試しください。',
  },
  'invalid-header': {
    message: 'このファイルはポータブルプロジェクトとして読み取れません。',
    nextAction: '拡張子が.ctsbundleの元ファイルを選び直してください。',
  },
  'unsupported-version': {
    message: 'このファイルは新しい形式で作成されています。',
    nextAction: 'アプリを更新してから、もう一度お試しください。',
  },
  'invalid-manifest': {
    message: 'ファイル内の音声一覧に矛盾があります。',
    nextAction: '書き出し元の端末から、もう一度書き出してください。',
  },
  'invalid-project': {
    message: 'ファイル内の曲の編集情報を安全に確認できませんでした。',
    nextAction: '書き出し元の端末から、もう一度書き出してください。',
  },
  'non-canonical': {
    message: 'ファイルが正規のポータブル形式ではありません。',
    nextAction: 'ファイルを編集せず、書き出し元から作り直してください。',
  },
  'checksum-mismatch': {
    message: '音声または曲の情報が破損・変更されています。',
    nextAction: '元のファイルを再取得するか、もう一度書き出してください。',
  },
  'length-mismatch': {
    message: 'ファイルが途中で切れているか、余分なデータが含まれています。',
    nextAction: 'コピーをやり直すか、もう一度書き出してください。',
  },
  'asset-metadata-conflict': {
    message: '同じ音声に異なる内容説明が付いているため、安全に扱えません。',
    nextAction: '書き出し元で音声素材を確認し、もう一度書き出してください。',
  },
  'unresolved-asset': {
    message: '見つからない音声素材がプロジェクトに残っています。',
    nextAction: '書き出し元で不足している音声素材を読み込み直してください。',
  },
  'too-many-assets': {
    message: 'プロジェクトに含まれる音声素材が多すぎます。',
    nextAction: '使っていない音声素材を減らして、もう一度お試しください。',
  },
  'asset-read-failed': {
    message: '音声素材を読み出せませんでした。',
    nextAction: '素材の保存領域と端末の空き容量を確認してください。',
  },
  'repository-missing': {
    message: '保存済みの音声素材が見つかりません。',
    nextAction: '音声素材がある元の端末で書き出してください。',
  },
  'repository-changed': {
    message: '保存済みの音声素材が変更または破損しています。',
    nextAction: '元の音声を読み込み直してから書き出してください。',
  },
  'repository-unavailable': {
    message: '音声素材の保存領域を利用できません。',
    nextAction: '空き容量やアクセス権を確認してから、もう一度お試しください。',
  },
  'repository-store-failed': {
    message: '検証した音声素材を端末へ保存できませんでした。',
    nextAction: '空き容量を確認してから、もう一度読み込んでください。',
  },
  'receipt-mismatch': {
    message: '保存した音声素材を正しく確認できなかったため、読み込みを中止しました。',
    nextAction: 'アプリを再起動して、もう一度お試しください。',
  },
  'adoption-failed': {
    message: '現在のプロジェクトを安全に保存できないため、切り替えませんでした。',
    nextAction: '現在のプロジェクトを保存してから、もう一度読み込んでください。',
  },
  'reservation-failed': {
    message: 'ポータブル操作に必要なメモリを安全に確保できませんでした。',
    nextAction: 'ほかの音声処理が終わってから再試行するか、長い音声素材を減らしてください。',
  },
  'file-read-failed': {
    message: '選択したファイルを読み込めませんでした。',
    nextAction: 'ファイルへのアクセス権を確認して、選び直してください。',
  },
  'handoff-failed': {
    message: 'ポータブルプロジェクトを保存先へ渡せませんでした。',
    nextAction: 'ブラウザーのダウンロード許可や端末の空き容量を確認してください。',
  },
  'crypto-unavailable': {
    message: '破損を確認する機能を利用できないため、安全のため処理を中止しました。',
    nextAction: 'アプリまたはブラウザーを再起動して、もう一度お試しください。',
  },
};

// Adding an error code fails compilation until beginner-facing copy is supplied.
void (PORTABLE_PROJECT_BUNDLE_ERROR_CODES satisfies readonly PortableProjectBundleErrorCode[]);

function assertNever(value: never): never {
  throw new Error(`Unreachable portable bundle error: ${String(value)}`);
}

function failureCopy(
  code: Exclude<PortableProjectBundleErrorCode, 'cancelled'>,
): Readonly<{ message: string; nextAction: string }> {
  switch (code) {
    case 'too-large':
    case 'invalid-header':
    case 'unsupported-version':
    case 'invalid-manifest':
    case 'invalid-project':
    case 'non-canonical':
    case 'checksum-mismatch':
    case 'length-mismatch':
    case 'asset-metadata-conflict':
    case 'unresolved-asset':
    case 'too-many-assets':
    case 'asset-read-failed':
    case 'repository-missing':
    case 'repository-changed':
    case 'repository-unavailable':
    case 'repository-store-failed':
    case 'receipt-mismatch':
    case 'adoption-failed':
    case 'reservation-failed':
    case 'file-read-failed':
    case 'handoff-failed':
    case 'crypto-unavailable':
      return FAILURE_COPY[code];
    default:
      return assertNever(code);
  }
}

export function normalizePortableProjectBundleError(
  error: unknown,
  operation: PortableProjectBundleOperation = 'import',
):
PortableProjectBundleError {
  if (error instanceof PortableProjectBundleError) return error;
  if (error instanceof AudioAssetRepositoryError) {
    if (error.code === 'missing') return new PortableProjectBundleError('repository-missing');
    if (error.code === 'checksum-mismatch'
      || error.code === 'length-mismatch'
      || error.code === 'corrupt') {
      return new PortableProjectBundleError('repository-changed');
    }
    if (error.code === 'write-failed') {
      return new PortableProjectBundleError('repository-store-failed');
    }
    return new PortableProjectBundleError('repository-unavailable');
  }
  if (error instanceof NativeFileGatewayError) {
    if (error.code === 'file-too-large') return new PortableProjectBundleError('too-large');
    if (error.code === 'unsupported-version') {
      return new PortableProjectBundleError('unsupported-version');
    }
    return new PortableProjectBundleError(
      operation === 'import' ? 'file-read-failed' : 'handoff-failed',
    );
  }
  return new PortableProjectBundleError(
    operation === 'import' ? 'file-read-failed' : 'handoff-failed',
  );
}

export function portableProjectBundleFailure(
  error: unknown,
  operation: PortableProjectBundleOperation = 'import',
):
PortableProjectBundleFailure | null {
  const normalized = normalizePortableProjectBundleError(error, operation);
  if (normalized.code === 'cancelled') return null;
  const copy = failureCopy(normalized.code);
  return { code: normalized.code, ...copy };
}

export function portableProjectBundleFailureMessage(
  error: unknown,
  operation: PortableProjectBundleOperation = 'import',
): string | null {
  const failure = portableProjectBundleFailure(error, operation);
  return failure === null ? null : `${failure.message} ${failure.nextAction}`;
}
