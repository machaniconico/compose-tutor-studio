import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from '../src/platform/AppErrorBoundary';
import { FatalRecoveryScreen } from '../src/platform/FatalRecoveryScreen';
import {
  __resetRuntimeDiagnosticsForTest,
  formatRuntimeDiagnosticReport,
} from '../src/platform/runtimeDiagnostics';

beforeEach(() => {
  __resetRuntimeDiagnosticsForTest();
});

describe('AppErrorBoundary', () => {
  it('keeps the healthy app tree and swaps a failed tree for recovery UI', () => {
    const child = <span>editor</span>;
    const boundary = new AppErrorBoundary({ children: child });
    expect(boundary.render()).toBe(child);

    boundary.state = AppErrorBoundary.getDerivedStateFromError();
    const fallback = boundary.render();
    expect(isValidElement(fallback)).toBe(true);
    if (!isValidElement(fallback)) throw new Error('expected React element');
    expect(fallback.type).toBe(FatalRecoveryScreen);
    expect(fallback.props).toMatchObject({ reason: 'render' });
  });

  it('records a sanitized diagnostic when React reports the failure', () => {
    const boundary = new AppErrorBoundary({ children: null });
    boundary.setState = vi.fn();
    boundary.componentDidCatch(
      new Error('秘密の曲 /Users/example/private.ctsproj.json'),
      { componentStack: '\n at PrivateProject' },
    );

    const report = formatRuntimeDiagnosticReport();
    expect(report).toContain('"stage": "render"');
    expect(report).not.toContain('秘密の曲');
    expect(report).not.toContain('/Users/example/private.ctsproj.json');
    expect(boundary.setState).toHaveBeenCalledWith({ failed: true, recorded: true });
  });
});
