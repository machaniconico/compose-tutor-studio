import type { EffectConfig, EffectType } from '@cts/project-model';

export type InsertEffectType = Extract<EffectType, 'filter' | 'delay' | 'reverb' | 'eq' | 'compressor'>;
type FilterEffectConfig = EffectConfig & { type: 'filter' };
type DelayEffectConfig = EffectConfig & { type: 'delay' };
type ReverbEffectConfig = EffectConfig & { type: 'reverb' };
type EqEffectConfig = EffectConfig & { type: 'eq' };
type CompressorEffectConfig = EffectConfig & { type: 'compressor' };
type InsertEffectConfig =
  | FilterEffectConfig
  | DelayEffectConfig
  | ReverbEffectConfig
  | EqEffectConfig
  | CompressorEffectConfig;

export type BuiltEffectChain = {
  input: AudioNode | null;
  output: AudioNode | null;
  nodes: AudioNode[];
  isBypassed: boolean;
  dispose: () => void;
};

type EffectStage = {
  input: AudioNode;
  output: AudioNode;
  nodes: AudioNode[];
};

export const INSERT_EFFECT_TYPES: readonly InsertEffectType[] = [
  'filter',
  'delay',
  'reverb',
  'eq',
  'compressor',
];

export const DEFAULT_EFFECT_PARAMS = {
  filter: { cutoff: 0.7, resonance: 0.15 },
  delay: { delayTime: 0.25, feedback: 0.25, mix: 0.25 },
  reverb: { wet: 0.25, decay: 0.45 },
  eq: { lowGain: 0.5, midGain: 0.5, highGain: 0.5 },
  compressor: { threshold: 0.55, ratio: 0.35, attack: 0.12, release: 0.35 },
} as const satisfies Record<InsertEffectType, Record<string, number>>;

const FILTER_MIN_HZ = 80;
const FILTER_MAX_HZ = 16_000;
const FILTER_MIN_Q = 0.2;
const FILTER_MAX_Q = 18;
const DELAY_MIN_SECONDS = 0.02;
const DELAY_MAX_SECONDS = 0.75;
const DELAY_MAX_FEEDBACK = 0.85;
const REVERB_MIN_SECONDS = 0.15;
const REVERB_MAX_SECONDS = 3;
const EQ_MIN_DB = -12;
const EQ_MAX_DB = 12;
const EQ_LOW_HZ = 160;
const EQ_MID_HZ = 1_000;
const EQ_HIGH_HZ = 5_000;
const EQ_MID_Q = 1.1;
const COMPRESSOR_MIN_THRESHOLD_DB = -48;
const COMPRESSOR_MAX_THRESHOLD_DB = -6;
const COMPRESSOR_MIN_RATIO = 1;
const COMPRESSOR_MAX_RATIO = 12;
const COMPRESSOR_MIN_ATTACK_SECONDS = 0.003;
const COMPRESSOR_MAX_ATTACK_SECONDS = 0.08;
const COMPRESSOR_MIN_RELEASE_SECONDS = 0.05;
const COMPRESSOR_MAX_RELEASE_SECONDS = 0.8;

export function isInsertEffectType(type: string): type is InsertEffectType {
  return (
    type === 'filter' ||
    type === 'delay' ||
    type === 'reverb' ||
    type === 'eq' ||
    type === 'compressor'
  );
}

