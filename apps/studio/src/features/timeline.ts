// Shared timeline geometry helpers used by the lane/editor components.
// Crude pixel mapping for the skeleton; wave 2 will replace with real layout.

/** Pixels per beat at zoom 1. */
export const BASE_PX_PER_BEAT = 28;

/** Pixels per beat at a given horizontal zoom factor. */
export function pxPerBeat(zoomX: number): number {
  return BASE_PX_PER_BEAT * zoomX;
}

/**
 * Pixels per beat for a grid of clickable steps: the shared scale, widened only
 * as far as needed to keep each step at least `minStepPx` wide.
 */
export function stepGridPxPerBeat(
  zoomX: number,
  stepsPerBar: number,
  beatsPerBar: number,
  minStepPx: number,
): number {
  return Math.max(pxPerBeat(zoomX), (minStepPx * stepsPerBar) / beatsPerBar);
}

/** Total project width in pixels. */
export function timelineWidth(lengthBeats: number, zoomX: number): number {
  return lengthBeats * pxPerBeat(zoomX);
}

/** Format a beat position as bar.beat (1-based) for display. */
export function formatPosition(beat: number, beatsPerBar: number): string {
  const safeBpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const bar = Math.floor(beat / safeBpb) + 1;
  const beatInBar = Math.floor(beat % safeBpb) + 1;
  return `${bar}.${beatInBar}`;
}

/** Seek granularity: bar start by default, nearest-below beat with Shift. */
export type SeekSnap = 'bar' | 'beat';

/**
 * Convert an x offset on the timeline (px from its left edge) to a beat to
 * seek to. Snaps down to the bar start (or beat start) and stays inside the
 * project, so a click inside bar 3 seeks to the start of bar 3.
 */
export function xToSeekBeat(
  x: number,
  zoomX: number,
  beatsPerBar: number,
  lengthBeats: number,
  snap: SeekSnap,
): number {
  const safeBpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const raw = x / pxPerBeat(zoomX);
  const unit = snap === 'beat' ? 1 : safeBpb;
  const snapped = Math.floor(raw / unit + 1e-9) * unit;
  return Math.min(Math.max(0, snapped), Math.max(0, lengthBeats));
}

/** Where a keyboard seek lands: the song start, or the previous/next bar start. */
export function keyboardSeekBeat(
  action: 'seekToStart' | 'seekBarBack' | 'seekBarForward',
  positionBeat: number,
  beatsPerBar: number,
  lengthBeats: number,
): number {
  const safeBpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const bar = Math.floor(positionBeat / safeBpb + 1e-9);
  const target =
    action === 'seekToStart'
      ? 0
      : action === 'seekBarForward'
        ? (bar + 1) * safeBpb
        : // Mid-bar goes to this bar's start; already at a bar start goes to the previous one.
          (positionBeat - bar * safeBpb > 1e-9 ? bar : bar - 1) * safeBpb;
  return Math.min(Math.max(0, target), Math.max(0, lengthBeats));
}
