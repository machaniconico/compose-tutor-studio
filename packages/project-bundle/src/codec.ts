import {
  DEFAULT_MAX_PROJECT_JSON_BYTES,
  MAX_AUDIO_ASSETS,
  decodeProjectJson,
  encodeProjectJson,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';

export const PORTABLE_PROJECT_BUNDLE_MAGIC = 'CTSBNDL1';
export const PORTABLE_PROJECT_BUNDLE_VERSION = 1;
export const PORTABLE_PROJECT_BUNDLE_HEADER_BYTES = 32;
export const PORTABLE_PROJECT_BUNDLE_EXTENSION = '.ctsbundle';
export const PORTABLE_PROJECT_BUNDLE_MIME_TYPE =
  'application/vnd.compose-tutor-studio.project-bundle';
export const MAX_PORTABLE_PROJECT_BUNDLE_BYTES = 128 * 1024 * 1024;
export const MAX_PORTABLE_PROJECT_BUNDLE_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES = 512 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type PortableProjectBundleAssetReference = Readonly<{
  checksumSha256: string;
  byteLength: number;
}>;

export type PortableProjectBundleAssetReader = Readonly<{
  read: (reference: PortableProjectBundleAssetReference) => Promise<Uint8Array>;
}>;

export type PortableProjectBundlePayload = PortableProjectBundleAssetReference & Readonly<{
  /** A borrowed view into the input bundle. It becomes invalid if the caller mutates that input. */
  bytes: Uint8Array;
}>;

export type DecodedPortableProjectBundle = Readonly<{
  project: Project;
  assets: readonly PortableProjectBundlePayload[];
  payloads: readonly PortableProjectBundlePayload[];
}>;

type Manifest = Readonly<{
  format: 'ctsbundle';
  version: 1;
  project: Readonly<{
    byteLength: number;
    checksumSha256: string;
  }>;
  assets: readonly PortableProjectBundleAssetReference[];
}>;

export const PORTABLE_PROJECT_BUNDLE_ERROR_CODES = [
  'too-large',
  'invalid-header',
  'unsupported-version',
  'invalid-manifest',
  'invalid-project',
  'non-canonical',
  'checksum-mismatch',
  'length-mismatch',
  'asset-metadata-conflict',
  'unresolved-asset',
  'too-many-assets',
  'asset-read-failed',
  'repository-missing',
  'repository-changed',
  'repository-unavailable',
  'repository-store-failed',
  'receipt-mismatch',
  'adoption-failed',
  'reservation-failed',
  'file-read-failed',
  'handoff-failed',
  'crypto-unavailable',
  'cancelled',
] as const;

export type PortableProjectBundleErrorCode =
  (typeof PORTABLE_PROJECT_BUNDLE_ERROR_CODES)[number];

export class PortableProjectBundleError extends Error {
  constructor(readonly code: PortableProjectBundleErrorCode, message: string = code) {
    super(message);
    this.name = 'PortableProjectBundleError';
  }
}

export function checkedPortableProjectBundleTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
      throw new PortableProjectBundleError('too-large');
    }
    total += value;
  }
  if (total > MAX_PORTABLE_PROJECT_BUNDLE_BYTES || total > 0xffff_ffff) {
    throw new PortableProjectBundleError('too-large');
  }
  return total;
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

export type PortableProjectBundleCodecDependencies = Readonly<{
  allocate?: (byteLength: number) => Uint8Array<ArrayBuffer>;
  hash?: (bytes: Uint8Array) => Promise<string>;
  parseJson?: (text: string) => unknown;
}>;

async function sha256(bytes: Uint8Array): Promise<string> {
  let subtle: SubtleCrypto | undefined;
  try {
    subtle = globalThis.crypto?.subtle;
  } catch {
    throw new PortableProjectBundleError('crypto-unavailable');
  }
  if (!subtle) throw new PortableProjectBundleError('crypto-unavailable');
  try {
    if (!(bytes.buffer instanceof ArrayBuffer)) {
      throw new PortableProjectBundleError('crypto-unavailable');
    }
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return toHex(new Uint8Array(await subtle.digest('SHA-256', view)));
  } catch {
    throw new PortableProjectBundleError('crypto-unavailable');
  }
}

