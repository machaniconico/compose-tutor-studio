// Tutorial bridge — owns the active TutorialEngine instance and connects it to
// app activity.
//
// Responsibilities:
//  - Instantiate a TutorialEngine for the active lesson, restoring saved
//    progress from localStorage ('cts.tutorial.<lessonId>').
//  - Subscribe to the app-event pub/sub (src/state/appEvents.ts) and forward
//    every AppEvent into engine.handleEvent(event, project), surfacing toast
//    feedback when a step advances or the lesson completes.
//  - Expose a tiny external store (subscribe + getSnapshot) so React components
//    re-render on engine/toast changes without the engine itself being reactive.
//  - Persist progress per lesson and expose per-lesson saved statuses for the
//    lesson browser.
//
// Pure-ish: the only side effects are localStorage and the in-memory engine. No
// React imports here so the bridge stays unit-testable.

import type { Project } from '@cts/project-model';
import {
  TutorialEngine,
  getLessonById,
  type AppEvent,
  type EngineState,
  type ExerciseAnswer,
  type FeedbackResult,
  type GradeResult,
  type LessonStatus,
  type SavedProgress,
} from '@cts/tutorial-engine';
import { subscribeAppEvents } from './appEvents';
import { useStore } from './store';
import { areRendererStorageWritesFenced } from '../platform/rendererStorageFence';

const PROGRESS_PREFIX = 'cts.tutorial.';

// ─── Toast model ──────────────────────────────────────────────────────────────

export type ToastKind = 'info' | 'success' | 'error';

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
};

const TOAST_TTL_MS = 4000;
let toastCounter = 0;

// ─── Bridge state (external store) ────────────────────────────────────────────

type BridgeSnapshot = {
  /** Engine state of the active lesson, or null when no lesson is running. */
  engineState: EngineState | null;
  /** Active toasts (newest last). */
  toasts: Toast[];
  /** The hint last requested for the current step, or null. */
  hint: string | null;
};

let snapshot: BridgeSnapshot = { engineState: null, toasts: [], hint: null };

const subscribers = new Set<() => void>();

function emit(): void {
  for (const fn of subscribers) fn();
}

/** Subscribe to bridge state changes (used by React's useSyncExternalStore). */
export function subscribeBridge(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/** Current immutable bridge snapshot. */
export function getBridgeSnapshot(): BridgeSnapshot {
  return snapshot;
}

function setSnapshot(patch: Partial<BridgeSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

// ─── Active engine ────────────────────────────────────────────────────────────

let engine: TutorialEngine | null = null;
let activeLessonId: string | null = null;
let unsubscribeEvents: (() => void) | null = null;
let unsubscribeProject: (() => void) | null = null;
let reconciliationEpoch = 0;
let queuedReconciliationEpoch: number | null = null;

/** Refresh the snapshot's engineState from the live engine. */
function syncEngineState(): void {
  setSnapshot({ engineState: engine ? engine.getState() : null });
}

// ─── Progress persistence ─────────────────────────────────────────────────────

function progressKey(lessonId: string): string {
  return `${PROGRESS_PREFIX}${lessonId}`;
}

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // sandboxed contexts can throw
  }
  return null;
}

/** Read saved progress for a lesson, or null if absent/corrupt. */
export function loadProgress(lessonId: string): SavedProgress | null {
  const storage = getStorage();
  if (!storage) return null;
  const raw = storage.getItem(progressKey(lessonId));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as SavedProgress).lessonId === 'string'
    ) {
      return value as SavedProgress;
    }
  } catch {
    // corrupt entry — ignore
  }
  return null;
}

/** Persist the current engine progress for the active lesson. */
export function saveProgress(): void {
  if (areRendererStorageWritesFenced()) return;
  if (!engine) return;
  const progress = engine.toProgress();
  if (!progress) return;
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(progressKey(progress.lessonId), JSON.stringify(progress));
  } catch {
    // best-effort
  }
}

