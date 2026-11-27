// Offline render to 16- or 24-bit PCM WAV.
//
// `renderProjectToWav` builds the same schedule used for live playback into an
// OfflineAudioContext, renders it, and encodes the result. `encodeWav` is a pure
// function (no Web Audio) so the RIFF/WAVE header, chunk sizes and sample
// clamping are unit testable.

import type { Project } from '@cts/project-model';
import { beatTick, hasAutomation, PPQ, resolveMuteSolo, sendLevel, songEndBeat } from '@cts/project-model';
import { delaySettings, enabledSupportedEffects, reverbSettings, REVERB_IMPULSE_SECONDS } from './effects';
import { noteEnvelopeTiming } from './envelope';
import { buildScheduleEvents, type SchedulePayload } from './events';
import { buildTrackGraphs } from './graph';
import { createMasterChain } from './masterChain';
import { beatToTime, secondsPerBeat, type DueEvent, type LoopRegion } from './scheduler';
import { DrumVoiceManager } from './drums';
import { applyMacros } from './macros';
import { resolvePreset, type Envelope } from './presets';
import { finishSampleSteps, runSampleSteps, type SampleStepOptions } from './sampleSteps';
import { SynthVoiceManager } from './synth';

/** Render sample rate (Hz). */
export const RENDER_SAMPLE_RATE = 44100;
export type WavSampleRate = 44100 | 48000;
export type WavExportRange = 'full' | 'loop';
export type WavBitDepth = 16 | 24;
export type WavEncodingOptions = { bitDepth?: WavBitDepth; dither?: boolean; normalize?: boolean };
export type WavExportOptions = WavEncodingOptions & { sampleRate?: WavSampleRate; range?: WavExportRange };
/** Render channel count. */
export const RENDER_CHANNELS = 2;
/** Minimum time reserved for release after the render window, in seconds. */
export const RENDER_TAIL_SECONDS = 1;

export { songEndBeat as songSoundEndBeat };

type RenderEvent = DueEvent & { payload: SchedulePayload };

export function wavLoopWindow(project: Project): { window: LoopRegion } | { reason: string } {
  const loop = project.loopRange;
  if (!loop) {
    return { reason: 'ループ範囲がありません。曲全体の画面でループ範囲を設定してください。' };
  }
  const startTick = Math.max(0, beatTick(loop.startBeat));
  const endTick = Math.min(beatTick(songEndBeat(project)), beatTick(loop.endBeat));
  if (!Number.isFinite(loop.startBeat) || !Number.isFinite(loop.endBeat) || endTick <= startTick) {
    return { reason: '書き出せるループ範囲がありません。曲の中で終わりを始まりより後ろに設定してください。' };
  }
  return { window: { startBeat: startTick / PPQ, endBeat: endTick / PPQ } };
}

function assertSampleRate(rate: number): asserts rate is WavSampleRate {
  if (rate !== 44100 && rate !== 48000) {
    throw new RangeError('WAVのサンプルレートは44.1 kHzか48 kHzを選んでください。');
  }
}

/**
 * Seconds kept after the song end. Keep the existing release and delay
 * allowance, extending it when a scheduled envelope rings out longer.
 * Live playback supplies the overhang of its already-scheduled voices.
 */
export function songTailSeconds(
  project: Project,
  source?: { events: readonly RenderEvent[]; endTime?: number } | { liveReleaseOverhang: number },
): number {
  const envelopes = new Map<string, Envelope>();
  let longestDelay = 0;
  let tail = RENDER_TAIL_SECONDS;
  let returnTail = 0;
  const audible = resolveMuteSolo(project.tracks);
  for (const track of project.tracks) {
    if (track.type !== 'drum') {
      const { env } = applyMacros(resolvePreset(track.instrument?.preset), track.instrument?.macros);
      envelopes.set(track.id, env);
      tail = Math.max(tail, env.release);
    }
    const effects = enabledSupportedEffects(track.effects);
    // Keep the original WAV duration for projects that send no signal.
    for (const effect of effects) {
      if (effect.type !== 'delay') continue;
      longestDelay = Math.max(longestDelay, delaySettings(effect).timeSeconds);
    }
    if (track.type !== 'bus' || !audible.has(track.id)) continue;
    if (!project.tracks.some((source) => audible.has(source.id) && sendLevel(source, track.id) > 0)) continue;
    let effectTail = 0;
    for (const effect of effects) {
      if (effect.type === 'reverb' && reverbSettings(effect).mix > 0) {
        effectTail += REVERB_IMPULSE_SECONDS;
      }
      if (effect.type === 'delay') {
        const { mix, timeSeconds, feedback } = delaySettings(effect);
        // The first repeat always plays. Keep feedback repeats through -60 dB.
        const repeats = feedback > 0 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1;
        if (mix > 0) effectTail += timeSeconds * repeats;
      }
    }
    returnTail = Math.max(returnTail, effectTail);
  }
  const effectTail = Math.max(longestDelay, returnTail);
  if (source && 'liveReleaseOverhang' in source) {
    return effectTail + Math.max(tail, source.liveReleaseOverhang);
  }

  const spb = secondsPerBeat(project.bpm);
  const endTime = source?.endTime ?? songEndBeat(project) * spb;
  for (const { payload, time } of source?.events ?? renderScheduleEvents(project)) {
    if (payload.kind !== 'note') continue;
    const env = envelopes.get(payload.trackId);
    if (!env) continue;
    const { releaseEnd } = noteEnvelopeTiming(env, time, payload.durationBeats * spb, payload.cut);
    tail = Math.max(tail, releaseEnd - endTime);
  }
  return effectTail + tail;
}

