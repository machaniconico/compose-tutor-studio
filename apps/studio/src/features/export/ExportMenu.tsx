import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  DeferredFeature,
  type DeferredFeatureLoader,
} from '../common/DeferredFeature';
import { Dialog } from '../common/Dialog';
import type { ExportMenuContentProps } from './ExportMenuContent';
import type { Wave5ConversionOffer } from './wave5Import';

export type ExportOperation =
  | 'midi-export'
  | 'wav-export'
  | 'track-wav-export'
  | 'stem-zip-export'
  | 'project-export'
  | 'project-import'
  | 'portable-project-export'
  | 'portable-project-import';

const loadExportMenuContent: DeferredFeatureLoader<ExportMenuContentProps> = () =>
  import('./ExportMenuContent').then((module) => ({
    default: module.ExportMenuContent,
  }));

/** Lightweight trigger; file encoders and native file UI load on demand. */
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [conversionOffer, setConversionOffer] = useState<Wave5ConversionOffer | null>(null);
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

  const closeMenu = useCallback((): void => {
    if (operationRef.current === null) setOpen(false);
  }, []);

  const preload = (): void => {
    void loadExportMenuContent().catch(() => undefined);
  };

  const renderMenu = (content: ReactNode) => (
    <Dialog
      title="書き出し / 読み込み"
      onClose={closeMenu}
      closeDisabled={activeOperation !== null}
    >
      {content}
    </Dialog>
  );

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
        <DeferredFeature
          load={loadExportMenuContent}
          componentProps={{
            onDone: () => setOpen(false),
            activeOperation,
            beginOperation,
            finishOperation,
            renderMenu,
            conversionOffer,
            setConversionOffer,
          }}
          wrapFallback={renderMenu}
          loadingLabel="書き出しメニューを読み込んでいます…"
          errorLabel="書き出しメニューを読み込めませんでした。アプリを再読み込みしてください。"
        />
      ) : null}
    </>
  );
}
