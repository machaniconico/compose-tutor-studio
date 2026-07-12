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

export type StudioRuntime =
  | Readonly<{
      kind: 'web';
      repository: ProjectRepository;
    }>
  | Readonly<{
      kind: 'native';
      repository: NativeRecoveryProjectRepository;
    }>;

export type StudioRuntimeOptions = Readonly<{
  bridge?: TauriBridge;
  browserRepository?: ProjectRepository;
  storage?: StorageLike | StorageProvider | null;
  migrationGateway?: NativeLegacyMigrationGateway;
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
    };
  }
  return {
    kind: 'web',
    repository: options.browserRepository ?? browserProjectRepository,
  };
}

/** Composition-root selection for the application. */
export const studioRuntime = createStudioRuntime();
export const selectedProjectRepository: ProjectRepository = studioRuntime.repository;
