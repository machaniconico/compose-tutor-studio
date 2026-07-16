// Offline render to 16-bit PCM WAV.
//
// `renderProjectToWav` builds the same schedule used for live playback into an
// OfflineAudioContext, renders it, and encodes the result. `encodeWav` is a pure
// function (no Web Audio) so the RIFF/WAVE header, chunk sizes and sample
// clamping are unit testable.

import {
  assertScheduleEventBudget,
  beatsPerBar as beatsPerBarForTimeSignature,
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
  type Project,
} from '@cts/project-model';
import { buildScheduleEvents, type SchedulePayload } from './events';
import { buildTrackGraphs, type TrackGraph } from './graph';
import { buildMasterBus } from './masterBus';
import { applyMasterMix } from './mixState';
import {
  beatToTime,
  projectLengthBeats,
  resolveDrumOccurrence,
  secondsPerBeat,
  type ScheduledEvent,
} from './scheduler';
import { createNoiseBuffer, DrumVoiceManager } from './drums';
import { SynthVoiceManager } from './synth';
import { planAudioTail } from './tail';

/** Render sample rate (Hz). */
export const RENDER_SAMPLE_RATE = 44100;
/** Render channel count. */
export const RENDER_CHANNELS = 2;
/** Browser-safe ceiling for an offline render before allocating audio buffers. */
export const MAX_WAV_RENDER_SECONDS = 5 * 60;
export const MAX_WAV_RENDER_ESTIMATED_BYTES = 192 * 1024 * 1024;
/** Offline rendering eagerly creates every source node for the whole song. */
export const MAX_WAV_SCHEDULE_EVENTS = 10_000;

export class WavRenderLimitError extends Error {
  readonly code = 'render-limit-exceeded' as const;

  constructor(
    readonly songSeconds: number,
    readonly estimatedBytes: number,
  ) {
    super(`WAV render exceeds the ${MAX_WAV_RENDER_SECONDS}-second browser limit`);
    this.name = 'WavRenderLimitError';
  }
}

export type WavRenderPlan = Readonly<{
  lengthBeats: number;
  songSeconds: number;
  uncappedTailSeconds: number;
  tailSeconds: number;
  totalSeconds: number;
  postLimiterTailSeconds: number;
  fadeStartSeconds: number | null;
  fadeEndSeconds: number | null;
  tailCapped: boolean;
  frames: number;
  estimatedBytes: number;
}>;

/** Compute and bound all large allocations before constructing OfflineAudioContext. */
export function planWavRender(
  project: Project,
  resolvedEvents: readonly ScheduledEvent[] = buildWavScheduleEvents(project),
): WavRenderPlan {
  const barBeats = beatsPerBarForTimeSignature(project.timeSignature);
  const lengthBeats = projectLengthBeats(project.lengthBars, barBeats);
  const songSeconds = lengthBeats * secondsPerBeat(project.bpm);
  const tail = planAudioTail(
    project,
    resolvedEvents,
    0,
    lengthBeats,
    RENDER_SAMPLE_RATE,
  );
  const totalSeconds = tail.totalSeconds;
  const frames = Math.max(1, Math.ceil(totalSeconds * RENDER_SAMPLE_RATE));
  // Offline float buffers plus the final interleaved 16-bit PCM payload.
  const estimatedBytes = frames * RENDER_CHANNELS * (Float32Array.BYTES_PER_ELEMENT + 2);
  if (
    !Number.isFinite(songSeconds) ||
    !Number.isFinite(totalSeconds) ||
    !Number.isSafeInteger(frames) ||
    songSeconds > MAX_WAV_RENDER_SECONDS ||
    estimatedBytes > MAX_WAV_RENDER_ESTIMATED_BYTES
  ) {
    throw new WavRenderLimitError(songSeconds, estimatedBytes);
  }
  return {
    lengthBeats,
    songSeconds,
    uncappedTailSeconds: tail.uncappedTailSeconds,
    tailSeconds: tail.tailSeconds,
    totalSeconds,
    postLimiterTailSeconds: tail.postLimiterTailSeconds,
    fadeStartSeconds: tail.fadeStartSeconds,
    fadeEndSeconds: tail.fadeEndSeconds,
    tailCapped: tail.capped,
    frames,
    estimatedBytes,
  };
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
  const encoder = prepareWavPcm16Encoder(source, sampleRate);
  encoder.writeFrames(0, encoder.numFrames);
  return encoder.buffer;
}

