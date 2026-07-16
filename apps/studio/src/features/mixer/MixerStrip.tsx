import { useEffect, useId, useRef, useState } from 'react';
import { MAX_AUDIO_SENDS_PER_SOURCE, type EffectConfig, type Track } from '@cts/project-model';
import { useStore } from '../../state/store';
import {
  addTrackEffect,
  removeTrackEffect,
  updateTrackEffectParam,
} from '../../state/editorActions';
import {
  INSERT_EFFECT_TYPES,
  compressorAttackToSeconds,
  compressorRatioToValue,
  compressorReleaseToSeconds,
  compressorThresholdToDb,
  eqGainToDb,
  isInsertEffectType,
  normalizeEffectConfig,
  type InsertEffectType,
} from '../../audio/effects';
import { readMeterLevel, type MeterLevel } from '../../audio/graph';
import { accessibleTrackName } from '../tracklist/trackPresentation';
import {
  addStudioAudioSend,
  removeStudioAudioSend,
  setStudioTrackOutput,
  studioRoutingErrorMessage,
  updateStudioAudioSend,
  type StudioRoutingCommandResult,
} from '../../state/routingActions';
import { pushToast } from '../../state/tutorialBridge';

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
  eq: {
    label: 'イコライザー',
    addLabel: 'イコライザーを追加',
    summary: '低音・中音・高音の明るさを調整します',
  },
  compressor: {
    label: 'コンプ',
    addLabel: 'コンプを追加',
    summary: '大きすぎる音をおさえて音量を揃えます',
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
  eq: [
    { key: 'lowGain', label: '低音', low: 'へらす', high: 'ふやす' },
    { key: 'midGain', label: '中音', low: 'へらす', high: 'ふやす' },
    { key: 'highGain', label: '高音', low: 'やわらかい', high: '明るい' },
  ],
  compressor: [
    { key: 'threshold', label: 'かかり始め', low: '小さい音から', high: '大きい音だけ' },
    { key: 'ratio', label: 'そろえる強さ', low: '自然', high: '強い' },
    { key: 'attack', label: '反応', low: '速い', high: 'ゆっくり' },
    { key: 'release', label: '戻り', low: '短い', high: '長い' },
  ],
};

// The Tauri window may be as short as 640 CSS pixels. At that height the full
// mixer can consume the piano-roll viewport, so start with it tucked away while
// keeping the choice reversible and keyboard accessible.
const COMPACT_MIXER_MEDIA_QUERY = '(min-width: 901px) and (max-height: 700px)';

function shouldStartWithExpandedMixer(): boolean {
  return !(
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(COMPACT_MIXER_MEDIA_QUERY).matches
  );
}

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

function dbControlLabel(db: number): string {
  if (Math.abs(db) < 0.05) return '0.0 dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function formatEffectParam(type: InsertEffectType, key: string, value: number): string {
  if (type === 'eq') return dbControlLabel(eqGainToDb(value));
  if (type === 'compressor' && key === 'threshold') {
    return `${Math.round(compressorThresholdToDb(value))} dB`;
  }
  if (type === 'compressor' && key === 'ratio') {
    return `${compressorRatioToValue(value).toFixed(1)}:1`;
  }
  if (type === 'compressor' && key === 'attack') {
    return `${Math.round(compressorAttackToSeconds(value) * 1_000)} ms`;
  }
  if (type === 'compressor' && key === 'release') {
    return `${Math.round(compressorReleaseToSeconds(value) * 1_000)} ms`;
  }
  return `${Math.round(value * 100)}%`;
}

function meterDbLabel(level: number): string {
  if (level <= 0.0001) return '-∞ dB';
  const db = 20 * Math.log10(level);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function useMeterLevel(trackId: string): MeterLevel {
  const [level, setLevel] = useState<MeterLevel>(() => readMeterLevel(trackId));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setLevel(readMeterLevel(trackId));
      return;
    }

    let raf = 0;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      // readMeterLevel returns a fresh object each frame; only re-render when the
      // value actually changed so an idle/silent mixer doesn't churn at 60fps.
      setLevel((prev) => {
        const next = readMeterLevel(trackId);
        if (prev.peak === next.peak && prev.rms === next.rms && prev.clipping === next.clipping) {
          return prev;
        }
        return next;
      });
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => {
      mounted = false;
      window.cancelAnimationFrame(raf);
    };
  }, [trackId]);

  return level;
}

/**
 * Bottom mixer: one vertical channel strip per non-master track, plus a master
 * strip pinned at the right. Volume 0..2 (default 1) with a dB-ish label, pan
 * slider -1..1, and M/S toggles with active states.
 */
