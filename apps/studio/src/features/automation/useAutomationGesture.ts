import {
  useEffect,
  useRef,
  useState,
  type ChangeEventHandler,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type PointerEventHandler,
} from 'react';
import type {
  AutomationTarget,
  AutomationWriteMode,
  Project,
} from '@cts/project-model';
import {
  automationLaneForTrack,
  automationValueAt,
  isAutomationReadEnabled,
} from '../../audio/automation';
import { useStore } from '../../state/store';
import { isImeComposing, matchShortcut } from '../common/keymap';

const RANGE_ADJUSTMENT_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
]);

type PointerGestureToken = Readonly<{ kind: 'pointer'; pointerId: number }>;

/** Each gesture owns a fresh object. Pointer IDs alone can be reused by the DOM. */
export type GestureToken =
  | PointerGestureToken
  | Readonly<{ kind: 'keyboard' | 'implicit' }>;

export type AutomationGestureAdapterOptions = Readonly<{
  shouldCapture: () => boolean;
  setScalar: (value: number) => void;
  beginCapture: (value: number) => boolean;
  updateCapture: (value: number) => boolean;
  endCapture: () => boolean;
  transaction: Readonly<{
    begin: (token: PointerGestureToken) => boolean;
    owns: (token: PointerGestureToken) => boolean;
    anyActive: () => boolean;
    commit: (token: PointerGestureToken) => void;
    cancel: (token: PointerGestureToken) => void;
  }>;
}>;

export function createAutomationGestureAdapter({
  shouldCapture,
  setScalar,
  beginCapture,
  updateCapture,
  endCapture,
  transaction,
}: AutomationGestureAdapterOptions) {
  let gesture: { token: GestureToken; capturing: boolean } | null = null;
  const retired = new WeakSet<GestureToken>();

  const discard = (token: GestureToken): void => {
    retired.add(token);
    if (gesture?.token === token) gesture = null;
  };

  const owns = (token: GestureToken): boolean => {
    if (gesture?.token !== token) return false;
    if (token.kind === 'pointer' && !transaction.owns(token)) {
      discard(token);
      return false;
    }
    return true;
  };

  return {
    begin(token: GestureToken, value: number): boolean {
      if (retired.has(token) || gesture?.token === token) return false;
      if (token.kind === 'pointer') {
        // The store arbitrates every pointer begin, including attempts during
        // a keyboard recording gesture that must show the recording notice.
        if (!transaction.begin(token)) {
          discard(token);
          return false;
        }
        if (gesture !== null) discard(gesture.token);
      } else if ((gesture !== null && owns(gesture.token)) || transaction.anyActive()) {
        discard(token);
        return false;
      }
      gesture = {
        token,
        capturing: token.kind !== 'pointer' && shouldCapture() && beginCapture(value),
      };
      return true;
    },

    change(token: GestureToken, value: number): boolean {
      if (gesture?.token !== token || !owns(token) || !Number.isFinite(value)) return false;
      if (token.kind === 'pointer') {
        setScalar(value);
      } else if (shouldCapture()) {
        if (gesture.capturing) return updateCapture(value);
        return (gesture.capturing = beginCapture(value));
      } else {
        if (gesture.capturing || transaction.anyActive()) return false;
        setScalar(value);
      }
      return true;
    },

    finish(token: GestureToken, mode: 'commit' | 'cancel' = 'commit'): boolean {
      if (gesture?.token !== token || !owns(token)) return false;
      const { capturing } = gesture;
      discard(token);
      if (token.kind === 'pointer') {
        if (mode === 'commit') transaction.commit(token);
        else transaction.cancel(token);
      } else if (capturing) {
        endCapture();
      }
      return true;
    },

    discard,
    owns,
  };
}

export type AutomationGestureInputProps = Readonly<{
  displayValue: number;
  onPointerDown: PointerEventHandler<HTMLInputElement>;
  onPointerMove: PointerEventHandler<HTMLInputElement>;
  onPointerUp: PointerEventHandler<HTMLInputElement>;
  onPointerCancel: PointerEventHandler<HTMLInputElement>;
  onLostPointerCapture: PointerEventHandler<HTMLInputElement>;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onKeyUp: KeyboardEventHandler<HTMLInputElement>;
  onChange: ChangeEventHandler<HTMLInputElement>;
  onBlur: FocusEventHandler<HTMLInputElement>;
}>;

