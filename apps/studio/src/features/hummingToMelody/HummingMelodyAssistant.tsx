import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  beatToSecondsAt,
  compileMusicalTime,
  findLearningTrack,
  secondsToBeatAt,
} from '@cts/project-model';
import { midiToNoteName } from '@cts/theory-engine';
import {
  SOURCE_AUDIO_ACCEPT,
  SourceAudioFileError,
  inspectSourceAudioBlob,
  validateSourceAudioBlobSize,
  type SourceAudioDescriptor,
} from '../../audio/sourceAudio';
import { loadSourceAudioPresentationDuration } from '../../audio/sourceAudioPresentation';
import {
  SourceAudioDecodeBusyError,
  awaitSourceAudioDecodeOrCancel,
  getActiveSourceAudioDecodeJob,
  startExclusiveSourceAudioDecode,
  type SourceAudioDecodeJob,
} from '../../audio/sourceAudioDecode';
import {
  HummingTranscriptionError,
  transcribeHummingToMelody,
  type HummingMelodyNote,
  type HummingTranscriptionProgress,
} from '../../audio/hummingTranscription';
import {
  AudioResourceReservationError,
  checkedHeavyAudioResourceTotal,
  reserveHeavyAudioResources,
  type HeavyAudioResourceReservation,
} from '../../audio/audioResourceReservation';
import type { MicrophonePcmCapture } from '../../audio/microphoneCapture';
import {
  MAX_VOCAL_CUT_DECODER_RESYNC_SECONDS,
  VocalCutError,
  validateVocalCutEncodedTiming,
  vocalCutCodecPaddingSeconds,
  type AudioBufferShape,
} from '../../audio/vocalCut';
import { studioRuntime } from '../../platform/runtime';
import {
  NativeFileGatewayError,
  nativeFileGateway,
} from '../../platform/nativeFileGateway';
import { findClip, replaceClipNotes } from '../../state/editorActions';
import { uid } from '../../state/ids';
import { useStore } from '../../state/store';
import { pushToast } from '../../state/tutorialBridge';
import {
  HummingNoteMappingError,
  hummingMelodyToNoteEvents,
  type HummingQuantize,
} from './hummingToNotes';
import { HummingRecordingDialog } from './HummingRecordingDialog';

const MAX_HUMMING_SOURCE_SECONDS = 60;
const MAX_HUMMING_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_HUMMING_WORKING_BYTES = 256 * 1024 * 1024;
const HUMMING_RUNTIME_OVERHEAD_BYTES = 16 * 1024 * 1024;

type Phase = 'idle' | 'opening' | 'decoding' | 'analyzing';

type Detection = Readonly<{
  fileName: string;
  durationSeconds: number;
  notes: readonly HummingMelodyNote[];
}>;

type AppliedSnapshot = Readonly<{
  clipId: string;
  notesFingerprint: string;
}>;

type SourcePreflight = Readonly<{
  durationSeconds: number;
  estimatedWorkingBytes: number;
}>;

class HummingAssistantError extends Error {
  constructor(
    readonly code:
      | 'duration-limit-exceeded'
      | 'file-too-large'
      | 'channel-limit-exceeded'
      | 'resource-limit-exceeded'
      | 'decode-failed'
      | 'decode-busy'
      | 'metadata-failed'
      | 'no-notes'
      | 'too-many-notes'
      | 'apply-failed',
  ) {
    super(code);
    this.name = 'HummingAssistantError';
  }
}

function progressPercent(progress: HummingTranscriptionProgress): number {
  const start =
    progress.phase === 'validating'
      ? 0
      : progress.phase === 'aligning'
        ? 20
        : progress.phase === 'mixing'
          ? 30
          : 45;
  const share =
    progress.phase === 'validating'
      ? 20
      : progress.phase === 'aligning'
        ? 10
        : progress.phase === 'mixing'
          ? 15
          : 55;
  return Math.round(start + progress.fraction * share);
}

