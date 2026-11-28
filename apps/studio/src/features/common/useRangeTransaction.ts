import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type PointerEventHandler,
} from 'react';
import { useStore } from '../../state/store';
import { matchShortcut } from './keymap';

export type RangeTransactionProps = Readonly<{
  onPointerDown: PointerEventHandler<HTMLInputElement>;
  onPointerUp: PointerEventHandler<HTMLInputElement>;
  onPointerCancel: PointerEventHandler<HTMLInputElement>;
  onLostPointerCapture: PointerEventHandler<HTMLInputElement>;
  onBlur: FocusEventHandler<HTMLInputElement>;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
}>;

/** One pointer drag. Its token is the store transaction owner; nothing else may close it. */
type Gesture = {
  readonly token: object;
  readonly pointerId: number;
  readonly element: HTMLInputElement;
  /** What the dragged control edits (track / clip); a change while dragging ends the drag. */
  readonly scope: string;
  readonly startValue: number;
  lastValue: number;
};

/**
 * Groups one pointer drag on any range input of a component into one undo
 * step, with the same lifecycle as the mixer faders (useAutomationGesture):
 * pointerdown opens a project transaction owned by that gesture alone;
 * pointerup of the owning pointer / lost capture / blur of the dragged
 * slider / tab hidden / unmount / a change of `scope` commit it, pointercancel
 * and Escape restore the base, and a project switch discards it. A drag that
 * ends at its starting value is cancelled, so it adds no undo step. Arrow
 * keys during a drag are ignored; outside a drag each press stays one step.
 * The value keeps being applied to the live project during the drag.
 *
 * `scope` identifies the edit target (for example track and clip ids).
 */
export function useRangeTransaction(scope: string): Readonly<{
  props: RangeTransactionProps;
  /** Wrap an onChange: it is skipped while a refused, ended or foreign drag is in play. */
  guard: <T extends HTMLInputElement>(
    apply: (event: ChangeEvent<T>) => void,
  ) => (event: ChangeEvent<T>) => void;
}> {
  const gesture = useRef<Gesture | null>(null);
  // Pointer whose refused, cancelled or finished drag still has the native
  // input moving; writes stay off until that pointer is released.
  const suppressedPointer = useRef<number | null>(null);
  const latestScope = useRef(scope);
  latestScope.current = scope;

  const [lifecycle] = useState(() => {
    const end = (mode: 'commit' | 'cancel' | 'discard' = 'commit'): void => {
      const current = gesture.current;
      gesture.current = null;
      if (current === null) return;
      suppressedPointer.current = current.pointerId;
      const state = useStore.getState();
      if (mode === 'commit') {
        // Back at the starting value is a no-op: cancel instead of committing.
        if (current.lastValue === current.startValue) state.cancelProjectTransaction(current.token);
        else state.commitProjectTransaction(current.token);
      } else if (mode === 'cancel') {
        state.cancelProjectTransaction(current.token);
      }
    };
    return { end };
  });

  useEffect(() => {
    const current = gesture.current;
    if (current !== null && current.scope !== scope) lifecycle.end();
  }, [scope, lifecycle]);

  useEffect(() => {
    const reset = (): void => lifecycle.end();
    const onEscape = (event: KeyboardEvent): void => {
      if (gesture.current === null || matchShortcut(event, 'gesture') !== 'cancelGesture') return;
      event.preventDefault();
      event.stopPropagation();
      lifecycle.end('cancel');
    };
    const onPointerRelease = (event: PointerEvent): void => {
      if (suppressedPointer.current === event.pointerId && gesture.current === null) {
        suppressedPointer.current = null;
      }
    };
    const unsubscribe = useStore.subscribe((state, previous) => {
      const current = gesture.current;
      if (
        current !== null
        && (
          state.saveState.activationId !== previous.saveState.activationId
          || !state.ownsProjectTransaction(current.token, current.pointerId)
        )
      ) {
        lifecycle.end('discard');
      }
    });
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('pointerup', onPointerRelease);
    window.addEventListener('pointercancel', onPointerRelease);
    return () => {
      unsubscribe();
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('pointerup', onPointerRelease);
      window.removeEventListener('pointercancel', onPointerRelease);
      lifecycle.end();
    };
  }, [lifecycle]);

  const release = (pointerId: number, mode: 'commit' | 'cancel'): void => {
    const current = gesture.current;
    if (current !== null) {
      // Only the owning pointer may end its drag.
      if (current.pointerId !== pointerId) return;
      lifecycle.end(mode);
    }
    if (suppressedPointer.current === pointerId) suppressedPointer.current = null;
  };

  return {
    props: {
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        if (gesture.current !== null) {
          // A second pointer never takes over a drag in progress.
          event.preventDefault();
          return;
        }
        const element = event.currentTarget;
        const token = {};
        const state = useStore.getState();
        if (!state.beginProjectTransaction(token, event.pointerId)) {
          suppressedPointer.current = event.pointerId;
          event.preventDefault();
          return;
        }
        suppressedPointer.current = null;
        const startValue = element.valueAsNumber;
        gesture.current = {
          token,
          pointerId: event.pointerId,
          element,
          scope: latestScope.current,
          startValue,
          lastValue: startValue,
        };
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // Some DOMs do not provide pointer capture.
        }
      },
      onPointerUp: (event) => release(event.pointerId, 'commit'),
      onPointerCancel: (event) => release(event.pointerId, 'cancel'),
      onLostPointerCapture: (event) => release(event.pointerId, 'commit'),
      // A stale blur from a slider whose own drag is over must not touch the next one.
      onBlur: (event) => {
        if (gesture.current?.element === event.currentTarget) lifecycle.end();
      },
      onKeyDown: (event) => {
        if (gesture.current !== null && event.key.startsWith('Arrow')) event.preventDefault();
      },
    },
    guard: (apply) => (event) => {
      const current = gesture.current;
      if (current !== null) {
        if (current.element !== event.currentTarget) return;
        if (current.scope !== latestScope.current) {
          // The edit target moved under the drag: close it on the original target.
          lifecycle.end();
          return;
        }
        current.lastValue = event.currentTarget.valueAsNumber;
      } else if (suppressedPointer.current !== null) {
        return;
      }
      apply(event);
    },
  };
}
