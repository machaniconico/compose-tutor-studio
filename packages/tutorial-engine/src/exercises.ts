// Exercise grading

import type {
  Exercise,
  ExerciseAnswer,
  GradeResult,
  MultipleChoiceAnswer,
  OrderChoicesAnswer,
} from './types.js';

export function gradeExercise(
  exercise: Exercise,
  answer: ExerciseAnswer,
): GradeResult {
  if (exercise.kind === 'multipleChoice' && answer.kind === 'multipleChoice') {
    return gradeMultipleChoice(exercise.correctIndex, exercise.explanation, answer);
  }
  if (exercise.kind === 'orderChoices' && answer.kind === 'orderChoices') {
    return gradeOrderChoices(exercise.correctOrder, exercise.explanation, answer);
  }
  return {
    correct: false,
    feedback: '回答の形式が問題と一致しません。もう一度試してください。',
  };
}

function gradeMultipleChoice(
  correctIndex: number,
  explanation: string,
  answer: MultipleChoiceAnswer,
): GradeResult {
  const correct = answer.selectedIndex === correctIndex;
  return {
    correct,
    feedback: correct
      ? `正解です！${explanation}`
      : `惜しいです。正解は選択肢 ${correctIndex + 1} でした。${explanation}`,
  };
}

function gradeOrderChoices(
  correctOrder: number[],
  explanation: string,
  answer: OrderChoicesAnswer,
): GradeResult {
  if (answer.orderedIndices.length !== correctOrder.length) {
    return {
      correct: false,
      feedback: `並び替えが完成していません。${explanation}`,
    };
  }
  const correct = correctOrder.every(
    (idx, pos) => answer.orderedIndices[pos] === idx,
  );
  return {
    correct,
    feedback: correct
      ? `正解です！${explanation}`
      : `順番が違います。もう一度考えてみましょう。${explanation}`,
  };
}
