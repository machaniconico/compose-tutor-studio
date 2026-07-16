import { invoke as invokeTauriCommand } from '@tauri-apps/api/core';

export const MAX_AUDIO_ASSET_BYTES = 128 * 1024 * 1024;
export const AUDIO_ASSET_DATABASE_NAME = 'compose-tutor-studio-audio-assets-v1';
export const AUDIO_ASSET_OBJECT_STORE = 'assets';

export const AUDIO_ASSET_COMMANDS = {
  store: 'audio_asset_store',
  read: 'audio_asset_read',
  verify: 'audio_asset_verify',
} as const;

export const AUDIO_ASSET_CHECKSUM_HEADER = 'x-cts-audio-checksum-sha256';
export const AUDIO_ASSET_BYTE_LENGTH_HEADER = 'x-cts-audio-byte-length';

export type AudioAssetReference = Readonly<{
  checksumSha256: string;
  byteLength: number;
}>;

export type AudioAssetStoreRequest = AudioAssetReference & Readonly<{
  bytes: Uint8Array;
}>;

export type AudioAssetStoreReceipt = AudioAssetReference & Readonly<{
  deduplicated: boolean;
}>;

export type AudioAssetRepositoryErrorCode =
  | 'invalid-request'
  | 'too-large'
  | 'checksum-mismatch'
  | 'length-mismatch'
  | 'missing'
  | 'corrupt'
  | 'storage-unavailable'
  | 'access-denied'
  | 'read-failed'
  | 'write-failed'
  | 'invalid-response';

export class AudioAssetRepositoryError extends Error {
  constructor(readonly code: AudioAssetRepositoryErrorCode) {
    super(code);
    this.name = 'AudioAssetRepositoryError';
  }
}

export type AudioAssetRepository = Readonly<{
  kind: 'memory' | 'indexeddb' | 'native';
  store: (request: AudioAssetStoreRequest) => Promise<AudioAssetStoreReceipt>;
  read: (reference: AudioAssetReference) => Promise<Uint8Array>;
  verify: (reference: AudioAssetReference) => Promise<void>;
}>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function assertReference(reference: AudioAssetReference): void {
  if (
    !SHA256_PATTERN.test(reference.checksumSha256) ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength <= 0 ||
    reference.byteLength > MAX_AUDIO_ASSET_BYTES
  ) {
    throw new AudioAssetRepositoryError(
      reference.byteLength > MAX_AUDIO_ASSET_BYTES ? 'too-large' : 'invalid-request',
    );
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function boundedBytes(value: unknown): Uint8Array {
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (Array.isArray(value)) {
    if (value.length > MAX_AUDIO_ASSET_BYTES) {
      throw new AudioAssetRepositoryError('too-large');
    }
    if (value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new AudioAssetRepositoryError('invalid-response');
    }
    bytes = Uint8Array.from(value as number[]);
  } else {
    throw new AudioAssetRepositoryError('invalid-response');
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_ASSET_BYTES) {
    throw new AudioAssetRepositoryError(bytes.byteLength > MAX_AUDIO_ASSET_BYTES ? 'too-large' : 'corrupt');
  }
  return copyBytes(bytes);
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

/** SHA-256 identity shared by the web and native asset repositories. */
export async function sha256AudioAsset(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_ASSET_BYTES) {
    throw new AudioAssetRepositoryError(bytes.byteLength > MAX_AUDIO_ASSET_BYTES ? 'too-large' : 'invalid-request');
  }
  let subtle: SubtleCrypto | undefined;
  try {
    subtle = globalThis.crypto?.subtle;
  } catch {
    throw new AudioAssetRepositoryError('storage-unavailable');
  }
  if (!subtle) throw new AudioAssetRepositoryError('storage-unavailable');
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest('SHA-256', copyBytes(bytes).buffer);
  } catch {
    throw new AudioAssetRepositoryError('storage-unavailable');
  }
  return toHex(new Uint8Array(digest));
}

async function validateBytes(
  reference: AudioAssetReference,
  bytes: Uint8Array,
): Promise<void> {
  assertReference(reference);
  if (bytes.byteLength !== reference.byteLength) {
    throw new AudioAssetRepositoryError('length-mismatch');
  }
  if ((await sha256AudioAsset(bytes)) !== reference.checksumSha256) {
    throw new AudioAssetRepositoryError('checksum-mismatch');
  }
}

export async function storeAudioAssetBytes(
  repository: AudioAssetRepository,
  bytes: Uint8Array,
): Promise<AudioAssetStoreReceipt> {
  const bounded = copyBytes(bytes);
  const checksumSha256 = await sha256AudioAsset(bounded);
  return repository.store({ bytes: bounded, checksumSha256, byteLength: bounded.byteLength });
}

export class MemoryAudioAssetRepository implements AudioAssetRepository {
  readonly kind = 'memory' as const;
  private readonly assets = new Map<string, Uint8Array>();

  async store(request: AudioAssetStoreRequest): Promise<AudioAssetStoreReceipt> {
    assertReference(request);
    await validateBytes(request, request.bytes);
    const existing = this.assets.get(request.checksumSha256);
    if (existing) {
      await validateBytes(request, existing);
      return { checksumSha256: request.checksumSha256, byteLength: request.byteLength, deduplicated: true };
    }
    this.assets.set(request.checksumSha256, copyBytes(request.bytes));
    return { checksumSha256: request.checksumSha256, byteLength: request.byteLength, deduplicated: false };
  }

  async read(reference: AudioAssetReference): Promise<Uint8Array> {
    assertReference(reference);
    const bytes = this.assets.get(reference.checksumSha256);
    if (!bytes) throw new AudioAssetRepositoryError('missing');
    await validateBytes(reference, bytes);
    return copyBytes(bytes);
  }

  async verify(reference: AudioAssetReference): Promise<void> {
    void (await this.read(reference));
  }
}

type StoredAudioAsset = Readonly<{
  checksumSha256: string;
  byteLength: number;
  bytes: ArrayBuffer;
}>;

function idbFailure(error: unknown, operation: 'read' | 'write'): AudioAssetRepositoryError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'QuotaExceededError') return new AudioAssetRepositoryError('too-large');
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return new AudioAssetRepositoryError('access-denied');
  }
  return new AudioAssetRepositoryError(operation === 'read' ? 'read-failed' : 'write-failed');
}

