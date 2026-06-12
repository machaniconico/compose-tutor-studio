// Export menu in the top bar: MIDI / WAV / project-file export, and project-file
// import. Surfaces progress + errors as toasts and emits export app events.
// MIDI/WAV export first shows a pre-export checklist (docs/02 §8.2); warnings
// are educational only and never block the export.

import { useRef, useState } from 'react';
import { projectToMidi } from '@cts/midi-io';
import {
  deserializeProject,
  serializeProject,
  validateProject,
} from '@cts/project-model';
import { useStore } from '../../state/store';
import { publishAppEvent } from '../../state/appEvents';
import { pushToast } from '../../state/tutorialBridge';
import { renderProjectToWav } from '../../audio/wav';
import { Dialog } from '../common/Dialog';
import { downloadBlob, safeFileStem } from './download';
import {
  clearExportHistory,
  formatExportKindJa,
  formatExportRelativeTimeJa,
  getExportKindIcon,
  loadExportHistory,
  recordExportHistory,
  type ExportHistoryEntry,
} from './exportHistory';
import {
  evaluateExportChecklist,
  hasExportChecklistWarnings,
  type ExportChecklistItem,
} from './exportChecklist';
import './exportChecklist.css';

/** 書き出し前チェックの対象になる形式。 */
type PendingExportKind = 'midi' | 'wav';

type PendingChecklist = {
  kind: PendingExportKind;
  items: ExportChecklistItem[];
};

