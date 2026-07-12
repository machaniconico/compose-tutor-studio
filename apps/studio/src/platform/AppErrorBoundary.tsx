import { Component, type ErrorInfo, type ReactNode } from 'react';
import { FatalRecoveryScreen } from './FatalRecoveryScreen';
import { tryRecordRuntimeDiagnostic } from './runtimeDiagnostics';

type AppErrorBoundaryProps = Readonly<{ children: ReactNode }>;
type AppErrorBoundaryState = Readonly<{ failed: boolean; recorded: boolean }>;

/** Last-resort containment for errors outside the feature-level boundaries. */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = { failed: false, recorded: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true, recorded: false };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    tryRecordRuntimeDiagnostic({ stage: 'render', error });
    this.setState({ failed: true, recorded: true });
  }

  override render(): ReactNode {
    if (this.state.failed) {
      // The key refreshes the sanitized report after componentDidCatch records
      // its event; it never re-enters the failed application tree.
      return (
        <FatalRecoveryScreen
          key={this.state.recorded ? 'recorded' : 'pending'}
          reason="render"
        />
      );
    }
    return this.props.children;
  }
}
