import { describe, expect, it, vi } from 'vitest';
import { integratedLoudness, measureAudioLevels, truePeak } from '../src/audio/loudness';

function sine(rate: number, seconds: number, db: number, frequency = 1000, phase = 0): Float32Array {
  const gain = 10 ** (db / 20);
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, frame) =>
    gain * Math.sin(2 * Math.PI * frequency * frame / rate + phase));
}

describe.each([44100, 48000] as const)('loudness at %i Hz', (rate) => {
  it('measures a 1 kHz stereo sine at −23 dBFS within 0.3 LKFS', () => {
    const channel = sine(rate, 1, -23);
    expect(Math.abs(integratedLoudness([channel, channel], rate) + 23)).toBeLessThan(0.3);
  });

  it('weights 40 Hz correctly at both rates', () => {
    const channel = sine(rate, 2, -23, 40);
    // The RLB response near its corner attenuates 40 Hz by about 5.6 dB.
    expect(integratedLoudness([channel, channel], rate)).toBeCloseTo(-29.27, 1);
  });

  it('reports silence and very quiet sound below the absolute gate', () => {
    const silent = new Float32Array(rate);
    expect(integratedLoudness([], rate)).toBe(-Infinity);
    expect(integratedLoudness([silent, silent], rate)).toBe(-Infinity);
    expect(integratedLoudness([sine(rate, 1, -80)], rate)).toBe(-Infinity);
    expect(truePeak([silent, silent])).toBe(-Infinity);
  });

  it('handles clips shorter than one block and discards incomplete trailing blocks', () => {
    const short = sine(rate, 0.12, -23);
    expect(integratedLoudness([short, short], rate)).toBeCloseTo(-23, 1);
    const trailing = new Float32Array(Math.round(rate * 0.45));
    trailing.set(sine(rate, 0.4, -23));
    trailing.fill(1, Math.round(rate * 0.4));
    expect(integratedLoudness([trailing, trailing], rate)).toBeCloseTo(-23, 1);
  });

  it('rejects blocks far below the gated average while including overlapping transitions', () => {
    const channel = sine(rate, 4, -45);
    channel.set(sine(rate, 1, -23));
    // Ten blocks include the loud passage, including three 100 ms overlap steps
    // with 75%, 50% and 25% of their samples loud. The other 27 are rejected.
    expect(integratedLoudness([channel, channel], rate)).toBeCloseTo(-23.7, 1);
  });

  it('detects peaks between sample positions with four-times oversampling', () => {
    const channel = sine(rate, 0.1, -1, rate / 4, Math.PI / 4);
    const samplePeakDb = 20 * Math.log10(Math.abs(channel[0]!));
    const peakDb = truePeak([channel]);
    expect(peakDb).toBeGreaterThan(samplePeakDb + 2.5);
    expect(Math.abs(peakDb + 1)).toBeLessThan(0.3);
  });

  it('deeply equals the one-shot measurements across event-loop yields', async () => {
    const left = sine(rate, 0.71, -23);
    const right = sine(rate, 0.62, -5, rate / 4, Math.PI / 4);
    left[4095] = NaN;
    right[right.length - 1] = 1;
    const channels = [left, right];
    const expected = { loudness: integratedLoudness(channels, rate), peak: truePeak(channels) };

    let time = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => time += 50);
    const onProgress = vi.fn();
    try {
      expect(await measureAudioLevels(channels, rate, { onProgress })).toEqual(expected);
      for (const phase of ['loudness', 'peak']) {
        expect(onProgress.mock.calls.some(([stage, fraction]) => stage === phase && fraction > 0 && fraction < 1))
          .toBe(true);
      }
    } finally {
      clock.mockRestore();
    }
  });
});

it('aborts during measurement when the event loop handles cancellation', async () => {
  const request = new AbortController();
  const channel = sine(48000, 0.5, -23);
  let time = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time += 50);
  const onProgress = vi.fn((phase: string, fraction: number) => {
    if (phase === 'peak' && fraction > 0) setTimeout(() => request.abort(), 0);
  });
  try {
    await expect(measureAudioLevels([channel], 48000, { signal: request.signal, onProgress }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(onProgress).toHaveBeenLastCalledWith('peak', expect.closeTo(4096 / (channel.length + 11)));
  } finally {
    clock.mockRestore();
  }
});
