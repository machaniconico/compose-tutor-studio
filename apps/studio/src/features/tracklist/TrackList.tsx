import { useState } from 'react';
import { useStore } from '../../state/store';
import { AddTrackDialog } from './AddTrackDialog';
import { audioTrackAssetSummary } from '../audioTrack/audioAssetPresentation';
import {
  TRACK_ADD_CONTROL_ID,
  TRACK_TYPE_BADGE,
  TRACK_TYPE_LABEL,
  accessibleTrackName,
  focusTrackSelectionControl,
  trackSelectionControlId,
} from './trackPresentation';

/** Left column listing tracks with volume plus sound-track mute/solo controls. */
export function TrackList() {
  const [addOpen, setAddOpen] = useState(false);
  const tracks = useStore((s) => s.project.tracks);
  const audioAssets = useStore((s) => s.project.audioAssets);
  const audioAssetIssues = useStore((s) => s.audioAssetIssues);
  const selectedTrackId = useStore((s) => s.editor.selectedTrackId);
  const selectTrack = useStore((s) => s.selectTrack);
  const selectClip = useStore((s) => s.selectClip);
  const setTrackVolume = useStore((s) => s.setTrackVolume);
  const toggleMute = useStore((s) => s.toggleMute);
  const toggleSolo = useStore((s) => s.toggleSolo);

  return (
    <nav className="track-list" aria-label="トラック一覧">
      <header className="track-list__header">
        <h2>トラック</h2>
        <button
          id={TRACK_ADD_CONTROL_ID}
          type="button"
          className="track-list__add"
          onClick={() => setAddOpen(true)}
        >
          ＋ 追加
        </button>
      </header>
      <ol className="track-list__items">
        {tracks.map((track) => {
          const isSelected = track.id === selectedTrackId;
          const controlName = accessibleTrackName(tracks, track);
          const assetStatus = track.type === 'audio'
            ? audioTrackAssetSummary(track, audioAssets, audioAssetIssues)
            : null;
          const selectThisTrack = () => {
            selectTrack(track.id);
            const firstClip = track.clips[0];
            selectClip(firstClip ? firstClip.id : null);
          };
          return (
            <li
              key={track.id}
              className={`track-row${isSelected ? ' is-selected' : ''}`}
            >
              <button
                id={trackSelectionControlId(track.id)}
                type="button"
                className="track-row__select"
                aria-label={`${controlName} トラックを選択`}
                aria-pressed={isSelected}
                onClick={selectThisTrack}
              >
                <span
                  className="track-row__swatch"
                  style={{ background: track.color ?? 'var(--accent)' }}
                  aria-hidden="true"
                />
                <span>
                  <span className="track-row__name">{track.name}</span>
                  <span className="track-row__type">
                    <span className="badge">{TRACK_TYPE_BADGE[track.type]}</span>{' '}
                    {TRACK_TYPE_LABEL[track.type]}
                  </span>
                  {track.type === 'audio' ? (
                    <span
                      className={`track-row__asset${assetStatus?.problem ? ' is-problem' : ''}`}
                      title={assetStatus?.statusLabel}
                    >
                      {assetStatus?.label ?? '音声クリップなし'}
                    </span>
                  ) : null}
                </span>
              </button>

              <div className="track-row__controls">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={track.volume}
                  aria-label={`${controlName} 音量`}
                  onChange={(event) => setTrackVolume(track.id, Number(event.target.value))}
                />
                {track.type !== 'master' ? (
                  <>
                    <button
                      type="button"
                      className={`mini-btn${track.mute ? ' is-active' : ''}`}
                      aria-pressed={track.mute}
                      aria-label={`${controlName} ミュート`}
                      onClick={() => toggleMute(track.id)}
                      title="ミュート"
                    >
                      M
                    </button>
                    <button
                      type="button"
                      className={`mini-btn${track.solo ? ' is-active' : ''}`}
                      aria-pressed={track.solo}
                      aria-label={`${controlName} ソロ`}
                      onClick={() => toggleSolo(track.id)}
                      title="ソロ"
                    >
                      S
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {addOpen ? (
        <AddTrackDialog
          onClose={() => setAddOpen(false)}
          onCreated={focusTrackSelectionControl}
        />
      ) : null}
    </nav>
  );
}
