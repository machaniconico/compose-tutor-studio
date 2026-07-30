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

type GestureSource =
  | Readonly<{ kind: 'pointer'; pointerId: number }>
  | Readonly<{ kind: 'keyboard' }>
  | Readonly<{ kind: 'implicit' }>;

export type AutomationGestureAdapter = Readonly<{
  pointerDown: (pointerId: number, value: number) => void;
  pointerUp: (pointerId: number) => void;
  pointerCancel: (pointerId: number) => void;
  lostPointerCapture: (pointerId: number) => void;
  keyDown: (key: string, value: number, repeat?: boolean) => void;
  keyUp: (key: string) => void;
  change: (value: number) => void;
  blur: () => void;
  dispose: () => void;
  isActive: () => boolean;
}>;

export type AutomationGestureAdapterOptions = Readonly<{
  shouldCapture: () => boolean;
  setScalar: (value: number) => void;
  beginCapture: (value: number) => boolean;
  updateCapture: (value: number) => boolean;
  endCapture: () => boolean;
}>;

/**
 * Event-order-independent gesture state machine. Every terminal browser event
 * goes through finish(), so pointerup followed by lostpointercapture (or keyup
 * followed by blur) releases a runtime automation target exactly once.
 */
export function createAutomationGestureAdapter(
  options: AutomationGestureAdapterOptions,
): AutomationGestureAdapter {
  let active: GestureSource | null = null;
  let pending: GestureSource | null = null;

  const begin = (source: GestureSource, value: number): boolean => {
    if (active !== null) return false;
    if (!options.shouldCapture()) {
      pending = null;
      return false;
    }
    if (!options.beginCapture(value)) {
      pending = source;
      return false;
    }
    active = source;
    pending = null;
    return true;
  };

  const finish = (): boolean => {
    if (active === null) return true;
    if (!options.endCapture()) return false;
    active = null;
    return true;
  };

  const finishPointer = (pointerId: number): void => {
    if (
      active?.kind === 'pointer'
      && active.pointerId === pointerId
    ) {
      finish();
      return;
    }
    if (
      pending?.kind === 'pointer'
      && pending.pointerId === pointerId
    ) {
      pending = null;
    }
  };

  const finishAll = (): void => {
    if (active !== null) {
      finish();
      return;
    }
    pending = null;
  };

  return Object.freeze({
    pointerDown(pointerId, value) {
      begin({ kind: 'pointer', pointerId }, value);
    },
    pointerUp: finishPointer,
    pointerCancel: finishPointer,
    lostPointerCapture: finishPointer,
    keyDown(key, value, repeat = false) {
      if (!RANGE_ADJUSTMENT_KEYS.has(key) || repeat) return;
      begin({ kind: 'keyboard' }, value);
    },
    keyUp(key) {
      if (!RANGE_ADJUSTMENT_KEYS.has(key)) return;
      if (active?.kind === 'keyboard') {
        finish();
        return;
      }
      if (pending?.kind === 'keyboard') pending = null;
    },
    change(value) {
      if (!Number.isFinite(value)) return;
      if (!options.shouldCapture()) {
        if (active !== null) {
          finish();
          return;
        }
        pending = null;
        options.setScalar(value);
        return;
      }
      if (active === null) {
        begin(pending ?? { kind: 'implicit' }, value);
        return;
      }
      options.updateCapture(value);
    },
    blur: finishAll,
    dispose: finishAll,
    isActive: () => active !== null,
  });
}

export type AutomationGestureInputProps = Readonly<{
  displayValue: number;
  onPointerDown: PointerEventHandler<HTMLInputElement>;
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
    phase,
    mode,
    target: { trackId, type: targetType } satisfies AutomationTarget,
    setScalar,
    beginAutomationGesture,
    updateAutomationGesture,
    endAutomationGesture,
  });
  latest.current = {
    phase,
    mode,
    target: { trackId, type: targetType },
    setScalar,
    beginAutomationGesture,
    updateAutomationGesture,
    endAutomationGesture,
  };

  const adapterRef = useRef<AutomationGestureAdapter | null>(null);
  if (adapterRef.current === null) {
    adapterRef.current = createAutomationGestureAdapter({
      shouldCapture: () => {
        const current = latest.current;
        return current.phase === 'playing' && current.mode !== 'read';
      },
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
    });
  }
  const adapter = adapterRef.current;

  useEffect(() => () => adapter.dispose(), [adapter]);
  useEffect(() => {
    setPreviewValue(null);
  }, [trackId, targetType, mode]);
  useEffect(() => {
    if (phase !== 'playing') setPreviewValue(null);
  }, [phase]);

  const clearCompletedPreview = (): void => {
    if (
      !adapter.isActive()
      && (
        phase !== 'playing'
        || mode === 'read'
        || mode === 'touch'
      )
    ) {
      setPreviewValue(null);
    }
  };

  return {
    displayValue: resolveAutomationGestureDisplayValue(
      sharedOverrideValue ?? previewValue,
      scalarValue,
      readDisplayValue,
      followLiveRead,
    ),
    onPointerDown: (event) => {
      setPreviewValue(event.currentTarget.valueAsNumber);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture can be unavailable in SSR/test DOMs; terminal events
        // still share the same exactly-once state machine.
      }
      adapter.pointerDown(event.pointerId, event.currentTarget.valueAsNumber);
    },
    onPointerUp: (event) => {
      adapter.pointerUp(event.pointerId);
      clearCompletedPreview();
    },
    onPointerCancel: (event) => {
      adapter.pointerCancel(event.pointerId);
      clearCompletedPreview();
    },
    onLostPointerCapture: (event) => {
      adapter.lostPointerCapture(event.pointerId);
      clearCompletedPreview();
    },
    onKeyDown: (event) => {
      if (RANGE_ADJUSTMENT_KEYS.has(event.key) && !event.repeat) {
        setPreviewValue(event.currentTarget.valueAsNumber);
      }
      adapter.keyDown(
        event.key,
        event.currentTarget.valueAsNumber,
        event.repeat,
      );
    },
    onKeyUp: (event) => {
      adapter.keyUp(event.key);
      clearCompletedPreview();
    },
    onChange: (event) => {
      setPreviewValue(event.currentTarget.valueAsNumber);
      adapter.change(event.currentTarget.valueAsNumber);
    },
    onBlur: () => {
      adapter.blur();
      clearCompletedPreview();
    },
  };
}
