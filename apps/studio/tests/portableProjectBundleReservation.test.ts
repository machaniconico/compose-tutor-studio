import { describe, expect, it } from 'vitest';
import { PortableProjectBundleError } from '@cts/project-bundle';
import {
  getReservedHeavyAudioResourceBytes,
  reserveHeavyAudioResources,
} from '../src/audio/audioResourceReservation';
import {
  PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES,
  planPortableProjectBundleResources,
  reservePortableProjectBundleResources,
} from '../src/features/export/portableProjectBundleReservation';

describe('portable project bundle reservation', () => {
  const MiB = 1024 * 1024;

  it('computes the exact export encode and handoff peaks', () => {
    expect(planPortableProjectBundleResources('export', 144 * MiB, 80 * MiB)).toEqual({
      operation: 'export',
      bundleBytes: 144 * MiB,
      largestAssetBytes: 80 * MiB,
      encodePeakBytes: PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES,
      handoffPeakBytes: 288 * MiB,
      peakBytes: PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES,
    });
    expect(() => planPortableProjectBundleResources(
      'export',
      144 * MiB,
      80 * MiB + 1,
    )).toThrowError(expect.objectContaining<Partial<PortableProjectBundleError>>({
      code: 'reservation-failed',
    }));
  });

  it('computes the exact import store and handoff peaks', () => {
    expect(planPortableProjectBundleResources('import', 144 * MiB, 120 * MiB)).toEqual({
      operation: 'import',
      bundleBytes: 144 * MiB,
      largestAssetBytes: 120 * MiB,
      storePeakBytes: PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES,
      handoffPeakBytes: 288 * MiB,
      peakBytes: PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES,
    });
    expect(() => planPortableProjectBundleResources(
      'import',
      144 * MiB,
      120 * MiB + 1,
    )).toThrowError(expect.objectContaining<Partial<PortableProjectBundleError>>({
      code: 'reservation-failed',
    }));
  });

  it('enforces the exact handoff boundary independently of processing', () => {
    expect(planPortableProjectBundleResources('import', 192 * MiB, 0))
      .toMatchObject({
        handoffPeakBytes: PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES,
        peakBytes: PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES,
      });
    expect(() => planPortableProjectBundleResources('import', 192 * MiB + 1, 0))
      .toThrowError(expect.objectContaining<Partial<PortableProjectBundleError>>({
        code: 'reservation-failed',
      }));
  });

  it('rejects unsafe arithmetic instead of rounding an overflowed plan', () => {
    for (const operation of ['export', 'import'] as const) {
      expect(() => planPortableProjectBundleResources(
        operation,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      )).toThrowError(expect.objectContaining<Partial<PortableProjectBundleError>>({
        code: 'reservation-failed',
      }));
    }
  });

  it('holds the exclusive 384 MiB envelope and releases it idempotently', () => {
    const baseline = getReservedHeavyAudioResourceBytes();
    const lease = reservePortableProjectBundleResources(
      'export',
      128 * MiB,
      80 * MiB,
    );
    expect(PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES).toBe(384 * 1024 * 1024);
    expect(getReservedHeavyAudioResourceBytes()).toBe(
      baseline + PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES,
    );
    lease.release();
    lease.release();
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline);
  });

  it('rejects over-cap and overflowed plans before touching the shared ledger', () => {
    const baseline = getReservedHeavyAudioResourceBytes();
    for (const [operation, bundleBytes, largestAssetBytes] of [
      ['export', 144 * MiB, 80 * MiB + 1],
      ['import', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect(() => reservePortableProjectBundleResources(
        operation,
        bundleBytes,
        largestAssetBytes,
      )).toThrowError(expect.objectContaining<Partial<PortableProjectBundleError>>({
        code: 'reservation-failed',
      }));
      expect(getReservedHeavyAudioResourceBytes()).toBe(baseline);
    }
  });

  it('rejects synchronously without changing an occupied ledger', () => {
    const baseline = getReservedHeavyAudioResourceBytes();
    const competing = reserveHeavyAudioResources(1);
    expect(() => reservePortableProjectBundleResources())
      .toThrowError(expect.objectContaining<Partial<PortableProjectBundleError>>({
        code: 'reservation-failed',
      }));
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline + 1);
    competing.release();
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline);
  });

  it('rejects invalid bundle bounds before touching the ledger', () => {
    const baseline = getReservedHeavyAudioResourceBytes();
    expect(() => reservePortableProjectBundleResources(128 * 1024 * 1024 + 1))
      .toThrowError(expect.objectContaining({ code: 'too-large' }));
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline);
  });
});
