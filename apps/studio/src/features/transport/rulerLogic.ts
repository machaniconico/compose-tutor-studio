// Pure rules for the timeline ruler: where a click seeks and what a drag selects.
// The loop range is runtime transport state, so nothing here touches the Project.
import { PPQ } from '@cts/project-model';

/** Pointer travel (px) that turns a press on the ruler into a loop-range drag. */
export const RULER_DRAG_MIN_PX = 4;

/** Shortest loop the ruler will select: one beat (PPQ ticks). */
export const MIN_RULER_LOOP_BEATS = 1;

export type RulerLoopResult =
  | Readonly<{ ok: true; startBeat: number; endBeat: number }>
  | Readonly<{ ok: false; reason: string }>;

function songEndTick(lengthBeats: number): number {
  return Number.isFinite(lengthBeats) && lengthBeats > 0 ? Math.floor(lengthBeats * PPQ + 1e-9) : 0;
}

function clampTick(tick: number, endTick: number): number {
  return Math.min(endTick, Math.max(0, tick));
}

/**
 * Beat under a ruler x position, snapped to the nearest whole beat (a whole
 * number of ticks) and clamped to [0, song end]. Bad input gives 0.
 */
export function rulerXToBeat(x: number, pxPerBeat: number, lengthBeats: number): number {
  const endTick = songEndTick(lengthBeats);
  if (!Number.isFinite(x) || !Number.isFinite(pxPerBeat) || pxPerBeat <= 0) return 0;
  const beatTick = Math.round(x / pxPerBeat) * PPQ;
  return clampTick(beatTick, endTick) / PPQ;
}

/**
 * Loop range for a drag between two beats: whole beats only (so whole ticks),
 * at least one beat, inside the song (a fractional song end counts as its floor). A drag shorter than a beat grows to one beat; a
 * right-to-left drag is swapped. Refuses with a beginner-friendly reason.
 */
export function loopRangeFromDrag(
  fromBeat: number,
  toBeat: number,
  lengthBeats: number,
): RulerLoopResult {
  // Whole beats are the loop domain: a fractional song end gives floor(end).
  const endLimit = Math.floor(songEndTick(lengthBeats) / PPQ) * PPQ;
  const minTicks = MIN_RULER_LOOP_BEATS * PPQ;
  if (endLimit < minTicks) {
    return { ok: false, reason: '曲が1拍より短いので、くり返す範囲を決められません。' };
  }
  if (!Number.isFinite(fromBeat) || !Number.isFinite(toBeat)) {
    return { ok: false, reason: 'くり返す範囲の位置が読み取れませんでした。もう一度ドラッグしてください。' };
  }
  const a = clampTick(Math.round(fromBeat) * PPQ, endLimit);
  const b = clampTick(Math.round(toBeat) * PPQ, endLimit);
  let start = Math.min(a, b);
  let end = Math.max(a, b);
  if (end - start < minTicks) {
    end = start + minTicks;
    if (end > endLimit) {
      end = endLimit;
      start = end - minTicks;
    }
  }
  return { ok: true, startBeat: start / PPQ, endBeat: end / PPQ };
}

/** Safe Japanese text for a thrown or odd value, so `{toString:null}` cannot throw. */
export function safeReasonText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
