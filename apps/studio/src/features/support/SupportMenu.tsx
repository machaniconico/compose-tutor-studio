import { useEffect, useState } from 'react';
import {
  appVersion,
  clearDiagnostics,
  type DiagnosticEntry,
  formatDiagnosticReport,
  formatDiagnosticValue,
  loadDiagnostics,
  sanitizeDiagnosticText,
  type DiagnosticKind,
} from '../../platform/diagnostics';
import {
  deleteProjectRecoveryIssues,
  listProjectRecoveryIssues,
  type ProjectRecoveryIssue,
} from '../../state/persistence';
import { pushToast } from '../../state/tutorialBridge';
import { Dialog } from '../common/Dialog';
import { listenForSupportMenuOpen } from './supportEvents';

const FILE_TRANSFER_DIAGNOSTIC_KINDS = new Set<DiagnosticKind>([
  'import-midi',
  'project-import',
  'project-export',
  'export-midi',
  'export-wav',
]);

const APP_FLOW_DIAGNOSTIC_KINDS = new Set<DiagnosticKind>(['template-load']);
const BACKUP_RECOVERY_MARKER = 'recovered from backup';

type SupportStatus =
  | 'idle'
  | 'copied'
  | 'copy-failed'
  | 'cleared'
  | 'clear-failed'
  | 'recovery-cleared'
  | 'recovery-clear-failed';

type RecentDiagnosticSummary = {
  id: string;
  kind: DiagnosticKind;
  label: string;
  occurredAt: string;
  occurredAtText: string;
  message: string;
};

export type ProjectRecoveryIssueSummary = {
  key: string;
  reason: string;
};

export type SupportDiagnosticCounts = {
  saveFailureCount: number;
  fileTransferFailureCount: number;
  audioFailureCount: number;
  savedProjectLoadFailureCount: number;
  appFlowFailureCount: number;
  backupRecoveryCount: number;
};

const RECENT_DIAGNOSTIC_LIMIT = 5;
const RECENT_DIAGNOSTIC_MESSAGE_LIMIT = 120;

function statusText(status: SupportStatus): string | null {
  if (status === 'copied') return '診断情報をコピーしました。';
  if (status === 'copy-failed') return 'クリップボードへコピーできませんでした。';
  if (status === 'cleared') return '診断ログを消去しました。';
  if (status === 'clear-failed') return '診断ログを消去できませんでした。';
  if (status === 'recovery-cleared') return '復元できない保存データを削除しました。';
  if (status === 'recovery-clear-failed') return '削除できる復元不能データが見つかりませんでした。';
  return null;
}

function recoveryReasonText(reason: ProjectRecoveryIssue['reason']): string {
  if (reason === 'invalid-json') return 'JSONが壊れています';
  if (reason === 'invalid-shape') return '必要な項目が足りません';
  if (reason === 'invalid-project') return '曲データの値が範囲外です';
  return '新しい形式のため未対応です';
}

export function summarizeProjectRecoveryIssue(
  issue: ProjectRecoveryIssue,
): ProjectRecoveryIssueSummary {
  return {
    key: formatDiagnosticValue(issue.key, 120),
    reason: recoveryReasonText(issue.reason),
  };
}

export function diagnosticKindLabel(kind: DiagnosticKind): string {
  switch (kind) {
    case 'render-error':
      return '画面表示';
    case 'window-error':
      return 'アプリエラー';
    case 'unhandled-rejection':
      return '処理中断';
    case 'storage-recovery':
      return '保存復元';
    case 'storage-save':
      return '保存';
    case 'audio-playback':
      return '音声';
    case 'template-load':
      return '作成/起動';
    case 'project-load':
      return '保存済み読み込み';
    case 'import-midi':
      return 'MIDI読み込み';
    case 'project-import':
      return 'プロジェクト読み込み';
    case 'project-export':
      return 'プロジェクト書き出し';
    case 'export-midi':
      return 'MIDI書き出し';
    case 'export-wav':
      return 'WAV書き出し';
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

export function formatSupportDiagnosticTime(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return '日時不明';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function summarizeDiagnosticMessage(message: string): string {
  const sanitized = sanitizeDiagnosticText(message).replace(/\s+/g, ' ').trim();
  if (sanitized.length <= RECENT_DIAGNOSTIC_MESSAGE_LIMIT) return sanitized;
  return `${sanitized.slice(0, RECENT_DIAGNOSTIC_MESSAGE_LIMIT - 1)}…`;
}

export function summarizeRecentDiagnostics(entries: DiagnosticEntry[]): RecentDiagnosticSummary[] {
  return entries.slice(0, RECENT_DIAGNOSTIC_LIMIT).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    label: diagnosticKindLabel(entry.kind),
    occurredAt: entry.occurredAt,
    occurredAtText: formatSupportDiagnosticTime(entry.occurredAt),
    message: summarizeDiagnosticMessage(entry.message),
  }));
}

