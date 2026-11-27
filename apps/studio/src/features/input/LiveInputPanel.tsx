import { useEffect } from 'react';
import { nearestScalePitch, transposeByDegree } from '@cts/theory-engine';
import { allNotesOff, noteOff, noteOn } from '../../audio/livePreview';
import { isEditableShortcutTarget } from '../../state/keymap';
import { useStore } from '../../state/store';
import { pushToast } from '../../state/tutorialBridge';
import { isAnyDialogOpen } from '../common/dialogState';
import { keyboardInput } from './keyboardMap';

export function LiveInputPanel() {
  const { liveInputEnabled, liveInputOctave, liveInputScaleLock } = useStore((state) => state.editor);
  const toggleLiveInput = useStore((state) => state.toggleLiveInput);
  const toggleScaleLock = useStore((state) => state.toggleLiveInputScaleLock);

  useEffect(() => {
    const held = new Map<string, number>();

    function stopPlaying() {
      held.clear();
      allNotesOff();
    }

    function onKeyDown(event: KeyboardEvent) {
      const { editor, project, startScreenOpen, setLiveInputOctave } = useStore.getState();
      if (!editor.liveInputEnabled || startScreenOpen || isAnyDialogOpen() || event.defaultPrevented ||
          isEditableShortcutTarget(event.target) || isEditableShortcutTarget(document.activeElement)) return;

      const input = keyboardInput(event, editor.liveInputOctave);
      if (!input) return;
      event.preventDefault();
      if (input.type === 'octave') {
        setLiveInputOctave(input.octave);
        return;
      }
      if (held.has(event.code)) return;

      let pitch = input.pitch;
      if (editor.liveInputScaleLock) {
        try {
          const nearest = nearestScalePitch(pitch, project.key, project.scale);
          // At the MIDI boundary, take the next in-range scale note.
          pitch = nearest < 0 || nearest > 127
            ? transposeByDegree(nearest, nearest < 0 ? 1 : -1, project.key, project.scale)
            : nearest;
        } catch {
          // Some older project files have invalid key or scale names.
          return;
        }
      }

      const alreadySounding = [...held.values()].includes(pitch);
      held.set(event.code, pitch);
      if (alreadySounding) return;
      const instrument = project.tracks.find((track) => track.id === editor.selectedTrackId)?.instrument;
      void noteOn(pitch, instrument).catch(() => {
        pushToast('音を鳴らせませんでした。音の出力先と音量を確認して、もう一度キーを押してください。', 'error');
      });
    }

    function onKeyUp(event: KeyboardEvent) {
      // keyup は repeat しない。IME が途中で入って 'Process' / isComposing の keyup になっても、
      // 押していたキーの音は必ず止める(鳴りっぱなし防止)。
      const pitch = held.get(event.code);
      if (pitch === undefined) return;
      held.delete(event.code);
      // Scale lock can map two keys to the same pitch. Release it with the last key.
      if ([...held.values()].includes(pitch)) return;
      noteOff(pitch);
    }

    function onVisibilityChange() {
      if (document.hidden) stopPlaying();
    }

    function onFocusIn(event: FocusEvent) {
      if (isEditableShortcutTarget(event.target)) stopPlaying();
    }

    const unsubscribe = useStore.subscribe((state, previous) => {
      if (previous.editor.liveInputEnabled && !state.editor.liveInputEnabled) stopPlaying();
    });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stopPlaying);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stopPlaying);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('focusin', onFocusIn, true);
      stopPlaying();
    };
  }, []);

  return (
    <section className="live-input" aria-label="PCキーボード演奏">
      <div className="live-input__controls">
        <button type="button" aria-pressed={liveInputEnabled} onClick={toggleLiveInput}>
          PC で演奏<span aria-hidden="true"> {liveInputEnabled ? 'オン' : 'オフ'}</span>
        </button>
        {liveInputEnabled && (
          <>
            <button type="button" aria-pressed={liveInputScaleLock} onClick={toggleScaleLock} aria-describedby="live-input-scale-help">
              スケールロック<span aria-hidden="true"> {liveInputScaleLock ? 'オン' : 'オフ'}</span>
            </button>
            <span>オクターブ {liveInputOctave}（Z で下げる・X で上げる）</span>
          </>
        )}
      </div>
      {liveInputEnabled && (
        <>
          <p>A S D F G H J K L が白鍵、W E T Y U が黒鍵です。押している間だけ音が鳴ります。</p>
          <p id="live-input-scale-help">
            スケールロックを入れると、曲のスケールにある音だけが鳴ります。
            スケールの外の音も、音と音をつなげたり、ブルースらしい響きを出したりするのに使えます。
          </p>
        </>
      )}
    </section>
  );
}
