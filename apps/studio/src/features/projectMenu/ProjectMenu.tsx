import { useState } from 'react';
import {
  DeferredFeature,
  type DeferredFeatureLoader,
} from '../common/DeferredFeature';
import { Dialog } from '../common/Dialog';

type ProjectMenuContentProps = {
  onDone: () => void;
  onMidiImportBusyChange?: (busy: boolean) => void;
};

const loadProjectMenuContent: DeferredFeatureLoader<ProjectMenuContentProps> = () =>
  import('./ProjectMenuContent').then((module) => ({
    default: module.ProjectMenuContent,
  }));

/** Lightweight trigger; project management code is fetched only when opened. */
export function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const [midiImportBusy, setMidiImportBusy] = useState(false);

  const preload = (): void => {
    void loadProjectMenuContent().catch(() => undefined);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        onFocus={preload}
        onPointerEnter={preload}
        title="プロジェクトメニュー"
      >
        ☰ プロジェクト
      </button>

      {open ? (
        <Dialog
          title="プロジェクト"
          onClose={() => setOpen(false)}
          className="dialog--wide"
          closeDisabled={midiImportBusy}
        >
          <fieldset
            className="project-menu__operation-lock"
            disabled={midiImportBusy}
          >
            <legend className="visually-hidden">プロジェクト操作</legend>
            <DeferredFeature
              load={loadProjectMenuContent}
              componentProps={{
                onDone: () => setOpen(false),
                onMidiImportBusyChange: setMidiImportBusy,
              }}
              loadingLabel="プロジェクトメニューを読み込んでいます…"
              errorLabel="プロジェクトメニューを読み込めませんでした。アプリを再読み込んでください。"
            />
          </fieldset>
        </Dialog>
      ) : null}
    </>
  );
}
