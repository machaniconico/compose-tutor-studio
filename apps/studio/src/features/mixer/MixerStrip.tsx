import type { Track } from '@cts/project-model';
import { useStore } from '../../state/store';

/** Convert a linear gain (0..2) to an approximate dB label for display. */
function gainToDbLabel(gain: number): string {
  if (gain <= 0.0001) return '-∞';
  const db = 20 * Math.log10(gain);
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
}

/** Pan label: L/C/R with magnitude. */
function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.02) return 'C';
  const amount = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `L${amount}` : `R${amount}`;
}

/**
 * Bottom mixer: one vertical channel strip per non-master track, plus a master
 * strip pinned at the right. Volume 0..2 (default 1) with a dB-ish label, pan
 * slider -1..1, and M/S toggles with active states.
 */
export function MixerStrip() {
  const tracks = useStore((s) => s.project.tracks);
  const channels = tracks.filter((t) => t.type !== 'master');
  const master = tracks.find((t) => t.type === 'master') ?? null;

  return (
    <footer className="mixer-strip" aria-label="ミキサー">
      <div className="mixer-strip__row">
        {channels.map((track) => (
          <ChannelStrip key={track.id} track={track} />
        ))}
      </div>
      {master ? (
        <div className="mixer-strip__master">
          <ChannelStrip track={master} isMaster />
        </div>
      ) : null}
    </footer>
  );
}

function ChannelStrip(props: { track: Track; isMaster?: boolean }) {
  const { track, isMaster = false } = props;
  const setTrackVolume = useStore((s) => s.setTrackVolume);
  const setTrackPan = useStore((s) => s.setTrackPan);
  const toggleMute = useStore((s) => s.toggleMute);
  const toggleSolo = useStore((s) => s.toggleSolo);

  return (
    <div className={`mix-ch${isMaster ? ' is-master' : ''}`}>
      <div className="mix-ch__head">
        <span
          className="mix-ch__dot"
          style={{ background: track.color ?? 'var(--accent)' }}
          aria-hidden="true"
        />
        <span className="mix-ch__name" title={track.name}>
          {isMaster ? 'マスター' : track.name}
        </span>
      </div>

      <div className="mix-ch__fader">
        <input
          className="mix-ch__volume"
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={track.volume}
          aria-label={`${track.name} 音量`}
          onChange={(e) => setTrackVolume(track.id, Number(e.target.value))}
        />
        <span className="mix-ch__db">{gainToDbLabel(track.volume)}</span>
      </div>

      {!isMaster ? (
        <div className="mix-ch__pan">
          <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={track.pan}
            aria-label={`${track.name} パン`}
            onChange={(e) => setTrackPan(track.id, Number(e.target.value))}
          />
          <span className="mix-ch__pan-label">{panLabel(track.pan)}</span>
        </div>
      ) : null}

      {!isMaster ? (
        <div className="mix-ch__buttons">
          <button
            type="button"
            className={`mini-btn${track.mute ? ' is-active is-mute' : ''}`}
            aria-pressed={track.mute}
            onClick={() => toggleMute(track.id)}
            title="ミュート"
          >
            M
          </button>
          <button
            type="button"
            className={`mini-btn${track.solo ? ' is-active is-solo' : ''}`}
            aria-pressed={track.solo}
            onClick={() => toggleSolo(track.id)}
            title="ソロ"
          >
            S
          </button>
        </div>
      ) : null}
    </div>
  );
}
