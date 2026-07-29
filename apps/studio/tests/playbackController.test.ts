import { describe, expect, it, vi } from 'vitest';
import {
  PlaybackController,
  type PlaybackRequestState,
  type PlaybackSessionHandlers,
} from '../src/audio/playbackController';

type FakeSession = {
  name: string;
  dispose: ReturnType<typeof vi.fn>;
  beginNaturalDrain?: (onComplete: () => void) => void;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function fakeSession(name: string): FakeSession {
  return { name, dispose: vi.fn() };
}

describe('PlaybackController', () => {
  it('reconciles a request that already existed when the bridge was installed', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 41 };
    const createSession = vi.fn(async () => fakeSession('initial'));
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession,
      confirmStarted: (requestId) => {
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: vi.fn(),
      interrupt: vi.fn(),
    });

    controller.reconcile();
    await settle();

    expect(createSession).toHaveBeenCalledOnce();
    expect(state).toEqual({ phase: 'playing', requestId: 41 });
  });

  it('rolls a matching rejected start back without an unhandled rejection', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 1 };
    const failStart = vi.fn((requestId: number) => {
      if (state.phase === 'starting' && state.requestId === requestId) {
        state = { phase: 'stopped', requestId: requestId + 1 };
      }
    });
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession: async () => {
        throw new Error('resume denied');
      },
      confirmStarted: vi.fn(),
      failStart,
      finish: vi.fn(),
      interrupt: vi.fn(),
    });

    controller.requestStart(1);
    await settle();

    expect(failStart).toHaveBeenCalledOnce();
    expect(failStart.mock.calls[0]?.[0]).toBe(1);
    expect(state).toEqual({ phase: 'stopped', requestId: 2 });
    expect(controller.activeSession).toBeNull();
  });

  it('accepts only B when A resolves after stop and a newer play', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 1 };
    const starts = new Map<number, Deferred<FakeSession>>();
    const handlers = new Map<number, PlaybackSessionHandlers>();
    const confirmed: number[] = [];
    const finished: number[] = [];
    const interrupted: number[] = [];
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession: (requestId, callbacks) => {
        const start = deferred<FakeSession>();
        starts.set(requestId, start);
        handlers.set(requestId, callbacks);
        return start.promise;
      },
      confirmStarted: (requestId) => {
        confirmed.push(requestId);
        if (state.phase === 'starting' && state.requestId === requestId) {
          state = { phase: 'playing', requestId };
        }
      },
      failStart: vi.fn(),
      finish: (requestId) => finished.push(requestId),
      interrupt: (requestId) => interrupted.push(requestId),
    });

    controller.requestStart(1);
    state = { phase: 'stopped', requestId: 2 };
    controller.stop();
    state = { phase: 'starting', requestId: 3 };
    controller.requestStart(3);

    const sessionB = fakeSession('B');
    starts.get(3)?.resolve(sessionB);
    await settle();
    expect(controller.activeSession).toBe(sessionB);
    expect(confirmed).toEqual([3]);

    const sessionA = fakeSession('A');
    starts.get(1)?.resolve(sessionA);
    await settle();
    expect(sessionA.dispose).toHaveBeenCalledOnce();
    expect(sessionB.dispose).not.toHaveBeenCalled();
    expect(controller.activeSession).toBe(sessionB);
    expect(confirmed).toEqual([3]);

    // Even a stale scheduler callback cannot finish or interrupt B.
    handlers.get(1)?.onEnd();
    handlers.get(1)?.onInterrupted();
    expect(finished).toEqual([]);
    expect(interrupted).toEqual([]);
    expect(controller.activeSession).toBe(sessionB);
  });

  it('accepts only B when stale A resolves before the newer request', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 1 };
    const starts = new Map<number, Deferred<FakeSession>>();
    const confirmed: number[] = [];
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession: (requestId) => {
        const start = deferred<FakeSession>();
        starts.set(requestId, start);
        return start.promise;
      },
      confirmStarted: (requestId) => {
        confirmed.push(requestId);
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: vi.fn(),
      interrupt: vi.fn(),
    });

    controller.requestStart(1);
    state = { phase: 'stopped', requestId: 2 };
    controller.stop();
    state = { phase: 'starting', requestId: 3 };
    controller.requestStart(3);

    const sessionA = fakeSession('A-first');
    starts.get(1)?.resolve(sessionA);
    await settle();
    expect(sessionA.dispose).toHaveBeenCalledOnce();
    expect(confirmed).toEqual([]);

    const sessionB = fakeSession('B-second');
    starts.get(3)?.resolve(sessionB);
    await settle();
    expect(confirmed).toEqual([3]);
    expect(controller.activeSession).toBe(sessionB);
  });

  it('single-flights duplicate notifications for one starting request', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 7 };
    const start = deferred<FakeSession>();
    const createSession = vi.fn(() => start.promise);
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession,
      confirmStarted: (requestId) => {
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: vi.fn(),
      interrupt: vi.fn(),
    });

    controller.requestStart(7);
    controller.requestStart(7);
    expect(createSession).toHaveBeenCalledOnce();

    start.resolve(fakeSession('only'));
    await settle();
    expect(state.phase).toBe('playing');
  });

  it('replaces an active session when a new starting generation supersedes it', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 50 };
    const sessions = new Map<number, FakeSession>();
    const replacementStart = deferred<FakeSession>();
    const createSession = vi.fn((requestId: number) => {
      if (requestId === 51) return replacementStart.promise;
      const session = fakeSession(`session-${requestId}`);
      sessions.set(requestId, session);
      return Promise.resolve(session);
    });
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession,
      confirmStarted: (requestId) => {
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: vi.fn(),
      interrupt: vi.fn(),
    });

    controller.reconcile();
    await settle();
    expect(controller.activeSession).toBe(sessions.get(50));

    state = { phase: 'starting', requestId: 51 };
    controller.reconcile(state);

    // Supersession is fail-closed: the old scheduler is gone before any async
    // work for the replacement can reserve its first lookahead window.
    expect(sessions.get(50)?.dispose).toHaveBeenCalledOnce();
    expect(controller.activeSession).toBeNull();

    const replacement = fakeSession('session-51');
    sessions.set(51, replacement);
    replacementStart.resolve(replacement);
    await settle();

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(sessions.get(51)?.dispose).not.toHaveBeenCalled();
    expect(controller.activeSession).toBe(sessions.get(51));
    expect(state).toEqual({ phase: 'playing', requestId: 51 });
  });

  it('disposes a late session when stopped during startup', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 10 };
    const start = deferred<FakeSession>();
    const confirmStarted = vi.fn();
    const failStart = vi.fn();
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession: () => start.promise,
      confirmStarted,
      failStart,
      finish: vi.fn(),
      interrupt: vi.fn(),
    });

    controller.requestStart(10);
    state = { phase: 'stopped', requestId: 11 };
    controller.stop();
    const late = fakeSession('late');
    start.resolve(late);
    await settle();

    expect(late.dispose).toHaveBeenCalledOnce();
    expect(confirmStarted).not.toHaveBeenCalled();
    expect(failStart).not.toHaveBeenCalled();
  });

  it('reports interruption before tearing down the active generation', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 20 };
    let callbacks!: PlaybackSessionHandlers;
    const interrupted: number[] = [];
    const finished: number[] = [];
    const session = fakeSession('active');
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession: async (_requestId, handlers) => {
        callbacks = handlers;
        return session;
      },
      confirmStarted: (requestId) => {
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: (requestId) => {
        finished.push(requestId);
        state = { phase: 'stopped', requestId: requestId + 1 };
      },
      interrupt: (requestId) => {
        interrupted.push(requestId);
        state = { phase: 'stopped', requestId: requestId + 1 };
      },
    });

    controller.requestStart(20);
    await settle();
    callbacks.onInterrupted();

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(interrupted).toEqual([20]);
    expect(finished).toEqual([]);
    expect(controller.activeSession).toBeNull();

    // An already-disposed callback is idempotent.
    callbacks.onEnd();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(finished).toEqual([]);
  });

  it('does not leave a session playing if browser output disappears at confirmation', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 30 };
    const isReady = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const session = { ...fakeSession('vanished'), isReady };
    const interrupt = vi.fn((requestId: number) => {
      state = { phase: 'stopped', requestId: requestId + 1 };
    });
    const controller = new PlaybackController<typeof session>({
      getRequestState: () => state,
      createSession: async () => session,
      confirmStarted: (requestId) => {
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: vi.fn(),
      interrupt,
    });

    controller.requestStart(30);
    await settle();

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledWith(30);
    expect(state).toEqual({ phase: 'stopped', requestId: 31 });
    expect(controller.activeSession).toBeNull();
  });

  it('finishes transport immediately but preserves a natural drain through the reentrant stop', async () => {
    vi.useFakeTimers();
    try {
      let state: PlaybackRequestState = { phase: 'starting', requestId: 60 };
      let callbacks!: PlaybackSessionHandlers;
      const session: FakeSession = {
        ...fakeSession('natural-tail'),
        beginNaturalDrain: vi.fn((onComplete: () => void) => {
          setTimeout(onComplete, 500);
        }),
      };
      const finish = vi.fn((requestId: number) => {
        state = { phase: 'stopped', requestId: requestId + 1 };
        controller.reconcile(state);
      });
      const controller = new PlaybackController<FakeSession>({
        getRequestState: () => state,
        createSession: async (_requestId, handlers) => {
          callbacks = handlers;
          return session;
        },
        confirmStarted: (requestId) => {
          state = { phase: 'playing', requestId };
        },
        failStart: vi.fn(),
        finish,
        interrupt: vi.fn(),
      });

      controller.requestStart(60);
      await settle();
      callbacks.onEnd();

      expect(finish).toHaveBeenCalledWith(60);
      expect(state).toEqual({ phase: 'stopped', requestId: 61 });
      expect(controller.activeSession).toBeNull();
      expect(session.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(499);
      expect(session.dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(session.dispose).toHaveBeenCalledOnce();

      await vi.runAllTimersAsync();
      callbacks.onEnd();
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps immediate disposal for sessions without natural drain support', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 65 };
    let callbacks!: PlaybackSessionHandlers;
    const order: string[] = [];
    const session = fakeSession('no-natural-tail');
    session.dispose.mockImplementation(() => order.push('dispose'));
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession: async (_requestId, handlers) => {
        callbacks = handlers;
        return session;
      },
      confirmStarted: (requestId) => {
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: (requestId) => {
        order.push('finish');
        state = { phase: 'stopped', requestId: requestId + 1 };
      },
      interrupt: vi.fn(),
    });

    controller.requestStart(65);
    await settle();
    callbacks.onEnd();

    expect(order).toEqual(['dispose', 'finish']);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(controller.activeSession).toBeNull();
  });

  it('disposes a preserved drain on a later stopped reconciliation', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 70 };
    let callbacks!: PlaybackSessionHandlers;
    let completeDrain!: () => void;
    const session: FakeSession = {
      ...fakeSession('project-a-tail'),
      beginNaturalDrain: (onComplete) => {
        completeDrain = onComplete;
      },
    };
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession: async (_requestId, handlers) => {
        callbacks = handlers;
        return session;
      },
      confirmStarted: (requestId) => {
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: (requestId) => {
        state = { phase: 'stopped', requestId: requestId + 1 };
        controller.reconcile(state);
      },
      interrupt: vi.fn(),
    });

    controller.requestStart(70);
    await settle();
    callbacks.onEnd();
    expect(session.dispose).not.toHaveBeenCalled();

    state = { phase: 'stopped', requestId: 72 };
    controller.reconcile(state);
    expect(session.dispose).toHaveBeenCalledOnce();

    completeDrain();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it('manual stop and controller disposal synchronously tear down natural drains', async () => {
    async function startDrainingSession(
      requestId: number,
    ): Promise<{
      controller: PlaybackController<FakeSession>;
      session: FakeSession;
      complete: () => void;
    }> {
      let state: PlaybackRequestState = { phase: 'starting', requestId };
      let callbacks!: PlaybackSessionHandlers;
      let complete!: () => void;
      const session: FakeSession = {
        ...fakeSession(`drain-${requestId}`),
        beginNaturalDrain: (onComplete) => {
          complete = onComplete;
        },
      };
      const controller = new PlaybackController<FakeSession>({
        getRequestState: () => state,
        createSession: async (_candidateRequestId, handlers) => {
          callbacks = handlers;
          return session;
        },
        confirmStarted: (confirmedRequestId) => {
          state = { phase: 'playing', requestId: confirmedRequestId };
        },
        failStart: vi.fn(),
        finish: (finishedRequestId) => {
          state = { phase: 'stopped', requestId: finishedRequestId + 1 };
          controller.reconcile(state);
        },
        interrupt: vi.fn(),
      });
      controller.requestStart(requestId);
      await settle();
      callbacks.onEnd();
      return { controller, session, complete };
    }

    const stopped = await startDrainingSession(80);
    stopped.controller.stop();
    expect(stopped.session.dispose).toHaveBeenCalledOnce();
    stopped.complete();
    expect(stopped.session.dispose).toHaveBeenCalledOnce();

    const disposed = await startDrainingSession(90);
    disposed.controller.dispose();
    expect(disposed.session.dispose).toHaveBeenCalledOnce();
    disposed.complete();
    expect(disposed.session.dispose).toHaveBeenCalledOnce();
  });

  it('a drain interruption tears it down without interrupting the already-finished transport', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 100 };
    let callbacks!: PlaybackSessionHandlers;
    let completeDrain!: () => void;
    const session: FakeSession = {
      ...fakeSession('interrupted-tail'),
      beginNaturalDrain: (onComplete) => {
        completeDrain = onComplete;
      },
    };
    const interrupt = vi.fn();
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession: async (_requestId, handlers) => {
        callbacks = handlers;
        return session;
      },
      confirmStarted: (requestId) => {
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: (requestId) => {
        state = { phase: 'stopped', requestId: requestId + 1 };
        controller.reconcile(state);
      },
      interrupt,
    });

    controller.requestStart(100);
    await settle();
    callbacks.onEnd();
    callbacks.onInterrupted();

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
    completeDrain();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it('disposes an old drain before replacement startup and ignores its stale completion', async () => {
    let state: PlaybackRequestState = { phase: 'starting', requestId: 110 };
    const callbacks = new Map<number, PlaybackSessionHandlers>();
    const completions = new Map<number, () => void>();
    const sessions = new Map<number, FakeSession>();
    const order: string[] = [];
    const createSession = vi.fn(async (requestId: number, handlers: PlaybackSessionHandlers) => {
      order.push(`create-${requestId}`);
      callbacks.set(requestId, handlers);
      const base = fakeSession(`session-${requestId}`);
      base.dispose.mockImplementation(() => order.push(`dispose-${requestId}`));
      const session: FakeSession = {
        ...base,
        beginNaturalDrain: (onComplete) => {
          completions.set(requestId, onComplete);
        },
      };
      sessions.set(requestId, session);
      return session;
    });
    const controller = new PlaybackController<FakeSession>({
      getRequestState: () => state,
      createSession,
      confirmStarted: (requestId) => {
        state = { phase: 'playing', requestId };
      },
      failStart: vi.fn(),
      finish: (requestId) => {
        state = { phase: 'stopped', requestId: requestId + 1 };
        controller.reconcile(state);
      },
      interrupt: vi.fn(),
    });

    controller.requestStart(110);
    await settle();
    callbacks.get(110)?.onEnd();
    expect(sessions.get(110)?.dispose).not.toHaveBeenCalled();

    state = { phase: 'starting', requestId: 112 };
    controller.reconcile(state);
    expect(order.slice(-2)).toEqual(['dispose-110', 'create-112']);
    await settle();
    callbacks.get(112)?.onEnd();
    expect(sessions.get(112)?.dispose).not.toHaveBeenCalled();

    completions.get(110)?.();
    expect(sessions.get(110)?.dispose).toHaveBeenCalledOnce();
    expect(sessions.get(112)?.dispose).not.toHaveBeenCalled();

    completions.get(112)?.();
    expect(sessions.get(112)?.dispose).toHaveBeenCalledOnce();
    completions.get(110)?.();
    completions.get(112)?.();
    expect(sessions.get(110)?.dispose).toHaveBeenCalledOnce();
    expect(sessions.get(112)?.dispose).toHaveBeenCalledOnce();
  });
});