function notesFingerprint(
  notes: readonly Readonly<{
    id: string;
    pitch: number;
    startBeat: number;
    durationBeats: number;
    velocity: number;
  }>[],
): string {
  return JSON.stringify(
    notes.map(({ id, pitch, startBeat, durationBeats, velocity }) => [
      id,
      pitch,
      startBeat,
      durationBeats,
      velocity,
    ]),
  );
}

function failureMessage(error: unknown): string {
  if (
    (error instanceof HummingAssistantError && error.code === 'file-too-large') ||
    (error instanceof SourceAudioFileError && error.code === 'file-too-large') ||
    (error instanceof NativeFileGatewayError && error.code === 'file-too-large')
  ) {
    return '鼻歌の音声ファイルは32 MB以下にしてください。';
  }
  if (
    (error instanceof HummingAssistantError && error.code === 'duration-limit-exceeded') ||
    (error instanceof VocalCutError && error.code === 'duration-limit-exceeded') ||
    (error instanceof HummingTranscriptionError && error.code === 'duration-limit-exceeded')
  ) {
    return '鼻歌は60秒以内にしてください。短く区切ると音程を判定しやすくなります。';
  }
  if (
    (error instanceof HummingAssistantError && error.code === 'channel-limit-exceeded') ||
    (error instanceof HummingTranscriptionError && error.code === 'channel-limit-exceeded')
  ) {
    return 'モノラルまたはステレオの音声を選んでください。';
  }
  if (
    (error instanceof HummingAssistantError && error.code === 'resource-limit-exceeded') ||
    (error instanceof HummingTranscriptionError && error.code === 'resource-limit-exceeded') ||
    error instanceof AudioResourceReservationError
  ) {
    return 'この音源は端末内で安全に解析できるメモリ上限を超えています。短い音源に分けてください。';
  }
  if (error instanceof HummingAssistantError && error.code === 'metadata-failed') {
    return '音源の長さを確認できませんでした。別のWAV / MP3 / M4A / AACをお試しください。';
  }
  if (error instanceof HummingAssistantError && error.code === 'decode-busy') {
    return '前の音源の読み込みが終了してから、もう一度お試しください。';
  }
  if (error instanceof HummingAssistantError && error.code === 'no-notes') {
    return 'はっきりした単音のメロディを見つけられませんでした。伴奏を入れず、一定の声量で録音してください。';
  }
  if (error instanceof HummingAssistantError && error.code === 'too-many-notes') {
    return '音の切り替わりを細かく検出しすぎました。雑音や伴奏を減らし、短い鼻歌に分けてください。';
  }
  if (
    error instanceof SourceAudioFileError ||
    error instanceof NativeFileGatewayError
  ) {
    return '対応するWAV / MP3 / M4A（AAC-LC）/ AACを選んでください。';
  }
  if (error instanceof HummingTranscriptionError) {
    if (error.code === 'non-finite-sample') {
      return '音源に解析できないサンプル値が含まれています。別の音源へ書き出してお試しください。';
    }
    if (error.code === 'cancelled') return '';
  }
  if (
    error instanceof HummingNoteMappingError ||
    (error instanceof HummingAssistantError && error.code === 'apply-failed')
  ) {
    return '検出結果を現在のメロディクリップへ反映できませんでした。クリップの長さを確認してください。';
  }
  return '音声を解析できませんでした。伴奏のない短い鼻歌音源でお試しください。';
}

function createDecodeContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: 44_100 });
  } catch {
    return new AudioContext();
  }
}

