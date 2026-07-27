import { describe, expect, it } from 'vitest';
import {
  HummingCandidateEditError,
  MAX_HUMMING_PITCH_SEGMENTS,
  commitHummingCandidateEdit,
  createHummingCandidateHistory,
  createHummingPitchDraft,
  hummingDraftToMelodyNotes,
  mergeHummingSegmentWithNext,
  moveHummingSegment,
  moveHummingSegmentBoundary,
  redoHummingCandidateEdit,
  removeHummingSegment,
  resetHummingCandidateHistory,
  setHummingSegmentPitch,
  splitHummingSegment,
  undoHummingCandidateEdit,
  type HummingPitchDraft,
} from '../src/features/hummingToMelody/hummingCandidateEditing';

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

function draft(): HummingPitchDraft {
  return createHummingPitchDraft(
    [
      { startSeconds: 0.1, durationSeconds: 0.3, midi: 60, confidence: 0.8 },
      { startSeconds: 0.5, durationSeconds: 0.25, midi: 64, confidence: 0.6 },
      { startSeconds: 0.9, durationSeconds: 0.2, midi: 67, confidence: 1 },
    ],
    { sourceDurationSeconds: 1.2, createId: ids('a', 'b', 'c') },
  );
}

function expectCode(action: () => unknown, code: HummingCandidateEditError['code']): void {
  expect(action).toThrowError(
    expect.objectContaining({ name: 'HummingCandidateEditError', code }),
  );
}

