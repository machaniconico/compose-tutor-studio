import { describe, expect, it, vi } from 'vitest';
import {
  registerAutomationGestureLifecycle,
  registerPersistenceLifecycle,
  registerRuntimeCaptureLifecycle,
  type AutomationGestureLifecycleActions,
  type PersistenceLifecycleActions,
} from '../src/state/persistenceLifecycle';

class VisibilityTarget extends EventTarget {
  visibilityState = 'visible';
}

function actions(
  overrides: Partial<PersistenceLifecycleActions> = {},
): PersistenceLifecycleActions {
  return {
    flushAsync: vi.fn(),
    flushSynchronously: vi.fn(() => true),
    hasUnsavedChanges: vi.fn(() => false),
    ...overrides,
  };
}

describe('registerPersistenceLifecycle', () => {
  it('uses only the synchronous capability for pagehide', () => {
    const page = new EventTarget();
    const visibilityDoc = new VisibilityTarget();
    const lifecycle = actions();

    const cleanup = registerPersistenceLifecycle(lifecycle, page, visibilityDoc);
    page.dispatchEvent(new Event('pagehide'));

    expect(lifecycle.flushSynchronously).toHaveBeenCalledTimes(1);
    expect(lifecycle.flushAsync).not.toHaveBeenCalled();
    cleanup();
  });

  it('starts an async flush on visibilitychange only when hidden', () => {
    const page = new EventTarget();
    const visibilityDoc = new VisibilityTarget();
    const lifecycle = actions();

    const cleanup = registerPersistenceLifecycle(lifecycle, page, visibilityDoc);
    visibilityDoc.dispatchEvent(new Event('visibilitychange'));
    expect(lifecycle.flushAsync).not.toHaveBeenCalled();

    visibilityDoc.visibilityState = 'hidden';
    visibilityDoc.dispatchEvent(new Event('visibilitychange'));
    expect(lifecycle.flushAsync).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('routes async background flush and a later exact synchronous pagehide flush', () => {
    const page = new EventTarget();
    const visibilityDoc = new VisibilityTarget();
    let pending = true;
    let writes = 0;
    const flush = () => {
      if (!pending) return true;
      writes += 1;
      pending = false;
      return true;
    };
    const lifecycle = actions({ flushAsync: vi.fn(flush), flushSynchronously: vi.fn(flush) });
    const cleanup = registerPersistenceLifecycle(lifecycle, page, visibilityDoc);

    visibilityDoc.visibilityState = 'hidden';
    visibilityDoc.dispatchEvent(new Event('visibilitychange'));
    expect(writes).toBe(1);

    pending = true;
    page.dispatchEvent(new Event('pagehide'));
    expect(lifecycle.flushAsync).toHaveBeenCalledTimes(1);
    expect(lifecycle.flushSynchronously).toHaveBeenCalledTimes(1);
    expect(writes).toBe(2);
    cleanup();
  });

  it('prevents unload only when a synchronous flush leaves unsaved work', () => {
    const page = new EventTarget();
    const lifecycle = actions({
      flushSynchronously: vi.fn(() => false),
      hasUnsavedChanges: vi.fn(() => true),
    });
    const cleanup = registerPersistenceLifecycle(lifecycle, page, new VisibilityTarget());
    const event = new Event('beforeunload', { cancelable: true });

    page.dispatchEvent(event);

    expect(lifecycle.flushSynchronously).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    cleanup();
  });

  it('allows unload after the synchronous flush makes the project clean', () => {
    const page = new EventTarget();
    const lifecycle = actions({ hasUnsavedChanges: vi.fn(() => false) });
    const cleanup = registerPersistenceLifecycle(lifecycle, page, new VisibilityTarget());
    const event = new Event('beforeunload', { cancelable: true });

    page.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    cleanup();
  });

  it('stops routing all lifecycle events after cleanup', () => {
    const page = new EventTarget();
    const visibilityDoc = new VisibilityTarget();
    const lifecycle = actions();
    const cleanup = registerPersistenceLifecycle(lifecycle, page, visibilityDoc);

    cleanup();
    page.dispatchEvent(new Event('pagehide'));
    page.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    visibilityDoc.visibilityState = 'hidden';
    visibilityDoc.dispatchEvent(new Event('visibilitychange'));

    expect(lifecycle.flushAsync).not.toHaveBeenCalled();
    expect(lifecycle.flushSynchronously).not.toHaveBeenCalled();
  });

  it('is safe to register and clean up without browser globals', () => {
    const lifecycle = actions();
    const cleanup = registerPersistenceLifecycle(lifecycle);

    expect(cleanup).toBeTypeOf('function');
    expect(() => cleanup()).not.toThrow();
    expect(lifecycle.flushAsync).not.toHaveBeenCalled();
    expect(lifecycle.flushSynchronously).not.toHaveBeenCalled();
  });
});

describe('registerRuntimeCaptureLifecycle', () => {
  it('finalizes before the persistence pagehide listener observes the Project', () => {
    const page = new EventTarget();
    const order: string[] = [];
    const cleanupCapture = registerRuntimeCaptureLifecycle({
      finalize: vi.fn(() => {
        order.push('finalize');
        return true;
      }),
      cancel: vi.fn(() => {
        order.push('cancel');
        return true;
      }),
    }, page);
    const cleanupPersistence = registerPersistenceLifecycle(actions({
      flushSynchronously: vi.fn(() => {
        order.push('flush');
        return true;
      }),
    }), page, new VisibilityTarget());

    page.dispatchEvent(new Event('pagehide'));

    expect(order).toEqual(['finalize', 'flush']);
    cleanupPersistence();
    cleanupCapture();
  });

  it('uses a deterministic Project-no-op cancel when pagehide finalization fails', () => {
    const page = new EventTarget();
    const finalize = vi.fn(() => false);
    const cancel = vi.fn(() => true);
    const cleanup = registerRuntimeCaptureLifecycle({ finalize, cancel }, page);

    page.dispatchEvent(new Event('pagehide'));

    expect(finalize).toHaveBeenCalledWith('pagehide');
    expect(cancel).toHaveBeenCalledOnce();
    cleanup();
  });
});

describe('registerAutomationGestureLifecycle', () => {
  it.each(['pointerup', 'pointercancel', 'keyup', 'change', 'blur'])(
    'ends active automation gestures on %s',
    (eventName) => {
      const page = new EventTarget();
      const lifecycle: AutomationGestureLifecycleActions = {
        endActiveGestures: vi.fn(() => true),
      };
      const cleanup = registerAutomationGestureLifecycle(lifecycle, page);

      page.dispatchEvent(new Event(eventName));

      expect(lifecycle.endActiveGestures).toHaveBeenCalledOnce();
      cleanup();
    },
  );

  it('ignores release events after cleanup', () => {
    const page = new EventTarget();
    const lifecycle: AutomationGestureLifecycleActions = {
      endActiveGestures: vi.fn(() => true),
    };
    const cleanup = registerAutomationGestureLifecycle(lifecycle, page);

    cleanup();
    page.dispatchEvent(new Event('pointerup'));

    expect(lifecycle.endActiveGestures).not.toHaveBeenCalled();
  });
});
