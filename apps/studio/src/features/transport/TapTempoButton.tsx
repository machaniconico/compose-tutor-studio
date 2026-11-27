import { useEffect, useRef, useState } from 'react';
import { tapTempo } from '@cts/project-model';
import { useStore } from '../../state/store';

/** A pause this long (ms) ends a tap run; 2000 ms between taps is 30 BPM. */
export const TAP_RESET_MS = 2000;
const MAX_TAPS = 5;

/**
 * Tap the button to the beat. The tempo shown follows the taps; when the taps
 * pause the tempo is written once with main's `setBpm` (first tempo), so a
 * whole run is exactly 1 undo step. A run belongs to the project it started
 * in: switching project or unmounting discards it without writing.
 */
export function TapTempoButton(props: { disabled?: boolean }) {
  const setBpm = useStore((s) => s.setBpm);
  const projectId = useStore((s) => s.project.id);
  const taps = useRef<number[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);
  const runProjectId = useRef<string | null>(null);
  const [pendingBpm, setPendingBpm] = useState<number | null>(null);

  const discard = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    taps.current = [];
    pending.current = null;
    runProjectId.current = null;
    setPendingBpm(null);
  };
  const commit = (): void => {
    const bpm = pending.current;
    const sameProject = runProjectId.current === useStore.getState().project.id;
    discard();
    if (bpm !== null && sameProject) setBpm(bpm);
  };
  const discardRef = useRef(discard);
  discardRef.current = discard;
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (runProjectId.current !== null && runProjectId.current !== projectId) discardRef.current();
  }, [projectId]);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const onTap = (): void => {
    if (props.disabled) return;
    const now = performance.now();
    const last = taps.current[taps.current.length - 1];
    if (last !== undefined && now - last > TAP_RESET_MS) taps.current = [];
    if (taps.current.length === 0) runProjectId.current = useStore.getState().project.id;
    taps.current = [...taps.current, now].slice(-MAX_TAPS);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => commitRef.current(), TAP_RESET_MS);
    const bpm = tapTempo(taps.current);
    pending.current = bpm;
    setPendingBpm(bpm);
  };

  return (
    <button
      type="button"
      className="transport-bar__tap"
      aria-label="タップテンポ"
      title="拍に合わせて2回以上たたくと、BPMが決まります"
      disabled={props.disabled}
      onClick={onTap}
    >
      タップ{pendingBpm !== null ? ` ${pendingBpm}` : ''}
    </button>
  );
}
