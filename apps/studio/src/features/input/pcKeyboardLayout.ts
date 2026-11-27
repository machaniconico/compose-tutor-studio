// What each PC key plays: chromatic by default, or only the project's scale
// tones when the scale lock is on. Pure; nothing here touches audio or the project.
//
// Scale lock counts SCALE DEGREES (consecutive scale tones upward from the
// tonic), not semitones: key number i plays degree i, wrapping every octave.

import type { MusicalKey, ScaleName } from '@cts/project-model';
import { buildScale, midiToNoteName } from '@cts/theory-engine';
import { keyboardInput, PLAYING_CODES } from './keyboardMap';

export type PlayingKeyAssignment = Readonly<{
  code: string;
  /** The letter printed on the key, upper case. */
  keyLabel: string;
  /** MIDI pitch, or null when it would be outside 0-127 (the key stays silent). */
  pitch: number | null;
  /** Note name with octave, or '—' when silent. */
  noteName: string;
}>;

export type PlayingLayoutOptions = Readonly<{
  octave: number;
  scaleLock: boolean;
  key: MusicalKey;
  scale: ScaleName;
}>;

const SEMITONES_PER_OCTAVE = 12;

function validPitch(pitch: number): number | null {
  return Number.isInteger(pitch) && pitch >= 0 && pitch <= 127 ? pitch : null;
}

const ACCIDENTAL_SHIFT: Readonly<Record<string, number>> = { '': 0, '#': 1, x: 2, b: -1, bb: -2 };

/** Octave of a spelled note: Cb belongs to the next octave and B# to the previous one. */
function spelledOctave(name: string, pitch: number): number {
  const shift = Object.hasOwn(ACCIDENTAL_SHIFT, name.slice(1)) ? (ACCIDENTAL_SHIFT[name.slice(1)] as number) : 0;
  return Math.floor((pitch - shift) / SEMITONES_PER_OCTAVE) - 1;
}

/** Every playable key with its pitch under the given octave / lock / project scale. */
export function buildPlayingLayout(options: PlayingLayoutOptions): PlayingKeyAssignment[] {
  const { octave, scaleLock, key, scale } = options;
  let lockedPitchAt: ((index: number) => { pitch: number; name: string }) | null = null;
  if (scaleLock) {
    try {
      const built = buildScale(key, scale);
      const count = built.pitchClasses.length;
      const rootPc = built.pitchClasses[0] ?? 0;
      // The chromatic octave start (the lowest key), so Z/X move the locked keys by octaves too.
      const first = keyboardInput({ code: PLAYING_CODES[0] ?? '', key: '', repeat: false, isComposing: false }, octave);
      const base = first?.type === 'note' ? first.pitch : null;
      if (count > 0 && base !== null) {
        lockedPitchAt = (index) => {
          const pc = built.pitchClasses[index % count] ?? rootPc;
          const pitch = base + rootPc + Math.floor(index / count) * SEMITONES_PER_OCTAVE
            + ((pc - rootPc + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE);
          return { pitch, name: built.notes[index % count] ?? '' };
        };
      }
    } catch {
      lockedPitchAt = null;
    }
  }
  return PLAYING_CODES.map((code, index) => {
    const keyLabel = code.replace(/^Key/, '');
    if (lockedPitchAt) {
      const { pitch, name } = lockedPitchAt(index);
      const valid = validPitch(pitch);
      const octaveNumber = valid === null ? '' : String(spelledOctave(name, valid));
      return { code, keyLabel, pitch: valid, noteName: valid === null ? '—' : `${name}${octaveNumber}` };
    }
    const input = keyboardInput({ code, key: '', repeat: false, isComposing: false }, octave);
    const pitch = input?.type === 'note' ? validPitch(input.pitch) : null;
    return { code, keyLabel, pitch, noteName: pitch === null ? '—' : midiToNoteName(pitch) };
  });
}
