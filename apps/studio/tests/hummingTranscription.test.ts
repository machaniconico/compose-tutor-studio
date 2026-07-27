import { describe, expect, it } from 'vitest';
import {
  MAX_HUMMING_CHANNELS,
  MAX_HUMMING_PCM_BYTES,
  MAX_HUMMING_PUBLIC_PITCH_FRAMES,
  MAX_HUMMING_SAMPLE_RATE,
  MAX_HUMMING_TRANSCRIPTION_SECONDS,
  MAX_HUMMING_WAVEFORM_BINS,
  transcribeHummingToMelody,
  transcribeHummingToMelodyResult,
  type HummingAudioBufferShape,
  type HummingTranscriptionResult,
} from '../src/audio/hummingTranscription';

const SAMPLE_RATE = 8_000;
const immediateYield = async () => undefined;

function sine(
  frequencyHz: number,
  seconds: number,
  amplitude = 0.5,
  sampleRate = SAMPLE_RATE,
): Float32Array {
  const frames = Math.round(seconds * sampleRate);
  return Float32Array.from(
    { length: frames },
    (_, frame) =>
      amplitude * Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRate),
  );
}

function vibrato(
  centerHz: number,
  seconds: number,
  depthSemitones: number,
  rateHz: number,
): Float32Array {
  const frames = Math.round(seconds * SAMPLE_RATE);
  let phase = 0;
  return Float32Array.from({ length: frames }, (_, frame) => {
    const depth = depthSemitones * Math.sin((2 * Math.PI * rateHz * frame) / SAMPLE_RATE);
    const frequencyHz = centerHz * 2 ** (depth / 12);
    phase += (2 * Math.PI * frequencyHz) / SAMPLE_RATE;
    return 0.5 * Math.sin(phase);
  });
}

function concatenate(...parts: readonly Float32Array[]): Float32Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function audioBufferShape(
  channels: readonly Float32Array[],
  sampleRate = SAMPLE_RATE,
): HummingAudioBufferShape {
  const length = channels[0]?.length ?? 0;
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate,
    getChannelData(channel: number) {
      const samples = channels[channel];
      if (!samples) throw new RangeError('channel');
      return samples;
    },
  };
}

function expectBoundedPreview(result: HummingTranscriptionResult): void {
  expect(Number.isFinite(result.durationSeconds)).toBe(true);
  expect(result.durationSeconds).toBeGreaterThan(0);
  expect(result.waveform.length).toBeLessThanOrEqual(MAX_HUMMING_WAVEFORM_BINS);
  expect(result.pitchFrames.length).toBeLessThanOrEqual(
    MAX_HUMMING_PUBLIC_PITCH_FRAMES,
  );

  let previousWaveformStart = Number.NEGATIVE_INFINITY;
  let previousWaveformEnd = 0;
  for (const bin of result.waveform) {
    expect(Number.isFinite(bin.startSeconds)).toBe(true);
    expect(Number.isFinite(bin.endSeconds)).toBe(true);
    expect(Number.isFinite(bin.min)).toBe(true);
    expect(Number.isFinite(bin.max)).toBe(true);
    expect(bin.startSeconds).toBeGreaterThanOrEqual(0);
    expect(bin.startSeconds).toBeGreaterThanOrEqual(previousWaveformStart);
    expect(bin.startSeconds).toBeGreaterThanOrEqual(previousWaveformEnd);
    expect(bin.endSeconds).toBeGreaterThan(bin.startSeconds);
    expect(bin.endSeconds).toBeLessThanOrEqual(result.durationSeconds);
    expect(bin.min).toBeLessThanOrEqual(bin.max);
    previousWaveformStart = bin.startSeconds;
    previousWaveformEnd = bin.endSeconds;
  }

  let previousPitchStart = Number.NEGATIVE_INFINITY;
  let previousPitchEnd = 0;
  for (const frame of result.pitchFrames) {
    expect(Number.isFinite(frame.startSeconds)).toBe(true);
    expect(Number.isFinite(frame.endSeconds)).toBe(true);
    expect(Number.isFinite(frame.confidence)).toBe(true);
    expect(frame.startSeconds).toBeGreaterThanOrEqual(0);
    expect(frame.startSeconds).toBeGreaterThanOrEqual(previousPitchStart);
    expect(frame.startSeconds).toBeGreaterThanOrEqual(previousPitchEnd);
    expect(frame.endSeconds).toBeGreaterThan(frame.startSeconds);
    expect(frame.endSeconds).toBeLessThanOrEqual(result.durationSeconds);
    expect(frame.confidence).toBeGreaterThanOrEqual(0);
    expect(frame.confidence).toBeLessThanOrEqual(1);
    if (frame.midi !== null) {
      expect(Number.isFinite(frame.midi)).toBe(true);
      expect(frame.midi).toBeGreaterThanOrEqual(0);
      expect(frame.midi).toBeLessThanOrEqual(127);
    }
    previousPitchStart = frame.startSeconds;
    previousPitchEnd = frame.endSeconds;
  }
}

