// Export menu in the top bar: MIDI / WAV / project-file export, and project-file
// import. Surfaces progress + errors as toasts and emits export app events.

import { useRef } from 'react';
import { MidiExportError, projectToMidi } from '@cts/midi-io';
import {
  DEFAULT_MAX_PROJECT_JSON_BYTES,
  ScheduleEventLimitError,
  decodeProjectJson,
  serializeProject,
} from '@cts/project-model';
import { useStore } from '../../state/store';
import { uid } from '../../state/ids';
import { publishAppEvent } from '../../state/appEvents';
import { pushToast } from '../../state/tutorialBridge';
import { renderProjectToWav, WavRenderLimitError } from '../../audio/wav';
import { AudioAssetPlaybackError } from '../../audio/audioAssetResolver';
import { AudioClipPlanLimitError } from '../../audio/audioClipPlanner';
import {
  downloadBlob,
  downloadBlobAndWaitForHandoff,
  safeFileStem,
} from './download';
import { saveWavRenderLease } from './wavExport';
import { cloneProjectForImport } from './projectImport';
import { studioRuntime } from '../../platform/runtime';
import {
  NativeFileGatewayError,
  nativeFileGateway,
} from '../../platform/nativeFileGateway';
import type { ExportOperation } from './ExportMenu';

type ExportMenuContentProps = {
  onDone: () => void;
  activeOperation: ExportOperation | null;
  beginOperation: (operation: ExportOperation) => boolean;
  finishOperation: (operation: ExportOperation) => void;
};

export function midiExportFailureMessage(error: unknown): string {
  if (error instanceof MidiExportError) {
    if (error.code === 'overlapping-note') {
      return '同じ音程のノートが重なっているためMIDIを書き出せません。重なりを短くするか、1つのノートにまとめてください。';
    }
    if (error.code === 'event-limit-exceeded') {
      return 'MIDIに書き出すノートが多すぎます。ノート、ループ、または連動コピーを減らしてください。';
    }
  }
  return 'MIDIの書き出しに失敗しました。';
}

export function wavExportFailureMessage(error: unknown): string {
  if (error instanceof ScheduleEventLimitError || error instanceof AudioClipPlanLimitError) {
    return '再生イベントが多すぎてWAVを書き出せません。ノート、ドラム、オーディオクリップ、または連動コピーを減らしてください。';
  }
  if (error instanceof WavRenderLimitError) {
    return 'WAV書き出しは5分以内の曲に対応しています。曲を短くしてください。';
  }
  if (error instanceof AudioAssetPlaybackError) {
    if (error.code === 'asset-missing') {
      return '保存済みの音声素材が見つからないためWAVを書き出せません。素材を保存した端末のアプリデータを確認してください。';
    }
    if (error.code === 'asset-changed') {
      return '保存済みの音声素材が変更または破損しているためWAVを書き出せません。';
    }
    if (error.code === 'resolver-unavailable' || error.code === 'asset-unavailable') {
      return '音声素材の保存領域へアクセスできないためWAVを書き出せません。端末の空き容量やアクセス権を確認してください。';
    }
    if (error.code === 'decode-failed') {
      return '保存済みの音声素材を読み取れないためWAVを書き出せません。';
    }
    if (error.code === 'resource-limit') {
      return '音声素材がWAV書き出し時のメモリ上限を超えています。使用する素材の数または長さを減らしてください。';
    }
  }
  return 'WAVの書き出しに失敗しました。';
}

