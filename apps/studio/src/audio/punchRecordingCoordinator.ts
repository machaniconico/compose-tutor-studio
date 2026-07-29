export type PunchRecordingDiscardReason = 'cancelled' | 'interrupted';

export type PunchRecordingCoordinatorTerminal =
  | 'active'
  | 'finalized'
  | 'discarded';

export type PunchRecordingCoordinatorSnapshot = Readonly<{
  captureComplete: boolean;
  postrollComplete: boolean;
  terminal: PunchRecordingCoordinatorTerminal;
  discardReason: PunchRecordingDiscardReason | null;
}>;

export type PunchRecordingCoordinatorCallbacks = Readonly<{
  onFinalize: () => void;
  onDiscard: (reason: PunchRecordingDiscardReason) => void;
}>;

export type PunchRecordingCoordinator = Readonly<{
  /**
   * Accept capture completion once. Finalization occurs synchronously when the
   * natural post-roll has also completed.
   */
  signalCaptureComplete: () => boolean;
  /**
   * Accept natural post-roll completion once. Finalization occurs synchronously
   * when capture has also completed.
   */
  signalPostrollComplete: () => boolean;
  /** Discard an unfinished operation. */
  cancel: () => boolean;
  /** Discard an unfinished operation after a transport/device interruption. */
  interrupt: () => boolean;
  getSnapshot: () => PunchRecordingCoordinatorSnapshot;
}>;

const INITIAL_SNAPSHOT: PunchRecordingCoordinatorSnapshot = Object.freeze({
  captureComplete: false,
  postrollComplete: false,
  terminal: 'active',
  discardReason: null,
});

/**
 * Coordinate the two independently ordered punch completion signals.
 *
 * Terminal state is committed before a callback runs. Therefore duplicates,
 * late delivery, and callback re-entry cannot finalize or discard twice.
 */
export function createPunchRecordingCoordinator(
  callbacks: PunchRecordingCoordinatorCallbacks,
): PunchRecordingCoordinator {
  let snapshot = INITIAL_SNAPSHOT;

  const signalCompletion = (
    kind: 'capture' | 'postroll',
  ): boolean => {
    if (snapshot.terminal !== 'active') return false;
    if (
      (kind === 'capture' && snapshot.captureComplete)
      || (kind === 'postroll' && snapshot.postrollComplete)
    ) {
      return false;
    }

    const captureComplete =
      kind === 'capture' ? true : snapshot.captureComplete;
    const postrollComplete =
      kind === 'postroll' ? true : snapshot.postrollComplete;
    const terminal = captureComplete && postrollComplete
      ? 'finalized'
      : 'active';
    snapshot = Object.freeze({
      captureComplete,
      postrollComplete,
      terminal,
      discardReason: null,
    });
    if (terminal === 'finalized') callbacks.onFinalize();
    return true;
  };

  const discard = (reason: PunchRecordingDiscardReason): boolean => {
    if (snapshot.terminal !== 'active') return false;
    snapshot = Object.freeze({
      ...snapshot,
      terminal: 'discarded',
      discardReason: reason,
    });
    callbacks.onDiscard(reason);
    return true;
  };

  return Object.freeze({
    signalCaptureComplete: () => signalCompletion('capture'),
    signalPostrollComplete: () => signalCompletion('postroll'),
    cancel: () => discard('cancelled'),
    interrupt: () => discard('interrupted'),
    getSnapshot: () => snapshot,
  });
}