export function isBackupRecoveryDiagnostic(entry: DiagnosticEntry): boolean {
  return entry.kind === 'storage-recovery' && entry.message.includes(BACKUP_RECOVERY_MARKER);
}

export function summarizeSupportDiagnosticCounts(entries: DiagnosticEntry[]): SupportDiagnosticCounts {
  return {
    saveFailureCount: entries.filter((entry) => entry.kind === 'storage-save').length,
    fileTransferFailureCount: entries.filter((entry) =>
      FILE_TRANSFER_DIAGNOSTIC_KINDS.has(entry.kind),
    ).length,
    audioFailureCount: entries.filter((entry) => entry.kind === 'audio-playback').length,
    savedProjectLoadFailureCount: entries.filter((entry) => entry.kind === 'project-load').length,
    appFlowFailureCount: entries.filter((entry) =>
      APP_FLOW_DIAGNOSTIC_KINDS.has(entry.kind),
    ).length,
    backupRecoveryCount: entries.filter(isBackupRecoveryDiagnostic).length,
  };
}

export function SupportMenu() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SupportStatus>('idle');
  const [manualReport, setManualReport] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const recoveryIssues = open ? listProjectRecoveryIssues() : [];
  const diagnostics = open ? loadDiagnostics() : [];
  const recentDiagnostics = summarizeRecentDiagnostics(diagnostics);
  const {
    saveFailureCount,
    fileTransferFailureCount,
    audioFailureCount,
    savedProjectLoadFailureCount,
    appFlowFailureCount,
    backupRecoveryCount,
  } = summarizeSupportDiagnosticCounts(diagnostics);
  const message = statusText(status);

  const openDialog = (): void => {
    setStatus('idle');
    setManualReport(null);
    setOpen(true);
  };

  useEffect(() => listenForSupportMenuOpen(openDialog), []);

  const copyReport = async (): Promise<void> => {
    const report = formatDiagnosticReport(loadDiagnostics());
    try {
      await navigator.clipboard.writeText(report);
      setManualReport(null);
      setStatus('copied');
      pushToast('診断情報をコピーしました。', 'success');
    } catch {
      setManualReport(report);
      setStatus('copy-failed');
      pushToast('診断情報をコピーできませんでした。', 'error');
    }
  };

  const clearLog = (): void => {
    if (clearDiagnostics()) {
      setManualReport(null);
      setStatus('cleared');
      pushToast('診断ログを消去しました。', 'success');
    } else {
      setStatus('clear-failed');
      pushToast('診断ログを消去できませんでした。', 'error');
    }
  };

  const clearRecoveryData = (): void => {
    if (
      !window.confirm(
        '復元できない保存データを削除します。通常の保存済みプロジェクトと診断ログは残ります。続けますか？',
      )
    ) {
      return;
    }

    const deleted = deleteProjectRecoveryIssues();
    if (deleted > 0) {
      setVersion((value) => value + 1);
      setStatus('recovery-cleared');
      pushToast(`${deleted}件の復元不能データを削除しました。`, 'success');
    } else {
      setStatus('recovery-clear-failed');
      pushToast('削除できる復元不能データが見つかりませんでした。', 'info');
    }
  };

  return (
    <>
      <button type="button" title="サポートと診断" onClick={openDialog}>
        サポート
      </button>

      {open ? (
        <Dialog title="サポート" onClose={() => setOpen(false)}>
          <div className="support-menu">
            <dl className="support-menu__summary">
              <div>
                <dt>バージョン</dt>
                <dd>{appVersion()}</dd>
              </div>
              <div>
                <dt>診断ログ</dt>
                <dd>{diagnostics.length} 件</dd>
              </div>
              <div>
                <dt>復元不能</dt>
                <dd>{recoveryIssues.length} 件</dd>
              </div>
            </dl>

            <p className="support-menu__note">
              診断ログは端末内だけに保存されます。コピーした内容はパスを伏せたうえで、サポートへ相談するときに使えます。
            </p>

            {recoveryIssues.length > 0 ? (
              <section className="support-menu__recovery" aria-labelledby="support-recovery-title">
                <h3 id="support-recovery-title">復元できない保存データ</h3>
                <p>
                  以下の保存データは自動で読み込まず、元データは端末内に残しています。診断情報をコピーして相談するか、不要なら削除できます。
                </p>
                <ul>
                  {recoveryIssues.map((issue) => {
                    const summary = summarizeProjectRecoveryIssue(issue);
                    return (
                      <li key={`${issue.key}:${issue.reason}`}>
                        <span>{summary.key}</span>
                        <small>{summary.reason}</small>
                      </li>
                    );
                  })}
                </ul>
                <button type="button" onClick={clearRecoveryData} data-version={version}>
                  復元できない保存データを削除
                </button>
              </section>
            ) : null}

            {backupRecoveryCount > 0 ? (
              <section
                className="support-menu__recovery support-menu__recovery--info"
                aria-labelledby="support-backup-recovery-title"
              >
                <h3 id="support-backup-recovery-title">バックアップから復元した記録</h3>
                <p>
                  {backupRecoveryCount}
                  件の保存データを直前の正常なバックアップから読み込みました。現在開けている曲はそのまま確認し、必要なら別名で書き出してください。
                </p>
              </section>
            ) : null}

            {saveFailureCount > 0 ? (
              <section
                className="support-menu__recovery support-menu__recovery--warning"
                aria-labelledby="support-save-failure-title"
              >
                <h3 id="support-save-failure-title">保存に失敗した記録</h3>
                <p>
                  {saveFailureCount}
                  件の保存失敗が記録されています。診断情報をコピーして相談すると、保存容量や保存先の問題を確認しやすくなります。
                </p>
              </section>
            ) : null}

            {fileTransferFailureCount > 0 ? (
              <section
                className="support-menu__recovery support-menu__recovery--warning"
                aria-labelledby="support-file-transfer-failure-title"
              >
                <h3 id="support-file-transfer-failure-title">読み込み/書き出しに失敗した記録</h3>
                <p>
                  {fileTransferFailureCount}
                  件の読み込み/書き出し失敗が記録されています。診断情報をコピーして相談すると、ファイル形式や保存先の問題を確認しやすくなります。
                </p>
              </section>
            ) : null}

            {audioFailureCount > 0 ? (
              <section
                className="support-menu__recovery support-menu__recovery--warning"
                aria-labelledby="support-audio-failure-title"
              >
                <h3 id="support-audio-failure-title">音声の開始に失敗した記録</h3>
                <p>
                  {audioFailureCount}
                  件の音声開始失敗が記録されています。診断情報をコピーして相談すると、出力デバイスや音声許可の問題を確認しやすくなります。
                </p>
              </section>
            ) : null}

            {savedProjectLoadFailureCount > 0 ? (
              <section
                className="support-menu__recovery support-menu__recovery--warning"
                aria-labelledby="support-saved-project-load-failure-title"
              >
                <h3 id="support-saved-project-load-failure-title">保存済みプロジェクトを開けなかった記録</h3>
                <p>
                  {savedProjectLoadFailureCount}
                  件の保存済みプロジェクト読み込み失敗が記録されています。診断情報をコピーして相談すると、保存データの状態を確認しやすくなります。
                </p>
              </section>
            ) : null}

            {appFlowFailureCount > 0 ? (
              <section
                className="support-menu__recovery support-menu__recovery--warning"
                aria-labelledby="support-app-flow-failure-title"
              >
                <h3 id="support-app-flow-failure-title">作成/起動に失敗した記録</h3>
                <p>
                  {appFlowFailureCount}
                  件の作成/起動失敗が記録されています。診断情報をコピーして相談すると、テンプレートや起動直後の問題を確認しやすくなります。
                </p>
              </section>
            ) : null}

            {recentDiagnostics.length > 0 ? (
              <section className="support-menu__recent" aria-labelledby="support-recent-title">
                <h3 id="support-recent-title">最近の診断</h3>
                <ul>
                  {recentDiagnostics.map((entry) => (
                    <li key={entry.id}>
                      <div>
                        <span>{entry.label}</span>
                        <time dateTime={entry.occurredAt}>{entry.occurredAtText}</time>
                      </div>
                      <p>{entry.message}</p>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className="support-menu__actions">
              <button type="button" onClick={() => void copyReport()}>
                診断情報をコピー
              </button>
              <button
                type="button"
                disabled={diagnostics.length === 0}
                title={diagnostics.length === 0 ? '消去する診断ログはありません' : undefined}
                onClick={clearLog}
              >
                診断ログを消去
              </button>
            </div>

            {message ? (
              <p className="support-menu__status" role="status" aria-live="polite">
                {message}
              </p>
            ) : null}

            {manualReport ? (
              <section className="support-menu__manual-copy" aria-labelledby="support-manual-copy-title">
                <h3 id="support-manual-copy-title">手動コピー用診断情報</h3>
                <p>クリップボードを使えない場合は、この内容を選択してサポートへ送れます。</p>
                <textarea
                  aria-label="手動コピー用診断情報"
                  readOnly
                  rows={8}
                  value={manualReport}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </section>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
