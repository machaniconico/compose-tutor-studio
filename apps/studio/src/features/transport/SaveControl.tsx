import {
  formatSavedTime,
  getSaveStatusPresentation,
  type SaveStatusState,
} from './saveStatus';

type SaveControlProps = {
  state: SaveStatusState;
  onSave: () => unknown;
  onEmergencyExport: () => unknown;
  emergencyExportBusy?: boolean;
};

/** Accessible, result-driven save control shared by manual and automatic save state. */
export function SaveControl({
  state,
  onSave,
  onEmergencyExport,
  emergencyExportBusy = false,
}: SaveControlProps) {
  const status = getSaveStatusPresentation(state);
  const savedTime = formatSavedTime(status.savedAt);

  return (
    <div className="transport-bar__save">
      <button
        type="button"
        className={
          status.tone === 'error'
            ? 'transport-bar__save-button transport-bar__save-button--retry'
            : 'transport-bar__save-button'
        }
        aria-describedby="project-save-status"
        disabled={!status.canRetry}
        onClick={() => void onSave()}
      >
        {status.buttonLabel}
      </button>

      <span
        id="project-save-status"
        className={`save-indicator save-indicator--${status.tone}`}
        role={status.role}
        aria-live={status.ariaLive}
        aria-atomic="true"
      >
        {status.label}
        {savedTime && status.savedAt ? (
          <>
            {' '}
            <time dateTime={status.savedAt}>{savedTime}</time>
          </>
        ) : null}
      </span>
      {state.phase === 'error' ? (
        <button
          type="button"
          className="transport-bar__emergency-export"
          aria-describedby="project-save-status"
          aria-busy={emergencyExportBusy || undefined}
          disabled={emergencyExportBusy}
          onClick={() => void onEmergencyExport()}
        >
          {emergencyExportBusy ? 'バックアップを書き出し中…' : 'バックアップを書き出す'}
        </button>
      ) : null}
    </div>
  );
}
