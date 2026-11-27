import { expect, it } from 'vitest';
import { createMidiParser, parseMidiMessages, requestWebMidi, supportsWebMidi } from '../src/platform/webMidi';

it('parses note on/off, treats velocity 0 as off, on every channel', () => {
  expect(parseMidiMessages([0x90, 60, 100])).toEqual([{ type: 'noteOn', channel: 0, pitch: 60, velocity: 100 }]);
  expect(parseMidiMessages([0x90, 60, 0])).toEqual([{ type: 'noteOff', channel: 0, pitch: 60 }]);
  expect(parseMidiMessages([0x8f, 61, 64])).toEqual([{ type: 'noteOff', channel: 15, pitch: 61 }]);
  for (let ch = 0; ch < 16; ch++) {
    expect(parseMidiMessages([0x90 + ch, 40, 1])).toHaveLength(1);
  }
});

it('ignores realtime bytes anywhere and supports running status inside a packet', () => {
  expect(parseMidiMessages([0xf8, 0x90, 0xf8, 60, 0xfe, 100])).toEqual([
    { type: 'noteOn', channel: 0, pitch: 60, velocity: 100 },
  ]);
  expect(parseMidiMessages([0x90, 60, 100, 62, 90])).toHaveLength(2);
});

it('ignores CC64, program change data, sysex and truncated or hostile input without throwing', () => {
  expect(parseMidiMessages([0xb0, 64, 127])).toEqual([]);
  expect(parseMidiMessages([0xc0, 5, 0x90, 60, 1])).toHaveLength(1);
  expect(parseMidiMessages([0xf0, 1, 2, 3, 0xf7])).toEqual([]);
  expect(parseMidiMessages([0x90, 60])).toEqual([]);
  expect(parseMidiMessages([60, 100])).toEqual([]);
  expect(parseMidiMessages([0x90, 300, 5])).toEqual([]);
  expect(parseMidiMessages([0x90, NaN, 5])).toEqual([]);
  for (const bad of [null, undefined, 5, 'x', {}, { length: 1e9 }, { toString: null }]) {
    expect(() => parseMidiMessages(bad)).not.toThrow();
  }
});

it('seeded fuzz never throws and only yields valid notes', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 2000; i++) {
    const data = Uint8Array.from({ length: Math.floor(rnd() * 12) }, () => Math.floor(rnd() * 256));
    for (const n of parseMidiMessages(data)) {
      expect(n.pitch).toBeGreaterThanOrEqual(0);
      expect(n.pitch).toBeLessThanOrEqual(127);
      if (n.type === 'noteOn') expect(n.velocity).toBeGreaterThan(0);
    }
  }
});

it('reports unsupported / denied without throwing', async () => {
  const none = {} as Navigator;
  expect(supportsWebMidi(none)).toBe(false);
  expect(await requestWebMidi(none)).toEqual({ status: 'unsupported' });
  const denied = { requestMIDIAccess: async () => { throw new Error('no'); } } as unknown as Navigator;
  expect(await requestWebMidi(denied)).toEqual({ status: 'denied' });
});

it('keeps running status and partial messages across packets', () => {
  const p = createMidiParser();
  expect(p.feed([0x90, 0x3c, 0x64])).toHaveLength(1);
  expect(p.feed([0x3c, 0x00])).toEqual([{ type: 'noteOff', channel: 0, pitch: 0x3c }]);
  const q = createMidiParser();
  expect(q.feed([0x80, 0x3c])).toEqual([]);
  expect(q.feed([0x40])).toEqual([{ type: 'noteOff', channel: 0, pitch: 0x3c }]);
});

it('resets on system messages and on reset(); parsers are independent', () => {
  const p = createMidiParser();
  p.feed([0x90, 60]);
  p.feed([0xf0]);
  expect(p.feed([100])).toEqual([]);
  const q = createMidiParser();
  q.feed([0x90, 60]);
  q.reset();
  expect(q.feed([100])).toEqual([]);
  const a = createMidiParser();
  const b = createMidiParser();
  a.feed([0x90, 60]);
  expect(b.feed([100])).toEqual([]);
});

it('splitting a valid stream at every byte boundary equals the unsplit parse (seeded fuzz)', () => {
  let seed = 777;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 500; i++) {
    const stream: number[] = [];
    for (let m = 0; m < 1 + Math.floor(rnd() * 6); m++) {
      const status = [0x80, 0x90, 0xb0, 0xc0][Math.floor(rnd() * 4)]! + Math.floor(rnd() * 16);
      stream.push(status);
      const reps = 1 + Math.floor(rnd() * 3);
      for (let r = 0; r < reps; r++) {
        stream.push(Math.floor(rnd() * 128));
        if ((status & 0xf0) !== 0xc0) stream.push(Math.floor(rnd() * 128));
        if (rnd() < 0.2) stream.push(0xf8);
      }
    }
    const whole = createMidiParser().feed(stream);
    const p = createMidiParser();
    const parts: typeof whole = [];
    for (let at = 0; at < stream.length; ) {
      const n = 1 + Math.floor(rnd() * 3);
      parts.push(...p.feed(stream.slice(at, at + n)));
      at += n;
    }
    expect(parts).toEqual(whole);
    const every = createMidiParser();
    expect(stream.flatMap((b) => every.feed([b]))).toEqual(whole);
  }
});
