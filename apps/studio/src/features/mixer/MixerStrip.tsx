import type { EffectConfig, Track } from '@cts/project-model';
import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_EFFECT_PARAMS,
  effectParam,
  findEffect,
  upsertEffect,
  type SupportedEffectType,
} from '../../audio/effects';
import { useStore } from '../../state/store';
import { LevelMeter, type LevelMeterReading } from './LevelMeter';
import './meter.css';

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

function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function effectLabel(effect: EffectConfig | undefined, key: string, fallback: number): number {
  return effectParam(effect, key, fallback);
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
  const [meterLevels, setMeterLevels] = useState<Record<string, LevelMeterReading>>({});
  const updateMeterLevel = useCallback((trackId: string, reading: LevelMeterReading) => {
    setMeterLevels((current) => {
      const previous = current[trackId];
      if (
        previous &&
        previous.clipping === reading.clipping &&
        previous.fill === reading.fill &&
        previous.displayDb === reading.displayDb &&
        previous.peakDb === reading.peakDb
      ) {
        return current;
      }
      return { ...current, [trackId]: reading };
    });
  }, []);
  const loudestTrack = useMemo(
    () => findLoudestTrack(channels, meterLevels),
    [channels, meterLevels],
  );
  const masterClipping = master ? (meterLevels[master.id]?.clipping ?? false) : false;

  return (
    <footer className="mixer-strip" aria-label="ミキサー">
      <div className="mixer-strip__row">
        {channels.map((track) => (
          <ChannelStrip
            key={track.id}
            track={track}
            onLevelChange={updateMeterLevel}
          />
        ))}
      </div>
      {master ? (
        <div className="mixer-strip__master">
          <ChannelStrip track={master} isMaster onLevelChange={updateMeterLevel} />
          {masterClipping ? (
            <div className="mixer-clip-warning" role="alert">
              音が大きすぎて歪んでいます。一番大きいトラックの音量を下げてみましょう
              {loudestTrack ? (
                <span className="mixer-clip-warning__target">
                  候補: {loudestTrack.name}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
}

function ChannelStrip(props: {
  track: Track;
  isMaster?: boolean;
  onLevelChange: (trackId: string, reading: LevelMeterReading) => void;
}) {
  const { track, isMaster = false, onLevelChange } = props;
  const setTrackVolume = useStore((s) => s.setTrackVolume);
  const setTrackPan = useStore((s) => s.setTrackPan);
  const toggleMute = useStore((s) => s.toggleMute);
  const toggleSolo = useStore((s) => s.toggleSolo);
  const applyProjectChange = useStore((s) => s.applyProjectChange);
  const handleLevelChange = useCallback(
    (reading: LevelMeterReading) => onLevelChange(track.id, reading),
    [onLevelChange, track.id],
  );

  const updateEffect = (
    type: SupportedEffectType,
    update: (effect: EffectConfig) => EffectConfig,
  ) => {
    applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((candidate) =>
        candidate.id === track.id
          ? {
              ...candidate,
              effects: upsertEffect(candidate.effects, type, update),
            }
          : candidate,
      ),
    }));
  };

  const setEffectEnabled = (type: SupportedEffectType, enabled: boolean) => {
    updateEffect(type, (effect) => ({ ...effect, enabled }));
  };

  const setEffectParam = (type: SupportedEffectType, key: string, value: number) => {
    updateEffect(type, (effect) => ({
      ...effect,
      enabled: true,
      params: { ...effect.params, [key]: value },
    }));
  };

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

      <div className="mix-ch__meter">
        <LevelMeter
          label={isMaster ? 'マスター' : track.name}
          source={isMaster ? { kind: 'master' } : { kind: 'track', trackId: track.id }}
          onLevelChange={handleLevelChange}
        />
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

      {!isMaster ? (
        <EffectControls
          track={track}
          setEffectEnabled={setEffectEnabled}
          setEffectParam={setEffectParam}
        />
      ) : null}
    </div>
  );
}

function findLoudestTrack(
  tracks: readonly Track[],
  levels: Record<string, LevelMeterReading>,
): Track | null {
  let loudest: Track | null = null;
  let loudestDb = Number.NEGATIVE_INFINITY;
  let fallback: Track | null = null;
  let fallbackVolume = Number.NEGATIVE_INFINITY;
  for (const track of tracks) {
    const level = levels[track.id];
    const db = level?.peakDb ?? Number.NEGATIVE_INFINITY;
    if (Number.isFinite(db) && db > loudestDb) {
      loudest = track;
      loudestDb = db;
    }
    if (track.volume > fallbackVolume) {
      fallback = track;
      fallbackVolume = track.volume;
    }
  }
  return loudest ?? fallback;
}

function EffectControls(props: {
  track: Track;
  setEffectEnabled: (type: SupportedEffectType, enabled: boolean) => void;
  setEffectParam: (type: SupportedEffectType, key: string, value: number) => void;
}) {
  const { track, setEffectEnabled, setEffectParam } = props;
  const filter = findEffect(track.effects, 'filter');
  const delay = findEffect(track.effects, 'delay');
  const reverb = findEffect(track.effects, 'reverb');
  const filterOn = filter?.enabled ?? false;
  const delayOn = delay?.enabled ?? false;
  const reverbOn = reverb?.enabled ?? false;

  const cutoffHz = effectLabel(
    filter,
    'cutoffHz',
    DEFAULT_EFFECT_PARAMS.filter.cutoffHz ?? 1800,
  );
  const delayTime = effectLabel(
    delay,
    'timeSeconds',
    DEFAULT_EFFECT_PARAMS.delay.timeSeconds ?? 0.25,
  );
  const delayFeedback = effectLabel(
    delay,
    'feedback',
    DEFAULT_EFFECT_PARAMS.delay.feedback ?? 0.28,
  );
  const reverbMix = effectLabel(
    reverb,
    'mix',
    DEFAULT_EFFECT_PARAMS.reverb.mix ?? 0.25,
  );

  return (
    <details className="mix-ch__effects">
      <summary>FX</summary>
      <div className="mix-ch__effect">
        <label>
          <input
            type="checkbox"
            checked={filterOn}
            aria-label={`${track.name} フィルター`}
            onChange={(event) => setEffectEnabled('filter', event.target.checked)}
          />
          フィルター
        </label>
        <input
          type="range"
          min={200}
          max={12000}
          step={10}
          value={cutoffHz}
          disabled={!filterOn}
          aria-label={`${track.name} フィルター cutoff`}
          onChange={(event) => setEffectParam('filter', 'cutoffHz', Number(event.target.value))}
        />
        <span>{Math.round(cutoffHz)} Hz</span>
      </div>

      <div className="mix-ch__effect">
        <label>
          <input
            type="checkbox"
            checked={delayOn}
            aria-label={`${track.name} ディレイ`}
            onChange={(event) => setEffectEnabled('delay', event.target.checked)}
          />
          ディレイ
        </label>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.01}
          value={delayTime}
          disabled={!delayOn}
          aria-label={`${track.name} ディレイ time`}
          onChange={(event) => setEffectParam('delay', 'timeSeconds', Number(event.target.value))}
        />
        <span>{delayTime.toFixed(2)} s</span>
        <input
          type="range"
          min={0}
          max={0.8}
          step={0.01}
          value={delayFeedback}
          disabled={!delayOn}
          aria-label={`${track.name} ディレイ feedback`}
          onChange={(event) => setEffectParam('delay', 'feedback', Number(event.target.value))}
        />
        <span>{percentLabel(delayFeedback)}</span>
      </div>

      <div className="mix-ch__effect">
        <label>
          <input
            type="checkbox"
            checked={reverbOn}
            aria-label={`${track.name} リバーブ`}
            onChange={(event) => setEffectEnabled('reverb', event.target.checked)}
          />
          リバーブ
        </label>
        <input
          type="range"
          min={0}
          max={0.8}
          step={0.01}
          value={reverbMix}
          disabled={!reverbOn}
          aria-label={`${track.name} リバーブ mix`}
          onChange={(event) => setEffectParam('reverb', 'mix', Number(event.target.value))}
        />
        <span>{percentLabel(reverbMix)}</span>
      </div>
    </details>
  );
}
