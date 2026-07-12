import { tauriBridge, PERSISTENCE_COMMANDS, type TauriBridge } from './tauriBridge';
import { fenceRendererStorageWrites } from './rendererStorageFence';
import { settleNativeCloseHandoff } from './nativeCloseHandoff';
import type { NativeCloseAuthorization } from './nativeAppLifecycle';

export const ERASE_ID_PATTERN =
  /^erase-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type NativeEraseAllStatus =
  | Readonly<{ state: 'idle' }>
  | Readonly<{ state: 'pending'; eraseId: string }>;

export type NativeEraseAllPrepared = Readonly<{
  eraseId: string;
  nativeDataRemoved: true;
}>;

export type NativeLocalDataEraseGateway = Readonly<{
  getStatus: () => Promise<NativeEraseAllStatus>;
  prepare: (eraseId: string) => Promise<NativeEraseAllPrepared>;
  complete: (eraseId: string) => Promise<void>;
}>;

type SecureEraseCrypto = Readonly<{
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isEraseId(value: unknown): value is string {
  return typeof value === 'string' && ERASE_ID_PATTERN.test(value);
}

function decodeStatus(value: unknown): NativeEraseAllStatus {
  if (!isRecord(value) || typeof value.state !== 'string') {
    throw new Error('Invalid erase-all status response');
  }
  if (value.state === 'idle' && hasExactKeys(value, ['state'])) {
    return { state: 'idle' };
  }
  if (
    value.state === 'pending' &&
    hasExactKeys(value, ['state', 'eraseId']) &&
    isEraseId(value.eraseId)
  ) {
    return { state: 'pending', eraseId: value.eraseId };
  }
  throw new Error('Invalid erase-all status response');
}

function decodePrepared(value: unknown, eraseId: string): NativeEraseAllPrepared {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['eraseId', 'nativeDataRemoved']) ||
    value.eraseId !== eraseId ||
    value.nativeDataRemoved !== true
  ) {
    throw new Error('Invalid erase-all prepare response');
  }
  return { eraseId, nativeDataRemoved: true };
}

export class TauriNativeLocalDataEraseGateway implements NativeLocalDataEraseGateway {
  constructor(private readonly bridge: TauriBridge = tauriBridge) {}

  async getStatus(): Promise<NativeEraseAllStatus> {
    return decodeStatus(await this.bridge.invoke(PERSISTENCE_COMMANDS.eraseAllStatus));
  }

  async prepare(eraseId: string): Promise<NativeEraseAllPrepared> {
    if (!isEraseId(eraseId)) throw new Error('Invalid erase-all request id');
    const value = await this.bridge.invoke(PERSISTENCE_COMMANDS.prepareEraseAll, {
      request: { eraseId },
    });
    return decodePrepared(value, eraseId);
  }

  async complete(eraseId: string): Promise<void> {
    if (!isEraseId(eraseId)) throw new Error('Invalid erase-all request id');
    const value = await this.bridge.invoke(PERSISTENCE_COMMANDS.completeEraseAll, {
      request: { eraseId },
    });
    if (value !== null) throw new Error('Invalid erase-all completion response');
  }
}

export const nativeLocalDataEraseGateway = new TauriNativeLocalDataEraseGateway();

function formatUuidV4(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Creates the native command's canonical opaque id without weak randomness. */
export function createSecureEraseId(
  source: SecureEraseCrypto | null | undefined =
    typeof globalThis.crypto === 'undefined'
      ? undefined
      : (globalThis.crypto as SecureEraseCrypto),
): string | null {
  let randomUuid: string | null = null;
  try {
    const value: unknown = source?.randomUUID?.();
    if (typeof value === 'string') randomUuid = value.toLowerCase();
  } catch {
    // Some WebViews expose randomUUID but deny it in a restricted context.
  }
  if (randomUuid && isEraseId(`erase-${randomUuid}`)) return `erase-${randomUuid}`;

  try {
    if (!source?.getRandomValues) return null;
    const bytes = source.getRandomValues(new Uint8Array(16));
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) return null;
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const eraseId = `erase-${formatUuidV4(bytes)}`;
    return isEraseId(eraseId) ? eraseId : null;
  } catch {
    return null;
  }
}

export type RendererStorageArea = Readonly<{
  clear: () => void;
  readonly length: number;
}>;

export type RendererDataEraseDependencies = Readonly<{
  localStorage?: RendererStorageArea;
  sessionStorage?: RendererStorageArea;
  clearBrowsingData?: () => Promise<void>;
}>;

async function clearCurrentWebviewBrowsingData(): Promise<void> {
  // Keep the comparatively large WebView API out of the normal startup chunk.
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().clearAllBrowsingData();
}

function requiredStorage(
  provided: RendererStorageArea | undefined,
  globalName: 'localStorage' | 'sessionStorage',
): RendererStorageArea {
  if (provided) return provided;
  const value = globalThis[globalName];
  if (!value) throw new Error(`${globalName} is unavailable`);
  return value;
}

/**
 * Clears both JS storage areas, clears the current WebView data, then clears
 * both areas again and proves they stayed empty before native completion.
 */
