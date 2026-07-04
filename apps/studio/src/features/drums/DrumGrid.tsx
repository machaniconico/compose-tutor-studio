import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import type { Clip, DrumEvent, DrumLane, Track } from '@cts/project-model';
import { DRUM_PATTERNS, applyDrumPattern, setDrumStepVelocity } from '../../state/editorActions';
import { makeDrumGrooveStepKey, setDrumGrooveRuntimeOptions } from '../../audio/scheduler';
import { publishAppEvent } from '../../state/appEvents';

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

type DrumGrooveSettings = {
  swing: number;
  probability: number;
  humanizeVelocity: number;
  seed: number;
};

type DrumEventWithGroove = DrumEvent & {
  probability?: number;
};

type DrumClipWithGroove = Clip & {
  drumGroove?: Partial<DrumGrooveSettings>;
  drumEvents?: DrumEventWithGroove[];
};

type SelectedStep = {
  lane: DrumLane;
  stepIndex: number;
};

const DEFAULT_GROOVE: DrumGrooveSettings = {
  swing: 0,
  probability: 1,
  humanizeVelocity: 0,
  seed: 1,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function readGroove(clip: Clip | null): DrumGrooveSettings {
  const raw = clip ? (clip as DrumClipWithGroove).drumGroove : undefined;
  return {
    swing: clamp(raw?.swing ?? DEFAULT_GROOVE.swing, 0, 1),
    probability: clamp(raw?.probability ?? DEFAULT_GROOVE.probability, 0, 1),
    humanizeVelocity: Math.round(clamp(raw?.humanizeVelocity ?? DEFAULT_GROOVE.humanizeVelocity, 0, 32)),
    seed: Math.max(1, Math.trunc(raw?.seed ?? DEFAULT_GROOVE.seed)),
  };
}

function stepBeat(
  clip: Clip,
  stepIndex: number,
  stepsPerBar: number,
  beatsPerBar: number,
): number {
  const steps = stepsPerBar > 0 ? stepsPerBar : 16;
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  return clip.startBeat + stepIndex * (bpb / steps);
}

function eventProbability(event: DrumEventWithGroove, fallback: number): number {
  return clamp(event.probability ?? fallback, 0, 1);
}

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
  const applyProjectChange = useStore((s) => s.applyProjectChange);

  const [bar, setBar] = useState(0);
  const [selectedStep, setSelectedStep] = useState<SelectedStep | null>(null);

  const clip = findDrumClip(tracks, selectedClipId);
  const groove = readGroove(clip);
  const stepsPerBar = clip?.stepsPerBar ?? 16;
  const bpb = timeSignature[0];
  const events = ((clip as DrumClipWithGroove | null)?.drumEvents ?? []) as DrumEventWithGroove[];
  const probabilityMap = useMemo(() => {
    if (!clip) return {};
    const map: Record<string, number> = {};
    for (const event of events) {
      const beat = stepBeat(clip, event.stepIndex, stepsPerBar, bpb);
      map[makeDrumGrooveStepKey(event.lane, beat)] = eventProbability(event, groove.probability);
    }
    return map;
  }, [bpb, clip, events, groove.probability, stepsPerBar]);

  useEffect(() => {
    if (!clip) return;
    setDrumGrooveRuntimeOptions({
      swing: groove.swing,
      probability: groove.probability,
      humanizeVelocity: groove.humanizeVelocity,
      seed: groove.seed,
      stepsPerBar,
      beatsPerBar: bpb,
      probabilitiesByStep: probabilityMap,
    });
  }, [
    bpb,
    clip,
    groove.humanizeVelocity,
    groove.probability,
    groove.seed,
    groove.swing,
    probabilityMap,
    stepsPerBar,
  ]);

  if (!clip) {
    return <div className="empty-hint">ドラムクリップがありません。</div>;
  }

  const totalBars = Math.max(1, Math.round(clip.lengthBeats / bpb));
  const activeBar = Math.min(bar, totalBars - 1);
  const barOffset = activeBar * stepsPerBar;

  const byKey = new Map<string, DrumEvent>();
  for (const e of events) byKey.set(`${e.lane}:${e.stepIndex}`, e);
  const selectedEvent =
    selectedStep === null
      ? undefined
      : (byKey.get(`${selectedStep.lane}:${selectedStep.stepIndex}`) as DrumEventWithGroove | undefined);
  const selectedLaneLabel = LANES.find((lane) => lane.lane === selectedStep?.lane)?.label;

  const ownerTrackId =
    tracks.find((track) => track.clips.some((c) => c.id === clip.id))?.id ?? '';

  const updateGroove = (patch: Partial<DrumGrooveSettings>): void => {
    applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((candidate) => {
          if (candidate.id !== clip.id) return candidate;
          const nextClip: DrumClipWithGroove = {
            ...(candidate as DrumClipWithGroove),
            drumGroove: { ...readGroove(candidate), ...patch },
          };
          return nextClip;
        }),
      })),
    }));
    const merged = { ...groove, ...patch };
    publishAppEvent({
      type: 'drum.grooveChanged',
      payload: {
        trackId: ownerTrackId,
        swing: merged.swing,
        probability: merged.probability,
        humanizeVelocity: merged.humanizeVelocity,
      },
    });
  };

  const updateSelectedProbability = (probability: number): void => {
    if (!selectedStep) return;
    applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((candidate) => {
          if (candidate.id !== clip.id) return candidate;
          const nextEvents = ((candidate as DrumClipWithGroove).drumEvents ?? []).map((event) => {
            if (event.lane !== selectedStep.lane || event.stepIndex !== selectedStep.stepIndex) {
              return event;
            }
            const nextEvent: DrumEventWithGroove = {
              ...event,
              probability: clamp(probability, 0, 1),
            };
            return nextEvent;
          });
          const nextClip: DrumClipWithGroove = {
            ...(candidate as DrumClipWithGroove),
            drumEvents: nextEvents,
          };
          return nextClip;
        }),
      })),
    }));
  };

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

        <div className="drums__groove" role="group" aria-label="グルーヴ設定">
          <label>
            スイング
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={groove.swing}
              onChange={(event) => updateGroove({ swing: Number(event.currentTarget.value) })}
            />
            <span>{Math.round(groove.swing * 100)}%</span>
          </label>
          <label>
            全体の確率
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={groove.probability}
              onChange={(event) => updateGroove({ probability: Number(event.currentTarget.value) })}
            />
            <span>{Math.round(groove.probability * 100)}%</span>
          </label>
          <label>
            強さのゆらぎ
            <input
              type="range"
              min="0"
              max="32"
              step="1"
              value={groove.humanizeVelocity}
              onChange={(event) =>
                updateGroove({ humanizeVelocity: Number(event.currentTarget.value) })
              }
            />
            <span>±{groove.humanizeVelocity}</span>
          </label>
          <label>
            乱数シード
            <input
              type="number"
              min="1"
              max="999999"
              value={groove.seed}
              onChange={(event) => updateGroove({ seed: Number(event.currentTarget.value) })}
            />
          </label>
        </div>
      </div>

      <div className="drum-grid" style={{ ['--steps' as string]: String(stepsPerBar) }}>
        {LANES.map(({ lane, label }) => (
          <div className="drum-grid__row" key={lane}>
            <span className="drum-grid__lane-label">{label}</span>
            {Array.from({ length: stepsPerBar }, (_, stepInBar) => {
              const stepIndex = barOffset + stepInBar;
              const event = byKey.get(`${lane}:${stepIndex}`) as DrumEventWithGroove | undefined;
              const isOn = event !== undefined;
              const isBeatStart = stepInBar % 4 === 0;
              const shade = isOn ? velocityClass(event.velocity) : '';
              const probability = event ? eventProbability(event, groove.probability) : null;
              return (
                <button
                  type="button"
                  key={stepInBar}
                  className={`drum-cell${isOn ? ' is-on' : ''}${shade}${isBeatStart ? ' is-beat-start' : ''}`}
                  aria-pressed={isOn}
                  aria-label={`${label} ステップ ${stepInBar + 1}${
                    isOn
                      ? ` 強さ ${event.velocity} 確率 ${Math.round((probability ?? 1) * 100)}%`
                      : ''
                  }`}
                  title={
                    isOn
                      ? `${label} ${stepInBar + 1}: 強さ ${event.velocity} / 確率 ${Math.round(
                          (probability ?? 1) * 100,
                        )}%`
                      : `${label} ${stepInBar + 1}`
                  }
                  onClick={() => {
                    setSelectedStep({ lane, stepIndex });
                    setDrumStepVelocity(clip.id, lane, stepIndex, nextVelocity(event?.velocity ?? null));
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="drums__step-probability">
        {selectedEvent && selectedStep ? (
          <label>
            選択ステップの確率（{selectedLaneLabel} ステップ {selectedStep.stepIndex + 1}）
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={eventProbability(selectedEvent, groove.probability)}
              onChange={(event) => updateSelectedProbability(Number(event.currentTarget.value))}
            />
            <span>{Math.round(eventProbability(selectedEvent, groove.probability) * 100)}%</span>
          </label>
        ) : (
          <span>セルを選ぶと、その音だけの発音確率を調整できます。</span>
        )}
      </div>
      <p className="drums__hint">セルを繰り返しクリックすると 強 → 中 → 弱 → オフ と切り替わります。</p>
    </div>
  );
}
