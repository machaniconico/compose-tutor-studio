// Offline render to 16-bit PCM WAV.
//
// `renderProjectToWav` builds the same schedule used for live playback into an
// OfflineAudioContext, renders it, and encodes the result. `encodeWav` is a pure
// function (no Web Audio) so the RIFF/WAVE header, chunk sizes and sample
// clamping are unit testable.

import type { Project } from '@cts/project-model';
import { beatsPerBar as beatsPerBarOf } from '@cts/project-model';
import { delaySettings, enabledSupportedEffects } from './effects';
import { buildScheduleEvents, type SchedulePayload } from './events';
import { buildTrackGraphs } from './graph';
import { createMasterChain } from './masterChain';
import { nextEventsInWindow, projectLengthBeats, secondsPerBeat, type DueEvent } from './scheduler';
import { DrumVoiceManager } from './drums';
import { SynthVoiceManager } from './synth';

/** Render sample rate (Hz). */
export const RENDER_SAMPLE_RATE = 44100;
/** Render channel count. */
export const RENDER_CHANNELS = 2;
/** Silence tail appended after the last event, seconds. */
export const RENDER_TAIL_SECONDS = 1;

/**
 * The beat the sound of the song ends, before any release or echo: the song
 * end, or later when a note that starts before the song end lasts past it.
 * Such a note sounds its full length on every path (live, WAV and MIDI).
 */
export function songSoundEndBeat(project: Project): number {
  const bpb = beatsPerBarOf(project.timeSignature);
  const lengthBeats = projectLengthBeats(project.lengthBars, bpb > 0 ? bpb : 4);
  let end = lengthBeats;
  for (const event of buildScheduleEvents(project)) {
    const payload = event.payload as SchedulePayload;
    if (payload.kind !== 'note' || event.beat >= lengthBeats) continue;
    end = Math.max(end, event.beat + payload.durationBeats);
  }
  return end;
}

/**
 * Seconds kept after `songSoundEndBeat` for releases and echoes: the first
 * repeat of the longest enabled delay plus `RENDER_TAIL_SECONDS`.
 */
export function songTailSeconds(project: Project): number {
  let longestDelay = 0;
  for (const track of project.tracks) {
    for (const effect of enabledSupportedEffects(track.effects)) {
      if (effect.type !== 'delay') continue;
      longestDelay = Math.max(longestDelay, delaySettings(effect).timeSeconds);
    }
  }
  return longestDelay + RENDER_TAIL_SECONDS;
}

/**
 * Total render length in seconds: until the last note that starts in the song
 * has ended (`songSoundEndBeat`), plus the tail (`songTailSeconds`), so the
 * export does not cut off that note, its release or the echoes.
 */
export function renderLengthSeconds(project: Project): number {
  return songSoundEndBeat(project) * secondsPerBeat(project.bpm) + songTailSeconds(project);
}

/**
 * The events the offline render plays: the song window `[0, end)` resolved to
 * seconds with the same rule live playback (loop off) uses, so an event at or
 * after the last bar sounds in neither.
 */
export function renderScheduleEvents(project: Project): DueEvent[] {
  const bpb = beatsPerBarOf(project.timeSignature);
  const lengthBeats = projectLengthBeats(project.lengthBars, bpb > 0 ? bpb : 4);
  return nextEventsInWindow(buildScheduleEvents(project), 0, lengthBeats, project.bpm, 0, 0, null);
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
  const frames = Math.max(1, Math.ceil(renderLengthSeconds(project) * RENDER_SAMPLE_RATE));

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
      synths.set(track.id, new SynthVoiceManager(ctx, graph.input, track.instrument?.preset));
    }
  }

  // Schedule the song window. anchorBeat=0, anchorTime=0 => beat n maps to n*spb.
  const spb = secondsPerBeat(project.bpm);
  for (const ev of renderScheduleEvents(project)) {
    const time = ev.time;
    const payload = ev.payload as SchedulePayload;
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
        drum.trigger(payload.lane, time, payload.velocity);
      }
    }
  }

  const rendered = await ctx.startRendering();
  const wav = encodeWav(rendered);
  return new Blob([wav], { type: 'audio/wav' });
}