/** Export/import controls loaded only after their dialog opens. */
export function ExportMenuContent({
  onDone,
  activeOperation,
  beginOperation,
  finishOperation,
}: ExportMenuContentProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const project = useStore((s) => s.project);
  const replaceProject = useStore((s) => s.replaceProject);

  const stem = safeFileStem(project.title);
  const isNative = studioRuntime.kind === 'native';
  const operationBusy = activeOperation !== null;
  const rendering = activeOperation === 'wav-export';

  const exportMidi = async () => {
    const operation = 'midi-export' satisfies ExportOperation;
    if (!beginOperation(operation)) return;
    try {
      const bytes = projectToMidi(project);
      const fileName = `${stem}.mid`;
      if (isNative) {
        const result = await nativeFileGateway.exportMidi(bytes, fileName);
        if (result.status === 'cancelled') return;
      } else {
        // Copy into a fresh ArrayBuffer so the Blob owns a plain ArrayBuffer.
        const buffer = bytes.slice().buffer;
        downloadBlob(new Blob([buffer], { type: 'audio/midi' }), fileName);
      }
      publishAppEvent({ type: 'export.midi', payload: { format: 'midi' } });
      pushToast('MIDIファイルを書き出しました。', 'success');
    } catch (error) {
      pushToast(midiExportFailureMessage(error), 'error');
    } finally {
      finishOperation(operation);
    }
  };

  const exportWav = async () => {
    const operation = 'wav-export' satisfies ExportOperation;
    if (!beginOperation(operation)) return;
    try {
      const rendered = await renderProjectToWav(project);
      const fileName = `${stem}.wav`;
      const result = await saveWavRenderLease(rendered, fileName, {
        runtime: isNative ? 'native' : 'web',
        exportNative: (bytes, suggestedFileName) =>
          nativeFileGateway.exportWav(bytes, suggestedFileName),
        downloadWeb: downloadBlobAndWaitForHandoff,
      });
      if (result.status === 'cancelled') return;
      publishAppEvent({ type: 'export.wav', payload: { format: 'wav' } });
      pushToast('WAVファイルを書き出しました。', 'success');
    } catch (error) {
      pushToast(wavExportFailureMessage(error), 'error');
    } finally {
      finishOperation(operation);
    }
  };

  const exportProjectFile = async () => {
    const operation = 'project-export' satisfies ExportOperation;
    if (!beginOperation(operation)) return;
    try {
      const json = serializeProject(project);
      const fileName = `${stem}.ctsproj.json`;
      if (isNative) {
        const result = await nativeFileGateway.exportProject(
          new TextEncoder().encode(json),
          fileName,
        );
        if (result.status === 'cancelled') return;
      } else {
        downloadBlob(new Blob([json], { type: 'application/json' }), fileName);
      }
      pushToast('プロジェクトを書き出しました。', 'success');
    } catch {
      pushToast('プロジェクトの書き出しに失敗しました。', 'error');
    } finally {
      finishOperation(operation);
    }
  };

  const importProjectJson = async (text: string) => {
    const decoded = decodeProjectJson(text);
    if (!decoded.ok) {
      pushToast(
        decoded.error.code === 'future-schema-version'
          ? 'このファイルは新しいアプリ版で作成されています。アプリを更新してください。'
          : 'プロジェクトファイルを安全に検証できませんでした。',
        'error',
      );
      return;
    }
    const importedProject = cloneProjectForImport(decoded.project, uid('project'));
    if (!(await replaceProject(importedProject))) {
      pushToast('現在のプロジェクトを保存できないため、読み込みを中止しました。', 'error');
      return;
    }
    onDone();
    const saveFailed = useStore.getState().saveState.phase === 'error';
    pushToast(
      saveFailed
        ? 'プロジェクトをコピーとして読み込みましたが、まだ端末に保存できていません。'
        : 'プロジェクトをコピーとして読み込みました。',
      saveFailed ? 'error' : 'success',
    );
  };

  const onImportFile = async (file: File) => {
    if (file.size > DEFAULT_MAX_PROJECT_JSON_BYTES) {
      pushToast('プロジェクトファイルが大きすぎます（上限16MB）。', 'error');
      return;
    }
    const operation = 'project-import' satisfies ExportOperation;
    if (!beginOperation(operation)) return;
    try {
      await importProjectJson(await file.text());
    } catch {
      pushToast('プロジェクトの読み込みに失敗しました。', 'error');
    } finally {
      finishOperation(operation);
    }
  };

  const openNativeProjectFile = async () => {
    const operation = 'project-import' satisfies ExportOperation;
    if (!beginOperation(operation)) return;
    try {
      const result = await nativeFileGateway.openProject();
      if (result.status === 'cancelled') return;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
      await importProjectJson(text);
    } catch (error) {
      pushToast(
        error instanceof NativeFileGatewayError && error.code === 'file-too-large'
          ? 'プロジェクトファイルが大きすぎます（上限16MB）。'
          : error instanceof NativeFileGatewayError &&
              (error.code === 'invalid-file' ||
                error.code === 'invalid-envelope' ||
                error.code === 'invalid-filename')
            ? 'プロジェクトファイルを安全に検証できませんでした。'
            : 'プロジェクトの読み込みに失敗しました。',
        'error',
      );
    } finally {
      finishOperation(operation);
    }
  };

  return (
    <div className="export-menu">
            <section className="export-menu__group">
              <p className="panel-section__title">音源として書き出す</p>
              <div className="export-menu__row">
                <button
                  type="button"
                  onClick={() => void exportMidi()}
                  disabled={operationBusy}
                >
                  MIDIエクスポート
                </button>
                <button
                  type="button"
                  onClick={() => void exportWav()}
                  disabled={operationBusy}
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
                <button
                  type="button"
                  onClick={() => void exportProjectFile()}
                  disabled={operationBusy}
                >
                  プロジェクト書き出し
                </button>
                <button
                  type="button"
                  disabled={operationBusy}
                  onClick={() => {
                    if (isNative) void openNativeProjectFile();
                    else fileInputRef.current?.click();
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
                .ctsproj.jsonには編集情報だけを書き出し、Audio Trackの音声本体は含みません。同じ端末の素材保存領域がある場合に、別のコピーとして読み込んで編集できます。
              </p>
            </section>
    </div>
  );
}
