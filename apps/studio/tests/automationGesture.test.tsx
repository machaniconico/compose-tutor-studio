import { describe, expect, it, vi } from 'vitest';
import {
  createAutomationGestureAdapter,
  type AutomationGestureAdapterOptions,
} from '../src/features/automation/useAutomationGesture';

function fixture(capturing = true) {
  let shouldCapture = capturing;
  const calls = {
    scalar: vi.fn(),
    begin: vi.fn(() => true),
    update: vi.fn(() => true),
    end: vi.fn(() => true),
  };
  const options: AutomationGestureAdapterOptions = {
    shouldCapture: () => shouldCapture,
    setScalar: calls.scalar,
    beginCapture: calls.begin,
    updateCapture: calls.update,
    endCapture: calls.end,
  };
  return {
    adapter: createAutomationGestureAdapter(options),
    calls,
    setCapturing: (next: boolean) => {
      shouldCapture = next;
    },
  };
}

describe('shared automation gesture adapter', () => {
  it.each([
    ['pointerup', (end: ReturnType<typeof fixture>['adapter']) => end.pointerUp(7)],
    ['pointercancel', (end: ReturnType<typeof fixture>['adapter']) => end.pointerCancel(7)],
    [
      'lostpointercapture',
      (end: ReturnType<typeof fixture>['adapter']) => end.lostPointerCapture(7),
    ],
    ['blur', (end: ReturnType<typeof fixture>['adapter']) => end.blur()],
  ])('ends a pointer gesture once across %s and later terminal events', (_, terminate) => {
    const { adapter, calls } = fixture();
    adapter.pointerDown(7, 1);
    adapter.change(1.25);

    terminate(adapter);
    adapter.pointerUp(7);
    adapter.pointerCancel(7);
    adapter.lostPointerCapture(7);
    adapter.blur();

    expect(calls.begin).toHaveBeenCalledOnce();
    expect(calls.begin).toHaveBeenCalledWith(1);
    expect(calls.update).toHaveBeenCalledOnce();
    expect(calls.update).toHaveBeenCalledWith(1.25);
    expect(calls.end).toHaveBeenCalledOnce();
  });

  it('ends a keyboard gesture once on keyup even when blur follows', () => {
    const { adapter, calls } = fixture();
    adapter.keyDown('ArrowUp', 0.5);
    adapter.keyDown('ArrowUp', 0.5, true);
    adapter.change(0.51);
    adapter.keyUp('ArrowUp');
    adapter.blur();
    adapter.keyUp('ArrowUp');

    expect(calls.begin).toHaveBeenCalledOnce();
    expect(calls.update).toHaveBeenCalledOnce();
    expect(calls.end).toHaveBeenCalledOnce();
  });

  it('retries a rejected terminal end and releases exactly once', () => {
    const { adapter, calls } = fixture();
    calls.end
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    adapter.pointerDown(7, 1);

    adapter.pointerUp(7);
    expect(adapter.isActive()).toBe(true);
    expect(calls.end).toHaveBeenCalledOnce();

    adapter.lostPointerCapture(7);
    adapter.pointerCancel(7);
    adapter.blur();

    expect(adapter.isActive()).toBe(false);
    expect(calls.end).toHaveBeenCalledTimes(2);
  });

  it('keeps pointer identity when a change retries a rejected begin', () => {
    const { adapter, calls } = fixture();
    calls.begin
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    adapter.pointerDown(7, 1);
    adapter.change(1.25);
    expect(adapter.isActive()).toBe(true);

    adapter.pointerUp(7);
    adapter.lostPointerCapture(7);

    expect(calls.begin).toHaveBeenNthCalledWith(1, 1);
    expect(calls.begin).toHaveBeenNthCalledWith(2, 1.25);
    expect(calls.end).toHaveBeenCalledOnce();
    expect(adapter.isActive()).toBe(false);
  });

  it('keeps keyboard identity when a change retries a rejected begin', () => {
    const { adapter, calls } = fixture();
    calls.begin
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    adapter.keyDown('ArrowUp', 0.5);
    adapter.change(0.51);
    adapter.keyUp('ArrowUp');

    expect(calls.end).toHaveBeenCalledOnce();
    expect(adapter.isActive()).toBe(false);

    adapter.blur();
    expect(calls.end).toHaveBeenCalledOnce();
  });

  it('ignores unrelated pointer ids and non-adjustment keyboard keys', () => {
    const { adapter, calls } = fixture();
    adapter.keyDown('Tab', 1);
    adapter.pointerDown(12, 1);
    adapter.pointerUp(13);
    expect(adapter.isActive()).toBe(true);
    expect(calls.end).not.toHaveBeenCalled();

    adapter.pointerUp(12);
    expect(calls.end).toHaveBeenCalledOnce();
  });

  it('keeps stopped/Read changes scalar and captures playing write changes', () => {
    const { adapter, calls, setCapturing } = fixture(false);
    adapter.pointerDown(7, 0.5);
    adapter.change(0.75);
    adapter.pointerUp(7);
    expect(calls.scalar).toHaveBeenCalledWith(0.75);
    expect(calls.begin).not.toHaveBeenCalled();
    expect(calls.end).not.toHaveBeenCalled();

    setCapturing(true);
    adapter.change(1.1);
    adapter.change(1.2);
    adapter.blur();

    expect(calls.begin).toHaveBeenCalledWith(1.1);
    expect(calls.update).toHaveBeenCalledWith(1.2);
    expect(calls.end).toHaveBeenCalledOnce();
    expect(calls.scalar).toHaveBeenCalledOnce();
  });

  it('does not arm an end when runtime capture rejects begin', () => {
    const calls = {
      scalar: vi.fn(),
      begin: vi.fn(() => false),
      update: vi.fn(() => false),
      end: vi.fn(() => false),
    };
    const adapter = createAutomationGestureAdapter({
      shouldCapture: () => true,
      setScalar: calls.scalar,
      beginCapture: calls.begin,
      updateCapture: calls.update,
      endCapture: calls.end,
    });

    adapter.pointerDown(1, 1);
    adapter.pointerUp(1);
    adapter.blur();

    expect(calls.begin).toHaveBeenCalledOnce();
    expect(calls.end).not.toHaveBeenCalled();
  });
});
