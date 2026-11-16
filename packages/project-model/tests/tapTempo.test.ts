import { describe, expect, it } from 'vitest';
import { tapTempo } from '../src/index';

describe('tapTempo', () => {
  it('turns 5 taps 500ms apart into 120 BPM', () => {
    expect(tapTempo([0, 500, 1000, 1500, 2000])).toBe(120);
  });

  it('returns null with fewer than 2 taps', () => {
    expect(tapTempo([])).toBeNull();
    expect(tapTempo([1234])).toBeNull();
  });

  it('clamps very fast taps (10ms apart) to 300 BPM', () => {
    expect(tapTempo([0, 10, 20, 30, 40])).toBe(300);
  });

  it('clamps very slow taps to 20 BPM', () => {
    expect(tapTempo([0, 10000])).toBe(20);
  });

  it('averages only the last 4 intervals', () => {
    // An old 2000ms gap is ignored; the last 4 gaps are 500ms each.
    expect(tapTempo([0, 2000, 2500, 3000, 3500, 4000])).toBe(120);
  });

  it('averages uneven intervals', () => {
    // Gaps 400 and 600 average to 500ms = 120 BPM.
    expect(tapTempo([0, 400, 1000])).toBe(120);
  });
});
