import { describe, expect, it, vi } from 'vitest';
import { SynthVoiceManager } from '../src/audio/synth';

type Call = [number, number];

function createMockContext() {
  const gains: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }[] = [];
  const param = () => ({ setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const ctx = {
    currentTime: 0,
    createOscillator: vi.fn(() => ({
      type: 'sine',
      frequency: param(),
      detune: param(),
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createBiquadFilter: vi.fn(() => ({ type: 'lowpass', frequency: param(), Q: param(), connect: vi.fn() })),
    createGain: vi.fn(() => {
      const gain = param();
      gains.push(gain);
      return { gain, connect: vi.fn() };
    }),
  };
  return { ctx, gains };
}

/** Time the voice gain starts its final ramp to 0 (the release start). */
function releaseStartOf(gain: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }): number {
  const sets = gain.setValueAtTime.mock.calls as Call[];
  return sets[sets.length - 1]![1];
}

describe('synth gate (live playback and WAV share SynthVoiceManager)', () => {
  // 120 BPM, warmPad (attack 0.18 + decay 0.3 = 0.48 s). A 2-beat note at 3.5 beats in a
  // 4-beat clip is cut to 0.5 beats = 0.25 s, so MIDI ends it at 2.00 s.
  it('starts the release at the clip-shortened end (2.00 s), not after attack+decay (2.23 s)', () => {
    const { ctx, gains } = createMockContext();
    const synth = new SynthVoiceManager(ctx as unknown as BaseAudioContext, {} as AudioNode, 'warmPad');
    synth.noteOn(60, 1.75, 0.25, 100, { cutAtEnd: true });
    const gain = gains[0]!;
    expect(releaseStartOf(gain)).toBeCloseTo(2.0, 9);
    const ramps = gain.linearRampToValueAtTime.mock.calls as Call[];
    // No envelope point lands between the gate end and the release ramp.
    for (const [, t] of ramps.slice(0, -1)) expect(t).toBeLessThanOrEqual(2.0 + 1e-9);
    expect(ramps[ramps.length - 1]).toEqual([0, 2.5]);
  });

  // Same 0.25 s warmPad note, not cut by a clip: it keeps the sound it always had
  // (full attack+decay, release from 0.48 s), live and in WAV.
  it('keeps the full attack and decay for an uncut short note (release at 0.48 s)', () => {
    const { ctx, gains } = createMockContext();
    const synth = new SynthVoiceManager(ctx as unknown as BaseAudioContext, {} as AudioNode, 'warmPad');
    synth.noteOn(60, 0, 0.25, 100);
    const gain = gains[0]!;
    expect(releaseStartOf(gain)).toBeCloseTo(0.48, 9);
    const ramps = gain.linearRampToValueAtTime.mock.calls as Call[];
    expect(ramps.map((c) => c[1])).toEqual([0.18, 0.48, 0.98]);
  });

  it('keeps the full attack and decay for a note longer than them', () => {
    const { ctx, gains } = createMockContext();
    const synth = new SynthVoiceManager(ctx as unknown as BaseAudioContext, {} as AudioNode, 'warmPad');
    synth.noteOn(60, 0, 1, 127);
    const gain = gains[0]!;
    const ramps = gain.linearRampToValueAtTime.mock.calls as Call[];
    expect(ramps.map((c) => c[1])).toEqual([0.18, 0.48, 1.5]);
    expect(releaseStartOf(gain)).toBe(1);
  });
});
