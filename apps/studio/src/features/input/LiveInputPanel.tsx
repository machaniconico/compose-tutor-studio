import { useEffect, useRef, useState } from 'react';
import { nearestScalePitch, transposeByDegree } from '@cts/theory-engine';
import { getAudioEngine } from '../../audio/engine';
import { allNotesOff, noteOff, noteOn } from '../../audio/livePreview';
import { listenForMidiInput, requestWebMidi, supportsWebMidi } from '../../platform/webMidi';
import { isEditableShortcutTarget } from '../../state/keymap';
import { useStore } from '../../state/store';
import { pushToast } from '../../state/tutorialBridge';
import { isAnyDialogOpen } from '../common/dialogState';
import { keyboardInput } from './keyboardMap';

const MIDI_CHANNELS = Array.from({ length: 16 }, (_, index) => index + 1);
const NO_MIDI = 'この環境では MIDI 鍵盤を使えません。PC キーボードで演奏できます';
const AUDIO_ERROR = '音を鳴らせませんでした。音の出力先と音量を確認して、もう一度キーを押してください。';

type MidiSession =
  | { status: 'unsupported' | 'idle' | 'pending' | 'failed' }
  | { status: 'ready'; access: MIDIAccess };

function startNote(held: Map<string, number>, key: string, pitch: number, velocity?: number) {
  if (held.has(key)) return;
  const { editor, project } = useStore.getState();
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
  held.set(key, pitch);
  if (alreadySounding) return;
  const instrument = project.tracks.find((track) => track.id === editor.selectedTrackId)?.instrument;
  const played = velocity === undefined ? noteOn(pitch, instrument) : noteOn(pitch, instrument, velocity);
  void played.catch(() => pushToast(AUDIO_ERROR, 'error'));
}

function releaseNote(held: Map<string, number>, key: string) {
  const pitch = held.get(key);
  if (pitch === undefined) return;
  held.delete(key);
  // Different keys, including MIDI and PC keys, can share one preview voice.
  if (![...held.values()].includes(pitch)) noteOff(pitch);
}

export function LiveInputPanel() {
  const { liveInputEnabled, liveInputOctave, liveInputScaleLock } = useStore((state) => state.editor);
  const toggleLiveInput = useStore((state) => state.toggleLiveInput);
  const toggleScaleLock = useStore((state) => state.toggleLiveInputScaleLock);
  const heldNotes = useRef(new Map<string, number>());
  const midiFocused = useRef(true);
  const [midiSession, setMidiSession] = useState<MidiSession>(() => ({
    status: supportsWebMidi() ? 'idle' : 'unsupported',
  }));
  const midiStatus = midiSession.status;
  const midiAccess = midiStatus === 'ready' ? midiSession.access : null;
  const [midiInputs, setMidiInputs] = useState<MIDIInput[]>([]);
  const [midiChannel, setMidiChannel] = useState(1);

  async function enableMidi() {
    setMidiSession({ status: 'pending' });
    const request = requestWebMidi();
    // Prepare audio from the button gesture. MIDI messages cannot unlock audio themselves.
    void getAudioEngine().ensureContext(useStore.getState().project.tracks)
      .catch(() => pushToast(AUDIO_ERROR, 'error'));
    const result = await request;
    if (!result.supported) {
      setMidiSession({ status: 'unsupported' });
    } else if (result.access) {
      setMidiSession({ status: 'ready', access: result.access });
    } else {
      setMidiSession({ status: 'failed' });
    }
  }

  useEffect(() => {
    const held = heldNotes.current;

    function stopPlaying() {
      held.clear();
      allNotesOff();
    }

    function onKeyDown(event: KeyboardEvent) {
      const { editor, startScreenOpen, setLiveInputOctave } = useStore.getState();
      if (!editor.liveInputEnabled || startScreenOpen || isAnyDialogOpen() || event.defaultPrevented ||
          isEditableShortcutTarget(event.target) || isEditableShortcutTarget(document.activeElement)) return;

      const input = keyboardInput(event, editor.liveInputOctave);
      if (!input) return;
      event.preventDefault();
      if (input.type === 'octave') {
        setLiveInputOctave(input.octave);
        return;
      }
      startNote(held, event.code, input.pitch);
    }

    function onKeyUp(event: KeyboardEvent) {
      // keyup は repeat しない。IME が途中で入って 'Process' / isComposing の keyup になっても、
      // 押していたキーの音は必ず止める(鳴りっぱなし防止)。
      releaseNote(held, event.code);
    }

    function onBlur() {
      midiFocused.current = false;
      stopPlaying();
    }

    function onFocus() {
      midiFocused.current = true;
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
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('focusin', onFocusIn, true);
      stopPlaying();
    };
  }, []);

  useEffect(() => {
    if (!midiAccess) return;
    const held = heldNotes.current;

    function stopMidi() {
      for (const key of held.keys()) {
        if (key.startsWith('midi:')) releaseNote(held, key);
      }
    }

    const unlisten = listenForMidiInput(midiAccess, midiChannel, {
      onInputsChanged: setMidiInputs,
      onDisconnect: stopMidi,
      onNote(deviceId, note) {
        const key = `midi:${deviceId}:${note.pitch}`;
        if (note.type === 'noteOff') {
          releaseNote(held, key);
          return;
        }
        const { editor, startScreenOpen } = useStore.getState();
        if (!editor.liveInputEnabled || !midiFocused.current || document.hidden ||
            startScreenOpen || isAnyDialogOpen()) return;
        startNote(held, key, note.pitch, note.velocity);
      },
    });
    return () => {
      unlisten();
      stopMidi();
    };
  }, [midiAccess, midiChannel]);

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
      <div className="live-input__midi">
        {midiStatus !== 'unsupported' && !midiAccess && (
          <button type="button" disabled={midiStatus === 'pending'} onClick={() => void enableMidi()}>
            MIDI 鍵盤を使う
          </button>
        )}
        {midiAccess && (
          <label className="live-input__controls">
            MIDI チャンネル
            <select value={midiChannel} onChange={(event) => setMidiChannel(Number(event.currentTarget.value))}>
              {MIDI_CHANNELS.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
            </select>
          </label>
        )}
        <div role="status">
          {midiStatus === 'unsupported' && <p>{NO_MIDI}</p>}
          {midiStatus === 'pending' && <p>MIDI 鍵盤の利用許可を確認しています。</p>}
          {midiStatus === 'failed' && <p>MIDI 鍵盤を使えませんでした。利用許可を確認するか、PC キーボードで演奏してください。</p>}
          {midiAccess && (midiInputs.length === 0
            ? <p>MIDI 鍵盤が見つかりません。鍵盤をつないでください。PC キーボードでも演奏できます。</p>
            : <>
                <ul aria-label="接続中の MIDI 鍵盤">
                  {midiInputs.map((input) => <li key={input.id}>{input.name || '名前のない MIDI 鍵盤'}</li>)}
                </ul>
                {!liveInputEnabled && <p>「PC で演奏」をオンにすると、MIDI 鍵盤でも音が鳴ります。</p>}
              </>)}
        </div>
      </div>
    </section>
  );
}
