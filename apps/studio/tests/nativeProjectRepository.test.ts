import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyProject,
  encodeProjectJson,
  type Project,
} from '@cts/project-model';
import {
  NativeProjectRepository,
  nativeExpectedHead,
} from '../src/platform/nativeProjectRepository';
import {
  PERSISTENCE_COMMANDS,
  type PersistenceCommand,
  type TauriBridge,
  type TauriInvokeArguments,
} from '../src/platform/tauriBridge';

const NOW = '2026-07-10T00:00:00.000Z';

function projectFixture(id = 'project-native'): Project {
  return {
    ...createEmptyProject({
      title: 'Native project',
      clock: () => new Date(NOW),
    }),
    id,
  };
}

function makeBridge(
  handler: (
    command: PersistenceCommand,
    args?: TauriInvokeArguments,
  ) => Promise<unknown> | unknown,
): TauriBridge & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(handler);
  return {
    isTauri: () => true,
    invoke,
  } as TauriBridge & { invoke: ReturnType<typeof vi.fn> };
}

function loadedWire(project: Project) {
  const encoded = encodeProjectJson(project);
  if (!encoded.ok) throw new Error('fixture must encode');
  return {
    projectJson: encoded.json,
    headVersion: '1:active:write-1',
    source: 'generation',
    recovered: false,
    recoveryReason: null,
  };
}