function metadataKey(asset: ReadyAudioAsset): string {
  return JSON.stringify([
    asset.byteLength,
    asset.mediaType,
    asset.sampleRate,
    asset.channelCount,
    asset.frameCount,
  ]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function canonicalProject(project: Project): Project {
  return {
    ...project,
    audioAssets: [...project.audioAssets].sort((left, right) => {
      const leftChecksum = left.availability === 'ready' ? left.checksumSha256 : '';
      const rightChecksum = right.availability === 'ready' ? right.checksumSha256 : '';
      return compareStrings(leftChecksum, rightChecksum)
        || compareStrings(left.availability, right.availability)
        || compareStrings(left.id, right.id);
    }),
  };
}

function assertPortableAudioAssetCount(project: Project): void {
  if (project.audioAssets.length > MAX_AUDIO_ASSETS) {
    throw new PortableProjectBundleError('too-many-assets');
  }
}

function assertPortableProjectJsonSize(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength)
    || byteLength <= 0
    || byteLength > DEFAULT_MAX_PROJECT_JSON_BYTES
  ) {
    throw new PortableProjectBundleError(
      byteLength > DEFAULT_MAX_PROJECT_JSON_BYTES ? 'too-large' : 'invalid-project',
    );
  }
}

function serializePortableProject(project: Project): string {
  const encoded = encodeProjectJson(project);
  if (!encoded.ok) {
    throw new PortableProjectBundleError(
      encoded.error.code === 'too-large' ? 'too-large' : 'invalid-project',
    );
  }
  return encoded.json;
}

