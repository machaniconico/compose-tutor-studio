// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAudioEngine } from '../src/audio/engine';
import { LiveInputPanel } from '../src/features/input/LiveInputPanel';
import { PianoRoll } from '../src/features/pianoRoll/PianoRoll';
import { useStore } from '../src/state/store';
import { MockMidiAccess, MockMidiInput } from './mockWebMidi';

const audio = vi.hoisted(() => ({
  noteOn: vi.fn<(pitch: number, instrument?: unknown, velocity?: number) => Promise<void>>(),
  noteOff: vi.fn<(pitch: number) => void>(),
  allNotesOff: vi.fn<() => void>(),
}));
vi.mock('../src/audio/livePreview', () => audio);

const sounding = new Set<number>();

function press(code: string, init: KeyboardEventInit = {}, target: Window | Element = window) {
  fireEvent.keyDown(target, { code, key: code.slice(3).toLowerCase(), ...init });
}

function release(code: string, init: KeyboardEventInit = {}) {
  fireEvent.keyUp(window, { code, ...init });
}

function modeButton() {
  return screen.getByRole('button', { name: 'PC で演奏' });
}

function scaleButton() {
  return screen.getByRole('button', { name: 'スケールロック' });
}

function enable() {
  const panel = render(createElement(LiveInputPanel));
  fireEvent.click(modeButton());
  return panel;
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.getState().createNewProject('キー演奏');
  useStore.getState().setStartScreenOpen(false);
  useStore.getState().setKey('C');
  useStore.getState().setScale('major');
  sounding.clear();
  audio.noteOn.mockImplementation((pitch) => {
    expect(sounding.has(pitch)).toBe(false);
    sounding.add(pitch);
    return Promise.resolve();
  });
  audio.noteOff.mockImplementation((pitch) => {
    expect(sounding.delete(pitch)).toBe(true);
  });
  audio.allNotesOff.mockImplementation(() => sounding.clear());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('optional MIDI keyboard performance', () => {
  function installMidi(midi: MockMidiAccess) {
    vi.stubGlobal('navigator', { requestMIDIAccess: midi.request });
    vi.spyOn(getAudioEngine(), 'ensureContext').mockResolvedValue({
      context: {} as AudioContext,
      master: {} as GainNode,
    });
  }

  function midiButton() {
    return screen.getByRole('button', { name: 'MIDI 鍵盤を使う' });
  }

  async function grantMidi() {
    await act(async () => fireEvent.click(midiButton()));
  }

  it('shows the Japanese fallback and keeps the PC keyboard playable', () => {
    vi.stubGlobal('navigator', {});
    enable();
    expect(screen.getByText('この環境では MIDI 鍵盤を使えません。PC キーボードで演奏できます')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'MIDI 鍵盤を使う' })).toBeNull();
    press('KeyA');
    expect(sounding).toEqual(new Set([60]));
    release('KeyA');
    expect(sounding.size).toBe(0);
  });

  it('requests MIDI only on click, allows a retry after denial, and updates the device list', async () => {
    const midi = new MockMidiAccess();
    midi.request.mockRejectedValueOnce(new Error('denied'));
    installMidi(midi);
    render(createElement(LiveInputPanel));
    expect(midi.request).not.toHaveBeenCalled();
    await grantMidi();
    expect(screen.getByText(/MIDI 鍵盤を使えませんでした/)).toBeTruthy();
    await grantMidi();
    expect(midi.request).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/MIDI 鍵盤が見つかりません/)).toBeTruthy();

    const input = new MockMidiInput('first', 'Mini Keys');
    act(() => midi.connect(input));
    expect(screen.getByRole('list', { name: '接続中の MIDI 鍵盤' }).textContent).toBe('Mini Keys');
    input.send([0x90, 60, 100]);
    expect(sounding.size).toBe(0);
    fireEvent.click(modeButton());
    input.send([0x90, 60, 100]);
    const { project, editor } = useStore.getState();
    const instrument = project.tracks.find((track) => track.id === editor.selectedTrackId)?.instrument;
    expect(audio.noteOn).toHaveBeenCalledExactlyOnceWith(60, instrument, 100);
    input.send([0x90, 60, 0]);
    expect(audio.noteOff).toHaveBeenCalledExactlyOnceWith(60);

    act(() => midi.disconnect(input));
    expect(screen.queryByText('Mini Keys')).toBeNull();
    expect(screen.getByText(/MIDI 鍵盤が見つかりません/)).toBeTruthy();
  });

  it('ignores other channels and clears held MIDI notes when switching channels', async () => {
    const midi = new MockMidiAccess();
    const input = new MockMidiInput('first');
    midi.connect(input);
    installMidi(midi);
    enable();
    await grantMidi();
    input.send([0x91, 60, 100]);
    expect(sounding.size).toBe(0);
    input.send([0x90, 60, 100]);
    input.send([0x81, 60, 100]);
    expect(sounding).toEqual(new Set([60]));
    fireEvent.change(screen.getByRole('combobox', { name: 'MIDI チャンネル' }), { target: { value: '2' } });
    expect(sounding.size).toBe(0);
    input.send([0x90, 60, 100]);
    input.send([0x91, 62, 100]);
    expect(sounding).toEqual(new Set([62]));
    input.send([0x81, 62, 0]);
    expect(sounding.size).toBe(0);
  });

  it('deduplicates a device pitch and releases its original snapped pitch after setting changes', async () => {
    const midi = new MockMidiAccess();
    const first = new MockMidiInput('first');
    const second = new MockMidiInput('second');
    midi.connect(first);
    midi.connect(second);
    installMidi(midi);
    enable();
    await grantMidi();
    fireEvent.click(scaleButton());

    first.send([0x90, 61, 100]);
    first.send([0x90, 61, 90]);
    second.send([0x90, 61, 100]);
    press('KeyA');
    expect(audio.noteOn).toHaveBeenCalledTimes(1);
    expect(sounding).toEqual(new Set([60]));
    fireEvent.click(scaleButton());
    act(() => useStore.getState().setKey('Db'));
    first.send([0x80, 61, 0]);
    release('KeyA');
    expect(sounding).toEqual(new Set([60]));
    second.send([0x80, 61, 0]);
    expect(audio.noteOff).toHaveBeenCalledExactlyOnceWith(60);
    expect(sounding.size).toBe(0);
  });

  it('stops all MIDI notes on disconnect while retaining a pitch held on the PC keyboard', async () => {
    const midi = new MockMidiAccess();
    const first = new MockMidiInput('first');
    const second = new MockMidiInput('second');
    midi.connect(first);
    midi.connect(second);
    installMidi(midi);
    enable();
    await grantMidi();
    press('KeyA');
    first.send([0x90, 60, 100]);
    second.send([0x90, 62, 100]);
    expect(sounding).toEqual(new Set([60, 62]));
    act(() => midi.disconnect(first));
    expect(sounding).toEqual(new Set([60]));
    second.send([0x80, 62, 0]);
    release('KeyA');
    expect(sounding.size).toBe(0);
  });

  it('clears MIDI on mode off and unmount and detaches the access and input listeners', async () => {
    const midi = new MockMidiAccess();
    const input = new MockMidiInput('first');
    midi.connect(input);
    installMidi(midi);
    const { unmount } = enable();
    await grantMidi();
    const removeAccessListener = vi.spyOn(midi, 'removeEventListener');
    const removeInputListener = vi.spyOn(input, 'removeEventListener');
    input.send([0x90, 60, 100]);
    expect(sounding).toEqual(new Set([60]));
    fireEvent.click(modeButton());
    input.send([0x90, 62, 100]);
    expect(sounding.size).toBe(0);
    fireEvent.click(modeButton());
    input.send([0x90, 60, 100]);
    expect(sounding).toEqual(new Set([60]));
    unmount();
    expect(sounding.size).toBe(0);
    expect(removeAccessListener).toHaveBeenCalledExactlyOnceWith('statechange', expect.any(Function));
    expect(removeInputListener).toHaveBeenCalledExactlyOnceWith('midimessage', expect.any(Function));
    input.send([0x90, 62, 100]);
    expect(sounding.size).toBe(0);
  });

  it('does not attach MIDI listeners if access is granted after unmount', async () => {
    const midi = new MockMidiAccess();
    installMidi(midi);
    let grant!: (access: MIDIAccess) => void;
    midi.request.mockReturnValueOnce(new Promise((resolve) => { grant = resolve; }));
    const addListener = vi.spyOn(midi, 'addEventListener');
    const { unmount } = enable();
    fireEvent.click(midiButton());
    expect(midiButton()).toHaveProperty('disabled', true);
    unmount();
    await act(async () => grant(midi as unknown as MIDIAccess));
    expect(addListener).not.toHaveBeenCalled();
  });

  it('matches held pitches throughout 1,000 seeded MIDI, connection and focus sequences', async () => {
    const midi = new MockMidiAccess();
    const inputs = [new MockMidiInput('first'), new MockMidiInput('second')];
    for (const input of inputs) midi.connect(input);
    installMidi(midi);
    enable();
    await grantMidi();

    let seed = 0x245eed;
    function random(max: number) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return Math.floor(seed / 0x1_0000_0000 * max);
    }

    const pitches = [60, 61, 62, 63, 72, 74];
    const snapped = [60, 60, 62, 62, 72, 74];
    const connected = new Set(inputs);
    const held = new Map<string, number>();
    let focused = true;
    let locked = false;

    act(() => {
      for (let sequence = 0; sequence < 1_000; sequence++) {
        const length = 1 + random(8);
        for (let step = 0; step < length; step++) {
          const input = inputs[random(inputs.length)]!;
          const index = random(pitches.length);
          const pitch = pitches[index]!;
          const key = `${input.id}:${pitch}`;
          const event = random(16);
          if (event < 5) {
            input.send([0x90, pitch, 1 + random(127)]);
            if (focused && connected.has(input) && !held.has(key)) {
              held.set(key, (locked ? snapped : pitches)[index]!);
            }
          } else if (event < 8) {
            input.send([event === 7 ? 0x80 : 0x90, pitch, 0]);
            held.delete(key);
          } else if (event === 8) {
            if (connected.delete(input)) {
              midi.disconnect(input);
              held.clear();
              expect(sounding.size).toBe(0);
            }
          } else if (event === 9) {
            midi.connect(input);
            connected.add(input);
          } else if (event === 10) {
            window.dispatchEvent(new Event('blur'));
            focused = false;
            held.clear();
            expect(sounding.size).toBe(0);
          } else if (event === 11) {
            window.dispatchEvent(new Event('focus'));
            focused = true;
          } else if (event === 12) {
            useStore.getState().toggleLiveInputScaleLock();
            locked = !locked;
          } else {
            const ignored = [[0x91, pitch, 100], [pitch, 100], [random(256)]];
            input.send(ignored[event - 13]!);
          }
          expect(sounding, `sequence ${sequence}, event ${step}`).toEqual(new Set(held.values()));
        }
      }
    });
    fireEvent.blur(window);
    expect(sounding.size).toBe(0);
  });
});

