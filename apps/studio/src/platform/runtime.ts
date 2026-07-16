import {
  NativeRecoveryJournal,
  NativeRecoveryProjectRepository,
  type ProjectRepository,
  type StorageLike,
  type StorageProvider,
} from '@cts/project-persistence';
import { browserProjectRepository } from '../state/persistence';
import {
  createNativeProjectRepository,
} from './nativeProjectRepository';
import {
  NativeLegacyMigratingRepository,
  type NativeLegacyMigrationGateway,
} from './nativeLegacyMigration';
import { nativeLegacyMigrationGateway } from './nativeLegacyMigrationGateway';
import { tauriBridge, type TauriBridge } from './tauriBridge';
import {
  AudioAssetRepositoryError,
  IndexedDbAudioAssetRepository,
  NativeAudioAssetRepository,
  type AudioAssetRepository,
} from './audioAssetRepository';
import {
  AudioAssetPlaybackError,
  setAudioAssetBytesResolver,
  type AudioAssetBytesResolver,
} from '../audio/audioAssetResolver';

export type StudioRuntime =
  | Readonly<{
      kind: 'web';
      repository: ProjectRepository;
      audioAssets: AudioAssetRepository;
    }>
  | Readonly<{
      kind: 'native';
      repository: NativeRecoveryProjectRepository;
      audioAssets: AudioAssetRepository;
    }>;

export type StudioRuntimeOptions = Readonly<{
  bridge?: TauriBridge;
  browserRepository?: ProjectRepository;
  storage?: StorageLike | StorageProvider | null;
  migrationGateway?: NativeLegacyMigrationGateway;
  audioAssetRepository?: AudioAssetRepository;
}>;

function webviewStorage(): StorageLike | null {
  // NativeRecoveryJournal and the migration snapshot own the exception
  // boundary around this provider; accessing localStorage can itself throw.
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Select platform services once, before the Studio store is constructed. */
export function createStudioRuntime(options: StudioRuntimeOptions = {}): StudioRuntime {
  const bridge = options.bridge ?? tauriBridge;
  if (bridge.isTauri()) {
    const storage = options.storage === undefined ? webviewStorage : options.storage;
    const nativeRepository = createNativeProjectRepository(bridge);
    const migratingRepository = new NativeLegacyMigratingRepository({
      repository: nativeRepository,
      gateway: options.migrationGateway ?? nativeLegacyMigrationGateway,
      storage,
    });
    return {
      kind: 'native',
      repository: new NativeRecoveryProjectRepository({
        delegate: migratingRepository,
        journal: new NativeRecoveryJournal({ storage }),
      }),
      audioAssets: options.audioAssetRepository ?? new NativeAudioAssetRepository(),
    };
  }
  return {
    kind: 'web',
    repository: options.browserRepository ?? browserProjectRepository,
    audioAssets: options.audioAssetRepository ?? new IndexedDbAudioAssetRepository(),
  };
}

/** Adapt platform persistence failures to the engine's stable playback contract. */
export function createAudioAssetBytesResolver(
  repository: AudioAssetRepository,
): AudioAssetBytesResolver {
  return {
    async resolve(asset, signal) {
      if (signal?.aborted) {
        throw new AudioAssetPlaybackError('cancelled', asset.id);
      }
      try {
        const bytes = await repository.read({
          checksumSha256: asset.checksumSha256,
          byteLength: asset.byteLength,
        });
        if (signal?.aborted) {
          throw new AudioAssetPlaybackError('cancelled', asset.id);
        }
        return bytes;
      } catch (error) {
        if (error instanceof AudioAssetPlaybackError) throw error;
        if (!(error instanceof AudioAssetRepositoryError)) {
          throw new AudioAssetPlaybackError('asset-unavailable', asset.id, undefined, error);
        }
        if (error.code === 'missing') {
          throw new AudioAssetPlaybackError('asset-missing', asset.id, undefined, error);
        }
        if (
          error.code === 'checksum-mismatch' ||
          error.code === 'length-mismatch' ||
          error.code === 'corrupt' ||
          error.code === 'invalid-response'
        ) {
          throw new AudioAssetPlaybackError('asset-changed', asset.id, undefined, error);
        }
        if (error.code === 'too-large') {
          throw new AudioAssetPlaybackError('resource-limit', asset.id, undefined, error);
        }
        throw new AudioAssetPlaybackError('asset-unavailable', asset.id, undefined, error);
      }
    },
  };
}

/** Composition-root selection for the application. */
export const studioRuntime = createStudioRuntime();
export const selectedProjectRepository: ProjectRepository = studioRuntime.repository;
export const selectedAudioAssetRepository: AudioAssetRepository = studioRuntime.audioAssets;
export const releaseStudioAudioAssetResolver = setAudioAssetBytesResolver(
  createAudioAssetBytesResolver(selectedAudioAssetRepository),
);
