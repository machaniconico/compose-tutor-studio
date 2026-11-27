import { describe, expect, it, vi } from 'vitest';
import { listenForMidiInput, parseMidiMessage, requestWebMidi, supportsWebMidi } from '../src/platform/webMidi';
import { MockMidiAccess, MockMidiInput } from './mockWebMidi';

describe('Web MIDI access', () => {
  it('reports unsupported without requesting access', async () => {
    const browser = {} as Navigator;
    expect(supportsWebMidi(browser)).toBe(false);
    await expect(requestWebMidi(browser)).resolves.toEqual({ supported: false });
  });

  it('requests access without sysex and preserves the navigator receiver', async () => {
    const midi = new MockMidiAccess();
    const browser = { requestMIDIAccess: midi.request } as unknown as Navigator;
    expect(supportsWebMidi(browser)).toBe(true);
    expect(midi.request).not.toHaveBeenCalled();
    await expect(requestWebMidi(browser)).resolves.toEqual({ supported: true, access: midi });
    expect(midi.request).toHaveBeenCalledExactlyOnceWith({ sysex: false });
    expect(midi.request.mock.contexts).toEqual([browser]);
  });

  it('reports denied access separately from an unsupported environment', async () => {
    const browser = { requestMIDIAccess: vi.fn().mockRejectedValue(new Error('denied')) } as unknown as Navigator;
    await expect(requestWebMidi(browser)).resolves.toEqual({ supported: true, access: null });
  });

  it('delivers messages and refreshes connected inputs on statechange, then removes listeners', () => {
    const midi = new MockMidiAccess();
    const first = new MockMidiInput('first');
    const second = new MockMidiInput('second');
    midi.connect(first);
    const onInputsChanged = vi.fn();
    const onDisconnect = vi.fn();
    const onNote = vi.fn();
    const unlisten = listenForMidiInput(midi as unknown as MIDIAccess, 1, { onInputsChanged, onDisconnect, onNote });
    expect(onInputsChanged).toHaveBeenLastCalledWith([first]);

    midi.connect(second);
    expect(onInputsChanged).toHaveBeenLastCalledWith([first, second]);
    second.send([0x90, 60, 100], { timeStamp: 0 });
    second.send([0x80, 60, 64], { timeStamp: 25 });
    second.send([0x90, 60, 0], { timeStamp: 30 });
    expect(onNote.mock.calls).toEqual([
      ['second', { type: 'noteOn', pitch: 60, velocity: 100 }, 0],
      ['second', { type: 'noteOff', pitch: 60 }, 25],
      ['second', { type: 'noteOff', pitch: 60 }, 30],
    ]);

    const removeSecondListener = vi.spyOn(second, 'removeEventListener');
    midi.disconnect(second);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onInputsChanged).toHaveBeenLastCalledWith([first]);
    expect(removeSecondListener).toHaveBeenCalledWith('midimessage', expect.any(Function));
    second.send([0x90, 60, 100]);

    unlisten();
    first.send([0x90, 60, 100]);
    midi.connect(second);
    second.send([0x90, 60, 100]);
    expect(onInputsChanged).toHaveBeenCalledTimes(3);
    expect(onNote).toHaveBeenCalledTimes(3);
  });
});

describe('MIDI message parser', () => {
  it('parses note-on, note-off and zero velocity on the selected channel', () => {
    expect(parseMidiMessage([0x90, 60, 100], 1)).toEqual({ type: 'noteOn', pitch: 60, velocity: 100 });
    expect(parseMidiMessage([0x8f, 127, 127], 16)).toEqual({ type: 'noteOff', pitch: 127 });
    expect(parseMidiMessage([0x9f, 0, 0], 16)).toEqual({ type: 'noteOff', pitch: 0 });
  });

  it('ignores notes on the other 15 channels, including zero-velocity messages', () => {
    for (let channel = 1; channel <= 16; channel++) {
      if (channel === 7) continue;
      expect(parseMidiMessage([0x90 + channel - 1, 60, 100], 7)).toBeUndefined();
      expect(parseMidiMessage([0x90 + channel - 1, 60, 0], 7)).toBeUndefined();
      expect(parseMidiMessage([0x80 + channel - 1, 60, 0], 7)).toBeUndefined();
    }
  });

  it('ignores non-note statuses, running status, invalid bytes and malformed lengths', () => {
    const ignored = [
      [0xf0, 0, 0xf7], [0xf8], [0xfe], [0xb0, 64, 127], [0xe0, 0, 64],
      [60, 100], [60, 100, 61], [0x90], [0x90, 60], [0x90, 60, 100, 0],
      [0x90, -1, 0], [0x90, 128, 0], [0x90, 0.5, 0], [0x90, NaN, 0],
      [0x90, 60, -1], [0x90, 60, 128], [0x90, 60, Infinity], null, undefined,
    ];
    for (const message of ignored) expect(parseMidiMessage(message, 1)).toBeUndefined();
    expect(parseMidiMessage([0x90, 60, 100], 0)).toBeUndefined();
    expect(parseMidiMessage([0x90, 60, 100], 17)).toBeUndefined();
  });
});
