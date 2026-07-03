import type { EffectConfig, EffectType } from '@cts/project-model';

export type InsertEffectType = Extract<EffectType, 'filter' | 'delay' | 'reverb'>;
type FilterEffectConfig = EffectConfig & { type: 'filter' };
type DelayEffectConfig = EffectConfig & { type: 'delay' };
type ReverbEffectConfig = EffectConfig & { type: 'reverb' };
type InsertEffectConfig = FilterEffectConfig | DelayEffectConfig | ReverbEffectConfig;

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

export const INSERT_EFFECT_TYPES: readonly InsertEffectType[] = ['filter', 'delay', 'reverb'];

export const DEFAULT_EFFECT_PARAMS = {
  filter: { cutoff: 0.7, resonance: 0.15 },
  delay: { delayTime: 0.25, feedback: 0.25, mix: 0.25 },
  reverb: { wet: 0.25, decay: 0.45 },
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

export function isInsertEffectType(type: string): type is InsertEffectType {
  return type === 'filter' || type === 'delay' || type === 'reverb';
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
  return createReverbStage(ctx, config);
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
