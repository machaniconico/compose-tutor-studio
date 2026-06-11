import { describe, expect, it } from 'vitest';
import { gradeExercise } from '../src/exercises.js';
import type { Exercise, ExerciseAnswer } from '../src/types.js';

const mcExercise: Exercise = {
  kind: 'multipleChoice',
  question: 'テスト問題です。',
  choices: ['選択肢A', '選択肢B', '選択肢C', '選択肢D'],
  correctIndex: 2,
  explanation: 'Cが正解です。',
};

const orderExercise: Exercise = {
  kind: 'orderChoices',
  question: '並べ替えてください。',
  choices: ['第3', '第1', '第2'],
  correctOrder: [1, 2, 0],
  explanation: '第1→第2→第3の順が正しいです。',
};

describe('gradeExercise — multipleChoice', () => {
  it('returns correct=true for right answer', () => {
    const answer: ExerciseAnswer = { kind: 'multipleChoice', selectedIndex: 2 };
    const result = gradeExercise(mcExercise, answer);
    expect(result.correct).toBe(true);
    expect(result.feedback).toContain('正解');
    expect(result.feedback).toContain('Cが正解です。');
  });

  it('returns correct=false for wrong answer', () => {
    const answer: ExerciseAnswer = { kind: 'multipleChoice', selectedIndex: 0 };
    const result = gradeExercise(mcExercise, answer);
    expect(result.correct).toBe(false);
    expect(result.feedback).toContain('惜しい');
    expect(result.feedback).toContain('3'); // correctIndex+1
  });
});

describe('gradeExercise — orderChoices', () => {
  it('returns correct=true for correct order', () => {
    const answer: ExerciseAnswer = { kind: 'orderChoices', orderedIndices: [1, 2, 0] };
    const result = gradeExercise(orderExercise, answer);
    expect(result.correct).toBe(true);
    expect(result.feedback).toContain('正解');
  });

  it('returns correct=false for wrong order', () => {
    const answer: ExerciseAnswer = { kind: 'orderChoices', orderedIndices: [0, 1, 2] };
    const result = gradeExercise(orderExercise, answer);
    expect(result.correct).toBe(false);
    expect(result.feedback).toContain('順番');
  });

  it('returns correct=false when length mismatch', () => {
    const answer: ExerciseAnswer = { kind: 'orderChoices', orderedIndices: [1, 2] };
    const result = gradeExercise(orderExercise, answer);
    expect(result.correct).toBe(false);
    expect(result.feedback).toContain('完成していません');
  });
});

describe('gradeExercise — kind mismatch', () => {
  it('returns correct=false when exercise and answer kinds differ', () => {
    const answer: ExerciseAnswer = { kind: 'orderChoices', orderedIndices: [0] };
    const result = gradeExercise(mcExercise, answer);
    expect(result.correct).toBe(false);
    expect(result.feedback).toContain('形式');
  });
});
