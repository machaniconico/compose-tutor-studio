import { useRef, useState } from 'react';
import { useStore } from '../../state/store';
import type {
  Clip,
  DrumEvent,
  DrumGrooveSettings,
  DrumLane,
  Track,
} from '@cts/project-model';
import {
  beatsPerBar,
  clipContentOwnerId,
  resolveClipContent,
} from '@cts/project-model';
import { DRUM_PATTERNS, applyDrumPattern, setDrumStepVelocity } from '../../state/editorActions';
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

type DrumEventWithGroove = DrumEvent;
type DrumClipWithGroove = Clip;

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
    humanizeVelocity: Math.round(clamp(raw?.humanizeVelocity ?? DEFAULT_GROOVE.humanizeVelocity, 0, 127)),
    seed: Math.max(1, Math.trunc(raw?.seed ?? DEFAULT_GROOVE.seed)),
  };
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
export function findDrumClip(
  tracks: readonly Track[],
  selectedClipId: string | null,
): Clip | null {
  if (selectedClipId) {
    for (const track of tracks) {
      if (track.type !== 'drum') continue;
      const selected = track.clips.find(
        (clip) => clip.id === selectedClipId && clip.type === 'drum',
      );
      if (selected) return selected;
    }
  }
  for (const track of tracks) {
    if (track.type !== 'drum') continue;
    const first = track.clips.find((clip) => clip.type === 'drum');
    if (first) return first;
  }
  return null;
}

/** Include a final partial bar so every persisted drum step remains editable. */
export function drumClipBarCount(lengthBeats: number, beatsInBar: number): number {
  if (!Number.isFinite(lengthBeats) || !Number.isFinite(beatsInBar) || beatsInBar <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(lengthBeats / beatsInBar));
}

/** Match project validation: a drum step is editable only before the clip end. */
export function isDrumStepWithinClip(
  stepIndex: number,
  stepsPerBar: number,
  beatsInBar: number,
  lengthBeats: number,
): boolean {
  return Number.isSafeInteger(stepIndex)
    && stepIndex >= 0
    && Number.isSafeInteger(stepsPerBar)
    && stepsPerBar > 0
    && Number.isFinite(beatsInBar)
    && beatsInBar > 0
    && Number.isFinite(lengthBeats)
    && stepIndex * (beatsInBar / stepsPerBar) < lengthBeats;
}

/** Last enabled zero-based cell in one visible bar, including partial final bars. */
export function lastDrumStepInBar(
  barIndex: number,
  stepsPerBar: number,
  beatsInBar: number,
  lengthBeats: number,
): number {
  if (!Number.isSafeInteger(barIndex) || barIndex < 0) return 0;
  let last = 0;
  for (let stepInBar = 0; stepInBar < stepsPerBar; stepInBar += 1) {
    if (
      isDrumStepWithinClip(
        barIndex * stepsPerBar + stepInBar,
        stepsPerBar,
        beatsInBar,
        lengthBeats,
      )
    ) {
      last = stepInBar;
    }
  }
  return last;
}

/**
 * Step sequencer. Repeated clicks cycle a step through three velocity levels
 * then off. Pattern template buttons fill the clip, and a bar selector scopes
 * the grid when the clip spans multiple bars.
 */