/** Lesson status for the browser: completed / inProgress / idle (未開始). */
export function lessonStatus(lessonId: string): LessonStatus {
  const progress = loadProgress(lessonId);
  return progress ? progress.status : 'idle';
}

/** Saved current step index for a lesson (0 when none). */
export function lessonSavedStep(lessonId: string): number {
  const progress = loadProgress(lessonId);
  return progress ? progress.currentStep : 0;
}

// ─── Toasts ───────────────────────────────────────────────────────────────────

/** Push a toast; it auto-dismisses after TOAST_TTL_MS. */
export function pushToast(message: string, kind: ToastKind = 'info'): void {
  toastCounter += 1;
  const id = `toast-${toastCounter}`;
  const toast: Toast = { id, kind, message };
  setSnapshot({ toasts: [...snapshot.toasts, toast] });
  if (typeof setTimeout !== 'undefined') {
    setTimeout(() => dismissToast(id), TOAST_TTL_MS);
  }
}

/** Remove a toast by id. */
export function dismissToast(id: string): void {
  setSnapshot({ toasts: snapshot.toasts.filter((t) => t.id !== id) });
}

// ─── Event handling ───────────────────────────────────────────────────────────

function applyFeedback(result: FeedbackResult, announcement?: string | null): void {
  const message = announcement === undefined ? result.message : announcement;
  if (result.completedLesson) {
    setSnapshot({ hint: null });
    if (message) pushToast(`🎉 ${message}`, 'success');
    saveProgress();
    syncEngineState();
    return;
  }
  if (result.advanced) {
    setSnapshot({ hint: null });
    if (message) pushToast(message, 'info');
    saveProgress();
    syncEngineState();
  }
}

/**
 * Satisfy the one editor-state-backed goal from the current committed state.
 * This does not publish an AppEvent: it reconciles a state that may have become
 * true before the lesson started or while the preceding step was active.
 */
function reconcileScaleSnapGoal(): FeedbackResult | null {
  if (!engine) return null;
  const engineState = engine.getState();
  const goal = engineState.currentStep?.goal;
  if (
    engineState.status !== 'inProgress' ||
    goal?.kind !== 'event' ||
    goal.eventType !== 'scale_snap.enabled'
  ) {
    return null;
  }

  const state = useStore.getState();
  if (!state.editor.scaleSnap) return null;
  const result = engine.handleEvent(
    {
      type: 'scale_snap.enabled',
      payload: { key: state.project.key, scale: state.project.scale },
    },
    state.project,
  );
  return result.advanced ? result : null;
}

/** Reconcile consecutive project/editor-state goals from adopted store state. */
function reconcileStateBackedGoals(): boolean {
  if (!engine) return false;
  let finalResult: FeedbackResult | null = null;
  let announcement: string | null | undefined;

  while (engine.getState().status === 'inProgress') {
    const projectResult = engine.reconcileProject(useStore.getState().project);
    if (projectResult.advanced) {
      finalResult = projectResult;
      announcement = undefined;
      if (projectResult.completedLesson) break;
      continue;
    }

    const scaleSnapResult = reconcileScaleSnapGoal();
    if (!scaleSnapResult) break;
    finalResult = scaleSnapResult;
    announcement =
      'スケールスナップは現在の設定ですでにオンのため、この手順は完了しました。';
    if (scaleSnapResult.completedLesson) break;
  }

  if (!finalResult) return false;
  applyFeedback(finalResult, announcement);
  return true;
}

/**
 * Store mutation listeners run before the action's post-commit AppEvent.
 * Reconcile in a microtask so that event is consumed by the step that was
 * active when the action occurred, never by the following step.
 */
function queueProjectReconciliation(): void {
  const epoch = reconciliationEpoch;
  if (queuedReconciliationEpoch === epoch) return;
  queuedReconciliationEpoch = epoch;
  queueMicrotask(() => {
    if (queuedReconciliationEpoch === epoch) queuedReconciliationEpoch = null;
    if (epoch !== reconciliationEpoch || !engine) return;
    reconcileStateBackedGoals();
  });
}

