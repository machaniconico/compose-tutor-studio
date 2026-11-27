// Static preset data shared by the voice manager and render tail planner.

/** ADSR envelope, seconds for A/D/R, 0..1 for sustain. */
export type Envelope = {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
};

export type OscillatorLayer = {
  role: 'primary' | 'unison' | 'sub';
  wave: OscillatorType;
  /** Octave offset from the played MIDI note. -1 is a sub oscillator. */
  octave: number;
  /** Fine pitch offset, cents. */
  detuneCents: number;
  /** Layer gain before the filter, 0..1. */
  gain: number;
};

export type FilterSettings = {
  cutoffHz: number;
  resonance: number;
};

/** Subtractive-synth preset definition. */
export type SynthPreset = {
  label: string;
  description: string;
  oscillators: readonly OscillatorLayer[];
  filter: FilterSettings;
  /** Per-note gain trim so presets sit at similar loudness. */
  gain: number;
  env: Envelope;
};

export type SynthPresetSummary = {
  name: string;
  label: string;
  description: string;
};

const softPadPreset: SynthPreset = {
  label: 'Soft Pad',
  description: 'Slow, mellow chords for gentle harmony practice.',
  oscillators: [
    { role: 'primary', wave: 'triangle', octave: 0, detuneCents: 0, gain: 0.22 },
    { role: 'unison', wave: 'sawtooth', octave: 0, detuneCents: -7, gain: 0.34 },
    { role: 'unison', wave: 'sawtooth', octave: 0, detuneCents: 7, gain: 0.34 },
    { role: 'sub', wave: 'sine', octave: -1, detuneCents: 0, gain: 0.1 },
  ],
  filter: { cutoffHz: 1250, resonance: 0.55 },
  gain: 0.24,
  env: { attack: 0.28, decay: 0.42, sustain: 0.72, release: 0.8 },
};

const brightPluckPreset: SynthPreset = {
  label: 'Bright Pluck',
  description: 'Short, clear notes for simple melodies and arpeggios.',
  oscillators: [
    { role: 'primary', wave: 'sawtooth', octave: 0, detuneCents: 0, gain: 0.55 },
    { role: 'unison', wave: 'square', octave: 0, detuneCents: 9, gain: 0.25 },
    { role: 'sub', wave: 'triangle', octave: -1, detuneCents: 0, gain: 0.2 },
  ],
  filter: { cutoffHz: 4200, resonance: 0.9 },
  gain: 0.23,
  env: { attack: 0.003, decay: 0.16, sustain: 0.18, release: 0.12 },
};

const warmBassPreset: SynthPreset = {
  label: 'Warm Bass',
  description: 'Rounded low notes that support a beginner chord loop.',
  oscillators: [
    { role: 'primary', wave: 'sine', octave: 0, detuneCents: 0, gain: 0.52 },
    { role: 'unison', wave: 'triangle', octave: 0, detuneCents: -4, gain: 0.23 },
    { role: 'sub', wave: 'sine', octave: -1, detuneCents: 0, gain: 0.35 },
  ],
  filter: { cutoffHz: 720, resonance: 0.65 },
  gain: 0.32,
  env: { attack: 0.006, decay: 0.13, sustain: 0.82, release: 0.15 },
};

const brightLeadPreset: SynthPreset = {
  label: 'Bright Lead',
  description: 'Focused lead tone for practicing memorable hooks.',
  oscillators: [
    { role: 'primary', wave: 'sawtooth', octave: 0, detuneCents: -9, gain: 0.42 },
    { role: 'unison', wave: 'sawtooth', octave: 0, detuneCents: 9, gain: 0.42 },
    { role: 'unison', wave: 'square', octave: 0, detuneCents: 0, gain: 0.12 },
    { role: 'sub', wave: 'triangle', octave: -1, detuneCents: 0, gain: 0.04 },
  ],
  filter: { cutoffHz: 3400, resonance: 0.85 },
  gain: 0.24,
  env: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.18 },
};

/** Adapt two-oscillator sounds to the existing layered synth. */
function layeredPreset(
  label: string,
  description: string,
  waveA: OscillatorType,
  secondary: Omit<OscillatorLayer, 'role' | 'gain'>,
  filter: FilterSettings,
  gain: number,
  env: Envelope,
): SynthPreset {
  return {
    label,
    description,
    oscillators: [
      { role: 'primary', wave: waveA, octave: 0, detuneCents: 0, gain: 0.6 },
      { ...secondary, role: 'unison', gain: 0.4 },
    ],
    filter,
    gain,
    env,
  };
}

