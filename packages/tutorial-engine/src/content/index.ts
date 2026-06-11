// Content registry — all courses and lessons

import type { Course, TutorialLesson } from '../types.js';
import { BASIC_COURSE, BASIC_LESSONS } from './basic-course.js';
import { COMPOSE_COURSE, COMPOSE_LESSONS } from './compose-course.js';

export { BASIC_COURSE, BASIC_LESSONS } from './basic-course.js';
export { COMPOSE_COURSE, COMPOSE_LESSONS } from './compose-course.js';

export const ALL_COURSES: Course[] = [BASIC_COURSE, COMPOSE_COURSE];

export const ALL_LESSONS: TutorialLesson[] = [...BASIC_LESSONS, ...COMPOSE_LESSONS];

const lessonMap = new Map<string, TutorialLesson>(ALL_LESSONS.map((l) => [l.id, l]));

export function getLessonById(id: string): TutorialLesson | undefined {
  return lessonMap.get(id);
}