/** Forward an app event into the active engine (exported for tests). */
export function handleAppEvent(event: AppEvent, project: Project): FeedbackResult {
  if (!engine) return { advanced: false, completedLesson: false };
  const before = engine.getState();
  const result = engine.handleEvent(event, project);
  const reconciled =
    result.advanced && !result.completedLesson ? reconcileStateBackedGoals() : false;
  if (!reconciled) applyFeedback(result);
  // Persist event-count progress even when a step did not advance, so the
  // progress bar / counts survive a reload mid-step.
  if (!result.advanced && before.status === 'inProgress') {
    saveProgress();
  }
  return result;
}

// ─── Lesson lifecycle ─────────────────────────────────────────────────────────

export type StartLessonOptions = Readonly<{
  /** Ignore saved progress and start again at step 1. */
  restart?: boolean;
}>;

/** Start (or resume) a lesson by id. Restores saved progress unless restarted. */
export function startLesson(lessonId: string, options: StartLessonOptions = {}): void {
  const lesson = getLessonById(lessonId);
  if (!lesson) return;

  engine = new TutorialEngine();
  const saved = options.restart ? null : loadProgress(lessonId);
  // A completed lesson restarts fresh so the user can replay it.
  if (saved && saved.status !== 'completed') {
    engine.loadLesson(lesson, saved);
  } else {
    engine.loadLesson(lesson);
  }
  activeLessonId = lessonId;
  reconciliationEpoch += 1;

  // (Re)subscribe to app events and adopted Project changes.
  if (unsubscribeEvents) unsubscribeEvents();
  if (unsubscribeProject) unsubscribeProject();
  unsubscribeEvents = subscribeAppEvents((event) => {
    handleAppEvent(event, useStore.getState().project);
  });
  unsubscribeProject = useStore.subscribe((next, previous) => {
    if (next.project !== previous.project) queueProjectReconciliation();
  });

  saveProgress();
  setSnapshot({ hint: null });
  syncEngineState();
  reconcileStateBackedGoals();
}

/** Stop the active lesson and return to the browser (中断). Progress is kept. */
export function stopLesson(): void {
  if (engine) saveProgress();
  if (unsubscribeEvents) {
    unsubscribeEvents();
    unsubscribeEvents = null;
  }
  if (unsubscribeProject) {
    unsubscribeProject();
    unsubscribeProject = null;
  }
  reconciliationEpoch += 1;
  queuedReconciliationEpoch = null;
  engine = null;
  activeLessonId = null;
  setSnapshot({ engineState: null, hint: null });
}

/** The lesson id currently running, or null. */
export function getActiveLessonId(): string | null {
  return activeLessonId;
}

/** Cycle to the next hint for the current step, surfacing it in the snapshot. */
export function requestHint(): void {
  if (!engine) return;
  const hint = engine.requestHint();
  setSnapshot({ hint });
}

/** Answer the current exercise step. Returns the grade for inline UI feedback. */
export function answerExercise(answer: ExerciseAnswer): GradeResult & FeedbackResult {
  if (!engine) {
    return {
      correct: false,
      feedback: 'レッスンが読み込まれていません。',
      advanced: false,
      completedLesson: false,
    };
  }
  const result = engine.answerExercise(answer);
  const reconciled =
    result.advanced && !result.completedLesson ? reconcileStateBackedGoals() : false;
  if (!reconciled) applyFeedback(result);
  return result;
}

/** Reset bridge state — used by tests to isolate cases. */
export function __resetBridgeForTest(): void {
  if (unsubscribeEvents) unsubscribeEvents();
  if (unsubscribeProject) unsubscribeProject();
  unsubscribeEvents = null;
  unsubscribeProject = null;
  reconciliationEpoch += 1;
  queuedReconciliationEpoch = null;
  engine = null;
  activeLessonId = null;
  snapshot = { engineState: null, toasts: [], hint: null };
}
