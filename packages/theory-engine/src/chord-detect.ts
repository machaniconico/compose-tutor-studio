import { buildChordSymbol, chordIntervals } from './chords';
import { pitchClassToSharpName } from './pitch';
import type { ChordQuality } from './types';

const PPQ = 480;
export const MAX_CHORD_DETECTION_SEGMENTS = 256;
export const MAX_CHORD_DETECTION_CANDIDATES = 8;
export const MAX_CHORD_DETECTION_NOTES = 16_384;
const MAX_TICKS = 16_384 * PPQ;

export type ChordDetectionNote = {
  pitch: number;
  startBeat: number;
  durationBeats: number;
};

export type ChordDetectionOptions = {
  segmentBeats: number;
  /** Optional clip boundary, in beats relative to the start of the clip. */
  lengthBeats?: number;
};

export type ChordDetectionCandidate = {
  symbol: string;
  /** The candidate's pitch classes, including a slash bass if specified. */
  pitchClasses: number[];
  bassPitchClass: number;
  matchingCount: number;
  extraCount: number;
  score: number;
};

export type ChordDetectionSegment = {
  startBeat: number;
  durationBeats: number;
  candidates: ChordDetectionCandidate[];
};

const QUALITIES: readonly ChordQuality[] = [
  'major', 'minor', 'diminished', 'augmented', 'sus2', 'sus4',
  'major7', 'minor7', 'dominant7', 'minor7b5', 'diminished7', 'minorMajor7', '6', 'minor6',
];

const templates = QUALITIES.flatMap((quality) => {
  const intervals = chordIntervals(quality);
  return Array.from({ length: 12 }, (_, root) => ({
    root,
    symbol: buildChordSymbol(root, quality),
    pitchClasses: intervals.map((interval) => (root + interval) % 12),
  }));
});

function validNote(note: ChordDetectionNote): boolean {
  return !!note && Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 &&
    Number.isFinite(note.startBeat) && Number.isFinite(note.durationBeats) && note.durationBeats > 0;
}

type RankedCandidate = {
  candidate: ChordDetectionCandidate;
  missingCount: number;
  externalBass: boolean;
};

function rankCandidates(pitchMask: number, lowestMidi: number): ChordDetectionCandidate[] {
  const observedCount = countBits(pitchMask);
  if (observedCount < 2) return [];

  const bass = lowestMidi % 12;
  const ranked: RankedCandidate[] = [];
  for (const { root, symbol, pitchClasses } of templates) {
    const matches = pitchClasses.reduce((count, pc) => count + ((pitchMask >> pc) & 1), 0);
    const missingCount = pitchClasses.length - matches;
    const extraCount = observedCount - matches;

    if (missingCount === 0 && bass !== root) {
      const externalBass = !pitchClasses.includes(bass);
      const matchingCount = matches + Number(externalBass);
      const slashExtra = observedCount - matchingCount;
      if (matchingCount > slashExtra) {
        ranked.push({
          missingCount,
          externalBass,
          candidate: {
            symbol: `${symbol}/${pitchClassToSharpName(bass)}`,
            pitchClasses: externalBass ? [...pitchClasses, bass] : [...pitchClasses],
            bassPitchClass: bass,
            matchingCount,
            extraCount: slashExtra,
            score: matchingCount - slashExtra,
          },
        });
      }
    }

    if (matches >= 2 && matches > extraCount) {
      ranked.push({
        missingCount,
        externalBass: false,
        candidate: {
          symbol,
          pitchClasses: [...pitchClasses],
          bassPitchClass: root,
          matchingCount: matches,
          extraCount,
          score: matches - extraCount,
        },
      });
    }
  }

  // Stable sort keeps template order (quality, then root) for remaining ties.
  return ranked.sort((a, b) =>
    b.candidate.score - a.candidate.score ||
    a.missingCount - b.missingCount ||
    Number(a.externalBass) - Number(b.externalBass) ||
    Number(b.candidate.bassPitchClass === bass) - Number(a.candidate.bassPitchClass === bass)
  ).slice(0, MAX_CHORD_DETECTION_CANDIDATES).map(({ candidate }) => candidate);
}

function countBits(mask: number): number {
  let count = 0;
  for (let remaining = mask; remaining !== 0; remaining &= remaining - 1) count++;
  return count;
}

/**
 * Detect chord interpretations in half-open, clip-relative tick segments.
 * Notes count in every segment they overlap. With no explicit clip length,
 * the final segment reaches the next segment boundary after the last note.
 * Invalid sizes and oversized inputs return an empty result.
 */
export function detectChords(
  notes: readonly ChordDetectionNote[],
  options: ChordDetectionOptions | null,
): ChordDetectionSegment[] {
  if (!Array.isArray(notes) || options === null || typeof options !== 'object') return [];
  const { segmentBeats, lengthBeats } = options;
  if (notes.length > MAX_CHORD_DETECTION_NOTES || !Number.isFinite(segmentBeats) || segmentBeats <= 0) return [];
  const segmentTicks = Math.round(segmentBeats * PPQ);
  if (!Number.isSafeInteger(segmentTicks) || segmentTicks < 1 || segmentTicks > MAX_TICKS) return [];

  const maxEnd = Math.min(MAX_TICKS, segmentTicks * MAX_CHORD_DETECTION_SEGMENTS);
  let clipEndTick: number;
  if (lengthBeats !== undefined) {
    if (!Number.isFinite(lengthBeats)) return [];
    clipEndTick = Math.round(lengthBeats * PPQ);
    if (!Number.isSafeInteger(clipEndTick) || clipEndTick < 1 || clipEndTick > maxEnd) return [];
  } else {
    let lastEnd = 0;
    // Preflight before allocating any per-note or per-segment data.
    for (const note of notes) {
      if (!validNote(note)) continue;
      const start = Math.max(0, Math.round(note.startBeat * PPQ));
      const end = Math.round((note.startBeat + note.durationBeats) * PPQ);
      if (end > maxEnd) return [];
      if (end <= start) continue;
      lastEnd = Math.max(lastEnd, end);
    }
    clipEndTick = Math.min(MAX_TICKS, Math.ceil(lastEnd / segmentTicks) * segmentTicks);
  }

  const count = Math.ceil(clipEndTick / segmentTicks);
  const pitchMasks = new Uint16Array(count);
  const lowestMidi = new Uint8Array(count).fill(128);
  for (const note of notes) {
    if (!validNote(note)) continue;
    const start = Math.max(0, Math.round(note.startBeat * PPQ));
    const end = Math.min(clipEndTick, Math.round((note.startBeat + note.durationBeats) * PPQ));
    if (end <= start) continue;
    const pitchBit = 1 << (note.pitch % 12);
    const endSegment = Math.ceil(end / segmentTicks);
    for (let i = Math.floor(start / segmentTicks); i < endSegment; i++) {
      pitchMasks[i] = pitchMasks[i]! | pitchBit;
      lowestMidi[i] = Math.min(lowestMidi[i]!, note.pitch);
    }
  }

  return Array.from(pitchMasks, (pitchMask, i) => ({
    startBeat: i * segmentTicks / PPQ,
    durationBeats: Math.min(segmentTicks, clipEndTick - i * segmentTicks) / PPQ,
    candidates: rankCandidates(pitchMask, lowestMidi[i]!),
  }));
}
