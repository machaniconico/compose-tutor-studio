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
import {
  renderProjectToWav,
  renderSelectedTrackToWav,
  WavRenderLimitError,
} from '../../audio/wav';
import { AudioAssetPlaybackError } from '../../audio/audioAssetResolver';
import { AudioClipPlanLimitError } from '../../audio/audioClipPlanner';
import { AudioWarpDspError } from '../../audio/audioWarpDsp';
import { AudioWarpPlanError } from '../../audio/audioWarpPlan';
import {
  downloadBlob,
  downloadBlobAndWaitForHandoff,
  safeFileStem,
} from './download';
import { saveWavRenderLease } from './wavExport';
import {
  selectedTrackWavAvailability,
  selectedTrackWavFileName,
} from './trackWavExport';
import { cloneProjectForImport } from './projectImport';
import {
  exportPortableProjectBundle,
  importPortableProjectBundle,
} from './portableProjectBundle';
import {
  MAX_PORTABLE_PROJECT_BUNDLE_BYTES,
  PORTABLE_PROJECT_BUNDLE_EXTENSION,
  PORTABLE_PROJECT_BUNDLE_MIME_TYPE,
  PortableProjectBundleError,
} from '@cts/project-bundle';
import {
  reservePortableProjectBundleResources,
} from './portableProjectBundleReservation';
import {
  portableProjectBundleFailureMessage,
} from './portableProjectBundleErrors';
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
  if (error instanceof AudioWarpPlanError || error instanceof AudioWarpDspError) {
    if (error.code === 'resource-limit') {
      return 'Elastic Audioの処理がWAV書き出し時のメモリ上限を超えています。編集するクリップの数または長さを減らしてください。';
    }
    if (error.code === 'cancelled') {
      return 'Elastic Audioの処理を中止したため、WAVは書き出されませんでした。';
    }
    return 'Elastic Audioの編集を音にできないためWAVを書き出せません。タイミング点やピッチ補正範囲を確認してください。元の音声素材は変更されていません。';
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
  const portableFileInputRef = useRef<HTMLInputElement | null>(null);

  const project = useStore((s) => s.project);
  const selectedTrackId = useStore((s) => s.editor.selectedTrackId);
  const replaceProject = useStore((s) => s.replaceProject);

  const stem = safeFileStem(project.title);
  const isNative = studioRuntime.kind === 'native';
  const operationBusy = activeOperation !== null;
  const renderingMix = activeOperation === 'wav-export';
  const renderingTrack = activeOperation === 'track-wav-export';
  const selectedWav = selectedTrackWavAvailability(project, selectedTrackId);

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

  const exportSelectedTrackWav = async () => {
    if (!selectedWav.enabled || !selectedWav.track) return;
    const operation = 'track-wav-export' satisfies ExportOperation;
    if (!beginOperation(operation)) return;
    try {
      const rendered = await renderSelectedTrackToWav(project, selectedWav.track.id);
      const fileName = selectedTrackWavFileName(project.title, selectedWav.track.name);
      const result = await saveWavRenderLease(rendered, fileName, {
        runtime: isNative ? 'native' : 'web',
        exportNative: (bytes, suggestedFileName) =>
          nativeFileGateway.exportWav(bytes, suggestedFileName),
        downloadWeb: downloadBlobAndWaitForHandoff,
      });
      if (result.status === 'cancelled') return;
      publishAppEvent({ type: 'export.wav', payload: { format: 'wav' } });
      pushToast(`「${selectedWav.track.name}」をWAVファイルに書き出しました。`, 'success');
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

  const exportPortableProjectFile = async () => {
    const operation = 'portable-project-export' satisfies ExportOperation;
    if (!beginOperation(operation)) return;
    let reservation: ReturnType<typeof reservePortableProjectBundleResources> | undefined;
    try {
      reservation = reservePortableProjectBundleResources();
      const bytes = await exportPortableProjectBundle(project, studioRuntime.audioAssets, {
        reservation,
      });
      if (isNative) {
        const result = await nativeFileGateway.exportProjectBundle(
          bytes,
          `${stem}${PORTABLE_PROJECT_BUNDLE_EXTENSION}`,
          reservation,
        );
        if (result.status === 'cancelled') return;
      } else {
        await downloadBlobAndWaitForHandoff(
          new Blob([bytes], { type: PORTABLE_PROJECT_BUNDLE_MIME_TYPE }),
          `${stem}${PORTABLE_PROJECT_BUNDLE_EXTENSION}`,
        );
      }
      pushToast('音声込みポータブルプロジェクトを書き出しました。', 'success');
    } catch (error) {
      const message = portableProjectBundleFailureMessage(error, 'export');
      if (message !== null) pushToast(message, 'error');
    } finally {
      reservation?.release();
      finishOperation(operation);
    }
  };

  const adoptPortableProject = async (
    input: Uint8Array,
    reservation: ReturnType<typeof reservePortableProjectBundleResources>,
    expectedProject: typeof project,
  ): Promise<void> => {
    if (useStore.getState().project !== expectedProject) {
      throw new PortableProjectBundleError('adoption-failed');
    }
    const replaced = await importPortableProjectBundle(input, {
      createProjectId: () => uid('project'),
      replaceProject: (importedProject) => {
        const state = useStore.getState();
        if (state.project !== expectedProject) return Promise.resolve(false);
        return replaceProject(importedProject);
      },
      reservation,
    });
    if (!replaced) throw new PortableProjectBundleError('adoption-failed');
    onDone();
    const saveFailed = useStore.getState().saveState.phase === 'error';
    pushToast(
      saveFailed
        ? '音声込みプロジェクトを読み込みましたが、まだ端末に保存できていません。'
        : '音声込みプロジェクトをコピーとして読み込みました。',
      saveFailed ? 'error' : 'success',
    );
  };

  const onImportPortableFile = async (file: File) => {
    const fileSize = file.size;
    if (fileSize > MAX_PORTABLE_PROJECT_BUNDLE_BYTES) {
      pushToast('ポータブルプロジェクトが大きすぎます（上限128MB）。', 'error');
      return;
    }
    const operation = 'portable-project-import' satisfies ExportOperation;
    if (!beginOperation(operation)) return;
    let reservation: ReturnType<typeof reservePortableProjectBundleResources> | undefined;
    try {
      reservation = reservePortableProjectBundleResources(fileSize);
      const input = new Uint8Array(await file.arrayBuffer());
      await adoptPortableProject(input, reservation, project);
    } catch (error) {
      const message = portableProjectBundleFailureMessage(error, 'import');
      if (message !== null) pushToast(message, 'error');
    } finally {
      reservation?.release();
      finishOperation(operation);
    }
  };

  const importPortableProjectFromNative = async () => {
    const operation = 'portable-project-import' satisfies ExportOperation;
    if (!beginOperation(operation)) return;
    let reservation: ReturnType<typeof reservePortableProjectBundleResources> | undefined;
    try {
      reservation = reservePortableProjectBundleResources();
      const result = await nativeFileGateway.openProjectBundle(reservation);
      if (result.status === 'cancelled') return;
      await adoptPortableProject(result.bytes, reservation, project);
    } catch (error) {
      const message = portableProjectBundleFailureMessage(error, 'import');
      if (message !== null) pushToast(message, 'error');
    } finally {
      reservation?.release();
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
                  {renderingMix ? '書き出し中…' : 'WAVエクスポート'}
                </button>
                <button
                  type="button"
                  onClick={() => void exportSelectedTrackWav()}
                  disabled={operationBusy || !selectedWav.enabled}
                  title={selectedWav.reason ?? undefined}
                >
                  {renderingTrack ? '選択トラックを書き出し中…' : '選択トラックをWAV'}
                </button>
              </div>
              <p className="export-menu__hint">
                MIDIは他のアプリで編集でき、WAVはそのまま再生・共有できます。
              </p>
              <p className="export-menu__hint">
                選択中: {selectedWav.track?.name ?? 'なし'}。楽器・ドラム・オーディオに対応します。
                保存済みのミュート／ソロは無視し、下流Bus、センド、エフェクト、オートメーション込みで書き出します。
                個別WAVを加算しても元のミックスを再現するものではありません。
                {selectedWav.reason ? ` ${selectedWav.reason}` : ''}
              </p>
            </section>

            <section className="export-menu__group">
              <p className="panel-section__title">編集情報のみ (.ctsproj.json)</p>
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

            <section className="export-menu__group">
                <p className="panel-section__title">
                  音声込みポータブル ({PORTABLE_PROJECT_BUNDLE_EXTENSION})
                </p>
                <div className="export-menu__row">
                  <button
                    type="button"
                    onClick={() => void exportPortableProjectFile()}
                    disabled={operationBusy}
                  >
                    音声込みポータブルを書き出し
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (isNative) void importPortableProjectFromNative();
                      else portableFileInputRef.current?.click();
                    }}
                    disabled={operationBusy}
                  >
                    音声込みポータブルを読み込み
                  </button>
                </div>
                {!isNative ? (
                  <input
                    ref={portableFileInputRef}
                    type="file"
                    accept={`${PORTABLE_PROJECT_BUNDLE_EXTENSION},${PORTABLE_PROJECT_BUNDLE_MIME_TYPE}`}
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void onImportPortableFile(file);
                      event.target.value = '';
                    }}
                  />
                ) : null}
                <p className="export-menu__hint">
                  Audio Trackの音声本体も含め、1つのファイルとして別のブラウザーへ持ち運べます。上限は128MBです。
                </p>
                <p className="export-menu__hint">
                  録音・読み込んだ元の音声素材を含みます。第三者へ渡すと素材も共有されるため、自作音源または共有の許諾がある音源だけを含めてください。アプリが自動で外部送信することはありません。
                </p>
              </section>
    </div>
  );
}
