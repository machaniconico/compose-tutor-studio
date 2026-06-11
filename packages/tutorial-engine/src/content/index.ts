// Content registry — all courses and lessons

import type { Course, TutorialLesson } from '../types.js';
import { BASIC_COURSE, BASIC_LESSONS } from './basic-course.js';
import { COMPOSE_COURSE, COMPOSE_LESSONS } from './compose-course.js';
import { COURSE0_COURSE, COURSE0_LESSONS } from '../courses.js';

export { BASIC_COURSE, BASIC_LESSONS } from './basic-course.js';
export { COMPOSE_COURSE, COMPOSE_LESSONS } from './compose-course.js';
export { COURSE0_COURSE, COURSE0_LESSONS } from '../courses.js';

export const ALL_COURSES: Course[] = [COURSE0_COURSE, BASIC_COURSE, COMPOSE_COURSE];

export const ALL_LESSONS: TutorialLesson[] = [...COURSE0_LESSONS, ...BASIC_LESSONS, ...COMPOSE_LESSONS];

const lessonMap = new Map<string, TutorialLesson>(ALL_LESSONS.map((l) => [l.id, l]));

export function getLessonById(id: string): TutorialLesson | undefined {
  return lessonMap.get(id);
}
