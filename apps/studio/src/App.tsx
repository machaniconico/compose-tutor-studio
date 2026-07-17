import { useCallback, useEffect, useRef, useState } from 'react';
import { TransportBar } from './features/transport/TransportBar';
import { TrackList } from './features/tracklist/TrackList';
import { ChordLane } from './features/chordTrack/ChordLane';
import { EditorArea } from './features/editor/EditorArea';
import {
  InspectorPanel,
  type RightTab,
} from './features/inspector/InspectorPanel';
import { MixerStrip } from './features/mixer/MixerStrip';
import { ToastStack } from './features/tutorial/ToastStack';
import {
  OnboardingOverlay,
  shouldShowOnboarding,
} from './features/onboarding/OnboardingOverlay';
import { useStore } from './state/store';
import { startLesson } from './state/tutorialBridge';
import { isAnyDialogOpen } from './features/common/dialogState';
import { registerPersistenceLifecycle } from './state/persistenceLifecycle';

/** True when focus is in a text-entry field, where shortcuts must not fire. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

/** Native/custom controls own Space while focused; the transport shortcut does not. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest(
      [
        'button',
        'input',
        'textarea',
        'select',
        'a[href]',
        'summary',
        '[contenteditable="true"]',
        '[role="button"]',
        '[role="checkbox"]',
        '[role="menuitem"]',
        '[role="slider"]',
        '[role="tab"]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(','),
    ) !== null
  );
}

type FocusTarget = { focus: () => void };

const FIRST_SONG_TITLE = '最初の1曲';
const FIRST_COMPOSITION_LESSON_ID = 'compose-1';
const FIRST_SONG_START_ERROR =
  'いまの曲を安全に保存できなかったため、レッスンを始められませんでした。保存のお知らせを確認して、もう一度お試しください。';

function isCurrentProjectDurable(current: ReturnType<typeof useStore.getState>): boolean {
  const { saveState } = current;
  return (
    saveState.phase === 'saved' &&
    saveState.projectId === current.project.id &&
    saveState.persistedRevision >= saveState.revision
  );
}

export type FirstSongStartResult =
  | { ok: true; retryProjectId: null }
  | { ok: false; retryProjectId: string | null };

/** Activate and save a blank project before starting the first composition lesson. */
export async function startFirstSongLesson(
  retryProjectId: string | null = null,
): Promise<FirstSongStartResult> {
  let current = useStore.getState();
  let activeAttemptProjectId: string;

  // Only the project activated by this still-open onboarding attempt may be
  // retried. A title or content-shape check could silently reuse an older song.
  if (retryProjectId !== null && current.project.id === retryProjectId) {
    activeAttemptProjectId = retryProjectId;
    if (!isCurrentProjectDurable(current)) {
      if (!(await current.saveToLocalStorage())) {
        return {
          ok: false,
          retryProjectId:
            useStore.getState().project.id === retryProjectId ? retryProjectId : null,
        };
      }
      current = useStore.getState();
    }
  } else {
    const previousProjectId = current.project.id;
    const created = await current.createNewProject(FIRST_SONG_TITLE);
    current = useStore.getState();
    const activatedProjectId =
      current.project.id === previousProjectId ? null : current.project.id;
    if (!created || activatedProjectId === null) {
      return { ok: false, retryProjectId: activatedProjectId };
    }
    activeAttemptProjectId = activatedProjectId;
  }
  if (
    current.project.id !== activeAttemptProjectId ||
    !isCurrentProjectDurable(current)
  ) {
    return {
      ok: false,
      retryProjectId:
        current.project.id === activeAttemptProjectId ? activeAttemptProjectId : null,
    };
  }
  // The CTA always uses a pristine blank canvas, so resuming a later step from
  // a previous song would make the instructions disagree with this project.
  startLesson(FIRST_COMPOSITION_LESSON_ID, { restart: true });
  return { ok: true, retryProjectId: null };
}

/** Focus the tutorial destination only for a completed primary onboarding handoff. */
export function focusTutorialTabAfterOnboarding(
  guideOpen: boolean,
  rightTab: RightTab,
  focusRequested: boolean,
  target: FocusTarget | null,
): boolean {
  if (guideOpen || rightTab !== 'tutorial' || !focusRequested || !target) return false;
  target.focus();
  return true;
}

