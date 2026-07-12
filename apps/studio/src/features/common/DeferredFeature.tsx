import {
  Component,
  Suspense,
  lazy,
  useMemo,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { tryRecordRuntimeDiagnostic } from '../../platform/runtimeDiagnostics';

type DeferredModule<Props extends object> = {
  default: ComponentType<Props>;
};

export type DeferredFeatureLoader<Props extends object> = () => Promise<
  DeferredModule<Props>
>;

type DeferredFeatureProps<Props extends object> = {
  load: DeferredFeatureLoader<Props>;
  componentProps: Props;
  loadingLabel: string;
  errorLabel: string;
  reloadLabel?: string;
};

type BoundaryProps = {
  children: ReactNode;
  errorLabel: string;
  reloadLabel: string;
  onReload: () => void;
};

type BoundaryState = { failed: boolean };

class DeferredFeatureErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    // React reports the original error in development. The user-facing copy is
    // intentionally stable and does not expose local paths or implementation details.
    tryRecordRuntimeDiagnostic({ stage: 'deferred-feature', error });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="deferred-feature-status" role="alert">
        <p>{this.props.errorLabel}</p>
        <button type="button" onClick={this.props.onReload}>
          {this.props.reloadLabel}
        </button>
      </div>
    );
  }
}

/**
 * React.lazy boundary for features that are not part of first paint.
 * The loader must be a module-level function so normal renders keep component state.
 * A failed native import can remain cached by the browser, so recovery uses a
 * full reload instead of presenting a retry action that may never refetch.
 */
export function DeferredFeature<Props extends object>({
  load,
  componentProps,
  loadingLabel,
  errorLabel,
  reloadLabel = 'アプリを再読み込み',
}: DeferredFeatureProps<Props>) {
  const LazyComponent = useMemo(() => lazy(load), [load]);

  return (
    <DeferredFeatureErrorBoundary
      errorLabel={errorLabel}
      reloadLabel={reloadLabel}
      onReload={() => window.location.reload()}
    >
      <Suspense
        fallback={
          <div className="deferred-feature-status" role="status" aria-live="polite">
            <p>{loadingLabel}</p>
          </div>
        }
      >
        <LazyComponent {...componentProps} />
      </Suspense>
    </DeferredFeatureErrorBoundary>
  );
}