export async function clearRendererStorageAndBrowsingData(
  dependencies: RendererDataEraseDependencies = {},
): Promise<void> {
  const local = requiredStorage(dependencies.localStorage, 'localStorage');
  const session = requiredStorage(dependencies.sessionStorage, 'sessionStorage');
  const clearBrowsingData = dependencies.clearBrowsingData ?? clearCurrentWebviewBrowsingData;

  local.clear();
  session.clear();
  await clearBrowsingData();
  // WebKit may replace its Storage objects while browsing data is cleared, so
  // resolve the globals again instead of trusting the pre-clear references.
  const localAfterBrowsingClear = requiredStorage(
    dependencies.localStorage,
    'localStorage',
  );
  const sessionAfterBrowsingClear = requiredStorage(
    dependencies.sessionStorage,
    'sessionStorage',
  );
  localAfterBrowsingClear.clear();
  sessionAfterBrowsingClear.clear();
  if (
    localAfterBrowsingClear.length !== 0 ||
    sessionAfterBrowsingClear.length !== 0
  ) {
    throw new Error('Renderer storage was recreated during erase');
  }
}

export type NativeEraseRecoveryAttempt =
  | Readonly<{
      ok: true;
      outcome: 'close-accepted';
      retryable: false;
      message: string;
    }>
  | Readonly<{
      ok: false;
      outcome: 'retryable-failure';
      retryable: true;
      message: string;
    }>
  | Readonly<{
      ok: false;
      outcome: 'close-unknown';
      retryable: false;
      message: string;
    }>;

export type NativeEraseRecoveryScreenRequest = Readonly<{
  autoStart: boolean;
  initialMessage: string;
  retry: () => Promise<NativeEraseRecoveryAttempt>;
}>;

export type NativeEraseStartupDependencies = Readonly<{
  gateway: NativeLocalDataEraseGateway;
  clearRendererData: () => Promise<void>;
  finishClose: (
    authorization: NativeCloseAuthorization,
  ) => Promise<boolean> | boolean;
  closeHandoffTimeoutMs?: number;
  showRecovery: (request: NativeEraseRecoveryScreenRequest) => void;
  continueNormalStartup: () => Promise<void> | void;
  fenceWrites?: () => void;
}>;

function recoveryFailureMessage(): string {
  return 'ローカルデータの消去を完了できませんでした。アプリを閉じず、「消去を再試行」を選んでください。';
}

function recoveryCloseUnknownMessage(dataErased: boolean): string {
  return dataErased
    ? 'ローカルデータは消去済みです。終了要求の応答を確認できませんでした。画面内の再試行や閉じる操作を繰り返さず、しばらく待っても終了しない場合はOSからアプリを終了してください。'
    : '消去待ちの状態は確認されず、データ消去は実行していません。終了要求の応答を確認できませんでした。画面内の再試行や閉じる操作を繰り返さず、しばらく待っても終了しない場合はOSからアプリを終了してください。';
}

/**
 * Native composition-root gate. Status is resolved before normal close guards,
 * repository initialization, migration, or App mounting can run.
 */
export async function startWithNativeEraseRecovery(
  dependencies: NativeEraseStartupDependencies,
): Promise<void> {
  let initialStatus: NativeEraseAllStatus | null = null;
  let statusFailed = false;
  try {
    initialStatus = await dependencies.gateway.getStatus();
  } catch {
    statusFailed = true;
  }

  if (initialStatus?.state === 'idle') {
    await dependencies.continueNormalStartup();
    return;
  }

  (dependencies.fenceWrites ?? fenceRendererStorageWrites)();
  let firstStatus = initialStatus;
  let observedPending = initialStatus?.state === 'pending';
  let attemptInFlight: Promise<NativeEraseRecoveryAttempt> | null = null;
  let terminalAttempt: NativeEraseRecoveryAttempt | null = null;
  const retry = (): Promise<NativeEraseRecoveryAttempt> => {
    if (terminalAttempt) return Promise.resolve(terminalAttempt);
    if (attemptInFlight) return attemptInFlight;
    attemptInFlight = (async () => {
      let completedEraseId: string | null = null;
      try {
        const status = firstStatus ?? (await dependencies.gateway.getStatus());
        firstStatus = null;
        if (status.state === 'pending') {
          observedPending = true;
          // The marker is committed before native family deletion begins.
          // Re-run the idempotent prepare with the same id so a crash between
          // those steps cannot advance to completion with native bytes intact.
          await dependencies.gateway.prepare(status.eraseId);
          await dependencies.clearRendererData();
          await dependencies.gateway.complete(status.eraseId);
          completedEraseId = status.eraseId;
        }
      } catch {
        firstStatus = null;
        return {
          ok: false,
          outcome: 'retryable-failure',
          retryable: true,
          message: recoveryFailureMessage(),
        } as const;
      }

      const closeOutcome = await settleNativeCloseHandoff(
        () =>
          dependencies.finishClose(
            completedEraseId
              ? { kind: 'erase', eraseId: completedEraseId }
              : { kind: 'bootstrap' },
          ),
        dependencies.closeHandoffTimeoutMs,
      );
      if (closeOutcome === 'accepted') {
        return {
          ok: true,
          outcome: 'close-accepted',
          retryable: false,
          message: observedPending
            ? 'ローカルデータを消去しました。アプリを終了します。'
            : '消去待ちの状態がないことを確認しました。安全のためアプリを終了します。再起動してください。',
        } as const;
      }
      return {
        ok: false,
        outcome: 'close-unknown',
        retryable: false,
        message: recoveryCloseUnknownMessage(observedPending),
      } as const;
    })()
      .then((attempt) => {
        if (!attempt.retryable) terminalAttempt = attempt;
        return attempt;
      })
      .finally(() => {
        attemptInFlight = null;
      });
    return attemptInFlight;
  };

  dependencies.showRecovery({
    autoStart: initialStatus?.state === 'pending',
    initialMessage: statusFailed
      ? '消去状態を安全に確認できませんでした。通常起動は停止しています。'
      : '前回のローカルデータ消去を安全に完了しています。',
    retry,
  });
}
