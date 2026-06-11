import { useState } from 'react';
import { useStore } from '../../state/store';
import type { Clip, DrumEvent, DrumLane, Track } from '@cts/project-model';
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
  for (const track of tracks) {
    if (track.type !== 'drum') continue;
    const selected = track.clips.find((c) => c.id === selectedClipId && c.type === 'drum');
    if (selected) return selected;
    const first = track.clips.find((c) => c.type === 'drum');
    if (first) return first;
  }
  return null;
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

  const [bar, setBar] = useState(0);

  const clip = findDrumClip(tracks, selectedClipId);
  if (!clip) {
    return <div className="empty-hint">ドラムクリップがありません。</div>;
  }

  const stepsPerBar = clip.stepsPerBar ?? 16;
  const bpb = timeSignature[0];
  const totalBars = Math.max(1, Math.round(clip.lengthBeats / bpb));
  const activeBar = Math.min(bar, totalBars - 1);
  const barOffset = activeBar * stepsPerBar;

  const events = clip.drumEvents ?? [];
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
                applyDrumPattern(clip.id, p.id);
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

      <div className="drum-grid" style={{ ['--steps' as string]: String(stepsPerBar) }}>
        {LANES.map(({ lane, label }) => (
          <div className="drum-grid__row" key={lane}>
            <span className="drum-grid__lane-label">{label}</span>
            {Array.from({ length: stepsPerBar }, (_, stepInBar) => {
              const stepIndex = barOffset + stepInBar;
              const event = byKey.get(`${lane}:${stepIndex}`);
              const isOn = event !== undefined;
              const isBeatStart = stepInBar % 4 === 0;
              const shade = isOn ? velocityClass(event.velocity) : '';
              return (
                <button
                  type="button"
                  key={stepInBar}
                  className={`drum-cell${isOn ? ' is-on' : ''}${shade}${isBeatStart ? ' is-beat-start' : ''}`}
                  aria-pressed={isOn}
                  aria-label={`${label} ステップ ${stepInBar + 1}${isOn ? ` 強さ ${event.velocity}` : ''}`}
                  onClick={() =>
                    setDrumStepVelocity(clip.id, lane, stepIndex, nextVelocity(event?.velocity ?? null))
                  }
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="drums__hint">セルを繰り返しクリックすると 強 → 中 → 弱 → オフ と切り替わります。</p>
    </div>
  );
}