/** Clamp normalized effect controls into 0..1. Non-finite values use fallback. */
export function clamp01(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function createDefaultEffectConfig(
  type: InsertEffectType,
  id: string,
): EffectConfig {
  return {
    id,
    type,
    enabled: true,
    params: { ...DEFAULT_EFFECT_PARAMS[type] },
  };
}

/** Return a copy with every numeric parameter in a safe normalized range. */
export function normalizeEffectConfig(config: EffectConfig): EffectConfig {
  const params: Record<string, number> = {};
  for (const [key, value] of Object.entries(config.params ?? {})) {
    params[key] = clamp01(value);
  }

  if (isInsertEffectType(config.type)) {
    const defaults = DEFAULT_EFFECT_PARAMS[config.type];
    for (const [key, fallback] of Object.entries(defaults)) {
      params[key] = clamp01(config.params?.[key] ?? fallback, fallback);
    }

    if (config.type === 'reverb' && config.params?.wet === undefined) {
      params.wet = clamp01(config.params?.mix ?? DEFAULT_EFFECT_PARAMS.reverb.wet, DEFAULT_EFFECT_PARAMS.reverb.wet);
    }
  }

  return { ...config, params };
}

export function normalizeEffectConfigs(configs: readonly EffectConfig[]): EffectConfig[] {
  return configs.map(normalizeEffectConfig);
}

export function effectConfigSignature(configs: readonly EffectConfig[]): string {
  return normalizeEffectConfigs(configs)
    .map((config) => {
      const params = Object.keys(config.params)
        .sort()
        .map((key) => `${key}:${config.params[key]}`)
        .join(',');
      return `${config.id}:${config.type}:${config.enabled ? 1 : 0}:${params}`;
    })
    .join('|');
}

export function cutoffToFrequency(cutoff: number, sampleRate: number): number {
  const safeCutoff = clamp01(cutoff, DEFAULT_EFFECT_PARAMS.filter.cutoff);
  const nyquistSafeMax = Math.max(FILTER_MIN_HZ, Math.min(FILTER_MAX_HZ, sampleRate * 0.45));
  return FILTER_MIN_HZ * (nyquistSafeMax / FILTER_MIN_HZ) ** safeCutoff;
}

export function resonanceToQ(resonance: number): number {
  return FILTER_MIN_Q + clamp01(resonance) * (FILTER_MAX_Q - FILTER_MIN_Q);
}

export function delayTimeToSeconds(delayTime: number): number {
  return DELAY_MIN_SECONDS + clamp01(delayTime) * (DELAY_MAX_SECONDS - DELAY_MIN_SECONDS);
}

export function feedbackToGain(feedback: number): number {
  return clamp01(feedback) * DELAY_MAX_FEEDBACK;
}

export function decayToSeconds(decay: number): number {
  return REVERB_MIN_SECONDS + clamp01(decay, DEFAULT_EFFECT_PARAMS.reverb.decay) *
    (REVERB_MAX_SECONDS - REVERB_MIN_SECONDS);
}

export function eqGainToDb(gain: number): number {
  return EQ_MIN_DB + clamp01(gain, 0.5) * (EQ_MAX_DB - EQ_MIN_DB);
}

export function compressorThresholdToDb(threshold: number): number {
  return COMPRESSOR_MIN_THRESHOLD_DB + clamp01(threshold, DEFAULT_EFFECT_PARAMS.compressor.threshold) *
    (COMPRESSOR_MAX_THRESHOLD_DB - COMPRESSOR_MIN_THRESHOLD_DB);
}

export function compressorRatioToValue(ratio: number): number {
  return COMPRESSOR_MIN_RATIO + clamp01(ratio, DEFAULT_EFFECT_PARAMS.compressor.ratio) *
    (COMPRESSOR_MAX_RATIO - COMPRESSOR_MIN_RATIO);
}

export function compressorAttackToSeconds(attack: number): number {
  return COMPRESSOR_MIN_ATTACK_SECONDS + clamp01(attack, DEFAULT_EFFECT_PARAMS.compressor.attack) *
    (COMPRESSOR_MAX_ATTACK_SECONDS - COMPRESSOR_MIN_ATTACK_SECONDS);
}

export function compressorReleaseToSeconds(release: number): number {
  return COMPRESSOR_MIN_RELEASE_SECONDS + clamp01(release, DEFAULT_EFFECT_PARAMS.compressor.release) *
    (COMPRESSOR_MAX_RELEASE_SECONDS - COMPRESSOR_MIN_RELEASE_SECONDS);
}

export function buildEffectChain(
  ctx: BaseAudioContext,
  configs: readonly EffectConfig[],
): BuiltEffectChain {
  const stages = normalizeEffectConfigs(configs)
    .filter((config) => config.enabled && isInsertEffectType(config.type))
    .map((config) => createStage(ctx, config as InsertEffectConfig));

  if (stages.length === 0) {
    return {
      input: null,
      output: null,
      nodes: [],
      isBypassed: true,
      dispose: () => {
        /* no nodes */
      },
    };
  }

  for (let index = 1; index < stages.length; index += 1) {
    stages[index - 1]?.output.connect(stages[index]?.input as AudioNode);
  }

  const nodes = stages.flatMap((stage) => stage.nodes);
  return {
    input: stages[0]?.input ?? null,
    output: stages[stages.length - 1]?.output ?? null,
    nodes,
    isBypassed: false,
    dispose: () => {
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {
          // already disconnected
        }
      }
    },
  };
}

function createStage(
  ctx: BaseAudioContext,
  config: InsertEffectConfig,
): EffectStage {
  if (config.type === 'filter') return createFilterStage(ctx, config);
  if (config.type === 'delay') return createDelayStage(ctx, config);
  if (config.type === 'reverb') return createReverbStage(ctx, config);
  if (config.type === 'eq') return createEqStage(ctx, config);
  return createCompressorStage(ctx, config);
}

