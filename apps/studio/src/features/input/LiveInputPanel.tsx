import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PPQ } from '@cts/project-model';
import { nearestScalePitch, transposeByDegree } from '@cts/theory-engine';
import { getAudioEngine } from '../../audio/engine';
import { allNotesOff, noteOff, noteOn } from '../../audio/livePreview';
import { captureLastPerformance, captureLiveNote, recordingTrackId, stopMidiRecording } from '../../audio/playback';
import { recordingPhase, subscribeRecordingPhase } from '../../audio/recorder';
import { listenForMidiInput, requestWebMidi, supportsWebMidi } from '../../platform/webMidi';
import { prepareStepInput, writeStepInputChord, type StepInputPosition } from '../../state/editorActions';
import { findShortcut, isEditableShortcutTarget } from '../../state/keymap';
import { useStore } from '../../state/store';
import { pushToast } from '../../state/tutorialBridge';
import { isAnyDialogOpen } from '../common/dialogState';
import { ignoreKeyboardEvent, keyboardInput } from './keyboardMap';

const MIDI_CHANNELS = Array.from({ length: 16 }, (_, index) => index + 1);
const NO_MIDI = 'この環境では MIDI 鍵盤を使えません。PC キーボードで演奏できます';
const AUDIO_ERROR = '音を鳴らせませんでした。音の出力先と音量を確認して、もう一度キーを押してください。';

type MidiSession =
  | { status: 'unsupported' | 'idle' | 'pending' | 'failed' }
  | { status: 'ready'; access: MIDIAccess };

type StepInputSession = {
  cursor?: number;
  chord?: { position: StepInputPosition; pitches: Map<number, number> };
};

function startNote(
  held: Map<string, number>, key: string, pitch: number, timeStamp: number,
  onPitch: (pitch: number, velocity: number) => void, velocity?: number,
) {
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
  onPitch(pitch, velocity ?? 100);
  if (alreadySounding) return;
  // During a take, monitor with the recording track's instrument, not the selection.
  const monitorTrackId = recordingTrackId() ?? editor.selectedTrackId;
  const instrument = project.tracks.find((track) => track.id === monitorTrackId)?.instrument;
  const played = velocity === undefined ? noteOn(pitch, instrument) : noteOn(pitch, instrument, velocity);
  captureLiveNote(pitch, true, velocity, timeStamp);
  void played.catch(() => pushToast(AUDIO_ERROR, 'error'));
}

function releaseNote(held: Map<string, number>, key: string, timeStamp?: number) {
  const pitch = held.get(key);
  if (pitch === undefined) return false;
  held.delete(key);
  // Different keys, including MIDI and PC keys, can share one preview voice.
  if (![...held.values()].includes(pitch)) {
    captureLiveNote(pitch, false, undefined, timeStamp);
    noteOff(pitch);
  }
  return true;
}

