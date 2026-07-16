import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_ASSET_BYTE_LENGTH_HEADER,
  AUDIO_ASSET_CHECKSUM_HEADER,
  AUDIO_ASSET_COMMANDS,
  AudioAssetRepositoryError,
  IndexedDbAudioAssetRepository,
  MemoryAudioAssetRepository,
  NativeAudioAssetRepository,
  sha256AudioAsset,
  storeAudioAssetBytes,
} from '../src/platform/audioAssetRepository';

const HELLO = new TextEncoder().encode('hello world');
const HELLO_SHA256 = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';

describe('audio asset repositories', () => {
  it('hashes, stores, deduplicates, and returns defensive byte copies in memory', async () => {
    const repository = new MemoryAudioAssetRepository();
    expect(await sha256AudioAsset(HELLO)).toBe(HELLO_SHA256);

    const first = await storeAudioAssetBytes(repository, HELLO);
    const second = await storeAudioAssetBytes(repository, HELLO);
    expect(first).toEqual({ checksumSha256: HELLO_SHA256, byteLength: 11, deduplicated: false });
    expect(second).toEqual({ checksumSha256: HELLO_SHA256, byteLength: 11, deduplicated: true });

    const loaded = await repository.read(first);
    loaded[0] = 0;
    await expect(repository.read(first)).resolves.toEqual(HELLO);
    await expect(repository.verify(first)).resolves.toBeUndefined();
  });

  it('rejects false identities without mutating the memory repository', async () => {
    const repository = new MemoryAudioAssetRepository();
    await expect(repository.store({
      bytes: HELLO,
      byteLength: HELLO.byteLength,
      checksumSha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'checksum-mismatch' });
    await expect(repository.read({
      byteLength: HELLO.byteLength,
      checksumSha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'missing' });
  });

  it('uses bounded raw IPC for native store and validates every native response', async () => {
    const invoke = vi.fn(async (
      command: string,
      _payload?: unknown,
      _options?: Readonly<{ headers: Readonly<Record<string, string>> }>,
    ) => {
      if (command === AUDIO_ASSET_COMMANDS.store) {
        return { checksumSha256: HELLO_SHA256, byteLength: 11, deduplicated: false };
      }
      if (command === AUDIO_ASSET_COMMANDS.read) return HELLO;
      return null;
    });
    const repository = new NativeAudioAssetRepository(invoke);
    const reference = { checksumSha256: HELLO_SHA256, byteLength: HELLO.byteLength };

    await expect(repository.store({ ...reference, bytes: HELLO })).resolves.toMatchObject(reference);
    const storeCall = invoke.mock.calls[0];
    expect(storeCall?.[0]).toBe(AUDIO_ASSET_COMMANDS.store);
    expect(storeCall?.[1]).toEqual(HELLO);
    expect(storeCall?.[2]).toEqual({
      headers: {
        [AUDIO_ASSET_CHECKSUM_HEADER]: HELLO_SHA256,
        [AUDIO_ASSET_BYTE_LENGTH_HEADER]: '11',
      },
    });
    await expect(repository.read(reference)).resolves.toEqual(HELLO);
    await expect(repository.verify(reference)).resolves.toBeUndefined();
  });

  it('sanitizes malformed native failures and unavailable IndexedDB', async () => {
    const malformed = new NativeAudioAssetRepository(async () => {
      throw new Error('/secret/path');
    });
    await expect(malformed.read({ checksumSha256: HELLO_SHA256, byteLength: 11 }))
      .rejects.toEqual(new AudioAssetRepositoryError('invalid-response'));

    const unavailable = new IndexedDbAudioAssetRepository(null);
    await expect(unavailable.read({ checksumSha256: HELLO_SHA256, byteLength: 11 }))
      .rejects.toMatchObject({ code: 'storage-unavailable' });
  });
});
