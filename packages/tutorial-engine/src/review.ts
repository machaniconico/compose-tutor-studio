// Spaced repetition review queue

import type { ClockFn, ReviewRecord } from './types.js';

// Interval days for each level: level 0 → +1d, level 1 → +3d, level 2 → +7d
const INTERVAL_DAYS: readonly number[] = [1, 3, 7];

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export class ReviewQueue {
  private records: Map<string, ReviewRecord> = new Map();
  private clock: ClockFn;

  constructor(clock: ClockFn = () => new Date()) {
    this.clock = clock;
  }

  /**
   * Record a lesson result and schedule the next review.
   * If correct, advances the interval level (capped at max).
   * If incorrect, resets to level 0.
   */
  recordResult(lessonId: string, correct: boolean): void {
    const now = this.clock();
    const existing = this.records.get(lessonId);
    let nextLevel: number;

    if (correct) {
      const currentLevel = existing?.intervalLevel ?? -1;
      nextLevel = Math.min(currentLevel + 1, INTERVAL_DAYS.length - 1);
    } else {
      nextLevel = 0;
    }

    const days = INTERVAL_DAYS[nextLevel] ?? 1;
    const nextReviewAt = addDays(now, days).toISOString();

    this.records.set(lessonId, {
      lessonId,
      nextReviewAt,
      intervalLevel: nextLevel,
      lastCorrect: correct,
    });
  }

  /**
   * Returns lessons due for review at or before `now`.
   */
  getDueReviews(now: Date): ReviewRecord[] {
    const results: ReviewRecord[] = [];
    for (const record of this.records.values()) {
      if (new Date(record.nextReviewAt) <= now) {
        results.push(record);
      }
    }
    return results;
  }

  /** Snapshot all records for persistence */
  toSnapshot(): ReviewRecord[] {
    return Array.from(this.records.values());
  }

  /** Restore from snapshot */
  fromSnapshot(records: ReviewRecord[]): void {
    this.records.clear();
    for (const r of records) {
      this.records.set(r.lessonId, r);
    }
  }
}
