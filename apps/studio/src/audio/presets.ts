// Synth preset table (pure data, no Web Audio).
//
// Kept apart from synth.ts so code that only needs preset values (the WAV /
// live tail length) can read them in tests that mock the synth voice manager.
// synth.ts re-exports everything here, so existing imports keep working.

/** ADSR envelope, seconds for A/D/R, 0..1 for sustain. */
export type Envelope = {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
};

/** Subtractive-synth preset definition. */
export type SynthPreset = {
  /** Oscillator waveforms for the two detuned voices. */
  waveA: OscillatorType;
  waveB: OscillatorType;
  /** Detune of the second oscillator, cents. */
  detuneCents: number;
  /** Base lowpass cutoff, Hz. */
  cutoffHz: number;
  /** Filter resonance (Q). */
  resonance: number;
  /** Per-note gain trim so presets sit at similar loudness. */
  gain: number;
  env: Envelope;
  /**
   * Left/right spread 0..1 (set by the width macro). Absent or 0: the voice is
   * mono and has no panner node.
   */
  spread?: number;
};

/**
 * Preset table. Keys cover both the canonical task names (warmPad / roundBass /
 * brightLead) and the names the default project currently ships with
 * (subBass / leadSine) so playback works without changing the project model.
 */
const PRESETS: Record<string, SynthPreset> = {
  // Soft attack, mellow filter — default for the Chords track.
  warmPad: {
    waveA: 'sawtooth',
    waveB: 'triangle',
    detuneCents: 8,
    cutoffHz: 1400,
    resonance: 0.6,
    gain: 0.22,
    env: { attack: 0.18, decay: 0.3, sustain: 0.7, release: 0.5 },
  },
  // Short attack, low filter, sine + triangle.
  roundBass: {
    waveA: 'sine',
    waveB: 'triangle',
    detuneCents: 4,
    cutoffHz: 600,
    resonance: 0.4,
    gain: 0.32,
    env: { attack: 0.005, decay: 0.12, sustain: 0.85, release: 0.12 },
  },
  // Saw, brighter filter — Melody.
  brightLead: {
    waveA: 'sawtooth',
    waveB: 'sawtooth',
    detuneCents: 12,
    cutoffHz: 3200,
    resonance: 0.9,
    gain: 0.26,
    env: { attack: 0.01, decay: 0.2, sustain: 0.75, release: 0.18 },
  },
};

// Aliases for the preset names used by the current default project factory.
PRESETS['subBass'] = PRESETS['roundBass'] as SynthPreset;
PRESETS['leadSine'] = PRESETS['brightLead'] as SynthPreset;

// Additional original presets (US-020). Keys are new names only: names already
// stored in projects ('piano', 'pad', 'bass', 'lead', ...) keep falling back to
// warmPad, so existing songs sound exactly as before.
const EXTRA_PRESETS: Record<string, SynthPreset> = {
  pianoLike: {
    waveA: 'triangle',
    waveB: 'sine',
    detuneCents: 3,
    cutoffHz: 2600,
    resonance: 0.5,
    gain: 0.28,
    env: { attack: 0.004, decay: 0.6, sustain: 0.25, release: 0.35 },
  },
  bell: {
    waveA: 'sine',
    waveB: 'sine',
    detuneCents: 1200,
    cutoffHz: 6000,
    resonance: 0.3,
    gain: 0.2,
    env: { attack: 0.002, decay: 0.9, sustain: 0.1, release: 0.9 },
  },
  organLike: {
    waveA: 'sine',
    waveB: 'square',
    detuneCents: 1200,
    cutoffHz: 2200,
    resonance: 0.4,
    gain: 0.18,
    env: { attack: 0.01, decay: 0.05, sustain: 1, release: 0.08 },
  },
  stringsLike: {
    waveA: 'sawtooth',
    waveB: 'sawtooth',
    detuneCents: 14,
    cutoffHz: 2000,
    resonance: 0.5,
    gain: 0.18,
    env: { attack: 0.35, decay: 0.4, sustain: 0.8, release: 0.7 },
  },
  brassLike: {
    waveA: 'sawtooth',
    waveB: 'square',
    detuneCents: 6,
    cutoffHz: 1800,
    resonance: 1.2,
    gain: 0.2,
    env: { attack: 0.06, decay: 0.25, sustain: 0.7, release: 0.2 },
  },
  pluck: {
    waveA: 'sawtooth',
    waveB: 'triangle',
    detuneCents: 5,
    cutoffHz: 2400,
    resonance: 0.8,
    gain: 0.26,
    env: { attack: 0.002, decay: 0.25, sustain: 0.05, release: 0.15 },
  },
  deepSubBass: {
    waveA: 'sine',
    waveB: 'sine',
    detuneCents: 0,
    cutoffHz: 300,
    resonance: 0.3,
    gain: 0.36,
    env: { attack: 0.008, decay: 0.1, sustain: 0.9, release: 0.1 },
  },
  softKeys: {
    waveA: 'triangle',
    waveB: 'triangle',
    detuneCents: 7,
    cutoffHz: 1600,
    resonance: 0.4,
    gain: 0.26,
    env: { attack: 0.01, decay: 0.5, sustain: 0.5, release: 0.4 },
  },
  squareLead: {
    waveA: 'square',
    waveB: 'square',
    detuneCents: 8,
    cutoffHz: 2800,
    resonance: 0.7,
    gain: 0.18,
    env: { attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.15 },
  },
  glassPad: {
    waveA: 'triangle',
    waveB: 'sine',
    detuneCents: 702,
    cutoffHz: 3500,
    resonance: 0.6,
    gain: 0.2,
    env: { attack: 0.5, decay: 0.6, sustain: 0.6, release: 1.2 },
  },
};
for (const [name, preset] of Object.entries(EXTRA_PRESETS)) PRESETS[name] = preset;

