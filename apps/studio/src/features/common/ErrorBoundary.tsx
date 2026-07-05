import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  clearDiagnostics,
  formatDiagnosticReport,
  loadDiagnostics,
  recordDiagnostic,
  type DiagnosticEntry,
} from '../../platform/diagnostics';

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  entry: DiagnosticEntry | null;
  copied: boolean;
  cleared: boolean;
  manualReport: string | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    entry: null,
    copied: false,
    cleared: false,
    manualReport: null,
  };

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const entry = recordDiagnostic('render-error', error, {
      componentStack: info.componentStack,
    });
    this.setState({ entry, copied: false, cleared: false, manualReport: null });
  }

  private reload = (): void => {
    window.location.reload();
  };

  private copyReport = async (): Promise<void> => {
    const report = formatDiagnosticReport(loadDiagnostics());
    try {
      await navigator.clipboard.writeText(report);
      this.setState({ copied: true, cleared: false, manualReport: null });
    } catch {
      this.setState({ copied: false, cleared: false, manualReport: report });
    }
  };

  private clearLog = (): void => {
    clearDiagnostics();
    this.setState({ copied: false, cleared: true, manualReport: null });
  };

  override render() {
    if (!this.state.entry) return this.props.children;

    return (
      <main className="error-boundary" role="alert" aria-live="assertive">
        <section className="error-boundary__panel">
          <p className="panel-section__title">エラー</p>
          <h1 className="error-boundary__title">画面の再描画に失敗しました</h1>
          <p className="error-boundary__lead">
            編集中のプロジェクトは自動保存ログに残っている可能性があります。アプリを再読み込みして、保存済みプロジェクトを確認してください。
          </p>
          <dl className="error-boundary__meta">
            <div>
              <dt>診断ID</dt>
              <dd>{this.state.entry.id}</dd>
            </div>
            <div>
              <dt>内容</dt>
              <dd>{this.state.entry.message}</dd>
            </div>
          </dl>
          <div className="error-boundary__actions">
            <button type="button" onClick={this.reload}>
              再読み込み
            </button>
            <button type="button" onClick={() => void this.copyReport()}>
              診断情報をコピー
            </button>
            <button type="button" onClick={this.clearLog}>
              診断ログを消去
            </button>
          </div>
          {this.state.copied ? (
            <p className="error-boundary__status">診断情報をコピーしました。</p>
          ) : null}
          {this.state.cleared ? (
            <p className="error-boundary__status">診断ログを消去しました。</p>
          ) : null}
          {this.state.manualReport ? (
            <section
              className="error-boundary__manual-copy"
              aria-labelledby="error-boundary-manual-copy-title"
            >
              <h2 id="error-boundary-manual-copy-title">手動コピー用診断情報</h2>
              <p>クリップボードを使えない場合は、この内容を選択してサポートへ送れます。</p>
              <textarea
                aria-label="手動コピー用診断情報"
                readOnly
                rows={8}
                value={this.state.manualReport}
                onFocus={(event) => event.currentTarget.select()}
              />
            </section>
          ) : null}
        </section>
      </main>
    );
  }
}
