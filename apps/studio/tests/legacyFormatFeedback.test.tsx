import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { createEmptyProject, decodeProjectJson } from '@cts/project-model';
import {
  decodePortableProjectBundle,
  PORTABLE_PROJECT_BUNDLE_HEADER_BYTES,
  PORTABLE_PROJECT_BUNDLE_MAGIC,
  PORTABLE_PROJECT_BUNDLE_VERSION,
} from '@cts/project-bundle';
import { legacyProjectKey, LocalStorageProjectRepository, MemoryProjectRepository } from '@cts/project-persistence';
import { portableProjectBundleFailureMessage } from '../src/features/export/portableProjectBundleErrors';
import { getSaveStatusPresentation } from '../src/features/transport/saveStatus';
import { NativeLegacyMigratingRepository } from '../src/platform/nativeLegacyMigration';
import { toSaveFailure } from '../src/state/persistence';
import { installLocalStorage, MemoryStorage } from './localStorageStub';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: <T,>(initial: T) => react.useState(initial === 'new' ? 'saved' : initial),
  };
});

vi.mock('../src/state/store', async (importOriginal) => {
  const store = await importOriginal<typeof import('../src/state/store')>();
  const getState = store.useStore.getState;
  return {
    ...store,
    useStore: Object.assign(
      <T,>(selector: (state: ReturnType<typeof getState>) => T) => selector(getState()),
      store.useStore,
    ),
  };
});

const message =
  'このファイルは開発中の別バージョンで保存されたため、このアプリではまだ開けません。元のファイルはそのまま残っています。';
const raw = readFileSync(
  new URL('../../../packages/project-model/tests/fixtures/wave5-v3/project-full.json', import.meta.url),
  'utf8',
);
const id = 'wave5-full';

it('provides the requested message for project file import', () => {
  expect(decodeProjectJson(raw)).toMatchObject({
    ok: false,
    error: { code: 'legacy-wave5-format', issues: [{ message }] },
  });
});

it('shows the format message in the saved project list alongside the existing future-version message', async () => {
  const storage = installLocalStorage();
  const { ProjectMenuContent } = await import('../src/features/projectMenu/ProjectMenuContent');
  const { useStore } = await import('../src/state/store');
  storage.setItem(legacyProjectKey(id), raw);
  storage.setItem(legacyProjectKey('future'), '{"schemaVersion":999}');
  const listed = await new LocalStorageProjectRepository({ storage }).list();
  if (!listed.ok) throw new Error(listed.error.code);

  useStore.setState({ savedProjects: listed.value });
  const html = renderToStaticMarkup(<ProjectMenuContent onDone={() => undefined} />);
  expect(html).toContain(message);
  expect(html).toContain('新しいアプリ版で作成されています');
  expect(storage.getItem(legacyProjectKey(id))).toBe(raw);
});

it('keeps the persistence code and explains why a legacy-format project cannot be saved', async () => {
  const storage = new MemoryStorage();
  storage.setItem(legacyProjectKey(id), raw);
  const repository = new LocalStorageProjectRepository({ storage });
  const saved = await repository.save({
    project: { ...createEmptyProject(), id },
    activationId: 'activation',
    revision: 1,
    writeId: 'write',
  });
  if (saved.ok) throw new Error('Unexpected save');
  expect(saved.error.code).toBe('unsupported-version');
  const { code: failure, retry } = toSaveFailure(saved.error);
  expect(getSaveStatusPresentation({
    phase: 'error',
    lastSavedAt: null,
    failure,
    retry,
  })).toMatchObject({ label: message, canRetry: false });
  expect(storage.getItem(legacyProjectKey(id))).toBe(raw);
});

it('restores the reason for a completed native legacy import from the retained source', async () => {
  const storage = new MemoryStorage();
  storage.setItem(legacyProjectKey(id), raw);
  const native = new MemoryProjectRepository();
  vi.spyOn(native, 'list').mockResolvedValue({
    ok: true,
    value: [{ status: 'unreadable', id, errorCode: 'unsupported-version', branches: [] }],
  });
  vi.spyOn(native, 'save').mockResolvedValue({
    ok: false,
    error: { operation: 'save', code: 'unsupported-version', retry: 'never', projectId: id },
  });
  const repository = new NativeLegacyMigratingRepository({
    repository: native,
    storage,
    gateway: {
      backupSnapshot: async () => ({ ok: true, value: undefined }),
      getStatus: async () => ({ ok: true, value: { complete: true } }),
      importProject: vi.fn(),
      complete: vi.fn(),
    },
  });
  await repository.initialize();
  await expect(repository.list()).resolves.toMatchObject({
    ok: true,
    value: [{ errorCode: 'unsupported-version', reason: 'legacy-wave5-format' }],
  });
  await expect(repository.save({
    project: { ...createEmptyProject(), id },
    activationId: 'activation',
    revision: 1,
    writeId: 'write',
  })).resolves.toMatchObject({
    ok: false,
    error: { code: 'unsupported-version', reason: 'legacy-wave5-format' },
  });
  expect(storage.getItem(legacyProjectKey(id))).toBe(raw);
});

it('uses the same message when a portable bundle contains the legacy project format', async () => {
  const encoder = new TextEncoder();
  const project = encoder.encode(raw);
  const checksumSha256 = createHash('sha256').update(project).digest('hex');
  const manifest = encoder.encode(JSON.stringify({
    format: 'ctsbundle',
    version: PORTABLE_PROJECT_BUNDLE_VERSION,
    project: { byteLength: project.byteLength, checksumSha256 },
    assets: [],
  }));
  const bundle = new Uint8Array(
    PORTABLE_PROJECT_BUNDLE_HEADER_BYTES + manifest.byteLength + project.byteLength,
  );
  bundle.set(encoder.encode(PORTABLE_PROJECT_BUNDLE_MAGIC));
  const header = new DataView(bundle.buffer);
  header.setUint16(8, PORTABLE_PROJECT_BUNDLE_VERSION, true);
  header.setUint32(12, manifest.byteLength, true);
  header.setUint32(16, project.byteLength, true);
  header.setUint32(24, bundle.byteLength, true);
  bundle.set(manifest, PORTABLE_PROJECT_BUNDLE_HEADER_BYTES);
  bundle.set(project, PORTABLE_PROJECT_BUNDLE_HEADER_BYTES + manifest.byteLength);

  const error = await decodePortableProjectBundle(bundle, {
    hash: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
  }).then(() => { throw new Error('Unexpected bundle decode'); }, (error: unknown) => error);
  expect(error).toMatchObject({ code: 'unsupported-version' });
  expect(portableProjectBundleFailureMessage(error)).toBe(message);
});