function requestResult<T>(request: IDBRequest<T>, operation: 'read' | 'write'): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(idbFailure(request.error, operation));
  });
}

function transactionDone(transaction: IDBTransaction, operation: 'read' | 'write'): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(idbFailure(transaction.error, operation));
    transaction.onerror = () => reject(idbFailure(transaction.error, operation));
  });
}

export class IndexedDbAudioAssetRepository implements AudioAssetRepository {
  readonly kind = 'indexeddb' as const;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory | null = browserIndexedDbFactory()) {}

  private database(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new AudioAssetRepositoryError('storage-unavailable'));
    if (!this.databasePromise) {
      this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
        let settled = false;
        const rejectOnce = (error: AudioAssetRepositoryError): void => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        let request: IDBOpenDBRequest;
        try {
          request = this.factory!.open(AUDIO_ASSET_DATABASE_NAME, 1);
        } catch (error) {
          rejectOnce(idbFailure(error, 'read'));
          return;
        }
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(AUDIO_ASSET_OBJECT_STORE)) {
            database.createObjectStore(AUDIO_ASSET_OBJECT_STORE, { keyPath: 'checksumSha256' });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          if (settled) {
            // A formerly blocked request can later succeed after callers have
            // already received a typed failure. Never leak that late handle.
            database.close();
            return;
          }
          settled = true;
          database.onversionchange = () => {
            database.close();
            this.databasePromise = null;
          };
          database.onclose = () => {
            this.databasePromise = null;
          };
          resolve(database);
        };
        request.onerror = () => rejectOnce(idbFailure(request.error, 'read'));
        request.onblocked = () => rejectOnce(new AudioAssetRepositoryError('storage-unavailable'));
      }).catch((error) => {
        this.databasePromise = null;
        throw error;
      });
    }
    return this.databasePromise!;
  }

  async store(request: AudioAssetStoreRequest): Promise<AudioAssetStoreReceipt> {
    assertReference(request);
    await validateBytes(request, request.bytes);
    const database = await this.database();
    const transaction = database.transaction(AUDIO_ASSET_OBJECT_STORE, 'readwrite');
    const objectStore = transaction.objectStore(AUDIO_ASSET_OBJECT_STORE);
    // Register completion handlers before the first request. IndexedDB may
    // auto-commit as soon as a request callback returns, while checksum
    // validation intentionally continues asynchronously outside that scope.
    const completion = transactionDone(transaction, 'write');
    try {
      const existing = await requestResult<StoredAudioAsset | undefined>(
        objectStore.get(request.checksumSha256),
        'read',
      );
      if (existing !== undefined) {
        const existingBytes = decodeStoredAsset(existing, request);
        await completion;
        await validateBytes(request, existingBytes);
        return { checksumSha256: request.checksumSha256, byteLength: request.byteLength, deduplicated: true };
      }
      const bytes = copyBytes(request.bytes);
      await requestResult(
        objectStore.add({
          checksumSha256: request.checksumSha256,
          byteLength: request.byteLength,
          bytes: bytes.buffer,
        } satisfies StoredAudioAsset),
        'write',
      );
      await completion;
      return { checksumSha256: request.checksumSha256, byteLength: request.byteLength, deduplicated: false };
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // A completed/aborted transaction needs no further rollback.
      }
      await completion.catch(() => undefined);
      if (error instanceof AudioAssetRepositoryError) throw error;
      throw idbFailure(error, 'write');
    }
  }

  async read(reference: AudioAssetReference): Promise<Uint8Array> {
    assertReference(reference);
    const database = await this.database();
    const transaction = database.transaction(AUDIO_ASSET_OBJECT_STORE, 'readonly');
    const completion = transactionDone(transaction, 'read');
    try {
      const stored = await requestResult<StoredAudioAsset | undefined>(
        transaction.objectStore(AUDIO_ASSET_OBJECT_STORE).get(reference.checksumSha256),
        'read',
      );
      await completion;
      if (!stored) throw new AudioAssetRepositoryError('missing');
      const bytes = decodeStoredAsset(stored, reference);
      await validateBytes(reference, bytes);
      return bytes;
    } catch (error) {
      await completion.catch(() => undefined);
      if (error instanceof AudioAssetRepositoryError) throw error;
      throw idbFailure(error, 'read');
    }
  }

  async verify(reference: AudioAssetReference): Promise<void> {
    void (await this.read(reference));
  }
}

