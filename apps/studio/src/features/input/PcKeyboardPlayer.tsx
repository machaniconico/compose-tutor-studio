import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import { holdNote, releaseHeldNote, stopPreview } from '../../audio/livePreview';
import { isAnyDialogOpen } from '../common/dialogState';
import { matchShortcut } from '../common/keymap';
import { buildPlayingLayout } from './pcKeyboardLayout';
import {
  getPcKeyboardMode,
  setPcKeyboardOctave,
  setPcKeyboardPlaying,
  setPcKeyboardScaleLock,
  usePcKeyboardMode,
} from './pcKeyboardMode';

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Meta', 'Control', 'Alt', 'AltGraph']);

/** AltGr reports as Ctrl+Alt on some platforms; either way it is typing, not playing. */
function isAltGraph(event: KeyboardEvent): boolean {
  return event.getModifierState?.('AltGraph') === true;
}

/**
 * Plays the selected instrument track from the computer keyboard while the
 * mode is on. Sound goes through the live preview (own bus, bounded voices);
 * nothing here touches the project or the undo history.
 */
function useKeyboardPlaying(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      // A modifier changes what the held keys mean (Cmd+A, AltGr...) and the
      // browser may swallow their key-ups: let go of everything at once.
      if (MODIFIER_KEYS.has(event.key)) {
        stopPreview();
        return;
      }
      if (event.defaultPrevented || isAnyDialogOpen() || isAltGraph(event)) return;
      const action = matchShortcut(event, 'playing');
      if (action === null) return;
      if (action === 'exitPlayingMode') {
        stopPreview();
        setPcKeyboardPlaying(false);
        return;
      }
      event.preventDefault();
      if (event.repeat) return;
      const mode = getPcKeyboardMode();
      if (action === 'octaveDown' || action === 'octaveUp') {
        setPcKeyboardOctave(mode.octave + (action === 'octaveDown' ? -1 : 1));
        return;
      }
      const { project, editor } = useStore.getState();
      const track = project.tracks.find((t) => t.id === editor.selectedTrackId);
      if (!track || track.type !== 'instrument') return;
      const assignment = buildPlayingLayout({
        octave: mode.octave,
        scaleLock: mode.scaleLock,
        key: project.key,
        scale: project.scale,
      }).find((candidate) => candidate.code === event.code);
      if (assignment?.pitch == null) return;
      holdNote(event.code, track.instrument, assignment.pitch);
    };
    // Key-up always releases, whatever the focus or modifiers are by then.
    const onKeyUp = (event: KeyboardEvent) => {
      // Backstop: a key-up that still reports a held modifier means key-ups were suppressed.
      if (event.metaKey || event.ctrlKey || event.altKey) stopPreview();
      else releaseHeldNote(event.code);
    };
    // A key-up eaten by a dropdown, dialog or other pointer action must not leave a note on.
    const releaseAll = () => stopPreview();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', releaseAll, true);
    document.addEventListener('focusin', releaseAll, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', releaseAll, true);
      document.removeEventListener('focusin', releaseAll, true);
      stopPreview();
    };
  }, [active]);
}

export function PcKeyboardPlayer() {
  const mode = usePcKeyboardMode();
  const panelId = useId();
  const key = useStore((s) => s.project.key);
  const scale = useStore((s) => s.project.scale);
  const selectedTrackType = useStore(
    (s) => s.project.tracks.find((t) => t.id === s.editor.selectedTrackId)?.type ?? null,
  );
  const recording = useStore(
    (s) => s.audioRecordingOperationId !== null || s.automationRecording.ownership !== null,
  );
  useKeyboardPlaying(mode.playing);
  // Unmounting (the track list leaving the screen) ends playing mode.
  useEffect(() => () => setPcKeyboardPlaying(false), []);

  // The panel is fixed to the window (the track list scrolls and would clip it).
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!mode.playing) return undefined;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAnchor({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 428)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [mode.playing]);

  const layout = useMemo(
    () => buildPlayingLayout({ octave: mode.octave, scaleLock: mode.scaleLock, key, scale }),
    [mode.octave, mode.scaleLock, key, scale],
  );

  return (
    <div className="pr__popover-anchor">
      <button
        ref={buttonRef}
        type="button"
        className={mode.playing ? 'pr__icon-btn is-active' : 'pr__icon-btn'}
        aria-label="PC鍵盤で弾く"
        aria-pressed={mode.playing}
        aria-controls={mode.playing ? panelId : undefined}
        title="PC鍵盤で弾く:パソコンのキーボードで、選んだ楽器トラックの音を鳴らします。やめるときは Esc"
        onClick={() => setPcKeyboardPlaying(!mode.playing)}
      >
        ⌨
      </button>
      {mode.playing && anchor
        ? createPortal(
        <div
          id={panelId}
          className="pr__popover pr__pckeys"
          style={{ top: anchor.top, left: anchor.left }}
          role="group"
          aria-label="PC鍵盤で弾く"
        >
          <strong className="pr__pckeys-title">PC鍵盤で弾く</strong>
          <label className="pr__field">
            <input
              type="checkbox"
              checked={mode.scaleLock}
              onChange={(event) => setPcKeyboardScaleLock(event.target.checked)}
            />
            <span>スケールロック</span>
          </label>
          <p className="pr__popover-help">
            スケールロックをオンにすると、どのキーを押してもスケールの音だけが鳴ります。オフのときは半音ずつ並びます。
          </p>
          <p className="pr__popover-help">
            オクターブ {mode.octave}(Zで下げる・Xで上げる)。キーを押している間だけ鳴ります。やめるときは Esc。
          </p>
          <ul className="pr__keymap" aria-label="キーと音の割り当て">
            {layout.map((item) => (
              <li key={item.code} className={item.pitch === null ? 'is-off' : ''}>
                <kbd>{item.keyLabel}</kbd> {item.noteName}
              </li>
            ))}
          </ul>
          {selectedTrackType !== 'instrument' ? (
            <p className="pr__popover-help" role="status">
              楽器トラックを選ぶと、音が鳴ります。
            </p>
          ) : null}
          {recording ? (
            <p className="pr__popover-help" role="status">
              録音中は音を鳴らせません。
            </p>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
