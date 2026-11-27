export type DrumPatternLane = 'kick' | 'snare' | 'closedHat' | 'openHat' | 'clap' | 'perc';

export type DrumPatternId =
  | 'fourOnFloor'
  | 'eightBeat'
  | 'hiphop'
  | 'gameLoop'
  | 'lofi';

export type DrumPattern = {
  id: DrumPatternId;
  name: string;
  /**
   * lane -> beat offsets within one bar of `bpb` beats that are ON (0 = 1st
   * beat, 0.5 = its off-beat). Hits at or past the bar end are dropped.
   */
  beats: (bpb: number) => Partial<Record<DrumPatternLane, number[]>>;
};

/** Whole beats of a bar (0, 1, ...), as many as fit before `bpb`. */
function barBeats(bpb: number): number[] {
  return Array.from({ length: Math.ceil(bpb) }, (_, i) => i).filter((beat) => beat < bpb);
}

/** Every 8th note of a bar (0, 0.5, 1, ...). */
function barEighths(bpb: number): number[] {
  return Array.from({ length: Math.ceil(bpb * 2) }, (_, i) => i / 2).filter((beat) => beat < bpb);
}

/**
 * One-bar drum pattern presets. Original beginner-friendly patterns;
 * not copied from any product's factory content.
 */
export const DRUM_PATTERNS: DrumPattern[] = [
  {
    id: 'fourOnFloor',
    name: 'Four on the floor',
    // Kick on every beat of the bar, hi-hat on each off-beat, clap on beats 2, 4, ...
    beats: (bpb) => ({
      kick: barBeats(bpb),
      closedHat: barBeats(bpb).map((beat) => beat + 0.5),
      clap: barBeats(bpb).filter((beat) => beat % 2 === 1),
    }),
  },
  {
    id: 'eightBeat',
    name: '8ビート',
    // Hi-hat on every 8th, kick on beats 1, 3, ..., snare on beats 2, 4, ...
    beats: (bpb) => ({
      kick: barBeats(bpb).filter((beat) => beat % 2 === 0),
      snare: barBeats(bpb).filter((beat) => beat % 2 === 1),
      closedHat: barEighths(bpb),
    }),
  },
  {
    id: 'hiphop',
    name: 'ヒップホップ',
    beats: () => ({
      kick: [0, 1.5, 2.5],
      snare: [1, 3],
      closedHat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
      openHat: [3.5],
    }),
  },
  {
    id: 'gameLoop',
    name: 'ゲームループ',
    beats: () => ({
      kick: [0, 2],
      snare: [1, 3],
      closedHat: [0, 0.75, 1.5, 2.25, 3, 3.75],
      perc: [0.5, 2.5],
    }),
  },
  {
    id: 'lofi',
    name: 'ローファイ',
    beats: () => ({
      kick: [0, 2.5],
      snare: [1, 3],
      closedHat: [0, 1, 2, 3],
      perc: [1.75],
    }),
  },
];

