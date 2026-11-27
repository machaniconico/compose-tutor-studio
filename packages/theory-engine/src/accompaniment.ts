import { generateBassLine } from './bass';
import { MAX_COMPING_NOTES, compingNoteCount, compingPattern, compingTickSpan, type CompingPattern } from './comping';
import { DRUM_PATTERNS, MAX_DRUM_PATTERN_BEATS, type DrumPatternId, type DrumPatternLane } from './drum-patterns';
import { createPrng, randomInt } from './prng';
import type { BassMode, ChordEventInput, GeneratedNote } from './types';

export const ACCOMPANIMENT_MOODS = {
  soft: 'やわらかい',
  bouncy: 'はずむ',
  straight: 'まっすぐ',
  driving: 'かけぬける',
} as const;
export type AccompanimentMood = keyof typeof ACCOMPANIMENT_MOODS;

export type AccompanimentPart = 'drums' | 'bass' | 'chords';
type Note = Omit<GeneratedNote, 'reason'>;
type DrumNote = Note & { lane: DrumPatternLane; stepIndex: number };
type ClipWindow = { startBeat: number; endBeat: number };

export type AccompanimentOptions = {
  seed: number;
  complexity: number;
  intensity: number;
  mood: AccompanimentMood;
  beatsPerBar?: number;
  drumStepsPerBar?: number;
  /** The intersection with the song for each target. Output times are clip-local. */
  windows?: Partial<Record<AccompanimentPart, ClipWindow>>;
};

export type AccompanimentResult =
  | { ok: true; chords: Note[]; bass: Note[]; drums: DrumNote[] }
  | { ok: false; reason: string };

const PPQ = 480;
const EPSILON = 1e-9;
const DRUM_PITCH: Record<DrumPatternLane, number> = {
  kick: 36, snare: 38, closedHat: 42, openHat: 46, clap: 39, perc: 37,
};

const MOODS = {
  soft: { drums: 'lofi', middle: 'whole', velocity: 0 },
  bouncy: { drums: 'gameLoop', middle: 'stab', velocity: 4 },
  straight: { drums: 'eightBeat', middle: 'stab', velocity: 2 },
  driving: { drums: 'fourOnFloor', middle: 'stab', velocity: 8 },
} as const satisfies Record<AccompanimentMood, {
  drums: DrumPatternId; middle: CompingPattern; velocity: number;
}>;

const TOO_MANY_NOTES = '伴奏の音の数が上限（100000 個）を超えます。クリップを短くするか、音の数を減らしてください。';

function unit(value: number): number {
  return typeof value !== 'number' || Number.isNaN(value) ? 0.5 : Math.max(0, Math.min(1, value));
}

function chordInWindow(chord: ChordEventInput, window: ClipWindow | undefined): ChordEventInput {
  const origin = window?.startBeat ?? 0;
  const start = Math.max(chord.startBeat, origin);
  const end = Math.min(chord.startBeat + chord.durationBeats, window?.endBeat ?? Infinity);
  return { symbol: chord.symbol, startBeat: start - origin, durationBeats: end - start };
}

function bassPlan(ticks: number, complexity: number, mood: AccompanimentMood): { mode: BassMode; count: number } {
  if (complexity < 1 / 3 || ticks < 2) return { mode: 'rootOnly', count: 1 };
  const beats = Math.round(ticks / PPQ);
  if (complexity >= 2 / 3 && beats >= 2 && (mood === 'bouncy' || mood === 'driving')) {
    return { mode: 'octavePulse', count: beats };
  }
  return { mode: 'rootFifth', count: 2 };
}

type DrumSlot = { lane: DrumPatternLane; step: number };

