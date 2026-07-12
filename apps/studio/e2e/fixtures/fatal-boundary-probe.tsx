import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from '../../src/platform/AppErrorBoundary';
import { FatalRecoveryScreen } from '../../src/platform/FatalRecoveryScreen';
import { __resetRuntimeDiagnosticsForTest } from '../../src/platform/runtimeDiagnostics';
import '../../src/styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('fixture root missing');

const search = new URLSearchParams(window.location.search);
const copyMode = search.get('copy');
const formatterMode = search.get('formatter');

function ThrowingChild(): never {
  throw new Error('秘密の曲 /Users/example/private-song.ctsproj.json');
}

function CopyStateProbe() {
  return (
    <FatalRecoveryScreen
      reason="startup"
      onReload={() => undefined}
      copyReport={
        copyMode === 'unavailable'
          ? async () => 'unavailable'
          : () => {
              throw new Error('clipboard implementation failed');
            }
      }
    />
  );
}

__resetRuntimeDiagnosticsForTest();
if (formatterMode === 'failed') {
  JSON.stringify = () => {
    throw new Error('formatter implementation failed');
  };
}
createRoot(rootElement).render(
  <StrictMode>
    {copyMode ? (
      <CopyStateProbe />
    ) : (
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>
    )}
  </StrictMode>,
);
