import {
  MAX_PORTABLE_PROJECT_BUNDLE_BYTES,
  PortableProjectBundleError,
} from '@cts/project-bundle';
import {
  AudioResourceReservationError,
  reserveHeavyAudioResources,
  type HeavyAudioResourceReservation,
} from '../../audio/audioResourceReservation';

/**
 * Conservative exclusive envelope for the renderer/browser/repository/IPC
 * copies that can coexist around a 128 MiB bundle. This is an accounting
 * contract, not a claim that process RSS or internal Web Crypto/Blob/Tauri
 * copies are observable.
 */
export const PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES = 384 * 1024 * 1024;

export type PortableProjectBundleOperation = 'export' | 'import';

export type PortableProjectBundleResourcePlan =
  | Readonly<{
      operation: 'export';
      bundleBytes: number;
      largestAssetBytes: number;
      encodePeakBytes: number;
      handoffPeakBytes: number;
      peakBytes: number;
    }>
  | Readonly<{
      operation: 'import';
      bundleBytes: number;
      largestAssetBytes: number;
      storePeakBytes: number;
      handoffPeakBytes: number;
      peakBytes: number;
    }>;

function reservationFailure(): never {
  throw new PortableProjectBundleError('reservation-failed');
}

function assertPlanBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) reservationFailure();
}

function checkedProduct(value: number, factor: number): number {
  assertPlanBytes(value);
  assertPlanBytes(factor);
  if (value !== 0 && factor > Math.floor(Number.MAX_SAFE_INTEGER / value)) {
    return reservationFailure();
  }
  return value * factor;
}

function checkedSum(left: number, right: number): number {
  assertPlanBytes(left);
  assertPlanBytes(right);
  if (left > Number.MAX_SAFE_INTEGER - right) return reservationFailure();
  return left + right;
}

/**
 * Pure peak-memory plan for observable bundle, repository and handoff copies.
 * Format-size validation remains separate so the arithmetic can be tested at
 * its exact 384 MiB boundary.
 */
export function planPortableProjectBundleResources(
  operation: PortableProjectBundleOperation,
  bundleBytes: number,
  largestAssetBytes: number,
): PortableProjectBundleResourcePlan {
  if (operation !== 'export' && operation !== 'import') reservationFailure();
  assertPlanBytes(bundleBytes);
  assertPlanBytes(largestAssetBytes);
  if (largestAssetBytes > bundleBytes) reservationFailure();

  const handoffPeakBytes = checkedProduct(bundleBytes, 2);
  if (operation === 'export') {
    const encodePeakBytes = checkedSum(bundleBytes, checkedProduct(largestAssetBytes, 3));
    const peakBytes = Math.max(encodePeakBytes, handoffPeakBytes);
    if (peakBytes > PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES) reservationFailure();
    return {
      operation,
      bundleBytes,
      largestAssetBytes,
      encodePeakBytes,
      handoffPeakBytes,
      peakBytes,
    };
  }

  const storePeakBytes = checkedSum(bundleBytes, checkedProduct(largestAssetBytes, 2));
  const peakBytes = Math.max(storePeakBytes, handoffPeakBytes);
  if (peakBytes > PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES) reservationFailure();
  return {
    operation,
    bundleBytes,
    largestAssetBytes,
    storePeakBytes,
    handoffPeakBytes,
    peakBytes,
  };
}

export function reservePortableProjectBundleResources(
  bundleBytes?: number,
): HeavyAudioResourceReservation;
export function reservePortableProjectBundleResources(
  operation: PortableProjectBundleOperation,
  bundleBytes: number,
  largestAssetBytes: number,
): HeavyAudioResourceReservation;
export function reservePortableProjectBundleResources(
  operationOrBundleBytes: PortableProjectBundleOperation | number = 0,
  bundleBytes?: number,
  largestAssetBytes?: number,
): HeavyAudioResourceReservation {
  const exactBundleBytes = typeof operationOrBundleBytes === 'number'
    ? operationOrBundleBytes
    : bundleBytes;
  if (typeof operationOrBundleBytes !== 'number') {
    if (bundleBytes === undefined || largestAssetBytes === undefined) reservationFailure();
    planPortableProjectBundleResources(
      operationOrBundleBytes,
      bundleBytes,
      largestAssetBytes,
    );
  }
  if (
    exactBundleBytes === undefined
    || !Number.isSafeInteger(exactBundleBytes)
    || exactBundleBytes < 0
    || exactBundleBytes > MAX_PORTABLE_PROJECT_BUNDLE_BYTES
  ) {
    throw new PortableProjectBundleError('too-large');
  }
  try {
    return reserveHeavyAudioResources(PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES);
  } catch (error) {
    if (error instanceof AudioResourceReservationError) {
      throw new PortableProjectBundleError('reservation-failed');
    }
    throw error;
  }
}