export type EncodeWavAsyncOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  /** Test seam and host-specific scheduling hook. */
  yieldControl?: () => Promise<void>;
  chunkFrames?: number;
}>;

/**
 * Encode the same PCM16 contract as `encodeWav`, yielding between bounded frame
 * ranges so multi-minute local transforms do not freeze the editor UI.
 */
export async function encodeWavAsync(
  source: AudioBuffer | Float32Array[],
  sampleRate?: number,
  options: EncodeWavAsyncOptions = {},
): Promise<ArrayBuffer> {
  const encoder = prepareWavPcm16Encoder(source, sampleRate);
  const chunkFrames =
    Number.isSafeInteger(options.chunkFrames) && (options.chunkFrames ?? 0) > 0
      ? (options.chunkFrames as number)
      : 524_288;
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  throwIfEncodingAborted(options.signal);
  options.onProgress?.(0);

  for (let start = 0; start < encoder.numFrames; start += chunkFrames) {
    throwIfEncodingAborted(options.signal);
    const end = Math.min(encoder.numFrames, start + chunkFrames);
    encoder.writeFrames(start, end);
    options.onProgress?.(encoder.numFrames === 0 ? 1 : end / encoder.numFrames);
    if (end < encoder.numFrames) await yieldControl();
  }
  throwIfEncodingAborted(options.signal);
  options.onProgress?.(1);
  return encoder.buffer;
}

type WavPcm16Encoder = Readonly<{
  buffer: ArrayBuffer;
  numFrames: number;
  writeFrames: (startFrame: number, endFrame: number) => void;
}>;

function prepareWavPcm16Encoder(
  source: AudioBuffer | Float32Array[],
  sampleRate?: number,
): WavPcm16Encoder {
  const channels: Float32Array[] = Array.isArray(source)
    ? source
    : collectChannels(source);
  const rate = sampleRate ?? (Array.isArray(source) ? RENDER_SAMPLE_RATE : source.sampleRate);
  const numChannels = channels.length;
  const numFrames = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = rate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  return {
    buffer,
    numFrames,
    writeFrames(startFrame, endFrame) {
      let offset = 44 + startFrame * blockAlign;
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        for (let channelIndex = 0; channelIndex < numChannels; channelIndex += 1) {
          const channel = channels[channelIndex];
          const sample = channel && frame < channel.length ? (channel[frame] ?? 0) : 0;
          view.setInt16(offset, floatToInt16(sample), true);
          offset += bytesPerSample;
        }
      }
    },
  };
}

function throwIfEncodingAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('WAV encoding was cancelled');
  error.name = 'AbortError';
  throw error;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
 * Build the exact event schedule used by offline WAV render.
 *
 * The shared project flattener embeds each drum clip's persisted groove. The
 * same pure occurrence resolver used by live scheduling resolves every event.
 */
export function buildWavScheduleEvents(project: Project): ScheduledEvent[] {
  assertScheduleEventBudget(project, {
    limit: MAX_WAV_SCHEDULE_EVENTS,
    projection: 'audible',
    density: {
      windowBeats: RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
      maxEventsPerWindow: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
    },
  });
  const events: ScheduledEvent[] = [];
  for (const event of buildScheduleEvents(project)) {
    const resolved = resolveDrumOccurrence(event, event.beat);
    if (resolved) events.push(resolved);
  }
  // Offline voices are allocated for the whole song in one pass. Their
  // reap/steal logic assumes nondecreasing start times, so normalize the
  // otherwise-unsorted project traversal here. Array#sort is stable, retaining
  // deterministic source order for events that share an onset.
  events.sort((left, right) => left.beat - right.beat);
  return events;
}

