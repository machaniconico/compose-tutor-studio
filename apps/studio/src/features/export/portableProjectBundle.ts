import {
  PortableProjectBundleError,
  type PortableProjectBundleCodecDependencies,
  decodePortableProjectBundle,
  encodePortableProjectBundle,
  portableProjectBundleByteLength,
} from '@cts/project-bundle';
import type { Project } from '@cts/project-model';
import {
  type AudioAssetRepository,
} from '../../platform/audioAssetRepository';
import type { HeavyAudioResourceReservation } from '../../audio/audioResourceReservation';
import {
  CanonicalPcm16Error,
  inspectCanonicalPcm16Metadata,
} from '../../audio/canonicalPcm16';
import { studioRuntime } from '../../platform/runtime';
import { cloneProjectForImport } from './projectImport';
import {
  PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES,
  planPortableProjectBundleResources,
} from './portableProjectBundleReservation';
import {
  normalizePortableProjectBundleError,
} from './portableProjectBundleErrors';

type PortableProjectBundleLeaseDependencies = Readonly<{
  reservation: HeavyAudioResourceReservation;
  codec?: PortableProjectBundleCodecDependencies;
}>;

export type PortableProjectBundleImportDependencies = PortableProjectBundleLeaseDependencies & Readonly<{
  repository?: AudioAssetRepository;
  replaceProject: (project: Project) => Promise<boolean>;
  createProjectId: () => string;
}>;

function validatePortableAudioPayloads(
  project: Project,
  payloads: readonly Readonly<{
    checksumSha256: string;
    bytes: Uint8Array;
  }>[],
): void {
  const readyByChecksum = new Map(
    project.audioAssets
      .filter((asset) => asset.availability === 'ready')
      .map((asset) => [asset.checksumSha256, asset] as const),
  );
  for (const payload of payloads) {
    const asset = readyByChecksum.get(payload.checksumSha256);
    if (!asset || asset.mediaType !== 'audio/wav') {
      throw new PortableProjectBundleError('invalid-project');
    }
    try {
      inspectCanonicalPcm16Metadata(payload.bytes, {
        sampleRate: asset.sampleRate,
        channelCount: asset.channelCount,
        frameCount: asset.frameCount,
      });
    } catch (error) {
      if (error instanceof CanonicalPcm16Error) {
        throw new PortableProjectBundleError(
          error.code === 'metadata-mismatch'
            ? 'asset-metadata-conflict'
            : 'invalid-project',
        );
      }
      throw error;
    }
  }
}

function validatePortableAudioAssetMetadata(project: Project): void {
  if (
    project.audioAssets.some(
      (asset) => asset.availability === 'ready' && asset.mediaType !== 'audio/wav',
    )
  ) {
    throw new PortableProjectBundleError('invalid-project');
  }
}

function assertPortableProjectBundleReservation(
  reservation: HeavyAudioResourceReservation,
): void {
  if (
    reservation.released
    || reservation.bytes !== PORTABLE_PROJECT_BUNDLE_RESERVATION_BYTES
  ) {
    throw new PortableProjectBundleError('reservation-failed');
  }
}

function largestReadyAssetBytes(project: Project): number {
  let largest = 0;
  for (const asset of project.audioAssets) {
    if (asset.availability === 'ready') {
      largest = Math.max(largest, asset.byteLength);
    }
  }
  return largest;
}

export async function exportPortableProjectBundle(
  project: Project,
  repository: AudioAssetRepository = studioRuntime.audioAssets,
  dependencies: PortableProjectBundleLeaseDependencies,
): Promise<Uint8Array<ArrayBuffer>> {
  assertPortableProjectBundleReservation(dependencies.reservation);
  try {
    validatePortableAudioAssetMetadata(project);
    // Projection is intentionally inside the lease: TextEncoder and codec
    // allocations are part of the explicit operation envelope.
    const bundleBytes = portableProjectBundleByteLength(project);
    planPortableProjectBundleResources(
      'export',
      bundleBytes,
      largestReadyAssetBytes(project),
    );
    return await encodePortableProjectBundle(project, {
      read: async (reference) => {
        try {
          const bytes = await repository.read(reference);
          validatePortableAudioPayloads(project, [{
            checksumSha256: reference.checksumSha256,
            bytes,
          }]);
          return bytes;
        } catch (error) {
          const normalized = normalizePortableProjectBundleError(error);
          throw normalized.code === 'file-read-failed'
            ? new PortableProjectBundleError('asset-read-failed')
            : normalized;
        }
      },
    }, dependencies.codec);
  } catch (error) {
    throw normalizePortableProjectBundleError(error, 'export');
  }
}

/**
 * Validate the complete immutable envelope first, then store every distinct
 * payload, verify every receipt, and only then request one transactional switch.
 * The content-addressed repository has no delete operation: a later store or
 * adoption failure may leave an immutable unreferenced object. Project adoption
 * remains atomic; this function does not claim to roll repository writes back.
 */
export async function importPortableProjectBundle(
  bytes: Uint8Array,
  dependencies: PortableProjectBundleImportDependencies,
): Promise<boolean> {
  assertPortableProjectBundleReservation(dependencies.reservation);
  try {
    const decoded = await decodePortableProjectBundle(bytes, dependencies.codec);
    validatePortableAudioPayloads(decoded.project, decoded.assets);
    planPortableProjectBundleResources(
      'import',
      bytes.byteLength,
      decoded.assets.reduce(
        (largest, payload) => Math.max(largest, payload.byteLength),
        0,
      ),
    );
    const repository = dependencies.repository ?? studioRuntime.audioAssets;
    for (const payload of decoded.assets) {
      let receipt;
      try {
        receipt = await repository.store({
          checksumSha256: payload.checksumSha256,
          byteLength: payload.byteLength,
          bytes: payload.bytes,
        });
      } catch (error) {
        const normalized = normalizePortableProjectBundleError(error);
        if (normalized.code === 'cancelled') throw normalized;
        throw new PortableProjectBundleError('repository-store-failed');
      }
      let receiptMatches = false;
      try {
        receiptMatches = receipt.checksumSha256 === payload.checksumSha256
          && receipt.byteLength === payload.byteLength;
      } catch {
        throw new PortableProjectBundleError('receipt-mismatch');
      }
      if (!receiptMatches) {
        throw new PortableProjectBundleError('receipt-mismatch');
      }
    }
    let imported: Project;
    try {
      imported = cloneProjectForImport(decoded.project, dependencies.createProjectId());
    } catch {
      throw new PortableProjectBundleError('adoption-failed');
    }
    let replaced: boolean;
    try {
      replaced = await dependencies.replaceProject(imported);
    } catch {
      throw new PortableProjectBundleError('adoption-failed');
    }
    if (!replaced) throw new PortableProjectBundleError('adoption-failed');
    return true;
  } catch (error) {
    throw normalizePortableProjectBundleError(error);
  }
}
