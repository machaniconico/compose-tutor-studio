// Testing Library's auto-cleanup needs vitest globals, which this repo does not
// use. Clean up explicitly, and only in environments that have a DOM.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});
