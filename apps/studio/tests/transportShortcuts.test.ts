import { describe, expect, it, vi } from 'vitest';
import {
  getTransportShortcut,
  handleTransportShortcutKeyDown,
  isEditableShortcutTarget,
  saveIndicatorText,
  type TransportShortcutEvent,
} from '../src/features/transport/TransportBar';

type FakeElement = EventTarget & {
  getAttribute: (name: string) => string | null;
  isContentEditable: boolean;
  parentElement: FakeElement | null;
  tagName: string;
};

function fakeElement(
  tagName: string,
  options: { contentEditable?: string; isContentEditable?: boolean; parentElement?: FakeElement } = {},
): FakeElement {
  const attributes = new Map<string, string>();
  if (options.contentEditable !== undefined) {
    attributes.set('contenteditable', options.contentEditable);
  }

  return Object.assign(new EventTarget(), {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    isContentEditable: options.isContentEditable ?? false,
    parentElement: options.parentElement ?? null,
    tagName,
  });
}

function shortcutEvent(
  key: string,
  init: Partial<TransportShortcutEvent> = {},
): TransportShortcutEvent {
  return {
    altKey: init.altKey ?? false,
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
    key,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    target: init.target ?? null,
  };
}

function keydown(key: string, init: Partial<TransportShortcutEvent> = {}): KeyboardEvent {
  if (typeof KeyboardEvent === 'function') {
    return new KeyboardEvent('keydown', {
      altKey: init.altKey ?? false,
      bubbles: true,
      cancelable: true,
      code: init.code ?? '',
      ctrlKey: init.ctrlKey ?? false,
      key,
      metaKey: init.metaKey ?? false,
      shiftKey: init.shiftKey ?? false,
    });
  }

  const event = new Event('keydown', { bubbles: true, cancelable: true }) as KeyboardEvent;
  Object.defineProperties(event, {
    altKey: { value: init.altKey ?? false },
    code: { value: init.code ?? '' },
    ctrlKey: { value: init.ctrlKey ?? false },
    key: { value: key },
    metaKey: { value: init.metaKey ?? false },
    shiftKey: { value: init.shiftKey ?? false },
  });
  return event;
}

function makeActions(isPlaying = false) {
  return {
    isPlaying,
    play: vi.fn(),
    redo: vi.fn(),
    saveToLocalStorage: vi.fn(),
    stop: vi.fn(),
    undo: vi.fn(),
  };
}

describe('transport shortcut key matching', () => {
  it('maps Space to playback toggle without colliding with piano roll local keys', () => {
    expect(getTransportShortcut(shortcutEvent(' '))).toBe('togglePlayback');
    expect(getTransportShortcut(shortcutEvent('Space'))).toBe('togglePlayback');
    expect(getTransportShortcut(shortcutEvent('Spacebar'))).toBe('togglePlayback');
    expect(getTransportShortcut(shortcutEvent('', { code: 'Space' }))).toBe('togglePlayback');

    for (const key of ['q', 'Q', 's', 'S', 'c', 'C', 'Delete', 'Backspace']) {
      expect(getTransportShortcut(shortcutEvent(key))).toBeNull();
    }
  });

  it('maps command-key save, undo, and redo shortcuts', () => {
    expect(getTransportShortcut(shortcutEvent('s', { ctrlKey: true }))).toBe('save');
    expect(getTransportShortcut(shortcutEvent('S', { metaKey: true }))).toBe('save');
    expect(getTransportShortcut(shortcutEvent('z', { ctrlKey: true }))).toBe('undo');
    expect(getTransportShortcut(shortcutEvent('z', { metaKey: true }))).toBe('undo');
    expect(getTransportShortcut(shortcutEvent('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(getTransportShortcut(shortcutEvent('y', { ctrlKey: true }))).toBe('redo');
    expect(getTransportShortcut(shortcutEvent('Y', { metaKey: true }))).toBe('redo');
  });

  it('ignores shortcuts while focus is in editable targets', () => {
    const input = fakeElement('input');
    const textarea = fakeElement('textarea');
    const select = fakeElement('select');
    const editable = fakeElement('div', { contentEditable: 'true' });
    const editableChild = fakeElement('span', { parentElement: editable });

    for (const target of [input, textarea, select, editable, editableChild]) {
      expect(isEditableShortcutTarget(target)).toBe(true);
      expect(getTransportShortcut(shortcutEvent(' ', { target }))).toBeNull();
      expect(getTransportShortcut(shortcutEvent('z', { ctrlKey: true, target }))).toBeNull();
    }
  });
});

describe('transport shortcut keydown handler', () => {
  it('dispatches Space keydown to play when stopped and stop when playing', () => {
    const stoppedActions = makeActions(false);
    const stoppedTarget = new EventTarget();
    const stoppedEvent = keydown(' ');
    stoppedTarget.addEventListener('keydown', (event) =>
      handleTransportShortcutKeyDown(event as KeyboardEvent, stoppedActions),
    );

    stoppedTarget.dispatchEvent(stoppedEvent);

    expect(stoppedActions.play).toHaveBeenCalledOnce();
    expect(stoppedActions.stop).not.toHaveBeenCalled();
    expect(stoppedEvent.defaultPrevented).toBe(true);

    const playingActions = makeActions(true);
    const playingTarget = new EventTarget();
    const playingEvent = keydown(' ');
    playingTarget.addEventListener('keydown', (event) =>
      handleTransportShortcutKeyDown(event as KeyboardEvent, playingActions),
    );

    playingTarget.dispatchEvent(playingEvent);

    expect(playingActions.stop).toHaveBeenCalledOnce();
    expect(playingActions.play).not.toHaveBeenCalled();
    expect(playingEvent.defaultPrevented).toBe(true);
  });

  it('dispatches undo and redo keydowns to the matching store actions', () => {
    const actions = makeActions();
    const target = new EventTarget();
    target.addEventListener('keydown', (event) =>
      handleTransportShortcutKeyDown(event as KeyboardEvent, actions),
    );

    target.dispatchEvent(keydown('z', { ctrlKey: true }));
    target.dispatchEvent(keydown('Z', { ctrlKey: true, shiftKey: true }));
    target.dispatchEvent(keydown('y', { ctrlKey: true }));

    expect(actions.undo).toHaveBeenCalledOnce();
    expect(actions.redo).toHaveBeenCalledTimes(2);
  });

  it('does not prevent default or fire actions for editable targets', () => {
    const actions = makeActions();
    const preventDefault = vi.fn();
    const stopImmediatePropagation = vi.fn();
    const event = {
      ...shortcutEvent('z', { ctrlKey: true, target: fakeElement('input') }),
      preventDefault,
      stopImmediatePropagation,
    } as unknown as KeyboardEvent;

    handleTransportShortcutKeyDown(event, actions);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopImmediatePropagation).not.toHaveBeenCalled();
    expect(actions.undo).not.toHaveBeenCalled();
    expect(actions.play).not.toHaveBeenCalled();
  });
});

describe('save indicator text', () => {
  it('exposes clear Japanese save states for the transport bar', () => {
    expect(saveIndicatorText({ status: 'idle', lastSavedAt: null, errorMessage: null })).toBe('未保存');
    expect(saveIndicatorText({ status: 'saving', lastSavedAt: null, errorMessage: null })).toBe('保存中...');
    expect(
      saveIndicatorText({
        status: 'error',
        lastSavedAt: null,
        errorMessage: '保存に失敗しました。',
      }),
    ).toBe('保存失敗: 保存に失敗しました。');
  });
});
