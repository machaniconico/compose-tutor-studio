import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './features/common/ErrorBoundary';
import { installGlobalDiagnostics } from './platform/diagnostics';
import { installProjectSaveGuards } from './state/projectSaveGuard';
import './styles.css';

installGlobalDiagnostics();
installProjectSaveGuards();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
