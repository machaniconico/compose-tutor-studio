/**
 * Tests for checker.ts — pure DSL evaluation functions.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeBassRootOnDownbeat,
  analyzeDrumPattern,
  analyzeMelodyChordToneOnStrongBeat,
  analyzeNotesWithinScale,
  applyEvent,
  checkCondition,
  checkProjectPredicate,
  evaluateLesson,
} from '../src/checker.js';
import type { EditEvent, Lesson } from '../src/dsl.js';
import type { LessonRuntimeState } from '../src/checker.js';
import { course0 } from '../src/courses.js';
import {
  makeBassTrack,
  makeChord,
  makeDrumEvent,
  makeDrumTrack,
  makeMelodyTrack,
  makeNote,
  makeProject,
} from './helpers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyState(): LessonRuntimeState {
  return { events: [] };
}

function stateFrom(...events: EditEvent[]): LessonRuntimeState {
  return events.reduce(
    (s, e) => applyEvent(s, e),
    emptyState(),
  );
}

// ─── applyEvent — immutability ────────────────────────────────────────────────

describe('applyEvent', () => {
  it('returns a new state object (immutable)', () => {
    const before = emptyState();
    const after = applyEvent(before, { type: 'project.created' });
    expect(after).not.toBe(before);
    expect(before.events).toHaveLength(0);
    expect(after.events).toHaveLength(1);
  });

  it('does not mutate the original events array', () => {
    const before = stateFrom({ type: 'project.created' });
    const original = before.events;
    applyEvent(before, { type: 'tempo.changed', bpm: 120 });
    expect(before.events).toBe(original);
    expect(before.events).toHaveLength(1);
  });

  it('accumulates events in order', () => {
    const s = stateFrom(
      { type: 'project.created' },
      { type: 'tempo.changed', bpm: 100 },
    );
    expect(s.events[0]?.type).toBe('project.created');
    expect(s.events[1]?.type).toBe('tempo.changed');
  });
});

// ─── checkCondition — hasEvent ────────────────────────────────────────────────

describe('checkCondition: hasEvent', () => {
  it('returns false when no matching event exists', () => {
    const state = emptyState();
    expect(
      checkCondition({ kind: 'hasEvent', eventType: 'project.created' }, state),
    ).toBe(false);
  });

  it('returns true when a matching event exists', () => {
    const state = stateFrom({ type: 'project.created' });
    expect(
      checkCondition({ kind: 'hasEvent', eventType: 'project.created' }, state),
    ).toBe(true);
  });

  it('does not false-positive on a different event type', () => {
    const state = stateFrom({ type: 'tempo.changed', bpm: 120 });
    expect(
      checkCondition({ kind: 'hasEvent', eventType: 'project.created' }, state),
    ).toBe(false);
  });
});

// ─── checkCondition — eventCount ─────────────────────────────────────────────

describe('checkCondition: eventCount', () => {
  it('returns false when count is below min', () => {
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
    );
    expect(
      checkCondition(
        { kind: 'eventCount', eventType: 'drum.step.toggled', min: 4 },
        state,
      ),
    ).toBe(false);
  });

  it('returns true when count meets min', () => {
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 12 },
    );
    expect(
      checkCondition(
        { kind: 'eventCount', eventType: 'drum.step.toggled', min: 4 },
        state,
      ),
    ).toBe(true);
  });

  it('returns true when count exceeds min', () => {
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 8 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 12 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 4 },
    );
    expect(
      checkCondition(
        { kind: 'eventCount', eventType: 'drum.step.toggled', min: 4 },
        state,
      ),
    ).toBe(true);
  });
});

// ─── checkCondition — progressionEquals ──────────────────────────────────────

describe('checkCondition: progressionEquals', () => {
  it('returns false when no progression.set event exists', () => {
    const state = stateFrom({ type: 'chord.added', symbol: 'C', startBeat: 0 });
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(false);
  });

  it('returns false when progression does not match', () => {
    const state = stateFrom({
      type: 'progression.set',
      symbols: ['C', 'Am', 'F', 'G'],
    });
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(false);
  });

  it('returns false when symbol count differs', () => {
    const state = stateFrom({
      type: 'progression.set',
      symbols: ['C', 'G', 'Am'],
    });
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(false);
  });

  it('returns true when last progression.set matches exactly', () => {
    const state = stateFrom({
      type: 'progression.set',
      symbols: ['C', 'G', 'Am', 'F'],
    });
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(true);
  });

  it('uses the LAST progression.set event', () => {
    const state = stateFrom(
      { type: 'progression.set', symbols: ['C', 'Am', 'F', 'G'] },
      { type: 'progression.set', symbols: ['C', 'G', 'Am', 'F'] },
    );
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(true);
  });
});

// ─── checkCondition — noteCountAtLeast ───────────────────────────────────────

describe('checkCondition: noteCountAtLeast', () => {
  it('returns false when note count is below min', () => {
    const state = stateFrom(
      { type: 'note.added', pitch: 60, startBeat: 0 },
      { type: 'note.added', pitch: 62, startBeat: 1 },
    );
    expect(
      checkCondition({ kind: 'noteCountAtLeast', min: 4 }, state),
    ).toBe(false);
  });

  it('returns true when note count meets min', () => {
    const state = stateFrom(
      { type: 'note.added', pitch: 60, startBeat: 0 },
      { type: 'note.added', pitch: 62, startBeat: 1 },
      { type: 'note.added', pitch: 64, startBeat: 2 },
      { type: 'note.added', pitch: 65, startBeat: 3 },
    );
    expect(
      checkCondition({ kind: 'noteCountAtLeast', min: 4 }, state),
    ).toBe(true);
  });
});

// ─── checkCondition — exported ────────────────────────────────────────────────

describe('checkCondition: exported', () => {
  it('returns false when no export event exists', () => {
    const state = emptyState();
    expect(checkCondition({ kind: 'exported' }, state)).toBe(false);
  });

  it('returns true for any format when format is not specified', () => {
    const state = stateFrom({ type: 'exported', format: 'wav' });
    expect(checkCondition({ kind: 'exported' }, state)).toBe(true);
  });

  it('returns true when format matches', () => {
    const state = stateFrom({ type: 'exported', format: 'midi' });
    expect(checkCondition({ kind: 'exported', format: 'midi' }, state)).toBe(true);
  });

  it('returns false when format does not match', () => {
    const state = stateFrom({ type: 'exported', format: 'wav' });
    expect(checkCondition({ kind: 'exported', format: 'midi' }, state)).toBe(false);
  });
});

// ─── evaluateLesson — partial progress ───────────────────────────────────────

describe('evaluateLesson: partial progress', () => {
  // Use lesson02 (0-2 コード進行を選ぶ) which has 2 steps: chordCountAtLeast(1) then progressionEquals
  const lesson03 = course0[1] as Lesson;

  it('currentStep is 0 when no events have been applied', () => {
    const result = evaluateLesson(lesson03, emptyState());
    expect(result.currentStep).toBe(0);
    expect(result.completedStepIds).toHaveLength(0);
    expect(result.isComplete).toBe(false);
  });

  it('currentStep advances to 1 after first step is satisfied', () => {
    // Satisfy step 1: chord.added >= 1
    const state = stateFrom({ type: 'chord.added', symbol: 'C', startBeat: 0 });
    const result = evaluateLesson(lesson03, state);
    expect(result.currentStep).toBe(1);
    expect(result.completedStepIds).toContain(lesson03.steps[0]?.id);
    expect(result.isComplete).toBe(false);
  });

  it('feedback contains instruction or hint of the active step', () => {
    const state = emptyState();
    const result = evaluateLesson(lesson03, state);
    const step0 = lesson03.steps[0]!;
    const expectedFeedback = step0.hint ?? step0.instruction;
    expect(result.feedback).toBe(expectedFeedback);
  });
});

// ─── evaluateLesson — course0 lesson 3 completion ────────────────────────────

describe('evaluateLesson: course0 lesson03 completion', () => {
  const lesson03 = course0[1] as Lesson;

  it('isComplete when both steps are satisfied', () => {
    const state = stateFrom(
      // Satisfy step 1: chord.added >= 1
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      // Satisfy step 2: progressionEquals ['C','G','Am','F']
      { type: 'progression.set', symbols: ['C', 'G', 'Am', 'F'] },
    );
    const result = evaluateLesson(lesson03, state);
    expect(result.isComplete).toBe(true);
    expect(result.completedStepIds).toHaveLength(lesson03.steps.length);
    expect(result.currentStep).toBe(lesson03.steps.length);
  });

  it('completedStepIds contains all step ids when complete', () => {
    const state = stateFrom(
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      { type: 'progression.set', symbols: ['C', 'G', 'Am', 'F'] },
    );
    const result = evaluateLesson(lesson03, state);
    const expectedIds = lesson03.steps.map((s) => s.id);
    expect(result.completedStepIds).toEqual(expectedIds);
  });

  it('feedback equals successMessage of last step when complete', () => {
    const state = stateFrom(
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      { type: 'progression.set', symbols: ['C', 'G', 'Am', 'F'] },
    );
    const result = evaluateLesson(lesson03, state);
    const lastStep = lesson03.steps[lesson03.steps.length - 1]!;
    expect(result.feedback).toBe(lastStep.successMessage);
  });

  it('is NOT complete with wrong progression', () => {
    const state = stateFrom(
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      { type: 'progression.set', symbols: ['C', 'Am', 'F', 'G'] },
    );
    const result = evaluateLesson(lesson03, state);
    expect(result.isComplete).toBe(false);
  });
});

// ─── evaluateLesson — full course0 lesson sequence ───────────────────────────

describe('evaluateLesson: other course0 lessons', () => {
  it('lesson01 completes after project.created and tempo.changed', () => {
    const lesson01 = course0[0] as Lesson;
    const state = stateFrom(
      { type: 'project.created' },
      { type: 'tempo.changed', bpm: 120 },
    );
    const result = evaluateLesson(lesson01, state);
    expect(result.isComplete).toBe(true);
  });

  it('lesson04 (ベースを足す) completes after 4 note.added events', () => {
    const lesson04 = course0[3] as Lesson;
    const state = stateFrom(
      { type: 'note.added', pitch: 36, startBeat: 0 },
      { type: 'note.added', pitch: 43, startBeat: 4 },
      { type: 'note.added', pitch: 33, startBeat: 8 },
      { type: 'note.added', pitch: 41, startBeat: 12 },
    );
    const result = evaluateLesson(lesson04, state);
    expect(result.isComplete).toBe(true);
  });

  it('lesson05 (メロディを足す) completes after 4 note.added events', () => {
    const lesson05 = course0[4] as Lesson;
    const state = stateFrom(
      { type: 'note.added', pitch: 60, startBeat: 0 },
      { type: 'note.added', pitch: 64, startBeat: 1 },
      { type: 'note.added', pitch: 67, startBeat: 2 },
      { type: 'note.added', pitch: 69, startBeat: 3 },
    );
    const result = evaluateLesson(lesson05, state);
    expect(result.isComplete).toBe(true);
  });

  it('lesson03 (ドラムを足す) completes after 6 drum.step.toggled events', () => {
    const lesson03drums = course0[2] as Lesson;
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 8 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 12 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 12 },
    );
    const result = evaluateLesson(lesson03drums, state);
    expect(result.isComplete).toBe(true);
  });

  it('lesson08 (書き出す) completes after exported midi', () => {
    const lesson08 = course0[7] as Lesson;
    const state = stateFrom({ type: 'exported', format: 'midi' });
    const result = evaluateLesson(lesson08, state);
    expect(result.isComplete).toBe(true);
  });
});

// ═══ 音楽的判定チェッカー (checkProjectPredicate) ═══════════════════════════════
//
// 共通設定: C メジャー / 4/4 / 4小節 / コード C → G → Am → F（各1小節）
// MIDI: C2=36, F2=41, G2=43, A2=45 / C4=60, E4=64, F#4=66, G4=67, A4=69, B4=71, D5=74

const FOUR_CHORDS = [
  makeChord('C', 0),
  makeChord('G', 4),
  makeChord('Am', 8),
  makeChord('F', 12),
];

// ─── hasBassRootOnDownbeat ────────────────────────────────────────────────────

describe('checkProjectPredicate: hasBassRootOnDownbeat', () => {
  const predicate = (minRatio: number) =>
    ({ type: 'hasBassRootOnDownbeat', trackName: 'Bass', minRatio }) as const;

  it('成功: 全小節の1拍目がルート音なら ratio=1.0 で満たす', () => {
    const project = makeProject({
      lengthBars: 4,
      chordTrack: FOUR_CHORDS,
      tracks: [
        makeBassTrack([makeNote(36, 0), makeNote(43, 4), makeNote(45, 8), makeNote(41, 12)]),
      ],
    });
    expect(checkProjectPredicate(predicate(0.75), project)).toBe(true);
    const analysis = analyzeBassRootOnDownbeat(project, 'Bass');
    expect(analysis.consideredBars).toBe(4);
    expect(analysis.rootBars).toBe(4);
    expect(analysis.firstIssue).toBeNull();
  });

  it('境界: 4小節中3小節がルート (ratio=0.75) で minRatio=0.75 ちょうど → 満たす', () => {
    // 4小節目 (F) だけルート以外 (A2=45) を弾く
    const project = makeProject({
      lengthBars: 4,
      chordTrack: FOUR_CHORDS,
      tracks: [
        makeBassTrack([makeNote(36, 0), makeNote(43, 4), makeNote(45, 8), makeNote(45, 12)]),
      ],
    });
    expect(checkProjectPredicate(predicate(0.75), project)).toBe(true);
  });

  it('失敗: ratio=0.75 は minRatio=0.8 を満たさず、firstIssue が4小節目を指す', () => {
    const project = makeProject({
      lengthBars: 4,
      chordTrack: FOUR_CHORDS,
      tracks: [
        makeBassTrack([makeNote(36, 0), makeNote(43, 4), makeNote(45, 8), makeNote(45, 12)]),
      ],
    });
    expect(checkProjectPredicate(predicate(0.8), project)).toBe(false);
    const analysis = analyzeBassRootOnDownbeat(project, 'Bass');
    expect(analysis.firstIssue?.barNumber).toBe(4);
    expect(analysis.firstIssue?.chordSymbol).toBe('F');
    expect(analysis.firstIssue?.rootName).toBe('F');
    expect(analysis.firstIssue?.hasNoteOnDownbeat).toBe(true);
  });

  it('1拍目にノートが無い小節は「未達」として分母に入る', () => {
    // 1・2小節目だけルートを弾く → 2/4 = 0.5
    const project = makeProject({
      lengthBars: 4,
      chordTrack: FOUR_CHORDS,
      tracks: [makeBassTrack([makeNote(36, 0), makeNote(43, 4)])],
    });
    expect(checkProjectPredicate(predicate(0.5), project)).toBe(true);
    expect(checkProjectPredicate(predicate(0.75), project)).toBe(false);
    const analysis = analyzeBassRootOnDownbeat(project, 'Bass');
    expect(analysis.firstIssue?.barNumber).toBe(3);
    expect(analysis.firstIssue?.hasNoteOnDownbeat).toBe(false);
  });

  it('失敗: コードが1つも無ければ判定対象ゼロで満たさない', () => {
    const project = makeProject({
      lengthBars: 4,
      chordTrack: [],
      tracks: [makeBassTrack([makeNote(36, 0)])],
    });
    expect(checkProjectPredicate(predicate(0.5), project)).toBe(false);
  });

  it('オクターブ違いのルート音もルートとして認める（ピッチクラス判定）', () => {
    const project = makeProject({
      lengthBars: 1,
      chordTrack: [makeChord('C', 0)],
      tracks: [makeBassTrack([makeNote(48, 0)])], // C3
    });
    expect(checkProjectPredicate(predicate(1), project)).toBe(true);
  });
});

// ─── hasMelodyChordToneOnStrongBeat ──────────────────────────────────────────

describe('checkProjectPredicate: hasMelodyChordToneOnStrongBeat', () => {
  const predicate = (minRatio: number) =>
    ({ type: 'hasMelodyChordToneOnStrongBeat', trackName: 'Melody', minRatio }) as const;
  const TWO_CHORDS = [makeChord('C', 0), makeChord('G', 4)];

  it('成功: 強拍(1・3拍目)全てがコードトーンに着地 → ratio=1.0', () => {
    // bar1: E4(C のコードトーン), G4 / bar2: B4(G のコードトーン), D5
    const project = makeProject({
      lengthBars: 2,
      chordTrack: TWO_CHORDS,
      tracks: [
        makeMelodyTrack([makeNote(64, 0), makeNote(67, 2), makeNote(71, 4), makeNote(74, 6)]),
      ],
    });
    expect(checkProjectPredicate(predicate(1), project)).toBe(true);
  });

  it('境界: 4着地中3つがコードトーン (ratio=0.75) で minRatio=0.75 ちょうど → 満たす', () => {
    // bar2 の3拍目 (beat 6) を F#4 (G のコードトーンでもスケール内でもない) にする
    const project = makeProject({
      lengthBars: 2,
      chordTrack: TWO_CHORDS,
      tracks: [
        makeMelodyTrack([makeNote(64, 0), makeNote(67, 2), makeNote(71, 4), makeNote(66, 6)]),
      ],
    });
    expect(checkProjectPredicate(predicate(0.75), project)).toBe(true);
    expect(checkProjectPredicate(predicate(0.8), project)).toBe(false);
  });

  it('failure 詳細: firstIssue に小節番号・コード名・着地候補・スケール外フラグが入る', () => {
    const project = makeProject({
      lengthBars: 2,
      chordTrack: TWO_CHORDS,
      tracks: [
        makeMelodyTrack([makeNote(64, 0), makeNote(67, 2), makeNote(71, 4), makeNote(66, 6)]),
      ],
    });
    const analysis = analyzeMelodyChordToneOnStrongBeat(project, 'Melody');
    expect(analysis.landings).toBe(4);
    expect(analysis.chordToneLandings).toBe(3);
    expect(analysis.firstIssue?.barNumber).toBe(2);
    expect(analysis.firstIssue?.chordSymbol).toBe('G');
    expect(analysis.firstIssue?.chordToneNames).toEqual(['G', 'B', 'D']);
    expect(analysis.firstIssue?.outOfScale).toBe(true); // F# は C メジャー外
  });

  it('強拍にノートが無い（シンコペーション）は分母に入らない', () => {
    // 着地は beat 0 の E4 だけ。beat 1.5 / 2.5 の音は判定対象外
    const project = makeProject({
      lengthBars: 2,
      chordTrack: TWO_CHORDS,
      tracks: [
        makeMelodyTrack([makeNote(64, 0), makeNote(66, 1.5), makeNote(69, 2.5)]),
      ],
    });
    const analysis = analyzeMelodyChordToneOnStrongBeat(project, 'Melody');
    expect(analysis.landings).toBe(1);
    expect(analysis.chordToneLandings).toBe(1);
    expect(checkProjectPredicate(predicate(1), project)).toBe(true);
  });

  it('失敗: 強拍への着地が1つも無ければ満たさない（minRatio が低くても）', () => {
    const project = makeProject({
      lengthBars: 2,
      chordTrack: TWO_CHORDS,
      tracks: [makeMelodyTrack([makeNote(64, 1), makeNote(67, 3)])],
    });
    expect(checkProjectPredicate(predicate(0.1), project)).toBe(false);
  });
});

// ─── hasNotesWithinScale ──────────────────────────────────────────────────────

describe('checkProjectPredicate: hasNotesWithinScale', () => {
  const predicate = (minRatio: number) =>
    ({ type: 'hasNotesWithinScale', trackName: 'Melody', minRatio }) as const;

  it('成功: 全ノートが C メジャースケール内 → ratio=1.0', () => {
    const project = makeProject({
      tracks: [makeMelodyTrack([makeNote(60, 0), makeNote(62, 1), makeNote(64, 2), makeNote(67, 3)])],
    });
    expect(checkProjectPredicate(predicate(1), project)).toBe(true);
  });

  it('境界: 4ノート中3つがスケール内 (ratio=0.75) で minRatio=0.75 ちょうど → 満たす', () => {
    const project = makeProject({
      tracks: [makeMelodyTrack([makeNote(60, 0), makeNote(62, 1), makeNote(64, 2), makeNote(66, 3)])],
    });
    expect(checkProjectPredicate(predicate(0.75), project)).toBe(true);
    expect(checkProjectPredicate(predicate(0.8), project)).toBe(false);
  });

  it('スケール外ノートの最初の小節番号を報告する（4/4 で beat 6 → 2小節目）', () => {
    const project = makeProject({
      tracks: [makeMelodyTrack([makeNote(60, 0), makeNote(66, 6)])],
    });
    const analysis = analyzeNotesWithinScale(project, 'Melody');
    expect(analysis.totalNotes).toBe(2);
    expect(analysis.inScaleNotes).toBe(1);
    expect(analysis.firstOutsideBarNumber).toBe(2);
  });

  it('失敗: ノートが1つも無ければ満たさない', () => {
    const project = makeProject({ tracks: [makeMelodyTrack([])] });
    expect(checkProjectPredicate(predicate(0.5), project)).toBe(false);
  });

  it('別キー/スケールでも判定する（A ナチュラルマイナー）', () => {
    const project = makeProject({
      key: 'A',
      scale: 'naturalMinor',
      tracks: [makeMelodyTrack([makeNote(69, 0), makeNote(71, 1), makeNote(72, 2)])], // A, B, C
    });
    expect(checkProjectPredicate(predicate(1), project)).toBe(true);
  });
});

// ─── hasDrumPattern ───────────────────────────────────────────────────────────

describe('checkProjectPredicate: hasDrumPattern', () => {
  it('fourOnFloor 成功: キックが 0,4,8,12 にある', () => {
    const project = makeProject({
      tracks: [
        makeDrumTrack([
          makeDrumEvent('kick', 0),
          makeDrumEvent('kick', 4),
          makeDrumEvent('kick', 8),
          makeDrumEvent('kick', 12),
          makeDrumEvent('snare', 4), // 余分なレーンがあってもよい
        ]),
      ],
    });
    expect(
      checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'fourOnFloor' }, project),
    ).toBe(true);
  });

  it('fourOnFloor 失敗: キックが1つ欠けると満たさない', () => {
    const project = makeProject({
      tracks: [
        makeDrumTrack([makeDrumEvent('kick', 0), makeDrumEvent('kick', 4), makeDrumEvent('kick', 8)]),
      ],
    });
    expect(
      checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'fourOnFloor' }, project),
    ).toBe(false);
    const analysis = analyzeDrumPattern(project, 'fourOnFloor');
    expect(analysis.missing).toEqual([{ lane: 'kick', stepIndices: [12] }]);
  });

  it('backbeat 成功/失敗: スネアが2・4拍目 (4,12) に必要', () => {
    const ok = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('snare', 4), makeDrumEvent('snare', 12)])],
    });
    const ng = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('snare', 4)])],
    });
    expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'backbeat' }, ok)).toBe(true);
    expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'backbeat' }, ng)).toBe(false);
  });

  it('eightBeat 成功: ハイハット8分刻み + キック1拍目 + スネア2・4拍目', () => {
    const hats = [0, 2, 4, 6, 8, 10, 12, 14].map((s) => makeDrumEvent('closedHat', s));
    const project = makeProject({
      tracks: [
        makeDrumTrack([...hats, makeDrumEvent('kick', 0), makeDrumEvent('snare', 4), makeDrumEvent('snare', 12)]),
      ],
    });
    expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'eightBeat' }, project)).toBe(true);
  });

  it('eightBeat 失敗: ハイハットが無いと満たさない', () => {
    const project = makeProject({
      tracks: [
        makeDrumTrack([makeDrumEvent('kick', 0), makeDrumEvent('snare', 4), makeDrumEvent('snare', 12)]),
      ],
    });
    expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'eightBeat' }, project)).toBe(false);
  });

  it('複数小節クリップ: 2小節目 (ステップ16-31) だけにパターンがあっても満たす', () => {
    const project = makeProject({
      tracks: [
        makeDrumTrack([
          makeDrumEvent('kick', 16),
          makeDrumEvent('kick', 20),
          makeDrumEvent('kick', 24),
          makeDrumEvent('kick', 28),
        ]),
      ],
    });
    expect(
      checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'fourOnFloor' }, project),
    ).toBe(true);
  });

  it('失敗: ドラムイベントが無ければ満たさず、必要要素を missing で返す', () => {
    const project = makeProject({ tracks: [makeDrumTrack([])] });
    expect(
      checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'backbeat' }, project),
    ).toBe(false);
    const analysis = analyzeDrumPattern(project, 'backbeat');
    expect(analysis.missing).toEqual([{ lane: 'snare', stepIndices: [4, 12] }]);
  });
});

// ─── 委譲と純粋性 ────────────────────────────────────────────────────────────

describe('checkProjectPredicate: 既存predicateへの委譲と純粋性', () => {
  it('従来predicate (chordCountAtLeast) も評価できる', () => {
    const project = makeProject({ chordTrack: [makeChord('C', 0)] });
    expect(checkProjectPredicate({ type: 'chordCountAtLeast', value: 1 }, project)).toBe(true);
    expect(checkProjectPredicate({ type: 'chordCountAtLeast', value: 2 }, project)).toBe(false);
  });

  it('決定的かつ非破壊: 同じ入力なら同じ結果で、Project を変更しない', () => {
    const project = makeProject({
      lengthBars: 2,
      chordTrack: [makeChord('C', 0), makeChord('G', 4)],
      tracks: [makeMelodyTrack([makeNote(64, 0), makeNote(66, 4)])],
    });
    const snapshot = JSON.stringify(project);
    const predicate = {
      type: 'hasMelodyChordToneOnStrongBeat',
      trackName: 'Melody',
      minRatio: 0.5,
    } as const;
    const first = checkProjectPredicate(predicate, project);
    const second = checkProjectPredicate(predicate, project);
    expect(first).toBe(second);
    expect(JSON.stringify(project)).toBe(snapshot);
  });
});