export function MixerStrip() {
  const tracks = useStore((s) => s.project.tracks);
  const channels = tracks.filter((t) => t.type !== 'master');
  const buses = channels.filter((track) => track.type === 'bus');
  const master = tracks.find((t) => t.type === 'master') ?? null;
  const contentId = useId();
  const manuallyToggled = useRef(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(shouldStartWithExpandedMixer);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(COMPACT_MIXER_MEDIA_QUERY);
    const followViewportUntilManuallyToggled = () => {
      if (manuallyToggled.current) return;
      if (
        media.matches &&
        contentRef.current?.contains(document.activeElement)
      ) {
        toggleRef.current?.focus();
      }
      setExpanded(!media.matches);
    };

    followViewportUntilManuallyToggled();
    media.addEventListener('change', followViewportUntilManuallyToggled);
    return () => media.removeEventListener('change', followViewportUntilManuallyToggled);
  }, []);

  return (
    <section
      className={`mixer-strip${expanded ? ' is-expanded' : ' is-collapsed'}`}
      aria-label="ミキサー"
    >
      <div className="mixer-strip__toggle-rail">
        <button
          ref={toggleRef}
          type="button"
          className="mixer-strip__toggle"
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={expanded ? 'ミキサーをたたむ' : 'ミキサーを開く'}
          onClick={() => {
            manuallyToggled.current = true;
            setExpanded((current) => !current);
          }}
        >
          <span aria-hidden="true">{expanded ? 'たたむ ▾' : 'ミキサーを開く ▴'}</span>
        </button>
      </div>

      <div
        ref={contentRef}
        className="mixer-strip__content"
        id={contentId}
        hidden={!expanded}
      >
        <div className="mixer-strip__row">
          {channels.map((track) => (
            <ChannelStrip
              key={track.id}
              track={track}
              accessibleName={accessibleTrackName(tracks, track)}
              buses={buses}
            />
          ))}
        </div>
        {master ? (
          <div className="mixer-strip__master">
            <ChannelStrip
              track={master}
              accessibleName={accessibleTrackName(tracks, master)}
              buses={buses}
              isMaster
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ChannelStrip(props: {
  track: Track;
  accessibleName: string;
  buses: readonly Track[];
  isMaster?: boolean;
}) {
  const { track, accessibleName, buses, isMaster = false } = props;
  const meter = useMeterLevel(track.id);
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
          {isMaster ? 'マスター' : `${track.name}${track.type === 'bus' ? '（Bus）' : ''}`}
        </span>
      </div>

      <div className="mix-ch__fader">
        <LevelMeter level={meter} trackName={isMaster ? 'マスター' : accessibleName} />
        <input
          className="mix-ch__volume"
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={track.volume}
          aria-label={`${accessibleName} 音量`}
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
            aria-label={`${accessibleName} パン`}
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
            aria-label={`${accessibleName} ミュート`}
            onClick={() => toggleMute(track.id)}
            title="ミュート"
          >
            M
          </button>
          <button
            type="button"
            className={`mini-btn${track.solo ? ' is-active is-solo' : ''}`}
            aria-pressed={track.solo}
            aria-label={`${accessibleName} ソロ`}
            onClick={() => toggleSolo(track.id)}
            title="ソロ"
          >
            S
          </button>
        </div>
      ) : null}

      {!isMaster ? (
        <RoutingControls track={track} accessibleName={accessibleName} buses={buses} />
      ) : null}

      {!isMaster ? <EffectRack track={track} accessibleName={accessibleName} /> : null}
    </div>
  );
}

function reportRoutingResult(
  result: StudioRoutingCommandResult,
  successMessage: string,
): boolean {
  if (!result.ok) {
    pushToast(studioRoutingErrorMessage(result.code), 'error');
    return false;
  }
  if (result.changed && (successMessage.length > 0 || result.playbackStopped)) {
    pushToast(
      `${successMessage}${result.playbackStopped ? ' 再生を停止し、位置を保持しました。' : ''}`.trim(),
      'info',
    );
  }
  return true;
}

