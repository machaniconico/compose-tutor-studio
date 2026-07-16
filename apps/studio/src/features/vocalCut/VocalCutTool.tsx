import { useCallback, useState } from 'react';
import {
  DeferredFeature,
  type DeferredFeatureLoader,
} from '../common/DeferredFeature';
import { Dialog } from '../common/Dialog';
import { useStore } from '../../state/store';

export type VocalCutToolContentProps = {
  onBusyChange: (busy: boolean) => void;
};

const loadVocalCutToolContent: DeferredFeatureLoader<VocalCutToolContentProps> = () =>
  import('./VocalCutToolContent').then((module) => ({
    default: module.VocalCutToolContent,
  }));

/** Always-mounted trigger owning the modal lock while its deferred tool runs. */
export function VocalCutTool() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const openTool = useCallback(() => {
    const state = useStore.getState();
    if (state.transport.phase !== 'stopped') state.stop();
    setOpen(true);
  }, []);

  const preload = (): void => {
    void loadVocalCutToolContent().catch(() => undefined);
  };

  return (
    <>
      <button
        type="button"
        aria-label="カラオケ用音源を作る"
        onClick={openTool}
        onFocus={preload}
        onPointerEnter={preload}
      >
        カラオケ
      </button>

      {open ? (
        <Dialog
          title="カラオケ作成（ボーカルカット）"
          className="dialog--wide dialog--vocal-cut"
          onClose={() => setOpen(false)}
          closeDisabled={busy}
          busy={busy}
        >
          <DeferredFeature
            load={loadVocalCutToolContent}
            componentProps={{ onBusyChange: setBusy }}
            loadingLabel="カラオケ作成ツールを読み込んでいます…"
            errorLabel="カラオケ作成ツールを読み込めませんでした。アプリを再読み込みしてください。"
          />
        </Dialog>
      ) : null}
    </>
  );
}