function distinctReadyAssets(project: Project): PortableProjectBundleAssetReference[] {
  assertPortableAudioAssetCount(project);
  const metadataByChecksum = new Map<string, string>();
  const references = new Map<string, PortableProjectBundleAssetReference>();
  for (const asset of project.audioAssets) {
    if (asset.availability !== 'ready') {
      throw new PortableProjectBundleError('unresolved-asset');
    }
    if (!SHA256_PATTERN.test(asset.checksumSha256)) {
      throw new PortableProjectBundleError('invalid-project');
    }
    if (
      !Number.isSafeInteger(asset.byteLength)
      || asset.byteLength <= 0
      || asset.byteLength > MAX_PORTABLE_PROJECT_BUNDLE_ASSET_BYTES
    ) {
      throw new PortableProjectBundleError(
        asset.byteLength > MAX_PORTABLE_PROJECT_BUNDLE_ASSET_BYTES
          ? 'too-large'
          : 'invalid-project',
      );
    }
    const metadata = metadataKey(asset);
    const previous = metadataByChecksum.get(asset.checksumSha256);
    if (previous !== undefined && previous !== metadata) {
      throw new PortableProjectBundleError('asset-metadata-conflict');
    }
    metadataByChecksum.set(asset.checksumSha256, metadata);
    references.set(asset.checksumSha256, {
      checksumSha256: asset.checksumSha256,
      byteLength: asset.byteLength,
    });
  }
  return [...references.values()].sort((left, right) =>
    compareStrings(left.checksumSha256, right.checksumSha256));
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function parseManifest(
  text: string,
  parseJson: (text: string) => unknown = JSON.parse,
): Manifest {
  let value: unknown;
  try {
    value = parseJson(text);
  } catch {
    throw new PortableProjectBundleError('invalid-manifest');
  }
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || !exactKeys(value, ['format', 'version', 'project', 'assets'])
  ) {
    throw new PortableProjectBundleError('invalid-manifest');
  }
  const record = value as Record<string, unknown>;
  const project = record.project;
  const assets = record.assets;
  if (
    record.format !== 'ctsbundle'
    || record.version !== 1
    || typeof project !== 'object'
    || project === null
    || Array.isArray(project)
    || !exactKeys(project, ['byteLength', 'checksumSha256'])
    || !Array.isArray(assets)
  ) {
    throw new PortableProjectBundleError('invalid-manifest');
  }
  const projectRecord = project as Record<string, unknown>;
  if (assets.length > MAX_AUDIO_ASSETS) {
    throw new PortableProjectBundleError('too-many-assets');
  }
  if (
    !Number.isSafeInteger(projectRecord.byteLength)
    || (projectRecord.byteLength as number) <= 0
    || typeof projectRecord.checksumSha256 !== 'string'
    || !SHA256_PATTERN.test(projectRecord.checksumSha256)
  ) {
    throw new PortableProjectBundleError('invalid-manifest');
  }
  assertPortableProjectJsonSize(projectRecord.byteLength as number);
  let previousChecksum = '';
  const lengths = new Map<string, number>();
  for (const asset of assets) {
    if (
      typeof asset !== 'object'
      || asset === null
      || Array.isArray(asset)
      || !exactKeys(asset, ['checksumSha256', 'byteLength'])
    ) {
      throw new PortableProjectBundleError('invalid-manifest');
    }
    const item = asset as Record<string, unknown>;
    if (typeof item.checksumSha256 !== 'string'
      || !SHA256_PATTERN.test(item.checksumSha256)
      || !Number.isSafeInteger(item.byteLength)
      || (item.byteLength as number) <= 0) {
      throw new PortableProjectBundleError('invalid-manifest');
    }
    const checksum = item.checksumSha256;
    const byteLength = item.byteLength as number;
    if (byteLength > MAX_PORTABLE_PROJECT_BUNDLE_ASSET_BYTES) {
      throw new PortableProjectBundleError('too-large');
    }
    const duplicateLength = lengths.get(checksum);
    if (duplicateLength !== undefined) {
      throw new PortableProjectBundleError(
        duplicateLength === byteLength ? 'non-canonical' : 'asset-metadata-conflict',
      );
    }
    if (checksum <= previousChecksum) {
      throw new PortableProjectBundleError('non-canonical');
    }
    lengths.set(checksum, byteLength);
    previousChecksum = checksum;
  }
  const canonical: Manifest = {
    format: 'ctsbundle',
    version: 1,
    project: {
      byteLength: projectRecord.byteLength as number,
      checksumSha256: projectRecord.checksumSha256 as string,
    },
    assets: assets.map((asset) => {
      const item = asset as Record<string, unknown>;
      return {
        checksumSha256: item.checksumSha256 as string,
        byteLength: item.byteLength as number,
      };
    }),
  };
  if (JSON.stringify(canonical) !== text) {
    throw new PortableProjectBundleError('non-canonical');
  }
  return canonical;
}

/** Exact encoded length projection; performs no repository reads or allocation of that size. */
export function portableProjectBundleByteLength(project: Project): number {
  assertPortableAudioAssetCount(project);
  const normalizedProject = canonicalProject(project);
  const projectBytes = encoder.encode(serializePortableProject(normalizedProject));
  assertPortableProjectJsonSize(projectBytes.byteLength);
  const assets = distinctReadyAssets(normalizedProject);
  const manifestBytes = encoder.encode(JSON.stringify({
    format: 'ctsbundle',
    version: 1,
    project: {
      byteLength: projectBytes.byteLength,
      checksumSha256: '0'.repeat(64),
    },
    assets,
  } satisfies Manifest));
  if (manifestBytes.byteLength > MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES) {
    throw new PortableProjectBundleError('too-large');
  }
  return checkedPortableProjectBundleTotal([
    PORTABLE_PROJECT_BUNDLE_HEADER_BYTES,
    manifestBytes.byteLength,
    projectBytes.byteLength,
    ...assets.map((asset) => asset.byteLength),
  ]);
}

/**
 * Encode a deterministic v1 bundle. The size projection is completed before
 * the first repository read or output-buffer allocation.
 */
