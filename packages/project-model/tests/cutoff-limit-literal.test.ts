import { describe, expect, it } from 'vitest';
import { MAX_FILTER_CUTOFF_OCTAVES } from '../src/automation-targets';

describe('MAX_FILTER_CUTOFF_OCTAVES', () => {
  it('is the correctly rounded log2(10), not a platform-dependent runtime value', () => {
    expect(MAX_FILTER_CUTOFF_OCTAVES).toBe(Number('3.32192809488736234787031942948939017586'));
  });
});