describe('humming candidate editing', () => {
  it('creates a sorted stable-id draft and converts it back to melody notes', () => {
    const result = createHummingPitchDraft(
      [
        { startSeconds: 0.6, durationSeconds: 0.2, midi: 67, confidence: 0.7 },
        { startSeconds: 0.1, durationSeconds: 0.3, midi: 60, confidence: 0.9 },
      ],
      { sourceDurationSeconds: 1, createId: ids('later', 'earlier') },
    );

    expect(result).toEqual({
      sourceDurationSeconds: 1,
      segments: [
        {
          id: 'earlier',
          startSeconds: 0.1,
          endSeconds: 0.4,
          midi: 60,
          confidence: 0.9,
        },
        {
          id: 'later',
          startSeconds: 0.6,
          endSeconds: 0.8,
          midi: 67,
          confidence: 0.7,
        },
      ],
    });
    const melody = hummingDraftToMelodyNotes(result);
    expect(melody).toHaveLength(2);
    expect(melody[0]).toMatchObject({
      startSeconds: 0.1,
      midi: 60,
      confidence: 0.9,
    });
    expect(melody[0]?.durationSeconds).toBeCloseTo(0.3, 12);
    expect(melody[1]).toMatchObject({
      startSeconds: 0.6,
      midi: 67,
      confidence: 0.7,
    });
    expect(melody[1]?.durationSeconds).toBeCloseTo(0.2, 12);

    const exactMinimum = createHummingPitchDraft(
      [{ startSeconds: 0.6, durationSeconds: 0.06, midi: 69, confidence: 1 }],
      { sourceDurationSeconds: 1, createId: ids('minimum') },
    );
    expect(exactMinimum.segments[0]?.endSeconds).toBeCloseTo(0.66, 12);
  });

  it('rejects invalid, overlapping, duplicate-id, and excessive detector input atomically', () => {
    const valid = draft();
    const before = structuredClone(valid);

    expectCode(
      () =>
        createHummingPitchDraft(
          [{ startSeconds: 0, durationSeconds: 0.059, midi: 60, confidence: 1 }],
          { sourceDurationSeconds: 1, createId: ids('short') },
        ),
      'duration-too-short',
    );
    expectCode(
      () =>
        createHummingPitchDraft(
          [
            { startSeconds: 0, durationSeconds: 0.2, midi: 60, confidence: 1 },
            { startSeconds: 0.1, durationSeconds: 0.2, midi: 62, confidence: 1 },
          ],
          { sourceDurationSeconds: 1, createId: ids('one', 'two') },
        ),
      'segments-overlap',
    );
    expectCode(
      () =>
        createHummingPitchDraft(
          [
            { startSeconds: 0, durationSeconds: 0.1, midi: 60, confidence: 1 },
            { startSeconds: 0.2, durationSeconds: 0.1, midi: 62, confidence: 1 },
          ],
          { sourceDurationSeconds: 1, createId: ids('same', 'same') },
        ),
      'duplicate-segment-id',
    );
    expectCode(
      () =>
        createHummingPitchDraft(
          Array.from({ length: MAX_HUMMING_PITCH_SEGMENTS + 1 }, (_, index) => ({
            startSeconds: index * 0.1,
            durationSeconds: 0.06,
            midi: 60,
            confidence: 1,
          })),
          {
            sourceDurationSeconds: MAX_HUMMING_PITCH_SEGMENTS + 1,
            createId: ids(),
          },
        ),
      'segment-limit-exceeded',
    );
    expect(valid).toEqual(before);
  });

  it('changes pitch without mutating the source and rejects invalid pitches', () => {
    const source = draft();
    const changed = setHummingSegmentPitch(source, 'b', 65);

    expect(changed.segments[1]?.midi).toBe(65);
    expect(source.segments[1]?.midi).toBe(64);
    expectCode(() => setHummingSegmentPitch(source, 'b', 64.5), 'invalid-pitch');
    expectCode(() => setHummingSegmentPitch(source, 'missing', 64), 'segment-not-found');
  });

  it('moves start/end boundaries while validating minimum duration, bounds, order, and gaps', () => {
    const source = draft();
    const startMoved = moveHummingSegmentBoundary(source, 'b', 'start', 0.42);
    const endMoved = moveHummingSegmentBoundary(startMoved, 'b', 'end', 0.82);

    expect(endMoved.segments[1]).toMatchObject({
      startSeconds: 0.42,
      endSeconds: 0.82,
    });
    expectCode(
      () => moveHummingSegmentBoundary(source, 'b', 'start', 0.35),
      'segments-overlap',
    );
    expectCode(
      () => moveHummingSegmentBoundary(source, 'b', 'end', 0.95),
      'segments-overlap',
    );
    expectCode(
      () => moveHummingSegmentBoundary(source, 'b', 'end', 0.55),
      'duration-too-short',
    );
    expectCode(
      () => moveHummingSegmentBoundary(source, 'a', 'start', -0.01),
      'out-of-bounds',
    );
    expect(source).toEqual(draft());
  });

  it('moves a complete segment by a finite delta or rejects the entire collision', () => {
    const source = draft();
    const moved = moveHummingSegment(source, 'b', 0.05);
    expect(moved.segments[1]).toMatchObject({
      startSeconds: 0.55,
      endSeconds: 0.8,
    });
    expectCode(() => moveHummingSegment(source, 'b', -0.11), 'segments-overlap');
    expectCode(() => moveHummingSegment(source, 'a', -0.11), 'out-of-bounds');
    expectCode(() => moveHummingSegment(source, 'a', Number.NaN), 'invalid-time');
    expect(source).toEqual(draft());
  });

  it('rejects non-finite source, confidence, shift, and boundary values without touching the draft', () => {
    const source = draft();
    const originalReference = source;
    const originalContents = structuredClone(source);

    expectCode(
      () =>
        createHummingPitchDraft([], {
          sourceDurationSeconds: Number.POSITIVE_INFINITY,
          createId: ids(),
        }),
      'invalid-source-duration',
    );
    expectCode(
      () =>
        createHummingPitchDraft(
          [
            {
              startSeconds: 0,
              durationSeconds: 0.1,
              midi: 60,
              confidence: Number.POSITIVE_INFINITY,
            },
          ],
          { sourceDurationSeconds: 1, createId: ids('infinite-confidence') },
        ),
      'invalid-confidence',
    );
    expectCode(
      () => moveHummingSegment(source, 'b', Number.POSITIVE_INFINITY),
      'invalid-time',
    );
    expectCode(
      () =>
        moveHummingSegmentBoundary(
          source,
          'b',
          'end',
          Number.POSITIVE_INFINITY,
        ),
      'invalid-time',
    );

    expect(source).toBe(originalReference);
    expect(source).toEqual(originalContents);
  });

  it('produces the same draft when independent pitch and time edits are applied in either order', () => {
    const source = draft();
    const originalContents = structuredClone(source);

    const pitchThenTime = moveHummingSegment(
      setHummingSegmentPitch(source, 'b', 65),
      'b',
      0.05,
    );
    const timeThenPitch = setHummingSegmentPitch(
      moveHummingSegment(source, 'b', 0.05),
      'b',
      65,
    );

    expect(pitchThenTime).toEqual(timeThenPitch);
    expect(pitchThenTime.segments[1]).toMatchObject({
      id: 'b',
      startSeconds: 0.55,
      endSeconds: 0.8,
      midi: 65,
      confidence: 0.6,
    });
    expect(source).toEqual(originalContents);
  });

  it('splits only when both halves are at least 60 ms and keeps the left stable id', () => {
    const source = draft();
    const split = splitHummingSegment(source, 'a', 0.25, ids('a-right'));

    expect(split.segments.slice(0, 2)).toEqual([
      {
        id: 'a',
        startSeconds: 0.1,
        endSeconds: 0.25,
        midi: 60,
        confidence: 0.8,
      },
      {
        id: 'a-right',
        startSeconds: 0.25,
        endSeconds: 0.4,
        midi: 60,
        confidence: 0.8,
      },
    ]);
    expectCode(
      () => splitHummingSegment(source, 'a', 0.12, ids('too-close')),
      'duration-too-short',
    );
    expectCode(
      () => splitHummingSegment(source, 'a', 0.25, ids('b')),
      'duplicate-segment-id',
    );
    expect(source).toEqual(draft());
  });

  it('merges with the chronological next segment and removes by stable id', () => {
    const source = draft();
    const merged = mergeHummingSegmentWithNext(source, 'a');

    expect(merged.segments[0]).toMatchObject({
      id: 'a',
      startSeconds: 0.1,
      endSeconds: 0.75,
      midi: 60,
    });
    expect(merged.segments[0]?.confidence).toBeCloseTo(
      (0.8 * 0.3 + 0.6 * 0.25) / 0.55,
      12,
    );
    expect(merged.segments.map((segment) => segment.id)).toEqual(['a', 'c']);
    expectCode(() => mergeHummingSegmentWithNext(source, 'c'), 'no-next-segment');

    const removed = removeHummingSegment(source, 'b');
    expect(removed.segments.map((segment) => segment.id)).toEqual(['a', 'c']);
    expectCode(() => removeHummingSegment(source, 'missing'), 'segment-not-found');
    expect(source).toEqual(draft());
  });
});

