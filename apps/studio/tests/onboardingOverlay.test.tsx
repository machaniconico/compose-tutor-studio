import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../src/state/store';
import { createEmptyProject } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';
import {
  __resetRendererStorageFenceForTest,
  fenceRendererStorageWrites,
} from '../src/platform/rendererStorageFence';

// This component is DOM-only apart from its effect. Replacing useEffect lets us
// exercise its click handlers as a plain React element tree without adding a DOM
// test environment to the otherwise node-only studio suite.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useEffect: vi.fn(),
    useId: vi.fn(() => 'test-modal-id'),
    useRef: vi.fn((initialValue: unknown) => ({ current: initialValue })),
  };
});

type ClickableProps = {
  children?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  'aria-disabled'?: boolean;
};

let OnboardingOverlay: typeof import('../src/features/onboarding/OnboardingOverlay')['OnboardingOverlay'];
let bridge: typeof import('../src/state/tutorialBridge');
let focusTutorialTabAfterOnboarding: typeof import('../src/App')['focusTutorialTabAfterOnboarding'];
let startFirstSongLesson: typeof import('../src/App')['startFirstSongLesson'];

beforeAll(async () => {
  ({ OnboardingOverlay } = await import('../src/features/onboarding/OnboardingOverlay'));
  bridge = await import('../src/state/tutorialBridge');
  ({
    focusTutorialTabAfterOnboarding,
    startFirstSongLesson,
  } = await import('../src/App'));
});

beforeEach(() => {
  __resetRendererStorageFenceForTest();
  installLocalStorage();
  bridge.__resetBridgeForTest();
});

function findButton(node: ReactNode, label: string): ReactElement<ClickableProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;

  const props = node.props as { children?: ReactNode };
  if (node.type === 'button' && props.children === label) {
    return node as ReactElement<ClickableProps>;
  }
  return findButton(props.children, label);
}

function findByRole(node: ReactNode, role: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByRole(child, role);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;

  const props = node.props as { children?: ReactNode; role?: string };
  if (props.role === role) return node;
  return findByRole(props.children, role);
}

