import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  SOURCE_AUDIO_ACCEPT,
  SourceAudioFileError,
  inspectSourceAudioBlob,
  sourceAudioStem,
  validateSourceAudioBlobSize,
  type SourceAudioDescriptor,
} from '../../audio/sourceAudio';
import { loadSourceAudioPresentationDuration } from '../../audio/sourceAudioPresentation';
import {
  SourceAudioDecodeBusyError,
  getActiveSourceAudioDecodeJob,
  startExclusiveSourceAudioDecode,
  type SourceAudioDecodeJob,
} from '../../audio/sourceAudioDecode';
import {
  MAX_VOCAL_CUT_SECONDS,
  VOCAL_CUT_PRESETS,
  VocalCutError,
  planVocalCutDecode,
  renderVocalCutToWav,
  trimVocalCutCodecPadding,
  validateVocalCutEncodedTiming,
  validateVocalCutSourceTiming,
  type VocalCutPresetId,
  type VocalCutProgress,
  type VocalCutResult,
} from '../../audio/vocalCut';
import { downloadBlob, safeFileStem } from '../export/download';
import { studioRuntime } from '../../platform/runtime';
import {
  NativeFileGatewayError,
  nativeFileGateway,
} from '../../platform/nativeFileGateway';
import { pushToast } from '../../state/tutorialBridge';
import type { VocalCutToolContentProps } from './VocalCutTool';

type SourceSelection = Readonly<{
  fileName: string;
  blob: Blob;
  url: string;
  descriptor: SourceAudioDescriptor;
  durationSeconds: number;
}>;

type CompletedResult = Readonly<{
  rendered: VocalCutResult;
  url: string;
  fileName: string;
}>;

type Operation = 'selecting' | 'processing' | 'cancelling' | 'saving' | null;

class VocalCutUiError extends Error {
  constructor(readonly code: 'metadata' | 'decode' | 'decode-busy' | 'selection-busy') {
    super(code);
    this.name = 'VocalCutUiError';
  }
}

function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return mebibytes >= 10 ? `${mebibytes.toFixed(0)} MB` : `${mebibytes.toFixed(1)} MB`;
}

function outputFileName(sourceFileName: string): string {
  return `${safeFileStem(sourceAudioStem(sourceFileName))}_karaoke.wav`;
}

export function vocalCutPreflightDurationSeconds(
  presentationDurationSeconds: number,
  descriptor: SourceAudioDescriptor,
): number {
  validateVocalCutSourceTiming({
    format: descriptor.format,
    sampleRate: descriptor.sampleRate,
    presentationDurationSeconds,
    containerDurationSeconds: descriptor.containerDurationSeconds,
    decodeDurationSeconds: descriptor.decodeDurationSeconds,
  });
  return Math.min(
    presentationDurationSeconds,
    descriptor.containerDurationSeconds,
    MAX_VOCAL_CUT_SECONDS,
  );
}

function createDecodeContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: 44_100 });
  } catch {
    return new AudioContext();
  }
}

type DecodeJob = SourceAudioDecodeJob;

type SourceSelectionJob = Readonly<{
  result: Promise<void>;
  settled: Promise<void>;
  startedAt: number;
}>;

let activeSourceSelectionJob: SourceSelectionJob | null = null;
const BACKGROUND_JOB_RECOVERY_HINT_MS = 30_000;

function startExclusiveSourceSelection(task: () => Promise<void>): SourceSelectionJob {
  if (activeSourceSelectionJob) throw new VocalCutUiError('selection-busy');
  const result = Promise.resolve().then(task);
  let job: SourceSelectionJob;
  const settled = result.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (activeSourceSelectionJob === job) activeSourceSelectionJob = null;
  });
  job = { result, settled, startedAt: Date.now() };
  activeSourceSelectionJob = job;
  return job;
}

function startExclusiveDecode(
  context: AudioContext,
  blob: Blob,
): DecodeJob {
  try {
    return startExclusiveSourceAudioDecode(context, blob);
  } catch (error) {
    if (error instanceof SourceAudioDecodeBusyError) {
      throw new VocalCutUiError('decode-busy');
    }
    throw error;
  }
}

