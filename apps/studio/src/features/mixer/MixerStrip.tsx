import { useStore } from '../../state/store';

/** Bottom mixer: one channel per track with volume, pan, mute, solo. */
export function MixerStrip() {
  const tracks = useStore((s) => s.project.tracks);
  const setTrackVolume = useStore((s) => s.setTrackVolume);
  const setTrackPan = useStore((s) => s.setTrackPan);
  const toggleMute = useStore((s) => s.toggleMute);
  const toggleSolo = useStore((s) => s.toggleSolo);

  return (
    <footer className="mixer-strip" aria-label="ミキサー">
      <div className="mixer-strip__row">
        {tracks.map((track) => (
          <div className="mixer-channel" key={track.id}>
            <div className="mixer-channel__name" title={track.name}>
              {track.name}
            </div>

            <label className="mixer-channel__label" htmlFor={`vol-${track.id}`}>
              音量 {Math.round(track.volume * 100)}
            </label>
            <input
              id={`vol-${track.id}`}
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={track.volume}
              onChange={(e) => setTrackVolume(track.id, Number(e.target.value))}
            />

            <label className="mixer-channel__label" htmlFor={`pan-${track.id}`}>
              パン {track.pan.toFixed(2)}
            </label>
            <input
              id={`pan-${track.id}`}
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={track.pan}
              onChange={(e) => setTrackPan(track.id, Number(e.target.value))}
            />

            <div className="mixer-channel__buttons">
              <button
                type="button"
                className={`mini-btn${track.mute ? ' is-active' : ''}`}
                aria-pressed={track.mute}
                onClick={() => toggleMute(track.id)}
              >
                M
              </button>
              <button
                type="button"
                className={`mini-btn${track.solo ? ' is-active' : ''}`}
                aria-pressed={track.solo}
                onClick={() => toggleSolo(track.id)}
              >
                S
              </button>
            </div>
          </div>
        ))}
      </div>
    </footer>
  );
}
