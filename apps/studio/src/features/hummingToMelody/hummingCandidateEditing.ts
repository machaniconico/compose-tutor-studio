import type { HummingMelodyNote } from '../../audio/hummingTranscription';

export const MIN_HUMMING_SEGMENT_SECONDS = 0.06;
export const MAX_HUMMING_PITCH_SEGMENTS = 512;
export const DEFAULT_HUMMING_CANDIDATE_HISTORY_LIMIT = 100;
export const MAX_HUMMING_CANDIDATE_HISTORY_LIMIT = 100;

const TIMING_EPSILON_SECONDS = 1e-9;

export type HummingPitchSegment = Readonly<{
  id: string;
  startSeconds: number;
  endSeconds: number;
  midi: number;
  confidence: number;
}>;

export type HummingPitchDraft = Readonly<{
  sourceDurationSeconds: number;
  segments: readonly HummingPitchSegment[];
}>;

export type HummingCandidateEditErrorCode =
  | 'invalid-source-duration'
  | 'invalid-time'
  | 'invalid-pitch'
  | 'invalid-confidence'
  | 'invalid-segment-id'
  | 'duplicate-segment-id'
  | 'segment-limit-exceeded'
  | 'segment-not-found'
  | 'duration-too-short'
  | 'out-of-bounds'
  | 'segments-not-sorted'
  | 'segments-overlap'
  | 'no-next-segment'
  | 'invalid-history'
  | 'source-duration-mismatch';

export class HummingCandidateEditError extends Error {
  constructor(readonly code: HummingCandidateEditErrorCode) {
    super(code);
    this.name = 'HummingCandidateEditError';
  }
}

export type HummingCandidateHistory = Readonly<{
  initial: HummingPitchDraft;
  current: HummingPitchDraft;
  undoStack: readonly HummingPitchDraft[];
  redoStack: readonly HummingPitchDraft[];
  limit: number;
}>;

type DraftOptions = Readonly<{
  sourceDurationSeconds: number;
  createId: () => string;
}>;

type SegmentBoundary = 'start' | 'end';

function assertFiniteTime(value: number): void {
  if (!Number.isFinite(value)) {
    throw new HummingCandidateEditError('invalid-time');
  }
}

function assertPitch(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new HummingCandidateEditError('invalid-pitch');
  }
}

function assertConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new HummingCandidateEditError('invalid-confidence');
  }
}

function assertSegmentId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HummingCandidateEditError('invalid-segment-id');
  }
}

function nextId(createId: () => string): string {
  if (typeof createId !== 'function') {
    throw new HummingCandidateEditError('invalid-segment-id');
  }
  let id: string;
  try {
    id = createId();
  } catch {
    throw new HummingCandidateEditError('invalid-segment-id');
  }
  assertSegmentId(id);
  return id;
}

function assertSourceDuration(sourceDurationSeconds: number): void {
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    throw new HummingCandidateEditError('invalid-source-duration');
  }
}

function assertSegmentShape(
  segment: HummingPitchSegment,
  sourceDurationSeconds: number,
): void {
  assertSegmentId(segment.id);
  assertFiniteTime(segment.startSeconds);
  assertFiniteTime(segment.endSeconds);
  assertPitch(segment.midi);
  assertConfidence(segment.confidence);
  if (
    segment.startSeconds < 0
    || segment.endSeconds > sourceDurationSeconds
  ) {
    throw new HummingCandidateEditError('out-of-bounds');
  }
  if (
    segment.endSeconds <= segment.startSeconds
    || (
      segment.endSeconds
      - segment.startSeconds
      + TIMING_EPSILON_SECONDS
      < MIN_HUMMING_SEGMENT_SECONDS
    )
  ) {
    throw new HummingCandidateEditError('duration-too-short');
  }
}

