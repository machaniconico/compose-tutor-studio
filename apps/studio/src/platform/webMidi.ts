type MidiNote =
  | { type: 'noteOn'; pitch: number; velocity: number }
  | { type: 'noteOff'; pitch: number };

type MidiAccessResult =
  | { supported: false }
  | { supported: true; access: MIDIAccess | null };

export function supportsWebMidi(browser = globalThis.navigator): boolean {
  return typeof browser?.requestMIDIAccess === 'function';
}

export async function requestWebMidi(browser = globalThis.navigator): Promise<MidiAccessResult> {
  if (!supportsWebMidi(browser)) return { supported: false };
  try {
    return { supported: true, access: await browser.requestMIDIAccess({ sysex: false }) };
  } catch {
    return { supported: true, access: null };
  }
}

/** Parse a single MIDI message on the selected channel (1–16). */
export function parseMidiMessage(data: ArrayLike<number> | null | undefined, channel: number): MidiNote | undefined {
  if (data?.length !== 3 || !Number.isInteger(channel) || channel < 1 || channel > 16) return;
  const status = data[0];
  if (status !== 0x90 + channel - 1 && status !== 0x80 + channel - 1) return;

  const pitch = data[1];
  const velocity = data[2];
  if (pitch === undefined || !Number.isInteger(pitch) || pitch < 0 || pitch > 127 ||
      velocity === undefined || !Number.isInteger(velocity) || velocity < 0 || velocity > 127) return;

  return status >= 0x90 && velocity > 0
    ? { type: 'noteOn', pitch, velocity }
    : { type: 'noteOff', pitch };
}

export function listenForMidiInput(
  access: MIDIAccess,
  channel: number,
  callbacks: {
    onInputsChanged: (inputs: MIDIInput[]) => void;
    onDisconnect: () => void;
    onNote: (deviceId: string, note: MidiNote) => void;
  },
): () => void {
  const listening = new Map<MIDIInput, (event: MIDIMessageEvent) => void>();

  function syncInputs(event?: MIDIConnectionEvent) {
    const connected = new Set<MIDIInput>();
    access.inputs.forEach((input) => {
      if (input.state === 'connected') connected.add(input);
    });

    let disconnected = event?.port?.type === 'input' && event.port.state === 'disconnected';
    for (const [input, handler] of listening) {
      if (connected.has(input)) continue;
      input.removeEventListener('midimessage', handler);
      listening.delete(input);
      disconnected = true;
    }
    if (disconnected) callbacks.onDisconnect();

    for (const input of connected) {
      if (listening.has(input)) continue;
      const handler = (message: MIDIMessageEvent) => {
        if (input.state !== 'connected') return;
        const note = parseMidiMessage(message.data, channel);
        if (note) callbacks.onNote(input.id, note);
      };
      listening.set(input, handler);
      input.addEventListener('midimessage', handler);
    }
    callbacks.onInputsChanged([...connected]);
  }

  access.addEventListener('statechange', syncInputs);
  syncInputs();
  return () => {
    access.removeEventListener('statechange', syncInputs);
    for (const [input, handler] of listening) input.removeEventListener('midimessage', handler);
  };
}