/** Picker categories, in display order. */
export type PresetCategory = 'keys' | 'pad' | 'bass' | 'lead' | 'other';

/** One choice in the instrument picker. */
export type PresetInfo = {
  /** The value stored in InstrumentConfig.preset. */
  id: string;
  /** Short functional Japanese name. */
  name: string;
  category: PresetCategory;
  /** One-line beginner description. */
  description: string;
};

/** Category labels for the picker. */
export const PRESET_CATEGORY_LABELS: Record<PresetCategory, string> = {
  keys: '鍵盤',
  pad: 'パッド・持続音',
  bass: 'ベース',
  lead: 'メロディ',
  other: 'その他',
};

/** Every selectable preset (aliases are not listed separately). */
export const PRESET_LIST: readonly PresetInfo[] = [
  { id: 'pianoLike', name: 'ピアノ風', category: 'keys', description: '叩くとすぐ鳴り、だんだん小さくなる音。コードにもメロディにも。' },
  { id: 'softKeys', name: 'やさしい鍵盤', category: 'keys', description: '角の取れた丸い鍵盤の音。伴奏向き。' },
  { id: 'organLike', name: 'オルガン風', category: 'keys', description: '押している間ずっと同じ大きさで鳴る音。' },
  { id: 'warmPad', name: 'やわらかいパッド', category: 'pad', description: 'ゆっくり立ち上がる、包み込むような和音向きの音。' },
  { id: 'stringsLike', name: 'ストリングス風', category: 'pad', description: '弦楽器の合奏のように、なめらかに伸びる音。' },
  { id: 'glassPad', name: 'すきとおるパッド', category: 'pad', description: '澄んだ響きが長く残る、静かな場面向きの音。' },
  { id: 'roundBass', name: 'まるいベース', category: 'bass', description: '低くて丸い、曲の土台を支える音。' },
  { id: 'deepSubBass', name: 'サブベース', category: 'bass', description: 'とても低く、体で感じるような重い音。' },
  { id: 'brightLead', name: '明るいリード', category: 'lead', description: 'はっきり前に出る、メロディ向きの音。' },
  { id: 'squareLead', name: 'ゲーム風リード', category: 'lead', description: '素朴でかわいらしい、ピコピコした音。' },
  { id: 'brassLike', name: 'ブラス風', category: 'lead', description: '金管楽器のように力強く鳴る音。' },
  { id: 'pluck', name: 'プラック', category: 'other', description: '弦をはじいたように短く切れる音。リズムを刻むのに。' },
  { id: 'bell', name: 'ベル', category: 'other', description: 'キラッと響いて長く残る、鐘のような音。' },
];

/** Default preset when an unknown name is requested. */
const DEFAULT_PRESET = 'warmPad';

/** Resolve a preset by name, falling back to the default. */
export function resolvePreset(preset: unknown): SynthPreset {
  // Object.hasOwn: 'constructor' や '__proto__' などの継承プロパティを音色として拾わない
  if (typeof preset === 'string' && Object.hasOwn(PRESETS, preset)) return PRESETS[preset] as SynthPreset;
  return PRESETS[DEFAULT_PRESET] as SynthPreset;
}