function RoutingControls(props: {
  track: Track;
  accessibleName: string;
  buses: readonly Track[];
}) {
  const { track, accessibleName, buses } = props;
  const routing = useStore((state) => state.project.audioRouting);
  const output = routing.outputs.find((route) => route.sourceTrackId === track.id);
  const sends = routing.sends.filter((send) => send.sourceTrackId === track.id);
  const mainBusId = output?.destination.type === 'bus' ? output.destination.trackId : null;
  const sendTargets = new Set(sends.map((send) => send.targetBusId));
  const availableNewTargets = buses.filter(
    (bus) => bus.id !== track.id && bus.id !== mainBusId && !sendTargets.has(bus.id),
  );
  const canAddSend = sends.length < MAX_AUDIO_SENDS_PER_SOURCE;
  const outputValue = output?.destination.type === 'bus'
    ? `bus:${output.destination.trackId}`
    : 'master';

  return (
    <details className="mix-ch__routing">
      <summary>経路</summary>
      <label className="mix-ch__routing-field">
        <span>出力</span>
        <select
          aria-label={`${accessibleName} 出力先`}
          value={outputValue}
          onChange={(event) => {
            const value = event.currentTarget.value;
            const result = value === 'master'
              ? setStudioTrackOutput(track.id, { type: 'master' })
              : setStudioTrackOutput(track.id, {
                  type: 'bus',
                  trackId: value.slice('bus:'.length),
                });
            reportRoutingResult(result, `${track.name}の出力先を変更しました。`);
          }}
        >
          <option value="master">マスター</option>
          {buses.filter((bus) => bus.id !== track.id).map((bus) => (
            <option key={bus.id} value={`bus:${bus.id}`}>
              {accessibleTrackName(buses, bus)}
            </option>
          ))}
        </select>
      </label>

      <div className="mix-ch__sends" aria-label={`${accessibleName} センド`}>
        <span className="mix-ch__routing-title">センド</span>
        {sends.length === 0 ? <small>追加したバスへ音を分けて送れます。</small> : null}
        {sends.map((send) => {
          const otherTargets = new Set(
            sends.filter((candidate) => candidate.id !== send.id).map((candidate) => candidate.targetBusId),
          );
          const targetBus = buses.find((bus) => bus.id === send.targetBusId);
          const targetName = targetBus ? accessibleTrackName(buses, targetBus) : 'バス';
          const sendAccessibleName = `${accessibleName} ${targetName}へのセンド`;
          return (
            <div className="mix-ch__send" key={send.id}>
              <label>
                <span className="visually-hidden">{sendAccessibleName}の送り先</span>
                <select
                  aria-label={`${sendAccessibleName}の送り先`}
                  value={send.targetBusId}
                  onChange={(event) => {
                    reportRoutingResult(
                      updateStudioAudioSend(send.id, { targetBusId: event.currentTarget.value }),
                      `${track.name}のセンド先を変更しました。`,
                    );
                  }}
                >
                  {buses
                    .filter((bus) =>
                      bus.id !== track.id &&
                      bus.id !== mainBusId &&
                      !otherTargets.has(bus.id))
                    .map((bus) => (
                      <option key={bus.id} value={bus.id}>{accessibleTrackName(buses, bus)}</option>
                    ))}
                </select>
              </label>
              <label className="mix-ch__send-enabled">
                <input
                  type="checkbox"
                  aria-label={`${sendAccessibleName}を有効にする`}
                  checked={send.enabled}
                  onChange={(event) => {
                    reportRoutingResult(
                      updateStudioAudioSend(send.id, { enabled: event.currentTarget.checked }),
                      '',
                    );
                  }}
                />
                有効
              </label>
              <label>
                <span className="visually-hidden">{sendAccessibleName}の位置</span>
                <select
                  aria-label={`${sendAccessibleName}の位置`}
                  value={send.position}
                  onChange={(event) => {
                    const position = event.currentTarget.value === 'pre-fader'
                      ? 'pre-fader'
                      : 'post-fader';
                    reportRoutingResult(
                      updateStudioAudioSend(send.id, { position }),
                      `${track.name}のセンド位置を変更しました。`,
                    );
                  }}
                >
                  <option value="post-fader">フェーダー後</option>
                  <option value="pre-fader">フェーダー前</option>
                </select>
              </label>
              <label className="mix-ch__send-gain">
                <span>量 {gainToDbLabel(send.gain)}</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={send.gain}
                  aria-label={`${sendAccessibleName}の送り量`}
                  onChange={(event) => {
                    reportRoutingResult(
                      updateStudioAudioSend(send.id, { gain: Number(event.currentTarget.value) }),
                      '',
                    );
                  }}
                />
              </label>
              <button
                type="button"
                className="mix-ch__send-remove"
                aria-label={`${sendAccessibleName}を削除`}
                onClick={() => {
                  reportRoutingResult(
                    removeStudioAudioSend(send.id),
                    `${track.name}のセンドを削除しました。`,
                  );
                }}
              >
                削除
              </button>
            </div>
          );
        })}
        {canAddSend && availableNewTargets.length > 0 ? (
          <label className="mix-ch__routing-field">
            <span className="visually-hidden">{accessibleName} センドを追加</span>
            <select
              aria-label={`${accessibleName} センドを追加`}
              value=""
              onChange={(event) => {
                const targetBusId = event.currentTarget.value;
                if (targetBusId.length === 0) return;
                reportRoutingResult(
                  addStudioAudioSend(track.id, targetBusId),
                  `${track.name}にセンドを追加しました。`,
                );
              }}
            >
              <option value="">センドを追加…</option>
              {availableNewTargets.map((bus) => (
                <option key={bus.id} value={bus.id}>{accessibleTrackName(buses, bus)}</option>
              ))}
            </select>
          </label>
        ) : null}
        {!canAddSend ? (
          <small>1つのトラックから追加できるセンドは最大{MAX_AUDIO_SENDS_PER_SOURCE}件です。</small>
        ) : null}
        <small>フェーダー前は音量・効果の前、フェーダー後は音量・効果・パンの後から送ります。</small>
      </div>
    </details>
  );
}

