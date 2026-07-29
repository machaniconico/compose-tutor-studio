/**
 * Coordinates asynchronous audio startup with the synchronous transport store.
 *
 * A request id is the authority boundary: work started for an older request may
 * finish, but it can never become the active session or mutate the current
 * transport. The controller deliberately has no Web Audio or Zustand imports so
 * the race contract can be tested with deferred promises.
 */

export type PlaybackRequestState = {
  phase: 'stopped' | 'starting' | 'playing';
  requestId: number;
};

export type PlaybackSessionHandlers = {
  onEnd: () => void;
  onInterrupted: () => void;
};

export type PlaybackSession = {
  dispose: () => void;
  /** Keep the session alive only long enough to release its natural audio tail. */
  beginNaturalDrain?: (onComplete: () => void) => void;
  /** Optional last-moment readiness check for browser-owned resources. */
  isReady?: () => boolean;
};

export type PlaybackControllerDependencies<TSession extends PlaybackSession> = {
  getRequestState: () => PlaybackRequestState;
  createSession: (
    requestId: number,
    handlers: PlaybackSessionHandlers,
    isCurrent: () => boolean,
  ) => Promise<TSession>;
  confirmStarted: (requestId: number) => void;
  failStart: (requestId: number, error: unknown) => void;
  finish: (requestId: number) => void;
  interrupt: (requestId: number) => void;
};

export class PlaybackController<TSession extends PlaybackSession> {
  private readonly pending = new Set<number>();
  private active: { requestId: number; session: TSession } | null = null;
  private draining: { requestId: number; session: TSession } | null = null;
  private preserveDrainForReentrantStop: {
    drain: { requestId: number; session: TSession };
    consumed: boolean;
  } | null = null;
  private disposed = false;

  constructor(private readonly dependencies: PlaybackControllerDependencies<TSession>) {}

  get activeSession(): TSession | null {
    return this.active?.session ?? null;
  }

  /** Reconcile a subscription snapshot, including the state present at install time. */
  reconcile(state: PlaybackRequestState = this.dependencies.getRequestState()): void {
    if (this.disposed) return;
    if (state.phase === 'starting') {
      // A superseding topology request (for example a loop toggle) must not
      // overlap the old scheduler with the candidate session's first lookahead.
      this.disposeDraining();
      if (this.active?.requestId !== state.requestId) this.disposeActive();
      this.requestStart(state.requestId);
    } else if (state.phase === 'stopped') {
      const preservation = this.preserveDrainForReentrantStop;
      if (
        preservation &&
        !preservation.consumed &&
        state.requestId === preservation.drain.requestId + 1 &&
        this.draining === preservation.drain
      ) {
        preservation.consumed = true;
        this.disposeActive();
        return;
      }
      this.stop();
    } else if (this.active?.requestId !== state.requestId) {
      // A replaced bridge cannot inherit another controller's audio resources.
      // Fail closed instead of presenting a playing state with no owner.
      this.disposeDraining();
      this.dependencies.interrupt(state.requestId);
    }
  }

  /** Begin one generation. Duplicate notifications for the same id are ignored. */
  requestStart(requestId: number): void {
    if (this.disposed || this.pending.has(requestId)) return;
    this.disposeDraining();
    this.pending.add(requestId);
    void this.start(requestId);
  }

  /** Stop the accepted session. Pending generations are invalidated by the store id. */
  stop(): void {
    this.disposeActive();
    this.disposeDraining();
  }

  /** Permanently tear down this controller. Late promises are disposed on arrival. */
  dispose(): void {
    this.disposed = true;
    this.disposeActive();
    this.disposeDraining();
  }

  private isCurrent(requestId: number, phase: PlaybackRequestState['phase']): boolean {
    if (this.disposed) return false;
    const current = this.dependencies.getRequestState();
    return current.requestId === requestId && current.phase === phase;
  }

  private async start(requestId: number): Promise<void> {
    let candidate: TSession | null = null;
    try {
      candidate = await this.dependencies.createSession(
        requestId,
        {
          onEnd: () => this.handleEnd(requestId),
          onInterrupted: () => this.handleInterruption(requestId),
        },
        () => this.isCurrent(requestId, 'starting'),
      );

      if (!this.isCurrent(requestId, 'starting')) {
        candidate.dispose();
        return;
      }
      if (candidate.isReady?.() === false) {
        throw new Error('Playback session lost its output before startup was confirmed.');
      }

      // Only one accepted session may own audio resources. This is defensive;
      // a valid store transition normally stops the previous session first.
      this.disposeActive();
      this.active = { requestId, session: candidate };
      candidate = null;
      this.dependencies.confirmStarted(requestId);

      // A confirm callback is required to synchronously acknowledge this exact
      // generation. If it did not, do not leave an unowned scheduler running.
      const confirmed = this.isCurrent(requestId, 'playing');
      const ready = this.active?.session.isReady?.() !== false;
      if (!confirmed || !ready) {
        if (confirmed && !ready) {
          this.interruptActive(requestId);
        } else {
          this.disposeActive(requestId);
        }
      }
    } catch (error) {
      candidate?.dispose();
      if (this.isCurrent(requestId, 'starting')) {
        this.dependencies.failStart(requestId, error);
      }
    } finally {
      this.pending.delete(requestId);
    }
  }

  private handleEnd(requestId: number): void {
    if (this.active?.requestId !== requestId || !this.isCurrent(requestId, 'playing')) return;
    const active = this.active;
    if (!active.session.beginNaturalDrain) {
      this.disposeActive(requestId);
      this.dependencies.finish(requestId);
      return;
    }

    this.active = null;
    this.disposeDraining();
    const drain = active;
    this.draining = drain;
    try {
      active.session.beginNaturalDrain(() => this.completeDrain(drain));
    } catch {
      this.completeDrain(drain);
    }

    if (this.draining !== drain) {
      this.dependencies.finish(requestId);
      return;
    }

    const preservation = { drain, consumed: false };
    this.preserveDrainForReentrantStop = preservation;
    try {
      this.dependencies.finish(requestId);
    } finally {
      if (this.preserveDrainForReentrantStop === preservation) {
        this.preserveDrainForReentrantStop = null;
      }
    }
  }

  private handleInterruption(requestId: number): void {
    if (this.draining?.requestId === requestId) {
      this.disposeDraining(requestId);
      return;
    }
    if (this.active?.requestId !== requestId || !this.isCurrent(requestId, 'playing')) return;
    this.interruptActive(requestId);
  }

  private interruptActive(requestId: number): void {
    this.dependencies.interrupt(requestId);
    if (!this.isCurrent(requestId, 'playing')) {
      this.disposeActive(requestId);
    }
  }

  private disposeActive(requestId?: number): void {
    if (!this.active || (requestId !== undefined && this.active.requestId !== requestId)) return;
    const active = this.active;
    this.active = null;
    active.session.dispose();
  }

  private completeDrain(drain: { requestId: number; session: TSession }): void {
    if (this.draining !== drain) return;
    this.draining = null;
    drain.session.dispose();
  }

  private disposeDraining(requestId?: number): void {
    if (!this.draining || (requestId !== undefined && this.draining.requestId !== requestId)) {
      return;
    }
    const draining = this.draining;
    this.draining = null;
    draining.session.dispose();
  }
}
