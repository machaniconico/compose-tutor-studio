// Export menu in the top bar: MIDI / WAV / project-file export, and project-file
// import. Surfaces progress + errors as toasts and emits export app events.
// MIDI/WAV export first shows a pre-export checklist (docs/02 §8.2); warnings
// are educational only and never block the export.

import { useRef, useState } from 'react';
import { projectToMidi } from '@cts/midi-io';
import { serializeProject } from '@cts/project-model';
import { useStore } from '../../state/store';
import { publishAppEvent } from '../../state/appEvents';
import { pushToast } from '../../state/tutorialBridge';
import { recordDiagnostic } from '../../platform/diagnostics';
import {
  assertWavRenderFits,
  collectChannels,
  encodeWav,
  normalizePeakInChunks,
  planWavRender,
  renderWavAudio,
  RENDER_SAMPLE_RATE,
  WavSizeLimitError,
  wavLoopWindow,
  type WavBitDepth,
  type WavExportOptions,
  type WavExportRange,
  type WavSampleRate,
} from '../../audio/wav';
import { measureAudioLevels } from '../../audio/loudness';
import { Dialog } from '../common/Dialog';
import { safeFileStem } from './download';
import { parseProjectFileImport } from './projectFileImport';
import {
  canUseNativeFileDialogs,
  openTextFileFromDialog,
  saveBlob,
} from '../../platform/fileDialogs';
import {
  clearExportHistory,
  formatExportKindJa,
  formatExportRelativeTimeJa,
  formatWavExportSettingsJa,
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
import { fileTransferFailureMessage } from './exportFailureMessages';
import { exportStemTracks, prepareStemZip } from './exportStems';
import { ZipStoreLimitError } from './zipStore';
import './exportChecklist.css';

/** 書き出し前チェックの対象になる形式。 */
type PendingExportKind = 'midi' | 'wav';

type WavPreparation =
  | { status: 'loading'; label: string; fraction?: number }
  | { status: 'failed'; reason: string }
  | {
      status: 'ready';
      loudness: number;
      peak: number;
      settings: Required<WavExportOptions> & { stems: boolean };
      makeBlob: (onProgress: (current: number, total: number) => void) => Promise<Blob>;
    };

type PendingChecklist = { items: ExportChecklistItem[] } & (
  | { kind: 'midi' }
  | { kind: 'wav'; preparation: WavPreparation }
);

/** Top-bar export button + dialog. */
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [wavProgress, setWavProgress] = useState<string | null>(null);
  const [sampleRate, setSampleRate] = useState<WavSampleRate>(RENDER_SAMPLE_RATE);
  const [range, setRange] = useState<WavExportRange>('full');
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(16);
  const [dither, setDither] = useState(false);
  const [normalize, setNormalize] = useState(false);
  const [stems, setStems] = useState(false);
  const [history, setHistory] = useState<ExportHistoryEntry[]>(() => loadExportHistory());
  const [checklist, setChecklist] = useState<PendingChecklist | null>(null);
  const wavRequest = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const project = useStore((s) => s.project);
  const replaceProject = useStore((s) => s.replaceProject);

  const stem = safeFileStem(project.title);
  const loop = range === 'loop' ? wavLoopWindow(project) : undefined;
  const loopReason = loop && 'reason' in loop ? loop.reason : undefined;
  const noStems = stems && exportStemTracks(project.tracks).length === 0;
  const wavBlocked = wavProgress !== null || loopReason !== undefined || noStems;

  const openMenu = () => {
    setHistory(loadExportHistory());
    setChecklist(null);
    setOpen(true);
  };

  const importProjectFromText = (text: string): boolean => {
    const result = parseProjectFileImport(text);
    if (!result.ok) {
      recordDiagnostic('project-import', result.diagnosticMessage);
      pushToast(result.userMessage, 'error');
      return false;
    }
    replaceProject(result.project);
    setOpen(false);
    pushToast('プロジェクトを読み込みました。', 'success');
    return true;
  };

  const exportMidi = async () => {
    try {
      const bytes = projectToMidi(project);
      // Copy into a fresh ArrayBuffer so the Blob owns a plain ArrayBuffer.
      const buffer = bytes.slice().buffer;
      const fileName = `${stem}.mid`;
      const result = await saveBlob(new Blob([buffer], { type: 'audio/midi' }), fileName, [
        { name: 'MIDI', extensions: ['mid', 'midi'] },
      ]);
      if (result === 'cancelled') return;
      publishAppEvent({ type: 'export.midi', payload: { format: 'midi' } });
      setHistory(recordExportHistory({ kind: 'midi', fileName, projectId: project.id }));
      pushToast('MIDIファイルを書き出しました。', 'success');
    } catch (error) {
      recordDiagnostic('export-midi', error);
      pushToast(fileTransferFailureMessage('export-midi'), 'error');
    }
  };

  const exportWav = async (prepared: Extract<WavPreparation, { status: 'ready' }>) => {
    const { settings, makeBlob } = prepared;
    setWavProgress('WAVの音声を作っています…');
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const blob = await makeBlob((current, total) => {
        setWavProgress(`ステムを作っています（${current} / ${total}）…`);
      });
      const extension = settings.stems ? 'zip' : 'wav';
      const label = settings.stems ? 'ステム ZIP' : 'WAV';
      setWavProgress(`${label}を保存しています…`);
      const fileName = `${stem}.${extension}`;
      const result = await saveBlob(blob, fileName, [
        { name: label, extensions: [extension] },
      ]);
      if (result === 'cancelled') return;
      publishAppEvent({ type: 'export.wav', payload: { format: 'wav' } });
      setHistory(recordExportHistory({ kind: 'wav', fileName, projectId: project.id, ...settings }));
      pushToast(settings.stems ? 'ステム ZIP を書き出しました。' : 'WAVファイルを書き出しました。', 'success');
    } catch (error) {
      recordDiagnostic('export-wav', error);
      pushToast(fileTransferFailureMessage('export-wav'), 'error');
    } finally {
      setWavProgress(null);
    }
  };

  const exportProjectFile = async () => {
    try {
      const json = serializeProject(project);
      const fileName = `${stem}.ctsproj.json`;
      const result = await saveBlob(new Blob([json], { type: 'application/json' }), fileName, [
        { name: 'Compose Tutor project', extensions: ['json'] },
      ]);
      if (result === 'cancelled') return;
      setHistory(recordExportHistory({ kind: 'project', fileName, projectId: project.id }));
      pushToast('プロジェクトを書き出しました。', 'success');
    } catch (error) {
      recordDiagnostic('project-export', error);
      pushToast(fileTransferFailureMessage('project-export'), 'error');
    }
  };

  /** Render the selected range and show its loudness before asking to save. */
  const prepareWav = async () => {
    if (wavBlocked) return;
    const items = evaluateExportChecklist(project);
    setChecklist({
      kind: 'wav', items, preparation: { status: 'loading', label: '書き出す範囲の音声を作っています…' },
    });
    const request = new AbortController();
    wavRequest.current?.abort();
    wavRequest.current = request;
    const settings = { sampleRate, range, bitDepth, dither: bitDepth === 16 && dither, normalize, stems };
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (request.signal.aborted) return;
      const mix = planWavRender(project, settings);
      if (!stems) assertWavRenderFits(mix.frames, bitDepth);
      const makeZip = stems ? prepareStemZip(mix, settings) : undefined;
      const rendered = await renderWavAudio(mix);
      if (request.signal.aborted) return;
      const input = collectChannels(rendered);
      const updateProgress = (label: string, fraction: number) => {
        setChecklist({ kind: 'wav', items, preparation: { status: 'loading', label, fraction } });
      };
      const channels = normalize ? await normalizePeakInChunks(input, {
        signal: request.signal,
        onProgress: (fraction) => updateProgress('音量をそろえています…', fraction),
      }) : input;
      const { loudness, peak } = await measureAudioLevels(channels, sampleRate, {
        signal: request.signal,
        onProgress: (phase, fraction) => {
          const label = phase === 'loudness' ? '平均的な音の大きさを測っています…' : '音の最大レベルを測っています…';
          updateProgress(label, fraction);
        },
      });
      if (request.signal.aborted) return;
      const makeBlob = makeZip ?? (async () => new Blob(
        [encodeWav(channels, sampleRate, { bitDepth, dither: settings.dither })],
        { type: 'audio/wav' },
      ));
      setChecklist({ kind: 'wav', items, preparation: { status: 'ready', loudness, peak, settings, makeBlob } });
    } catch (error) {
      if (request.signal.aborted) return;
      recordDiagnostic('export-wav', error);
      const reason = error instanceof ZipStoreLimitError || error instanceof WavSizeLimitError
        ? error.message
        : fileTransferFailureMessage('export-wav');
      setChecklist({ kind: 'wav', items, preparation: { status: 'failed', reason } });
    }
  };

  const cancelChecklist = () => {
    wavRequest.current?.abort();
    setChecklist(null);
  };

  const proceedExport = () => {
    if (!checklist) return;
    if (checklist.kind === 'midi') {
      setChecklist(null);
      void exportMidi();
    } else if (checklist.preparation.status === 'ready' && wavProgress === null) {
      setChecklist(null);
      void exportWav(checklist.preparation);
    }
  };

  const clearHistory = () => {
    clearExportHistory();
    setHistory([]);
  };

  const importProjectFromDesktop = async () => {
    try {
      const text = await openTextFileFromDialog([
        { name: 'Compose Tutor project', extensions: ['json'] },
      ]);
      if (text === null) return;
      importProjectFromText(text);
    } catch (error) {
      recordDiagnostic('project-import', error);
      pushToast(fileTransferFailureMessage('project-import'), 'error');
    }
  };

  const onImportFile = async (file: File) => {
    try {
      const text = await file.text();
      importProjectFromText(text);
    } catch (error) {
      recordDiagnostic('project-import', error);
      pushToast(fileTransferFailureMessage('project-import'), 'error');
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
          stems={stems}
          blocked={checklist.kind === 'wav' && (wavProgress !== null || checklist.preparation.status !== 'ready')}
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
                <button type="button" onClick={() => setChecklist({ kind: 'midi', items: evaluateExportChecklist(project) })}>
                  MIDIエクスポート
                </button>
                <button
                  type="button"
                  onClick={() => void prepareWav()}
                  disabled={wavBlocked}
                >
                  {stems ? 'ステム ZIP を確認' : 'WAVエクスポート'}
                </button>
              </div>
              <div className="export-menu__row">
                <label className="export-menu__field">
                  WAVのサンプルレート
                  <select
                    value={sampleRate}
                    disabled={wavProgress !== null}
                    onChange={(event) => setSampleRate(event.target.value === '48000' ? 48000 : RENDER_SAMPLE_RATE)}
                  >
                    <option value={44100}>44.1 kHz</option>
                    <option value={48000}>48 kHz</option>
                  </select>
                </label>
                <label className="export-menu__field">
                  WAVの書き出し範囲
                  <select
                    value={range}
                    disabled={wavProgress !== null}
                    onChange={(event) => setRange(event.target.value === 'loop' ? 'loop' : 'full')}
                    aria-invalid={loopReason ? true : undefined}
                    aria-describedby={loopReason ? 'wav-loop-reason' : undefined}
                  >
                    <option value="full">全体</option>
                    <option value="loop">ループ範囲</option>
                  </select>
                </label>
                <label className="export-menu__field">
                  WAVのビット数
                  <select
                    value={bitDepth}
                    disabled={wavProgress !== null}
                    onChange={(event) => setBitDepth(event.target.value === '24' ? 24 : 16)}
                  >
                    <option value={16}>16ビット</option>
                    <option value={24}>24ビット</option>
                  </select>
                </label>
              </div>
              {loopReason && <p id="wav-loop-reason" className="export-menu__hint" role="alert">{loopReason}</p>}
              <label className="export-menu__toggle">
                <input
                  type="checkbox"
                  checked={bitDepth === 16 && dither}
                  disabled={bitDepth === 24 || wavProgress !== null}
                  onChange={(event) => setDither(event.target.checked)}
                />
                16ビット変換のゆがみを抑える（ディザ）
              </label>
              <label className="export-menu__toggle">
                <input
                  type="checkbox"
                  checked={normalize}
                  disabled={wavProgress !== null}
                  aria-describedby={stems ? 'wav-stem-normalize' : undefined}
                  onChange={(event) => setNormalize(event.target.checked)}
                />
                一番大きい音を −1 dBFS にそろえる
              </label>
              {stems && (
                <p id="wav-stem-normalize" className="export-menu__hint">
                  この設定を使うと、ステムでは WAV ごとに音量をそろえます。全部を重ねても元のミックスと同じにはなりません。
                </p>
              )}
              <label className="export-menu__toggle">
                <input
                  type="checkbox"
                  checked={stems}
                  disabled={wavProgress !== null}
                  aria-describedby="wav-stem-rules"
                  onChange={(event) => setStems(event.target.checked)}
                />
                トラックごとの WAV を ZIP にまとめる
              </label>
              <p id="wav-stem-rules" className="export-menu__hint">
                ミュートしたトラックは入りません。ソロが有効なときはソロのトラックだけが入り、
                その音が送られる共有エフェクト（リターン）は別の WAV に入ります。
                ソロが有効でないときは、ミュートしていないリターンが別の WAV になります。
              </p>
              {noStems && <p className="export-menu__hint" role="alert">ミュートを解除して、書き出すトラックを選んでください。</p>}
              <div role="status">{wavProgress}</div>
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
                <button
                  type="button"
                  onClick={() => {
                    if (canUseNativeFileDialogs()) {
                      void importProjectFromDesktop();
                    } else {
                      fileInputRef.current?.click();
                    }
                  }}
                >
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
                        {entry.kind === 'wav' && `${formatWavExportSettingsJa(entry)} ・ `}
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
  stems: boolean;
  blocked: boolean;
  onCancel: () => void;
  onProceed: () => void;
};

/**
 * 書き出し前チェックリストの確認ダイアログ。
 * warning があっても「このまま書き出す」で続行できる教育的UI (書き出しは妨げない)。
 */
function ExportChecklistDialog({
  checklist,
  stems,
  blocked,
  onCancel,
  onProceed,
}: ExportChecklistDialogProps) {
  const hasWarnings = hasExportChecklistWarnings(checklist.items);
  const preparation = checklist.kind === 'wav' ? checklist.preparation : undefined;
  const kindLabel = checklist.kind === 'wav' && stems
    ? 'ステム ZIP'
    : formatExportKindJa(checklist.kind);

  return (
    <Dialog title={`書き出し前チェック（${kindLabel}）`} onClose={onCancel}>
      <div className="export-checklist">
        <p className="export-checklist__summary">
          {hasWarnings
            ? '気になるポイントが見つかりました。理由を読んで、直してから書き出すか、このまま書き出すかを選べます。'
            : preparation && preparation.status !== 'ready'
              ? '曲のチェック項目はすべてOKです。'
              : 'チェックはすべてOKです。このまま書き出せます。'}
        </p>
        {preparation && (
          <div className="export-checklist__levels" role="status">
            {preparation.status === 'loading' && (
              <>
                <p>{preparation.label}</p>
                <progress aria-label={preparation.label} value={preparation.fraction} max={1} />
              </>
            )}
            {preparation.status === 'failed' && <p>{preparation.reason}</p>}
            {preparation.status === 'ready' && (
              <>
                <p>
                  選んだ範囲で、音を混ぜたときの平均的な大きさ{' '}
                  {preparation.loudness === -Infinity ? 'ゲート以下（とても小さいか無音）' : `${preparation.loudness.toFixed(1)} LUFS`}
                </p>
                <p>
                  音の瞬間的な最大レベル{' '}
                  {preparation.peak === -Infinity ? '無音' : `${preparation.peak.toFixed(1)} dBTP`}
                </p>
                <p className="export-menu__hint">動画BGMの目安としては −14〜−16 LUFS 付近がよく使われます。</p>
              </>
            )}
          </div>
        )}
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
          <button type="button" onClick={onCancel} autoFocus>
            キャンセル
          </button>
          <button type="button" onClick={onProceed} disabled={blocked}>
            {hasWarnings ? 'このまま書き出す' : `${kindLabel}を書き出す`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