/** Root layout: CSS-grid studio shell wiring the feature panels together. */
export function App() {
  // Onboarding visibility is lifted here so the transport bar's guide button can
  // re-open it after the first dismissal.
  const [guideOpen, setGuideOpen] = useState(() => shouldShowOnboarding());
  const [rightTab, setRightTab] = useState<RightTab>('inspector');
  const [lessonStartState, setLessonStartState] = useState<'idle' | 'pending' | 'error'>('idle');
  const tutorialTabRef = useRef<HTMLButtonElement>(null);
  const guideButtonRef = useRef<HTMLButtonElement>(null);
  const shouldFocusTutorialRef = useRef(false);
  const shouldFocusGuideRef = useRef(false);
  const lessonStartInFlightRef = useRef(false);
  const firstSongRetryProjectIdRef = useRef<string | null>(null);
  const persistenceNotice = useStore((state) => state.persistenceNotice);
  const clearPersistenceNotice = useStore((state) => state.clearPersistenceNotice);

  const openGuide = useCallback(() => {
    shouldFocusGuideRef.current = false;
    firstSongRetryProjectIdRef.current = null;
    setLessonStartState('idle');
    setGuideOpen(true);
  }, []);
  const closeGuide = useCallback(() => {
    shouldFocusGuideRef.current = true;
    firstSongRetryProjectIdRef.current = null;
    setLessonStartState('idle');
    setGuideOpen(false);
  }, []);
  const handleLessonStarted = useCallback(async (): Promise<boolean> => {
    if (lessonStartInFlightRef.current) return false;
    lessonStartInFlightRef.current = true;
    setLessonStartState('pending');
    try {
      const result = await startFirstSongLesson(firstSongRetryProjectIdRef.current);
      if (!result.ok) {
        firstSongRetryProjectIdRef.current = result.retryProjectId;
        setLessonStartState('error');
        return false;
      }

      firstSongRetryProjectIdRef.current = null;
      shouldFocusGuideRef.current = false;
      shouldFocusTutorialRef.current = true;
      setRightTab('tutorial');
      setGuideOpen(false);
      return true;
    } catch {
      setLessonStartState('error');
      return false;
    } finally {
      lessonStartInFlightRef.current = false;
    }
  }, []);

  // The onboarding dialog is removed in the same render that reveals the lesson.
  // Move focus only after that commit so keyboard and screen-reader users land on
  // the newly selected, meaningful destination instead of the removed CTA.
  useEffect(() => {
    const focused = focusTutorialTabAfterOnboarding(
      guideOpen,
      rightTab,
      shouldFocusTutorialRef.current,
      tutorialTabRef.current,
    );
    if (focused) shouldFocusTutorialRef.current = false;
    if (!guideOpen && shouldFocusGuideRef.current && guideButtonRef.current) {
      guideButtonRef.current.focus();
      shouldFocusGuideRef.current = false;
    }
  }, [guideOpen, rightTab]);

  // Global keyboard shortcuts: Space = play/stop, Cmd/Ctrl+S = save. Skipped
  // while typing in a field or while a modal dialog (incl. onboarding) is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isAnyDialogOpen()) return;

      if (e.key === ' ' || e.code === 'Space') {
        if (isInteractiveTarget(e.target)) return;
        e.preventDefault();
        const s = useStore.getState();
        if (s.transport.phase !== 'stopped') s.stop();
        else s.play();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        void useStore.getState().saveToLocalStorage();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Flush the latest immutable edit snapshot before the browser backgrounds or
  // discards the page. The store makes duplicate lifecycle events idempotent.
  useEffect(
    () =>
      registerPersistenceLifecycle({
        flushAsync: () => useStore.getState().flushPendingSave(),
        flushSynchronously: () => useStore.getState().flushPendingSaveSynchronously(),
        hasUnsavedChanges: () => {
          const state = useStore.getState();
          return (
            state.audioRecordingOperationId !== null
            || state.saveState.phase === 'pending'
            || state.saveState.phase === 'error'
          );
        },
      }),
    [],
  );

  return (
    <div className="app-shell">
      {persistenceNotice ? (
        <div
          className={`persistence-notice persistence-notice--${persistenceNotice.kind}`}
          role={persistenceNotice.kind === 'warning' ? 'alert' : 'status'}
          aria-live={persistenceNotice.kind === 'warning' ? 'assertive' : 'polite'}
        >
          <span>{persistenceNotice.message}</span>
          <button type="button" onClick={clearPersistenceNotice} aria-label="保存のお知らせを閉じる">
            閉じる
          </button>
        </div>
      ) : null}
      <TransportBar onOpenGuide={openGuide} guideButtonRef={guideButtonRef} />
      <TrackList />
      <main className="center-pane">
        <ChordLane />
        <EditorArea />
      </main>
      <InspectorPanel
        activeTab={rightTab}
        onTabChange={setRightTab}
        tutorialTabRef={tutorialTabRef}
      />
      <MixerStrip />
      <ToastStack />
      <OnboardingOverlay
        open={guideOpen}
        onClose={closeGuide}
        onLessonStarted={handleLessonStarted}
        lessonStartPending={lessonStartState === 'pending'}
        lessonStartError={lessonStartState === 'error' ? FIRST_SONG_START_ERROR : null}
      />
    </div>
  );
}
