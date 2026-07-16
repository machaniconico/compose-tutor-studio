// Beat/time math utilities. All functions are pure.

import type { Project, TempoMapEvent, TimeSignatureMapEvent } from './types';

export type TempoSegment = Readonly<{
  startBeat: number;
  endBeat: number;
  startSeconds: number;
  bpm: number;
}>;

export type TimeSignatureSegment = Readonly<{
  startBeat: number;
  endBeat: number;
  startBar: number;
  endBar: number;
  numerator: number;
  denominator: number;
  beatsPerBar: number;
}>;

/** A reusable, immutable index for map-aware musical-time conversion. */
export type MusicalTimeIndex = Readonly<{
  tempoSegments: readonly TempoSegment[];
  timeSignatureSegments: readonly TimeSignatureSegment[];
  lengthBeats: number;
}>;

export type BarPosition = Readonly<{
  /** Zero-based bar index. */
  bar: number;
  /** Quarter-note beats elapsed from the beginning of `bar`. */
  beatInBar: number;
  timeSignature: readonly [number, number];
}>;

/**
 * Number of quarter-note beats in one bar for a given time signature.
 * A beat here is always a quarter note (the MIDI/PPQ convention), so a bar of
 * `num/den` contains `num * (4 / den)` quarter-note beats.
 */
export function beatsPerBar(timeSignature: readonly [number, number]): number {
  const [num, den] = timeSignature;
  return num * (4 / den);
}

/** Convert a bar index (0-based) to its starting beat for a fixed signature. */
export function barToBeat(bar: number, timeSignature: readonly [number, number]): number {
  return bar * beatsPerBar(timeSignature);
}

/** Convert a beat position to a (possibly fractional) fixed-signature bar. */
export function beatToBar(beat: number, timeSignature: readonly [number, number]): number {
  return beat / beatsPerBar(timeSignature);
}

