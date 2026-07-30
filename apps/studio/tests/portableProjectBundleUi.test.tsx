import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyProject,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { encodePortableProjectBundle } from '@cts/project-bundle';
import type { ExportOperation } from '../src/features/export/ExportMenu';
import {
  getReservedHeavyAudioResourceBytes,
  reserveHeavyAudioResources,
} from '../src/audio/audioResourceReservation';
import {
  NativeFileGatewayError,
  nativeFileGateway,
} from '../src/platform/nativeFileGateway';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  read: vi.fn(),
  store: vi.fn(),
  verify: vi.fn(),
  replaceProject: vi.fn(),
  uid: vi.fn(),
  toast: vi.fn(),
  runtimeKind: 'web' as 'web' | 'native',
  events: [] as string[],
  state: null as unknown as {
    project: Project;
    editor: { selectedTrackId: string | null };
    replaceProject: (project: Project) => Promise<boolean>;
  },
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useRef: vi.fn((initial: unknown) => ({ current: initial })),
  };
});
vi.mock('../src/state/store', () => ({
  useStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => ({
        ...mocks.state,
        saveState: { phase: 'saved' },
      }),
    },
  ),
}));
vi.mock('../src/platform/runtime', () => ({
  studioRuntime: {
    get kind() {
      return mocks.runtimeKind;
    },
    audioAssets: {
      kind: 'memory',
      read: (...args: unknown[]) => mocks.read(...args),
      store: (...args: unknown[]) => mocks.store(...args),
      verify: (...args: unknown[]) => mocks.verify(...args),
    },
  },
}));
vi.mock('../src/state/ids', () => ({
  uid: (...args: unknown[]) => mocks.uid(...args),
}));
vi.mock('../src/features/export/download', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/features/export/download')>();
  return {
    ...original,
    downloadBlob: (...args: unknown[]) => mocks.download(...args),
    downloadBlobAndWaitForHandoff: (...args: unknown[]) => mocks.download(...args),
  };
});
vi.mock('../src/state/tutorialBridge', () => ({
  pushToast: (...args: unknown[]) => mocks.toast(...args),
}));
vi.mock('../src/state/appEvents', () => ({ publishAppEvent: vi.fn() }));

type ElementProps = {
  children?: ReactNode;
  onClick?: () => void;
  onChange?: (event: {
    target: { files?: File[]; value: string };
  }) => void;
  accept?: string;
};

function find(node: ReactNode, predicate: (element: ReactElement<ElementProps>) => boolean):
ReactElement<ElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<ElementProps>;
  if (predicate(element)) return element;
  return find(element.props.children, predicate);
}

function portableControls(tree: ReactNode): {
  exportButton: ReactElement<ElementProps>;
  input: ReactElement<ElementProps>;
} {
  const exportButton = find(tree, (element) =>
    element.type === 'button' && element.props.children === '音声込みポータブルを書き出し');
  const input = find(tree, (element) =>
    element.type === 'input' && element.props.accept?.startsWith('.ctsbundle') === true);
  expect(exportButton).not.toBeNull();
  expect(input).not.toBeNull();
  return { exportButton: exportButton!, input: input! };
}

async function checksum(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalWav(...samples: number[]): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

async function readyAsset(id: string, bytes: Uint8Array): Promise<ReadyAudioAsset> {
  return {
    id,
    availability: 'ready',
    checksumSha256: await checksum(bytes),
    originalName: `${id}.wav`,
    mediaType: 'audio/wav',
    byteLength: bytes.byteLength,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: (bytes.byteLength - 44) / 2,
  };
}

function recordCryptoDigests(): void {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    mocks.events.push('hash');
    return digest(algorithm, data);
  });
}

let ExportMenuContent:
  typeof import('../src/features/export/ExportMenuContent')['ExportMenuContent'];