const CANONICAL_SYNTH_PRESETS: Readonly<Record<string, SynthPreset>> = {
  softPad: softPadPreset,
  brightPluck: brightPluckPreset,
  warmBass: warmBassPreset,
  brightLead: brightLeadPreset,
  // New IDs are namespaced so unqualified names in legacy files still use the fallback.
  'p22:pianoLike': layeredPreset(
    'ピアノ風', 'すぐに鳴り、ピアノのようにだんだん小さくなる音です。',
    'triangle', { wave: 'sine', octave: 0, detuneCents: 3 },
    { cutoffHz: 2600, resonance: 0.5 }, 0.28,
    { attack: 0.004, decay: 0.6, sustain: 0.25, release: 0.35 },
  ),
  'p22:bell': layeredPreset(
    'ベル', '鐘のように澄んでいて、響きが長く残る音です。',
    'sine', { wave: 'sine', octave: 1, detuneCents: 0 },
    { cutoffHz: 6000, resonance: 0.3 }, 0.2,
    { attack: 0.002, decay: 0.9, sustain: 0.1, release: 0.9 },
  ),
  'p22:organLike': layeredPreset(
    'オルガン風', '音を伸ばしている間、同じ強さで鳴り続ける音です。',
    'sine', { wave: 'square', octave: 1, detuneCents: 0 },
    { cutoffHz: 2200, resonance: 0.4 }, 0.18,
    { attack: 0.01, decay: 0.05, sustain: 1, release: 0.08 },
  ),
  'p22:stringsLike': layeredPreset(
    '弦楽器の合奏風', '弦楽器の合奏のように、ゆっくり鳴り始めてなめらかに伸びます。',
    'sawtooth', { wave: 'sawtooth', octave: 0, detuneCents: 14 },
    { cutoffHz: 2000, resonance: 0.5 }, 0.18,
    { attack: 0.35, decay: 0.4, sustain: 0.8, release: 0.7 },
  ),
  'p22:brassLike': layeredPreset(
    '金管楽器風', 'トランペットのように力強く、主旋律が目立つ音です。',
    'sawtooth', { wave: 'square', octave: 0, detuneCents: 6 },
    { cutoffHz: 1800, resonance: 1.2 }, 0.2,
    { attack: 0.06, decay: 0.25, sustain: 0.7, release: 0.2 },
  ),
  'p22:pluck': layeredPreset(
    'はじく弦の音', '弦をはじくように短く鳴り、リズムを刻みやすい音です。',
    'sawtooth', { wave: 'triangle', octave: 0, detuneCents: 5 },
    { cutoffHz: 2400, resonance: 0.8 }, 0.26,
    { attack: 0.002, decay: 0.25, sustain: 0.05, release: 0.15 },
  ),
  'p22:deepSubBass': layeredPreset(
    '深い低音', '曲の土台を支える、低くやわらかい音です。',
    'sine', { wave: 'sine', octave: -1, detuneCents: 0 },
    { cutoffHz: 300, resonance: 0.3 }, 0.36,
    { attack: 0.008, decay: 0.1, sustain: 0.9, release: 0.1 },
  ),
  'p22:softKeys': layeredPreset(
    'やさしい鍵盤', '伴奏になじむ、角の取れた丸い鍵盤の音です。',
    'triangle', { wave: 'triangle', octave: 0, detuneCents: 7 },
    { cutoffHz: 1600, resonance: 0.4 }, 0.26,
    { attack: 0.01, decay: 0.5, sustain: 0.5, release: 0.4 },
  ),
  'p22:squareLead': layeredPreset(
    'ピコピコした主旋律', '短いメロディにも使いやすい、輪郭のはっきりした音です。',
    'square', { wave: 'square', octave: 0, detuneCents: 8 },
    { cutoffHz: 2800, resonance: 0.7 }, 0.18,
    { attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.15 },
  ),
  'p22:glassPad': layeredPreset(
    'すきとおるパッド', '和音を伸ばすと澄んだ響きがゆっくり広がります。',
    'triangle', { wave: 'sine', octave: 1, detuneCents: 0 },
    { cutoffHz: 3500, resonance: 0.6 }, 0.2,
    { attack: 0.5, decay: 0.6, sustain: 0.6, release: 1.2 },
  ),
};

const SYNTH_PRESET_ALIASES: Readonly<Record<string, string>> = {
  warmPad: 'softPad',
  pad: 'softPad',
  roundBass: 'warmBass',
  subBass: 'warmBass',
  bass: 'warmBass',
  leadSine: 'brightLead',
  lead: 'brightLead',
};

const synthPresetTable = Object.assign(
  Object.create(null) as Record<string, SynthPreset>,
  CANONICAL_SYNTH_PRESETS,
);
for (const [alias, canonical] of Object.entries(SYNTH_PRESET_ALIASES)) {
  synthPresetTable[alias] = CANONICAL_SYNTH_PRESETS[canonical]!;
}
export const SYNTH_PRESETS: Readonly<Record<string, SynthPreset>> = Object.freeze(synthPresetTable);

export const BEGINNER_SYNTH_PRESETS = ['softPad', 'brightPluck', 'warmBass'] as const;
export const DEFAULT_PRESET = 'warmPad';

export function canonicalSynthPresetName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (Object.hasOwn(SYNTH_PRESET_ALIASES, value)) return SYNTH_PRESET_ALIASES[value]!;
  return Object.hasOwn(CANONICAL_SYNTH_PRESETS, value) ? value : null;
}

export function resolvePreset(value: unknown): SynthPreset {
  const preset = typeof value === 'string' && Object.hasOwn(SYNTH_PRESETS, value)
    ? SYNTH_PRESETS[value]!
    : softPadPreset;
  return {
    ...preset,
    oscillators: preset.oscillators.map((layer) => ({ ...layer })),
    filter: { ...preset.filter },
    env: { ...preset.env },
  };
}

export function listSynthPresets(): readonly SynthPresetSummary[] {
  return Object.entries(CANONICAL_SYNTH_PRESETS).map(([name, { label, description }]) => ({
    name,
    label,
    description,
  }));
}
