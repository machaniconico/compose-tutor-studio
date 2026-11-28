import { MAX_FILTER_CUTOFF_OCTAVES } from '../automation-targets';
import { beatTick, PPQ } from '../ticks';
import type { AutomationLane, AutomationTarget } from '../types';
import { clamp, type LegacyTrack } from './input';
import type { Report } from './report';

const TARGETS = {
  volume: 'track-volume',
  pan: 'track-pan',
  cutoff: 'track-filter-cutoff',
} as const satisfies Record<string, AutomationTarget['type']>;

type Point = { beat: number; value: number; fromInput?: true };

/** Keep the original linear ramp until it reaches a clamp boundary. */
function insertCrossings(points: Point[], min: number, max: number): Point[] {
  return points.flatMap((point, index) => {
    const previous = points[index - 1];
    const crossings: Point[] = [];
    if (previous) {
      for (const bound of [min, max]) {
        if (bound <= Math.min(previous.value, point.value) || bound >= Math.max(previous.value, point.value)) continue;
        const fraction = (bound - previous.value) / (point.value - previous.value);
        const beat = previous.beat + (point.beat - previous.beat) * fraction;
        if (beat > previous.beat && beat < point.beat) crossings.push({ beat, value: bound });
      }
      crossings.sort((a, b) => a.beat - b.beat);
    }
    return [...crossings, { ...point, value: clamp(point.value, min, max) }];
  });
}

function fitSong(points: Point[], lengthBeats: number): Point[] {
  const firstOutside = points.findIndex((point) => point.beat > lengthBeats);
  if (firstOutside === -1) return points;
  const inside = points.slice(0, firstOutside);
  const previous = inside.at(-1);
  if (previous && previous.beat < lengthBeats) {
    const next = points[firstOutside]!;
    const fraction = (lengthBeats - previous.beat) / (next.beat - previous.beat);
    inside.push({ beat: lengthBeats, value: previous.value + (next.value - previous.value) * fraction });
  }
  return inside;
}

export function convertAutomation(
  track: LegacyTrack, lengthBeats: number, makeId: (seed: string) => string, report: Report,
): AutomationLane[] {
  const trackId = track.id;
  const lanes: AutomationLane[] = [];
  for (const [parameter, lane] of Object.entries(track.automation ?? {})) {
    if (track.type === 'master' || !Object.hasOwn(TARGETS, parameter)
        || (parameter === 'cutoff' && track.type !== 'instrument')) {
      report('automation-lane-dropped', { trackId, detail: { parameter } });
      continue;
    }
    if (!Array.isArray(lane.points)) throw new TypeError('Invalid Wave5 automation lane');
    if (lane.points.length === 0) continue;
    const target = TARGETS[parameter as keyof typeof TARGETS];
    const byBeat = new Map<number, number>();
    let lastBeat = -1;
    for (const { beat, value } of lane.points) {
      if (!Number.isFinite(beat) || beat < 0 || beat < lastBeat || !Number.isFinite(value) ||
        (parameter === 'cutoff' && value <= 0)) throw new TypeError('Invalid Wave5 automation point');
      byBeat.set(beat, value);
      lastBeat = beat;
    }
    // Count original points removed, including duplicates beyond the song.
    // Clamp crossings and the interpolated endpoint are synthesized below.
    const count = lane.points.length - [...byBeat.keys()].filter((beat) => beat <= lengthBeats).length;
    if (count > 0) report('automation-point-dropped', { trackId, detail: { parameter, count } });
    let points: Point[] = Array.from(byBeat, ([beat, value]) => ({
      beat,
      fromInput: true,
      value: parameter === 'volume' ? track.volume * value
        : parameter === 'pan' ? track.pan + value : Math.log2(value),
    }));
    const first = points[0]!;
    if (first.beat > 0) points.unshift({ beat: 0, value: first.value });
    if (parameter === 'pan') points = insertCrossings(points, -1, 1);
    if (parameter === 'cutoff') {
      points = insertCrossings(points, -MAX_FILTER_CUTOFF_OCTAVES, MAX_FILTER_CUTOFF_OCTAVES);
    }
    const fitted = new Map<number, number>();
    const lastTick = Math.floor(lengthBeats * PPQ);
    for (const { beat, value, fromInput } of fitSong(points, lengthBeats)) {
      const outputBeat = fromInput ? Math.min(beatTick(beat), lastTick) / PPQ : beat;
      fitted.set(outputBeat, value);
    }
    const id = makeId(`${trackId}-${parameter}`);
    lanes.push({
      id,
      bypassed: false,
      target: { type: target, trackId },
      // A rounded source beat can move past a nearby synthesized point.
      points: [...fitted].sort(([a], [b]) => a - b).map(([beat, value], index) => ({
        id: makeId(`${id}-${index + 1}`), beat, value, interpolation: 'linear',
      })),
    });
  }
  return lanes;
}
