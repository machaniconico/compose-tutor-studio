import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_NATIVE_CLOSE_REQUEST_COMMAND,
  FINISH_NATIVE_CLOSE_COMMAND,
  NativeAppLifecycleGateway,
} from '../src/platform/nativeAppLifecycle';

describe('NativeAppLifecycleGateway', () => {
  it('accepts only the exact Rust-issued close request receipt', async () => {
    const accepted = vi.fn(async () => ({ requestId: 'close-0000000000000001' }));
    await expect(
      new NativeAppLifecycleGateway(accepted).claimCloseRequest(),
    ).resolves.toBe('close-0000000000000001');
    expect(accepted).toHaveBeenCalledWith(
      CLAIM_NATIVE_CLOSE_REQUEST_COMMAND,
    );

    for (const invalid of [
      null,
      { requestId: 'close-1' },
      { requestId: 'close-0000000000000001', extra: true },
      { requestId: 1 },
    ]) {
      await expect(
        new NativeAppLifecycleGateway(vi.fn(async () => invalid)).claimCloseRequest(),
      ).resolves.toBeNull();
    }
  });

  it('accepts only the exact void response from the narrow close command', async () => {
    const accepted = vi.fn(async () => null);
    const authorization = {
      kind: 'normal' as const,
      requestId: 'close-0000000000000001',
    };
    await expect(
      new NativeAppLifecycleGateway(accepted).finishClose(authorization),
    ).resolves.toBe(true);
    expect(accepted).toHaveBeenCalledWith(FINISH_NATIVE_CLOSE_COMMAND, {
      request: authorization,
    });

    await expect(
      new NativeAppLifecycleGateway(
        vi.fn(async () => ({ closed: true })),
      ).finishClose(authorization),
    ).resolves.toBe(false);
    await expect(
      new NativeAppLifecycleGateway(
        vi.fn(async () => {
          throw new Error('denied');
        }),
      ).finishClose(authorization),
    ).resolves.toBe(false);
  });
});
