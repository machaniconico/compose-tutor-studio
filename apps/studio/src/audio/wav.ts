// Offline render to 16-bit PCM WAV.
//
// `renderProjectToWav` builds the same schedule used for live playback into an
// OfflineAudioContext, renders it, and encodes the result. `encodeWav` is a pure
// function (no Web Audio) so the RIFF/WAVE header, chunk sizes and sample
// clamping are unit testable.

import type { Project } from '@cts/project-model';
import { beatTick, PPQ, songEndBeat } from '@cts/project-model';
import { delaySettings, enabledSupportedEffects } from './effects';
import { noteEnvelopeTiming } from './envelope';
import { buildScheduleEvents, type SchedulePayload } from './events';
import { buildTrackGraphs } from './graph';
import { createMasterChain } from './masterChain';
import { beatToTime, secondsPerBeat, type DueEvent, type LoopRegion } from './scheduler';
import { DrumVoiceManager } from './drums';
import { applyMacros } from './macros';
import { resolvePreset, type Envelope } from './presets';
import { SynthVoiceManager } from './synth';

/** Render sample rate (Hz). */
export const RENDER_SAMPLE_RATE = 44100;
export type WavSampleRate = 44100 | 48000;
export type WavExportRange = 'full' | 'loop';
export type WavExportOptions = { sampleRate?: WavSampleRate; range?: WavExportRange };
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
  for (const track of project.tracks) {
    if (track.type !== 'drum') {
      const { env } = applyMacros(resolvePreset(track.instrument?.preset), track.instrument?.macros);
      envelopes.set(track.id, env);
      tail = Math.max(tail, env.release);
    }
    for (const effect of enabledSupportedEffects(track.effects)) {
      if (effect.type !== 'delay') continue;
      longestDelay = Math.max(longestDelay, delaySettings(effect).timeSeconds);
    }
  }
  if (source && 'liveReleaseOverhang' in source) {
    return longestDelay + Math.max(tail, source.liveReleaseOverhang);
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
  return longestDelay + tail;
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

/**
 * Encode interleaved/planar channel data to a 16-bit PCM WAV.
 *
 * Accepts either an AudioBuffer or an array of per-channel Float32Arrays. Pure:
 * no Web Audio dependency beyond reading the buffer, no I/O. Returns an
 * ArrayBuffer containing a complete RIFF/WAVE file.
 */
export function encodeWav(
  source: AudioBuffer | Float32Array[],
  sampleRate?: number,
): ArrayBuffer {
  const rate = sampleRate === undefined
    ? (Array.isArray(source) ? RENDER_SAMPLE_RATE : source.sampleRate)
    : sampleRate;
  assertSampleRate(rate);
  const channels: Float32Array[] = Array.isArray(source)
    ? source
    : collectChannels(source);

  const numChannels = channels.length;
  const numFrames = channels.reduce((max, ch) => Math.max(max, ch.length), 0);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = rate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header.
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // chunk size = file size - 8
  writeAscii(view, 8, 'WAVE');

  // fmt subchunk.
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample

  // data subchunk.
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels, sample by sample.
  let offset = 44;
  for (let frame = 0; frame < numFrames; frame += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const channel = channels[ch];
      const sample = channel && frame < channel.length ? (channel[frame] ?? 0) : 0;
      view.setInt16(offset, floatToInt16(sample), true);
      offset += 2;
    }
  }

  return buffer;
}

/** Read all channels of an AudioBuffer into Float32Arrays. */
function collectChannels(buffer: AudioBuffer): Float32Array[] {
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

/**
 * Render a project to a WAV Blob via an OfflineAudioContext.
 *
 * Builds the per-track graph + voices, schedules every note/drum event at its
 * resolved offline time, renders, and encodes. A selected loop plays one pass
 * without a metronome click.
 */
export async function renderProjectToWav(project: Project, options: WavExportOptions = {}): Promise<Blob> {
  const { sampleRate = RENDER_SAMPLE_RATE } = options;
  assertSampleRate(sampleRate);
  const loop = options.range === 'loop' ? wavLoopWindow(project) : undefined;
  if (loop && 'reason' in loop) throw new RangeError(loop.reason);
  const window = loop?.window;
  const events = renderScheduleEvents(project, window);
  const frames = renderFrameCount(project, events, sampleRate, window);

  const ctx = new OfflineAudioContext(RENDER_CHANNELS, frames, sampleRate);

  // Master bus + soft limiter (shared with AudioEngine).
  const master = createMasterChain(ctx, project.tracks).input;

  // Per-track graphs + voice managers.
  const graphs = buildTrackGraphs(ctx, master, project.tracks, 0);
  const automation = {
    bpm: project.bpm, startBeat: window?.startBeat ?? 0, loop: null, startTime: 0,
    endBeat: window?.endBeat ?? songEndBeat(project),
  };
  const synths = new Map<string, SynthVoiceManager>();
  const drums = new Map<string, DrumVoiceManager>();
  for (const track of project.tracks) {
    const graph = graphs.get(track.id);
    if (!graph) continue;
    if (track.automation?.volume?.points.length) graph.scheduleAutomation(automation);
    if (track.type === 'drum') {
      drums.set(track.id, new DrumVoiceManager(ctx, graph.input));
    } else {
      // The voice manager applies the track's macros, as in live playback.
      synths.set(
        track.id,
        new SynthVoiceManager(ctx, graph.input, track.instrument?.preset, undefined, track.instrument?.macros),
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

  const rendered = await ctx.startRendering();
  const wav = encodeWav(rendered, sampleRate);
  return new Blob([wav], { type: 'audio/wav' });
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