function preflightSource(
  descriptor: SourceAudioDescriptor,
  presentationDurationSeconds: number,
  sourceBytes: number,
  decodeSampleRate: number,
): SourcePreflight {
  validateVocalCutEncodedTiming({
    format: descriptor.format,
    sampleRate: descriptor.sampleRate,
    containerDurationSeconds: descriptor.containerDurationSeconds,
    decodeDurationSeconds: descriptor.decodeDurationSeconds,
  }, MAX_HUMMING_SOURCE_SECONDS);
  const paddingSeconds = vocalCutCodecPaddingSeconds(
    descriptor.format,
    descriptor.sampleRate,
  );
  if (
    (descriptor.format !== 'aac' &&
      presentationDurationSeconds > MAX_HUMMING_SOURCE_SECONDS + paddingSeconds) ||
    descriptor.containerDurationSeconds > MAX_HUMMING_SOURCE_SECONDS + paddingSeconds ||
    descriptor.decodeDurationSeconds >
      descriptor.containerDurationSeconds + MAX_VOCAL_CUT_DECODER_RESYNC_SECONDS
  ) {
    throw new HummingAssistantError('duration-limit-exceeded');
  }
  if (
    descriptor.channelCount > 2 ||
    descriptor.decodeChannelCountUpperBound > 2
  ) {
    throw new HummingAssistantError('channel-limit-exceeded');
  }
  const frames = Math.ceil(descriptor.decodeDurationSeconds * decodeSampleRate);
  const analysisBytes =
    Math.ceil(MAX_HUMMING_SOURCE_SECONDS * 8_000) * Float64Array.BYTES_PER_ELEMENT;
  const estimatedWorkingBytes = checkedHeavyAudioResourceTotal([
    sourceBytes * 3,
    frames * descriptor.decodeChannelCountUpperBound * Float32Array.BYTES_PER_ELEMENT,
    analysisBytes,
    HUMMING_RUNTIME_OVERHEAD_BYTES,
  ]);
  if (
    !Number.isSafeInteger(frames) ||
    frames <= 0 ||
    !Number.isSafeInteger(estimatedWorkingBytes) ||
    estimatedWorkingBytes > MAX_HUMMING_WORKING_BYTES
  ) {
    throw new HummingAssistantError('resource-limit-exceeded');
  }
  return {
    durationSeconds: Math.min(
      presentationDurationSeconds,
      descriptor.containerDurationSeconds,
      MAX_HUMMING_SOURCE_SECONDS,
    ),
    estimatedWorkingBytes,
  };
}

function preflightCapturedPcm(buffer: AudioBufferShape): SourcePreflight {
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) {
    throw new HummingAssistantError('channel-limit-exceeded');
  }
  if (
    !Number.isSafeInteger(buffer.length) ||
    buffer.length <= 0 ||
    !Number.isSafeInteger(buffer.sampleRate) ||
    buffer.sampleRate < 8_000 ||
    buffer.sampleRate > 192_000
  ) {
    throw new HummingAssistantError('resource-limit-exceeded');
  }
  const durationSeconds = buffer.length / buffer.sampleRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds > MAX_HUMMING_SOURCE_SECONDS) {
    throw new HummingAssistantError('duration-limit-exceeded');
  }
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    if (buffer.getChannelData(channel).length !== buffer.length) {
      throw new HummingAssistantError('decode-failed');
    }
  }
  const analysisBytes =
    Math.ceil(MAX_HUMMING_SOURCE_SECONDS * 8_000) * Float64Array.BYTES_PER_ELEMENT;
  const estimatedWorkingBytes = checkedHeavyAudioResourceTotal([
    buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
    analysisBytes,
    HUMMING_RUNTIME_OVERHEAD_BYTES,
  ]);
  if (estimatedWorkingBytes > MAX_HUMMING_WORKING_BYTES) {
    throw new HummingAssistantError('resource-limit-exceeded');
  }
  return { durationSeconds, estimatedWorkingBytes };
}

function trimDecodedPadding(
  buffer: AudioBufferShape,
  descriptor: SourceAudioDescriptor,
): AudioBufferShape {
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) {
    throw new HummingAssistantError('channel-limit-exceeded');
  }
  const maximumFrames = Math.floor(MAX_HUMMING_SOURCE_SECONDS * buffer.sampleRate);
  if (buffer.length <= maximumFrames) return buffer;
  const paddingSeconds = vocalCutCodecPaddingSeconds(
    descriptor.format,
    descriptor.sampleRate,
  );
  const maximumPaddedFrames = Math.floor(
    (MAX_HUMMING_SOURCE_SECONDS + paddingSeconds) * buffer.sampleRate,
  );
  if (buffer.length > maximumPaddedFrames) {
    throw new HummingAssistantError('duration-limit-exceeded');
  }
  return {
    numberOfChannels: buffer.numberOfChannels,
    length: maximumFrames,
    sampleRate: buffer.sampleRate,
    getChannelData(channel: number): Float32Array {
      const data = buffer.getChannelData(channel);
      if (data.length < buffer.length) throw new HummingAssistantError('decode-failed');
      return data.subarray(0, maximumFrames);
    },
  };
}

