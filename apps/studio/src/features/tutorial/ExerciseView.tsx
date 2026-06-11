// Exercise UI for the lesson runner: multipleChoice (radio + grade) and
// orderChoices (tap-to-order + reset). Answers go through the bridge's
// answerExercise(), which grades via engine.answerExercise and advances on a
// correct answer.

import { useState } from 'react';
import type { Exercise } from '@cts/tutorial-engine';
import { answerExercise } from '../../state/tutorialBridge';

type Feedback = { correct: boolean; text: string } | null;

/** Render the active step's exercise. */
export function ExerciseView({ exercise }: { exercise: Exercise }) {
  if (exercise.kind === 'multipleChoice') {
    return <MultipleChoice exercise={exercise} />;
  }
  return <OrderChoices exercise={exercise} />;
}

function MultipleChoice({
  exercise,
}: {
  exercise: Extract<Exercise, { kind: 'multipleChoice' }>;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const submit = () => {
    if (selected === null) return;
    const result = answerExercise({ kind: 'multipleChoice', selectedIndex: selected });
    setFeedback({
      correct: result.correct,
      text: result.correct ? `正解！ ${exercise.explanation}` : result.feedback,
    });
  };

  return (
    <div className="exercise">
      <p className="exercise__q">{exercise.question}</p>
      <div className="exercise__choices" role="radiogroup">
        {exercise.choices.map((choice, i) => (
          <label key={i} className="exercise__choice">
            <input
              type="radio"
              name="mc-choice"
              checked={selected === i}
              onChange={() => {
                setSelected(i);
                setFeedback(null);
              }}
            />
            <span>{choice}</span>
          </label>
        ))}
      </div>
      <button
        type="button"
        className="exercise__submit"
        disabled={selected === null}
        onClick={submit}
      >
        回答する
      </button>
      {feedback ? (
        <p className={`exercise__feedback ${feedback.correct ? 'is-correct' : 'is-wrong'}`}>
          {feedback.text}
          {!feedback.correct ? '（もう一度選んでみましょう）' : ''}
        </p>
      ) : null}
    </div>
  );
}

function OrderChoices({
  exercise,
}: {
  exercise: Extract<Exercise, { kind: 'orderChoices' }>;
}) {
  // `order` holds original indices in the user's chosen order; `remaining` are
  // the still-untapped original indices.
  const [order, setOrder] = useState<number[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const remaining = exercise.choices
    .map((_, i) => i)
    .filter((i) => !order.includes(i));

  const tap = (originalIndex: number) => {
    setOrder((prev) => [...prev, originalIndex]);
    setFeedback(null);
  };
  const reset = () => {
    setOrder([]);
    setFeedback(null);
  };
  const submit = () => {
    if (order.length !== exercise.choices.length) return;
    const result = answerExercise({ kind: 'orderChoices', orderedIndices: order });
    setFeedback({
      correct: result.correct,
      text: result.correct ? `正解！ ${exercise.explanation}` : result.feedback,
    });
    if (!result.correct) setOrder([]);
  };

  return (
    <div className="exercise">
      <p className="exercise__q">{exercise.question}</p>

      <p className="exercise__sub">あなたの並び</p>
      <ol className="exercise__order">
        {order.length === 0 ? (
          <li className="exercise__order-empty">下のボタンを順にタップしてください</li>
        ) : (
          order.map((origIndex, pos) => (
            <li key={`${origIndex}-${pos}`} className="exercise__order-item">
              {pos + 1}. {exercise.choices[origIndex]}
            </li>
          ))
        )}
      </ol>

      <p className="exercise__sub">選択肢</p>
      <div className="exercise__choices">
        {remaining.map((i) => (
          <button
            key={i}
            type="button"
            className="exercise__choice-btn"
            onClick={() => tap(i)}
          >
            {exercise.choices[i]}
          </button>
        ))}
      </div>

      <div className="exercise__actions">
        <button type="button" className="exercise__reset" onClick={reset}>
          リセット
        </button>
        <button
          type="button"
          className="exercise__submit"
          disabled={order.length !== exercise.choices.length}
          onClick={submit}
        >
          回答する
        </button>
      </div>

      {feedback ? (
        <p className={`exercise__feedback ${feedback.correct ? 'is-correct' : 'is-wrong'}`}>
          {feedback.text}
        </p>
      ) : null}
    </div>
  );
}
