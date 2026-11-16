// Channel presets: starting points for a track's EQ / compressor / filter.
//
// Names and descriptions are original, functional Japanese (what the preset
// does to the sound), not names borrowed from other software. Values stay
// inside the ranges checked by `validateProject` and the audio clamps in
// `audio/effects.ts`. Applying one is a single undo step (editorActions).

export type ChannelPresetEffects = {
  eq?: { lowGainDb: number; midGainDb: number; highGainDb: number };
  compressor?: {
    thresholdDb: number;
    ratio: number;
    attackSeconds: number;
    releaseSeconds: number;
  };
  filter?: { cutoffHz: number; resonance: number };
};

export type ChannelPreset = {
  id: string;
  name: string;
  /** One-line mix explanation; show it through `simplifyExplanation`. */
  description: string;
  effects: ChannelPresetEffects;
};

export const CHANNEL_PRESETS: readonly ChannelPreset[] = [
  {
    id: 'bass-thick',
    name: 'ベースを太く',
    description:
      '低音を持ち上げ、コンプレッサーで音量のばらつきをそろえて、ベースを太く安定させます。',
    effects: {
      eq: { lowGainDb: 4, midGainDb: -1, highGainDb: -2 },
      compressor: { thresholdDb: -20, ratio: 4, attackSeconds: 0.02, releaseSeconds: 0.2 },
    },
  },
  {
    id: 'lead-forward',
    name: 'ボーカル風リードを前へ',
    description:
      '中音と高音を少し上げ、軽くコンプレッサーをかけて、メロディが他の楽器より手前に聞こえるようにします。',
    effects: {
      eq: { lowGainDb: -2, midGainDb: 3, highGainDb: 2 },
      compressor: { thresholdDb: -18, ratio: 3, attackSeconds: 0.01, releaseSeconds: 0.15 },
    },
  },
  {
    id: 'pad-back',
    name: 'パッドを奥へ',
    description:
      '高音をフィルターで丸め、中音を少し下げて、伴奏の和音が後ろに広がるようにします。',
    effects: {
      eq: { lowGainDb: -1, midGainDb: -2, highGainDb: -3 },
      filter: { cutoffHz: 2500, resonance: 0.7 },
    },
  },
  {
    id: 'drums-clear',
    name: 'ドラムをはっきり',
    description:
      '低音と高音を上げ、アタックを遅めにしたコンプレッサーで、叩いた瞬間の音を目立たせます。',
    effects: {
      eq: { lowGainDb: 2, midGainDb: -2, highGainDb: 3 },
      compressor: { thresholdDb: -16, ratio: 4, attackSeconds: 0.03, releaseSeconds: 0.12 },
    },
  },
  {
    id: 'soft-overall',
    name: '全体をやわらかく',
    description:
      '高音を下げてフィルターで耳に痛い成分を減らし、ゆるいコンプレッサーで角の取れた音にします。',
    effects: {
      eq: { lowGainDb: 1, midGainDb: 0, highGainDb: -4 },
      compressor: { thresholdDb: -24, ratio: 2, attackSeconds: 0.02, releaseSeconds: 0.3 },
      filter: { cutoffHz: 6000, resonance: 0.5 },
    },
  },
];

export function findChannelPreset(id: string): ChannelPreset | undefined {
  return CHANNEL_PRESETS.find((preset) => preset.id === id);
}