/** Render through the song end plus the release and echo tail. */
export function renderLengthSeconds(project: Project, events: readonly RenderEvent[] = renderScheduleEvents(project)): number {
  return songEndBeat(project) * secondsPerBeat(project.bpm) + songTailSeconds(project, { events });
}

/** Resolve the shared schedule to absolute times for the offline context. */
export function renderScheduleEvents(project: Project, window?: LoopRegion): RenderEvent[] {
  return buildScheduleEvents(project, undefined, undefined, window)
    .map(({ beat, payload }) => ({
      beat,
      payload: payload as SchedulePayload,
      time: beatToTime(beat, project.bpm, window?.startBeat ?? 0, 0),
    }))
    .sort((a, b) => a.time - b.time);
}

/** Clamp a float sample to [-1, 1] and convert to a signed 16-bit int. */
export function floatToInt16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  // Asymmetric range: negative scales by 0x8000, positive by 0x7FFF.
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

const PCM_HEADROOM = 10 ** (-1 / 20);
const NORMALIZE_CHUNK_FRAMES = 16_384;

/** Apply one gain across all channels to preserve their relative levels. */
export function normalizePeak(channels: Float32Array[]): Float32Array[] {
  return finishSampleSteps(normalizePeakSteps(channels));
}

export function normalizePeakInChunks(channels: Float32Array[], options: SampleStepOptions): Promise<Float32Array[]> {
  return runSampleSteps(normalizePeakSteps(channels), options);
}

function* normalizePeakSteps(channels: Float32Array[]): Generator<number, Float32Array[], void> {
  const totalSamples = 2 * channels.reduce((sum, channel) => sum + channel.length, 0);
  let processedSamples = 0;
  let peak = 0;
  for (const channel of channels) {
    for (let start = 0; start < channel.length; start += NORMALIZE_CHUNK_FRAMES) {
      const end = Math.min(start + NORMALIZE_CHUNK_FRAMES, channel.length);
      for (let frame = start; frame < end; frame += 1) peak = Math.max(peak, Math.abs(channel[frame]!));
      processedSamples += end - start;
      yield processedSamples / totalSamples;
    }
  }
  if (peak === 0 || !Number.isFinite(peak)) return channels;
  const gain = PCM_HEADROOM / peak;
  const normalized: Float32Array[] = [];
  for (const channel of channels) {
    const output = new Float32Array(channel.length);
    for (let start = 0; start < channel.length; start += NORMALIZE_CHUNK_FRAMES) {
      const end = Math.min(start + NORMALIZE_CHUNK_FRAMES, channel.length);
      for (let frame = start; frame < end; frame += 1) output[frame] = channel[frame]! * gain;
      processedSamples += end - start;
      yield processedSamples / totalSamples;
    }
    normalized.push(output);
  }
  return normalized;
}

function wavByteLength(dataSize: number): number {
  return 44 + dataSize + dataSize % 2;
}

export class WavSizeLimitError extends RangeError {
  constructor() {
    super('WAV ファイルのサイズが上限（約 4 GB）を超えます。書き出す範囲を短くするか、サンプルレートやビット数を下げてください。');
  }
}

function assertRiffSize(byteLength: number): void {
  // The outer RIFF chunk also has a 32-bit size field, including header and padding.
  if (byteLength - 8 >= 2 ** 32) throw new WavSizeLimitError();
}

