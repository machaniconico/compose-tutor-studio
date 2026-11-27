// UI-only state of PC-keyboard playing. Never persisted and never part of the
// project: it lives for the session (the toggle is in the track list header).

import { useSyncExternalStore } from 'react';
import { DEFAULT_KEYBOARD_OCTAVE, MAX_KEYBOARD_OCTAVE, MIN_KEYBOARD_OCTAVE } from './keyboardMap';

export type PcKeyboardModeState = Readonly<{
  playing: boolean;
  scaleLock: boolean;
  octave: number;
}>;

const INITIAL: PcKeyboardModeState = { playing: false, scaleLock: false, octave: DEFAULT_KEYBOARD_OCTAVE };

let state: PcKeyboardModeState = INITIAL;
const listeners = new Set<() => void>();

function set(next: Partial<PcKeyboardModeState>): void {
  const merged = { ...state, ...next };
  if (merged.playing === state.playing && merged.scaleLock === state.scaleLock && merged.octave === state.octave) return;
  state = merged;
  for (const listener of [...listeners]) listener();
}

export function getPcKeyboardMode(): PcKeyboardModeState {
  return state;
}

export function isPcKeyboardPlaying(): boolean {
  return state.playing;
}

export function setPcKeyboardPlaying(playing: boolean): void {
  set({ playing });
}

export function setPcKeyboardScaleLock(scaleLock: boolean): void {
  set({ scaleLock });
}

export function setPcKeyboardOctave(octave: number): void {
  if (!Number.isFinite(octave)) return;
  set({ octave: Math.min(MAX_KEYBOARD_OCTAVE, Math.max(MIN_KEYBOARD_OCTAVE, Math.trunc(octave))) });
}

/** Test seam: back to the initial state (listeners are kept). */
export function resetPcKeyboardMode(): void {
  set({ ...INITIAL });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePcKeyboardMode(): PcKeyboardModeState {
  return useSyncExternalStore(subscribe, getPcKeyboardMode, getPcKeyboardMode);
}