export function automationDisplayValue(
  project: Project,
  target: AutomationTarget,
  phase: 'stopped' | 'starting' | 'playing',
  beat: number,
  followReadAutomation: boolean,
): number {
  const track = project.tracks.find((candidate) => candidate.id === target.trackId);
  const baseValue = target.type === 'track-volume'
    ? track?.volume ?? 1
    : track?.pan ?? 0;
  if (
    !followReadAutomation
    || phase !== 'playing'
    || !Number.isFinite(beat)
    || beat < 0
  ) {
    return baseValue;
  }
  const lane = automationLaneForTrack(
    project.automationLanes,
    target.trackId,
    target.type,
  );
  return lane && isAutomationReadEnabled(project.automationReadState, lane)
    ? automationValueAt(lane, baseValue, beat)
    : baseValue;
}

export function resolveAutomationGestureDisplayValue(
  previewValue: number | null,
  scalarValue: number,
  readDisplayValue: number,
  followReadAutomation: boolean,
): number {
  return previewValue ?? (
    followReadAutomation ? readDisplayValue : scalarValue
  );
}

export function shouldFollowAutomationRead(
  requested: boolean,
  phase: 'stopped' | 'starting' | 'playing',
  mode: AutomationWriteMode,
): boolean {
  return requested && !(phase === 'playing' && mode === 'write');
}

