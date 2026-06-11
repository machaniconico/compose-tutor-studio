import { useStore } from '../../state/store';
import type { Clip, DrumLane, Track } from '@cts/project-model';

/** Six lanes shown top-to-bottom, with Japanese labels. */
const LANES: { lane: DrumLane; label: string }[] = [
  { lane: 'kick', label: 'キック' },
  { lane: 'snare', label: 'スネア' },
  { lane: 'closedHat', label: 'クローズHH' },
  { lane: 'openHat', label: 'オープンHH' },
  { lane: 'clap', label: 'クラップ' },
  { lane: 'perc', label: 'パーカス' },
];

/** Find the first drum clip in the project (skeleton uses one drum clip). */
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
 * Clickable step sequencer grid. Renders `stepsPerBar` columns x 6 lanes and
 * toggles drum events via the store.
 */
export function DrumGrid() {
  const tracks = useStore((s) => s.project.tracks);
  const selectedClipId = useStore((s) => s.editor.selectedClipId);
  const toggleDrumStep = useStore((s) => s.toggleDrumStep);

  const clip = findDrumClip(tracks, selectedClipId);
  if (!clip) {
    return <div className="empty-hint">ドラムクリップがありません。</div>;
  }

  const steps = clip.stepsPerBar ?? 16;
  const events = clip.drumEvents ?? [];
  const onSet = new Set(events.map((e) => `${e.lane}:${e.stepIndex}`));

  return (
    <div className="drum-grid" style={{ ['--steps' as string]: String(steps) }}>
      {LANES.map(({ lane, label }) => (
        <div className="drum-grid__row" key={lane}>
          <span className="drum-grid__lane-label">{label}</span>
          {Array.from({ length: steps }, (_, stepIndex) => {
            const isOn = onSet.has(`${lane}:${stepIndex}`);
            const isBeatStart = stepIndex % 4 === 0;
            return (
              <button
                type="button"
                key={stepIndex}
                className={`drum-cell${isOn ? ' is-on' : ''}${isBeatStart ? ' is-beat-start' : ''}`}
                aria-pressed={isOn}
                aria-label={`${label} ステップ ${stepIndex + 1}`}
                onClick={() => toggleDrumStep(clip.id, lane, stepIndex)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