/** Seconds per quarter-note beat at a fixed tempo. */
export function beatToSeconds(bpm: number): number {
  return 60 / bpm;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

/** Compile tempo and time-signature maps once for repeated conversions. */
export function compileMusicalTime(
  project: Readonly<{
    lengthBeats: number;
    tempoMap: readonly TempoMapEvent[];
    timeSignatureMap: readonly TimeSignatureMapEvent[];
  }>,
): MusicalTimeIndex {
  if (project.tempoMap.length === 0) throw new RangeError('tempoMap must not be empty');
  if (project.timeSignatureMap.length === 0) {
    throw new RangeError('timeSignatureMap must not be empty');
  }

  let elapsedSeconds = 0;
  const tempoSegments = project.tempoMap.map((event, index): TempoSegment => {
    const next = project.tempoMap[index + 1];
    const endBeat = next?.beat ?? Number.POSITIVE_INFINITY;
    const segment = Object.freeze({
      startBeat: event.beat,
      endBeat,
      startSeconds: elapsedSeconds,
      bpm: event.bpm,
    });
    if (next !== undefined) elapsedSeconds += (next.beat - event.beat) * (60 / event.bpm);
    return segment;
  });

  let startBar = 0;
  const timeSignatureSegments = project.timeSignatureMap.map(
    (event, index): TimeSignatureSegment => {
      const next = project.timeSignatureMap[index + 1];
      const segmentBeatsPerBar = beatsPerBar([event.numerator, event.denominator]);
      const endBeat = next?.beat ?? Number.POSITIVE_INFINITY;
      const endBar = next === undefined
        ? Number.POSITIVE_INFINITY
        : startBar + (next.beat - event.beat) / segmentBeatsPerBar;
      const segment = Object.freeze({
        startBeat: event.beat,
        endBeat,
        startBar,
        endBar,
        numerator: event.numerator,
        denominator: event.denominator,
        beatsPerBar: segmentBeatsPerBar,
      });
      startBar = endBar;
      return segment;
    },
  );

  return Object.freeze({
    tempoSegments: Object.freeze(tempoSegments),
    timeSignatureSegments: Object.freeze(timeSignatureSegments),
    lengthBeats: project.lengthBeats,
  });
}

function tempoSegmentAtBeat(index: MusicalTimeIndex, beat: number): TempoSegment {
  assertFinite(beat, 'beat');
  for (let i = index.tempoSegments.length - 1; i >= 0; i -= 1) {
    const segment = index.tempoSegments[i];
    if (segment !== undefined && beat >= segment.startBeat) return segment;
  }
  const first = index.tempoSegments[0];
  if (first === undefined) throw new RangeError('tempo index must not be empty');
  return first;
}

function signatureSegmentAtBeat(index: MusicalTimeIndex, beat: number): TimeSignatureSegment {
  const segment = index.timeSignatureSegments[signatureSegmentIndexAtBeat(index, beat)];
  if (segment === undefined) throw new RangeError('time-signature index must not be empty');
  return segment;
}

/** Convert an absolute beat position to seconds using the compiled tempo map. */
export function beatToSecondsAt(index: MusicalTimeIndex, beat: number): number {
  const segment = tempoSegmentAtBeat(index, beat);
  return segment.startSeconds + (beat - segment.startBeat) * (60 / segment.bpm);
}

/** Convert absolute seconds back to a beat position using the compiled tempo map. */
export function secondsToBeatAt(index: MusicalTimeIndex, seconds: number): number {
  assertFinite(seconds, 'seconds');
  for (let i = index.tempoSegments.length - 1; i >= 0; i -= 1) {
    const segment = index.tempoSegments[i];
    if (segment !== undefined && seconds >= segment.startSeconds) {
      return segment.startBeat + (seconds - segment.startSeconds) / (60 / segment.bpm);
    }
  }
  const first = index.tempoSegments[0];
  if (first === undefined) throw new RangeError('tempo index must not be empty');
  return first.startBeat + (seconds - first.startSeconds) / (60 / first.bpm);
}

/** Duration in seconds between two beat positions. */
export function secondsBetweenBeats(
  index: MusicalTimeIndex,
  startBeat: number,
  endBeat: number,
): number {
  return beatToSecondsAt(index, endBeat) - beatToSecondsAt(index, startBeat);
}

/** Convert a zero-based integer bar index to its absolute start beat. */
export function barToBeatAt(index: MusicalTimeIndex, bar: number): number {
  assertFinite(bar, 'bar');
  if (!Number.isSafeInteger(bar) || bar < 0) {
    throw new RangeError('bar must be a non-negative safe integer');
  }
  const segments = index.timeSignatureSegments;
  if (segments.length === 0) throw new RangeError('time-signature index must not be empty');
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const segment = segments[middle];
    if (segment !== undefined && segment.startBar <= bar) low = middle + 1;
    else high = middle;
  }
  const segment = segments[Math.max(0, low - 1)];
  if (segment === undefined) throw new RangeError('time-signature index must not be empty');
  return segment.startBeat + (bar - segment.startBar) * segment.beatsPerBar;
}

/** Resolve an absolute beat to its zero-based bar and beat within that bar. */
export function beatToBarPosition(index: MusicalTimeIndex, beat: number): BarPosition {
  const segment = signatureSegmentAtBeat(index, beat);
  const fractionalBar = segment.startBar + (beat - segment.startBeat) / segment.beatsPerBar;
  const bar = Math.floor(fractionalBar);
  const beatInBar = beat - barToBeatAt(index, bar);
  return Object.freeze({
    bar,
    beatInBar,
    timeSignature: Object.freeze([segment.numerator, segment.denominator]) as readonly [number, number],
  });
}

/** Time signature active at an absolute beat. */
export function timeSignatureAtBeat(
  index: MusicalTimeIndex,
  beat: number,
): readonly [number, number] {
  const segment = signatureSegmentAtBeat(index, beat);
  return Object.freeze([segment.numerator, segment.denominator]);
}

export type DrumStepTiming = Readonly<{
  beat: number;
  beatsPerBar: number;
}>;

export type DrumStepProjectionSegment = Readonly<{
  /** First zero-based clip-local bar covered by this segment. */
  startBar: number;
  /** Absolute project beat at `startBar`. */
  startBeat: number;
  beatsPerBar: number;
}>;

/**
 * Immutable clip-local index for repeated drum step projection.
 *
 * `segments` contains only the local-bar thresholds where the active time
 * signature changes. Compiling is O(M log M) for M signature-map entries and
 * each subsequent projection is O(log M), independent of event count.
 */
export type DrumStepProjector = Readonly<{
  clipStartBeat: number;
  stepsPerBar: number;
  segments: readonly DrumStepProjectionSegment[];
}>;