beforeAll(async () => {
  ({ ExportMenuContent } = await import('../src/features/export/ExportMenuContent'));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.runtimeKind = 'web';
  mocks.uid.mockImplementation(() => {
    mocks.events.push('fresh-id');
    return 'project-fresh';
  });
  mocks.replaceProject.mockImplementation(async () => {
    mocks.events.push('replace');
    return true;
  });
  mocks.state = {
    project: createEmptyProject({ title: 'portable-ui' }),
    editor: { selectedTrackId: null },
    replaceProject: mocks.replaceProject,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function menu(
  beginOperation = vi.fn(() => true),
  onDone = vi.fn(),
): ReactNode {
  return ExportMenuContent({
    onDone,
    activeOperation: null,
    beginOperation,
    finishOperation: vi.fn(),
  });
}

describe('portable bundle web controls', () => {
  it('uses separate controls, file inputs, and operation ids from metadata-only JSON', async () => {
    const begin = vi.fn<(operation: ExportOperation) => boolean>(() => false);
    const tree = menu(begin);
    const { exportButton, input } = portableControls(tree);
    const metadataInput = find(tree, (element) =>
      element.type === 'input' && element.props.accept === '.json,application/json');
    expect(metadataInput).not.toBeNull();
    expect(input).not.toBe(metadataInput);
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain('第三者へ渡すと素材も共有される');
    expect(html).toContain('共有の許諾がある音源');
    expect(html).toContain('自動で外部送信することはありません');

    await exportButton.props.onClick?.();
    expect(begin).toHaveBeenCalledWith('portable-project-export');

    const tooLarge = {
      size: 128 * 1024 * 1024 + 1,
      arrayBuffer: vi.fn(),
    } as unknown as File;
    input.props.onChange?.({ target: { files: [tooLarge], value: 'bundle' } });
    expect(tooLarge.arrayBuffer).not.toHaveBeenCalled();

    const file = {
      size: 1,
      arrayBuffer: vi.fn(async () => Uint8Array.of(0).buffer),
    } as unknown as File;
    input.props.onChange?.({ target: { files: [file], value: 'bundle' } });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledWith('portable-project-import');
    expect(begin.mock.calls.map(([operation]) => operation)).toEqual([
      'portable-project-export',
      'portable-project-import',
    ]);
  });

  it('reads and hashes every asset before constructing the Blob and handing off download', async () => {
    const firstBytes = canonicalWav(1, 2, 3);
    const secondBytes = canonicalWav(8, 5, 3, 1);
    const assets = await Promise.all([
      readyAsset('first-asset', firstBytes),
      readyAsset('second-asset', secondBytes),
    ]);
    const byChecksum = new Map([
      [assets[0]!.checksumSha256, firstBytes],
      [assets[1]!.checksumSha256, secondBytes],
    ]);
    mocks.state.project = {
      ...createEmptyProject({ title: 'portable-ui' }),
      audioAssets: [...assets].reverse(),
    };
    mocks.read.mockImplementation(async (reference: { checksumSha256: string }) => {
      mocks.events.push(`read:${reference.checksumSha256}`);
      expect(getReservedHeavyAudioResourceBytes()).toBe(384 * 1024 * 1024);
      return byChecksum.get(reference.checksumSha256)!;
    });
    recordCryptoDigests();
    const BlobConstructor = vi.fn((
      _parts: readonly BlobPart[],
      _options?: BlobPropertyBag,
    ) => {
      mocks.events.push('blob');
      expect(getReservedHeavyAudioResourceBytes()).toBe(384 * 1024 * 1024);
      return {};
    });
    vi.stubGlobal('Blob', BlobConstructor);
    mocks.download.mockImplementation(() => {
      mocks.events.push('download');
      expect(getReservedHeavyAudioResourceBytes()).toBe(384 * 1024 * 1024);
    });

    const exportButton = find(menu(), (element) =>
      element.type === 'button'
      && element.props.children === '音声込みポータブルを書き出し');
    expect(exportButton).not.toBeNull();
    await exportButton!.props.onClick?.();
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());

    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.events.filter((event) => event.startsWith('read:')).sort()).toEqual(
      [...byChecksum.keys()].sort().map((value) => `read:${value}`),
    );
    expect(mocks.events.filter((event) => event === 'hash')).toHaveLength(3);
    const blobIndex = mocks.events.indexOf('blob');
    expect(blobIndex).toBeGreaterThan(mocks.events.lastIndexOf('hash'));
    for (const event of mocks.events.filter((value) => value.startsWith('read:'))) {
      expect(blobIndex).toBeGreaterThan(mocks.events.indexOf(event));
    }
    const [blobParts, blobOptions] = BlobConstructor.mock.calls[0]!;
    expect(blobParts).toHaveLength(1);
    expect(blobParts[0]).toBeInstanceOf(Uint8Array);
    expect(blobOptions).toEqual({
      type: 'application/vnd.compose-tutor-studio.project-bundle',
    });
    expect(mocks.events.slice(blobIndex)).toEqual(['blob', 'download']);
  });

  it('holds the 384 MiB lease until the web download handoff settles', async () => {
    let completeHandoff: (() => void) | undefined;
    mocks.download.mockImplementation(() => new Promise<void>((resolve) => {
      mocks.events.push('download-start');
      completeHandoff = resolve;
    }));

    const { exportButton } = portableControls(menu());
    await exportButton.props.onClick?.();
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());

    expect(getReservedHeavyAudioResourceBytes()).toBe(384 * 1024 * 1024);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(completeHandoff).toBeTypeOf('function');
    completeHandoff?.();
    await vi.waitFor(() => expect(getReservedHeavyAudioResourceBytes()).toBe(0));
    expect(mocks.toast).toHaveBeenCalledWith(
      '音声込みポータブルプロジェクトを書き出しました。',
      'success',
    );
  });

  it('releases the 384 MiB lease when the web download handoff fails', async () => {
    mocks.download.mockRejectedValue(new Error('injected handoff failure'));

    const { exportButton } = portableControls(menu());
    await exportButton.props.onClick?.();
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getReservedHeavyAudioResourceBytes()).toBe(0));

    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(mocks.toast.mock.calls[0]?.[0]).toContain('保存先へ渡せませんでした');
    expect(mocks.toast.mock.calls[0]?.[1]).toBe('error');
  });

  it('does not construct a Blob or hand off a download when asset validation fails', async () => {
    const bytes = canonicalWav(4, 5, 6);
    const asset = await readyAsset('changed-asset', bytes);
    mocks.state.project = {
      ...createEmptyProject(),
      audioAssets: [asset],
    };
    mocks.read.mockResolvedValue(canonicalWav(4, 5, 7));
    recordCryptoDigests();
    const BlobConstructor = vi.fn();
    vi.stubGlobal('Blob', BlobConstructor);

    const { exportButton } = portableControls(menu());
    await exportButton.props.onClick?.();
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.events.filter((event) => event === 'hash')).toHaveLength(2));
    expect(BlobConstructor).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('checks size, decodes and hashes fully, stores and checks receipts, then clones and replaces', async () => {
    const bytes = canonicalWav(9, 7, 5, 3);
    const asset = await readyAsset('imported-asset', bytes);
    const sourceProject = {
      ...createEmptyProject({ title: 'portable import' }),
      audioAssets: [asset],
    };
    const bundle = await encodePortableProjectBundle(sourceProject, {
      read: async () => bytes,
    });
    mocks.events.length = 0;
    recordCryptoDigests();
    mocks.store.mockImplementation(async (request: {
      checksumSha256: string;
      byteLength: number;
    }) => {
      mocks.events.push('store');
      expect(getReservedHeavyAudioResourceBytes()).toBe(384 * 1024 * 1024);
      return {
        get checksumSha256() {
          mocks.events.push('receipt-checksum');
          return request.checksumSha256;
        },
        get byteLength() {
          mocks.events.push('receipt-length');
          return request.byteLength;
        },
        deduplicated: false,
      };
    });
    mocks.replaceProject.mockImplementation(async (project: Project) => {
      mocks.events.push('replace');
      expect(project.id).toBe('project-fresh');
      expect(project.id).not.toBe(sourceProject.id);
      return true;
    });
    const file = {
      get size() {
        mocks.events.push('size');
        return bundle.byteLength;
      },
      arrayBuffer: vi.fn(async () => {
        mocks.events.push('arrayBuffer');
        expect(getReservedHeavyAudioResourceBytes()).toBe(384 * 1024 * 1024);
        return bundle.slice().buffer;
      }),
    } as unknown as File;

    const { input } = portableControls(menu());
    input.props.onChange?.({ target: { files: [file], value: 'bundle' } });
    await vi.waitFor(() => expect(mocks.replaceProject).toHaveBeenCalledOnce());

    expect(mocks.store).toHaveBeenCalledOnce();
    expect(mocks.events[0]).toBe('size');
    expect(mocks.events[1]).toBe('arrayBuffer');
    expect(mocks.events.filter((event) => event === 'hash')).toHaveLength(2);
    const storeIndex = mocks.events.indexOf('store');
    expect(storeIndex).toBeGreaterThan(mocks.events.lastIndexOf('hash'));
    expect(mocks.events.slice(storeIndex)).toEqual([
      'store',
      'receipt-checksum',
      'receipt-length',
      'fresh-id',
      'replace',
    ]);
  });

  it('does not replace a Project that changed while portable assets were being stored', async () => {
    const bytes = canonicalWav(2, 4, 6, 8);
    const asset = await readyAsset('stale-import-asset', bytes);
    const bundle = await encodePortableProjectBundle({
      ...createEmptyProject({ title: 'incoming stale bundle' }),
      audioAssets: [asset],
    }, {
      read: async () => bytes,
    });
    const onDone = vi.fn();
    mocks.store.mockImplementation(async (request: {
      checksumSha256: string;
      byteLength: number;
    }) => {
      mocks.state = {
        ...mocks.state,
        project: createEmptyProject({ title: 'concurrent current project' }),
      };
      return { ...request, deduplicated: false };
    });
    const file = {
      size: bundle.byteLength,
      arrayBuffer: vi.fn(async () => bundle.slice().buffer),
    } as unknown as File;

    const { input } = portableControls(menu(vi.fn(() => true), onDone));
    input.props.onChange?.({ target: { files: [file], value: 'bundle' } });
    await vi.waitFor(() => expect(mocks.store).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());

    expect(mocks.replaceProject).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(mocks.state.project.title).toBe('concurrent current project');
    expect(mocks.toast.mock.calls[0]?.[0]).toContain('切り替えませんでした');
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('reservation rejection happens before web File, repository, Blob, and download boundaries', async () => {
    const competing = reserveHeavyAudioResources(1);
    try {
      const BlobConstructor = vi.fn();
      vi.stubGlobal('Blob', BlobConstructor);
      const file = {
        size: 1,
        arrayBuffer: vi.fn(async () => Uint8Array.of(0).buffer),
      } as unknown as File;
      const { exportButton, input } = portableControls(menu());
      await exportButton.props.onClick?.();
      input.props.onChange?.({ target: { files: [file], value: 'bundle' } });
      await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.store).not.toHaveBeenCalled();
      expect(file.arrayBuffer).not.toHaveBeenCalled();
      expect(BlobConstructor).not.toHaveBeenCalled();
      expect(mocks.download).not.toHaveBeenCalled();
      expect(getReservedHeavyAudioResourceBytes()).toBe(1);
    } finally {
      competing.release();
    }
  });

  it('explains an unsafe bundle memory plan and never reads the projected large asset', async () => {
    const projectedAssetBytes = 100 * 1024 * 1024;
    mocks.state.project = {
      ...createEmptyProject(),
      audioAssets: [{
        id: 'large-projected-asset',
        availability: 'ready',
        checksumSha256: 'b'.repeat(64),
        originalName: 'large-self-authored.wav',
        mediaType: 'audio/wav',
        byteLength: projectedAssetBytes,
        sampleRate: 48_000,
        channelCount: 1,
        frameCount: projectedAssetBytes / 2,
      }],
    };
    const BlobConstructor = vi.fn();
    vi.stubGlobal('Blob', BlobConstructor);

    const { exportButton } = portableControls(menu());
    await exportButton.props.onClick?.();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());

    expect(mocks.toast.mock.calls[0]?.[0]).toContain('必要なメモリ');
    expect(mocks.toast.mock.calls[0]?.[0]).toContain('長い音声素材を減らしてください');
    expect(mocks.read).not.toHaveBeenCalled();
    expect(BlobConstructor).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('uses native IPC under the 384 MiB lease and never constructs a Blob', async () => {
    mocks.runtimeKind = 'native';
    const BlobConstructor = vi.fn();
    vi.stubGlobal('Blob', BlobConstructor);
    const save = vi.spyOn(nativeFileGateway, 'exportProjectBundle')
      .mockImplementation(async (_bytes, _fileName, reservation) => {
        mocks.events.push('native-save');
        expect(getReservedHeavyAudioResourceBytes()).toBe(384 * 1024 * 1024);
        expect(reservation.released).toBe(false);
        return { status: 'saved' };
      });
    const tree = menu();
    const exportButton = find(tree, (element) =>
      element.type === 'button'
      && element.props.children === '音声込みポータブルを書き出し');
    expect(exportButton).not.toBeNull();
    await exportButton!.props.onClick?.();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(BlobConstructor).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('native cancel produces no toast, onDone, or Project adoption', async () => {
    mocks.runtimeKind = 'native';
    const onDone = vi.fn();
    const open = vi.spyOn(nativeFileGateway, 'openProjectBundle')
      .mockImplementation(async (reservation) => {
        expect(getReservedHeavyAudioResourceBytes()).toBe(384 * 1024 * 1024);
        expect(reservation.released).toBe(false);
        return { status: 'cancelled' };
      });
    const tree = menu(vi.fn(() => true), onDone);
    const importButton = find(tree, (element) =>
      element.type === 'button'
      && element.props.children === '音声込みポータブルを読み込み');
    expect(importButton).not.toBeNull();
    await importButton!.props.onClick?.();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.replaceProject).not.toHaveBeenCalled();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('native save cancel is silent and does not report a successful handoff', async () => {
    mocks.runtimeKind = 'native';
    const onDone = vi.fn();
    const save = vi.spyOn(nativeFileGateway, 'exportProjectBundle')
      .mockImplementation(async (_bytes, _fileName, reservation) => {
        expect(reservation.released).toBe(false);
        return { status: 'cancelled' };
      });
    const tree = menu(vi.fn(() => true), onDone);
    const exportButton = find(tree, (element) =>
      element.type === 'button'
      && element.props.children === '音声込みポータブルを書き出し');
    await exportButton!.props.onClick?.();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(mocks.replaceProject).not.toHaveBeenCalled();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('preserves a typed native size rejection instead of reporting a generic save failure', async () => {
    mocks.runtimeKind = 'native';
    vi.spyOn(nativeFileGateway, 'exportProjectBundle')
      .mockRejectedValue(new NativeFileGatewayError('file-too-large'));

    const exportButton = find(menu(), (element) =>
      element.type === 'button'
      && element.props.children === '音声込みポータブルを書き出し');
    expect(exportButton).not.toBeNull();
    await exportButton!.props.onClick?.();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());

    expect(mocks.toast.mock.calls[0]?.[0]).toContain('上限128MB');
    expect(mocks.toast.mock.calls[0]?.[0]).not.toContain('保存先へ渡せませんでした');
    expect(mocks.download).not.toHaveBeenCalled();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });
});