/** Top-bar export button + dialog. */
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [history, setHistory] = useState<ExportHistoryEntry[]>(() => loadExportHistory());
  const [checklist, setChecklist] = useState<PendingChecklist | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const project = useStore((s) => s.project);
  const replaceProject = useStore((s) => s.replaceProject);

  const stem = safeFileStem(project.title);

  const openMenu = () => {
    setHistory(loadExportHistory());
    setChecklist(null);
    setOpen(true);
  };

  const exportMidi = () => {
    try {
      const bytes = projectToMidi(project);
      // Copy into a fresh ArrayBuffer so the Blob owns a plain ArrayBuffer.
      const buffer = bytes.slice().buffer;
      const fileName = `${stem}.mid`;
      downloadBlob(new Blob([buffer], { type: 'audio/midi' }), fileName);
      publishAppEvent({ type: 'export.midi', payload: { format: 'midi' } });
      setHistory(recordExportHistory({ kind: 'midi', fileName, projectId: project.id }));
      pushToast('MIDIファイルを書き出しました。', 'success');
    } catch {
      pushToast('MIDIの書き出しに失敗しました。', 'error');
    }
  };

  const exportWav = async () => {
    setRendering(true);
    try {
      const blob = await renderProjectToWav(project);
      const fileName = `${stem}.wav`;
      downloadBlob(blob, fileName);
      publishAppEvent({ type: 'export.wav', payload: { format: 'wav' } });
      setHistory(recordExportHistory({ kind: 'wav', fileName, projectId: project.id }));
      pushToast('WAVファイルを書き出しました。', 'success');
    } catch {
      pushToast('WAVの書き出しに失敗しました。', 'error');
    } finally {
      setRendering(false);
    }
  };

  const exportProjectFile = () => {
    try {
      const json = serializeProject(project);
      const fileName = `${stem}.ctsproj.json`;
      downloadBlob(
        new Blob([json], { type: 'application/json' }),
        fileName,
      );
      setHistory(recordExportHistory({ kind: 'project', fileName, projectId: project.id }));
      pushToast('プロジェクトを書き出しました。', 'success');
    } catch {
      pushToast('プロジェクトの書き出しに失敗しました。', 'error');
    }
  };

  /** MIDI/WAV ボタン → まず書き出し前チェックを表示する。 */
  const openChecklist = (kind: PendingExportKind) => {
    setChecklist({ kind, items: evaluateExportChecklist(project) });
  };

  /** チェックをやめてメニューに戻る (書き出しは実行しない)。 */
  const cancelChecklist = () => {
    setChecklist(null);
  };

  /** チェック内容を確認したうえで書き出しを実行する。 */
  const proceedExport = () => {
    if (!checklist) return;
    const kind = checklist.kind;
    setChecklist(null);
    if (kind === 'midi') {
      exportMidi();
    } else {
      void exportWav();
    }
  };

  const clearHistory = () => {
    clearExportHistory();
    setHistory([]);
  };

  const onImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const loaded = deserializeProject(text);
      const result = validateProject(loaded);
      if (!result.ok) {
        pushToast('プロジェクトファイルが正しくありません。', 'error');
        return;
      }
      replaceProject(loaded);
      setOpen(false);
      pushToast('プロジェクトを読み込みました。', 'success');
    } catch {
      pushToast('プロジェクトの読み込みに失敗しました。', 'error');
    }
  };

  return (
    <>
      <button type="button" onClick={openMenu}>
        書き出し
      </button>

      {open && checklist ? (
        <ExportChecklistDialog
          checklist={checklist}
          rendering={rendering}
          onCancel={cancelChecklist}
          onProceed={proceedExport}
        />
      ) : null}

      {open && !checklist ? (
        <Dialog title="書き出し / 読み込み" onClose={() => setOpen(false)}>
          <div className="export-menu">
            <section className="export-menu__group">
              <p className="panel-section__title">音源として書き出す</p>
              <div className="export-menu__row">
                <button type="button" onClick={() => openChecklist('midi')}>
                  MIDIエクスポート
                </button>
                <button
                  type="button"
                  onClick={() => openChecklist('wav')}
                  disabled={rendering}
                >
                  {rendering ? '書き出し中…' : 'WAVエクスポート'}
                </button>
              </div>
              <p className="export-menu__hint">
                MIDIは他のアプリで編集でき、WAVはそのまま再生・共有できます。
              </p>
            </section>

            <section className="export-menu__group">
              <p className="panel-section__title">プロジェクトファイル</p>
              <div className="export-menu__row">
                <button type="button" onClick={exportProjectFile}>
                  プロジェクト書き出し
                </button>
                <button type="button" onClick={() => fileInputRef.current?.click()}>
                  プロジェクト読み込み
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onImportFile(file);
                  e.target.value = '';
                }}
              />
              <p className="export-menu__hint">
                書き出したファイル（.ctsproj.json）を読み込むと、続きから編集できます。
              </p>
            </section>

            <section className="export-menu__group" aria-label="書き出し履歴">
              <div className="export-menu__row">
                <p className="panel-section__title">書き出し履歴</p>
                <button type="button" onClick={clearHistory} disabled={history.length === 0}>
                  履歴をクリア
                </button>
              </div>
              {history.length === 0 ? (
                <p className="export-menu__hint">まだ書き出し履歴はありません。</p>
              ) : (
                <ul className="export-menu__history">
                  {history.map((entry) => (
                    <li
                      key={`${entry.exportedAt}-${entry.kind}-${entry.fileName}`}
                      className="export-menu__history-item"
                    >
                      <span aria-hidden="true">{getExportKindIcon(entry.kind)}</span>
                      <span>{entry.fileName}</span>
                      <span className="export-menu__hint">
                        {formatExportKindJa(entry.kind)} ・{' '}
                        {formatExportRelativeTimeJa(entry.exportedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

type ExportChecklistDialogProps = {
  checklist: PendingChecklist;
  rendering: boolean;
  onCancel: () => void;
  onProceed: () => void;
};

/**
 * 書き出し前チェックリストの確認ダイアログ。
 * warning があっても「このまま書き出す」で続行できる教育的UI (書き出しは妨げない)。
 */
function ExportChecklistDialog({
  checklist,
  rendering,
  onCancel,
  onProceed,
}: ExportChecklistDialogProps) {
  const hasWarnings = hasExportChecklistWarnings(checklist.items);
  const kindLabel = formatExportKindJa(checklist.kind);

  return (
    <Dialog title={`書き出し前チェック（${kindLabel}）`} onClose={onCancel}>
      <div className="export-checklist">
        <p className="export-checklist__summary">
          {hasWarnings
            ? '気になるポイントが見つかりました。理由を読んで、直してから書き出すか、このまま書き出すかを選べます。'
            : 'チェックはすべてOKです。このまま書き出せます。'}
        </p>
        <ul className="export-checklist__list">
          {checklist.items.map((item) => (
            <li
              key={item.id}
              className={`export-checklist__item export-checklist__item--${item.level}`}
            >
              <span className="export-checklist__badge">
                {item.level === 'warning' ? '注意' : 'OK'}
              </span>
              <div className="export-checklist__text">
                <p className="export-checklist__title">{item.title}</p>
                <p className="export-checklist__advice">{item.advice}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="export-checklist__actions">
          <button type="button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="button" onClick={onProceed} disabled={rendering}>
            {hasWarnings ? 'このまま書き出す' : `${kindLabel}を書き出す`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
