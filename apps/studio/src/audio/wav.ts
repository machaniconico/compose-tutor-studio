// Offline render to 16-bit PCM WAV.
//
// `renderProjectToWav` builds the same schedule used for live playback into an
// OfflineAudioContext, renders it, and encodes the result. `encodeWav` is a pure
// function (no Web Audio) so the RIFF/WAVE header, chunk sizes and sample
// clamping are unit testable.

import type { Clip, DrumEvent, Project } from '@cts/project-model';
import {
  DEFAULT_STEPS_PER_BAR,
  buildScheduleEvents,
  drumStepToBeat,
  type SchedulePayload,
} from './events';
import { buildTrackGraphs } from './graph';
import {
  beatToTime,
  makeDrumGrooveStepKey,
  projectLengthBeats,
  resolveDrumGrooveHit,
  secondsPerBeat,
  type ScheduledEvent,
} from './scheduler';
import { DrumVoiceManager } from './drums';
import { SynthVoiceManager } from './synth';

/** Render sample rate (Hz). */
export const RENDER_SAMPLE_RATE = 44100;
/** Render channel count. */
export const RENDER_CHANNELS = 2;
/** Silence tail appended after the last event, seconds. */
export const RENDER_TAIL_SECONDS = 1;

type DrumGrooveSettings = {
  swing: number;
  probability: number;
  humanizeVelocity: number;
  seed: number;
};

type DrumEventWithGroove = DrumEvent & {
  probability?: number;
};

type DrumClipWithGroove = Clip & {
  drumGroove?: Partial<DrumGrooveSettings>;
  drumEvents?: DrumEventWithGroove[];
};

const DEFAULT_DRUM_GROOVE: DrumGrooveSettings = {
  swing: 0,
  probability: 1,
  humanizeVelocity: 0,
  seed: 1,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function readDrumGroove(clip: Clip): DrumGrooveSettings {
  const raw = (clip as DrumClipWithGroove).drumGroove;
  return {
    swing: clamp(raw?.swing ?? DEFAULT_DRUM_GROOVE.swing, 0, 1),
    probability: clamp(raw?.probability ?? DEFAULT_DRUM_GROOVE.probability, 0, 1),
    humanizeVelocity: Math.round(
      clamp(raw?.humanizeVelocity ?? DEFAULT_DRUM_GROOVE.humanizeVelocity, 0, 32),
    ),
    seed: Math.max(1, Math.trunc(raw?.seed ?? DEFAULT_DRUM_GROOVE.seed)),
  };
}

function readDrumEventProbability(
  event: DrumEventWithGroove,
  fallback: number,
): number {
  return clamp(event.probability ?? fallback, 0, 1);
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
 * Build the exact event schedule used by offline WAV render.
 *
 * Notes come from the shared project flattener. Drum clips are resolved here so
 * export reads each clip's persisted groove instead of the UI runtime groove.
 */
export function buildWavScheduleEvents(project: Project): ScheduledEvent[] {
  const beatsPerBar = project.timeSignature[0] > 0 ? project.timeSignature[0] : 4;
  const events = buildScheduleEvents(project).filter((ev) => {
    const payload = ev.payload as Partial<SchedulePayload>;
    return payload.kind !== 'drum';
  });

  for (const track of project.tracks) {
    if (track.type !== 'drum') continue;

    for (const clip of track.clips) {
      const drumEvents = (clip as DrumClipWithGroove).drumEvents ?? [];
      if (drumEvents.length === 0) continue;

      const stepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
      const groove = readDrumGroove(clip);

      for (const drum of drumEvents) {
        const beat = drumStepToBeat(drum.stepIndex, stepsPerBar, beatsPerBar, clip.startBeat);
        const stepKey = makeDrumGrooveStepKey(drum.lane, beat);
        const hit = resolveDrumGrooveHit({
          beat,
          lane: drum.lane,
          velocity: drum.velocity,
          probability: readDrumEventProbability(drum, groove.probability),
          swing: groove.swing,
          humanizeVelocity: groove.humanizeVelocity,
          seed: groove.seed,
          stepKey,
          stepsPerBar,
          beatsPerBar,
        });
        if (!hit) continue;

        events.push({
          beat: hit.beat,
          payload: {
            kind: 'drum',
            trackId: track.id,
            lane: drum.lane,
            velocity: hit.velocity,
          } satisfies SchedulePayload,
        });
      }
    }
  }

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
  const beatsPerBar = project.timeSignature[0] > 0 ? project.timeSignature[0] : 4;
  const lengthBeats = projectLengthBeats(project.lengthBars, beatsPerBar);
  const songSeconds = lengthBeats * secondsPerBeat(project.bpm);
  const totalSeconds = songSeconds + RENDER_TAIL_SECONDS;
  const frames = Math.max(1, Math.ceil(totalSeconds * RENDER_SAMPLE_RATE));

  const ctx = new OfflineAudioContext(RENDER_CHANNELS, frames, RENDER_SAMPLE_RATE);

  // Master bus + soft limiter (mirrors AudioEngine routing).
  const master = ctx.createGain();
  master.gain.value = 1;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  master.connect(limiter);
  limiter.connect(ctx.destination);

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

  // Schedule everything. anchorBeat=0, anchorTime=0 => beat n maps to n*spb.
  const events = buildWavScheduleEvents(project);
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
        drum.trigger(payload.lane, time, payload.velocity);
      }
    }
  }

  const rendered = await ctx.startRendering();
  const wav = encodeWav(rendered);
  return new Blob([wav], { type: 'audio/wav' });
}
