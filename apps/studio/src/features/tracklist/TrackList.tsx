import { useStore } from '../../state/store';
import type { TrackType } from '@cts/project-model';

/** Tiny text label for each track type (no emoji, no SVG — simple shapes). */
const TYPE_LABEL: Record<TrackType, string> = {
  instrument: '鍵',
  drum: '打',
  audio: '音',
  bus: '束',
  master: '主',
};

/** Left column listing tracks with volume + mute/solo controls. */
export function TrackList() {
  const tracks = useStore((s) => s.project.tracks);
  const selectedTrackId = useStore((s) => s.editor.selectedTrackId);
  const selectTrack = useStore((s) => s.selectTrack);
  const selectClip = useStore((s) => s.selectClip);
  const setTrackVolume = useStore((s) => s.setTrackVolume);
  const toggleMute = useStore((s) => s.toggleMute);
  const toggleSolo = useStore((s) => s.toggleSolo);

  return (
    <nav className="track-list" aria-label="トラック一覧">
      {tracks.map((track) => {
        const isSelected = track.id === selectedTrackId;
        const selectThisTrack = () => {
          selectTrack(track.id);
          const firstClip = track.clips[0];
          selectClip(firstClip ? firstClip.id : null);
        };
        return (
          <div
            key={track.id}
            className={`track-row${isSelected ? ' is-selected' : ''}`}
            onClick={selectThisTrack}
          >
            <button
              type="button"
              aria-label={`${track.name} トラックを選択`}
              onClick={(e) => {
                e.stopPropagation();
                selectThisTrack();
              }}
              style={{
                gridColumn: '1 / -1',
                display: 'grid',
                gridTemplateColumns: '18px 1fr',
                gap: 'var(--sp-2)',
                alignItems: 'center',
                padding: 0,
                border: 0,
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span
                className="track-row__swatch"
                style={{ background: track.color ?? 'var(--accent)' }}
                aria-hidden="true"
              />
              <div>
                <div className="track-row__name">{track.name}</div>
                <div className="track-row__type">
                  <span className="badge">{TYPE_LABEL[track.type]}</span> {track.type}
                </div>
              </div>
            </button>

            <div className="track-row__controls" onClick={(e) => e.stopPropagation()}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={track.volume}
                aria-label={`${track.name} 音量`}
                onChange={(e) => setTrackVolume(track.id, Number(e.target.value))}
              />
              <button
                type="button"
                className={`mini-btn${track.mute ? ' is-active' : ''}`}
                aria-pressed={track.mute}
                onClick={() => toggleMute(track.id)}
                title="ミュート"
              >
                M
              </button>
              <button
                type="button"
                className={`mini-btn${track.solo ? ' is-active' : ''}`}
                aria-pressed={track.solo}
                onClick={() => toggleSolo(track.id)}
                title="ソロ"
              >
                S
              </button>
            </div>
          </div>
        );
      })}
    </nav>
  );
}
