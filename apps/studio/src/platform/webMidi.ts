// Web MIDI input (read-only, no sysex). Pure parser plus a thin device layer.
//
// Supported on Windows and Linux builds. The macOS WebView (WKWebView) has no
// Web MIDI, so `requestMIDIAccess` is absent there; that is detected by feature
// (never by crashing) and explained in Japanese by the caller.
// Channels: every channel (1-16) is accepted; there is no channel filter.
// Sustain pedal (CC64) and every other control change are ignored.

export type MidiNoteMessage =
  | { type: 'noteOn'; channel: number; pitch: number; velocity: number }
  | { type: 'noteOff'; channel: number; pitch: number };

export type WebMidiRequest =
  | { status: 'unsupported' }
  | { status: 'denied' }
  | { status: 'ready'; access: MIDIAccess };

export const MIDI_UNSUPPORTED_MESSAGE =
  'この環境では MIDI キーボードを使えません(Windows・Linux 版で使えます)';
export const MIDI_DENIED_MESSAGE =
  'MIDI キーボードの使用が許可されませんでした。もう一度ボタンを押して許可してください';

export function supportsWebMidi(nav: Navigator | undefined = globalThis.navigator): boolean {
  return typeof nav?.requestMIDIAccess === 'function';
}

/** Call only from an explicit user action. Never throws. */
export async function requestWebMidi(
  nav: Navigator | undefined = globalThis.navigator,
): Promise<WebMidiRequest> {
  if (!supportsWebMidi(nav)) return { status: 'unsupported' };
  try {
    const access = await nav!.requestMIDIAccess({ sysex: false });
    return access ? { status: 'ready', access } : { status: 'denied' };
  } catch {
    return { status: 'denied' };
  }
}

function dataLength(status: number): number {
  const high = status & 0xf0;
  return high === 0xc0 || high === 0xd0 ? 1 : 2;
}

export type MidiParser = {
  /** Feed one packet; returns the notes completed by it. Never throws. */
  feed: (data: unknown) => MidiNoteMessage[];
  /** Drop the running status and any partial message. */
  reset: () => void;
};

/**
 * Stateful parser for ONE input. Keeps the running status and a partial
 * message (at most 2 data bytes) across packets. Note On with velocity 0 is a
 * Note Off. Realtime bytes (>= 0xF8) are dropped wherever they appear and do
 * not disturb the state. A system or sysex status byte (0xF0-0xF7), an
 * out-of-range byte or reset() clears the state.
 */
export function createMidiParser(): MidiParser {
  let status = 0;
  let pending: number[] = [];
  const clear = () => {
    status = 0;
    pending = [];
  };
  const feed = (data: unknown): MidiNoteMessage[] => {
    const out: MidiNoteMessage[] = [];
    if (data === null || typeof data !== 'object') return out;
    let bytes: number[];
    try {
      const length = (data as ArrayLike<number>).length;
      if (!Number.isInteger(length) || length < 0 || length > 4096) return out;
      bytes = Array.from(data as ArrayLike<number>);
    } catch {
      return out;
    }
    for (const raw of bytes) {
      if (!Number.isInteger(raw) || raw < 0 || raw > 255) {
        clear();
        continue;
      }
      if (raw >= 0xf8) continue;
      if (raw >= 0x80) {
        status = raw >= 0xf0 ? 0 : raw;
        pending = [];
        continue;
      }
      if (status === 0) continue;
      pending.push(raw);
      if (pending.length < dataLength(status)) continue;
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const [pitch, velocity] = pending as [number, number];
      pending = [];
      if (kind === 0x90) {
        out.push(
          velocity > 0
            ? { type: 'noteOn', channel, pitch, velocity }
            : { type: 'noteOff', channel, pitch },
        );
      } else if (kind === 0x80) {
        out.push({ type: 'noteOff', channel, pitch });
      }
    }
    return out;
  };
  return { feed, reset: clear };
}

/** Parse one self-contained packet (no state kept between calls). */
export function parseMidiMessages(data: unknown): MidiNoteMessage[] {
  return createMidiParser().feed(data);
}

/** `name` is the port's own name, possibly empty; ids are never persisted. */
export type MidiInputInfo = { id: string; name: string };

export type MidiListener = {
  /** Called with only currently connected inputs. */
  onInputsChanged: (inputs: MidiInputInfo[]) => void;
  /** A listened input went away (unplugged). */
  onDisconnect: () => void;
  onNote: (inputId: string, note: MidiNoteMessage) => void;
};

export type MidiListening = {
  stop: () => void;
  /** Drop every input's partial message (selection changed). */
  resetParsers: () => void;
};

/**
 * Listen to the inputs of `access`. Each input has its own parser. Note-offs
 * are always delivered; `accepts` only gates note-ons.
 */
export function listenForMidi(
  access: MIDIAccess,
  accepts: (input: MidiInputInfo) => boolean,
  listener: MidiListener,
): MidiListening {
  const listening = new Map<MIDIInput, { handler: (event: Event) => void; parser: MidiParser }>();

  const sync = () => {
    const connected: MIDIInput[] = [];
    access.inputs.forEach((input) => {
      if (input.state === 'connected') connected.push(input);
    });
    let lost = false;
    for (const [input, entry] of listening) {
      if (connected.includes(input)) continue;
      input.removeEventListener('midimessage', entry.handler);
      entry.parser.reset();
      listening.delete(input);
      lost = true;
    }
    if (lost) listener.onDisconnect();
    for (const input of connected) {
      if (listening.has(input)) continue;
      const parser = createMidiParser();
      const handler = (event: Event) => {
        if (input.state !== 'connected') return;
        const info = { id: input.id, name: input.name ?? '' };
        for (const note of parser.feed((event as MIDIMessageEvent).data)) {
          if (note.type === 'noteOn' && !accepts(info)) continue;
          listener.onNote(input.id, note);
        }
      };
      listening.set(input, { handler, parser });
      input.addEventListener('midimessage', handler);
    }
    listener.onInputsChanged(connected.map((input) => ({ id: input.id, name: input.name ?? '' })));
  };

  access.addEventListener('statechange', sync);
  sync();
  return {
    stop: () => {
      access.removeEventListener('statechange', sync);
      for (const [input, entry] of listening) input.removeEventListener('midimessage', entry.handler);
      listening.clear();
    },
    resetParsers: () => {
      for (const entry of listening.values()) entry.parser.reset();
    },
  };
}
