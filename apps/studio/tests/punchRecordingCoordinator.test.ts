import { describe, expect, it, vi } from 'vitest';
import {
  createPunchRecordingCoordinator,
  type PunchRecordingCoordinator,
  type PunchRecordingDiscardReason,
} from '../src/audio/punchRecordingCoordinator';

function setup() {
  const onFinalize = vi.fn();
  const onDiscard = vi.fn();
  const coordinator = createPunchRecordingCoordinator({
    onFinalize,
    onDiscard,
  });
  return { coordinator, onFinalize, onDiscard };
}

describe('createPunchRecordingCoordinator', () => {
  it.each([
    ['capture then post-roll', 'capture', 'postroll'],
    ['post-roll then capture', 'postroll', 'capture'],
  ] as const)(
    'finalizes once when completion arrives %s',
    (_label, first, second) => {
      const { coordinator, onFinalize, onDiscard } = setup();
      const signal = (kind: typeof first) => (
        kind === 'capture'
          ? coordinator.signalCaptureComplete()
          : coordinator.signalPostrollComplete()
      );

      expect(signal(first)).toBe(true);
      expect(onFinalize).not.toHaveBeenCalled();
      expect(coordinator.getSnapshot()).toMatchObject({
        captureComplete: first === 'capture',
        postrollComplete: first === 'postroll',
        terminal: 'active',
        discardReason: null,
      });

      expect(signal(second)).toBe(true);
      expect(onFinalize).toHaveBeenCalledOnce();
      expect(onDiscard).not.toHaveBeenCalled();
      expect(coordinator.getSnapshot()).toEqual({
        captureComplete: true,
        postrollComplete: true,
        terminal: 'finalized',
        discardReason: null,
      });
    },
  );

  it('ignores duplicate, replayed, and late signals after exactly one finalize', () => {
    const { coordinator, onFinalize, onDiscard } = setup();

    expect(coordinator.signalCaptureComplete()).toBe(true);
    expect(coordinator.signalCaptureComplete()).toBe(false);
    expect(coordinator.signalPostrollComplete()).toBe(true);
    expect(coordinator.signalPostrollComplete()).toBe(false);
    expect(coordinator.signalCaptureComplete()).toBe(false);
    expect(coordinator.cancel()).toBe(false);
    expect(coordinator.interrupt()).toBe(false);

    expect(onFinalize).toHaveBeenCalledOnce();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it.each([
    ['cancel before either completion', [] as const, 'cancelled'],
    ['cancel after capture', ['capture'] as const, 'cancelled'],
    ['interrupt after post-roll', ['postroll'] as const, 'interrupted'],
  ] as const)(
    'discards exactly once on %s',
    (_label, completed, reason) => {
      const { coordinator, onFinalize, onDiscard } = setup();
      for (const kind of completed) {
        if (kind === 'capture') coordinator.signalCaptureComplete();
        else coordinator.signalPostrollComplete();
      }

      const discarded = reason === 'cancelled'
        ? coordinator.cancel()
        : coordinator.interrupt();
      expect(discarded).toBe(true);
      expect(coordinator.cancel()).toBe(false);
      expect(coordinator.interrupt()).toBe(false);
      expect(coordinator.signalCaptureComplete()).toBe(false);
      expect(coordinator.signalPostrollComplete()).toBe(false);
      expect(onFinalize).not.toHaveBeenCalled();
      expect(onDiscard).toHaveBeenCalledOnce();
      expect(onDiscard).toHaveBeenCalledWith(reason);
      expect(coordinator.getSnapshot()).toMatchObject({
        terminal: 'discarded',
        discardReason: reason,
      });
    },
  );

  it('commits finalized state before invoking a re-entrant finalize callback', () => {
    let coordinator: PunchRecordingCoordinator;
    const onDiscard = vi.fn();
    const onFinalize = vi.fn(() => {
      expect(coordinator.getSnapshot().terminal).toBe('finalized');
      expect(coordinator.cancel()).toBe(false);
      expect(coordinator.signalCaptureComplete()).toBe(false);
      expect(coordinator.signalPostrollComplete()).toBe(false);
    });
    coordinator = createPunchRecordingCoordinator({
      onFinalize,
      onDiscard,
    });

    coordinator.signalCaptureComplete();
    coordinator.signalPostrollComplete();

    expect(onFinalize).toHaveBeenCalledOnce();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('commits discarded state before invoking a re-entrant discard callback', () => {
    let coordinator: PunchRecordingCoordinator;
    const reasons: PunchRecordingDiscardReason[] = [];
    const onFinalize = vi.fn();
    const onDiscard = vi.fn((reason: PunchRecordingDiscardReason) => {
      reasons.push(reason);
      expect(coordinator.getSnapshot().terminal).toBe('discarded');
      expect(coordinator.cancel()).toBe(false);
      expect(coordinator.interrupt()).toBe(false);
      expect(coordinator.signalCaptureComplete()).toBe(false);
      expect(coordinator.signalPostrollComplete()).toBe(false);
    });
    coordinator = createPunchRecordingCoordinator({
      onFinalize,
      onDiscard,
    });

    coordinator.interrupt();

    expect(reasons).toEqual(['interrupted']);
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onFinalize).not.toHaveBeenCalled();
  });

  it('remains terminal when a callback throws and will not retry it', () => {
    const failure = new Error('finalize failed');
    const onFinalize = vi.fn(() => {
      throw failure;
    });
    const onDiscard = vi.fn();
    const coordinator = createPunchRecordingCoordinator({
      onFinalize,
      onDiscard,
    });

    coordinator.signalCaptureComplete();
    expect(() => coordinator.signalPostrollComplete()).toThrow(failure);
    expect(coordinator.getSnapshot().terminal).toBe('finalized');
    expect(coordinator.signalPostrollComplete()).toBe(false);
    expect(coordinator.cancel()).toBe(false);
    expect(onFinalize).toHaveBeenCalledOnce();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('returns immutable snapshots and never exposes mutable coordinator state', () => {
    const { coordinator } = setup();
    const initial = coordinator.getSnapshot();
    expect(Object.isFrozen(initial)).toBe(true);

    coordinator.signalCaptureComplete();
    const next = coordinator.getSnapshot();
    expect(next).not.toBe(initial);
    expect(Object.isFrozen(next)).toBe(true);
    expect(initial.captureComplete).toBe(false);
    expect(next.captureComplete).toBe(true);
  });
});
