// Course / lesson browser shown in the チュートリアル tab when no lesson is running.
// Lists ALL_COURSES with their lessons; each lesson card shows its saved status
// and step count, and clicking starts (or resumes) it.

import {
  ALL_COURSES,
  getLessonById,
  type LessonStatus,
  type TutorialLesson,
} from '@cts/tutorial-engine';
import {
  lessonSavedStep,
  lessonStatus,
  startLesson,
} from '../../state/tutorialBridge';

const STATUS_LABEL: Record<LessonStatus, string> = {
  idle: '未開始',
  inProgress: '進行中',
  completed: '完了',
};

/** Browse courses and lessons; start/resume on click. */
export function LessonBrowser() {
  return (
    <div className="lesson-browser">
      <p className="panel-section__title">レッスン一覧</p>
      {ALL_COURSES.map((course) => (
        <section key={course.id} className="course-card">
          <h3 className="course-card__title">{course.title}</h3>
          <p className="course-card__desc">{course.description}</p>
          <ul className="lesson-list">
            {course.lessonIds
              .map((id) => getLessonById(id))
              .filter((l): l is TutorialLesson => Boolean(l))
              .map((lesson) => (
                <LessonCard key={lesson.id} lesson={lesson} />
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function LessonCard({ lesson }: { lesson: TutorialLesson }) {
  const status = lessonStatus(lesson.id);
  const savedStep = lessonSavedStep(lesson.id);
  const stepCount = lesson.steps.length;
  const cta =
    status === 'completed' ? 'もう一度' : status === 'inProgress' ? '再開する' : '始める';

  return (
    <li className="lesson-card">
      <button
        type="button"
        className="lesson-card__btn"
        onClick={() => startLesson(lesson.id)}
      >
        <span className="lesson-card__head">
          <span className="lesson-card__title">{lesson.title}</span>
          <span className={`lesson-status lesson-status--${status}`}>
            {STATUS_LABEL[status]}
          </span>
        </span>
        <span className="lesson-card__desc">{lesson.description}</span>
        <span className="lesson-card__meta">
          {status === 'inProgress'
            ? `ステップ ${Math.min(savedStep + 1, stepCount)} / ${stepCount}`
            : `全 ${stepCount} ステップ`}
          <span className="lesson-card__cta">{cta}</span>
        </span>
      </button>
    </li>
  );
}
