import { describe, expect, it } from 'vitest';
import { listenForSupportMenuOpen, requestSupportMenuOpen, SUPPORT_OPEN_EVENT } from '../src/features/support/supportEvents';

describe('support menu events', () => {
  it('dispatches and listens for support menu open requests', () => {
    const target = new EventTarget();
    let opens = 0;

    const dispose = listenForSupportMenuOpen(() => {
      opens += 1;
    }, target);

    expect(requestSupportMenuOpen(target)).toBe(true);
    expect(opens).toBe(1);

    dispose();
    expect(requestSupportMenuOpen(target)).toBe(true);
    expect(opens).toBe(1);
  });

  it('uses a stable custom event name', () => {
    expect(SUPPORT_OPEN_EVENT).toBe('cts:support-open');
  });
});
