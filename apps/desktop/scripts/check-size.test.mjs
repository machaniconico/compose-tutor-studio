import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateSize, getExecutableBudget } from './check-size.mjs';

test('accepts an executable exactly at the configured maximum', () => {
  const result = evaluateSize(1024, { baselineBytes: 900, maxBytes: 1024 });
  assert.equal(result.ok, true);
  assert.equal(result.remainingBytes, 0);
  assert.equal(result.deltaFromBaseline, 124);
});

test('rejects an executable one byte above the configured maximum', () => {
  const result = evaluateSize(1025, { maxBytes: 1024, provisional: true });
  assert.equal(result.ok, false);
  assert.equal(result.remainingBytes, -1);
  assert.equal(result.provisional, true);
});

test('fails closed for an unknown platform or architecture', () => {
  assert.throws(
    () => getExecutableBudget({ platforms: {} }, 'plan9', 'mips'),
    /No valid executable size budget for plan9-mips/,
  );
});