/** Local microphone/file humming transcription with explicit preview before MIDI replacement. */
export function HummingMelodyAssistant() {
  const project = useStore((state) => state.project);
  const targetClips = useMemo(
    () =>
      project.tracks.flatMap((track) =>
        track.clips
          .filter((clip) => clip.type === 'midi' && !clip.aliasOf)
          .map((clip, index) => ({
            clipId: clip.id,
            trackId: track.id,
            label: `${track.name} — MIDI ${index + 1}`,
          })),
      ),
    [project],
  );
  const melodyTrackId = findLearningTrack(project, 'Melody')?.id;
  const preferredTarget =
    targetClips.find((target) => target.trackId === melodyTrackId) ?? targetClips[0];
  const [targetClipId, setTargetClipId] = useState(preferredTarget?.clipId ?? '');
  const [quantize, setQuantize] = useState<HummingQuantize>('sixteenth');
  const [phase, setPhase] = useState<Phase>('idle');
  const [decodePending, setDecodePending] = useState(false);
  const [decodeStalled, setDecodeStalled] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState('マイクで録音するか、録音済みの鼻歌ファイルを選んでください。');
  const [error, setError] = useState<string | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [applied, setApplied] = useState(false);
  const [appliedSnapshot, setAppliedSnapshot] = useState<AppliedSnapshot | null>(null);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceButtonRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const removeButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const applyingRef = useRef(false);
  const appliedRef = useRef(false);
  const contextRef = useRef<AudioContext | null>(null);
  const mountedRef = useRef(true);
  const isNative = studioRuntime.kind === 'native';
  const busy = phase !== 'idle' || decodePending || recordingOpen;

  const invalidateAppliedResult = (message: string): void => {
    appliedRef.current = false;
    setApplied(false);
    setAppliedSnapshot(null);
    setStatus(message);
  };

  const watchDecodeJob = (job: SourceAudioDecodeJob): void => {
    setDecodePending(true);
    void job.settled.finally(() => {
      if (mountedRef.current) setDecodePending(false);
    });
  };

  useEffect(() => {
    if (targetClips.some((target) => target.clipId === targetClipId)) return;
    setTargetClipId(preferredTarget?.clipId ?? '');
  }, [preferredTarget?.clipId, targetClipId, targetClips]);

  useEffect(() => {
    if (!appliedSnapshot) return;
    const clip = findClip(project, appliedSnapshot.clipId);
    if (
      clip?.type === 'midi' &&
      clip.notes !== undefined &&
      notesFingerprint(clip.notes) === appliedSnapshot.notesFingerprint
    ) return;
    appliedRef.current = false;
    setApplied(false);
    setAppliedSnapshot(null);
    setStatus('反映後にプロジェクトが変更されました。必要なら候補をもう一度反映してください。');
  }, [appliedSnapshot, project]);

  useEffect(
    () => {
      mountedRef.current = true;
      const pending = getActiveSourceAudioDecodeJob();
      if (pending) watchDecodeJob(pending);
      else setDecodePending(false);
      return () => {
        mountedRef.current = false;
        generationRef.current += 1;
        abortRef.current?.abort();
        const context = contextRef.current;
        contextRef.current = null;
        if (context) void context.close().catch(() => undefined);
      };
    },
    [],
  );

  useEffect(() => {
    const pending = getActiveSourceAudioDecodeJob();
    if (!decodePending || !pending) {
      setDecodeStalled(false);
      return;
    }
    const remaining = Math.max(0, 30_000 - (Date.now() - pending.startedAt));
    const timeout = window.setTimeout(() => setDecodeStalled(true), remaining);
    return () => window.clearTimeout(timeout);
  }, [decodePending]);

  const analyzeBuffer = async (
    generation: number,
    controller: AbortController,
    fileName: string,
    durationSeconds: number,
    buffer: AudioBufferShape,
  ): Promise<boolean> => {
    setPhase('analyzing');
    setProgress(0);
    setStatus('声の高さと音の区切りを解析しています…');
    const notes = await transcribeHummingToMelody(buffer, {
      signal: controller.signal,
      onProgress: (next) => {
        if (generation !== generationRef.current) return;
        setProgress(progressPercent(next));
      },
    });
    if (notes.length === 0) throw new HummingAssistantError('no-notes');
    if (notes.length > 512) throw new HummingAssistantError('too-many-notes');
    if (generation !== generationRef.current || controller.signal.aborted) return false;
    setDetection({ fileName, durationSeconds, notes });
    setProgress(100);
    setStatus(`${notes.length}個の音符候補を検出しました。対象を確認して反映してください。`);
    return true;
  };

  const processSource = async (
    fileName: string,
    blob: Blob,
    byteLength: number,
    trustedDescriptor?: SourceAudioDescriptor,
  ): Promise<void> => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('opening');
    setProgress(null);
    setError(null);
    setDetection(null);
    appliedRef.current = false;
    setApplied(false);
    setAppliedSnapshot(null);
    setStatus('音声ファイルを確認しています…');
    let url: string | null = null;
    let context: AudioContext | null = null;
    let decodeJob: SourceAudioDecodeJob | null = null;
    let resourceReservation: HeavyAudioResourceReservation | null = null;
    try {
      validateSourceAudioBlobSize(blob.size, byteLength);
      if (byteLength > MAX_HUMMING_SOURCE_BYTES) {
        throw new HummingAssistantError('file-too-large');
      }
      const descriptor =
        trustedDescriptor ?? (await inspectSourceAudioBlob(fileName, blob, byteLength));
      if (controller.signal.aborted) throw new HummingTranscriptionError('cancelled');
      validateVocalCutEncodedTiming(descriptor, MAX_HUMMING_SOURCE_SECONDS);
      const normalizedBlob = blob.slice(0, byteLength, descriptor.mimeType);
      url = URL.createObjectURL(normalizedBlob);
      let presentationDurationSeconds: number;
      try {
        presentationDurationSeconds = await loadSourceAudioPresentationDuration(
          url,
          controller.signal,
        );
      } catch {
        throw new HummingAssistantError('metadata-failed');
      }
      if (controller.signal.aborted) throw new HummingTranscriptionError('cancelled');
      context = createDecodeContext();
      contextRef.current = context;
      const sourcePreflight = preflightSource(
        descriptor,
        presentationDurationSeconds,
        normalizedBlob.size,
        context.sampleRate,
      );
      resourceReservation = reserveHeavyAudioResources(
        sourcePreflight.estimatedWorkingBytes,
      );
      setPhase('decoding');
      setStatus('音声を端末内で読み込んでいます…');
      let decoded: AudioBuffer;
      try {
        decodeJob = startExclusiveSourceAudioDecode(context, normalizedBlob);
        watchDecodeJob(decodeJob);
        decoded = await awaitSourceAudioDecodeOrCancel(decodeJob, controller.signal);
      } catch (decodeError) {
        if (decodeError instanceof SourceAudioDecodeBusyError) {
          const pending = getActiveSourceAudioDecodeJob();
          if (pending) watchDecodeJob(pending);
          throw new HummingAssistantError('decode-busy');
        }
        if (controller.signal.aborted) throw new HummingTranscriptionError('cancelled');
        throw new HummingAssistantError('decode-failed');
      }
      if (controller.signal.aborted) throw new HummingTranscriptionError('cancelled');
      const bounded = trimDecodedPadding(decoded, descriptor);
      await analyzeBuffer(
        generation,
        controller,
        fileName,
        sourcePreflight.durationSeconds,
        bounded,
      );
    } catch (caught) {
      if (generation !== generationRef.current) return;
      const cancelled =
        controller.signal.aborted ||
        (caught instanceof HummingTranscriptionError && caught.code === 'cancelled');
      setProgress(null);
      setError(cancelled ? null : failureMessage(caught));
      setStatus(
        cancelled
          ? getActiveSourceAudioDecodeJob()
            ? '解析を中止しました。端末内の読み込み終了後に再実行できます。'
            : '鼻歌の解析を中止しました。'
          : '鼻歌をメロディに変換できませんでした。',
      );
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (contextRef.current === context) contextRef.current = null;
      if (context) void context.close().catch(() => undefined);
      if (resourceReservation) {
        const release = (): void => resourceReservation?.release();
        if (decodeJob) void decodeJob.settled.then(release, release);
        else release();
      }
      if (abortRef.current === controller) abortRef.current = null;
      if (generation === generationRef.current) setPhase('idle');
    }
  };

  const processCapture = async (capture: MicrophonePcmCapture): Promise<void> => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('analyzing');
    setProgress(0);
    setError(null);
    setDetection(null);
    appliedRef.current = false;
    setApplied(false);
    setAppliedSnapshot(null);
    setStatus('マイク録音を端末内で解析しています…');
    let resourceReservation: HeavyAudioResourceReservation | null = null;
    try {
      const capturePreflight = preflightCapturedPcm(capture);
      resourceReservation = reserveHeavyAudioResources(
        capturePreflight.estimatedWorkingBytes,
      );
      const detected = await analyzeBuffer(
        generation,
        controller,
        'マイク録音',
        capturePreflight.durationSeconds,
        capture,
      );
      if (detected) {
        window.requestAnimationFrame(() => resultRef.current?.focus());
      }
    } catch (caught) {
      if (generation !== generationRef.current) return;
      const cancelled =
        controller.signal.aborted ||
        (caught instanceof HummingTranscriptionError && caught.code === 'cancelled');
      setProgress(null);
      setError(cancelled ? null : failureMessage(caught));
      setStatus(
        cancelled
          ? '鼻歌の解析を中止しました。'
          : '鼻歌をメロディに変換できませんでした。',
      );
    } finally {
      resourceReservation?.release();
      if (abortRef.current === controller) abortRef.current = null;
      if (generation === generationRef.current) setPhase('idle');
    }
  };

  const chooseNativeSource = async (): Promise<void> => {
    if (phase !== 'idle' || decodePending) return;
    const pickerGeneration = ++generationRef.current;
    setPhase('opening');
    setError(null);
    setStatus('音声ファイルを選んでいます…');
    try {
      const selected = await nativeFileGateway.openAudio();
      if (!mountedRef.current || generationRef.current !== pickerGeneration) return;
      if (selected.status === 'cancelled') {
        setStatus('音声ファイルの選択をキャンセルしました。');
        return;
      }
      const bytes: Uint8Array<ArrayBuffer> =
        selected.bytes.buffer instanceof ArrayBuffer
          ? new Uint8Array(
              selected.bytes.buffer,
              selected.bytes.byteOffset,
              selected.bytes.byteLength,
            )
          : Uint8Array.from(selected.bytes);
      await processSource(
        selected.fileName,
        new Blob([bytes], { type: selected.descriptor.mimeType }),
        bytes.byteLength,
        selected.descriptor,
      );
    } catch (caught) {
      if (mountedRef.current && generationRef.current === pickerGeneration) {
        setError(failureMessage(caught));
        setStatus('音声ファイルを開けませんでした。');
      }
    } finally {
      if (
        mountedRef.current &&
        generationRef.current === pickerGeneration &&
        !abortRef.current
      ) {
        setPhase('idle');
      }
    }
  };

  const chooseBrowserSource = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy) return;
    void processSource(file.name, file, file.size);
  };

  const openRecording = (): void => {
    if (phase !== 'idle' || decodePending || recordingOpen) return;
    const state = useStore.getState();
    if (state.transport.phase !== 'stopped') state.stop();
    setError(null);
    setRecordingOpen(true);
  };

  const chooseFileFromRecording = (): void => {
    setRecordingOpen(false);
    if (isNative) void chooseNativeSource();
    else fileInputRef.current?.click();
  };

  const applyDetection = (): void => {
    if (
      !detection ||
      busy ||
      !targetClipId ||
      applyingRef.current ||
      appliedRef.current
    ) return;
    applyingRef.current = true;
    try {
      const current = useStore.getState();
      const clip = findClip(current.project, targetClipId);
      const target = targetClips.find((candidate) => candidate.clipId === targetClipId);
      if (!clip || clip.type !== 'midi' || !target) {
        throw new HummingAssistantError('apply-failed');
      }
      const musicalTime = compileMusicalTime(current.project);
      const clipStartSeconds = beatToSecondsAt(musicalTime, clip.startBeat);
      const events = hummingMelodyToNoteEvents(detection.notes, {
        bpm: current.project.bpm,
        secondsToBeat: (seconds) => (
          secondsToBeatAt(musicalTime, clipStartSeconds + seconds) - clip.startBeat
        ),
        clipLengthBeats: clip.lengthBeats,
        quantize,
        createId: () => uid('note'),
      });
      if (events.length === 0 || !replaceClipNotes(clip.id, events)) {
        throw new HummingAssistantError('apply-failed');
      }
      const latest = useStore.getState();
      latest.selectTrack(target.trackId);
      latest.selectClip(clip.id);
      latest.setActiveView('pianoRoll');
      appliedRef.current = true;
      setApplied(true);
      setAppliedSnapshot({ clipId: clip.id, notesFingerprint: notesFingerprint(events) });
      setError(null);
      setStatus(`${events.length}個の音符を反映しました。ピアノロールで調整できます。`);
      pushToast('鼻歌をメロディクリップへ反映しました。', 'success');
    } catch (caught) {
      setError(failureMessage(caught));
      setStatus('検出結果を反映できませんでした。');
    } finally {
      applyingRef.current = false;
    }
  };

  return (
    <section className="panel-section assistant__humming" aria-labelledby="humming-title">
      <p className="panel-section__title" id="humming-title">鼻歌からメロディ</p>
      <p className="assistant__hint">
        伴奏のない単音の鼻歌を端末内で解析し、MIDI音符にします。録音データや解析結果を外部へ送信しません。
      </p>

      <div className="assistant__humming-actions">
        <button
          type="button"
          className="assistant__generate"
          disabled={busy}
          onClick={openRecording}
        >
          マイクで鼻歌を録音
        </button>
        <button
          ref={sourceButtonRef}
          type="button"
          disabled={busy}
          onClick={() => {
            if (isNative) void chooseNativeSource();
            else fileInputRef.current?.click();
          }}
        >
          {decodePending ? '読み込み終了待ち…' : phase !== 'idle' ? '解析中…' : '録音済みファイルを選ぶ'}
        </button>
      </div>
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept={SOURCE_AUDIO_ACCEPT}
        tabIndex={-1}
        onChange={chooseBrowserSource}
      />
      {phase !== 'idle' ? (
        <button type="button" onClick={() => abortRef.current?.abort()}>
          解析を中止
        </button>
      ) : null}
      <p className="assistant__hint">
        マイク録音は60秒まで（保存しません）。ファイルはWAV / MP3 / M4A（AAC-LC）/ AAC、32 MB・60秒まで。
      </p>
      {decodeStalled ? (
        <p role="alert" className="assistant__humming-error">
          読み込みに時間がかかっています。作曲内容を保存してから、Web版は再読み込み、デスクトップ版は再起動してください。
        </p>
      ) : null}

      {progress !== null ? (
        <progress value={progress} max={100} aria-label="鼻歌解析の進み具合">
          {progress}%
        </progress>
      ) : null}
      <p className="assistant__humming-status" role="status" aria-live="polite">
        {status}
      </p>
      {error ? <p role="alert" className="assistant__humming-error">{error}</p> : null}

      {detection ? (
        <div
          ref={resultRef}
          className="assistant__humming-result"
          role="region"
          aria-label="鼻歌の解析結果"
          tabIndex={-1}
        >
          <p>
            <strong>{detection.notes.length}音</strong>を検出 — {detection.fileName}（{Math.round(detection.durationSeconds)}秒）
          </p>
          <ol className="assistant__humming-notes" aria-label="検出した音符候補">
            {detection.notes.map((note, index) => (
              <li key={`${note.startSeconds}:${index}`}>
                <span>{index + 1}. {midiToNoteName(note.midi)}</span>
                <label>
                  <span className="visually-hidden">{index + 1}音目のMIDIノート</span>
                  <input
                    type="number"
                    min={0}
                    max={127}
                    step={1}
                    value={note.midi}
                    disabled={busy}
                    onChange={(event) => {
                      const midi = Math.max(0, Math.min(127, Math.round(Number(event.currentTarget.value))));
                      if (!Number.isFinite(midi)) return;
                      invalidateAppliedResult(`${index + 1}音目の高さを変更しました。内容を確認して反映してください。`);
                      setDetection((current) =>
                        current
                          ? {
                              ...current,
                              notes: current.notes.map((candidate, candidateIndex) =>
                                candidateIndex === index ? { ...candidate, midi } : candidate,
                              ),
                            }
                          : null,
                      );
                    }}
                  />
                </label>
                <button
                  ref={(node) => {
                    removeButtonRefs.current[index] = node;
                  }}
                  type="button"
                  disabled={busy}
                  aria-label={`${index + 1}音目を候補から外す`}
                  onClick={() => {
                    const remainingCount = detection.notes.length - 1;
                    invalidateAppliedResult(
                      remainingCount > 0
                        ? `${remainingCount}個の音符候補にしました。内容を確認して反映してください。`
                        : '音符候補が0個になりました。別の鼻歌を選ぶか、解析し直してください。',
                    );
                    setDetection((current) =>
                      current
                        ? {
                            ...current,
                            notes: current.notes.filter((_, candidateIndex) => candidateIndex !== index),
                          }
                        : null,
                    );
                    window.requestAnimationFrame(() => {
                      if (remainingCount > 0) {
                        const focusIndex = Math.min(index, remainingCount - 1);
                        removeButtonRefs.current[focusIndex]?.focus();
                      } else {
                        sourceButtonRef.current?.focus();
                      }
                    });
                  }}
                >
                  外す
                </button>
              </li>
            ))}
          </ol>
          {targetClips.length > 0 ? (
            <label>
              反映先
              <select
                value={targetClipId}
                disabled={busy}
                onChange={(event) => {
                  invalidateAppliedResult('反映先を変更しました。内容を確認して反映してください。');
                  setTargetClipId(event.currentTarget.value);
                }}
              >
                {targetClips.map((target) => (
                  <option key={target.clipId} value={target.clipId}>{target.label}</option>
                ))}
              </select>
            </label>
          ) : (
            <p role="alert" className="assistant__humming-error">
              反映先のMIDIクリップがありません。先にインストゥルメントトラックへMIDIクリップを作成してください。
            </p>
          )}
          <label>
            リズム補正
            <select
              value={quantize}
              disabled={busy}
              onChange={(event) => {
                invalidateAppliedResult('リズム補正を変更しました。内容を確認して反映してください。');
                setQuantize(event.currentTarget.value as HummingQuantize);
              }}
            >
              <option value="sixteenth">1/16音符</option>
              <option value="eighth">1/8音符</option>
              <option value="quarter">1/4音符</option>
              <option value="off">補正しない</option>
            </select>
          </label>
          <p className="assistant__hint">反映すると対象クリップの既存音符を置き換えます。元に戻す操作に対応しています。</p>
          <button
            type="button"
            className="assistant__generate"
            disabled={!targetClipId || busy || applied || detection.notes.length === 0}
            onClick={applyDetection}
          >
            {applied ? 'メロディクリップへ反映済み' : 'メロディクリップへ反映'}
          </button>
        </div>
      ) : null}
      {recordingOpen ? (
        <HummingRecordingDialog
          onClose={() => setRecordingOpen(false)}
          onCaptured={(capture) => void processCapture(capture)}
          onChooseFile={chooseFileFromRecording}
        />
      ) : null}
    </section>
  );
}