function signatureSegmentIndexAtBeat(index: MusicalTimeIndex, beat: number): number {
  assertFinite(beat, 'beat');
  const segments = index.timeSignatureSegments;
  if (segments.length === 0) throw new RangeError('time-signature index must not be empty');
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const segment = segments[middle];
    if (segment !== undefined && segment.startBeat <= beat) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

/** Compile one clip start and step resolution for repeated drum projections. */
export function compileDrumStepProjector(
  stepsPerBar: number,
  clipStartBeat: number,
  musicalTime: MusicalTimeIndex,
): DrumStepProjector {
  const steps = Number.isSafeInteger(stepsPerBar) && stepsPerBar > 0
    ? stepsPerBar
    : 16;
  assertFinite(clipStartBeat, 'clipStartBeat');

  const projectionSegments: DrumStepProjectionSegment[] = [];
  let startBar = 0;
  let startBeat = clipStartBeat;
  // A valid, strictly increasing map can cross each signature threshold only
  // once. The explicit bound also keeps direct use with a malformed compiled
  // index finite; validateProject rejects such maps before calling us.
  const maxSegments = musicalTime.timeSignatureSegments.length + 1;
  for (let iteration = 0; iteration < maxSegments; iteration += 1) {
    const signatureIndex = signatureSegmentIndexAtBeat(musicalTime, startBeat);
    const signature = musicalTime.timeSignatureSegments[signatureIndex];
    if (signature === undefined) throw new RangeError('time-signature index must not be empty');
    const segmentBeatsPerBar = Number.isFinite(signature.beatsPerBar)
      && signature.beatsPerBar > 0
      ? signature.beatsPerBar
      : 4;
    projectionSegments.push(Object.freeze({
      startBar,
      startBeat,
      beatsPerBar: segmentBeatsPerBar,
    }));

    if (!Number.isFinite(signature.endBeat)) break;
    const beatsUntilNextSignature = signature.endBeat - startBeat;
    if (!Number.isFinite(beatsUntilNextSignature) || beatsUntilNextSignature <= 0) break;
    const barsUntilNextSignature = Math.max(
      1,
      Math.ceil(beatsUntilNextSignature / segmentBeatsPerBar),
    );
    const nextBar = startBar + barsUntilNextSignature;
    const nextBeat = startBeat + barsUntilNextSignature * segmentBeatsPerBar;
    if (!Number.isFinite(nextBar) || !Number.isFinite(nextBeat)) break;
    startBar = nextBar;
    startBeat = nextBeat;
  }

  return Object.freeze({
    clipStartBeat,
    stepsPerBar: steps,
    segments: Object.freeze(projectionSegments),
  });
}

/** Project one clip-local step through a previously compiled projector. */
export function projectDrumStep(
  projector: DrumStepProjector,
  stepIndex: number,
): DrumStepTiming {
  const safeStep = Number.isInteger(stepIndex) && stepIndex >= 0
    ? stepIndex
    : 0;
  const localBar = Math.floor(safeStep / projector.stepsPerBar);
  const stepInBar = safeStep - localBar * projector.stepsPerBar;
  let low = 0;
  let high = projector.segments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const segment = projector.segments[middle];
    if (segment !== undefined && segment.startBar <= localBar) low = middle + 1;
    else high = middle;
  }
  const segment = projector.segments[Math.max(0, low - 1)];
  if (segment === undefined) throw new RangeError('drum-step projector must not be empty');
  const barStartBeat = segment.startBeat
    + (localBar - segment.startBar) * segment.beatsPerBar;
  return Object.freeze({
    beat: barStartBeat + stepInBar * (segment.beatsPerBar / projector.stepsPerBar),
    beatsPerBar: segment.beatsPerBar,
  });
}

/**
 * Project one clip-local drum step through the signature active at each local
 * bar start. Segment-sized jumps keep even hostile large step indexes bounded
 * by the time-signature-map size rather than by the number of skipped bars.
 */
export function drumStepToBeatOnTimeline(
  stepIndex: number,
  stepsPerBar: number,
  clipStartBeat: number,
  musicalTime: MusicalTimeIndex,
): DrumStepTiming {
  return projectDrumStep(
    compileDrumStepProjector(stepsPerBar, clipStartBeat, musicalTime),
    stepIndex,
  );
}

/** Total length of the project in quarter-note beats. */
export function projectLengthBeats(project: Pick<Project, 'lengthBeats'>): number {
  return project.lengthBeats;
}
