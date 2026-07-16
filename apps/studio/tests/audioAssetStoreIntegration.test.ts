import { describe, expect, it } from 'vitest';
import { MemoryProjectRepository } from '@cts/project-persistence';
import { createAudioTrackClip, type ReadyAudioAsset } from '@cts/project-model';
import {
  MemoryAudioAssetRepository,
  storeAudioAssetBytes,
} from '../src/platform/audioAssetRepository';
import { createDefaultProject } from '../src/state/defaultProject';
import { createStudioStore } from '../src/state/store';

async function audioProject(
  assets: MemoryAudioAssetRepository,
): Promise<ReturnType<typeof createDefaultProject>> {
  const bytes = new Uint8Array([82, 73, 70, 70]);
  const receipt = await storeAudioAssetBytes(assets, bytes);
  const asset: ReadyAudioAsset = {
    id: 'asset-store-integration',
    availability: 'ready',
    checksumSha256: receipt.checksumSha256,
    originalName: 'take.wav',
    mediaType: 'audio/wav',
    byteLength: receipt.byteLength,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 48_000,
  };
  const created = createAudioTrackClip(createDefaultProject(), asset, {
    idFactory: (kind) => `${kind}-store-integration`,
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.project;
}

describe('Studio audio asset activation', () => {
  it('rejects a standalone project JSON when its ready binary is not locally available', async () => {
    const projectRepository = new MemoryProjectRepository();
    const storedAssets = new MemoryAudioAssetRepository();
    const project = await audioProject(storedAssets);
    const store = createStudioStore(projectRepository, {
      audioAssetRepository: new MemoryAudioAssetRepository(),
      localDataErase: null,
    });
    await store.getState().initializePersistence();
    const before = store.getState().project;

    await expect(store.getState().replaceProject(project)).resolves.toBe(false);
    expect(store.getState().project).toBe(before);
    expect(store.getState().persistenceNotice?.message).toMatch(/音声本体/);
  });

  it('activates a project only after the matching checksum object is available', async () => {
    const projectRepository = new MemoryProjectRepository();
    const assets = new MemoryAudioAssetRepository();
    const project = await audioProject(assets);
    const store = createStudioStore(projectRepository, {
      audioAssetRepository: assets,
      localDataErase: null,
    });
    await store.getState().initializePersistence();

    await expect(store.getState().replaceProject(project)).resolves.toBe(true);
    expect(store.getState().project.id).toBe(project.id);
    expect(store.getState().audioAssetIssues).toEqual({});
  });

  it('opens a saved project with a runtime-only missing marker without destroying metadata', async () => {
    const projectRepository = new MemoryProjectRepository();
    const assets = new MemoryAudioAssetRepository();
    const project = await audioProject(assets);
    const first = createStudioStore(projectRepository, {
      audioAssetRepository: assets,
      localDataErase: null,
    });
    await first.getState().initializePersistence();
    await expect(first.getState().replaceProject(project)).resolves.toBe(true);

    const reopened = createStudioStore(projectRepository, {
      audioAssetRepository: new MemoryAudioAssetRepository(),
      localDataErase: null,
    });
    await reopened.getState().initializePersistence();
    expect(reopened.getState().project.id).toBe(project.id);
    expect(reopened.getState().project.audioAssets).toEqual(project.audioAssets);
    expect(reopened.getState().audioAssetIssues).toEqual({
      'asset-store-integration': 'missing',
    });
    expect(reopened.getState().persistenceNotice?.message).toMatch(/見つかりません/);
  });
});
