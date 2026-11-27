// Beginner sound macros (US-020): brightness / release / width / attack, each
// 0..1, mapped onto a SynthPreset by one pure function. SynthVoiceManager calls
// it, so live playback, the WAV render and the live preview share the mapping.

import type { InstrumentMacros } from '@cts/project-model';
import type { SynthPreset } from './presets';

/** Lowest / highest cutoff the brightness macro can reach, Hz (below 22.05kHz Nyquist at 44.1kHz). */
export const MACRO_CUTOFF_MIN_HZ = 40;
export const MACRO_CUTOFF_MAX_HZ = 16000;
/** Envelope time limits for the release / attack macros, seconds. */
export const MACRO_RELEASE_MIN_S = 0.01;
export const MACRO_RELEASE_MAX_S = 4;
export const MACRO_ATTACK_MIN_S = 0.002;
export const MACRO_ATTACK_MAX_S = 2;
/** Each of brightness / release / attack scales the preset value by 1/4..4 (x1 at 0.5). */
const MACRO_SCALE_OCTAVES = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A macro value as a usable 0..1 number (non-finite -> 0.5, the neutral point). */
function unit(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0.5;
}

/** Preset value scaled by the macro around its neutral 0.5: x(1/4)..x4. */
function scaled(base: number, macro: number): number {
  return base * Math.pow(2, (unit(macro) - 0.5) * 2 * MACRO_SCALE_OCTAVES);
}

/**
 * Apply the beginner macros to a preset (pure). Without macros the same
 * preset object is returned. brightness scales the cutoff, release / attack
 * scale those envelope times (0.5 keeps the preset value), width sets the
 * stereo spread 0..1. Outputs are clamped to ranges the synth can play.
 */
export function applyMacros(preset: SynthPreset, macros: InstrumentMacros | undefined): SynthPreset {
  if (!macros) return preset;
  const { env } = preset;
  return {
    ...preset,
    cutoffHz: clamp(scaled(preset.cutoffHz, macros.brightness), MACRO_CUTOFF_MIN_HZ, MACRO_CUTOFF_MAX_HZ),
    env: {
      ...env,
      attack: clamp(scaled(env.attack, macros.attack), MACRO_ATTACK_MIN_S, MACRO_ATTACK_MAX_S),
      release: clamp(scaled(env.release, macros.release), MACRO_RELEASE_MIN_S, MACRO_RELEASE_MAX_S),
    },
    spread: Number.isFinite(macros.width) ? clamp(macros.width, 0, 1) : 0,
  };
}

/** Macros a track starts from when the user first opens the sliders: the preset as is. */
export const NEUTRAL_MACROS: InstrumentMacros = { brightness: 0.5, release: 0.5, width: 0, attack: 0.5 };
