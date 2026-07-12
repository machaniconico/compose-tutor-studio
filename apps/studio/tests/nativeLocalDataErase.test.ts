import { describe, expect, it, vi } from 'vitest';
import {
  clearRendererStorageAndBrowsingData,
  createSecureEraseId,
  ERASE_ID_PATTERN,
  startWithNativeEraseRecovery,
  TauriNativeLocalDataEraseGateway,
  type NativeEraseRecoveryScreenRequest,
} from '../src/platform/nativeLocalDataErase';
import {
  PERSISTENCE_COMMANDS,
  type PersistenceCommand,
  type TauriBridge,
  type TauriInvokeArguments,
} from '../src/platform/tauriBridge';
import { shouldShowEraseRecoveryRetry } from '../src/platform/LocalDataEraseRecoveryScreen';

const ERASE_ID = 'erase-12345678-1234-4234-9234-123456789abc';

function bridgeReturning(
  handler: (
    command: PersistenceCommand,
    args?: TauriInvokeArguments,
  ) => unknown | Promise<unknown>,
): TauriBridge & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(handler);
  return { isTauri: () => true, invoke } as TauriBridge & {
    invoke: ReturnType<typeof vi.fn>;
  };
}

describe('TauriNativeLocalDataEraseGateway', () => {
  it('invokes all commands with exact DTOs and accepts only exact results', async () => {
    const bridge = bridgeReturning((command) => {
      if (command === PERSISTENCE_COMMANDS.eraseAllStatus) {
        return { state: 'pending', eraseId: ERASE_ID };
      }
      if (command === PERSISTENCE_COMMANDS.prepareEraseAll) {
        return { eraseId: ERASE_ID, nativeDataRemoved: true };
      }
      return null;
    });
    const gateway = new TauriNativeLocalDataEraseGateway(bridge);

    await expect(gateway.getStatus()).resolves.toEqual({
      state: 'pending',
      eraseId: ERASE_ID,
    });
    await expect(gateway.prepare(ERASE_ID)).resolves.toEqual({
      eraseId: ERASE_ID,
      nativeDataRemoved: true,
    });
    await expect(gateway.complete(ERASE_ID)).resolves.toBeUndefined();

    expect(bridge.invoke.mock.calls).toEqual([
      [PERSISTENCE_COMMANDS.eraseAllStatus],
      [PERSISTENCE_COMMANDS.prepareEraseAll, { request: { eraseId: ERASE_ID } }],
      [PERSISTENCE_COMMANDS.completeEraseAll, { request: { eraseId: ERASE_ID } }],
    ]);
  });

  it.each([
    null,
    {},
    { state: 'idle', extra: true },
    { state: 'pending' },
    { state: 'pending', eraseId: 'erase-not-a-uuid' },
    { state: 'pending', eraseId: ERASE_ID, extra: true },
    { state: 'unknown' },
  ])('fails closed for malformed status %#', async (wire) => {
    const gateway = new TauriNativeLocalDataEraseGateway(
      bridgeReturning(() => wire),
    );
    await expect(gateway.getStatus()).rejects.toThrow('Invalid erase-all status');
  });

  it('rejects substituted/extended prepare receipts and non-null completion', async () => {
    const mismatched = new TauriNativeLocalDataEraseGateway(
      bridgeReturning(() => ({
        eraseId: 'erase-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        nativeDataRemoved: true,
      })),
    );
    await expect(mismatched.prepare(ERASE_ID)).rejects.toThrow(
      'Invalid erase-all prepare',
    );

    const extended = new TauriNativeLocalDataEraseGateway(
      bridgeReturning(() => ({
        eraseId: ERASE_ID,
        nativeDataRemoved: true,
        extra: true,
      })),
    );
    await expect(extended.prepare(ERASE_ID)).rejects.toThrow(
      'Invalid erase-all prepare',
    );

    const nonVoid = new TauriNativeLocalDataEraseGateway(
      bridgeReturning(() => ({})),
    );
    await expect(nonVoid.complete(ERASE_ID)).rejects.toThrow(
      'Invalid erase-all completion',
    );
  });

  it('rejects an invalid request id before IPC', async () => {
    const bridge = bridgeReturning(() => null);
    const gateway = new TauriNativeLocalDataEraseGateway(bridge);
    await expect(gateway.prepare('bad-id')).rejects.toThrow('Invalid erase-all request id');
    await expect(gateway.complete('bad-id')).rejects.toThrow('Invalid erase-all request id');
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
});

describe('createSecureEraseId', () => {
  it('prefixes a canonical secure UUID v4', () => {
    expect(
      createSecureEraseId({
        randomUUID: () => '12345678-1234-4234-9234-123456789abc',
      }),
    ).toBe(ERASE_ID);
  });

  it('uses secure random bytes with UUID v4 and variant bits when randomUUID is absent', () => {
    const eraseId = createSecureEraseId({
      getRandomValues: (bytes) => {
        bytes.fill(0);
        return bytes;
      },
    });
    expect(eraseId).toBe('erase-00000000-0000-4000-8000-000000000000');
    expect(eraseId).toMatch(ERASE_ID_PATTERN);
  });

  it('falls back to secure random bytes when randomUUID throws', () => {
    expect(
      createSecureEraseId({
        randomUUID: () => {
          throw new Error('restricted');
        },
        getRandomValues: (bytes) => {
          bytes.fill(0xff);
          return bytes;
        },
      }),
    ).toBe('erase-ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('never falls back to weak randomness', () => {
    expect(createSecureEraseId(null)).toBeNull();
    expect(
      createSecureEraseId({ randomUUID: () => 'not-a-v4-uuid' }),
    ).toBeNull();
  });
});

describe('clearRendererStorageAndBrowsingData', () => {
  it('clears twice around WebView browsing data and verifies both stores', async () => {
    const calls: string[] = [];
    const area = (name: string) => ({
      clear: () => calls.push(`${name}:clear`),
      get length() {
        calls.push(`${name}:length`);
        return 0;
      },
    });

    await clearRendererStorageAndBrowsingData({
      localStorage: area('local'),
      sessionStorage: area('session'),
      clearBrowsingData: async () => {
        calls.push('webview:clear');
      },
    });

    expect(calls).toEqual([
      'local:clear',
      'session:clear',
      'webview:clear',
      'local:clear',
      'session:clear',
      'local:length',
      'session:length',
    ]);
  });

  it('fails if either renderer store is recreated after the second clear', async () => {
    await expect(
      clearRendererStorageAndBrowsingData({
        localStorage: { clear: vi.fn(), length: 1 },
        sessionStorage: { clear: vi.fn(), length: 0 },
        clearBrowsingData: async () => undefined,
      }),
    ).rejects.toThrow('Renderer storage was recreated');
  });

  it.each([
    ['first local clear', 'local:1'],
    ['first session clear', 'session:1'],
    ['WebView clear', 'webview'],
    ['second local clear', 'local:2'],
    ['second session clear', 'session:2'],
  ] as const)('stops exactly at a failed %s boundary', async (_label, failedAt) => {
    const calls: string[] = [];
    const area = (name: 'local' | 'session') => {
      let clears = 0;
      return {
        clear: () => {
          clears += 1;
          const marker = `${name}:${clears}`;
          calls.push(marker);
          if (marker === failedAt) throw new Error('boundary failed');
        },
        get length() {
          calls.push(`${name}:length`);
          return 0;
        },
      };
    };

    await expect(
      clearRendererStorageAndBrowsingData({
        localStorage: area('local'),
        sessionStorage: area('session'),
        clearBrowsingData: async () => {
          calls.push('webview');
          if (failedAt === 'webview') throw new Error('boundary failed');
        },
      }),
    ).rejects.toThrow('boundary failed');

    expect(calls.at(-1)).toBe(failedAt);
    expect(calls).not.toContain('local:length');
    expect(calls).not.toContain('session:length');
  });
});

describe('LocalDataEraseRecoveryScreen retry visibility', () => {
  it('hides retry after a terminal unknown close response', () => {
    expect(
      shouldShowEraseRecoveryRetry({
        ok: false,
        outcome: 'close-unknown',
        retryable: false,
        message: '終了要求の応答を確認できませんでした。',
      }),
    ).toBe(false);
  });

  it('shows retry only before an attempt or after a pre-dispatch failure', () => {
    expect(shouldShowEraseRecoveryRetry(null)).toBe(true);
    expect(
      shouldShowEraseRecoveryRetry({
        ok: false,
        outcome: 'retryable-failure',
        retryable: true,
        message: '消去を再試行してください。',
      }),
    ).toBe(true);
    expect(
      shouldShowEraseRecoveryRetry({
        ok: true,
        outcome: 'close-accepted',
        retryable: false,
        message: '終了します。',
      }),
    ).toBe(false);
  });
});

describe('startWithNativeEraseRecovery', () => {
  function setup(status: { state: 'idle' } | { state: 'pending'; eraseId: string }) {
    const calls: string[] = [];
    let screen: NativeEraseRecoveryScreenRequest | null = null;
    const gateway = {
      getStatus: vi.fn(async () => {
        calls.push('status');
        return status;
      }),
      prepare: vi.fn(async (eraseId: string) => {
        calls.push('prepare');
        return { eraseId, nativeDataRemoved: true as const };
      }),
      complete: vi.fn(async () => {
        calls.push('complete');
      }),
    };
    const dependencies = {
      gateway,
      fenceWrites: vi.fn(() => calls.push('fence')),
      clearRendererData: vi.fn(async () => {
        calls.push('clear');
      }),
      finishClose: vi.fn(async () => {
        calls.push('finish');
        return true;
      }),
      showRecovery: vi.fn((request: NativeEraseRecoveryScreenRequest) => {
        calls.push('screen');
        screen = request;
      }),
      continueNormalStartup: vi.fn(async () => {
        calls.push('close-guard');
        calls.push('initialize/migrate');
        calls.push('app');
      }),
    };
    return { calls, gateway, dependencies, getScreen: () => screen };
  }

  it('continues normal bootstrap only after an exact idle status', async () => {
    const harness = setup({ state: 'idle' });
    await startWithNativeEraseRecovery(harness.dependencies);
    expect(harness.calls).toEqual([
      'status',
      'close-guard',
      'initialize/migrate',
      'app',
    ]);
    expect(harness.dependencies.showRecovery).not.toHaveBeenCalled();
  });

  it('bypasses normal bootstrap and resumes pending erase in strict order', async () => {
    const harness = setup({ state: 'pending', eraseId: ERASE_ID });
    await startWithNativeEraseRecovery(harness.dependencies);

    expect(harness.calls).toEqual(['status', 'fence', 'screen']);
    expect(harness.getScreen()?.autoStart).toBe(true);
    await expect(harness.getScreen()?.retry()).resolves.toMatchObject({
      ok: true,
      outcome: 'close-accepted',
      retryable: false,
    });
    expect(harness.calls).toEqual([
      'status',
      'fence',
      'screen',
      'prepare',
      'clear',
      'complete',
      'finish',
    ]);
    expect(harness.dependencies.continueNormalStartup).not.toHaveBeenCalled();
    expect(harness.gateway.prepare).toHaveBeenCalledOnce();
    expect(harness.gateway.prepare).toHaveBeenCalledWith(ERASE_ID);
    expect(harness.dependencies.finishClose).toHaveBeenCalledWith({
      kind: 'erase',
      eraseId: ERASE_ID,
    });
  });

  it('reruns prepare to finish a partial native-family deletion before renderer clear', async () => {
    const harness = setup({ state: 'pending', eraseId: ERASE_ID });
    let nativeFamily: 'partial' | 'removed' = 'partial';
    harness.gateway.prepare.mockImplementationOnce(async (eraseId) => {
      harness.calls.push('prepare');
      nativeFamily = 'removed';
      return { eraseId, nativeDataRemoved: true as const };
    });
    harness.dependencies.clearRendererData.mockImplementationOnce(async () => {
      harness.calls.push('clear');
      expect(nativeFamily).toBe('removed');
    });
    await startWithNativeEraseRecovery(harness.dependencies);

    await expect(harness.getScreen()?.retry()).resolves.toMatchObject({
      ok: true,
      outcome: 'close-accepted',
      retryable: false,
    });
    expect(harness.calls.slice(-4)).toEqual(['prepare', 'clear', 'complete', 'finish']);
  });

  it('never clears renderer data, completes, or closes after resumed prepare failure', async () => {
    const harness = setup({ state: 'pending', eraseId: ERASE_ID });
    harness.gateway.prepare.mockRejectedValueOnce(new Error('native deletion failed'));
    await startWithNativeEraseRecovery(harness.dependencies);

    await expect(harness.getScreen()?.retry()).resolves.toMatchObject({
      ok: false,
      outcome: 'retryable-failure',
      retryable: true,
    });
    expect(harness.dependencies.clearRendererData).not.toHaveBeenCalled();
    expect(harness.gateway.complete).not.toHaveBeenCalled();
    expect(harness.dependencies.finishClose).not.toHaveBeenCalled();
    expect(harness.dependencies.continueNormalStartup).not.toHaveBeenCalled();
  });

  it('never completes or closes after a renderer clear failure', async () => {
    const harness = setup({ state: 'pending', eraseId: ERASE_ID });
    harness.dependencies.clearRendererData.mockRejectedValueOnce(new Error('clear failed'));
    await startWithNativeEraseRecovery(harness.dependencies);

    await expect(harness.getScreen()?.retry()).resolves.toMatchObject({
      ok: false,
      outcome: 'retryable-failure',
      retryable: true,
    });
    expect(harness.gateway.complete).not.toHaveBeenCalled();
    expect(harness.dependencies.finishClose).not.toHaveBeenCalled();
    expect(harness.dependencies.continueNormalStartup).not.toHaveBeenCalled();
  });

  it('never closes when native completion fails', async () => {
    const harness = setup({ state: 'pending', eraseId: ERASE_ID });
    harness.gateway.complete.mockRejectedValueOnce(new Error('complete failed'));
    await startWithNativeEraseRecovery(harness.dependencies);

    await expect(harness.getScreen()?.retry()).resolves.toMatchObject({
      ok: false,
      outcome: 'retryable-failure',
      retryable: true,
    });
    expect(harness.dependencies.finishClose).not.toHaveBeenCalled();
  });

  it.each(['false', 'reject', 'timeout'] as const)(
    'makes a dispatched pending-recovery close %s terminal and non-retryable',
    async (outcome) => {
      const harness = setup({ state: 'pending', eraseId: ERASE_ID });
      harness.dependencies.finishClose =
        outcome === 'false'
          ? vi.fn(async () => false)
          : outcome === 'reject'
            ? vi.fn(async () => {
                throw new Error('response lost');
              })
            : vi.fn(() => new Promise<boolean>(() => undefined));
      await startWithNativeEraseRecovery({
        ...harness.dependencies,
        closeHandoffTimeoutMs: 5,
      });

      const first = await harness.getScreen()?.retry();
      expect(first).toMatchObject({
        ok: false,
        outcome: 'close-unknown',
        retryable: false,
        message: expect.stringContaining('ローカルデータは消去済み'),
      });
      const second = await harness.getScreen()?.retry();
      expect(second).toEqual(first);
      expect(harness.dependencies.finishClose).toHaveBeenCalledOnce();
      expect(harness.gateway.prepare).toHaveBeenCalledOnce();
      expect(harness.gateway.complete).toHaveBeenCalledOnce();
    },
  );

  it('does not claim data deletion when an idle recovery close response is unknown', async () => {
    const harness = setup({ state: 'idle' });
    harness.gateway.getStatus
      .mockRejectedValueOnce(new Error('initial status unavailable'))
      .mockResolvedValueOnce({ state: 'idle' });
    harness.dependencies.finishClose = vi.fn(async () => false);
    await startWithNativeEraseRecovery(harness.dependencies);

    const result = await harness.getScreen()?.retry();
    expect(result).toMatchObject({
      ok: false,
      outcome: 'close-unknown',
      retryable: false,
      message: expect.stringContaining('データ消去は実行していません'),
    });
    expect(result?.message).not.toContain('消去済み');
    expect(harness.dependencies.clearRendererData).not.toHaveBeenCalled();
    expect(harness.dependencies.finishClose).toHaveBeenCalledOnce();
  });

  it('status failure mounts retry-only recovery and never starts normally', async () => {
    const harness = setup({ state: 'idle' });
    harness.gateway.getStatus
      .mockImplementationOnce(async () => {
        harness.calls.push('status');
        throw new Error('malformed status');
      })
      .mockImplementationOnce(async () => {
        harness.calls.push('status');
        return { state: 'idle' };
      });
    await startWithNativeEraseRecovery(harness.dependencies);

    expect(harness.calls).toEqual(['status', 'fence', 'screen']);
    expect(harness.getScreen()?.autoStart).toBe(false);
    const result = await harness.getScreen()?.retry();
    expect(result).toEqual({
      ok: true,
      outcome: 'close-accepted',
      retryable: false,
      message:
        '消去待ちの状態がないことを確認しました。安全のためアプリを終了します。再起動してください。',
    });
    expect(harness.dependencies.continueNormalStartup).not.toHaveBeenCalled();
    expect(harness.dependencies.clearRendererData).not.toHaveBeenCalled();
    expect(harness.dependencies.finishClose).toHaveBeenCalledOnce();
    expect(harness.dependencies.finishClose).toHaveBeenCalledWith({
      kind: 'bootstrap',
    });
  });
});
