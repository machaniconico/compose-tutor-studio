const NOTE_OFFSETS: ReadonlyMap<string, number> = new Map([
  ['KeyA', 0], ['KeyW', 1], ['KeyS', 2], ['KeyE', 3], ['KeyD', 4],
  ['KeyF', 5], ['KeyT', 6], ['KeyG', 7], ['KeyY', 8], ['KeyH', 9],
  ['KeyU', 10], ['KeyJ', 11], ['KeyK', 12], ['KeyL', 14],
]);

const SEMITONES_PER_OCTAVE = 12;
const pitches = [...NOTE_OFFSETS.values()];
export const DEFAULT_KEYBOARD_OCTAVE = 4;
export const MIN_KEYBOARD_OCTAVE = Math.ceil(-Math.min(...pitches) / SEMITONES_PER_OCTAVE) - 1;
export const MAX_KEYBOARD_OCTAVE = Math.floor((127 - Math.max(...pitches)) / SEMITONES_PER_OCTAVE) - 1;

type KeyboardInputEvent = Pick<KeyboardEvent, 'code' | 'key' | 'repeat' | 'isComposing'> &
  Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey'>>;

export type KeyboardInput =
  | { type: 'note'; pitch: number }
  | { type: 'octave'; octave: number };

export function ignoreKeyboardEvent(event: Pick<KeyboardInputEvent, 'key' | 'repeat' | 'isComposing'>): boolean {
  return event.repeat || event.isComposing || event.key === 'Process';
}

export function isPlayingCode(code: string | undefined): boolean {
  return code !== undefined && (NOTE_OFFSETS.has(code) || code === 'KeyZ' || code === 'KeyX');
}

export function keyboardInput(event: KeyboardInputEvent, octave = DEFAULT_KEYBOARD_OCTAVE): KeyboardInput | null {
  if (ignoreKeyboardEvent(event) || event.altKey || event.ctrlKey || event.metaKey) return null;

  const current = Math.min(MAX_KEYBOARD_OCTAVE, Math.max(MIN_KEYBOARD_OCTAVE, octave));
  if (event.code === 'KeyZ' || event.code === 'KeyX') {
    const next = current + (event.code === 'KeyZ' ? -1 : 1);
    if (next < MIN_KEYBOARD_OCTAVE || next > MAX_KEYBOARD_OCTAVE) return null;
    return { type: 'octave', octave: next };
  }

  const offset = NOTE_OFFSETS.get(event.code);
  return offset === undefined ? null : { type: 'note', pitch: (current + 1) * SEMITONES_PER_OCTAVE + offset };
}
