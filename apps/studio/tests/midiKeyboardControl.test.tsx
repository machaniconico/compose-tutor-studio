// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { holdNote, releaseHeldNote, releaseHeldNotesMatching, stopPreview } = vi.hoisted(() => ({
  holdNote: vi.fn(),
  releaseHeldNotesMatching: vi.fn(),
  releaseHeldNote: vi.fn(),
  stopPreview: vi.fn(),
}));
vi.mock('../src/audio/livePreview', () => ({ holdNote, releaseHeldNote, releaseHeldNotesMatching, stopPreview }));

import { MidiKeyboardControl } from '../src/features/tracklist/MidiKeyboardControl';
import { useStore } from '../src/state/store';

class Input extends EventTarget {
  type = 'input';
  state = 'connected';
  constructor(public id: string, public name: string) { super(); }
  send(data: number[]) {
    this.dispatchEvent(Object.assign(new Event('midimessage'), { data: Uint8Array.from(data) }));
  }
}
class Access extends EventTarget {
  inputs = new Map<string, Input>();
  change() { this.dispatchEvent(new Event('statechange')); }
}

const nav = navigator as unknown as { requestMIDIAccess?: unknown };

beforeEach(() => {
  holdNote.mockClear();
  releaseHeldNote.mockClear();
  releaseHeldNotesMatching.mockClear();
  stopPreview.mockClear();
  localStorage.clear();
  stopPreview.mockClear();
  const s = useStore.getState();
  s.selectTrack(s.project.tracks.find((t) => t.type === 'instrument')!.id);
});
afterEach(() => {
  cleanup();
  delete nav.requestMIDIAccess;
});

async function open() {
  render(<MidiKeyboardControl />);
  fireEvent.click(screen.getByRole('button', { name: 'MIDI' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'MIDI キーボードを使う' }));
  });
}

it('does not request access on load and explains when unsupported', async () => {
  render(<MidiKeyboardControl />);
  fireEvent.click(screen.getByRole('button', { name: 'MIDI' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'MIDI キーボードを使う' }));
  });
  expect(screen.getByRole('status').textContent).toContain('Windows・Linux 版で使えます');
});

it('explains permission denial and a missing device', async () => {
  nav.requestMIDIAccess = vi.fn(async () => { throw new Error('denied'); });
  await open();
  expect(screen.getByRole('status').textContent).toContain('許可されませんでした');
  cleanup();
  const access = new Access();
  nav.requestMIDIAccess = vi.fn(async () => access);
  await open();
  expect(screen.getByRole('status').textContent).toContain('見つかりません');
  expect(nav.requestMIDIAccess).toHaveBeenCalledWith({ sysex: false });
});

it('plays note-on with velocity, handles hot-plug, and releases on disconnect and unmount', async () => {
  const access = new Access();
  nav.requestMIDIAccess = vi.fn(async () => access);
  await open();
  const kb = new Input('a', 'Keys');
  act(() => { access.inputs.set('a', kb); access.change(); });
  expect(screen.getByRole('option', { name: 'Keys' })).toBeTruthy();
  act(() => kb.send([0x90, 64, 100]));
  expect(holdNote).toHaveBeenCalledWith('midi:a:0:64', expect.anything(), 64, 100);
  act(() => kb.send([0x90, 64, 0]));
  expect(releaseHeldNote).toHaveBeenCalledWith('midi:a:0:64');
  act(() => kb.send([0x81, 66, 0]));
  expect(releaseHeldNote).toHaveBeenCalledWith('midi:a:1:66');
  expect(holdNote).toHaveBeenCalledTimes(1);
  act(() => { kb.state = 'disconnected'; access.change(); });
  expect(releaseHeldNotesMatching).toHaveBeenCalledWith('midi:');
  expect(stopPreview).not.toHaveBeenCalled();
  expect(screen.queryByRole('option', { name: 'Keys' })).toBeNull();
  act(() => kb.send([0x90, 65, 100]));
  expect(holdNote).toHaveBeenCalledTimes(1);
  releaseHeldNotesMatching.mockClear();
  cleanup();
  expect(releaseHeldNotesMatching).toHaveBeenCalledWith('midi:');
  expect(stopPreview).not.toHaveBeenCalled();
});

it('a permission grant that resolves after unmount installs nothing', async () => {
  const access = new Access();
  const add = vi.spyOn(access, 'addEventListener');
  let grant!: (a: Access) => void;
  nav.requestMIDIAccess = vi.fn(() => new Promise<Access>((r) => { grant = r; }));
  render(<MidiKeyboardControl />);
  fireEvent.click(screen.getByRole('button', { name: 'MIDI' }));
  fireEvent.click(screen.getByRole('button', { name: 'MIDI キーボードを使う' }));
  cleanup();
  releaseHeldNotesMatching.mockClear();
  await act(async () => { grant(access); });
  expect(add).not.toHaveBeenCalled();
  expect(releaseHeldNotesMatching).not.toHaveBeenCalled();
});

it('note-off is processed for a held note even when the input filter excludes that device', async () => {
  const access = new Access();
  nav.requestMIDIAccess = vi.fn(async () => access);
  localStorage.setItem('cts.midiInputName', 'Keys');
  await open();
  const other = new Input('o', 'Other');
  act(() => { access.inputs.set('o', other); access.change(); });
  act(() => other.send([0x90, 60, 100]));
  expect(holdNote).not.toHaveBeenCalled();
  act(() => other.send([0x80, 60, 0]));
  expect(releaseHeldNote).toHaveBeenCalledWith('midi:o:0:60');
  const kb = new Input('k', 'Keys');
  act(() => { access.inputs.set('k', kb); access.change(); });
  act(() => kb.send([0x90, 61, 90]));
  expect(holdNote).toHaveBeenCalledTimes(1);
});

it('persists only a non-empty device name, never a port id', async () => {
  const access = new Access();
  nav.requestMIDIAccess = vi.fn(async () => access);
  await open();
  const unnamed = new Input('port-1', '');
  const named = new Input('port-2', 'Keys');
  act(() => { access.inputs.set('a', unnamed); access.inputs.set('b', named); access.change(); });
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  const options = Array.from(select.options);
  fireEvent.change(select, { target: { value: options[1]!.value } });
  expect(localStorage.getItem('cts.midiInputName')).not.toBe('port-1');
  expect(localStorage.getItem('cts.midiInputName') ?? '').not.toContain('port-1');
  act(() => unnamed.send([0x90, 60, 100]));
  expect(holdNote).toHaveBeenCalledTimes(1);
  fireEvent.change(select, { target: { value: options[2]!.value } });
  expect(localStorage.getItem('cts.midiInputName')).toBe('Keys');
});
