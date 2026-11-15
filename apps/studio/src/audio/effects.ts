import type { EffectConfig, EffectType } from '@cts/project-model';

export type SupportedEffectType = Extract<
  EffectType,
  'eq' | 'compressor' | 'filter' | 'delay' | 'reverb'
>;

/**
 * Signal order once EQ or the compressor is on: eq -> compressor -> filter ->
 * delay -> reverb. Without them, older projects keep their saved list order.
 */
const SUPPORTED_EFFECTS: readonly SupportedEffectType[] = [
  'eq',
  'compressor',
  'filter',
  'delay',
  'reverb',
];

export const DEFAULT_EFFECT_PARAMS: Record<SupportedEffectType, Record<string, number>> = {
  eq: {
    lowGainDb: 0,
    midGainDb: 0,
    highGainDb: 0,
  },
  compressor: {
    thresholdDb: -24,
    ratio: 3,
    attackSeconds: 0.01,
    releaseSeconds: 0.2,
  },
  filter: {
    cutoffHz: 1800,
    resonance: 0.7,
  },
  delay: {
    timeSeconds: 0.25,
    feedback: 0.28,
    mix: 0.32,
  },
  reverb: {
    mix: 0.25,
  },
};

export type EqEffectSettings = {
  lowGainDb: number;
  midGainDb: number;
  highGainDb: number;
};

export type CompressorEffectSettings = {
  thresholdDb: number;
  ratio: number;
  attackSeconds: number;
  releaseSeconds: number;
};

export type DelayDivision = '1/4' | '1/8' | '1/8d';

const DELAY_DIVISION_BEATS: Record<DelayDivision, number> = {
  '1/4': 1,
  '1/8': 0.5,
  '1/8d': 0.75,
};

/**
 * Upper clamp for a saved delay time. Kept at the pre-tempo-sync value so
 * projects saved with an over-limit value (e.g. `delayTime: 4`) still resolve to
 * exactly the same 1.5 s they played at before. Tempo-synced values that would
 * exceed it (a quarter note below 40 BPM) are clamped by the mixer.
 */
export const MAX_DELAY_SECONDS = 1.5;

/** Delay time in seconds that lines up with the tempo for a note division. */
export function delayTimeSeconds(bpm: number, division: DelayDivision): number {
  return (60 / bpm) * DELAY_DIVISION_BEATS[division];
}

export type FilterEffectSettings = {
  cutoffHz: number;
  resonance: number;
};

export type DelayEffectSettings = {
  timeSeconds: number;
  feedback: number;
  mix: number;
};

export type ReverbEffectSettings = {
  mix: number;
};

type EffectInstance = {
  readonly type: SupportedEffectType;
  readonly input: AudioNode;
  readonly output: AudioNode;
  apply(effect: EffectConfig, when: number): void;
  dispose(): void;
};

export type TrackEffectChain = {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly effectTypes: readonly SupportedEffectType[];
  readonly signature: string;
  apply(effects: readonly EffectConfig[] | undefined, when: number): void;
  dispose(): void;
};

const reverbImpulseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
const reverbImpulseDataCache = new Map<string, readonly Float32Array[]>();

export function isSupportedEffectType(type: EffectType): type is SupportedEffectType {
  return SUPPORTED_EFFECTS.includes(type as SupportedEffectType);
}

export function createDefaultEffectConfig(type: SupportedEffectType): EffectConfig {
  return {
    id: `fx-${type}`,
    type,
    enabled: true,
    params: { ...DEFAULT_EFFECT_PARAMS[type] },
  };
}

export function findEffect(
  effects: readonly EffectConfig[] | undefined,
  type: SupportedEffectType,
): EffectConfig | undefined {
  return (effects ?? []).find((effect) => effect.type === type);
}

