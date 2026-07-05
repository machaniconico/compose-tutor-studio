import { describe, expect, it } from 'vitest';
import { ErrorBoundary } from '../src/features/common/ErrorBoundary';
import { DIAGNOSTIC_LOG_KEY } from '../src/platform/diagnostics';
import { installLocalStorage } from './localStorageStub';

function patchSetState(component: ErrorBoundary): void {
  component.setState = ((update: unknown): void => {
    const next = typeof update === 'function' ? update(component.state, component.props) : update;
    component.state = { ...component.state, ...(next as Partial<typeof component.state>) };
  }) as typeof component.setState;
}

describe('ErrorBoundary', () => {
  it('shows a manual diagnostic report when clipboard copy fails', async () => {
    const storage = installLocalStorage();
    storage.setItem(
      DIAGNOSTIC_LOG_KEY,
      JSON.stringify([
        {
          id: 'diag_error_boundary_copy',
          kind: 'render-error',
          message: 'Render failed at C:\\Users\\tester\\broken.ctsproj.json',
          stack: null,
          componentStack: null,
          occurredAt: '2026-06-23T00:03:00.000Z',
          userAgent: 'vitest-agent',
        },
      ]),
    );
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (): Promise<void> => {
            throw new Error('NotAllowedError');
          },
        },
      },
    });

    const component = new ErrorBoundary({ children: null });
    patchSetState(component);
    component.state = {
      entry: {
        id: 'diag_error_boundary_copy',
        kind: 'render-error',
        message: 'Render failed at [local-path]',
        stack: null,
        componentStack: null,
        occurredAt: '2026-06-23T00:03:00.000Z',
        userAgent: 'vitest-agent',
      },
      copied: false,
      cleared: false,
      manualReport: null,
    };

    await (component as unknown as { copyReport: () => Promise<void> }).copyReport();

    expect(component.state.copied).toBe(false);
    expect(component.state.manualReport).toContain('id: diag_error_boundary_copy');
    expect(component.state.manualReport).toContain('[local-path]');
    expect(component.state.manualReport).not.toContain('C:\\Users\\tester');
    expect(JSON.stringify(component.render())).toContain('手動コピー用診断情報');
  });
});
