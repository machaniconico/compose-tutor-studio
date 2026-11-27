import { describe, expect, it } from 'vitest';
import {
  keyboardInput,
  MAX_KEYBOARD_OCTAVE,
  MIN_KEYBOARD_OCTAVE,
} from '../src/features/input/keyboardMap';

function key(code: string, overrides: Partial<KeyboardEvent> = {}) {
  return { code, key: '', repeat: false, isComposing: false, ...overrides };
}

const keys = 'AWSEDFTGYHUJKL';
const pitches = [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 74];

describe('PC keyboard map', () => {
  it('maps the white and black keys by physical code at octave 4', () => {
    Array.from(keys).forEach((letter, index) => {
      expect(keyboardInput(key(`Key${letter}`, { key: '別' }))).toEqual({
        type: 'note',
        pitch: pitches[index],
      });
    });
    expect(keyboardInput(key('KeyC', { key: 'a' }))).toBeNull();
  });

  it('shifts Z down and X up by one octave', () => {
    const down = keyboardInput(key('KeyZ'));
    const up = keyboardInput(key('KeyX'));
    expect(down).toEqual({ type: 'octave', octave: 3 });
    expect(up).toEqual({ type: 'octave', octave: 5 });
    if (down?.type !== 'octave' || up?.type !== 'octave') throw new Error('Expected octave changes');
    expect(keyboardInput(key('KeyA'), down.octave)).toEqual({ type: 'note', pitch: 48 });
    expect(keyboardInput(key('KeyA'), up.octave)).toEqual({ type: 'note', pitch: 72 });
  });

  it('stops shifting at the last octave where every mapped pitch fits', () => {
    expect(MIN_KEYBOARD_OCTAVE).toBe(-1);
    expect(MAX_KEYBOARD_OCTAVE).toBe(8);
    expect(keyboardInput(key('KeyZ'), MIN_KEYBOARD_OCTAVE)).toBeNull();
    expect(keyboardInput(key('KeyX'), MAX_KEYBOARD_OCTAVE)).toBeNull();
    for (const letter of keys) {
      for (const octave of [MIN_KEYBOARD_OCTAVE, MAX_KEYBOARD_OCTAVE]) {
        const input = keyboardInput(key(`Key${letter}`), octave);
        if (input?.type !== 'note') throw new Error('Expected a note');
        expect(input.pitch).toBeGreaterThanOrEqual(0);
        expect(input.pitch).toBeLessThanOrEqual(127);
      }
    }
  });

  it.each([{ repeat: true }, { isComposing: true }, { key: 'Process' }])(
    'ignores playing and octave keys for %j',
    (flags) => {
      expect(keyboardInput(key('KeyA', flags))).toBeNull();
      expect(keyboardInput(key('KeyX', flags))).toBeNull();
    },
  );
});
