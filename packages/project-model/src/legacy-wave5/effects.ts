import type { EffectConfig } from '../types';
import { clamp, type LegacyEffect } from './input';
import type { Report } from './report';

type Parameter = {
  aliases: readonly string[];
  fallback: number;
  min: number;
  max: number;
  mainMin?: number;
  mainMax?: number;
  map?: (value: number) => number;
};

const parameter = (
  aliases: readonly string[], fallback: number, min: number, max: number,
): Parameter => ({ aliases, fallback, min, max });

// Values in the input table are physical units as read by Wave5.
const EFFECTS = {
  filter: {
    cutoff: { ...parameter(['cutoffHz', 'cutoff'], 1800, 80, 18000), mainMax: 16000,
      map: (hz: number) => Math.log(hz / 80) / Math.log(200) },
    resonance: { ...parameter(['resonance', 'q', 'Q'], 0.7, 0.0001, 30), mainMin: 0.2, mainMax: 18 },
  },
  delay: {
    delayTime: { ...parameter(['timeSeconds', 'time', 'delayTime'], 0.25, 0, 1.5), mainMin: 0.02, mainMax: 0.75 },
    feedback: parameter(['feedback'], 0.28, 0, 0.85),
    mix: parameter(['mix'], 0.32, 0, 1),
  },
  reverb: {
    wet: parameter(['mix'], 0.25, 0, 1),
    decay: { ...parameter([], 1.4, 1.4, 1.4), map: () => 0.43859649122807015 },
  },
  eq: {
    lowGain: parameter(['lowGainDb'], 0, -12, 12),
    midGain: parameter(['midGainDb'], 0, -12, 12),
    highGain: parameter(['highGainDb'], 0, -12, 12),
  },
  compressor: {
    threshold: { ...parameter(['thresholdDb'], -24, -60, 0), mainMin: -48, mainMax: -6 },
    ratio: { ...parameter(['ratio'], 3, 1, 20), mainMax: 12 },
    attack: { ...parameter(['attackSeconds'], 0.01, 0, 1), mainMin: 0.003, mainMax: 0.08 },
    release: { ...parameter(['releaseSeconds'], 0.2, 0.01, 1), mainMin: 0.05, mainMax: 0.8 },
  },
} satisfies Record<EffectConfig['type'], Record<string, Parameter>>;

const SIGNAL_ORDER: readonly EffectConfig['type'][] = ['eq', 'compressor', 'filter', 'delay', 'reverb'];

function readNumber(params: LegacyEffect['params'], spec: Parameter): number {
  for (const key of spec.aliases) {
    if (!params || !Object.hasOwn(params, key)) continue;
    const value = params[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return spec.fallback;
}

export function convertEffects(
  inputs: readonly LegacyEffect[], trackId: string, claimId: (id: string) => string, report: Report,
): EffectConfig[] {
  const effects: EffectConfig[] = [];
  for (const input of inputs) {
    const effectId = claimId(input.id);
    if (!Object.hasOwn(EFFECTS, input.type)) {
      report('effect-dropped', { trackId, effectId });
      continue;
    }
    const type = input.type as EffectConfig['type'];
    let adjusted = false;
    const params = Object.fromEntries(Object.entries<Parameter>(EFFECTS[type]).map(([key, spec]) => {
      const raw = readNumber(input.params, spec);
      const wave5 = clamp(raw, spec.min, spec.max);
      const folded = type === 'delay' && key === 'delayTime' && wave5 > 0.75 ? wave5 / 2 : wave5;
      const min = spec.mainMin ?? spec.min;
      const max = spec.mainMax ?? spec.max;
      const limited = clamp(folded, min, max);
      adjusted ||= limited !== wave5;
      const normalized = spec.map ? spec.map(limited) : (limited - min) / (max - min);
      return [key, clamp(normalized, 0, 1)];
    }));
    if (adjusted) report('effect-adjusted', { trackId, effectId });
    effects.push({ id: effectId, type, enabled: input.enabled, params });
  }
  if (effects.some(({ enabled, type }) => enabled && (type === 'eq' || type === 'compressor'))) {
    effects.sort((a, b) => SIGNAL_ORDER.indexOf(a.type) - SIGNAL_ORDER.indexOf(b.type));
  }
  return effects;
}