describe('humming candidate edit history', () => {
  it('bounds undo, restores redo, clears redo on a branch, and resets to detection', () => {
    const initial = draft();
    let history = createHummingCandidateHistory(initial, 2);
    history = commitHummingCandidateEdit(
      history,
      setHummingSegmentPitch(history.current, 'a', 61),
    );
    history = commitHummingCandidateEdit(
      history,
      setHummingSegmentPitch(history.current, 'a', 62),
    );
    history = commitHummingCandidateEdit(
      history,
      setHummingSegmentPitch(history.current, 'a', 63),
    );

    expect(history.undoStack).toHaveLength(2);
    expect(history.current.segments[0]?.midi).toBe(63);
    history = undoHummingCandidateEdit(history);
    expect(history.current.segments[0]?.midi).toBe(62);
    history = undoHummingCandidateEdit(history);
    expect(history.current.segments[0]?.midi).toBe(61);
    expect(undoHummingCandidateEdit(history)).toBe(history);

    history = redoHummingCandidateEdit(history);
    expect(history.current.segments[0]?.midi).toBe(62);
    history = commitHummingCandidateEdit(
      history,
      setHummingSegmentPitch(history.current, 'a', 70),
    );
    expect(history.redoStack).toEqual([]);
    expect(redoHummingCandidateEdit(history)).toBe(history);

    history = resetHummingCandidateHistory(history);
    expect(history.current).toEqual(initial);
    expect(history.undoStack).toEqual([]);
    expect(history.redoStack).toEqual([]);
  });

  it('ignores no-op commits and rejects invalid limits or a different source', () => {
    const initial = draft();
    const history = createHummingCandidateHistory(initial);
    expect(commitHummingCandidateEdit(history, initial)).toBe(history);
    expectCode(() => createHummingCandidateHistory(initial, 0), 'invalid-history');
    expectCode(
      () =>
        commitHummingCandidateEdit(history, {
          sourceDurationSeconds: 2,
          segments: initial.segments,
        }),
      'source-duration-mismatch',
    );
  });
});