describe('OnboardingOverlay lesson handoff', () => {
  it('creates 最初の1曲 before starting compose-1', async () => {
    const original = useStore.getState();
    const project = createEmptyProject({ title: '最初の1曲' });
    const createNewProject = vi.fn(async (_title?: string) => {
      useStore.setState((state) => ({
        project,
        saveState: {
          ...state.saveState,
          phase: 'saved',
          projectId: project.id,
          persistedRevision: state.saveState.revision,
          failure: null,
          retry: null,
        },
      }));
      return true;
    });
    useStore.setState({ createNewProject });

    try {
      await expect(startFirstSongLesson()).resolves.toEqual({
        ok: true,
        retryProjectId: null,
      });
    } finally {
      useStore.setState({
        project: original.project,
        createNewProject: original.createNewProject,
        saveState: original.saveState,
      });
    }

    expect(createNewProject).toHaveBeenCalledOnce();
    expect(createNewProject).toHaveBeenCalledWith('最初の1曲');
    expect(bridge.getActiveLessonId()).toBe('compose-1');
    expect(bridge.getBridgeSnapshot().engineState?.status).toBe('inProgress');
  });

  it('restarts compose-1 at step 1 for the newly blank project', async () => {
    localStorage.setItem(
      'cts.tutorial.compose-1',
      JSON.stringify({
        lessonId: 'compose-1',
        status: 'inProgress',
        currentStep: 3,
        updatedAt: '2026-07-10T00:00:00.000Z',
        eventCounts: {},
      }),
    );
    const original = useStore.getState();
    const project = createEmptyProject({ title: '最初の1曲' });
    const createNewProject = vi.fn(async () => {
      useStore.setState((state) => ({
        project,
        saveState: {
          ...state.saveState,
          phase: 'saved',
          projectId: project.id,
          persistedRevision: state.saveState.revision,
          failure: null,
          retry: null,
        },
      }));
      return true;
    });
    useStore.setState({ createNewProject });

    try {
      await expect(startFirstSongLesson()).resolves.toEqual({
        ok: true,
        retryProjectId: null,
      });
    } finally {
      useStore.setState({
        project: original.project,
        createNewProject: original.createNewProject,
        saveState: original.saveState,
      });
    }

    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(0);
    expect(bridge.loadProgress('compose-1')?.currentStep).toBe(0);
  });

  it('does not start compose-1 when the new project cannot be created', async () => {
    const originalCreateNewProject = useStore.getState().createNewProject;
    const createNewProject = vi.fn(async (_title?: string) => false);
    useStore.setState({ createNewProject });

    try {
      await expect(startFirstSongLesson()).resolves.toEqual({
        ok: false,
        retryProjectId: null,
      });
    } finally {
      useStore.setState({ createNewProject: originalCreateNewProject });
    }

    expect(createNewProject).toHaveBeenCalledWith('最初の1曲');
    expect(bridge.getActiveLessonId()).toBeNull();
  });

  it('does not start compose-1 when the new project is visible but not durable', async () => {
    const original = useStore.getState();
    const project = createEmptyProject({ title: '最初の1曲' });
    const createNewProject = vi.fn(async () => {
      useStore.setState((state) => ({
        project,
        saveState: {
          ...state.saveState,
          phase: 'error',
          projectId: project.id,
          persistedRevision: -1,
          failure: 'quota-exceeded',
          retry: 'manual',
        },
      }));
      return false;
    });
    useStore.setState({ createNewProject });

    try {
      await expect(startFirstSongLesson()).resolves.toEqual({
        ok: false,
        retryProjectId: project.id,
      });
    } finally {
      useStore.setState({
        project: original.project,
        createNewProject: original.createNewProject,
        saveState: original.saveState,
      });
    }

    expect(createNewProject).toHaveBeenCalledWith('最初の1曲');
    expect(bridge.getActiveLessonId()).toBeNull();
  });

  it('re-saves only the exact project activated by the failed onboarding attempt', async () => {
    const original = useStore.getState();
    const project = createEmptyProject({ title: '最初の1曲' });
    const createNewProject = vi.fn(async () => true);
    const saveToLocalStorage = vi.fn(async () => {
      useStore.setState((state) => ({
        saveState: {
          ...state.saveState,
          phase: 'saved',
          projectId: project.id,
          persistedRevision: state.saveState.revision,
          failure: null,
          retry: null,
        },
      }));
      return true;
    });
    useStore.setState({
      project,
      createNewProject,
      saveToLocalStorage,
      saveState: {
        ...original.saveState,
        phase: 'error',
        projectId: project.id,
        persistedRevision: -1,
        failure: 'write-failed',
        retry: 'automatic',
      },
    });

    try {
      await expect(startFirstSongLesson(project.id)).resolves.toEqual({
        ok: true,
        retryProjectId: null,
      });
    } finally {
      useStore.setState({
        project: original.project,
        createNewProject: original.createNewProject,
        saveToLocalStorage: original.saveToLocalStorage,
        saveState: original.saveState,
      });
    }

    expect(saveToLocalStorage).toHaveBeenCalledOnce();
    expect(createNewProject).not.toHaveBeenCalled();
    expect(bridge.getActiveLessonId()).toBe('compose-1');
  });

  it('creates a new blank project instead of reusing a matching historical project', async () => {
    const original = useStore.getState();
    const historicalProject = createEmptyProject({ title: '最初の1曲' });
    const newProject = createEmptyProject({ title: '最初の1曲' });
    const createNewProject = vi.fn(async () => {
      useStore.setState((state) => ({
        project: newProject,
        saveState: {
          ...state.saveState,
          phase: 'saved',
          projectId: newProject.id,
          persistedRevision: state.saveState.revision,
          failure: null,
          retry: null,
        },
      }));
      return true;
    });
    useStore.setState({
      project: historicalProject,
      createNewProject,
      saveState: {
        ...original.saveState,
        phase: 'saved',
        projectId: historicalProject.id,
        persistedRevision: original.saveState.revision,
        failure: null,
        retry: null,
      },
    });

    try {
      await expect(startFirstSongLesson()).resolves.toEqual({
        ok: true,
        retryProjectId: null,
      });
      expect(useStore.getState().project.id).toBe(newProject.id);
    } finally {
      useStore.setState({
        project: original.project,
        createNewProject: original.createNewProject,
        saveState: original.saveState,
      });
    }

    expect(createNewProject).toHaveBeenCalledOnce();
    expect(createNewProject).toHaveBeenCalledWith('最初の1曲');
    expect(bridge.getActiveLessonId()).toBe('compose-1');
  });

  it('marks onboarding complete only after the parent reports a successful handoff', async () => {
    const onClose = vi.fn();
    const onLessonStarted = vi.fn(async () => true);
    const overlay = OnboardingOverlay({
      open: true,
      onClose,
      onLessonStarted,
      lessonStartPending: false,
      lessonStartError: null,
    });
    const startButton = findButton(overlay, '最初の1曲を作る');

    expect(startButton).not.toBeNull();
    startButton?.props.onClick();

    await vi.waitFor(() => expect(onLessonStarted).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem('cts.onboarded')).toBe('1'));
    expect(onClose).not.toHaveBeenCalled();
    expect(localStorage.getItem('cts.onboarded')).toBe('1');
  });

  it('keeps onboarding active when the parent reports a failed handoff', async () => {
    const onClose = vi.fn();
    const onLessonStarted = vi.fn(async () => false);
    const overlay = OnboardingOverlay({
      open: true,
      onClose,
      onLessonStarted,
      lessonStartPending: false,
      lessonStartError: null,
    });
    const startButton = findButton(overlay, '最初の1曲を作る');

    startButton?.props.onClick();

    await vi.waitFor(() => expect(onLessonStarted).toHaveBeenCalledOnce());
    expect(localStorage.getItem('cts.onboarded')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('focuses the selected tutorial tab only after the primary handoff closes', () => {
    const target = { focus: vi.fn() };

    expect(focusTutorialTabAfterOnboarding(true, 'tutorial', true, target)).toBe(false);
    expect(focusTutorialTabAfterOnboarding(false, 'inspector', true, target)).toBe(false);
    expect(focusTutorialTabAfterOnboarding(false, 'tutorial', false, target)).toBe(false);
    expect(target.focus).not.toHaveBeenCalled();

    expect(focusTutorialTabAfterOnboarding(false, 'tutorial', true, target)).toBe(true);
    expect(target.focus).toHaveBeenCalledOnce();
  });

  it('shows a retryable alert and blocks duplicate actions while preparing', () => {
    const onClose = vi.fn();
    const onLessonStarted = vi.fn(async () => false);
    const errorMessage = '最初の1曲を準備できませんでした。もう一度お試しください。';
    const failedOverlay = OnboardingOverlay({
      open: true,
      onClose,
      onLessonStarted,
      lessonStartPending: false,
      lessonStartError: errorMessage,
    });

    const alert = findByRole(failedOverlay, 'alert');
    expect(alert).not.toBeNull();
    expect((alert?.props as { children?: ReactNode }).children).toBe(errorMessage);

    const pendingOverlay = OnboardingOverlay({
      open: true,
      onClose,
      onLessonStarted,
      lessonStartPending: true,
      lessonStartError: null,
    });
    const pendingButton = findButton(pendingOverlay, '最初の1曲を準備中…');
    const laterButton = findButton(pendingOverlay, 'あとで');

    expect(pendingButton?.props.disabled).toBeUndefined();
    expect(pendingButton?.props['aria-disabled']).toBe(true);
    expect(laterButton?.props.disabled).toBe(true);
    pendingButton?.props.onClick();
    laterButton?.props.onClick();
    (pendingOverlay as ReactElement<ClickableProps>).props.onClick();
    expect(onLessonStarted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the later action and backdrop as the same close-only path', () => {
    const onClose = vi.fn();
    const onLessonStarted = vi.fn(async () => true);
    const overlay = OnboardingOverlay({
      open: true,
      onClose,
      onLessonStarted,
      lessonStartPending: false,
      lessonStartError: null,
    });
    const laterButton = findButton(overlay, 'あとで');

    expect(laterButton).not.toBeNull();
    expect((overlay as ReactElement<ClickableProps>).props.onClick).toBe(
      laterButton?.props.onClick,
    );
    laterButton?.props.onClick();

    expect(bridge.getActiveLessonId()).toBeNull();
    expect(onLessonStarted).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(localStorage.getItem('cts.onboarded')).toBe('1');
  });

  it('never recreates the onboarding flag after renderer erasure is fenced', () => {
    const onClose = vi.fn();
    const overlay = OnboardingOverlay({
      open: true,
      onClose,
      onLessonStarted: vi.fn(async () => true),
      lessonStartPending: false,
      lessonStartError: null,
    });
    fenceRendererStorageWrites();

    findButton(overlay, 'あとで')?.props.onClick();

    expect(onClose).toHaveBeenCalledOnce();
    expect(localStorage.getItem('cts.onboarded')).toBeNull();
  });
});