export function effectParam(
  effect: EffectConfig | undefined,
  key: string,
  fallback: number,
): number {
  const value = effect?.params?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function upsertEffect(
  effects: readonly EffectConfig[] | undefined,
  type: SupportedEffectType,
  update: (effect: EffectConfig) => EffectConfig,
): EffectConfig[] {
  const list = [...(effects ?? [])];
  const index = list.findIndex((effect) => effect.type === type);
  const current = index >= 0 ? (list[index] as EffectConfig) : createDefaultEffectConfig(type);
  const next = update({
    ...current,
    params: { ...(current.params ?? {}) },
  });

  if (index >= 0) {
    list[index] = next;
  } else {
    list.push(next);
  }
  return list;
}

export function enabledSupportedEffects(
  effects: readonly EffectConfig[] | undefined,
): EffectConfig[] {
  const enabled = (effects ?? []).filter(
    (effect) => effect.enabled && isSupportedEffectType(effect.type),
  );
  if (!enabled.some((effect) => effect.type === 'eq' || effect.type === 'compressor')) {
    return enabled;
  }
  return enabled.sort(
    (a, b) =>
      SUPPORTED_EFFECTS.indexOf(a.type as SupportedEffectType) -
      SUPPORTED_EFFECTS.indexOf(b.type as SupportedEffectType),
  );
}

export function effectSignature(effects: readonly EffectConfig[] | undefined): string {
  return enabledSupportedEffects(effects)
    .map((effect) => `${effect.id}:${effect.type}`)
    .join('|');
}

export function eqSettings(effect: EffectConfig): EqEffectSettings {
  return {
    lowGainDb: readNumber(effect, ['lowGainDb'], 0, -12, 12),
    midGainDb: readNumber(effect, ['midGainDb'], 0, -12, 12),
    highGainDb: readNumber(effect, ['highGainDb'], 0, -12, 12),
  };
}

export function compressorSettings(effect: EffectConfig): CompressorEffectSettings {
  return {
    thresholdDb: readNumber(effect, ['thresholdDb'], -24, -60, 0),
    ratio: readNumber(effect, ['ratio'], 3, 1, 20),
    attackSeconds: readNumber(effect, ['attackSeconds'], 0.01, 0, 1),
    releaseSeconds: readNumber(effect, ['releaseSeconds'], 0.2, 0.01, 1),
  };
}

export function filterSettings(effect: EffectConfig): FilterEffectSettings {
  return {
    cutoffHz: readNumber(effect, ['cutoffHz', 'cutoff'], 1800, 80, 18000),
    resonance: readNumber(effect, ['resonance', 'q', 'Q'], 0.7, 0.0001, 30),
  };
}

export function delaySettings(effect: EffectConfig): DelayEffectSettings {
  return {
    timeSeconds: readNumber(effect, ['timeSeconds', 'time', 'delayTime'], 0.25, 0, MAX_DELAY_SECONDS),
    feedback: readNumber(effect, ['feedback'], 0.28, 0, 0.85),
    mix: readNumber(effect, ['mix'], 0.32, 0, 1),
  };
}

export function reverbSettings(effect: EffectConfig): ReverbEffectSettings {
  return {
    mix: readNumber(effect, ['mix'], 0.25, 0, 1),
  };
}

export function buildTrackEffectChain(
  ctx: BaseAudioContext,
  input: AudioNode,
  output: AudioNode,
  effects: readonly EffectConfig[] | undefined,
  when: number,
): TrackEffectChain {
  const enabled = enabledSupportedEffects(effects);
  const instances: EffectInstance[] = [];
  let cursor = input;

  for (const effect of enabled) {
    const instance = createEffectInstance(ctx, effect, when);
    cursor.connect(instance.input);
    cursor = instance.output;
    instances.push(instance);
  }

  cursor.connect(output);

  return {
    input,
    output,
    effectTypes: instances.map((instance) => instance.type),
    signature: effectSignature(effects),
    apply(nextEffects, nextWhen) {
      const active = enabledSupportedEffects(nextEffects);
      for (let index = 0; index < instances.length; index += 1) {
        const instance = instances[index];
        const effect = active[index];
        if (instance && effect && instance.type === effect.type) {
          instance.apply(effect, nextWhen);
        }
      }
    },
    dispose() {
      for (const instance of instances) {
        instance.dispose();
      }
    },
  };
}

export function getCachedReverbImpulse(ctx: BaseAudioContext): AudioBuffer {
  const cached = reverbImpulseCache.get(ctx);
  if (cached) return cached;

  const seconds = 1.4;
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const key = `${ctx.sampleRate}:${length}`;
  let data = reverbImpulseDataCache.get(key);
  if (!data) {
    data = createImpulseData(length, ctx.sampleRate);
    reverbImpulseDataCache.set(key, data);
  }

  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const source = data[channel] ?? data[0];
    if (!source) continue;
    const target = buffer.getChannelData(channel);
    target.set(source);
  }
  reverbImpulseCache.set(ctx, buffer);
  return buffer;
}

function createEffectInstance(
  ctx: BaseAudioContext,
  effect: EffectConfig,
  when: number,
): EffectInstance {
  if (effect.type === 'eq') return createEqEffect(ctx, effect, when);
  if (effect.type === 'compressor') return createCompressorEffect(ctx, effect, when);
  if (effect.type === 'filter') return createFilterEffect(ctx, effect, when);
  if (effect.type === 'delay') return createDelayEffect(ctx, effect, when);
  return createReverbEffect(ctx, effect, when);
}

function createEqEffect(
  ctx: BaseAudioContext,
  effect: EffectConfig,
  when: number,
): EffectInstance {
  const low = ctx.createBiquadFilter();
  const mid = ctx.createBiquadFilter();
  const high = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 200;
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 1;
  high.type = 'highshelf';
  high.frequency.value = 4000;
  low.connect(mid);
  mid.connect(high);

  const instance: EffectInstance = {
    type: 'eq',
    input: low,
    output: high,
    apply(nextEffect, nextWhen) {
      const settings = eqSettings(nextEffect);
      setParam(low.gain, settings.lowGainDb, nextWhen);
      setParam(mid.gain, settings.midGainDb, nextWhen);
      setParam(high.gain, settings.highGainDb, nextWhen);
    },
    dispose() {
      disconnect(low);
      disconnect(mid);
      disconnect(high);
    },
  };
  instance.apply(effect, when);
  return instance;
}

