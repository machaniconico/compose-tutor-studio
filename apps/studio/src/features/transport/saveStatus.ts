import type { SaveFailureCode } from '../../state/persistence';
import type { RetryPolicy } from '@cts/project-persistence';

export type { SaveFailureCode } from '../../state/persistence';

export type SaveStatusState = {
  phase: 'idle' | 'pending' | 'saved' | 'error';
  lastSavedAt: string | null;
  failure: SaveFailureCode | null;
  retry?: RetryPolicy | null;
  revision?: number;
  protectedRevision?: number;
  crashProtectionAvailable?: boolean;
  protectionFailed?: boolean;
};

export type SaveStatusPresentation = {
  label: string;
  tone: SaveStatusState['phase'];
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
  buttonLabel: '保存' | '再試行' | '保存不可';
  canRetry: boolean;
  savedAt: string | null;
};

const FAILURE_MESSAGES: Record<SaveFailureCode, string> = {
  'storage-unavailable': '保存できません。この環境ではローカル保存を利用できません。',
  'quota-exceeded': '保存できません。端末の空き容量を確認してください。',
  'access-denied': '保存できません。端末またはアプリの保存許可を確認してください。',
  'invalid-project': '保存できません。プロジェクトの内容を確認してください。',
  'serialization-failed': '保存データを作成できませんでした。もう一度お試しください。',
  'too-large': '保存できません。曲のトラックや音符を減らしてからもう一度お試しください。',
  'corrupt-data': '保存データの破損を検出しました。バックアップを書き出してください。',
  'unsupported-version': '新しいバージョンの保存データです。アプリを更新してください。',
  conflict: '別の画面で更新されています。内容を確認してからもう一度保存してください。',
  'read-failed': '保存データを読み取れませんでした。もう一度お試しください。',
  'write-failed': '保存できませんでした。もう一度お試しください。',
  'delete-failed': '削除を完了できませんでした。データは残しています。',
  'migration-failed': '古い保存データを安全に変換できませんでした。',
  'lock-unavailable':
    '安全に保存するための排他制御を利用できません。ほかの画面や起動中のアプリを閉じて、もう一度お試しください。',
  'sync-unsupported': '終了前の保存を完了できません。バックアップを書き出してください。',
};

/** Convert persistence state into consistent visible and assistive feedback. */
export function getSaveStatusPresentation(state: SaveStatusState): SaveStatusPresentation {
  if (state.phase === 'error') {
    const canRetry = state.retry !== 'never';
    return {
      label: state.protectionFailed
        ? canRetry
          ? '変更を強制終了から保護できません。今すぐ保存を再試行するか、バックアップを書き出してください。'
          : '変更を強制終了から保護できず、この画面では保存を再試行できません。バックアップを書き出してください。'
        : FAILURE_MESSAGES[state.failure ?? 'write-failed'],
      tone: 'error',
      role: 'alert',
      ariaLive: 'assertive',
      buttonLabel: canRetry ? '再試行' : '保存不可',
      canRetry,
      savedAt: null,
    };
  }

  if (state.phase === 'pending') {
    const crashProtectionPending =
      state.crashProtectionAvailable === true &&
      (state.protectedRevision ?? -1) < (state.revision ?? 0);
    return {
      label: state.crashProtectionAvailable
        ? crashProtectionPending
          ? '未保存の変更を保護中です。'
          : '未保存の変更は保護済みです。自動保存を待っています。'
        : '未保存の変更があります',
      tone: 'pending',
      role: 'status',
      ariaLive: 'polite',
      buttonLabel: '保存',
      canRetry: true,
      savedAt: null,
    };
  }

  if (state.phase === 'saved') {
    return {
      label: '保存済み',
      tone: 'saved',
      role: 'status',
      ariaLive: 'polite',
      buttonLabel: '保存',
      canRetry: true,
      savedAt: state.lastSavedAt,
    };
  }

  return {
    label: '未保存',
    tone: 'idle',
    role: 'status',
    ariaLive: 'polite',
    buttonLabel: '保存',
    canRetry: true,
    savedAt: null,
  };
}

/** Render only a valid save timestamp; malformed state should never imply a save time. */
export function formatSavedTime(savedAt: string | null): string | null {
  if (!savedAt) return null;
  const timestamp = Date.parse(savedAt);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}
