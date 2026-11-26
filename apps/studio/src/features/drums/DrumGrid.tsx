import { useState } from 'react';
import { useStore } from '../../state/store';
import type { Clip, DrumEvent, DrumLane, Track } from '@cts/project-model';
import { beatsPerBar, CLIP_EDGE_TOLERANCE_BEATS, resolveLinkSource, startsBeforeClipEnd } from '@cts/project-model';
import { DEFAULT_STEPS_PER_BAR } from '../../audio/events';
import { stepGridPxPerBeat } from '../timeline';
import { Playhead } from '../transport/TimelineRuler';
import { DRUM_PATTERNS, applyDrumPattern, setDrumStepVelocity } from '../../state/editorActions';

/** Six lanes shown top-to-bottom, with Japanese labels. */
const LANES: { lane: DrumLane; label: string }[] = [
  { lane: 'kick', label: 'キック' },
  { lane: 'snare', label: 'スネア' },
  { lane: 'closedHat', label: 'ハイハット(閉)' },
  { lane: 'openHat', label: 'ハイハット(開)' },
  { lane: 'clap', label: 'クラップ' },
  { lane: 'perc', label: 'パーカッション' },
];

/** Velocity cycle for repeated clicks: strong -> medium -> soft -> off. */
/** Layout of one drum row in px (matches .drum-grid__row in styles.css). */
const LANE_LABEL_PX = 64;
const MIN_STEP_PX = 22;
const STEP_GAP_PX = 3;

const VELOCITY_CYCLE = [100, 70, 40, 0] as const;

function nextVelocity(current: number | null): number {
  if (current === null) return VELOCITY_CYCLE[0];
  // find the closest level and advance to the next in the cycle
  const idx = VELOCITY_CYCLE.findIndex((v) => v !== 0 && Math.abs(v - current) <= 15);
  const safeIdx = idx >= 0 ? idx : 0;
  return VELOCITY_CYCLE[(safeIdx + 1) % VELOCITY_CYCLE.length] ?? 0;
}

/** Intensity class for a velocity, used to shade the cell. */
function velocityClass(velocity: number): string {
  if (velocity >= 90) return ' is-strong';
  if (velocity >= 60) return ' is-medium';
  return ' is-soft';
}

/** Find the drum clip (selected one, else first). */
function findDrumClip(tracks: readonly Track[], selectedClipId: string | null): Clip | null {
  const drumClips = tracks
    .filter((track) => track.type === 'drum')
    .flatMap((track) => track.clips.filter((clip) => clip.type === 'drum'));
  return drumClips.find((clip) => clip.id === selectedClipId) ?? drumClips[0] ?? null;
}

/**
 * Step sequencer. Repeated clicks cycle a step through three velocity levels
 * then off. Pattern template buttons fill the clip, and a bar selector scopes
 * the grid when the clip spans multiple bars.
 */