function assertDraft(draft: HummingPitchDraft): void {
  assertSourceDuration(draft.sourceDurationSeconds);
  if (!Array.isArray(draft.segments)) {
    throw new HummingCandidateEditError('invalid-history');
  }
  if (draft.segments.length > MAX_HUMMING_PITCH_SEGMENTS) {
    throw new HummingCandidateEditError('segment-limit-exceeded');
  }
  const ids = new Set<string>();
  let previous: HummingPitchSegment | null = null;
  for (const segment of draft.segments) {
    assertSegmentShape(segment, draft.sourceDurationSeconds);
    if (ids.has(segment.id)) {
      throw new HummingCandidateEditError('duplicate-segment-id');
    }
    ids.add(segment.id);
    if (previous && segment.startSeconds < previous.startSeconds) {
      throw new HummingCandidateEditError('segments-not-sorted');
    }
    if (previous && segment.startSeconds < previous.endSeconds) {
      throw new HummingCandidateEditError('segments-overlap');
    }
    previous = segment;
  }
}

function snapshotDraft(draft: HummingPitchDraft): HummingPitchDraft {
  assertDraft(draft);
  return {
    sourceDurationSeconds: draft.sourceDurationSeconds,
    segments: draft.segments.map((segment) => ({ ...segment })),
  };
}

function draftWithSegments(
  draft: HummingPitchDraft,
  segments: readonly HummingPitchSegment[],
): HummingPitchDraft {
  const next: HummingPitchDraft = {
    sourceDurationSeconds: draft.sourceDurationSeconds,
    segments,
  };
  assertDraft(next);
  return next;
}

function segmentIndex(draft: HummingPitchDraft, id: string): number {
  assertDraft(draft);
  assertSegmentId(id);
  const index = draft.segments.findIndex((segment) => segment.id === id);
  if (index < 0) throw new HummingCandidateEditError('segment-not-found');
  return index;
}

function replaceSegment(
  draft: HummingPitchDraft,
  index: number,
  segment: HummingPitchSegment,
): HummingPitchDraft {
  const segments = draft.segments.map((candidate, candidateIndex) =>
    candidateIndex === index ? segment : candidate
  );
  return draftWithSegments(draft, segments);
}

function sameSegment(
  left: HummingPitchSegment,
  right: HummingPitchSegment,
): boolean {
  return (
    left.id === right.id
    && left.startSeconds === right.startSeconds
    && left.endSeconds === right.endSeconds
    && left.midi === right.midi
    && left.confidence === right.confidence
  );
}

function sameDraft(left: HummingPitchDraft, right: HummingPitchDraft): boolean {
  return (
    left.sourceDurationSeconds === right.sourceDurationSeconds
    && left.segments.length === right.segments.length
    && left.segments.every((segment, index) => {
      const candidate = right.segments[index];
      return candidate !== undefined && sameSegment(segment, candidate);
    })
  );
}

function assertHistory(history: HummingCandidateHistory): void {
  if (
    !Number.isInteger(history.limit)
    || history.limit < 1
    || history.limit > MAX_HUMMING_CANDIDATE_HISTORY_LIMIT
    || history.undoStack.length > history.limit
    || history.redoStack.length > history.limit
  ) {
    throw new HummingCandidateEditError('invalid-history');
  }
  const drafts = [
    history.initial,
    history.current,
    ...history.undoStack,
    ...history.redoStack,
  ];
  for (const draft of drafts) {
    assertDraft(draft);
    if (draft.sourceDurationSeconds !== history.initial.sourceDurationSeconds) {
      throw new HummingCandidateEditError('source-duration-mismatch');
    }
  }
}

/**
 * Convert transcription notes into a sorted, stable-id editing draft.
 * The generated ids stay attached to their source notes after sorting.
 */