describe('humming transcription', () => {
  it('returns bounded waveform and pitch projections without exposing source PCM', async () => {
    const source = sine(440, 1);
    const result = await transcribeHummingToMelodyResult(audioBufferShape([source]), {
      yieldControl: immediateYield,
    });

    expect(Object.keys(result).sort()).toEqual([
      'durationSeconds',
      'notes',
      'pitchFrames',
      'waveform',
    ]);
    expect(result.durationSeconds).toBe(1);
    expect(result.waveform).toHaveLength(MAX_HUMMING_WAVEFORM_BINS);
    expect(result.waveform[0]?.startSeconds).toBe(0);
    expect(result.waveform.at(-1)?.endSeconds).toBe(1);
    expect(result.waveform.some((bin) => bin.min < 0 && bin.max > 0)).toBe(true);
    for (let index = 0; index < result.waveform.length; index += 1) {
      const bin = result.waveform[index];
      const next = result.waveform[index + 1];
      expect(bin).toBeDefined();
      expect(Number.isFinite(bin?.min)).toBe(true);
      expect(Number.isFinite(bin?.max)).toBe(true);
      expect(bin?.min).toBeLessThanOrEqual(bin?.max ?? Number.NEGATIVE_INFINITY);
      expect(bin?.startSeconds).toBeLessThan(bin?.endSeconds ?? 0);
      if (bin && next) expect(bin.endSeconds).toBe(next.startSeconds);
    }

    expect(result.pitchFrames.length).toBeGreaterThan(0);
    expect(result.pitchFrames.length).toBeLessThanOrEqual(MAX_HUMMING_PUBLIC_PITCH_FRAMES);
    expect(result.pitchFrames[0]?.startSeconds).toBe(0);
    expect(result.pitchFrames.at(-1)?.endSeconds).toBe(1);
    expect(
      result.pitchFrames
        .filter((frame) => frame.midi !== null)
        .every((frame) => Math.abs((frame.midi ?? 0) - 69) < 0.1),
    ).toBe(true);
    expect(result.notes.map((note) => note.midi)).toEqual([69]);

    const snapshot = JSON.stringify(result);
    source.fill(0);
    expect(JSON.stringify(result)).toBe(snapshot);
    expect(snapshot).not.toContain('getChannelData');
  });

  it('compacts public pitch frames to a fixed bound while covering the full source time', async () => {
    const durationSeconds = 61;
    const result = await transcribeHummingToMelodyResult(
      audioBufferShape([new Float32Array(SAMPLE_RATE * durationSeconds)]),
      { yieldControl: immediateYield },
    );

    expect(result.pitchFrames).toHaveLength(MAX_HUMMING_PUBLIC_PITCH_FRAMES);
    expect(result.pitchFrames[0]?.startSeconds).toBe(0);
    expect(result.pitchFrames.at(-1)?.endSeconds).toBe(durationSeconds);
    expect(result.pitchFrames.every((frame) => frame.midi === null)).toBe(true);
    expect(result.waveform).toHaveLength(MAX_HUMMING_WAVEFORM_BINS);
  });

  it('keeps an exact 60-second preview finite, monotonic, and within public bounds', async () => {
    const durationSeconds = 60;
    const result = await transcribeHummingToMelodyResult(
      audioBufferShape([new Float32Array(SAMPLE_RATE * durationSeconds)]),
      { yieldControl: immediateYield },
    );

    expect(result.durationSeconds).toBe(durationSeconds);
    expectBoundedPreview(result);
  });

  it('keeps the note-only API compatible with the rich result', async () => {
    const source = audioBufferShape([sine(329.628, 0.8)]);
    const rich = await transcribeHummingToMelodyResult(source, {
      yieldControl: immediateYield,
    });
    const notes = await transcribeHummingToMelody(source, {
      yieldControl: immediateYield,
    });

    expect(notes).toEqual(rich.notes);
  });

  it('transcribes a clean A4 into one quantized MIDI note', async () => {
    const notes = await transcribeHummingToMelody(audioBufferShape([sine(440, 1)]), {
      yieldControl: immediateYield,
    });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ midi: 69 });
    expect(notes[0]?.startSeconds).toBeLessThan(0.03);
    expect(notes[0]?.durationSeconds).toBeGreaterThan(0.9);
    expect(notes[0]?.confidence).toBeGreaterThan(0.95);
  });

  it('returns no notes for silence', async () => {
    const result = await transcribeHummingToMelodyResult(
      audioBufferShape([new Float32Array(SAMPLE_RATE)]),
      { yieldControl: immediateYield },
    );
    expect(result.notes).toEqual([]);
    expect(result.waveform.every((bin) => bin.min === 0 && bin.max === 0)).toBe(true);
    expect(
      result.pitchFrames.every(
        (frame) => frame.midi === null && frame.confidence === 0,
      ),
    ).toBe(true);
  });

  it('covers the declared 50–1000 Hz pitch range', async () => {
    const low = await transcribeHummingToMelody(
      audioBufferShape([sine(50, 0.6)]),
      { yieldControl: immediateYield },
    );
    const high = await transcribeHummingToMelody(
      audioBufferShape([sine(1_000, 0.4)]),
      { yieldControl: immediateYield },
    );
    expect(low.map((note) => note.midi)).toEqual([31]);
    expect(high.map((note) => note.midi)).toEqual([83]);
  });

  it('accepts and downsamples the maximum declared sample rate', async () => {
    const source = sine(440, 0.2, 0.5, MAX_HUMMING_SAMPLE_RATE);
    const notes = await transcribeHummingToMelody(
      audioBufferShape([source], MAX_HUMMING_SAMPLE_RATE),
      { yieldControl: immediateYield },
    );
    expect(notes.map((note) => note.midi)).toEqual([69]);
  });

  it('keeps two pitches separated by a short unvoiced region', async () => {
    const recording = concatenate(
      sine(440, 0.6),
      new Float32Array(Math.round(SAMPLE_RATE * 0.08)),
      sine(523.251, 0.6),
    );
    const result = await transcribeHummingToMelodyResult(audioBufferShape([recording]), {
      yieldControl: immediateYield,
    });
    const notes = result.notes;

    expect(notes.map((note) => note.midi)).toEqual([69, 72]);
    const first = notes[0];
    const second = notes[1];
    expect(first && second ? first.startSeconds + first.durationSeconds : Infinity).toBeLessThan(
      second?.startSeconds ?? 0,
    );
    expectBoundedPreview(result);
    const voicedMidi = result.pitchFrames.flatMap((frame) =>
      frame.midi === null ? [] : [frame.midi]
    );
    expect(voicedMidi.some((midi) => Math.abs(midi - 69) < 0.2)).toBe(true);
    expect(voicedMidi.some((midi) => Math.abs(midi - 72) < 0.2)).toBe(true);
  });

  it('merges normal vibrato into one stable semitone', async () => {
    const notes = await transcribeHummingToMelody(
      audioBufferShape([vibrato(440, 1.2, 0.7, 5)]),
      { yieldControl: immediateYield },
    );

    expect(notes).toHaveLength(1);
    expect(notes[0]?.midi).toBe(69);
    expect(notes[0]?.durationSeconds).toBeGreaterThan(1.1);
  });

  it('keeps a weak fundamental when the second harmonic is much stronger', async () => {
    const fundamental = sine(110, 1, 0.1);
    const harmonic = sine(220, 1, 0.8);
    const source = Float32Array.from(
      fundamental,
      (sample, frame) => sample + (harmonic[frame] ?? 0),
    );
    const notes = await transcribeHummingToMelody(audioBufferShape([source]), {
      yieldControl: immediateYield,
    });
    expect(notes.map((note) => note.midi)).toEqual([45]);
  });

  it('does not invent octave-lower fundamentals for pure tones', async () => {
    for (const frequencyHz of [550, 590, 840, 940]) {
      const notes = await transcribeHummingToMelody(
        audioBufferShape([sine(frequencyHz, 0.4)]),
        { yieldControl: immediateYield },
      );
      const expectedMidi = Math.round(69 + 12 * Math.log2(frequencyHz / 440));
      expect(notes.map((note) => note.midi)).toEqual([expectedMidi]);
    }
  });

  it('low-passes ultrasonic source content before analysis downsampling', async () => {
    for (const frequencyHz of [4_100, 4_500, 7_900]) {
      const source = sine(frequencyHz, 0.5, 0.8, MAX_HUMMING_SAMPLE_RATE);
      const notes = await transcribeHummingToMelody(
        audioBufferShape([source], MAX_HUMMING_SAMPLE_RATE),
        { yieldControl: immediateYield },
      );
      expect(notes).toEqual([]);
    }
  });

  it('polarity-aligns inverse and nearly cancelling stereo before mixing', async () => {
    const left = sine(329.628, 0.8, 0.45);
    const exactInverse = Float32Array.from(left, (sample) => -sample);
    const nearInverse = Float32Array.from(left, (sample, frame) =>
      -0.995 * sample + 0.0002 * Math.sin((2 * Math.PI * 117 * frame) / SAMPLE_RATE),
    );

    const exactNotes = await transcribeHummingToMelody(
      audioBufferShape([left, exactInverse]),
      { yieldControl: immediateYield },
    );
    const nearNotes = await transcribeHummingToMelody(
      audioBufferShape([left, nearInverse]),
      { yieldControl: immediateYield },
    );
    expect(exactNotes.map((note) => note.midi)).toEqual([64]);
    expect(nearNotes.map((note) => note.midi)).toEqual([64]);
  });

  it('is deterministic for the same source regardless of chunk size', async () => {
    const source = audioBufferShape([sine(261.626, 0.5)]);
    const smallChunks = await transcribeHummingToMelodyResult(source, {
      chunkSamples: 127,
      yieldControl: immediateYield,
    });
    const largeChunks = await transcribeHummingToMelodyResult(source, {
      chunkSamples: 100_000,
      yieldControl: immediateYield,
    });
    expect(smallChunks).toEqual(largeChunks);
  });

  it('rejects unsafe duration, sample-rate, channel and sample values', async () => {
    const neverRead = () => {
      throw new Error('must reject before reading channels');
    };
    await expect(
      transcribeHummingToMelody(
        {
          numberOfChannels: 1,
          length: Math.floor((MAX_HUMMING_TRANSCRIPTION_SECONDS + 1) * SAMPLE_RATE),
          sampleRate: SAMPLE_RATE,
          getChannelData: neverRead,
        },
        { yieldControl: immediateYield },
      ),
    ).rejects.toMatchObject({ code: 'duration-limit-exceeded' });
    await expect(
      transcribeHummingToMelody(
        {
          numberOfChannels: 1,
          length: 1,
          sampleRate: MAX_HUMMING_SAMPLE_RATE + 1,
          getChannelData: neverRead,
        },
        { yieldControl: immediateYield },
      ),
    ).rejects.toMatchObject({ code: 'sample-rate-out-of-range' });
    await expect(
      transcribeHummingToMelody(
        {
          numberOfChannels: MAX_HUMMING_CHANNELS + 1,
          length: 1,
          sampleRate: SAMPLE_RATE,
          getChannelData: neverRead,
        },
        { yieldControl: immediateYield },
      ),
    ).rejects.toMatchObject({ code: 'channel-limit-exceeded' });
    await expect(
      transcribeHummingToMelody(
        {
          numberOfChannels: 2,
          length: Math.floor(MAX_HUMMING_PCM_BYTES / 8) + 1,
          sampleRate: MAX_HUMMING_SAMPLE_RATE,
          getChannelData: neverRead,
        },
        { yieldControl: immediateYield },
      ),
    ).rejects.toMatchObject({ code: 'resource-limit-exceeded' });
    await expect(
      transcribeHummingToMelody(
        {
          numberOfChannels: 1,
          length: 8_000,
          sampleRate: 8_000.5,
          getChannelData: neverRead,
        },
        { yieldControl: immediateYield },
      ),
    ).rejects.toMatchObject({ code: 'sample-rate-out-of-range' });
    await expect(
      transcribeHummingToMelody(audioBufferShape([sine(440, 0.1)]), {
        chunkSamples: Number.MAX_SAFE_INTEGER,
        yieldControl: immediateYield,
      }),
    ).rejects.toMatchObject({ code: 'invalid-audio' });

    const invalid = sine(440, 0.1);
    invalid[20] = Number.NaN;
    await expect(
      transcribeHummingToMelody(audioBufferShape([invalid]), {
        yieldControl: immediateYield,
      }),
    ).rejects.toMatchObject({ code: 'non-finite-sample' });
  });

  it('accepts the maximum channel count without diluting an active channel', async () => {
    const active = sine(220, 0.25);
    const channels = Array.from(
      { length: MAX_HUMMING_CHANNELS },
      (_, channel) => (channel === 17 ? active : new Float32Array(active.length)),
    );
    const notes = await transcribeHummingToMelody(audioBufferShape(channels), {
      yieldControl: immediateYield,
    });
    expect(notes.map((note) => note.midi)).toEqual([57]);
  });

  it('honors cancellation between bounded work chunks', async () => {
    const controller = new AbortController();
    let yields = 0;
    const promise = transcribeHummingToMelody(audioBufferShape([sine(440, 1)]), {
      signal: controller.signal,
      chunkSamples: 64,
      yieldControl: async () => {
        yields += 1;
        controller.abort();
      },
    });

    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(yields).toBe(1);
  });
});