function awaitDecodeOrCancel(
  job: DecodeJob,
  signal: AbortSignal,
): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => finish(new VocalCutError('cancelled'));
    const finish = (error?: unknown, decoded?: AudioBuffer): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (decoded) resolve(decoded);
      else reject(error ?? new VocalCutUiError('decode'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    job.result.then(
      (decoded) => finish(undefined, decoded),
      () => finish(new VocalCutUiError('decode')),
    );
  });
}

export function vocalCutFailureMessage(error: unknown): string {
  if (error instanceof SourceAudioFileError) {
    if (error.code === 'file-too-large') {
      return '音源ファイルが大きすぎます（上限128 MB）。';
    }
    if (error.code === 'invalid-filename') {
      return 'WAV、MP3、AAC、またはAAC-LC形式のM4Aを選んでください。';
    }
    return '拡張子と音声形式が一致しないか、音源ファイルが破損しています。M4AはAAC-LC形式に対応しています。';
  }
  if (error instanceof NativeFileGatewayError) {
    if (error.code === 'file-too-large') {
      return '音源ファイルが大きすぎます（上限128 MB）。';
    }
    if (error.code === 'invalid-file' || error.code === 'invalid-filename') {
      return '対応する音源ファイルを安全に確認できませんでした。';
    }
    return '音源ファイルを開けませんでした。保存場所の権限を確認してください。';
  }
  if (error instanceof VocalCutError) {
    if (error.code === 'stereo-required') {
      return 'この機能は2チャンネルのステレオ音源に対応しています。モノラル音源は処理できません。';
    }
    if (error.code === 'near-mono') {
      return '左右の差がほとんどない音源です。この方式では伴奏まで消えるため処理を中止しました。';
    }
    if (error.code === 'duration-limit-exceeded') {
      return 'ボーカルカットは5分以内の音源に対応しています。';
    }
    if (error.code === 'resource-limit-exceeded') {
      return 'この音源は処理に必要なメモリが大きすぎます。短い音源か低いサンプルレートの音源を選んでください。';
    }
    if (error.code === 'non-finite-sample' || error.code === 'invalid-audio') {
      return '音声データを安全に処理できませんでした。別の音源を選んでください。';
    }
  }
  if (error instanceof VocalCutUiError) {
    if (error.code === 'selection-busy') {
      return '前の音源確認が終わるまでお待ちください。';
    }
    if (error.code === 'decode-busy') {
      return '前の音源の読み込み終了を待っています。完了後にもう一度お試しください。';
    }
    return error.code === 'metadata'
      ? '音源の長さを確認できませんでした。端末で再生できる別の形式をお試しください。'
      : 'この端末では音源をデコードできませんでした。WAV形式をお試しください。';
  }
  return 'ボーカルカットの作成に失敗しました。別の音源でお試しください。';
}

function overallProgress(progress: VocalCutProgress): number {
  if (progress.phase === 'analyzing') return progress.fraction * 0.2;
  if (progress.phase === 'processing') return 0.2 + progress.fraction * 0.55;
  return 0.75 + progress.fraction * 0.25;
}

function progressLabel(progress: VocalCutProgress | null): string {
  if (!progress) return '音源をデコードしています…';
  if (progress.phase === 'analyzing') return 'ステレオ成分を解析しています…';
  if (progress.phase === 'processing') return '中央成分を抑えています…';
  return 'WAVファイルを組み立てています…';
}

function suitabilityLabel(result: VocalCutResult): string {
  if (result.analysis.suitability === 'good') {
    return '適性：高（左右差成分が多く、この方式に比較的向いています）';
  }
  if (result.analysis.suitability === 'fair') {
    return '適性：中（中央の楽器も弱くなる場合があります）';
  }
  return '適性：低（中央の楽器が大きく弱くなる可能性があります）';
}

type PreviewComparisonProps = Readonly<{
  sourceUrl: string;
  resultUrl: string;
}>;

