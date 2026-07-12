import { describe, expect, it } from 'vitest';
import { MemoryProjectRepository } from '@cts/project-persistence';
import type { AppEvent } from '@cts/tutorial-engine';
import { subscribeAppEvents } from '../src/state/appEvents';
import { createStudioStore } from '../src/state/store';

describe('scale snap state events', () => {
  it('publishes committed enabled states without changing project history itself', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const observed: Array<{ event: AppEvent; enabled: boolean }> = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type === 'scale_snap.enabled') {
        observed.push({ event, enabled: store.getState().editor.scaleSnap });
      }
    });

    try {
      const initial = store.getState();
      expect(initial.editor.scaleSnap).toBe(false);

      store.getState().toggleScaleSnap();
      expect(observed).toEqual([
        {
          event: { type: 'scale_snap.enabled', payload: { key: 'C', scale: 'major' } },
          enabled: true,
        },
      ]);
      expect(store.getState().project).toBe(initial.project);
      expect(store.getState().past).toBe(initial.past);
      expect(store.getState().saveState).toEqual(initial.saveState);

      store.getState().toggleScaleSnap();
      store.getState().setKey('G');
      expect(observed).toHaveLength(1);

      store.getState().toggleScaleSnap();
      store.getState().setScale('naturalMinor');
      expect(observed.map(({ event }) => event)).toEqual([
        { type: 'scale_snap.enabled', payload: { key: 'C', scale: 'major' } },
        { type: 'scale_snap.enabled', payload: { key: 'G', scale: 'major' } },
        { type: 'scale_snap.enabled', payload: { key: 'G', scale: 'naturalMinor' } },
      ]);

      const revision = store.getState().saveState.revision;
      store.getState().setKey('G');
      store.getState().setScale('naturalMinor');
      expect(observed).toHaveLength(3);
      expect(store.getState().saveState.revision).toBe(revision);
    } finally {
      unsubscribe();
    }
  });
});