export function DrumGrid() {
  const project = useStore((s) => s.project);
  const tracks = project.tracks;
  const selectedClipId = useStore((s) => s.editor.selectedClipId);
  const timeSignature = project.timeSignature;
  const applyProjectChange = useStore((s) => s.applyProjectChange);

  const [bar, setBar] = useState(0);
  const [selectedStep, setSelectedStep] = useState<SelectedStep | null>(null);
  const [focusedCell, setFocusedCell] = useState<{ lane: DrumLane; stepInBar: number }>({
    lane: LANES[0]?.lane ?? 'kick',
    stepInBar: 0,
  });
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const instance = findDrumClip(tracks, selectedClipId);
  const clip = instance ? resolveClipContent(project, instance) : null;
  const groove = readGroove(clip);
  const stepsPerBar = clip?.stepsPerBar ?? 16;
  const bpb = beatsPerBar(timeSignature);
  const events = ((clip as DrumClipWithGroove | null)?.drumEvents ?? []) as DrumEventWithGroove[];

  if (!clip) {
    return <div className="empty-hint">ドラムクリップがありません。</div>;
  }

  const totalBars = drumClipBarCount(clip.lengthBeats, bpb);
  const activeBar = Math.min(bar, totalBars - 1);
  const barOffset = activeBar * stepsPerBar;
  const lastEnabledStep = lastDrumStepInBar(
    activeBar,
    stepsPerBar,
    bpb,
    clip.lengthBeats,
  );
  const focusedStepInBar = Math.min(focusedCell.stepInBar, lastEnabledStep);

  const moveCellFocus = (laneIndex: number, stepInBar: number): void => {
    const lane = LANES[Math.max(0, Math.min(LANES.length - 1, laneIndex))]?.lane;
    if (!lane) return;
    const boundedStep = Math.max(0, Math.min(lastEnabledStep, stepInBar));
    setFocusedCell({ lane, stepInBar: boundedStep });
    cellRefs.current.get(`${lane}:${boundedStep}`)?.focus();
  };

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
    const committed = applyProjectChange((currentProject) => {
      const ownerId = clipContentOwnerId(currentProject, clip.id);
      if (!ownerId) return currentProject;
      return {
        ...currentProject,
        tracks: currentProject.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((candidate) => {
            if (candidate.id !== ownerId) return candidate;
            const nextClip: DrumClipWithGroove = {
              ...(candidate as DrumClipWithGroove),
              drumGroove: { ...readGroove(candidate), ...patch },
            };
            return nextClip;
          }),
        })),
      };
    });
    if (!committed) return;
    const committedProject = useStore.getState().project;
    const committedInstance = committedProject.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clip.id);
    const merged = committedInstance
      ? readGroove(resolveClipContent(committedProject, committedInstance) ?? committedInstance)
      : { ...groove, ...patch };
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
    applyProjectChange((currentProject) => {
      const ownerId = clipContentOwnerId(currentProject, clip.id);
      if (!ownerId) return currentProject;
      return {
        ...currentProject,
        tracks: currentProject.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((candidate) => {
            if (candidate.id !== ownerId) return candidate;
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
      };
    });
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
                aria-pressed={b === activeBar}
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
              max="127"
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

      <div
        className="drum-grid"
        role="grid"
        aria-label={`ドラムステップ、小節 ${activeBar + 1} / ${totalBars}`}
        aria-describedby="drum-grid-keyboard-help"
        aria-rowcount={LANES.length}
        aria-colcount={stepsPerBar + 1}
        style={{ ['--steps' as string]: String(stepsPerBar) }}
      >
        {LANES.map(({ lane, label }, laneIndex) => (
          <div className="drum-grid__row" role="row" aria-rowindex={laneIndex + 1} key={lane}>
            <span className="drum-grid__lane-label" role="rowheader" aria-colindex={1}>
              {label}
            </span>
            {Array.from({ length: stepsPerBar }, (_, stepInBar) => {
              const stepIndex = barOffset + stepInBar;
              const isWithinClip = isDrumStepWithinClip(
                stepIndex,
                stepsPerBar,
                bpb,
                clip.lengthBeats,
              );
              const event = byKey.get(`${lane}:${stepIndex}`) as DrumEventWithGroove | undefined;
              const isOn = event !== undefined;
              const isBeatStart = stepInBar % 4 === 0;
              const shade = isOn ? velocityClass(event.velocity) : '';
              const probability = event ? eventProbability(event, groove.probability) : null;
              return (
                <span
                  className="drum-grid__cell"
                  role="gridcell"
                  aria-colindex={stepInBar + 2}
                  key={stepInBar}
                >
                  <button
                    type="button"
                    ref={(button) => {
                      const key = `${lane}:${stepInBar}`;
                      if (button) cellRefs.current.set(key, button);
                      else cellRefs.current.delete(key);
                    }}
                    className={`drum-cell${isOn ? ' is-on' : ''}${shade}${isBeatStart ? ' is-beat-start' : ''}`}
                    disabled={!isWithinClip}
                    tabIndex={
                      isWithinClip &&
                      focusedCell.lane === lane &&
                      focusedStepInBar === stepInBar
                        ? 0
                        : -1
                    }
                    aria-pressed={isOn}
                    aria-label={`小節 ${activeBar + 1}、${label} ステップ ${stepInBar + 1}${
                      !isWithinClip
                        ? ' クリップ範囲外'
                        : isOn
                        ? ` 強さ ${event.velocity} 確率 ${Math.round((probability ?? 1) * 100)}%`
                        : ''
                    }`}
                    title={
                      !isWithinClip
                        ? `小節 ${activeBar + 1}、${label} ${stepInBar + 1}: クリップ範囲外`
                        : isOn
                        ? `小節 ${activeBar + 1}、${label} ${stepInBar + 1}: 強さ ${event.velocity} / 確率 ${Math.round(
                            (probability ?? 1) * 100,
                          )}%`
                        : `小節 ${activeBar + 1}、${label} ${stepInBar + 1}`
                    }
                    onClick={() => {
                      const committed = setDrumStepVelocity(
                        clip.id,
                        lane,
                        stepIndex,
                        nextVelocity(event?.velocity ?? null),
                      );
                      if (committed) setSelectedStep({ lane, stepIndex });
                    }}
                    onFocus={() => setFocusedCell({ lane, stepInBar })}
                    onKeyDown={(event) => {
                      let nextLane = laneIndex;
                      let nextStep = stepInBar;
                      switch (event.key) {
                        case 'ArrowLeft':
                          nextStep -= 1;
                          break;
                        case 'ArrowRight':
                          nextStep += 1;
                          break;
                        case 'ArrowUp':
                          nextLane -= 1;
                          break;
                        case 'ArrowDown':
                          nextLane += 1;
                          break;
                        case 'Home':
                          nextStep = 0;
                          break;
                        case 'End':
                          nextStep = lastEnabledStep;
                          break;
                        default:
                          return;
                      }
                      event.preventDefault();
                      moveCellFocus(nextLane, nextStep);
                    }}
                  />
                </span>
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
      <p id="drum-grid-keyboard-help" className="drums__hint">
        矢印キーでセルを移動し、Home / Endで小節の先頭 / 末尾へ移動できます。EnterまたはSpaceで 強 → 中 → 弱 → オフ と切り替わります。
      </p>
    </div>
  );
}
