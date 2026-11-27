import { vi } from 'vitest';

export class MockMidiInput extends EventTarget {
  readonly type = 'input';
  state: MIDIPortDeviceState = 'disconnected';

  constructor(readonly id: string, readonly name = id) {
    super();
  }

  send(data: readonly number[]) {
    this.dispatchEvent(Object.assign(new Event('midimessage'), { data: Uint8Array.from(data) }));
  }
}

export class MockMidiAccess extends EventTarget {
  readonly inputs = new Map<string, MockMidiInput>();
  readonly request = vi.fn(async () => this as unknown as MIDIAccess);

  connect(input: MockMidiInput) {
    input.state = 'connected';
    this.inputs.set(input.id, input);
    this.change(input);
  }

  disconnect(input: MockMidiInput) {
    input.state = 'disconnected';
    this.inputs.delete(input.id);
    this.change(input);
  }

  private change(input: MockMidiInput) {
    this.dispatchEvent(Object.assign(new Event('statechange'), { port: input }));
  }
}