export function LiveInputPanel() {
  const liveInputEnabled = useStore((state) => state.editor.liveInputEnabled);
  const liveInputOctave = useStore((state) => state.editor.liveInputOctave);
  const liveInputScaleLock = useStore((state) => state.editor.liveInputScaleLock);
  const toggleLiveInput = useStore((state) => state.toggleLiveInput);
  const toggleScaleLock = useStore((state) => state.toggleLiveInputScaleLock);
  const heldNotes = useRef(new Map<string, number>());
  const step = useRef<StepInputSession | null>(null);
  const [stepEnabled, setStepEnabled] = useState(false);
  const [cursor, setCursor] = useState<number>();
  const recordingActive = useSyncExternalStore(subscribeRecordingPhase, recordingPhase) !== 'idle';

  const midiFocused = useRef(true);
  const [midiSession, setMidiSession] = useState<MidiSession>(() => ({
    status: supportsWebMidi() ? 'idle' : 'unsupported',
  }));
  const midiStatus = midiSession.status;
  const midiAccess = midiStatus === 'ready' ? midiSession.access : null;
  const [midiInputs, setMidiInputs] = useState<MIDIInput[]>([]);
  const [midiChannel, setMidiChannel] = useState(1);

  function toggleStepInput() {
    if (recordingPhase() !== 'idle') return;
    finishStepChord();
    step.current = step.current ? null : {};
    setStepEnabled(step.current !== null);
    setCursor(undefined);
    if (step.current && !useStore.getState().editor.liveInputEnabled) toggleLiveInput();
  }

  const addStepPitch = useCallback((pitch: number, velocity: number) => {
    const session = step.current;
    if (!session || recordingPhase() !== 'idle') return;
    if (!session.chord) {
      const position = prepareStepInput(session.cursor);
      if (!position) return;
      session.chord = { position, pitches: new Map() };
      session.cursor = position.nextTick;
      setCursor(session.cursor);
    }
    if (!session.chord.pitches.has(pitch)) session.chord.pitches.set(pitch, velocity);
  }, []);

  const finishStepChord = useCallback(() => {
    const session = step.current;
    const chord = session?.chord;
    if (!session || !chord) return;
    session.chord = undefined;
    writeStepInputChord(chord.position, chord.pitches);
  }, []);

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

    function stopPlaying(keepInput = true) {
      if (keepInput) {
        finishStepChord();
        for (const pitch of new Set(held.values())) captureLiveNote(pitch, false);
      }
      held.clear();
      allNotesOff();
    }

    function onKeyDown(event: KeyboardEvent) {
      const { editor, startScreenOpen, setLiveInputOctave } = useStore.getState();
      if (!editor.liveInputEnabled || startScreenOpen || isAnyDialogOpen() || event.defaultPrevented ||
          isEditableShortcutTarget(event.target) || isEditableShortcutTarget(document.activeElement)) return;

      const session = step.current;
      if (session && recordingPhase() === 'idle' && !ignoreKeyboardEvent(event) &&
          findShortcut('liveInput', event) === 'stepInputRest') {
        event.preventDefault();
        const position = prepareStepInput(session.cursor);
        if (position) {
          session.cursor = position.nextTick;
          setCursor(session.cursor);
        }
        return;
      }

      const input = keyboardInput(event, editor.liveInputOctave);
      if (!input) return;
      event.preventDefault();
      if (input.type === 'octave') {
        setLiveInputOctave(input.octave);
        return;
      }
      startNote(held, event.code, input.pitch, event.timeStamp, addStepPitch);
    }

    function onKeyUp(event: KeyboardEvent) {
      // keyup は repeat しない。IME が途中で入って 'Process' / isComposing の keyup になっても、
      // 押していたキーの音は必ず止める(鳴りっぱなし防止)。
      if (releaseNote(held, event.code, event.timeStamp)) finishStepChord();
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
      if (previous.projectOpenVersion !== state.projectOpenVersion) {
        step.current = null;
        setStepEnabled(false);
        setCursor(undefined);
        stopPlaying(false);
      } else if (previous.editor.liveInputEnabled && !state.editor.liveInputEnabled) {
        stopPlaying();
        step.current = null;
        setStepEnabled(false);
        setCursor(undefined);
      } else if (step.current && (previous.editor.selectedClipId !== state.editor.selectedClipId ||
                 previous.editor.selectedTrackId !== state.editor.selectedTrackId)) {
        step.current = {};
        setCursor(undefined);
      }
    });
    const unsubscribeRecording = subscribeRecordingPhase(() => {
      const phase = recordingPhase();
      if (phase === 'idle') stopPlaying(false);
      if (phase === 'count-in' && step.current?.chord) {
        step.current.cursor = step.current.chord.position.tick;
        step.current.chord = undefined;
        setCursor(step.current.cursor);
      }
    });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      stopMidiRecording();
      unsubscribeRecording();
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('focusin', onFocusIn, true);
      stopPlaying();
    };
  }, [addStepPitch, finishStepChord]);

  useEffect(() => {
    if (!midiAccess) return;
    const held = heldNotes.current;

    function stopMidi() {
      for (const key of held.keys()) {
        if (key.startsWith('midi:') && releaseNote(held, key)) finishStepChord();
      }
    }

    const unlisten = listenForMidiInput(midiAccess, midiChannel, {
      onInputsChanged: setMidiInputs,
      onDisconnect: stopMidi,
      onNote(deviceId, note, timeStamp) {
        const key = `midi:${deviceId}:${note.pitch}`;
        if (note.type === 'noteOff') {
          if (releaseNote(held, key, timeStamp)) finishStepChord();
          return;
        }
        const { editor, startScreenOpen } = useStore.getState();
        if (!editor.liveInputEnabled || !midiFocused.current || document.hidden ||
            startScreenOpen || isAnyDialogOpen()) return;
        startNote(held, key, note.pitch, timeStamp, addStepPitch, note.velocity);
      },
    });
    return () => {
      unlisten();
      stopMidi();
    };
  }, [addStepPitch, finishStepChord, midiAccess, midiChannel]);

  return (
    <section className="live-input" aria-label="PCキーボード演奏">
      <div className="live-input__controls">
        <button type="button" aria-pressed={liveInputEnabled} onClick={toggleLiveInput}>
          PC で演奏<span aria-hidden="true"> {liveInputEnabled ? 'オン' : 'オフ'}</span>
        </button>
        <button type="button" aria-pressed={stepEnabled && !recordingActive}
          aria-describedby={stepEnabled && !recordingActive ? 'live-input-step-help' : undefined}
          disabled={recordingActive} onClick={toggleStepInput}>
          ステップ入力
        </button>
        <button type="button" disabled={recordingActive} onClick={captureLastPerformance}>
          今の演奏を拾う
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
      {stepEnabled && !recordingActive && (
        <p id="live-input-step-help">
          音を押すと、ピアノロールのグリッドの長さで入ります。同じ位置に音を重ねるには、一緒に押してください。
          休符を入れるには「.」を押します。
          {cursor !== undefined && <> 次の入力位置は曲の先頭から {(cursor / PPQ).toLocaleString('ja-JP', { maximumFractionDigits: 3 })} 拍です。</>}
        </p>
      )}
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
