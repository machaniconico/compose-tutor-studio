// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveInputPanel } from '../src/features/input/LiveInputPanel';
import { PianoRoll } from '../src/features/pianoRoll/PianoRoll';
import { useStore } from '../src/state/store';

const audio = vi.hoisted(() => ({
  noteOn: vi.fn<(pitch: number, instrument?: unknown) => Promise<void>>(),
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
  audio.noteOn.mockImplementation(async (pitch) => {
    expect(sounding.has(pitch)).toBe(false);
    sounding.add(pitch);
  });
  audio.noteOff.mockImplementation((pitch) => {
    expect(sounding.delete(pitch)).toBe(true);
  });
  audio.allNotesOff.mockImplementation(() => sounding.clear());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