function PreviewComparison({ sourceUrl, resultUrl }: PreviewComparisonProps) {
  const [mode, setMode] = useState<'source' | 'result'>('result');
  const audioRef = useRef<HTMLAudioElement>(null);
  const resumeRef = useRef<{ time: number; playing: boolean } | null>(null);

  useEffect(() => {
    setMode('result');
    resumeRef.current = null;
  }, [resultUrl]);

  const changeMode = (nextMode: 'source' | 'result'): void => {
    if (mode === nextMode) return;
    const audio = audioRef.current;
    resumeRef.current = audio
      ? { time: audio.currentTime, playing: !audio.paused }
      : null;
    audio?.pause();
    setMode(nextMode);
  };

  const restorePosition = (): void => {
    const audio = audioRef.current;
    const resume = resumeRef.current;
    if (!audio || !resume) return;
    resumeRef.current = null;
    const maximum = Number.isFinite(audio.duration) ? audio.duration : resume.time;
    audio.currentTime = Math.min(resume.time, Math.max(0, maximum - 0.01));
    if (resume.playing) void audio.play().catch(() => undefined);
  };

  return (
    <div className="vocal-cut__preview">
      <div className="vocal-cut__ab" role="group" aria-label="試聴する音源">
        <button
          type="button"
          aria-pressed={mode === 'source'}
          className={mode === 'source' ? 'is-active' : ''}
          onClick={() => changeMode('source')}
        >
          原曲
        </button>
        <button
          type="button"
          aria-pressed={mode === 'result'}
          className={mode === 'result' ? 'is-active' : ''}
          onClick={() => changeMode('result')}
        >
          ボーカルカット後
        </button>
      </div>
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={mode === 'source' ? sourceUrl : resultUrl}
        aria-label={mode === 'source' ? '原曲の試聴' : 'ボーカルカット後の試聴'}
        onLoadedMetadata={restorePosition}
      />
    </div>
  );
}

