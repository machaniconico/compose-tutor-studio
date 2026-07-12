import { describe, expect, it } from 'vitest';
import { isAnyDialogOpen, registerDialog } from '../src/features/common/dialogState';

describe('dialog modal stack', () => {
  it('gives Escape/focus ownership only to the latest registered dialog', () => {
    const first = registerDialog();
    const second = registerDialog();
    try {
      expect(isAnyDialogOpen()).toBe(true);
      expect(first.isTopmost()).toBe(false);
      expect(second.isTopmost()).toBe(true);

      second.unregister();
      expect(first.isTopmost()).toBe(true);
      expect(isAnyDialogOpen()).toBe(true);
    } finally {
      second.unregister();
      first.unregister();
    }
    expect(isAnyDialogOpen()).toBe(false);
  });
});
