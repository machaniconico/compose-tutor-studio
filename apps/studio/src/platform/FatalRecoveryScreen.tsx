import { useEffect, useRef, useState } from 'react';
import {
  copyRuntimeDiagnosticReport,
  formatRuntimeDiagnosticReport,
  type DiagnosticCopyResult,
} from './runtimeDiagnostics';

export type FatalRecoveryReason = 'render' | 'startup';

export type FatalRecoveryScreenProps = Readonly<{
  reason: FatalRecoveryReason;
  onReload?: () => void;
  copyReport?: () => Promise<DiagnosticCopyResult>;
}>;

function reloadCurrentDocument(): void {
  window.location.reload();
}

/** Accessible, network-free last-resort UI for an unrecoverable renderer state. */
export function FatalRecoveryScreen({
  reason,
  onReload = reloadCurrentDocument,
  copyReport = copyRuntimeDiagnosticReport,
}: FatalRecoveryScreenProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copyState, setCopyState] = useState<DiagnosticCopyResult | 'idle'>('idle');
  const diagnosticReport = formatRuntimeDiagnosticReport();

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const description =
    reason === 'startup'
      ? '安全な起動処理を完了できなかったため、編集画面を開きませんでした。'
      : '予期しない問題が発生したため、この画面での編集を停止しました。';

  return (
    <main className="fatal-recovery">
      <section className="fatal-recovery__panel" aria-labelledby="fatal-recovery-title">
        <div role="alert" aria-live="assertive">
          <p className="fatal-recovery__eyebrow">安全のため処理を停止しました</p>
          <h1 id="fatal-recovery-title" ref={headingRef} tabIndex={-1}>
            アプリを続行できませんでした
          </h1>
          <p className="fatal-recovery__lead">{description}</p>
        </div>

        <div className="fatal-recovery__guidance">
          <h2>次にできること</h2>
          <ol>
            <li>アプリを再読み込みして、最後に保存された状態から再開してください。</li>
            <li>同じ画面が続く場合は、下の診断情報をコピーしてサポートへ共有してください。</li>
          </ol>
          <p>
            再読み込み後は、最後に正常保存できた状態の復元を試みます。直前の未保存編集は復元できない場合があります。
          </p>
        </div>

        <div className="fatal-recovery__actions">
          <button type="button" className="fatal-recovery__primary" onClick={onReload}>
            アプリを再読み込み
          </button>
          <button
            type="button"
            onClick={() => {
              void Promise.resolve()
                .then(copyReport)
                .then(setCopyState)
                .catch(() => setCopyState('failed'));
            }}
          >
            診断情報をコピー
          </button>
        </div>

        {copyState !== 'idle' ? (
          <p
            className={`fatal-recovery__copy-status is-${copyState}`}
            role={copyState === 'copied' ? 'status' : 'alert'}
          >
            {copyState === 'copied'
              ? '診断情報をコピーしました。'
              : '自動コピーできませんでした。下の診断情報を選択してコピーしてください。'}
          </p>
        ) : null}

        <details className="fatal-recovery__details">
          <summary>診断情報を表示</summary>
          <p>この情報は自動送信されず、曲名・曲データ・ファイル名・端末内のパスを含みません。</p>
          <textarea
            className="fatal-recovery__report"
            aria-label="サポートへ共有する診断情報"
            readOnly
            rows={12}
            spellCheck={false}
            value={diagnosticReport}
            onFocus={(event) => event.currentTarget.select()}
          />
        </details>
      </section>
    </main>
  );
}
