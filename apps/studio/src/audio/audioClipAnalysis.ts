import type { AudioClip, AudioPitchRegion, ReadyAudioAsset } from '@cts/project-model';
import { parseCanonicalPcm16 } from './canonicalPcm16';
import {
  AudioResourceReservationError,
  checkedHeavyAudioResourceTotal,
  reserveHeavyAudioResources,
} from './audioResourceReservation';
import {
  transcribeHummingToMelodyResult,
  type HummingPitchFrame,
  type HummingTranscriptionOptions,
  type HummingWaveformBin,
} from './hummingTranscription';

export const MAX_AUDIO_CLIP_ANALYSIS_SECONDS = 60;
export const MAX_AUDIO_CLIP_PITCH_REGIONS = 128;
export const MIN_AUDIO_CLIP_PITCH_REGION_FRAMES = 1_920;

export type AudioClipPitchCandidate = AudioPitchRegion & Readonly<{
  confidence: number;
}>;

export type AudioClipAnalysisResult = Readonly<{
  durationSeconds: number;
  waveform: readonly HummingWaveformBin[];
  pitchFrames: readonly HummingPitchFrame[];
  regions: readonly AudioClipPitchCandidate[];
}>;

export type AudioClipAnalysisErrorCode =
  | 'invalid-clip'
  | 'duration-limit'
  | 'resource-limit'
  | 'no-monophonic-pitch'
  | 'cancelled'
  | 'analysis-failed';

export class AudioClipAnalysisError extends Error {
  constructor(readonly code: AudioClipAnalysisErrorCode, message = code) {
    super(message);
    this.name = 'AudioClipAnalysisError';
  }
}

function clipChannels(
  bytes: Uint8Array,
  asset: ReadyAudioAsset,
  clip: AudioClip,
): readonly Float32Array[] {
  const pcm = parseCanonicalPcm16(bytes, {
    sampleRate: asset.sampleRate,
    channelCount: asset.channelCount,
    frameCount: asset.frameCount,
  });
  const end = clip.sourceStartFrame + clip.sourceFrameCount;
  if (
    clip.audioAssetId !== asset.id
    || !Number.isSafeInteger(clip.sourceStartFrame)
    || !Number.isSafeInteger(clip.sourceFrameCount)
    || clip.sourceStartFrame < 0
    || clip.sourceFrameCount < MIN_AUDIO_CLIP_PITCH_REGION_FRAMES
    || end > pcm.frameCount
  ) {
    throw new AudioClipAnalysisError('invalid-clip');
  }
  if (clip.sourceFrameCount / pcm.sampleRate > MAX_AUDIO_CLIP_ANALYSIS_SECONDS) {
    throw new AudioClipAnalysisError('duration-limit');
  }
  return pcm.channels.map((channel) => channel.slice(clip.sourceStartFrame, end));
}

function weightedPitch(
  frames: readonly HummingPitchFrame[],
  startSeconds: number,
  endSeconds: number,
): Readonly<{ cents: number; confidence: number }> | null {
  let pitch = 0;
  let confidence = 0;
  let weight = 0;
  for (const frame of frames) {
    if (
      frame.midi === null
      || frame.endSeconds <= startSeconds
      || frame.startSeconds >= endSeconds
    ) continue;
    const overlap = Math.min(endSeconds, frame.endSeconds)
      - Math.max(startSeconds, frame.startSeconds);
    const frameWeight = overlap * Math.max(0.001, frame.confidence);
    pitch += frame.midi * 100 * frameWeight;
    confidence += frame.confidence * overlap;
    weight += frameWeight;
  }
  if (weight <= 0) return null;
  return {
    cents: Math.round(pitch / weight),
    confidence: Math.max(0, Math.min(1, confidence / (endSeconds - startSeconds))),
  };
}

/**
 * Analyze one verified, immutable canonical asset window locally.
 * The bounded projections and candidates are runtime-only until a caller commits an edit.
 */
