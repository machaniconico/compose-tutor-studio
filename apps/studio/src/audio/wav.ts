// Offline render to 16-bit PCM WAV.
//
// `renderProjectToWav` builds the same schedule used for live playback into an
// OfflineAudioContext, renders it, and encodes the result. `encodeWav` is a pure
// function (no Web Audio) so the RIFF/WAVE header, chunk sizes and sample
// clamping are unit testable.

import type { Project } from '@cts/project-model';
import { songEndBeat } from '@cts/project-model';
import { delaySettings, enabledSupportedEffects } from './effects';
import { noteEnvelopeTiming } from './envelope';
import { buildScheduleEvents, type SchedulePayload } from './events';
import { buildTrackGraphs } from './graph';
import { createMasterChain } from './masterChain';
import { beatToTime, secondsPerBeat, type DueEvent } from './scheduler';
import { DrumVoiceManager } from './drums';
import { applyMacros } from './macros';
import { resolvePreset, type Envelope } from './presets';
import { SynthVoiceManager } from './synth';

/** Render sample rate (Hz). */
export const RENDER_SAMPLE_RATE = 44100;
/** Render channel count. */
export const RENDER_CHANNELS = 2;
/** Silence tail appended after the last event, seconds. */
export const RENDER_TAIL_SECONDS = 1;

export { songEndBeat as songSoundEndBeat };

type RenderEvent = DueEvent & { payload: SchedulePayload };

/**
 * Seconds kept after the song end. Keep the existing release and delay
 * allowance, extending it when a scheduled envelope rings out longer.
 * Live playback supplies the overhang of its already-scheduled voices.
 */
export function songTailSeconds(
  project: Project,
  source?: { events: readonly RenderEvent[] } | { liveReleaseOverhang: number },
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
  const songEnd = songEndBeat(project) * spb;
  for (const { payload, time } of source?.events ?? renderScheduleEvents(project)) {
    if (payload.kind !== 'note') continue;
    const env = envelopes.get(payload.trackId);
    if (!env) continue;
    const { releaseEnd } = noteEnvelopeTiming(env, time, payload.durationBeats * spb, payload.cut);
    tail = Math.max(tail, releaseEnd - songEnd);
  }
  return longestDelay + tail;
}

/** Render through the song end plus the release and echo tail. */
export function renderLengthSeconds(project: Project, events = renderScheduleEvents(project)): number {
  return songEndBeat(project) * secondsPerBeat(project.bpm) + songTailSeconds(project, { events });
}

/** Resolve the shared schedule to absolute times for the offline context. */
export function renderScheduleEvents(project: Project): RenderEvent[] {
  return buildScheduleEvents(project)
    .map(({ beat, payload }) => ({ beat, payload: payload as SchedulePayload, time: beatToTime(beat, project.bpm, 0, 0) }))
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
  const channels: Float32Array[] = Array.isArray(source)
    ? source
    : collectChannels(source);
  const rate = sampleRate ?? (Array.isArray(source) ? RENDER_SAMPLE_RATE : source.sampleRate);

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
 * resolved offline time, renders, and encodes. Loop and metronome are not part
 * of an exported render (the song plays once, no click).
 */
export async function renderProjectToWav(project: Project): Promise<Blob> {
  const events = renderScheduleEvents(project);
  const frames = Math.max(1, Math.ceil(renderLengthSeconds(project, events) * RENDER_SAMPLE_RATE));

  const ctx = new OfflineAudioContext(RENDER_CHANNELS, frames, RENDER_SAMPLE_RATE);

  // Master bus + soft limiter (shared with AudioEngine).
  const master = createMasterChain(ctx, project.tracks).input;

  // Per-track graphs + voice managers.
  const graphs = buildTrackGraphs(ctx, master, project.tracks, 0);
  const synths = new Map<string, SynthVoiceManager>();
  const drums = new Map<string, DrumVoiceManager>();
  for (const track of project.tracks) {
    const graph = graphs.get(track.id);
    if (!graph) continue;
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

  // Schedule the song window. anchorBeat=0, anchorTime=0 => beat n maps to n*spb.
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
  const wav = encodeWav(rendered);
  return new Blob([wav], { type: 'audio/wav' });
}
