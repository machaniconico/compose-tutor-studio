import {
  getDiatonicChords,
  PROGRESSION_TEMPLATES,
  realizeProgression,
  borrowedChords,
  dominantMotionChords,
  type ScaleName,
} from '@cts/theory-engine';

export type PaletteTab = 'diatonic' | 'progressions' | 'borrowed' | 'dominant';

export type ChordPaletteCandidate = {
  symbol: string;
  degree: string;
  reason: string;
};

export type ProgressionPaletteCandidate = {
  id: string;
  name: string;
  degrees: string;
  symbols: string[];
  reason: string;
};

export function diatonicPalette(key: string, scale: ScaleName): ChordPaletteCandidate[] {
  return getDiatonicChords(key, scale).map((chord) => ({
    symbol: chord.symbol,
    degree: chord.degree,
    reason: 'キーの中だけで作った基本コードなので、メロディとなじみやすいです。',
  }));
}

export function progressionPalette(key: string, scale: ScaleName): ProgressionPaletteCandidate[] {
  return PROGRESSION_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    degrees: template.degrees.join('-'),
    symbols: realizeProgression(template.id, key, scale),
    reason: template.description,
  }));
}

export function borrowedPalette(key: string, scale: ScaleName): ChordPaletteCandidate[] {
  return borrowedChords(key, scale).map((chord) => ({
    symbol: chord.symbol,
    degree: chord.degree,
    reason: chord.reason,
  }));
}

export function dominantPalette(
  key: string,
  scale: ScaleName,
  targetSymbol?: string,
): ChordPaletteCandidate[] {
  return dominantMotionChords({
    key,
    scale,
    ...(targetSymbol !== undefined ? { targetSymbol } : {}),
  }).map((chord) => ({
    symbol: chord.symbol,
    degree: chord.degree,
    reason: chord.reason,
  }));
}