export function useAutomationGesture(input: Readonly<{
  trackId: string;
  targetType: AutomationTarget['type'];
  scalarValue: number;
  followReadAutomation?: boolean;
  setScalar: (value: number) => void;
}>): AutomationGestureInputProps {
  const {
    trackId,
    targetType,
    scalarValue,
    followReadAutomation = false,
    setScalar,
  } = input;
  const phase = useStore((state) => state.transport.phase);
  const mode = useStore(
    (state) => state.automationRecording.trackModes[trackId] ?? 'read',
  );
  const followLiveRead = shouldFollowAutomationRead(
    followReadAutomation,
    phase,
    mode,
  );
  const beginAutomationGesture = useStore(
    (state) => state.beginAutomationGesture,
  );
  const updateAutomationGesture = useStore(
    (state) => state.updateAutomationGesture,
  );
  const endAutomationGesture = useStore(
    (state) => state.endAutomationGesture,
  );
  const readDisplayValue = useStore((state) => automationDisplayValue(
    state.project,
    { trackId, type: targetType },
    state.transport.phase,
    state.transport.positionBeat,
    followLiveRead,
  ));
  const sharedOverrideValue = useStore((state) => {
    const value = state.automationRecording.overrideValues[
      `${trackId}:${targetType}`
    ];
    return value !== undefined && Number.isFinite(value) ? value : null;
  });
  const [previewValue, setPreviewValue] = useState<number | null>(null);
  const latest = useRef({
    target: { trackId, type: targetType } satisfies AutomationTarget,
    setScalar,
    beginAutomationGesture,
    updateAutomationGesture,
    endAutomationGesture,
  });
  latest.current = {
    target: { trackId, type: targetType },
    setScalar,
    beginAutomationGesture,
    updateAutomationGesture,
    endAutomationGesture,
  };

  const shouldCapture = () => {
    const state = useStore.getState();
    return state.transport.phase === 'playing'
      && (state.automationRecording.trackModes[latest.current.target.trackId] ?? 'read') !== 'read';
  };

  const adapterRef = useRef<ReturnType<typeof createAutomationGestureAdapter> | null>(null);
  if (adapterRef.current === null) {
    adapterRef.current = createAutomationGestureAdapter({
      shouldCapture,
      setScalar: (value) => latest.current.setScalar(value),
      beginCapture: (value) => {
        const current = latest.current;
        return current.beginAutomationGesture(current.target, value);
      },
      updateCapture: (value) => {
        const current = latest.current;
        return current.updateAutomationGesture(current.target, value);
      },
      endCapture: () => {
        const current = latest.current;
        return current.endAutomationGesture(current.target);
      },
      transaction: {
        begin: (token) =>
          useStore.getState().beginProjectTransaction(token, token.pointerId),
        owns: (token) =>
          useStore.getState().ownsProjectTransaction(token, token.pointerId),
        anyActive: () => useStore.getState().isProjectTransactionOpen(),
        commit: (token) => useStore.getState().commitProjectTransaction(token),
        cancel: (token) => useStore.getState().cancelProjectTransaction(token),
      },
    });
  }
  const adapter = adapterRef.current;

  const activeToken = useRef<GestureToken | null>(null);
  // Native range input/change events may omit pointerId. Use the companion
  // pointer event for provenance, with null suppressing unattributed changes
  // after a refused or completed drag. Keyboard adjustment establishes its
  // own source even when the old pointer never comes back.
  const rangeSource = useRef<GestureToken | null | undefined>(undefined);
  const sawPointer = useRef(false);

  const [lifecycle] = useState(() => {
    const end = (mode: 'commit' | 'cancel' | 'discard' = 'commit'): void => {
      const token = activeToken.current;
      activeToken.current = null;
      rangeSource.current = sawPointer.current ? null : undefined;
      if (token === null) return;
      if (mode === 'discard') adapter.discard(token);
      else adapter.finish(token, mode);
    };
    return {
      end,
      clear: (mode: 'commit' | 'cancel' | 'discard' = 'commit') => {
        end(mode);
        setPreviewValue(null);
      },
    };
  });

  useEffect(() => {
    const reset = () => lifecycle.clear();
    const onEscape = (event: KeyboardEvent) => {
      const token = activeToken.current;
      if (
        token?.kind !== 'pointer' || !adapter.owns(token)
        || matchShortcut(event, 'gesture') !== 'cancelGesture'
      ) return;
      event.preventDefault();
      event.stopPropagation();
      lifecycle.clear('cancel');
    };
    const unsubscribe = useStore.subscribe((state, previous) => {
      const token = activeToken.current;
      if (
        state.saveState.activationId !== previous.saveState.activationId
        || (token?.kind === 'pointer' && !state.ownsProjectTransaction(token, token.pointerId))
      ) {
        lifecycle.clear('discard');
      }
    });
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    window.addEventListener('keydown', onEscape, true);
    return () => {
      unsubscribe();
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
      window.removeEventListener('keydown', onEscape, true);
      lifecycle.end();
    };
  }, [adapter, lifecycle, trackId, targetType]);
  useEffect(() => {
    setPreviewValue(null);
  }, [trackId, targetType, mode]);
  useEffect(() => {
    if (phase !== 'playing') setPreviewValue(null);
  }, [phase]);

  const pointerToken = (pointerId: number): PointerGestureToken | null => {
    const token = activeToken.current;
    return token?.kind === 'pointer' && token.pointerId === pointerId ? token : null;
  };

  const finishPointer = (pointerId: number, mode?: 'cancel'): void => {
    if (pointerToken(pointerId) !== null) lifecycle.clear(mode);
  };

  return {
    displayValue: resolveAutomationGestureDisplayValue(
      sharedOverrideValue ?? previewValue,
      scalarValue,
      readDisplayValue,
      followLiveRead,
    ),
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      const token = { kind: 'pointer', pointerId: event.pointerId } as const;
      sawPointer.current = true;
      rangeSource.current = null;
      if (!adapter.begin(token, event.currentTarget.valueAsNumber)) {
        event.preventDefault();
        return;
      }
      activeToken.current = token;
      rangeSource.current = token;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Some DOMs do not provide pointer capture.
      }
    },
    onPointerMove: (event) => {
      // Ignore hover. Track a competing pressed pointer so a following
      // untagged native input cannot be attributed to the owner.
      if (event.buttons !== 0 || pointerToken(event.pointerId) !== null) {
        sawPointer.current = true;
        rangeSource.current = pointerToken(event.pointerId);
      }
    },
    onPointerUp: (event) => finishPointer(event.pointerId),
    onPointerCancel: (event) => finishPointer(event.pointerId, 'cancel'),
    onLostPointerCapture: (event) => finishPointer(event.pointerId),
    onKeyDown: (event) => {
      if (!RANGE_ADJUSTMENT_KEYS.has(event.key) || isImeComposing(event.nativeEvent)) return;
      const current = activeToken.current;
      if (current?.kind === 'keyboard' && adapter.owns(current)) {
        rangeSource.current = current;
        return;
      }
      if (current?.kind === 'implicit') lifecycle.clear();
      const token = { kind: 'keyboard' } as const;
      if (adapter.begin(token, event.currentTarget.valueAsNumber)) {
        activeToken.current = token;
        rangeSource.current = token;
      } else {
        event.preventDefault();
      }
    },
    onKeyUp: (event) => {
      if (RANGE_ADJUSTMENT_KEYS.has(event.key) && activeToken.current?.kind === 'keyboard') {
        lifecycle.clear();
      }
    },
    onChange: (event) => {
      const value = event.currentTarget.valueAsNumber;
      const native = event.nativeEvent;
      const token = 'pointerId' in native && typeof native.pointerId === 'number'
        ? pointerToken(native.pointerId)
        : rangeSource.current;
      if (token !== undefined) {
        if (token !== null && adapter.change(token, value)) setPreviewValue(value);
        return;
      }

      // Some controls (for example, assistive technologies) send a range
      // change without a corresponding pointer or keyboard event.
      const implicit = { kind: 'implicit' } as const;
      if (!adapter.begin(implicit, value)) return;
      if (shouldCapture()) {
        activeToken.current = implicit;
        rangeSource.current = implicit;
        setPreviewValue(value);
      } else {
        adapter.change(implicit, value);
        adapter.finish(implicit);
      }
    },
    onBlur: () => lifecycle.clear(),
  };
}
