import type { EffectConfig, Track } from '@cts/project-model';
import { useStore } from '../../state/store';
import {
  addTrackEffect,
  removeTrackEffect,
  updateTrackEffectParam,
} from '../../state/editorActions';
import {
  INSERT_EFFECT_TYPES,
  isInsertEffectType,
  normalizeEffectConfig,
  type InsertEffectType,
} from '../../audio/effects';

type EffectInfo = {
  label: string;
  addLabel: string;
  summary: string;
};

type ParamControl = {
  key: string;
  label: string;
  low: string;
  high: string;
};

const EFFECT_INFO: Record<InsertEffectType, EffectInfo> = {
  filter: {
    label: 'フィルター',
    addLabel: 'フィルターを追加',
    summary: '高い音をやわらかくします',
  },
  delay: {
    label: 'ディレイ',
    addLabel: 'やまびこを追加',
    summary: '音を少し遅らせて重ねます',
  },
  reverb: {
    label: 'リバーブ',
    addLabel: '響きを追加',
    summary: '部屋の残響のように広げます',
  },
};

const PARAM_CONTROLS: Record<InsertEffectType, ParamControl[]> = {
  filter: [
    { key: 'cutoff', label: '明るさ', low: '丸い', high: '明るい' },
    { key: 'resonance', label: 'くせ', low: '自然', high: '強い' },
  ],
  delay: [
    { key: 'delayTime', label: '遅れ', low: '短い', high: '長い' },
    { key: 'feedback', label: 'くり返し', low: '少ない', high: '多い' },
    { key: 'mix', label: '混ぜる量', low: 'うすい', high: '濃い' },
  ],
  reverb: [
    { key: 'wet', label: '響き', low: '近い', high: '広い' },
    { key: 'decay', label: '余韻', low: '短い', high: '長い' },
  ],
};

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

      {!isMaster ? <EffectRack track={track} /> : null}
    </div>
  );
}

function EffectRack({ track }: { track: Track }) {
  return (
    <div
      className="mix-ch__effects"
      aria-label={`${track.name} エフェクト`}
      style={{ display: 'grid', gap: 8, minWidth: 0 }}
    >
      <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
        <span>音づくり</span>
        <select
          value=""
          aria-label={`${track.name} エフェクト追加`}
          onChange={(e) => {
            const type = e.target.value;
            if (isInsertEffectType(type)) addTrackEffect(track.id, type);
          }}
        >
          <option value="">追加する効果</option>
          {INSERT_EFFECT_TYPES.map((type) => (
            <option key={type} value={type}>
              {EFFECT_INFO[type].addLabel}
            </option>
          ))}
        </select>
      </label>

      {track.effects.length > 0 ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {track.effects.map((effect) => (
            <EffectEditor key={effect.id} trackId={track.id} effect={effect} />
          ))}
        </div>
      ) : (
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>効果なし</span>
      )}
    </div>
  );
}

function EffectEditor(props: { trackId: string; effect: EffectConfig }) {
  const { trackId, effect } = props;

  if (!isInsertEffectType(effect.type)) {
    return (
      <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <strong>未対応の効果</strong>
          <button
            type="button"
            className="mini-btn"
            onClick={() => removeTrackEffect(trackId, effect.id)}
            title="この効果を削除"
          >
            削除
          </button>
        </div>
        <span style={{ color: 'var(--muted)' }}>この効果はまだ調整できません。</span>
      </div>
    );
  }

  const normalized = normalizeEffectConfig(effect);
  const info = EFFECT_INFO[effect.type];

  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong>{info.label}</strong>
        <button
          type="button"
          className="mini-btn"
          onClick={() => removeTrackEffect(trackId, effect.id)}
          title={`${info.label}を削除`}
        >
          削除
        </button>
      </div>
      <span style={{ color: 'var(--muted)' }}>{info.summary}</span>

      {PARAM_CONTROLS[effect.type].map((control) => {
        const value = normalized.params[control.key] ?? 0;
        return (
          <label key={control.key} style={{ display: 'grid', gap: 3 }}>
            <span>
              {control.label} {Math.round(value * 100)}%
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={value}
              aria-label={`${info.label} ${control.label}`}
              onChange={(e) =>
                updateTrackEffectParam(trackId, effect.id, control.key, Number(e.target.value))
              }
            />
            <span
              aria-hidden="true"
              style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--muted)' }}
            >
              <span>{control.low}</span>
              <span>{control.high}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
