import {
  getDiatonicChords,
  PROGRESSION_TEMPLATES,
  realizeProgression,
  borrowedChords,
  dominantMotionChords,
  voiceChord,
  type ScaleName,
} from '@cts/theory-engine';
import type { InstrumentConfig, Project } from '@cts/project-model';
import { previewChord } from '../../audio/livePreview';
import { CHORD_VOICING_REGISTER } from '../../state/editorActions';

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

/** Close voicing from C4 used to audition a chord; empty for an unreadable symbol. */
export function chordPreviewMidis(symbol: string): number[] {
  try {
    return voiceChord(symbol.trim(), { style: 'close', register: CHORD_VOICING_REGISTER });
  } catch {
    return [];
  }
}

/** Audition a chord symbol with the chords track's instrument (no-op when unreadable). */
export function auditionChord(project: Project, symbol: string): void {
  const midis = chordPreviewMidis(symbol);
  if (midis.length === 0) return;
  const instrument: InstrumentConfig | undefined = project.tracks.find((t) => t.role === 'chords')?.instrument;
  void previewChord(midis, instrument).catch(() => undefined);
}