export function DrumGrid() {
  const tracks = useStore((s) => s.project.tracks);
  const selectedClipId = useStore((s) => s.editor.selectedClipId);
  const timeSignature = useStore((s) => s.project.timeSignature);
  const positionBeat = useStore((s) => s.transport.positionBeat);
  const zoomX = useStore((s) => s.editor.zoomX);

  const [bar, setBar] = useState(0);

  const clip = findDrumClip(tracks, selectedClipId);
  if (!clip) {
    return <div className="empty-hint">ドラムクリップがありません。</div>;
  }

  const linked = clip.aliasOf !== undefined;
  const source = linked ? resolveLinkSource(clip, tracks.flatMap((track) => track.clips)) : clip;
  if (typeof source === 'string') {
    return <div className="empty-hint">{source}</div>;
  }

  const stepsPerBar = source.stepsPerBar !== undefined && source.stepsPerBar > 0
    ? source.stepsPerBar
    : DEFAULT_STEPS_PER_BAR;
  const bpb = beatsPerBar(timeSignature);
  // A clip may end part-way through a bar (after a meter change): show that
  // bar too, with the steps past the clip end switched off.
  const totalBars = Math.max(1, Math.ceil(clip.lengthBeats / bpb - 1e-9));
  const activeBar = Math.min(bar, totalBars - 1);
  const barOffset = activeBar * stepsPerBar;
  const beatsPerStep = bpb / stepsPerBar;
  // The playhead starts at the first step cell, just right of the lane label.
  const stepAreaPpb = stepGridPxPerBeat(zoomX, stepsPerBar, bpb, MIN_STEP_PX + STEP_GAP_PX);
  const stepPx = (stepAreaPpb * bpb) / stepsPerBar - STEP_GAP_PX;
  const labelOffsetBeats = (LANE_LABEL_PX + STEP_GAP_PX) / stepAreaPpb;
  const barStartBeat = clip.startBeat + activeBar * bpb;

  // A looping clip only sounds its first repeat's steps, so a cell in a later
  // repeat shows and edits the step that sounds there (as in the piano roll).
  const period = clip.contentLengthBeats ?? clip.lengthBeats;
  const looping = clip.loop && period > 0;
  /** The saved step that sounds at this cell, or null when no step can. */
  const soundingStep = (stepIndex: number): number | null => {
    const beat = stepIndex * beatsPerStep;
    if (!startsBeforeClipEnd(beat, clip.lengthBeats)) return null;
    if (!looping || startsBeforeClipEnd(beat, period)) return stepIndex;
    let local = beat % period;
    // Float remainders a hair under the period mean "the next repeat's start".
    if (!startsBeforeClipEnd(local, period)) local = 0;
    const step = Math.round(local / beatsPerStep);
    return Math.abs(step * beatsPerStep - local) < CLIP_EDGE_TOLERANCE_BEATS ? step : null;
  };

  const events = source.drumEvents ?? [];
  const byKey = new Map<string, DrumEvent>();
  for (const e of events) byKey.set(`${e.lane}:${e.stepIndex}`, e);

  return (
    <div className="drums">
      <div className="drums__toolbar">
        <div className="drums__patterns">
          <span className="drums__patterns-label">パターン</span>
          {DRUM_PATTERNS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                const ok = window.confirm(
                  `「${p.name}」のパターンでドラムを置き換えます。よろしいですか？`,
                );
                if (!ok) return;
                applyDrumPattern(source.id, p.id);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>

        {totalBars > 1 ? (
          <div className="drums__bars" role="group" aria-label="小節切替">
            <span className="drums__bars-label">小節</span>
            {Array.from({ length: totalBars }, (_, b) => (
              <button
                key={b}
                type="button"
                className={b === activeBar ? 'is-active' : ''}
                onClick={() => setBar(b)}
              >
                {b + 1}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div
        className="drum-grid"
        style={{ ['--steps' as string]: String(stepsPerBar), ['--step-px' as string]: `${stepPx}px` }}
      >
        {LANES.map(({ lane, label }) => (
          <div className="drum-grid__row" key={lane}>
            <span className="drum-grid__lane-label">{label}</span>
            {Array.from({ length: stepsPerBar }, (_, stepInBar) => {
              const sounding = soundingStep(barOffset + stepInBar);
              const stepIndex = sounding ?? barOffset + stepInBar;
              const event = sounding === null ? undefined : byKey.get(`${lane}:${stepIndex}`);
              const isOn = event !== undefined;
              const isBeatStart = stepInBar % 4 === 0;
              const isOutside = sounding === null;
              const outsideLabel =
                !startsBeforeClipEnd((barOffset + stepInBar) * beatsPerStep, clip.lengthBeats)
                  ? '(クリップの外)'
                  : '(ループで鳴らない位置)';
              const shade = isOn ? velocityClass(event.velocity) : '';
              return (
                <button
                  type="button"
                  key={stepInBar}
                  className={`drum-cell${isOn ? ' is-on' : ''}${shade}${isBeatStart ? ' is-beat-start' : ''}${isOutside ? ' is-outside' : ''}`}
                  aria-pressed={isOn}
                  aria-label={`${label} ステップ ${stepInBar + 1}${isOn ? ` 強さ ${event.velocity}` : ''}${isOutside ? outsideLabel : ''}`}
                  disabled={isOutside}
                  onClick={() =>
                    setDrumStepVelocity(source.id, lane, stepIndex, nextVelocity(event?.velocity ?? null))
                  }
                />
              );
            })}
          </div>
        ))}
        <Playhead
          ppb={stepAreaPpb}
          offsetBeats={barStartBeat - labelOffsetBeats}
          hidden={positionBeat < barStartBeat || positionBeat >= barStartBeat + bpb}
        />
      </div>
      {linked && (
        <p className="drums__hint">このクリップは中身を共有しています。セルやパターンを変えると、元のクリップと他の共有先にも反映されます。</p>
      )}
      <p className="drums__hint">セルを繰り返しクリックすると 強 → 中 → 弱 → オフ と切り替わります。</p>
    </div>
  );
}