function browserIndexedDbFactory(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function decodeStoredAsset(stored: unknown, expected: AudioAssetReference): Uint8Array {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    throw new AudioAssetRepositoryError('corrupt');
  }
  const candidate = stored as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.checksumSha256 !== expected.checksumSha256 ||
    candidate.byteLength !== expected.byteLength ||
    !(candidate.bytes instanceof ArrayBuffer)
  ) {
    throw new AudioAssetRepositoryError('corrupt');
  }
  return copyBytes(new Uint8Array(candidate.bytes));
}

type NativeAudioAssetRawInvoke = (
  command: string,
  payload?: unknown,
  options?: Readonly<{ headers: Readonly<Record<string, string>> }>,
) => Promise<unknown>;

function defaultNativeInvoke(command: string, payload?: unknown, options?: Readonly<{ headers: Readonly<Record<string, string>> }>): Promise<unknown> {
  return invokeTauriCommand(command, payload as never, options);
}

const nativeErrorCodes = new Set<AudioAssetRepositoryErrorCode>([
  'invalid-request', 'too-large', 'checksum-mismatch', 'length-mismatch', 'missing',
  'corrupt', 'storage-unavailable', 'access-denied', 'read-failed', 'write-failed',
]);

function nativeFailure(error: unknown): AudioAssetRepositoryError {
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const candidate = error as Record<string, unknown>;
    if (
      Object.keys(candidate).length === 1 &&
      typeof candidate.code === 'string' &&
      nativeErrorCodes.has(candidate.code as AudioAssetRepositoryErrorCode)
    ) {
      return new AudioAssetRepositoryError(candidate.code as AudioAssetRepositoryErrorCode);
    }
  }
  return new AudioAssetRepositoryError('invalid-response');
}

function decodeNativeReceipt(value: unknown, expected: AudioAssetReference): AudioAssetStoreReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AudioAssetRepositoryError('invalid-response');
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.checksumSha256 !== expected.checksumSha256 ||
    candidate.byteLength !== expected.byteLength ||
    typeof candidate.deduplicated !== 'boolean'
  ) {
    throw new AudioAssetRepositoryError('invalid-response');
  }
  return {
    checksumSha256: expected.checksumSha256,
    byteLength: expected.byteLength,
    deduplicated: candidate.deduplicated,
  };
}

export class NativeAudioAssetRepository implements AudioAssetRepository {
  readonly kind = 'native' as const;

  constructor(private readonly invoke: NativeAudioAssetRawInvoke = defaultNativeInvoke) {}

  async store(request: AudioAssetStoreRequest): Promise<AudioAssetStoreReceipt> {
    assertReference(request);
    await validateBytes(request, request.bytes);
    try {
      const raw = await this.invoke(AUDIO_ASSET_COMMANDS.store, copyBytes(request.bytes), {
        headers: {
          [AUDIO_ASSET_CHECKSUM_HEADER]: request.checksumSha256,
          [AUDIO_ASSET_BYTE_LENGTH_HEADER]: String(request.byteLength),
        },
      });
      return decodeNativeReceipt(raw, request);
    } catch (error) {
      if (error instanceof AudioAssetRepositoryError) throw error;
      throw nativeFailure(error);
    }
  }

  async read(reference: AudioAssetReference): Promise<Uint8Array> {
    assertReference(reference);
    try {
      const raw = await this.invoke(AUDIO_ASSET_COMMANDS.read, {
        request: {
          checksumSha256: reference.checksumSha256,
          expectedByteLength: reference.byteLength,
        },
      });
      const bytes = boundedBytes(raw);
      await validateBytes(reference, bytes);
      return bytes;
    } catch (error) {
      if (error instanceof AudioAssetRepositoryError) throw error;
      throw nativeFailure(error);
    }
  }

  async verify(reference: AudioAssetReference): Promise<void> {
    assertReference(reference);
    try {
      const raw = await this.invoke(AUDIO_ASSET_COMMANDS.verify, {
        request: {
          checksumSha256: reference.checksumSha256,
          expectedByteLength: reference.byteLength,
        },
      });
      if (raw !== null) throw new AudioAssetRepositoryError('invalid-response');
    } catch (error) {
      if (error instanceof AudioAssetRepositoryError) throw error;
      throw nativeFailure(error);
    }
  }
}
