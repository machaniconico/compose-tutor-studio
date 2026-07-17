import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import {
  initializeStudioStore,
  useStore,
} from './state/store';
import { registerNativeCloseGuard } from './platform/nativeCloseGuard';
import { nativeAppLifecycleGateway } from './platform/nativeAppLifecycle';
import { studioRuntime } from './platform/runtime';
import {
  clearRendererStorageAndBrowsingData,
  nativeLocalDataEraseGateway,
  startWithNativeEraseRecovery,
} from './platform/nativeLocalDataErase';
import { LocalDataEraseRecoveryScreen } from './platform/LocalDataEraseRecoveryScreen';
import { AppErrorBoundary } from './platform/AppErrorBoundary';
import { FatalRecoveryScreen } from './platform/FatalRecoveryScreen';
import {
  registerGlobalRuntimeDiagnostics,
  tryRecordRuntimeDiagnostic,
} from './platform/runtimeDiagnostics';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}
const rootContainer = rootEl;
const root = createRoot(rootContainer);

function renderApp(): void {
  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>,
  );
}

async function continueNormalStartup(): Promise<void> {
  if (studioRuntime.kind === 'native') {
    try {
      await registerNativeCloseGuard({
        isEraseInProgress: () => useStore.getState().localDataErase.phase !== 'idle',
        tryFenceEdits: () => useStore.getState().tryBeginNativeClose(),
        releaseEditFence: () => useStore.getState().cancelNativeClose(),
        claimCloseRequest: () => nativeAppLifecycleGateway.claimCloseRequest(),
        flushAsync: () => useStore.getState().flushPendingSave(),
        flushSynchronously: () => useStore.getState().flushPendingSaveSynchronously(),
        finishClose: (requestId) =>
          nativeAppLifecycleGateway.finishClose({ kind: 'normal', requestId }),
        onBlocked: (stage) => {
          if (
            stage === 'edit-fence'
            && useStore.getState().audioRecordingOperationId !== null
          ) {
            // tryBeginNativeClose already published the recording-specific
            // recovery action. Do not replace it with a generic save warning.
            return;
          }
          if (stage === 'window-close') {
            useStore.getState().markNativeCloseHandoffUnknown();
            const message =
              useStore.getState().localDataErase.message ??
              '終了要求の応答を確認できませんでした。OSからアプリを終了してください。';
            useStore.setState({
              persistenceNotice: { kind: 'warning', message },
            });
            return;
          }
          useStore.setState({
            persistenceNotice: {
              kind: 'warning',
              message:
                '保存または終了処理を完了できなかったため、画面を閉じませんでした。内容を書き出してから再度お試しください。',
            },
          });
        },
      });
    } catch (error) {
      // Without interception, the OS can destroy the WebView before its async
      // save finishes. Never expose an editable native UI in that state.
      tryRecordRuntimeDiagnostic({ stage: 'close-guard', error, runtime: 'native' });
      throw error;
    }
  }
  try {
    // Do not expose an editable placeholder while an async desktop repository
    // is still restoring/migrating the user's real project.
    await initializeStudioStore();
  } catch (error) {
    // Expected repository failures are represented in store state. This guard
    // keeps an unforeseen bootstrap failure from leaving a permanently blank UI.
    tryRecordRuntimeDiagnostic({
      stage: 'bootstrap-recovered',
      error,
      runtime: studioRuntime.kind,
    });
    if (!useStore.getState().persistenceNotice) {
      useStore.setState({
        persistenceNotice: {
          kind: 'warning',
          message:
            '保存状態の読み込み中に問題が発生しました。保存のお知らせを確認し、書き出しを行ってから編集してください。',
        },
      });
    }
  }
  renderApp();
}

async function start(): Promise<void> {
  if (studioRuntime.kind !== 'native') {
    await continueNormalStartup();
    return;
  }

  await startWithNativeEraseRecovery({
    gateway: nativeLocalDataEraseGateway,
    clearRendererData: clearRendererStorageAndBrowsingData,
    finishClose: (authorization) =>
      nativeAppLifecycleGateway.finishClose(authorization),
    showRecovery: (request) => {
      root.render(
        <StrictMode>
          <LocalDataEraseRecoveryScreen {...request} />
        </StrictMode>,
      );
    },
    continueNormalStartup,
  });
}

registerGlobalRuntimeDiagnostics();
void start().catch((error: unknown) => {
  tryRecordRuntimeDiagnostic({ stage: 'startup', error, runtime: studioRuntime.kind });
  root.render(
    <StrictMode>
      <FatalRecoveryScreen reason="startup" />
    </StrictMode>,
  );
});