function drumSlots(
  primary: DrumPatternId, extra: DrumPatternId, complexity: number, beatsPerBar: number, stepsPerBar: number,
): DrumSlot[] {
  const slots = new Map<string, DrumSlot>();
  for (const id of [primary, extra]) {
    const beatsByLane = DRUM_PATTERNS.find((candidate) => candidate.id === id)!.beats(beatsPerBar);
    for (const lane of Object.keys(DRUM_PITCH) as DrumPatternLane[]) {
      // These presets use closed hats. Keep hits independent of hi-hat choke.
      const threshold = id !== primary ? 2 / 3 : lane === 'closedHat' || lane === 'perc' ? 1 / 3 : 0;
      if (complexity < threshold) continue;
      if (!Object.hasOwn(beatsByLane, lane)) continue;
      for (const beat of beatsByLane[lane]!) {
        const step = Math.round(beat * stepsPerBar / beatsPerBar);
        if (beat >= beatsPerBar || step >= stepsPerBar) continue;
        slots.set(`${lane}:${step}`, { lane, step });
      }
    }
  }
  return [...slots.values()];
}

/** Range of bars whose slot fits both the raw grid placement and the rounded tick. */
function drumBars(start: number, end: number, slotTick: number, barTicks: number) {
  return {
    first: Math.max(0, Math.ceil((start - slotTick - EPSILON) / barTicks)),
    last: Math.floor((end - 1 - slotTick + EPSILON) / barTicks),
  };
}

