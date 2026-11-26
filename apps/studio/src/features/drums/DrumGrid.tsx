import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import type { Clip, DrumLane, Track } from '@cts/project-model';
import { beatTick, beatsPerBar, clipEditSpan, editableDrumStepAt, PPQ, resolveLinkSource, soundingEvents } from '@cts/project-model';
import { DEFAULT_STEPS_PER_BAR } from '../../audio/events';
import { stepGridPxPerBeat } from '../timeline';
import { Playhead } from '../transport/TimelineRuler';
import {
  DRUM_PATTERNS,
  applyDrumPattern,
  planDrumStepsChange,
  setDrumStepsPerBar,
  setDrumStepVelocity,
} from '../../state/editorActions';
import { pushToast } from '../../state/tutorialBridge';

/** Six lanes shown top-to-bottom, with Japanese labels. */
const LANES: { lane: DrumLane; label: string }[] = [
  { lane: 'kick', label: 'キック' },
  { lane: 'snare', label: 'スネア' },
  { lane: 'closedHat', label: 'ハイハット(閉)' },
  { lane: 'openHat', label: 'ハイハット(開)' },
  { lane: 'clap', label: 'クラップ' },
  { lane: 'perc', label: 'パーカッション' },
];

/** Step counts offered for one bar (US-019). */
const STEP_CHOICES = [16, 12] as const;

/** The question asked before a step-count change moves or merges hits. */
export function drumStepsConfirmMessage(to: number, moved: number, merged: number): string {
  const parts: string[] = [];
  if (moved > 0) parts.push(`${to} マスのグリッドに合わない音が ${moved} 個あります。最も近い位置へ動かします。`);
  if (merged > 0) parts.push(`${moved > 0 ? '' : `${to} マスにすると、`}同じ位置に重なる ${merged} 個の音は 1 つにまとめます。`);
  return `${parts.join('')}よろしいですか？`;
}

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
  const project = useStore((s) => s.project);
  const { tracks, timeSignature } = project;
  const selectedClipId = useStore((s) => s.editor.selectedClipId);
  const positionBeat = useStore((s) => s.transport.positionBeat);
  const zoomX = useStore((s) => s.editor.zoomX);

  const [bar, setBar] = useState(0);

  const clip = findDrumClip(tracks, selectedClipId);
  const byCell = useMemo(() => {
    const result = new Map<string, number>();
    if (!clip) return result;
    for (const event of soundingEvents(project, { clipId: clip.id, includeMuted: true }).events) {
      if (event.kind === 'drum') {
        const tick = beatTick(event.unswungStartBeat - clip.startBeat);
        result.set(`${event.lane}:${tick}`, event.sourceIndex);
      }
    }
    return result;
  }, [clip, project]);
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
  const { length } = clipEditSpan(project, clip);
  const totalBars = Math.max(1, Math.ceil(beatTick(length) / beatTick(bpb)));
  const activeBar = Math.min(bar, totalBars - 1);
  const barOffset = activeBar * stepsPerBar;
  const beatsPerStep = bpb / stepsPerBar;
  // The playhead starts at the first step cell, just right of the lane label.
  const stepAreaPpb = stepGridPxPerBeat(zoomX, stepsPerBar, bpb, MIN_STEP_PX + STEP_GAP_PX);
  const stepPx = (stepAreaPpb * bpb) / stepsPerBar - STEP_GAP_PX;
  const labelOffsetBeats = (LANE_LABEL_PX + STEP_GAP_PX) / stepAreaPpb;
  const barStartBeat = clip.startBeat + activeBar * bpb;

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

        <div className="drums__steps" role="group" aria-label="1 小節のマスの数">
          <span className="drums__steps-label">マス</span>
          {STEP_CHOICES.map((steps) => (
            <button
              key={steps}
              type="button"
              className={steps === stepsPerBar ? 'is-active' : ''}
              aria-pressed={steps === stepsPerBar}
              aria-label={`${steps} マス`}
              title={steps === 16 ? '1 拍を 4 つに分けます(4/4 の 16 分音符)' : '4/4 では 1 拍を 3 つに分けます(3 連符)'}
              onClick={() => {
                const plan = planDrumStepsChange(project, source.id, steps);
                if (!plan) return;
                if (!plan.ok) {
                  // Refused before asking: nothing changes and the reason is shown.
                  pushToast(plan.reason, 'error');
                  return;
                }
                if (plan.moved + plan.merged > 0 && !window.confirm(drumStepsConfirmMessage(steps, plan.moved, plan.merged))) return;
                setDrumStepsPerBar(source.id, steps);
              }}
            >
              {steps}
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
              const beat = (barOffset + stepInBar) * beatsPerStep;
              const stepIndex = editableDrumStepAt(project, clip, beat, beatsPerStep);
              const sourceIndex = byCell.get(`${lane}:${beatTick(beat)}`);
              const event = sourceIndex === undefined ? undefined : source.drumEvents?.[sourceIndex];
              const isOn = event !== undefined;
              const isBeatStart = beatTick(beat) % PPQ === 0;
              const isOutside = stepIndex === null && !event;
              const outsideLabel = beatTick(beat) >= beatTick(length)
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
                  onClick={() => {
                    const target = event?.stepIndex ?? stepIndex;
                    if (target !== null) setDrumStepVelocity(source.id, lane, target, nextVelocity(event?.velocity ?? null));
                  }}
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