function createFilterStage(
  ctx: BaseAudioContext,
  config: FilterEffectConfig,
): EffectStage {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoffToFrequency(
    config.params.cutoff ?? DEFAULT_EFFECT_PARAMS.filter.cutoff,
    ctx.sampleRate,
  );
  filter.Q.value = resonanceToQ(
    config.params.resonance ?? DEFAULT_EFFECT_PARAMS.filter.resonance,
  );
  return { input: filter, output: filter, nodes: [filter] };
}

function createDelayStage(
  ctx: BaseAudioContext,
  config: DelayEffectConfig,
): EffectStage {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const delay = ctx.createDelay(1);
  const feedback = ctx.createGain();
  const mix = clamp01(config.params.mix ?? DEFAULT_EFFECT_PARAMS.delay.mix, DEFAULT_EFFECT_PARAMS.delay.mix);

  dry.gain.value = 1 - mix;
  wet.gain.value = mix;
  delay.delayTime.value = delayTimeToSeconds(
    config.params.delayTime ?? DEFAULT_EFFECT_PARAMS.delay.delayTime,
  );
  feedback.gain.value = feedbackToGain(
    config.params.feedback ?? DEFAULT_EFFECT_PARAMS.delay.feedback,
  );

  input.connect(dry);
  dry.connect(output);
  input.connect(delay);
  delay.connect(wet);
  wet.connect(output);
  delay.connect(feedback);
  feedback.connect(delay);

  return {
    input,
    output,
    nodes: [input, dry, delay, feedback, wet, output],
  };
}

function createReverbStage(
  ctx: BaseAudioContext,
  config: ReverbEffectConfig,
): EffectStage {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const convolver = ctx.createConvolver();
  const wetAmount = clamp01(config.params.wet ?? DEFAULT_EFFECT_PARAMS.reverb.wet, DEFAULT_EFFECT_PARAMS.reverb.wet);

  convolver.buffer = createSyntheticImpulse(
    ctx,
    decayToSeconds(config.params.decay ?? DEFAULT_EFFECT_PARAMS.reverb.decay),
  );
  dry.gain.value = 1 - wetAmount;
  wet.gain.value = wetAmount;

  input.connect(dry);
  dry.connect(output);
  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(output);

  return {
    input,
    output,
    nodes: [input, dry, convolver, wet, output],
  };
}

function createEqStage(
  ctx: BaseAudioContext,
  config: EqEffectConfig,
): EffectStage {
  const low = ctx.createBiquadFilter();
  const mid = ctx.createBiquadFilter();
  const high = ctx.createBiquadFilter();

  low.type = 'lowshelf';
  low.frequency.value = EQ_LOW_HZ;
  low.gain.value = eqGainToDb(config.params.lowGain ?? DEFAULT_EFFECT_PARAMS.eq.lowGain);

  mid.type = 'peaking';
  mid.frequency.value = EQ_MID_HZ;
  mid.Q.value = EQ_MID_Q;
  mid.gain.value = eqGainToDb(config.params.midGain ?? DEFAULT_EFFECT_PARAMS.eq.midGain);

  high.type = 'highshelf';
  high.frequency.value = EQ_HIGH_HZ;
  high.gain.value = eqGainToDb(config.params.highGain ?? DEFAULT_EFFECT_PARAMS.eq.highGain);

  low.connect(mid);
  mid.connect(high);

  return {
    input: low,
    output: high,
    nodes: [low, mid, high],
  };
}

function createCompressorStage(
  ctx: BaseAudioContext,
  config: CompressorEffectConfig,
): EffectStage {
  const compressor = ctx.createDynamicsCompressor();

  compressor.threshold.value = compressorThresholdToDb(
    config.params.threshold ?? DEFAULT_EFFECT_PARAMS.compressor.threshold,
  );
  compressor.knee.value = 24;
  compressor.ratio.value = compressorRatioToValue(
    config.params.ratio ?? DEFAULT_EFFECT_PARAMS.compressor.ratio,
  );
  compressor.attack.value = compressorAttackToSeconds(
    config.params.attack ?? DEFAULT_EFFECT_PARAMS.compressor.attack,
  );
  compressor.release.value = compressorReleaseToSeconds(
    config.params.release ?? DEFAULT_EFFECT_PARAMS.compressor.release,
  );

  return {
    input: compressor,
    output: compressor,
    nodes: [compressor],
  };
}

function createSyntheticImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  let seed = 0x12345678;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      const noise = (seed / 0xffffffff) * 2 - 1;
      const envelope = (1 - i / length) ** 2;
      data[i] = noise * envelope * 0.35;
    }
  }

  return buffer;
}
