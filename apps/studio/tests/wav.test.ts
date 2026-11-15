import { describe, expect, it } from 'vitest';
import { createEmptyProject, type Track } from '@cts/project-model';
import {
  encodeWav,
  floatToInt16,
  RENDER_TAIL_SECONDS,
  renderLengthSeconds,
} from '../src/audio/wav';

/** Read a 4-char ASCII tag from an ArrayBuffer at an offset. */
function ascii(buffer: ArrayBuffer, offset: number, length = 4): string {
  const bytes = new Uint8Array(buffer, offset, length);
  return String.fromCharCode(...bytes);
}

describe('floatToInt16', () => {
  it('maps 0 to 0', () => {
    expect(floatToInt16(0)).toBe(0);
  });
  it('maps +1 to 0x7FFF and -1 to -0x8000', () => {
    expect(floatToInt16(1)).toBe(0x7fff);
    expect(floatToInt16(-1)).toBe(-0x8000);
  });
  it('clamps out-of-range samples', () => {
    expect(floatToInt16(2)).toBe(0x7fff);
    expect(floatToInt16(-2)).toBe(-0x8000);
  });
  it('scales mid values', () => {
    expect(floatToInt16(0.5)).toBe(Math.round(0.5 * 0x7fff));
    expect(floatToInt16(-0.5)).toBe(Math.round(-0.5 * 0x8000));
  });
});

describe('encodeWav header (stereo)', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, -1, 1, 0]);
  const buffer = encodeWav([left, right], 44100);
  const view = new DataView(buffer);

  it('writes RIFF / WAVE / fmt  / data tags', () => {
    expect(ascii(buffer, 0)).toBe('RIFF');
    expect(ascii(buffer, 8)).toBe('WAVE');
    expect(ascii(buffer, 12)).toBe('fmt ');
    expect(ascii(buffer, 36)).toBe('data');
  });

  it('has correct fmt fields for 16-bit PCM stereo', () => {
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint16(32, true)).toBe(4); // block align = 2ch * 2 bytes
    expect(view.getUint32(28, true)).toBe(44100 * 4); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('computes chunk sizes from the frame count', () => {
    const numFrames = 4;
    const blockAlign = 4;
    const dataSize = numFrames * blockAlign; // 16 bytes
    expect(view.getUint32(40, true)).toBe(dataSize); // data chunk size
    expect(view.getUint32(4, true)).toBe(36 + dataSize); // RIFF chunk size
    expect(buffer.byteLength).toBe(44 + dataSize);
  });

  it('interleaves L/R samples and clamps them', () => {
    // frame 0: L=0, R=0
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0);
    // frame 1: L=0.5, R=-1
    expect(view.getInt16(48, true)).toBe(floatToInt16(0.5));
    expect(view.getInt16(50, true)).toBe(-0x8000);
    // frame 3: L=1 (clamps to 0x7FFF), R=0
    expect(view.getInt16(56, true)).toBe(0x7fff);
    expect(view.getInt16(58, true)).toBe(0);
  });
});

describe('encodeWav (mono)', () => {
  it('produces a single-channel header', () => {
    const mono = new Float32Array([0.25, -0.25]);
    const buffer = encodeWav([mono], 22050);
    const view = new DataView(buffer);
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint16(32, true)).toBe(2); // block align = 1ch * 2 bytes
    expect(view.getUint32(40, true)).toBe(2 * 2); // 2 frames * 2 bytes
  });
});

describe('renderLengthSeconds', () => {
  const base = createEmptyProject({
    bpm: 20,
    lengthBars: 1,
    timeSignature: [4, 4],
    clock: () => new Date('2026-06-11T00:00:00.000Z'),
  });
  const delayTrack = (enabled: boolean, params: Record<string, number>): Track => ({
    id: 'melody',
    name: 'Melody',
    type: 'instrument',
    clips: [],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    effects: [{ id: 'fx-delay', type: 'delay', enabled, params }],
  });

  it('renders 8 bars of 3/4 as 24 beats', () => {
    // 8 bars x 3 beats at 60 BPM = 24 s.
    const waltz = { ...base, bpm: 60, lengthBars: 8, timeSignature: [3, 4] as [number, number], tracks: [] };
    expect(renderLengthSeconds(waltz)).toBe(24 + RENDER_TAIL_SECONDS);
  });

  it('is the song plus the fixed tail when no delay is enabled', () => {
    // 1 bar of 4/4 at 20 BPM = 12 s.
    expect(renderLengthSeconds({ ...base, tracks: [] })).toBe(12 + RENDER_TAIL_SECONDS);
    expect(
      renderLengthSeconds({ ...base, tracks: [delayTrack(false, { timeSeconds: 1.5 })] }),
    ).toBe(12 + RENDER_TAIL_SECONDS);
  });

  it('extends the tail by the longest enabled delay so the last repeat is kept', () => {
    const project = {
      ...base,
      tracks: [delayTrack(true, { timeSeconds: 0.5 }), { ...delayTrack(true, { timeSeconds: 1.5 }), id: 'bass' }],
    };
    expect(renderLengthSeconds(project)).toBe(12 + 1.5 + RENDER_TAIL_SECONDS);
  });

  it('uses the clamped legacy delay time, not the raw saved value', () => {
    const project = { ...base, tracks: [delayTrack(true, { delayTime: 4 })] };
    expect(renderLengthSeconds(project)).toBe(12 + 1.5 + RENDER_TAIL_SECONDS);
  });
});
