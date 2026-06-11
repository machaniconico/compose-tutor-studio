import { describe, expect, it } from 'vitest';
import { ReviewQueue } from '../src/review.js';

describe('ReviewQueue', () => {
  it('schedules +1d after first correct answer (level 0)', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    queue.recordResult('lesson-1', true);
    const rec = queue.toSnapshot()[0]!;
    expect(rec.lessonId).toBe('lesson-1');
    expect(rec.intervalLevel).toBe(0);
    expect(rec.nextReviewAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('advances to +3d after second correct (level 1)', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    queue.recordResult('lesson-1', true);
    queue.recordResult('lesson-1', true);
    const rec = queue.toSnapshot()[0]!;
    expect(rec.intervalLevel).toBe(1);
    expect(rec.nextReviewAt).toBe('2025-01-04T00:00:00.000Z');
  });

  it('advances to +7d after third correct (level 2)', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    queue.recordResult('lesson-1', true);
    queue.recordResult('lesson-1', true);
    queue.recordResult('lesson-1', true);
    const rec = queue.toSnapshot()[0]!;
    expect(rec.intervalLevel).toBe(2);
    expect(rec.nextReviewAt).toBe('2025-01-08T00:00:00.000Z');
  });

  it('caps interval at level 2 on further correct answers', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    for (let i = 0; i < 10; i++) queue.recordResult('lesson-1', true);
    const rec = queue.toSnapshot()[0]!;
    expect(rec.intervalLevel).toBe(2);
  });

  it('resets to level 0 on incorrect answer', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    queue.recordResult('lesson-1', true);
    queue.recordResult('lesson-1', true); // level 1
    queue.recordResult('lesson-1', false); // reset → level 0 +1d
    const rec = queue.toSnapshot()[0]!;
    expect(rec.intervalLevel).toBe(0);
    expect(rec.lastCorrect).toBe(false);
    expect(rec.nextReviewAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('getDueReviews returns nothing when review is in future', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    queue.recordResult('lesson-1', true); // due 2025-01-02

    const due = queue.getDueReviews(new Date('2025-01-01T12:00:00.000Z'));
    expect(due).toHaveLength(0);
  });

  it('getDueReviews returns record when review date has passed', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    queue.recordResult('lesson-1', true); // due 2025-01-02

    const due = queue.getDueReviews(new Date('2025-01-02T00:00:00.000Z'));
    expect(due).toHaveLength(1);
    expect(due[0]!.lessonId).toBe('lesson-1');
  });

  it('getDueReviews returns only overdue records', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    queue.recordResult('lesson-1', true); // due 2025-01-02 (level 0)
    queue.recordResult('lesson-2', true);
    queue.recordResult('lesson-2', true); // due 2025-01-04 (level 1)

    const due = queue.getDueReviews(new Date('2025-01-02T12:00:00.000Z'));
    const ids = due.map((r) => r.lessonId);
    expect(ids).toContain('lesson-1');
    expect(ids).not.toContain('lesson-2');
  });

  it('toSnapshot and fromSnapshot round-trip correctly', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    queue.recordResult('lesson-1', true);
    queue.recordResult('lesson-2', false);

    const snapshot = queue.toSnapshot();
    const queue2 = new ReviewQueue(() => now);
    queue2.fromSnapshot(snapshot);

    const snap2 = queue2.toSnapshot();
    expect(snap2).toHaveLength(2);
    const ids = snap2.map((r) => r.lessonId).sort();
    expect(ids).toEqual(['lesson-1', 'lesson-2']);
  });

  it('uses injected clock for scheduling date', () => {
    const now = new Date('2025-06-01T00:00:00.000Z');
    const queue = new ReviewQueue(() => now);
    queue.recordResult('lesson-1', true);
    const rec = queue.toSnapshot()[0]!;
    expect(rec.nextReviewAt.startsWith('2025-06-02')).toBe(true);
  });
});
