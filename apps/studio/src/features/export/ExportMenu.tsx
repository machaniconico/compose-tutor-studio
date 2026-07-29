import { useCallback, useRef, useState } from 'react';
import {
  DeferredFeature,
  type DeferredFeatureLoader,
} from '../common/DeferredFeature';
import { Dialog } from '../common/Dialog';

export type ExportOperation =
  | 'midi-export'
  | 'wav-export'
  | 'track-wav-export'
  | 'project-export'
  | 'project-import';

type ExportMenuContentProps = {
  onDone: () => void;
  activeOperation: ExportOperation | null;
  beginOperation: (operation: ExportOperation) => boolean;
  finishOperation: (operation: ExportOperation) => void;
};

const loadExportMenuContent: DeferredFeatureLoader<ExportMenuContentProps> = () =>
  import('./ExportMenuContent').then((module) => ({
    default: module.ExportMenuContent,
  }));

/** Lightweight trigger; file encoders and native file UI load on demand. */
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const operationRef = useRef<ExportOperation | null>(null);
  const [activeOperation, setActiveOperation] = useState<ExportOperation | null>(null);

  // This lock belongs to the always-mounted trigger rather than the deferred
  // dialog body. Closing with Escape/backdrop/X cannot erase an in-flight
  // native picker or WAV render and reopening cannot start a duplicate.
  const beginOperation = useCallback((operation: ExportOperation): boolean => {
    if (operationRef.current !== null) return false;
    operationRef.current = operation;
    setActiveOperation(operation);
    return true;
  }, []);

  const finishOperation = useCallback((operation: ExportOperation): void => {
    if (operationRef.current !== operation) return;
    operationRef.current = null;
    setActiveOperation(null);
  }, []);

  const preload = (): void => {
    void loadExportMenuContent().catch(() => undefined);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        onFocus={preload}
        onPointerEnter={preload}
      >
        書き出し
      </button>

      {open ? (
        <Dialog title="書き出し / 読み込み" onClose={() => setOpen(false)}>
          <DeferredFeature
            load={loadExportMenuContent}
            componentProps={{
              onDone: () => setOpen(false),
              activeOperation,
              beginOperation,
              finishOperation,
            }}
            loadingLabel="書き出しメニューを読み込んでいます…"
            errorLabel="書き出しメニューを読み込めませんでした。アプリを再読み込んでください。"
          />
        </Dialog>
      ) : null}
    </>
  );
}
