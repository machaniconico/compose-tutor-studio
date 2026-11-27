// P20 regression: a hi-hat choke must not change the open hat before the choke time.
//
// There is no real OfflineAudioContext under vitest, so the open hat's gain AudioParam is an
// evaluator of the Web Audio automation timeline (set / linear / exponential ramps, cancel,
// cancel-and-hold). The choked envelope is sampled against the unchoked one.
import { describe, expect, it } from 'vitest';
import { DrumVoiceManager } from '../src/audio/drums';
import { DRUM_VOICE_TIMING, HAT_CHOKE_FADE_SECONDS } from '../src/audio/voiceTiming';

type AutomationEvent = { kind: 'set' | 'linear' | 'exponential'; time: number; value: number };

class TimelineParam {
  value = 0;
  events: AutomationEvent[] = [];

  constructor(withCancelAndHold: boolean) {
    if (!withCancelAndHold) {
      (this as { cancelAndHoldAtTime?: unknown }).cancelAndHoldAtTime = undefined;
    }
  }

  private insert(event: AutomationEvent): void {
    const at = this.events.findIndex((existing) => existing.time > event.time);
    if (at < 0) this.events.push(event);
    else this.events.splice(at, 0, event);
  }

  setValueAtTime(value: number, time: number): void {
    this.insert({ kind: 'set', time, value });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.insert({ kind: 'linear', time, value });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.insert({ kind: 'exponential', time, value });
  }

  cancelScheduledValues(time: number): void {
    this.events = this.events.filter((event) => event.time < time);
  }

  cancelAndHoldAtTime(time: number): void {
    const held = this.valueAt(time);
    const crossing = this.events.find((event) => event.time > time);
    this.events = this.events.filter((event) => event.time <= time);
    if (crossing && crossing.kind !== 'set') this.insert({ kind: crossing.kind, time, value: held });
    else this.insert({ kind: 'set', time, value: held });
  }

  valueAt(time: number): number {
    let previous: AutomationEvent | undefined;
    for (const event of this.events) {
      if (event.time <= time) {
        previous = event;
        continue;
      }
      if (event.kind === 'set' || previous === undefined) break;
      const progress = (time - previous.time) / (event.time - previous.time);
      return event.kind === 'linear'
        ? previous.value + (event.value - previous.value) * progress
        : previous.value * (event.value / previous.value) ** progress;
    }
    return previous?.value ?? this.value;
  }
}

class Node {
  connect<T>(destination: T): T {
    return destination;
  }

  disconnect(): void {}
}

class Source extends Node {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  readonly stops: number[] = [];
  start(): void {}
  stop(time: number): void {
    this.stops.push(time);
  }
}

class Context {
  readonly sampleRate = 32;
  readonly currentTime = 0;
  readonly gains: Array<{ gain: TimelineParam }> = [];
  readonly sources: Source[] = [];

  constructor(private readonly withCancelAndHold: boolean) {}

  createBuffer(channels: number, length: number) {
    return { numberOfChannels: channels, length, getChannelData: () => new Float32Array(length) };
  }

  createBufferSource(): Source {
    const source = new Source();
    this.sources.push(source);
    return source;
  }

  createGain() {
    const gain = Object.assign(new Node(), { gain: new TimelineParam(this.withCancelAndHold) });
    this.gains.push(gain);
    return gain;
  }

  createBiquadFilter() {
    return Object.assign(new Node(), {
      type: 'highpass',
      frequency: new TimelineParam(true),
      Q: new TimelineParam(true),
    });
  }

  createOscillator() {
    return Object.assign(new Source(), { type: 'sine', frequency: new TimelineParam(true) });
  }
}

function openHatGain(
  withCancelAndHold: boolean,
  trigger: (manager: DrumVoiceManager) => void,
): { gain: TimelineParam; stops: number[] } {
  const ctx = new Context(withCancelAndHold);
  const manager = new DrumVoiceManager(ctx as unknown as BaseAudioContext, new Node() as unknown as AudioNode);
  trigger(manager);
  return { gain: ctx.gains[0]!.gain, stops: ctx.sources[0]!.stops };
}

const OPEN = 0.5;
const CHOKE = OPEN + 0.1;

describe('P20 hi-hat choke envelope', () => {
  for (const withCancelAndHold of [true, false]) {
    const label = withCancelAndHold ? 'cancelAndHoldAtTime' : 'fallback without cancelAndHoldAtTime';

    it(`chokedOpenHat_soundsIdenticalUntilChokeTime_thenFadesToSilence (${label})`, () => {
      const plain = openHatGain(withCancelAndHold, (m) => m.trigger('openHat', OPEN, 100, 7));
      const choked = [
        openHatGain(withCancelAndHold, (m) => m.trigger('openHat', OPEN, 100, 7, { stopTime: CHOKE })),
        openHatGain(withCancelAndHold, (m) => {
          // Live loop path: the closed hat stops earlier open hats when it is triggered.
          m.trigger('openHat', OPEN, 100, 7, { tick: 0 });
          m.trigger('closedHat', CHOKE, 100, 8, { tick: 48 });
        }),
      ];
      for (const { gain, stops } of choked) {
        for (let t = OPEN; t <= CHOKE; t += 0.001) {
          expect(gain.valueAt(t)).toBeCloseTo(plain.gain.valueAt(t), 9);
        }
        expect(gain.valueAt(CHOKE + HAT_CHOKE_FADE_SECONDS / 2)).toBeLessThan(plain.gain.valueAt(CHOKE));
        expect(gain.valueAt(CHOKE + HAT_CHOKE_FADE_SECONDS)).toBe(0);
        expect(stops.at(-1)).toBeCloseTo(CHOKE + HAT_CHOKE_FADE_SECONDS, 12);
      }
      // The decay really is a ramp at the choke time (the bug held the peak until the choke).
      expect(plain.gain.valueAt(CHOKE)).toBeLessThan(plain.gain.valueAt(OPEN) / 2);
    });
  }

  it('chokeAfterTheNaturalStop_leavesTheOpenHatUnchanged', () => {
    const late = OPEN + DRUM_VOICE_TIMING.openHat.sourceStopSeconds;
    const plain = openHatGain(true, (m) => m.trigger('openHat', OPEN, 100, 7));
    const choked = openHatGain(true, (m) => m.trigger('openHat', OPEN, 100, 7, { stopTime: late }));
    expect(choked.gain.events).toEqual(plain.gain.events);
    expect(choked.stops).toEqual(plain.stops);
  });
});