/** Pure, seeded arrangement using existing chord, bass and drum patterns. */
export function generateAccompaniment(
  chords: readonly ChordEventInput[], options: AccompanimentOptions | null,
): AccompanimentResult {
  if (!Array.isArray(chords) || options === null || typeof options !== 'object') {
    return { ok: false, reason: '伴奏の設定を読み取れませんでした。' };
  }
  if (chords.length > MAX_COMPING_NOTES) return { ok: false, reason: TOO_MANY_NOTES };

  const { seed, mood, windows, beatsPerBar = 4 } = options;
  if (typeof mood !== 'string' || !Object.hasOwn(MOODS, mood)) {
    return { ok: false, reason: '一覧から伴奏の雰囲気を選んでください。' };
  }
  if (!Number.isFinite(seed)) {
    return { ok: false, reason: '伴奏のシードを数値で指定してください。' };
  }
  if (!Number.isFinite(beatsPerBar) || beatsPerBar <= 0 || beatsPerBar > MAX_DRUM_PATTERN_BEATS) {
    return { ok: false, reason: 'ドラムの拍子やマス目を確認してから、もう一度試してください。' };
  }
  const drumStepsPerBar = options.drumStepsPerBar ?? Math.round(beatsPerBar * 4);
  const barTicks = beatsPerBar * PPQ;
  if (!Number.isSafeInteger(barTicks) || barTicks < 1 ||
      !Number.isInteger(drumStepsPerBar) || drumStepsPerBar < 1 || drumStepsPerBar > 192) {
    return { ok: false, reason: 'ドラムの拍子やマス目を確認してから、もう一度試してください。' };
  }

  const complexity = unit(options.complexity);
  const intensity = unit(options.intensity);
  const palette = MOODS[mood];
  const pattern = complexity >= 2 / 3 ? 'eighths' : complexity >= 1 / 3 ? palette.middle : 'whole';
  const rng = createPrng(seed);
  const extra = rng() < 0.5 ? 'eightBeat' : 'fourOnFloor';
  const slots = drumSlots(palette.drums, extra, complexity, beatsPerBar, drumStepsPerBar);
  const register = randomInt(rng, 55, 62);
  // Intensity adds the same amount to each hit. Consecutive seeds always change velocity parity.
  const velocity = () => 42 + palette.velocity + Math.round(64 * intensity) + 2 * randomInt(rng, 0, 5) + (seed & 1);

  const chordWindow = windows && Object.hasOwn(windows, 'chords') ? windows.chords : undefined;
  const bassWindow = windows && Object.hasOwn(windows, 'bass') ? windows.bass : undefined;
  const drumWindow = windows && Object.hasOwn(windows, 'drums') ? windows.drums : undefined;
  for (const window of [chordWindow, bassWindow, drumWindow]) {
    if (window !== undefined && (!window || !Number.isFinite(window.startBeat) ||
        !Number.isFinite(window.endBeat) || window.endBeat < window.startBeat)) {
      return { ok: false, reason: 'クリップの開始位置と終了位置を確認してください。' };
    }
  }

  // Count first. The drum estimate includes duplicates from overlapping chords.
  let count = 0;
  for (const chord of chords) {
    if (!chord || !Number.isFinite(chord.startBeat) || !Number.isFinite(chord.durationBeats)) continue;
    count += compingNoteCount(chordInWindow(chord, chordWindow), pattern);
    const bassInput = chordInWindow(chord, bassWindow);
    const bassSpan = compingTickSpan(bassInput);
    if (bassSpan && compingNoteCount(bassInput, 'whole') > 0) {
      count += bassPlan(bassSpan.end - bassSpan.start, complexity, mood).count;
    }
    const drumSpan = compingTickSpan(chordInWindow(chord, drumWindow));
    if (drumSpan) {
      for (const { step } of slots) {
        const { first, last } = drumBars(drumSpan.start, drumSpan.end, step * barTicks / drumStepsPerBar, barTicks);
        if (last < first) continue;
        if (!Number.isSafeInteger(last * drumStepsPerBar + step)) {
          return { ok: false, reason: 'ドラムの位置が遠すぎます。クリップの開始位置を確認してください。' };
        }
        count += last - first + 1;
      }
    }
    if (count > MAX_COMPING_NOTES) return { ok: false, reason: TOO_MANY_NOTES };
  }

  const validChords = chords.filter((chord) => chord &&
    Number.isFinite(chord.startBeat) && Number.isFinite(chord.durationBeats));
  const chordNotes = compingPattern(validChords.map((chord) => chordInWindow(chord, chordWindow)), pattern, {
    register, voiceLeading: true,
  }).map((note) => ({ ...note, velocity: velocity() }));

  const bass: Note[] = [];
  const drums: DrumNote[] = [];
  const usedDrumSteps = new Set<string>();
  for (const chord of validChords) {
    const bassInput = chordInWindow(chord, bassWindow);
    const bassSpan = compingTickSpan(bassInput);
    if (bassSpan && compingNoteCount(bassInput, 'whole') > 0) {
      const ticks = bassSpan.end - bassSpan.start;
      const { mode } = bassPlan(ticks, complexity, mood);
      const input = { ...bassInput, startBeat: 0, durationBeats: ticks / PPQ };
      for (const note of generateBassLine([input], { mode, key: 'C', scale: 'major', beatsPerBar })) {
        // Snap both ends to a shared tick so adjacent bass notes meet exactly.
        const start = Math.round(note.startBeat * PPQ);
        const end = Math.round((note.startBeat + note.durationBeats) * PPQ);
        bass.push({
          pitch: note.pitch,
          startBeat: (bassSpan.start + start) / PPQ,
          durationBeats: (end - start) / PPQ,
          velocity: velocity(),
        });
      }
    }

    const drumSpan = compingTickSpan(chordInWindow(chord, drumWindow));
    if (!drumSpan) continue;
    for (const { lane, step } of slots) {
      const offset = step * barTicks / drumStepsPerBar;
      const { first, last } = drumBars(drumSpan.start, drumSpan.end, offset, barTicks);
      for (let bar = first; bar <= last; bar += 1) {
        const stepIndex = bar * drumStepsPerBar + step;
        const key = `${lane}:${stepIndex}`;
        if (usedDrumSteps.has(key)) continue;
        usedDrumSteps.add(key);
        drums.push({
          lane, stepIndex, pitch: DRUM_PITCH[lane],
          startBeat: Math.round(bar * barTicks + offset) / PPQ,
          durationBeats: 1 / PPQ,
          velocity: velocity(),
        });
      }
    }
  }
  bass.sort((a, b) => a.startBeat - b.startBeat);
  drums.sort((a, b) => a.stepIndex - b.stepIndex);
  return { ok: true, chords: chordNotes, bass, drums };
}