describe('PC keyboard performance', () => {
  it('starts disabled, then plays KeyS with the selected instrument and releases it', () => {
    render(createElement(LiveInputPanel));
    const { project, editor } = useStore.getState();
    const instrument = project.tracks.find((track) => track.id === editor.selectedTrackId)?.instrument;
    expect(modeButton().getAttribute('aria-pressed')).toBe('false');
    press('KeyS');
    expect(audio.noteOn).not.toHaveBeenCalled();
    fireEvent.click(modeButton());
    press('KeyS', { key: '別' });
    expect(audio.noteOn).toHaveBeenCalledWith(62, instrument);
    release('KeyS', { key: 'another', ctrlKey: true });
    expect(audio.noteOff).toHaveBeenCalledWith(62);
    expect(sounding.size).toBe(0);
  });

  it('suppresses Piano Roll S/C shortcuts while playing and restores them when off', () => {
    render(createElement(PianoRoll));
    enable();
    const { scaleSnap, chordToneHighlight } = useStore.getState().editor;
    press('KeyS');
    press('KeyC');
    expect(sounding).toEqual(new Set([62]));
    expect(useStore.getState().editor).toMatchObject({ scaleSnap, chordToneHighlight });
    fireEvent.click(modeButton());
    press('KeyS');
    press('KeyC');
    expect(useStore.getState().editor).toMatchObject({
      scaleSnap: !scaleSnap,
      chordToneHighlight: !chordToneHighlight,
    });
  });

  it('defaults scale lock to off and uses the current song scale when enabled', () => {
    enable();
    expect(scaleButton().getAttribute('aria-pressed')).toBe('false');
    press('KeyW');
    expect(sounding).toEqual(new Set([61]));
    release('KeyW');
    fireEvent.click(scaleButton());
    press('KeyW');
    expect(sounding).toEqual(new Set([60]));
    release('KeyW');

    act(() => useStore.getState().setKey('Db'));
    press('KeyW');
    expect(sounding).toEqual(new Set([61]));
  });

  it('keeps an in-scale pitch when the nearest scale note is below MIDI 0', () => {
    enable();
    act(() => useStore.getState().setKey('B'));
    fireEvent.click(scaleButton());
    for (let i = 0; i < 6; i++) press('KeyZ');
    press('KeyA');
    expect(sounding).toEqual(new Set([1]));
  });

  it('does not stack repeated codes or change a held pitch when settings change', () => {
    enable();
    press('KeyW');
    press('KeyX');
    fireEvent.click(scaleButton());
    press('KeyW');
    expect(audio.noteOn).toHaveBeenCalledTimes(1);
    release('KeyW');
    expect(audio.noteOff).toHaveBeenCalledExactlyOnceWith(61);
    press('KeyW');
    expect(sounding).toEqual(new Set([72]));
  });

  it('keeps a shared pitch until all keys mapped to it are released', () => {
    enable();
    fireEvent.click(scaleButton());
    press('KeyA');
    press('KeyW');
    expect(audio.noteOn).toHaveBeenCalledTimes(1);
    release('KeyW');
    expect(sounding).toEqual(new Set([60]));
    expect(audio.noteOff).not.toHaveBeenCalled();
    release('KeyA');
    expect(audio.noteOff).toHaveBeenCalledExactlyOnceWith(60);
  });

  it.each([{ repeat: true }, { isComposing: true }, { key: 'Process' }])(
    'ignores keydown for %j but still releases a held key on such a keyup',
    (flags) => {
      enable();
      press('KeyS', flags);
      expect(sounding.size).toBe(0);
      press('KeyS');
      expect(sounding).toEqual(new Set([62]));
      // An IME switched on mid-hold can report the keyup as 'Process' / composing.
      release('KeyS', flags);
      expect(sounding.size).toBe(0);
    },
  );

  it.each([
    ['a window blur', () => fireEvent.blur(window)],
    ['switching off', () => fireEvent.click(modeButton())],
    ['unmounting', (unmount: () => void) => unmount()],
  ] as const)('stops every held pitch on %s', (_, stop) => {
    const { unmount } = enable();
    press('KeyA');
    press('KeyL');
    stop(unmount);
    expect(audio.allNotesOff).toHaveBeenCalledTimes(1);
    expect(sounding.size).toBe(0);
    release('KeyA');
    release('KeyL');
    expect(audio.noteOff).not.toHaveBeenCalled();
  });

  it('stops on a visibility change to hidden', () => {
    enable();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    press('KeyA');
    fireEvent(document, new Event('visibilitychange'));
    expect(sounding).toEqual(new Set([60]));
    hidden.mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(audio.allNotesOff).toHaveBeenCalledTimes(1);
    expect(sounding.size).toBe(0);
  });

  it.each(['input', 'textarea', 'select', 'contenteditable'])(
    'stops held notes and ignores typing inside %s',
    (tag) => {
      enable();
      const editable = tag === 'contenteditable'
        ? createElement(
            'div',
            { contentEditable: 'plaintext-only', suppressContentEditableWarning: true },
            createElement('span', { tabIndex: 0 }),
          )
        : createElement(tag);
      const { container } = render(editable);
      const target = (container.querySelector('span') ?? container.firstElementChild) as HTMLElement;
      press('KeyA');
      target.focus();
      expect(document.activeElement).toBe(target);
      expect(audio.allNotesOff).toHaveBeenCalledTimes(1);
      expect(sounding.size).toBe(0);
      press('KeyS', {}, target);
      press('KeyD');
      expect(audio.noteOn).toHaveBeenCalledTimes(1);
    },
  );

  it('matches the pitches of held codes through 1,000 seeded event sequences and a final blur', () => {
    enable();
    let seed = 0x235eed;
    function random(max: number) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return Math.floor(seed / 0x1_0000_0000 * max);
    }

    const codes = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyK', 'KeyL'];
    const rawPitches = [60, 61, 62, 63, 72, 74];
    const lockedPitches = [60, 60, 62, 62, 72, 74];
    const held = new Map<string, number>();
    let octave = 4;
    let locked = false;
    for (let sequence = 0; sequence < 1000; sequence++) {
      const length = 1 + random(10);
      for (let step = 0; step < length; step++) {
        const index = random(codes.length);
        const code = codes[index]!;
        const event = random(12);
        if (event < 5) {
          press(code);
          if (!held.has(code)) {
            const base = (locked ? lockedPitches : rawPitches)[index]!;
            held.set(code, base + (octave - 4) * 12);
          }
        } else if (event < 8) {
          release(code);
          held.delete(code);
        } else if (event === 8) {
          fireEvent.blur(window);
          held.clear();
        } else if (event === 9) {
          fireEvent.click(scaleButton());
          locked = !locked;
        } else {
          const down = event === 10;
          press(down ? 'KeyZ' : 'KeyX');
          octave = down ? Math.max(-1, octave - 1) : Math.min(8, octave + 1);
        }
        expect(sounding, `sequence ${sequence}, event ${step}`).toEqual(new Set(held.values()));
      }
    }
    fireEvent.blur(window);
    expect(sounding.size).toBe(0);
  });
});