function createCompressorEffect(
  ctx: BaseAudioContext,
  effect: EffectConfig,
  when: number,
): EffectInstance {
  const compressor = ctx.createDynamicsCompressor();
  compressor.knee.value = 6;

  const instance: EffectInstance = {
    type: 'compressor',
    input: compressor,
    output: compressor,
    apply(nextEffect, nextWhen) {
      const settings = compressorSettings(nextEffect);
      setParam(compressor.threshold, settings.thresholdDb, nextWhen);
      setParam(compressor.ratio, settings.ratio, nextWhen);
      setParam(compressor.attack, settings.attackSeconds, nextWhen);
      setParam(compressor.release, settings.releaseSeconds, nextWhen);
    },
    dispose() {
      disconnect(compressor);
    },
  };
  instance.apply(effect, when);
  return instance;
}

function createFilterEffect(
  ctx: BaseAudioContext,
  effect: EffectConfig,
  when: number,
): EffectInstance {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';

  const instance: EffectInstance = {
    type: 'filter',
    input: filter,
    output: filter,
    apply(nextEffect, nextWhen) {
      const settings = filterSettings(nextEffect);
      setParam(filter.frequency, settings.cutoffHz, nextWhen);
      setParam(filter.Q, settings.resonance, nextWhen);
    },
    dispose() {
      disconnect(filter);
    },
  };
  instance.apply(effect, when);
  return instance;
}

function createDelayEffect(
  ctx: BaseAudioContext,
  effect: EffectConfig,
  when: number,
): EffectInstance {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const delay = ctx.createDelay(MAX_DELAY_SECONDS);
  const feedback = ctx.createGain();
  const wet = ctx.createGain();
  const output = ctx.createGain();

  input.connect(dry);
  dry.connect(output);
  input.connect(delay);
  delay.connect(wet);
  wet.connect(output);
  delay.connect(feedback);
  feedback.connect(delay);

  const instance: EffectInstance = {
    type: 'delay',
    input,
    output,
    apply(nextEffect, nextWhen) {
      const settings = delaySettings(nextEffect);
      setParam(delay.delayTime, settings.timeSeconds, nextWhen);
      setParam(feedback.gain, settings.feedback, nextWhen);
      setWetDry(wet.gain, dry.gain, settings.mix, nextWhen);
    },
    dispose() {
      disconnect(input);
      disconnect(dry);
      disconnect(delay);
      disconnect(feedback);
      disconnect(wet);
      disconnect(output);
    },
  };
  instance.apply(effect, when);
  return instance;
}

function createReverbEffect(
  ctx: BaseAudioContext,
  effect: EffectConfig,
  when: number,
): EffectInstance {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const convolver = ctx.createConvolver();
  const wet = ctx.createGain();
  const output = ctx.createGain();

  convolver.buffer = getCachedReverbImpulse(ctx);
  input.connect(dry);
  dry.connect(output);
  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(output);

  const instance: EffectInstance = {
    type: 'reverb',
    input,
    output,
    apply(nextEffect, nextWhen) {
      const settings = reverbSettings(nextEffect);
      setWetDry(wet.gain, dry.gain, settings.mix, nextWhen);
    },
    dispose() {
      disconnect(input);
      disconnect(dry);
      disconnect(convolver);
      disconnect(wet);
      disconnect(output);
    },
  };
  instance.apply(effect, when);
  return instance;
}

function readNumber(
  effect: EffectConfig,
  keys: readonly string[],
  fallback: number,
  min: number,
  max: number,
): number {
  for (const key of keys) {
    const value = effect.params?.[key];
    if (Number.isFinite(value)) {
      return clamp(value as number, min, max);
    }
  }
  return fallback;
}

function setWetDry(wet: AudioParam, dry: AudioParam, mix: number, when: number): void {
  const clamped = clamp(mix, 0, 1);
  setParam(wet, clamped, when);
  setParam(dry, 1 - clamped, when);
}

function setParam(param: AudioParam, value: number, when: number): void {
  param.setTargetAtTime(value, when, 0.01);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function disconnect(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // already disconnected
  }
}

function createImpulseData(length: number, sampleRate: number): readonly Float32Array[] {
  const channels = [new Float32Array(length), new Float32Array(length)];
  let seed = 0x2f6e2b1;
  for (let channel = 0; channel < channels.length; channel += 1) {
    const data = channels[channel];
    if (!data) continue;
    for (let i = 0; i < length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = (seed / 0xffffffff) * 2 - 1;
      const t = i / sampleRate;
      data[i] = noise * Math.exp(-3.4 * t);
    }
  }
  return channels;
}
