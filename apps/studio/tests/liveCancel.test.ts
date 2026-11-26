import { describe, expect, it } from 'vitest';
import { DrumVoiceManager } from '../src/audio/drums';
import { SynthVoiceManager } from '../src/audio/synth';

// US-012b review: a note or drum hit cancelled by a live edit just before it
// was due to start must stay silent. The fake AudioParam evaluates its
// automation timeline (set + linear ramps) so the test can read the gain at
// and after the scheduled start.
type Event = { kind: 'set' | 'ramp'; time: number; value: number };

class FakeParam {
  events: Event[] = [];
  constructor(public value = 1) {}
  setValueAtTime(value: number, time: number) {
    this.insert({ kind: 'set', time, value });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.insert({ kind: 'ramp', time, value });
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.insert({ kind: 'ramp', time, value });
  }
  cancelScheduledValues(time: number) {
    this.events = this.events.filter((e) => e.time < time);
  }
  cancelAndHoldAtTime(time: number) {
    const held = this.valueAt(time);
    this.cancelScheduledValues(time);
    this.setValueAtTime(held, time);
  }
  valueAt(time: number): number {
    let value = this.value;
    let from = 0;
    for (const e of this.events) {
      if (e.time <= time) {
        value = e.value;
        from = e.time;
      } else {
        if (e.kind === 'ramp') return value + (e.value - value) * ((time - from) / (e.time - from));
        break;
      }
    }
    return value;
  }
  private insert(e: Event) {
    this.events.push(e);
    this.events.sort((a, b) => a.time - b.time);
  }
}

function fakeContext() {
  const gains: FakeParam[] = [];
  const sources: Array<{ start: number; stops: number[] }> = [];
  const source = () => {
    const record = { start: Infinity, stops: [] as number[] };
    sources.push(record);
    return {
      type: 'sine',
      buffer: null,
      loop: false,
      frequency: new FakeParam(),
      detune: new FakeParam(),
      connect() {},
      start(time: number) {
        record.start = time;
      },
      stop(time: number) {
        record.stops.push(time);
      },
    };
  };
  const ctx = {
    currentTime: 0,
    createOscillator: source,
    createBufferSource: source,
    createBiquadFilter: () => ({ type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam(), connect() {} }),
    createGain: () => {
      const gain = new FakeParam();
      gains.push(gain);
      return { gain, connect() {}, disconnect() {} };
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext, gains, sources };
}

/** The gain path is silent from `start` on (sampled each millisecond for 0.5 s). */
function silentFrom(gain: FakeParam, start: number): boolean {
  for (let t = start; t < start + 0.5; t += 0.001) {
    if (Math.abs(gain.valueAt(t)) > 1e-9) return false;
  }
  return true;
}

describe('cancelling a queued voice before it starts', () => {
  it('keeps a note queued at 1.000 s silent when it is cancelled at 0.990 s', () => {
    const { ctx, gains, sources } = fakeContext();
    const synth = new SynthVoiceManager(ctx, {} as AudioNode, 'warmPad');
    const handle = synth.noteOn(60, 1, 0.5, 100);
    handle.release(0.99);
    const voiceGain = gains[gains.length - 1]!;
    expect(silentFrom(voiceGain, 1)).toBe(true);
    // The oscillators are stopped no later than their start.
    for (const s of sources) expect(Math.min(...s.stops)).toBeLessThanOrEqual(1);
  });

  it('still fades out a note that has already started', () => {
    const { ctx, gains } = fakeContext();
    const synth = new SynthVoiceManager(ctx, {} as AudioNode, 'warmPad');
    const handle = synth.noteOn(60, 1, 2, 100);
    handle.release(1.5);
    const voiceGain = gains[gains.length - 1]!;
    expect(voiceGain.valueAt(1.5)).toBeGreaterThan(0);
    expect(voiceGain.valueAt(1.5 + 0.015)).toBeGreaterThan(0);
    expect(voiceGain.valueAt(1.5 + 0.03)).toBe(0);
  });

  it.each(['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'] as const)(
    'keeps a %s hit queued at 1.000 s silent when it is cancelled at 0.990 s',
    (lane) => {
      const { ctx, gains } = fakeContext();
      const drums = new DrumVoiceManager(ctx, {} as AudioNode, { duration: 1 } as AudioBuffer);
      const handle = drums.trigger(lane, 1, 100);
      handle.release(0.99);
      // The first gain of a hit is the hit's own output.
      expect(silentFrom(gains[0]!, 1)).toBe(true);
    },
  );
});

describe('moving the end of a voice (live edits)', () => {
  const release = 0.5; // warmPad release

  it('lengthens a cut note in place: it sustains and releases at the new end', () => {
    const { ctx, gains, sources } = fakeContext();
    const synth = new SynthVoiceManager(ctx, {} as AudioNode, 'warmPad');
    const handle = synth.noteOn(60, 0, 0.5, 100, { cutAtEnd: true });
    handle.setDuration(2, 0.25);
    const gain = gains[gains.length - 1]!;
    expect(gain.valueAt(1.5)).toBeGreaterThan(0);
    expect(gain.valueAt(2)).toBeGreaterThan(0);
    expect(gain.valueAt(2 + release + 0.001)).toBe(0);
    for (const s of sources) expect(s.stops[s.stops.length - 1]).toBeCloseTo(2 + release + 0.02);
  });

  it('shortens a sounding note: it releases at the new end', () => {
    const { ctx, gains } = fakeContext();
    const synth = new SynthVoiceManager(ctx, {} as AudioNode, 'warmPad');
    const handle = synth.noteOn(60, 0, 2, 100);
    handle.setDuration(1, 0.5);
    const gain = gains[gains.length - 1]!;
    expect(gain.valueAt(0.99)).toBeGreaterThan(0);
    expect(gain.valueAt(1 + release + 0.001)).toBe(0);
  });

  it('does not take another voice when all 16 are in use', () => {
    const { ctx, sources } = fakeContext();
    const synth = new SynthVoiceManager(ctx, {} as AudioNode, 'warmPad');
    const handles = [];
    for (let pitch = 60; pitch < 76; pitch += 1) handles.push(synth.noteOn(pitch, 0, pitch === 75 ? 1.5 : 1, 100, { cutAtEnd: true }));
    const stopsBefore = sources.map((s) => s.stops.length);
    handles[15]!.setDuration(2, 0.5);
    // Only the two oscillators of the 75 got a new stop time.
    const changed = sources.flatMap((s, i) => (s.stops.length !== stopsBefore[i] ? [i] : []));
    expect(changed).toEqual([30, 31]);
  });
});