function tpdfDither(): () => number {
  let seed = 0x43545335;
  const uniform = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  // The difference of two uniform values gives triangular noise of ±1 LSB.
  return () => uniform() - uniform();
}

/**
 * Encode planar channel data to PCM WAV.
 *
 * Accepts either an AudioBuffer or an array of per-channel Float32Arrays. Pure:
 * no Web Audio dependency beyond reading the buffer, no I/O. Returns an
 * ArrayBuffer containing a complete RIFF/WAVE file.
 */
export function encodeWav(
  source: AudioBuffer | Float32Array[],
  sampleRate?: number,
  options: WavEncodingOptions = {},
): ArrayBuffer {
  const rate = sampleRate === undefined
    ? (Array.isArray(source) ? RENDER_SAMPLE_RATE : source.sampleRate)
    : sampleRate;
  assertSampleRate(rate);
  const { bitDepth = 16, dither = false, normalize = false } = options;
  const input = Array.isArray(source) ? source : collectChannels(source);
  const numChannels = input.length;
  const numFrames = input.reduce((max, ch) => Math.max(max, ch.length), 0);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = rate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const byteLength = wavByteLength(dataSize);
  assertRiffSize(byteLength);
  const channels = normalize ? normalizePeak(input) : input;
  const nextNoise = bitDepth === 16 && dither ? tpdfDither() : undefined;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  // RIFF header.
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true); // chunk size = file size - 8
  writeAscii(view, 8, 'WAVE');

  // fmt subchunk.
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true); // bits per sample

  // data subchunk.
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels, sample by sample.
  let offset = 44;
  for (let frame = 0; frame < numFrames; frame += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const channel = channels[ch];
      const sample = channel && frame < channel.length ? (channel[frame] ?? 0) : 0;
      if (bitDepth === 24) {
        const clamped = Math.max(-1, Math.min(1, sample));
        const pcm = Math.round(clamped * (clamped < 0 ? 0x800000 : 0x7fffff));
        view.setUint16(offset, pcm, true);
        view.setUint8(offset + 2, pcm >> 16);
      } else if (nextNoise) {
        const clamped = Math.max(-1, Math.min(1, sample));
        const pcm = Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff) + nextNoise());
        view.setInt16(offset, Math.max(-0x8000, Math.min(0x7fff, pcm)), true);
      } else {
        view.setInt16(offset, floatToInt16(sample), true);
      }
      offset += bytesPerSample;
    }
  }

  return buffer;
}

/** Read all channels of an AudioBuffer into Float32Arrays. */
export function collectChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    channels.push(buffer.getChannelData(ch));
  }
  return channels;
}

/** Write a short ASCII string into a DataView at the given byte offset. */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export type WavRenderPlan = {
  project: Project;
  sampleRate: WavSampleRate;
  window?: LoopRegion;
  events: readonly RenderEvent[];
  frames: number;
  outputTrackId?: string;
};

function exportWindow(project: Project, options: WavExportOptions): LoopRegion | undefined {
  const loop = options.range === 'loop' ? wavLoopWindow(project) : undefined;
  if (loop && 'reason' in loop) throw new RangeError(loop.reason);
  return loop?.window;
}

export function planWavRender(project: Project, options: WavExportOptions = {}): WavRenderPlan {
  const { sampleRate = RENDER_SAMPLE_RATE } = options;
  assertSampleRate(sampleRate);
  const window = exportWindow(project, options);
  const events = renderScheduleEvents(project, window);
  return { project, sampleRate, window, events, frames: renderFrameCount(project, events, sampleRate, window) };
}

/** Keep the selected output and any source tracks that feed its return. */
export function planStemRender(mix: WavRenderPlan, trackId: string): WavRenderPlan {
  const { project, sampleRate, window } = mix;
  const target = project.tracks.find((track) => track.id === trackId);
  const audible = resolveMuteSolo(project.tracks);
  if (!target || !audible.has(trackId)) throw new RangeError('書き出せるトラックを選んでください。');
  const tracks = project.tracks
    .filter((track) => track.type === 'master' || track.id === trackId ||
      (target.type === 'bus' && audible.has(track.id) && sendLevel(track, trackId) > 0))
    .map((track) => ({ ...track, solo: false }));
  const stem = { ...project, tracks };
  const sources = new Set(tracks.map((track) => track.id));
  // The mix schedule has already resolved linked clips and cut notes at the range end.
  const events = mix.events.filter(({ payload }) => sources.has(payload.trackId));
  return {
    project: stem, sampleRate, window, events, outputTrackId: trackId,
    frames: renderFrameCount(stem, events, sampleRate, window),
  };
}