function LevelMeter(props: { level: MeterLevel; trackName: string }) {
  const { level, trackName } = props;
  const rmsPercent = Math.min(100, Math.max(0, level.rms * 100));
  const peakPercent = Math.min(100, Math.max(0, level.peak * 100));
  const fillColor = level.clipping ? '#dc2626' : '#22c55e';
  const label = `${trackName} レベル RMS ${meterDbLabel(level.rms)} / Peak ${meterDbLabel(level.peak)}`;

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuenow={Math.max(-60, Math.min(0, Math.round(20 * Math.log10(level.rms || 0.0001))))}
        style={{
          position: 'relative',
          height: 8,
          overflow: 'hidden',
          borderRadius: 4,
          background: 'rgba(148, 163, 184, 0.25)',
          boxShadow: 'inset 0 0 0 1px rgba(148, 163, 184, 0.3)',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'block',
            width: `${rmsPercent}%`,
            height: '100%',
            background: fillColor,
            transition: 'width 70ms linear, background-color 120ms linear',
          }}
        />
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${peakPercent}%`,
            width: 2,
            transform: 'translateX(-1px)',
            background: level.clipping ? '#ef4444' : '#f59e0b',
          }}
        />
      </div>
      {level.clipping ? (
        <span
          role="alert"
          style={{ color: '#dc2626', fontSize: 11, fontWeight: 700, lineHeight: 1.2 }}
        >
          音が大きすぎます
        </span>
      ) : (
        <span aria-hidden="true" style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.2 }}>
          Peak {meterDbLabel(level.peak)}
        </span>
      )}
    </div>
  );
}

function EffectRack({ track, accessibleName }: { track: Track; accessibleName: string }) {
  return (
    <div
      className="mix-ch__effects"
      aria-label={`${accessibleName} エフェクト`}
      style={{ display: 'grid', gap: 8, minWidth: 0 }}
    >
      <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
        <span>音づくり</span>
        <select
          value=""
          aria-label={`${accessibleName} エフェクト追加`}
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
          {track.effects.map((effect, index) => (
            <EffectEditor
              key={effect.id}
              trackId={track.id}
              trackName={accessibleName}
              effect={effect}
              ordinal={
                track.effects
                  .slice(0, index + 1)
                  .filter((candidate) => candidate.type === effect.type).length
              }
            />
          ))}
        </div>
      ) : (
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>効果なし</span>
      )}
    </div>
  );
}

function EffectEditor(props: {
  trackId: string;
  trackName: string;
  effect: EffectConfig;
  ordinal: number;
}) {
  const { trackId, trackName, effect, ordinal } = props;

  if (!isInsertEffectType(effect.type)) {
    const effectLabel = `${trackName} 未対応の効果 ${ordinal}`;
    return (
      <div
        role="group"
        aria-label={effectLabel}
        style={{ display: 'grid', gap: 6, fontSize: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <strong>未対応の効果</strong>
          <button
            type="button"
            className="mini-btn"
            aria-label={`${effectLabel}を削除`}
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
  const effectLabel = `${trackName} ${info.label} ${ordinal}`;

  return (
    <div
      role="group"
      aria-label={effectLabel}
      style={{ display: 'grid', gap: 6, fontSize: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong>{info.label} {ordinal}</strong>
        <button
          type="button"
          className="mini-btn"
          aria-label={`${effectLabel}を削除`}
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
              {control.label} {formatEffectParam(effect.type, control.key, value)}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={value}
              aria-label={`${effectLabel} ${control.label}`}
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
