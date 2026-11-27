import type { SynthPreset } from './presets';

export const NEUTRAL_MACROS = {
  macroBrightness: 0.5,
  macroRelease: 0.5,
  macroWidth: 0,
  macroAttack: 0.5,
} as const;

export type InstrumentMacroKey = keyof typeof NEUTRAL_MACROS;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Read a finite, clamped macro without coercing persisted values or modifying params. */
export function readInstrumentMacro(params: unknown, key: InstrumentMacroKey): number {
  const value = params !== null && typeof params === 'object' && Object.hasOwn(params, key)
    ? (params as Record<string, unknown>)[key]
    : undefined;
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : NEUTRAL_MACROS[key];
}

function scale(base: number, value: number, min: number, max: number): number {
  return value === 0.5 ? base : clamp(base * 2 ** ((value - 0.5) * 4), min, max);
}

/** Adjust the existing oscillator layers, lowpass and envelope without adding nodes. */
export function applyInstrumentMacros(preset: SynthPreset, params: unknown): SynthPreset {
  const brightness = readInstrumentMacro(params, 'macroBrightness');
  const release = readInstrumentMacro(params, 'macroRelease');
  const width = readInstrumentMacro(params, 'macroWidth');
  const attack = readInstrumentMacro(params, 'macroAttack');
  if (brightness === 0.5 && release === 0.5 && width === 0 && attack === 0.5) return preset;

  return {
    ...preset,
    oscillators: width === 0 ? preset.oscillators : preset.oscillators.map((layer) => {
      if (layer.role !== 'unison') return layer;
      const direction = layer.detuneCents < 0 ? -1 : 1;
      const detuneCents = clamp(layer.detuneCents + direction * width * 24, -100, 100);
      return { ...layer, detuneCents };
    }),
    filter: {
      ...preset.filter,
      cutoffHz: scale(preset.filter.cutoffHz, brightness, 40, 16_000),
    },
    env: {
      ...preset.env,
      attack: scale(preset.env.attack, attack, 0.002, 2),
      release: scale(preset.env.release, release, 0.01, 4),
    },
  };
}
