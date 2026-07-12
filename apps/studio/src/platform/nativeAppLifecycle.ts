import { invoke as invokeTauriCommand } from '@tauri-apps/api/core';

export const CLAIM_NATIVE_CLOSE_REQUEST_COMMAND = 'app_claim_close_request';
export const FINISH_NATIVE_CLOSE_COMMAND = 'app_finish_close';

export type NativeCloseAuthorization =
  | Readonly<{ kind: 'normal'; requestId: string }>
  | Readonly<{ kind: 'erase'; eraseId: string }>
  | Readonly<{ kind: 'bootstrap' }>;

export type NativeAppLifecycleInvoke = (
  command:
    | typeof CLAIM_NATIVE_CLOSE_REQUEST_COMMAND
    | typeof FINISH_NATIVE_CLOSE_COMMAND,
  args?: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

const CLOSE_REQUEST_ID = /^close-[0-9a-f]{16}$/;

function decodeClaimedRequest(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('requestId' in value) ||
    typeof value.requestId !== 'string' ||
    !CLOSE_REQUEST_ID.test(value.requestId)
  ) {
    return null;
  }
  return value.requestId;
}

export class NativeAppLifecycleGateway {
  constructor(
    private readonly invoke: NativeAppLifecycleInvoke = (command, args) =>
      invokeTauriCommand<unknown>(command, args),
  ) {}

  /** Returns an id only after Rust observed a real main-window close event. */
  async claimCloseRequest(): Promise<string | null> {
    try {
      return decodeClaimedRequest(
        await this.invoke(CLAIM_NATIVE_CLOSE_REQUEST_COMMAND),
      );
    } catch {
      return null;
    }
  }

  /** True only when Rust accepted exact authorization and owns final shutdown. */
  async finishClose(authorization: NativeCloseAuthorization): Promise<boolean> {
    try {
      return (
        (await this.invoke(FINISH_NATIVE_CLOSE_COMMAND, {
          request: authorization,
        })) === null
      );
    } catch {
      return false;
    }
  }
}

export const nativeAppLifecycleGateway = new NativeAppLifecycleGateway();