/** Deferred dialog body for a transient, entirely local center-reduction job. */
export function VocalCutToolContent({ onBusyChange }: VocalCutToolContentProps) {
  const [source, setSource] = useState<SourceSelection | null>(null);
  const [result, setResult] = useState<CompletedResult | null>(null);
  const [presetId, setPresetId] = useState<VocalCutPresetId>('standard');
  const [operation, setOperation] = useState<Operation>(null);
  const [decodePending, setDecodePending] = useState(
    getActiveSourceAudioDecodeJob() !== null,
  );
  const [selectionPending, setSelectionPending] = useState(
    activeSourceSelectionJob !== null,
  );
  const [decodeStalled, setDecodeStalled] = useState(
    getActiveSourceAudioDecodeJob() !== null &&
      Date.now() - (getActiveSourceAudioDecodeJob()?.startedAt ?? Date.now()) >=
        BACKGROUND_JOB_RECOVERY_HINT_MS,
  );
  const [selectionStalled, setSelectionStalled] = useState(
    activeSourceSelectionJob !== null &&
      Date.now() - activeSourceSelectionJob.startedAt >= BACKGROUND_JOB_RECOVERY_HINT_MS,
  );
  const [progress, setProgress] = useState<VocalCutProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('音源を選んでください。');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceButtonRef = useRef<HTMLButtonElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const previousDecodePendingRef = useRef(decodePending);
  const previousSelectionPendingRef = useRef(selectionPending);
  const busy = operation !== null;
  const dismissLocked = operation !== null && operation !== 'selecting';
  const controlsLocked = busy || decodePending || selectionPending;
  const isNative = studioRuntime.kind === 'native';

  useEffect(() => {
    onBusyChange(dismissLocked);
  }, [dismissLocked, onBusyChange]);

  useEffect(() => {
    const pending = getActiveSourceAudioDecodeJob();
    if (!pending) {
      setDecodePending(false);
      return;
    }
    let mounted = true;
    void pending.settled.finally(() => {
      if (mounted) setDecodePending(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const pending = getActiveSourceAudioDecodeJob();
    if (!decodePending || !pending) {
      setDecodeStalled(false);
      return;
    }
    const remaining = Math.max(
      0,
      BACKGROUND_JOB_RECOVERY_HINT_MS - (Date.now() - pending.startedAt),
    );
    const timeout = window.setTimeout(() => setDecodeStalled(true), remaining);
    return () => window.clearTimeout(timeout);
  }, [decodePending]);

  useEffect(() => {
    const pending = activeSourceSelectionJob;
    if (!selectionPending || !pending) {
      setSelectionStalled(false);
      return;
    }
    const remaining = Math.max(
      0,
      BACKGROUND_JOB_RECOVERY_HINT_MS - (Date.now() - pending.startedAt),
    );
    const timeout = window.setTimeout(() => setSelectionStalled(true), remaining);
    return () => window.clearTimeout(timeout);
  }, [selectionPending]);

  useEffect(() => {
    const wasPending = previousDecodePendingRef.current;
    previousDecodePendingRef.current = decodePending;
    if (wasPending && !decodePending && operation === null) {
      setStatusMessage(
        source
          ? '前の音源の読み込みが終了しました。もう一度ボーカルカットを作成できます。'
          : '前の音源の読み込みが終了しました。音源を選び直してください。',
      );
    }
  }, [decodePending, operation, source]);

  useEffect(() => {
    const wasPending = previousSelectionPendingRef.current;
    previousSelectionPendingRef.current = selectionPending;
    if (wasPending && !selectionPending && operation === null) {
      setStatusMessage(
        source
          ? '音源確認が終了しました。ボーカルカットを作成できます。'
          : '前の音源確認が終了しました。音源を選び直してください。',
      );
    }
  }, [operation, selectionPending, source]);

  useEffect(() => {
    const pending = activeSourceSelectionJob;
    if (!pending) {
      setSelectionPending(false);
      return;
    }
    let mounted = true;
    void pending.settled.finally(() => {
      if (mounted) setSelectionPending(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    sourceButtonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      abortRef.current?.abort();
      onBusyChange(false);
    };
  }, [onBusyChange]);

  useEffect(() => () => {
    if (source) URL.revokeObjectURL(source.url);
  }, [source]);

  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  useEffect(() => {
    if (result) resultHeadingRef.current?.focus({ preventScroll: true });
  }, [result]);

  const clearResult = (): void => {
    setResult(null);
    setProgress(null);
  };

  const acceptSource = async (
    fileName: string,
    blob: Blob,
    byteLength: number,
    trustedDescriptor?: SourceAudioDescriptor,
  ): Promise<void> => {
    const generation = ++generationRef.current;
    setOperation('selecting');
    setErrorMessage(null);
    setStatusMessage('音源を確認しています…');
    let url: string | null = null;
    try {
      validateSourceAudioBlobSize(blob.size, byteLength);
      const descriptor =
        trustedDescriptor ??
        await inspectSourceAudioBlob(fileName, blob, byteLength);
      if (descriptor.channelCount !== 2) {
        throw new VocalCutError('stereo-required');
      }
      validateVocalCutEncodedTiming(descriptor);
      const normalizedBlob = blob.slice(0, byteLength, descriptor.mimeType);
      url = URL.createObjectURL(normalizedBlob);
      let presentationDurationSeconds: number;
      try {
        presentationDurationSeconds = await loadSourceAudioPresentationDuration(url);
      } catch {
        throw new VocalCutUiError('metadata');
      }
      const durationSeconds = vocalCutPreflightDurationSeconds(
        presentationDurationSeconds,
        descriptor,
      );
      if (generation !== generationRef.current) return;
      setSource({ fileName, blob: normalizedBlob, url, descriptor, durationSeconds });
      clearResult();
      url = null;
      setStatusMessage('音源を読み込みました。仕上がりを選んで作成できます。');
    } catch (error) {
      if (generation === generationRef.current) {
        setErrorMessage(vocalCutFailureMessage(error));
        setStatusMessage(
          source
            ? '選択した音源を読み込めませんでした。前の音源と作成結果はそのままです。'
            : '音源を読み込めませんでした。',
        );
      }
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (generation === generationRef.current) setOperation(null);
    }
  };

  const chooseNativeSource = async (): Promise<void> => {
    if (controlsLocked) return;
    const generation = ++generationRef.current;
    setOperation('selecting');
    setErrorMessage(null);
    setStatusMessage('音源を選んでいます…');
    try {
      const job = startExclusiveSourceSelection(async () => {
        const selected = await nativeFileGateway.openAudio();
        if (generation !== generationRef.current || selected.status === 'cancelled') return;
        const blobBytes: Uint8Array<ArrayBuffer> =
          selected.bytes.buffer instanceof ArrayBuffer
            ? new Uint8Array(
                selected.bytes.buffer,
                selected.bytes.byteOffset,
                selected.bytes.byteLength,
              )
            : Uint8Array.from(selected.bytes);
        const blob = new Blob([blobBytes], { type: selected.descriptor.mimeType });
        setOperation(null);
        await acceptSource(
          selected.fileName,
          blob,
          selected.bytes.byteLength,
          selected.descriptor,
        );
      });
      setSelectionPending(true);
      void job.settled.finally(() => {
        if (mountedRef.current) setSelectionPending(false);
      });
      await job.result;
    } catch (error) {
      if (generation === generationRef.current) {
        setErrorMessage(vocalCutFailureMessage(error));
        setStatusMessage('音源を開けませんでした。');
      }
    } finally {
      if (generation === generationRef.current) setOperation(null);
    }
  };

  const chooseBrowserSource = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || controlsLocked) return;
    try {
      const job = startExclusiveSourceSelection(() =>
        acceptSource(file.name, file, file.size),
      );
      setSelectionPending(true);
      void job.settled.finally(() => {
        if (mountedRef.current) setSelectionPending(false);
      });
      await job.result;
    } catch (error) {
      if (mountedRef.current) {
        setErrorMessage(vocalCutFailureMessage(error));
        setStatusMessage('音源を確認できませんでした。');
      }
    }
  };

  const createVocalCut = async (): Promise<void> => {
    if (!source || controlsLocked) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setOperation('processing');
    setProgress(null);
    setErrorMessage(null);
    setStatusMessage('音源をデコードしています…');
    clearResult();
    let context: AudioContext | null = null;
    let decodeJob: DecodeJob | null = null;
    try {
      context = createDecodeContext();
      planVocalCutDecode(
        source.durationSeconds,
        context.sampleRate,
        source.blob.size,
        source.descriptor.channelCount,
        source.descriptor.decodeChannelCountUpperBound,
        source.descriptor.decodeDurationSeconds,
      );
      let decoded: AudioBuffer;
      try {
        decodeJob = startExclusiveDecode(context, source.blob);
        setDecodePending(true);
        void decodeJob.settled.finally(() => {
          if (generation === generationRef.current) setDecodePending(false);
        });
        decoded = await awaitDecodeOrCancel(decodeJob, controller.signal);
      } catch (error) {
        if (error instanceof VocalCutError) throw error;
        throw new VocalCutUiError('decode');
      }
      if (generation !== generationRef.current || controller.signal.aborted) {
        throw new VocalCutError('cancelled');
      }
      const boundedDecoded = trimVocalCutCodecPadding(decoded, {
        format: source.descriptor.format,
        sampleRate: source.descriptor.sampleRate,
        presentationDurationSeconds: source.durationSeconds,
        containerDurationSeconds: source.descriptor.containerDurationSeconds,
        decodeDurationSeconds: source.descriptor.decodeDurationSeconds,
      });
      const rendered = await renderVocalCutToWav(
        boundedDecoded,
        VOCAL_CUT_PRESETS[presetId],
        {
          signal: controller.signal,
          sourceBytes: source.blob.size,
          onProgress: (nextProgress) => {
            if (generation !== generationRef.current) return;
            setProgress(nextProgress);
            setStatusMessage(progressLabel(nextProgress));
          },
        },
      );
      if (generation !== generationRef.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(rendered.blob);
      setResult({ rendered, url, fileName: outputFileName(source.fileName) });
      setStatusMessage('ボーカルカットを作成しました。原曲と聴き比べてください。');
      pushToast('カラオケ用音源を作成しました。', 'success');
    } catch (error) {
      if (generation === generationRef.current) {
        if (error instanceof VocalCutError && error.code === 'cancelled') {
          setStatusMessage(
            decodeJob && getActiveSourceAudioDecodeJob() === decodeJob
              ? '処理を中止しました。端末内の読み込み終了後に再実行できます。'
              : '処理を中止しました。音源と設定はそのままです。',
          );
        } else {
          setErrorMessage(vocalCutFailureMessage(error));
          setStatusMessage('ボーカルカットを作成できませんでした。');
        }
      }
    } finally {
      abortRef.current = null;
      if (context) void context.close().catch(() => undefined);
      if (generation === generationRef.current) setOperation(null);
    }
  };

  const saveResult = async (): Promise<void> => {
    if (!result || controlsLocked) return;
    const generation = ++generationRef.current;
    setOperation('saving');
    setErrorMessage(null);
    setStatusMessage('WAVの保存先を確認しています…');
    try {
      if (isNative) {
        const bytes = new Uint8Array(await result.rendered.blob.arrayBuffer());
        const saved = await nativeFileGateway.exportWav(bytes, result.fileName);
        if (saved.status === 'cancelled') {
          setStatusMessage('WAVの保存をキャンセルしました。');
          return;
        }
      } else {
        downloadBlob(result.rendered.blob, result.fileName);
      }
      if (generation !== generationRef.current) return;
      setStatusMessage('カラオケ用WAVを書き出しました。');
      pushToast('カラオケ用WAVを書き出しました。', 'success');
    } catch {
      if (generation === generationRef.current) {
        setErrorMessage('WAVを書き出せませんでした。保存先の権限と空き容量を確認してください。');
        setStatusMessage('WAVを書き出せませんでした。');
      }
    } finally {
      if (generation === generationRef.current) setOperation(null);
    }
  };

  const cancelProcessing = (): void => {
    if (operation !== 'processing') return;
    abortRef.current?.abort();
    setOperation('cancelling');
    setStatusMessage('処理を中止しています…');
  };

  const progressValue = progress ? Math.round(overallProgress(progress) * 100) : null;

  return (
    <div className="vocal-cut">
      <p className="vocal-cut__lead">
        ステレオ音源の中央にある歌声を弱め、カラオケ用WAVを作ります。処理は端末内だけで行い、音源を外部へ送信しません。
      </p>

      <section className="vocal-cut__step" aria-labelledby="vocal-cut-source-title">
        <div className="vocal-cut__step-heading">
          <span aria-hidden="true">1</span>
          <h3 id="vocal-cut-source-title">音源を選ぶ</h3>
        </div>
        <button
          ref={sourceButtonRef}
          type="button"
          data-modal-initial-focus
          disabled={controlsLocked}
          onClick={() => {
            if (isNative) void chooseNativeSource();
            else fileInputRef.current?.click();
          }}
        >
          {operation === 'selecting'
            ? '確認中…'
            : selectionPending
              ? '音源確認の終了待ち…'
            : decodePending
              ? '読み込み終了待ち…'
              : source
                ? '別の音源を選ぶ'
                : '音源ファイルを選ぶ'}
        </button>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept={SOURCE_AUDIO_ACCEPT}
          tabIndex={-1}
          onChange={(event) => void chooseBrowserSource(event)}
        />
        <p className="vocal-cut__help">
          WAV / MP3 / M4A（AAC-LC） / AAC、最大128 MB・5分。圧縮形式は端末が再生できるコーデックに対応します。
        </p>
        {source ? (
          <dl className="vocal-cut__file" aria-label="選択した音源">
            <div><dt>ファイル</dt><dd>{source.fileName}</dd></div>
            <div><dt>形式</dt><dd>{source.descriptor.format.toUpperCase()}</dd></div>
            <div><dt>長さ</dt><dd>{formatDuration(source.durationSeconds)}</dd></div>
            <div><dt>サイズ</dt><dd>{formatBytes(source.blob.size)}</dd></div>
          </dl>
        ) : null}
      </section>

      <fieldset className="vocal-cut__step" disabled={controlsLocked || !source}>
        <legend className="vocal-cut__step-heading">
          <span aria-hidden="true">2</span>
          <span>仕上がりを選ぶ</span>
        </legend>
        <div className="vocal-cut__presets">
          {(Object.keys(VOCAL_CUT_PRESETS) as VocalCutPresetId[]).map((id) => {
            const preset = VOCAL_CUT_PRESETS[id];
            return (
              <label key={id} className={presetId === id ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="vocal-cut-preset"
                  value={id}
                  checked={presetId === id}
                  onChange={() => {
                    setPresetId(id);
                    setErrorMessage(null);
                    if (result) {
                      clearResult();
                      setStatusMessage('仕上がりを変更しました。もう一度ボーカルカットを作成してください。');
                    }
                  }}
                />
                <span><strong>{preset.label}</strong><small>{preset.description}</small></span>
              </label>
            );
          })}
        </div>
        <button
          type="button"
          className="vocal-cut__primary"
          disabled={!source || controlsLocked}
          onClick={() => void createVocalCut()}
        >
          ボーカルカットを作成
        </button>
      </fieldset>

      {operation === 'processing' || operation === 'cancelling' ? (
        <section className="vocal-cut__progress" aria-label="処理の進行状況">
          <progress max={100} {...(progressValue === null ? {} : { value: progressValue })} />
          <div>
            <span>
              {operation === 'cancelling'
                ? '処理を中止しています…'
                : progressLabel(progress)}
            </span>
            {progressValue === null ? null : <span>{progressValue}%</span>}
          </div>
          <button
            type="button"
            disabled={operation === 'cancelling'}
            onClick={cancelProcessing}
          >
            {operation === 'cancelling' ? '中止しています…' : '処理を中止'}
          </button>
        </section>
      ) : null}

      {decodePending && operation === null ? (
        <p className="vocal-cut__pending" role="status">
          中止した音源の読み込みを端末内で終了しています。
          {source ? '終了後にもう一度作成できます。' : '終了後に音源を選び直してください。'}
          この画面は閉じられます。
          {decodeStalled
            ? ' 長時間変わらない場合は、作曲内容を保存してからアプリを再読み込みしてください。デスクトップ版はアプリを再起動してください。'
            : null}
        </p>
      ) : null}

      {selectionPending && (operation === null || selectionStalled) ? (
        <p className="vocal-cut__pending" role="status">
          {operation === null
            ? '前の音源確認を端末内で終了しています。終了後に新しい音源を選べます。この画面は閉じられます。'
            : '音源確認に時間がかかっています。この画面は閉じられます。'}
          {selectionStalled
            ? ' 長時間変わらない場合は、作曲内容を保存してからアプリを再読み込みしてください。デスクトップ版はアプリを再起動してください。'
            : null}
        </p>
      ) : null}

      {result && source ? (
        <section className="vocal-cut__result" aria-labelledby="vocal-cut-result-title">
          <h3 id="vocal-cut-result-title" ref={resultHeadingRef} tabIndex={-1}>
            3. 聴き比べて保存
          </h3>
          <p className={`vocal-cut__suitability vocal-cut__suitability--${result.rendered.analysis.suitability}`}>
            {suitabilityLabel(result.rendered)}
          </p>
          <PreviewComparison sourceUrl={source.url} resultUrl={result.url} />
          <div className="vocal-cut__result-actions">
            <button
              type="button"
              className="vocal-cut__primary"
              disabled={controlsLocked}
              onClick={() => void saveResult()}
            >
              {operation === 'saving' ? '保存中…' : 'カラオケ用WAVを書き出す'}
            </button>
            <span>{result.fileName}</span>
          </div>
        </section>
      ) : null}

      {errorMessage ? <p className="vocal-cut__error" role="alert">{errorMessage}</p> : null}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </p>

      <aside className="vocal-cut__notice" aria-label="ボーカルカットの注意事項">
        <strong>仕上がりについて</strong>
        <p>
          左右に広がった歌声、コーラス、残響は残ることがあります。中央にあるキック、スネア、ベース、リード楽器も弱くなる場合があります。完全なボーカル除去やAIステム分離ではありません。
        </p>
        <p>自分で利用・加工する権利を持つ音源だけを使用してください。</p>
      </aside>
    </div>
  );
}