export function wavRenderByteLength(frames: number, bitDepth: WavBitDepth = 16): number {
  return wavByteLength(frames * RENDER_CHANNELS * (bitDepth / 8));
}

export function assertWavRenderFits(frames: number, bitDepth?: WavBitDepth): void {
  assertRiffSize(wavRenderByteLength(frames, bitDepth));
}

/** The selected range plus the minimum tail, before adding any track's effects. */
export function minimumStemFrames({ project, sampleRate, window }: WavRenderPlan): number {
  return renderFrameCount({ ...project, tracks: [] }, [], sampleRate, window);
}

export async function renderProjectToWav(project: Project, options: WavExportOptions = {}): Promise<Blob> {
  const plan = planWavRender(project, options);
  assertWavRenderFits(plan.frames, options.bitDepth);
  const rendered = await renderWavAudio(plan);
  return new Blob([encodeWav(rendered, plan.sampleRate, options)], { type: 'audio/wav' });
}

/** Render the shared graph and schedule. Loop exports play one pass without a click. */
export async function renderWavAudio(plan: WavRenderPlan): Promise<AudioBuffer> {
  const { project, sampleRate, window, events, frames, outputTrackId } = plan;
  const ctx = new OfflineAudioContext(RENDER_CHANNELS, frames, sampleRate);

  // Master bus + soft limiter (shared with AudioEngine).
  const master = createMasterChain(ctx, project.tracks).input;

  // Per-track graphs + voice managers.
  const graphs = buildTrackGraphs(ctx, master, project.tracks, 0, outputTrackId);
  const automation = {
    bpm: project.bpm, startBeat: window?.startBeat ?? 0, loop: null, startTime: 0,
    endBeat: window?.endBeat ?? songEndBeat(project),
  };
  const synths = new Map<string, SynthVoiceManager>();
  const drums = new Map<string, DrumVoiceManager>();
  for (const track of project.tracks) {
    const graph = graphs.get(track.id);
    if (!graph) continue;
    if (hasAutomation(track)) graph.scheduleAutomation(automation);
    if (track.type === 'bus') continue;
    if (track.type === 'drum') {
      drums.set(track.id, new DrumVoiceManager(ctx, graph.input));
    } else {
      // The voice manager applies the track's macros, as in live playback.
      synths.set(
        track.id,
        new SynthVoiceManager(
          ctx, graph.input, track.instrument?.preset, undefined, track.instrument?.macros, graph.cutoffSource,
        ),
      );
    }
  }

  // Schedule events at their resolved times relative to the export start.
  const spb = secondsPerBeat(project.bpm);
  for (const { time, payload } of events) {
    if (payload.kind === 'note') {
      const synth = synths.get(payload.trackId);
      if (synth) {
        synth.noteOn(payload.pitch, time, payload.durationBeats * spb, payload.velocity, {
          cutAtEnd: payload.cut,
        });
      }
    } else {
      const drum = drums.get(payload.trackId);
      if (drum) {
        if (payload.durationBeats === undefined) drum.trigger(payload.lane, time, payload.velocity);
        else drum.trigger(payload.lane, time, payload.velocity, payload.durationBeats * spb);
      }
    }
  }

  return ctx.startRendering();
}

function renderFrameCount(
  project: Project,
  events: readonly RenderEvent[],
  sampleRate: WavSampleRate,
  window?: LoopRegion,
): number {
  if (!window && sampleRate === RENDER_SAMPLE_RATE) {
    // Retain the original frame count for existing 44.1 kHz full-song exports.
    return Math.max(1, Math.ceil(renderLengthSeconds(project, events) * sampleRate));
  }
  const beats = window
    ? (beatTick(window.endBeat) - beatTick(window.startBeat)) / PPQ
    : songEndBeat(project);
  const bpm = project.bpm > 0 ? project.bpm : 120;
  const bodyFrames = Math.round(beats * 60 / bpm * sampleRate);
  // Measure envelope overhang from the rounded frame so a sub-frame rounding
  // difference in the body can't truncate the last release or echo.
  const tail = songTailSeconds(project, { events, endTime: bodyFrames / sampleRate });
  return bodyFrames + Math.ceil(tail * sampleRate);
}
