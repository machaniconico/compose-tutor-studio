// Shared timeline geometry helpers used by the lane/editor components.
// Crude pixel mapping for the skeleton; wave 2 will replace with real layout.

/** Pixels per beat at zoom 1. */
export const BASE_PX_PER_BEAT = 28;

/** Pixels per beat at a given horizontal zoom factor. */
export function pxPerBeat(zoomX: number): number {
  return BASE_PX_PER_BEAT * zoomX;
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