export function createHummingPitchDraft(
  notes: readonly HummingMelodyNote[],
  options: DraftOptions,
): HummingPitchDraft {
  assertSourceDuration(options.sourceDurationSeconds);
  if (notes.length > MAX_HUMMING_PITCH_SEGMENTS) {
    throw new HummingCandidateEditError('segment-limit-exceeded');
  }
  const segments = notes.map((note): HummingPitchSegment => {
    assertFiniteTime(note.startSeconds);
    assertFiniteTime(note.durationSeconds);
    assertPitch(note.midi);
    assertConfidence(note.confidence);
    const endSeconds = note.startSeconds + note.durationSeconds;
    if (!Number.isFinite(endSeconds)) {
      throw new HummingCandidateEditError('invalid-time');
    }
    return {
      id: nextId(options.createId),
      startSeconds: note.startSeconds,
      endSeconds,
      midi: note.midi,
      confidence: note.confidence,
    };
  });
  segments.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds
      || left.endSeconds - right.endSeconds
      || left.id.localeCompare(right.id),
  );
  return draftWithSegments(
    { sourceDurationSeconds: options.sourceDurationSeconds, segments: [] },
    segments,
  );
}

export function setHummingSegmentPitch(
  draft: HummingPitchDraft,
  id: string,
  midi: number,
): HummingPitchDraft {
  assertPitch(midi);
  const index = segmentIndex(draft, id);
  const current = draft.segments[index];
  if (!current || current.midi === midi) return draft;
  return replaceSegment(draft, index, { ...current, midi });
}

/**
 * Move one complete segment by a delta in seconds.
 * Invalid bounds or collisions reject the whole operation rather than clamp.
 */
export function moveHummingSegment(
  draft: HummingPitchDraft,
  id: string,
  deltaSeconds: number,
): HummingPitchDraft {
  assertFiniteTime(deltaSeconds);
  const index = segmentIndex(draft, id);
  const current = draft.segments[index];
  if (!current || deltaSeconds === 0) return draft;
  return replaceSegment(draft, index, {
    ...current,
    startSeconds: current.startSeconds + deltaSeconds,
    endSeconds: current.endSeconds + deltaSeconds,
  });
}

/**
 * Set one absolute segment boundary in seconds.
 * Start and end are the sole timing source of truth throughout editing.
 */
export function moveHummingSegmentBoundary(
  draft: HummingPitchDraft,
  id: string,
  boundary: SegmentBoundary,
  seconds: number,
): HummingPitchDraft {
  assertFiniteTime(seconds);
  const index = segmentIndex(draft, id);
  const current = draft.segments[index];
  if (!current) throw new HummingCandidateEditError('segment-not-found');
  if (boundary === 'start') {
    if (current.startSeconds === seconds) return draft;
    return replaceSegment(draft, index, { ...current, startSeconds: seconds });
  }
  if (boundary === 'end') {
    if (current.endSeconds === seconds) return draft;
    return replaceSegment(draft, index, { ...current, endSeconds: seconds });
  }
  throw new HummingCandidateEditError('invalid-time');
}

/**
 * Split a segment at an absolute source time. The left half keeps its id and
 * the right half receives the injected id.
 */
export function splitHummingSegment(
  draft: HummingPitchDraft,
  id: string,
  splitSeconds: number,
  createId: () => string,
): HummingPitchDraft {
  assertFiniteTime(splitSeconds);
  const index = segmentIndex(draft, id);
  if (draft.segments.length >= MAX_HUMMING_PITCH_SEGMENTS) {
    throw new HummingCandidateEditError('segment-limit-exceeded');
  }
  const current = draft.segments[index];
  if (!current) throw new HummingCandidateEditError('segment-not-found');
  if (
    splitSeconds
      - current.startSeconds
      + TIMING_EPSILON_SECONDS
      < MIN_HUMMING_SEGMENT_SECONDS
    || current.endSeconds
      - splitSeconds
      + TIMING_EPSILON_SECONDS
      < MIN_HUMMING_SEGMENT_SECONDS
  ) {
    throw new HummingCandidateEditError('duration-too-short');
  }
  const idForRight = nextId(createId);
  if (draft.segments.some((segment) => segment.id === idForRight)) {
    throw new HummingCandidateEditError('duplicate-segment-id');
  }
  const left: HummingPitchSegment = { ...current, endSeconds: splitSeconds };
  const right: HummingPitchSegment = {
    ...current,
    id: idForRight,
    startSeconds: splitSeconds,
  };
  return draftWithSegments(draft, [
    ...draft.segments.slice(0, index),
    left,
    right,
    ...draft.segments.slice(index + 1),
  ]);
}