describe('NativeProjectRepository', () => {
  it('maps the three expected-head states without collapsing undefined and null', () => {
    expect(nativeExpectedHead(undefined)).toEqual({ kind: 'repair' });
    expect(nativeExpectedHead(null)).toEqual({ kind: 'empty' });
    expect(nativeExpectedHead('4:active:write-old')).toEqual({
      kind: 'match',
      version: '4:active:write-old',
    });
  });

  it('canonical-encodes saves and checks the complete receipt identity', async () => {
    const project = projectFixture();
    const encoded = encodeProjectJson(project);
    if (!encoded.ok) throw new Error('fixture must encode');
    const bridge = makeBridge(async (_command, args) => {
      const request = args?.request as Record<string, unknown>;
      return {
        projectId: request.projectId,
        activationId: request.activationId,
        revision: request.revision,
        writeId: request.writeId,
        headVersion: '2:active:write-2',
        savedAt: NOW,
        bytes: encoded.bytes,
        retainedGenerations: 2,
        legacyMirrorWritten: false,
      };
    });
    const repository = new NativeProjectRepository(bridge);

    await expect(
      repository.save({
        project,
        activationId: 'activation-1',
        revision: 2,
        writeId: 'write-2',
        expectedHeadVersion: null,
        predecessorWriteId: 'write-1',
      }),
    ).resolves.toMatchObject({ ok: true, value: { writeId: 'write-2', revision: 2 } });

    expect(bridge.invoke).toHaveBeenCalledWith(PERSISTENCE_COMMANDS.save, {
      request: {
        projectId: project.id,
        projectJson: encoded.json,
        activationId: 'activation-1',
        revision: 2,
        writeId: 'write-2',
        expectedHead: { kind: 'empty' },
        predecessorWriteId: 'write-1',
      },
    });

    const mismatchedBridge = makeBridge(async () => ({
      projectId: project.id,
      activationId: 'another-activation',
      revision: 2,
      writeId: 'write-2',
      headVersion: '2:active:write-2',
      savedAt: NOW,
      bytes: encoded.bytes,
      retainedGenerations: 1,
      legacyMirrorWritten: false,
    }));
    await expect(
      new NativeProjectRepository(mismatchedBridge).save({
        project,
        activationId: 'activation-1',
        revision: 2,
        writeId: 'write-2',
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        operation: 'save',
        code: 'write-failed',
        retry: 'automatic',
        projectId: project.id,
      },
    });
  });

  it('stages an exact crash draft and rejects a mismatched protection receipt', async () => {
    const project = projectFixture();
    const encoded = encodeProjectJson(project);
    if (!encoded.ok) throw new Error('fixture must encode');
    const bridge = makeBridge(async (_command, args) => {
      const request = args?.request as Record<string, unknown>;
      return {
        projectId: request.projectId,
        activationId: request.activationId,
        revision: request.revision,
        writeId: request.writeId,
        protectedAt: NOW,
        bytes: encoded.bytes,
      };
    });
    const repository = new NativeProjectRepository(bridge);
    const request = {
      project,
      activationId: 'activation-1',
      revision: 2,
      writeId: 'write-2',
      expectedHeadVersion: 'head-1',
      predecessorWriteId: 'write-1',
    } as const;

    await expect(repository.stageCrashDraft(request)).resolves.toMatchObject({
      ok: true,
      value: { revision: 2, writeId: 'write-2' },
    });
    expect(bridge.invoke).toHaveBeenCalledWith(PERSISTENCE_COMMANDS.stageCrashDraft, {
      request: {
        projectId: project.id,
        projectJson: encoded.json,
        activationId: 'activation-1',
        revision: 2,
        writeId: 'write-2',
        expectedHead: { kind: 'match', version: 'head-1' },
        predecessorWriteId: 'write-1',
      },
    });

    const mismatched = makeBridge(async () => ({
      projectId: project.id,
      activationId: 'activation-1',
      revision: 999,
      writeId: 'write-2',
      protectedAt: NOW,
      bytes: encoded.bytes,
    }));
    await expect(
      new NativeProjectRepository(mismatched).stageCrashDraft(request),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'write-failed' },
    });
  });

  it('rejects invalid projects before invoking native code', async () => {
    const bridge = makeBridge(async () => null);
    const repository = new NativeProjectRepository(bridge);
    const invalid = { ...projectFixture(), bpm: Number.NaN };

    await expect(
      repository.save({
        project: invalid,
        activationId: 'activation-1',
        revision: 0,
        writeId: 'write-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'invalid-project', retry: 'never' },
    });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it('decodes canonical project JSON and rejects a project-id substitution', async () => {
    const project = projectFixture();
    const bridge = makeBridge(async () => loadedWire(project));
    const repository = new NativeProjectRepository(bridge);

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { id: project.id, title: project.title } },
    });
    expect(bridge.invoke).toHaveBeenCalledWith(PERSISTENCE_COMMANDS.load, {
      projectId: project.id,
    });
    await expect(repository.loadMostRecent()).resolves.toMatchObject({
      ok: true,
      value: { project: { id: project.id } },
    });
    expect(bridge.invoke).toHaveBeenCalledWith(
      PERSISTENCE_COMMANDS.loadMostRecent,
      undefined,
    );

    await expect(repository.load('another-project')).resolves.toEqual({
      ok: false,
      error: {
        operation: 'load',
        code: 'corrupt-data',
        retry: 'never',
        projectId: 'another-project',
      },
    });
  });

  it('strictly decodes the durable project state used for tombstone privacy', async () => {
    const bridge = makeBridge(async (command) =>
      command === PERSISTENCE_COMMANDS.projectState ? { state: 'deleted' } : null,
    );
    const repository = new NativeProjectRepository(bridge);

    await expect(repository.getDurableProjectState('deleted-project')).resolves.toEqual({
      ok: true,
      value: 'deleted',
    });
    expect(bridge.invoke).toHaveBeenCalledWith(PERSISTENCE_COMMANDS.projectState, {
      projectId: 'deleted-project',
    });

    const malformed = makeBridge(async () => ({ state: 'deleted', extra: true }));
    await expect(
      new NativeProjectRepository(malformed).getDurableProjectState('deleted-project'),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: 'load', code: 'read-failed' },
    });
  });

  it('maps a future project payload to unsupported-version', async () => {
    const bridge = makeBridge(async () => ({
      projectJson: JSON.stringify({ schemaVersion: 999 }),
      headVersion: '1:active:future',
      source: 'generation',
      recovered: false,
      recoveryReason: null,
    }));
    const repository = new NativeProjectRepository(bridge);

    await expect(repository.load('future-project')).resolves.toEqual({
      ok: false,
      error: {
        operation: 'load',
        code: 'unsupported-version',
        retry: 'never',
        projectId: 'future-project',
      },
    });
  });

  it('strictly validates summaries and branch payloads', async () => {
    const project = projectFixture();
    const encoded = encodeProjectJson(project);
    if (!encoded.ok) throw new Error('fixture must encode');
    const branch = {
      branchId: 'branch-1',
      source: 'recovery-journal',
      activationId: 'activation-old',
      revision: 3,
      writeId: 'write-old',
      savedAt: NOW,
      title: 'Recovered copy',
      updatedAt: NOW,
    };
    const bridge = makeBridge(async (command) => {
      if (command === PERSISTENCE_COMMANDS.list) {
        return [
          {
            status: 'ready',
            id: project.id,
            title: project.title,
            updatedAt: NOW,
            recovered: false,
            branches: [branch],
          },
        ];
      }
      return { ...branch, projectJson: encoded.json };
    });
    const repository = new NativeProjectRepository(bridge);

    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [{ id: project.id, branches: [{ branchId: 'branch-1' }] }],
    });
    await expect(repository.loadProjectBranch(project.id, 'branch-1')).resolves.toMatchObject({
      ok: true,
      value: { branchId: 'branch-1', project: { id: project.id } },
    });

    const malformed = makeBridge(async () => [
      {
        status: 'ready',
        id: project.id,
        title: project.title,
        updatedAt: NOW,
        recovered: false,
        branches: [],
        unexpected: true,
      },
    ]);
    await expect(new NativeProjectRepository(malformed).list()).resolves.toEqual({
      ok: false,
      error: { operation: 'list', code: 'read-failed', retry: 'automatic' },
    });
  });

  it('preserves a valid structured native error and rejects mismatched error identity', async () => {
    const projectId = 'project-native';
    const bridge = makeBridge(async () => {
      throw { code: 'conflict', retry: 'manual', projectId };
    });
    await expect(new NativeProjectRepository(bridge).load(projectId)).resolves.toEqual({
      ok: false,
      error: { operation: 'load', code: 'conflict', retry: 'manual', projectId },
    });

    const substituted = makeBridge(async () => {
      throw { code: 'conflict', retry: 'manual', projectId: 'other-project' };
    });
    await expect(new NativeProjectRepository(substituted).load(projectId)).resolves.toEqual({
      ok: false,
      error: {
        operation: 'load',
        code: 'read-failed',
        retry: 'automatic',
        projectId,
      },
    });
  });

  it('validates remove receipts and requires null for void command success', async () => {
    const projectId = 'project-native';
    const bridge = makeBridge(async (command) => {
      if (command === PERSISTENCE_COMMANDS.remove) {
        return {
          projectId,
          deleteId: 'delete-1',
          headVersion: '3:deleted:delete-1',
          removed: true,
          cleanupComplete: true,
        };
      }
      return null;
    });
    const repository = new NativeProjectRepository(bridge);

    await expect(repository.initialize()).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      repository.remove({
        projectId,
        deleteId: 'delete-1',
        expectedHeadVersion: '2:active:write-2',
      }),
    ).resolves.toMatchObject({ ok: true, value: { removed: true } });
    expect(bridge.invoke).toHaveBeenCalledWith(PERSISTENCE_COMMANDS.remove, {
      request: {
        projectId,
        deleteId: 'delete-1',
        expectedHead: { kind: 'match', version: '2:active:write-2' },
      },
    });
    const callsBeforeClose = bridge.invoke.mock.calls.length;
    await expect(repository.close()).resolves.toEqual({
      ok: false,
      error: { operation: 'close', code: 'access-denied', retry: 'never' },
    });
    expect(bridge.invoke).toHaveBeenCalledTimes(callsBeforeClose);

    const malformedVoid = makeBridge(async () => ({}));
    await expect(new NativeProjectRepository(malformedVoid).initialize()).resolves.toEqual({
      ok: false,
      error: { operation: 'initialize', code: 'storage-unavailable', retry: 'manual' },
    });
  });
});