export async function analyzeAudioClipPitch(
  bytes: Uint8Array,
  asset: ReadyAudioAsset,
  clip: AudioClip,
  options: HummingTranscriptionOptions = {},
): Promise<AudioClipAnalysisResult> {
  let reservation: ReturnType<typeof reserveHeavyAudioResources> | null = null;
  try {
    if (
      clip.sourceFrameCount / asset.sampleRate > MAX_AUDIO_CLIP_ANALYSIS_SECONDS
      || clip.sourceFrameCount < MIN_AUDIO_CLIP_PITCH_REGION_FRAMES
    ) {
      throw new AudioClipAnalysisError(
        clip.sourceFrameCount < MIN_AUDIO_CLIP_PITCH_REGION_FRAMES
          ? 'invalid-clip'
          : 'duration-limit',
      );
    }
    const assetFloatBytes = asset.frameCount
      * asset.channelCount
      * Float32Array.BYTES_PER_ELEMENT;
    const clipFloatBytes = clip.sourceFrameCount
      * asset.channelCount
      * Float32Array.BYTES_PER_ELEMENT;
    const analysisFloatBytes = Math.ceil(
      clip.sourceFrameCount * 8_000 / asset.sampleRate,
    ) * Float64Array.BYTES_PER_ELEMENT;
    reservation = reserveHeavyAudioResources(checkedHeavyAudioResourceTotal([
      asset.byteLength,
      assetFloatBytes,
      clipFloatBytes,
      analysisFloatBytes,
    ]));
    const channels = clipChannels(bytes, asset, clip);
    const result = await transcribeHummingToMelodyResult({
      numberOfChannels: channels.length,
      length: clip.sourceFrameCount,
      sampleRate: asset.sampleRate,
      getChannelData: (channel) => {
        const samples = channels[channel];
        if (!samples) throw new AudioClipAnalysisError('invalid-clip');
        return samples;
      },
    }, options);
    const regions: AudioClipPitchCandidate[] = [];
    for (const note of result.notes) {
      if (regions.length >= MAX_AUDIO_CLIP_PITCH_REGIONS) break;
      const localStart = Math.max(0, Math.round(note.startSeconds * asset.sampleRate));
      const localEnd = Math.min(
        clip.sourceFrameCount,
        Math.round((note.startSeconds + note.durationSeconds) * asset.sampleRate),
      );
      if (localEnd - localStart < MIN_AUDIO_CLIP_PITCH_REGION_FRAMES) continue;
      const measured = weightedPitch(
        result.pitchFrames,
        localStart / asset.sampleRate,
        localEnd / asset.sampleRate,
      );
      if (!measured) continue;
      regions.push({
        sourceStartFrame: clip.sourceStartFrame + localStart,
        sourceFrameCount: localEnd - localStart,
        sourcePitchCents: measured.cents,
        targetPitchCents: measured.cents,
        correctionAmount: 0,
        transitionFrames: 0,
        confidence: Math.min(note.confidence, measured.confidence),
      });
    }
    if (regions.length === 0) {
      throw new AudioClipAnalysisError('no-monophonic-pitch');
    }
    return Object.freeze({
      durationSeconds: result.durationSeconds,
      waveform: result.waveform,
      pitchFrames: result.pitchFrames,
      regions: Object.freeze(regions),
    });
  } catch (error) {
    if (error instanceof AudioClipAnalysisError) throw error;
    if (error instanceof AudioResourceReservationError) {
      throw new AudioClipAnalysisError('resource-limit');
    }
    if (options.signal?.aborted) throw new AudioClipAnalysisError('cancelled');
    throw new AudioClipAnalysisError('analysis-failed');
  } finally {
    reservation?.release();
  }
}

export function audioClipAnalysisErrorMessage(code: AudioClipAnalysisErrorCode): string {
  switch (code) {
    case 'duration-limit':
      return '音程を解析できるのは60秒以内のクリップです。短くトリムしてください。';
    case 'no-monophonic-pitch':
      return '一音ずつの安定した音程を見つけられませんでした。歌声や単音の素材でお試しください。';
    case 'resource-limit':
      return '音程解析に使える端末メモリの上限を超えています。ほかの音声処理を終えるか、短い素材でお試しください。';
    case 'cancelled':
      return '音程解析をキャンセルしました。編集内容は変更していません。';
    case 'invalid-clip':
      return 'このクリップの音声範囲を安全に解析できません。素材を確認してください。';
    case 'analysis-failed':
      return '音程を解析できませんでした。音声素材を確認してもう一度お試しください。';
  }
}