export async function encodePortableProjectBundle(
  project: Project,
  repository: PortableProjectBundleAssetReader,
  dependencies: PortableProjectBundleCodecDependencies = {},
): Promise<Uint8Array<ArrayBuffer>> {
  assertPortableAudioAssetCount(project);
  const normalizedProject = canonicalProject(project);
  const projectBytes = encoder.encode(serializePortableProject(normalizedProject));
  assertPortableProjectJsonSize(projectBytes.byteLength);
  const hash = dependencies.hash ?? sha256;
  const projectChecksum = await hash(projectBytes);
  if (!SHA256_PATTERN.test(projectChecksum)) {
    throw new PortableProjectBundleError('crypto-unavailable');
  }
  const assets = distinctReadyAssets(normalizedProject);
  const manifest: Manifest = {
    format: 'ctsbundle',
    version: 1,
    project: {
      byteLength: projectBytes.byteLength,
      checksumSha256: projectChecksum,
    },
    assets,
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES) {
    throw new PortableProjectBundleError('too-large');
  }
  const totalLength = portableProjectBundleByteLength(normalizedProject);

  const output = (dependencies.allocate
    ?? ((byteLength: number) => new Uint8Array(new ArrayBuffer(byteLength))))(totalLength);
  if (output.byteLength !== totalLength) {
    throw new PortableProjectBundleError('length-mismatch');
  }
  output.set(encoder.encode(PORTABLE_PROJECT_BUNDLE_MAGIC), 0);
  const header = new DataView(output.buffer, output.byteOffset, output.byteLength);
  header.setUint16(8, PORTABLE_PROJECT_BUNDLE_VERSION, true);
  header.setUint16(10, 0, true);
  header.setUint32(12, manifestBytes.byteLength, true);
  header.setUint32(16, projectBytes.byteLength, true);
  header.setUint32(20, assets.length, true);
  header.setUint32(24, totalLength, true);
  header.setUint32(28, 0, true);
  let offset = PORTABLE_PROJECT_BUNDLE_HEADER_BYTES;
  output.set(manifestBytes, offset);
  offset += manifestBytes.byteLength;
  output.set(projectBytes, offset);
  offset += projectBytes.byteLength;

  // Repository payloads are intentionally read, authenticated, copied into the
  // final envelope, and released one at a time. Retaining every asset beside
  // the full output would make the 384 MiB renderer reservation unverifiable.
  for (const asset of assets) {
    let bytes: Uint8Array;
    try {
      bytes = await repository.read(asset);
    } catch (error) {
      if (error instanceof PortableProjectBundleError) throw error;
      throw new PortableProjectBundleError('asset-read-failed');
    }
    if (bytes.byteLength !== asset.byteLength) {
      throw new PortableProjectBundleError('length-mismatch');
    }
    if ((await hash(bytes)) !== asset.checksumSha256) {
      throw new PortableProjectBundleError('checksum-mismatch');
    }
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (offset !== output.byteLength) {
    throw new PortableProjectBundleError('length-mismatch');
  }
  return output;
}

/** Decode and cryptographically validate every byte before returning borrowed payload views. */
export async function decodePortableProjectBundle(
  input: Uint8Array,
  dependencies: PortableProjectBundleCodecDependencies = {},
): Promise<DecodedPortableProjectBundle> {
  if (input.byteLength > MAX_PORTABLE_PROJECT_BUNDLE_BYTES) {
    throw new PortableProjectBundleError('too-large');
  }
  if (input.byteLength < PORTABLE_PROJECT_BUNDLE_HEADER_BYTES) {
    throw new PortableProjectBundleError('invalid-header');
  }
  let magic: string;
  try {
    magic = decoder.decode(input.subarray(0, 8));
  } catch {
    throw new PortableProjectBundleError('invalid-header');
  }
  const header = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (magic !== PORTABLE_PROJECT_BUNDLE_MAGIC) {
    throw new PortableProjectBundleError('invalid-header');
  }
  if (header.getUint16(8, true) !== PORTABLE_PROJECT_BUNDLE_VERSION) {
    throw new PortableProjectBundleError('unsupported-version');
  }
  if (
    header.getUint16(10, true) !== 0
    || header.getUint32(28, true) !== 0
    || header.getUint32(24, true) !== input.byteLength
  ) {
    throw new PortableProjectBundleError('invalid-header');
  }
  const manifestLength = header.getUint32(12, true);
  const projectLength = header.getUint32(16, true);
  const assetCount = header.getUint32(20, true);
  if (manifestLength > MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES) {
    throw new PortableProjectBundleError('too-large');
  }
  assertPortableProjectJsonSize(projectLength);
  if (assetCount > MAX_AUDIO_ASSETS) {
    throw new PortableProjectBundleError('too-many-assets');
  }
  const metadataEnd = checkedPortableProjectBundleTotal([
    PORTABLE_PROJECT_BUNDLE_HEADER_BYTES,
    manifestLength,
    projectLength,
  ]);
  if (metadataEnd > input.byteLength) {
    throw new PortableProjectBundleError('length-mismatch');
  }
  let manifestText: string;
  let projectText: string;
  const manifestStart = PORTABLE_PROJECT_BUNDLE_HEADER_BYTES;
  const projectStart = manifestStart + manifestLength;
  const manifestBytes = input.subarray(manifestStart, projectStart);
  const projectBytes = input.subarray(projectStart, metadataEnd);
  if (
    (manifestBytes[0] === 0xef && manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf)
    || (projectBytes[0] === 0xef && projectBytes[1] === 0xbb && projectBytes[2] === 0xbf)
  ) {
    throw new PortableProjectBundleError('non-canonical');
  }
  try {
    manifestText = decoder.decode(manifestBytes);
  } catch {
    throw new PortableProjectBundleError('invalid-manifest');
  }
  try {
    projectText = decoder.decode(projectBytes);
  } catch {
    throw new PortableProjectBundleError('invalid-project');
  }
  if (
    !bytesEqual(encoder.encode(manifestText), manifestBytes)
    || !bytesEqual(encoder.encode(projectText), projectBytes)
  ) {
    throw new PortableProjectBundleError('non-canonical');
  }
  const manifest = parseManifest(manifestText, dependencies.parseJson);
  if (
    manifest.assets.length !== assetCount
    || manifest.project.byteLength !== projectLength
  ) {
    throw new PortableProjectBundleError('length-mismatch');
  }
  const hash = dependencies.hash ?? sha256;
  if ((await hash(projectBytes)) !== manifest.project.checksumSha256) {
    throw new PortableProjectBundleError('checksum-mismatch');
  }
  const decodedProject = decodeProjectJson(projectText, {
    maxBytes: DEFAULT_MAX_PROJECT_JSON_BYTES,
  });
  if (!decodedProject.ok) {
    throw new PortableProjectBundleError(
      decodedProject.error.code === 'too-large'
        ? 'too-large'
        : decodedProject.error.code === 'future-schema-version'
          ? 'unsupported-version'
          : 'invalid-project',
    );
  }
  const normalizedProject = canonicalProject(decodedProject.project);
  if (serializePortableProject(normalizedProject) !== projectText) {
    throw new PortableProjectBundleError('non-canonical');
  }
  const expectedAssets = distinctReadyAssets(normalizedProject);
  if (JSON.stringify(expectedAssets) !== JSON.stringify(manifest.assets)) {
    throw new PortableProjectBundleError('invalid-manifest');
  }

  const payloads: PortableProjectBundlePayload[] = [];
  let offset = metadataEnd;
  for (const asset of manifest.assets) {
    const end = checkedPortableProjectBundleTotal([offset, asset.byteLength]);
    if (end > input.byteLength) throw new PortableProjectBundleError('length-mismatch');
    const bytes = input.subarray(offset, end);
    if ((await hash(bytes)) !== asset.checksumSha256) {
      throw new PortableProjectBundleError('checksum-mismatch');
    }
    payloads.push({ ...asset, bytes });
    offset = end;
  }
  if (offset !== input.byteLength) throw new PortableProjectBundleError('length-mismatch');
  return { project: normalizedProject, assets: payloads, payloads };
}

export const encodeProjectBundle = encodePortableProjectBundle;
export const decodeProjectBundle = decodePortableProjectBundle;
