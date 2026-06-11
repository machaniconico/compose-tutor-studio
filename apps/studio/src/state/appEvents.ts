// Tiny decoupled pub/sub for in-app activity events.
//
// The store and editorActions publish AppEvents here without importing the
// tutorial engine; the tutorial bridge (src/state/tutorialBridge.ts) subscribes
// and forwards them to the active TutorialEngine. Keeping this module dependency
// -free means domain code never has to know whether a lesson is running.

import type { AppEvent } from '@cts/tutorial-engine';

export type AppEventListener = (event: AppEvent) => void;

const listeners = new Set<AppEventListener>();

/** Subscribe to app events. Returns an unsubscribe function. */
export function subscribeAppEvents(listener: AppEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish an app event to every subscriber. Never throws to the caller. */
export function publishAppEvent(event: AppEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A misbehaving subscriber must not break the publishing domain code.
    }
  }
}