/**
 * Render a project to a WAV Blob via an OfflineAudioContext.
 *
 * Builds the per-track graph + voices, schedules every note/drum event at its
 * resolved offline time, renders, and encodes. Loop and metronome are not part
 * of an exported render (the song plays once, no click).
 */
export async function renderProjectToWav(project: Project): Promise<Blob> {
  const events = buildWavScheduleEvents(project);
  const plan = planWavRender(project, events);

  const ctx = new OfflineAudioContext(RENDER_CHANNELS, plan.frames, RENDER_SAMPLE_RATE);

  // Master bus topology and gain policy are shared with live playback.
  const { master, limiter } = buildMasterBus(ctx, ctx.destination);
  let graphs = new Map<string, TrackGraph>();
  const synths = new Map<string, SynthVoiceManager>();
  const drums = new Map<string, DrumVoiceManager>();
  let renderOutput: GainNode | null = null;
  try {
    applyMasterMix(master, project.tracks, 0, 'immediate');

    let graphDestination: AudioNode = master;
    if (plan.fadeStartSeconds !== null) {
      // This render-owned post-effect bus makes the final fade sample-accurate
      // without changing the persisted Master fader or the live engine graph.
      renderOutput = ctx.createGain();
      renderOutput.gain.value = 1;
      renderOutput.connect(master);
      scheduleWavFinalFade(renderOutput.gain, plan);
      graphDestination = renderOutput;
    }

    // Offline exports deliberately omit UI meters. Registering their analysers
    // would replace the live meter registry and retain the offline context.
    graphs = buildTrackGraphs(ctx, graphDestination, project.tracks, 0, 'disabled');
    let sharedDrumNoise: AudioBuffer | undefined;
    for (const track of project.tracks) {
      const graph = graphs.get(track.id);
      if (!graph) continue;
      if (track.type === 'drum') {
        sharedDrumNoise ??= createNoiseBuffer(ctx);
        drums.set(
          track.id,
          new DrumVoiceManager(ctx, graph.input, sharedDrumNoise),
        );
      } else {
        synths.set(track.id, new SynthVoiceManager(ctx, graph.input, track.instrument?.preset));
      }
    }

    // Schedule everything. anchorBeat=0, anchorTime=0 => beat n maps to n*spb.
    const spb = secondsPerBeat(project.bpm);
    for (const ev of events) {
      const time = beatToTime(ev.beat, project.bpm, 0, 0);
      const payload = ev.payload as SchedulePayload;
      if (payload.kind === 'note') {
        const synth = synths.get(payload.trackId);
        if (synth) {
          synth.noteOn(payload.pitch, time, payload.durationBeats * spb, payload.velocity);
        }
      } else {
        const drum = drums.get(payload.trackId);
        if (drum) {
          drum.trigger(payload.lane, time, payload.velocity, payload.voiceSeed);
        }
      }
    }

    const rendered = await ctx.startRendering();
    const wav = encodeWav(rendered);
    return new Blob([wav], { type: 'audio/wav' });
  } finally {
    for (const synth of synths.values()) synth.dispose();
    for (const drum of drums.values()) drum.dispose();
    for (const graph of graphs.values()) graph.dispose();
    try {
      renderOutput?.disconnect();
    } catch {
      // The output bus may have failed before it connected to the master.
    }
    try {
      master.disconnect();
    } catch {
      // The offline graph may already have been torn down after a render error.
    }
    try {
      limiter.disconnect();
    } catch {
      // The offline graph may already have been torn down after a render error.
    }
  }
}

export function scheduleWavFinalFade(param: AudioParam, plan: WavRenderPlan): void {
  if (plan.fadeStartSeconds === null || plan.fadeEndSeconds === null) return;
  param.setValueAtTime(1, plan.fadeStartSeconds);
  param.linearRampToValueAtTime(0, plan.fadeEndSeconds);
}