/**
 * Merge a segment with its chronological successor. The left segment keeps
 * its stable id and pitch; confidence is duration-weighted across both notes.
 */
export function mergeHummingSegmentWithNext(
  draft: HummingPitchDraft,
  id: string,
): HummingPitchDraft {
  const index = segmentIndex(draft, id);
  const left = draft.segments[index];
  const right = draft.segments[index + 1];
  if (!left || !right) {
    throw new HummingCandidateEditError('no-next-segment');
  }
  const leftDuration = left.endSeconds - left.startSeconds;
  const rightDuration = right.endSeconds - right.startSeconds;
  const confidence =
    (left.confidence * leftDuration + right.confidence * rightDuration)
    / (leftDuration + rightDuration);
  const merged: HummingPitchSegment = {
    ...left,
    endSeconds: right.endSeconds,
    confidence,
  };
  return draftWithSegments(draft, [
    ...draft.segments.slice(0, index),
    merged,
    ...draft.segments.slice(index + 2),
  ]);
}

export function removeHummingSegment(
  draft: HummingPitchDraft,
  id: string,
): HummingPitchDraft {
  const index = segmentIndex(draft, id);
  return draftWithSegments(draft, [
    ...draft.segments.slice(0, index),
    ...draft.segments.slice(index + 1),
  ]);
}

export function hummingDraftToMelodyNotes(
  draft: HummingPitchDraft,
): readonly HummingMelodyNote[] {
  assertDraft(draft);
  return draft.segments.map((segment) => ({
    startSeconds: segment.startSeconds,
    durationSeconds: segment.endSeconds - segment.startSeconds,
    midi: segment.midi,
    confidence: segment.confidence,
  }));
}

export function createHummingCandidateHistory(
  draft: HummingPitchDraft,
  limit = DEFAULT_HUMMING_CANDIDATE_HISTORY_LIMIT,
): HummingCandidateHistory {
  if (
    !Number.isInteger(limit)
    || limit < 1
    || limit > MAX_HUMMING_CANDIDATE_HISTORY_LIMIT
  ) {
    throw new HummingCandidateEditError('invalid-history');
  }
  const initial = snapshotDraft(draft);
  return {
    initial,
    current: initial,
    undoStack: [],
    redoStack: [],
    limit,
  };
}

export function commitHummingCandidateEdit(
  history: HummingCandidateHistory,
  draft: HummingPitchDraft,
): HummingCandidateHistory {
  assertHistory(history);
  assertDraft(draft);
  if (draft.sourceDurationSeconds !== history.current.sourceDurationSeconds) {
    throw new HummingCandidateEditError('source-duration-mismatch');
  }
  if (sameDraft(history.current, draft)) return history;
  return {
    ...history,
    current: snapshotDraft(draft),
    undoStack: [...history.undoStack, history.current].slice(-history.limit),
    redoStack: [],
  };
}

export function undoHummingCandidateEdit(
  history: HummingCandidateHistory,
): HummingCandidateHistory {
  assertHistory(history);
  const previous = history.undoStack.at(-1);
  if (!previous) return history;
  return {
    ...history,
    current: previous,
    undoStack: history.undoStack.slice(0, -1),
    redoStack: [...history.redoStack, history.current].slice(-history.limit),
  };
}

export function redoHummingCandidateEdit(
  history: HummingCandidateHistory,
): HummingCandidateHistory {
  assertHistory(history);
  const next = history.redoStack.at(-1);
  if (!next) return history;
  return {
    ...history,
    current: next,
    undoStack: [...history.undoStack, history.current].slice(-history.limit),
    redoStack: history.redoStack.slice(0, -1),
  };
}

/** Restore the original detector result and clear local candidate history. */
export function resetHummingCandidateHistory(
  history: HummingCandidateHistory,
): HummingCandidateHistory {
  assertHistory(history);
  const initial = snapshotDraft(history.initial);
  return {
    ...history,
    initial,
    current: initial,
    undoStack: [],
    redoStack: [],
  };
}
