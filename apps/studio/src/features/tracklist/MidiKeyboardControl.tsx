import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../state/store";
import {
  holdNote,
  releaseHeldNote,
  releaseHeldNotesMatching,
  stopPreview,
} from "../../audio/livePreview";
import {
  MIDI_DENIED_MESSAGE,
  MIDI_UNSUPPORTED_MESSAGE,
  listenForMidi,
  requestWebMidi,
  supportsWebMidi,
  type MidiInputInfo,
  type MidiListening,
} from "../../platform/webMidi";

const DEVICE_PREF_KEY = "cts.midiInputName";
const ALL_DEVICES = "";
/** Only MIDI-held notes carry this id prefix; PC keys use their event.code. */
const MIDI_ID_PREFIX = "midi:";
// Choice values: '' = all, 'n:<port name>' (remembered), 'i:<port id>' (this session only).

function readPref(): string {
  try {
    const name = globalThis.localStorage?.getItem(DEVICE_PREF_KEY);
    return name ? `n:${name}` : ALL_DEVICES;
  } catch {
    return ALL_DEVICES;
  }
}

/** Remember only a non-empty port name; never a port id. */
function writePref(choice: string): void {
  if (!choice.startsWith("n:") || choice.length <= 2) return;
  try {
    globalThis.localStorage?.setItem(DEVICE_PREF_KEY, choice.slice(2));
  } catch {
    // UI preference only; storage may be unavailable.
  }
}

/** Compact "MIDI keyboard" entry in the track-list header. Held notes share the live preview with the PC keyboard. */
export function MidiKeyboardControl() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [inputs, setInputs] = useState<MidiInputInfo[]>([]);
  const [active, setActive] = useState(false);
  const [choice, setChoice] = useState(readPref);
  const choiceRef = useRef(choice);
  const listeningRef = useRef<MidiListening | null>(null);
  /** Bumped by every enable/disable/unmount so a late permission grant installs nothing. */
  const epochRef = useRef(0);
  const recordingBusy = useStore(
    (s) =>
      s.audioRecordingOperationId !== null ||
      s.automationRecording.ownership !== null,
  );

  choiceRef.current = choice;

  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect)
        setAnchor({
          top: rect.bottom + 4,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 236)),
        });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const teardown = () => {
    epochRef.current += 1;
    listeningRef.current?.stop();
    listeningRef.current = null;
    releaseHeldNotesMatching(MIDI_ID_PREFIX);
  };

  useEffect(() => () => teardown(), []);
  useEffect(() => {
    if (recordingBusy && listeningRef.current) stopPreview();
  }, [recordingBusy]);

  const enable = async () => {
    if (!supportsWebMidi()) {
      setMessage(MIDI_UNSUPPORTED_MESSAGE);
      return;
    }
    const epoch = ++epochRef.current;
    const result = await requestWebMidi();
    if (epoch !== epochRef.current) return;
    if (result.status === "unsupported") setMessage(MIDI_UNSUPPORTED_MESSAGE);
    else if (result.status === "denied") setMessage(MIDI_DENIED_MESSAGE);
    else {
      teardown();
      listeningRef.current = listenForMidi(
        result.access,
        (info) => {
          const c = choiceRef.current;
          return (
            c === ALL_DEVICES || c === `n:${info.name}` || c === `i:${info.id}`
          );
        },
        {
          onInputsChanged: (list) => {
            setInputs(list);
            setMessage(
              list.length === 0
                ? "MIDI キーボードが見つかりません。つないでから少し待ってください"
                : null,
            );
          },
          onDisconnect: () => releaseHeldNotesMatching(MIDI_ID_PREFIX),
          onNote: (inputId, note) => {
            // One id per device, channel and key: held independently, and never clashes with PC-key ids (event.code).
            const id = `${MIDI_ID_PREFIX}${inputId}:${note.channel}:${note.pitch}`;
            if (note.type === "noteOff") {
              releaseHeldNote(id);
              return;
            }
            const state = useStore.getState();
            const track = state.project.tracks.find(
              (t) => t.id === state.editor.selectedTrackId,
            );
            if (!track || track.type !== "instrument") return;
            holdNote(id, track.instrument, note.pitch, note.velocity);
          },
        },
      );
      setActive(true);
    }
  };

  const disable = () => {
    teardown();
    setActive(false);
    setInputs([]);
    setMessage(null);
  };

  return (
    <div className="pr__popover-anchor midi-keyboard">
      <button
        type="button"
        ref={buttonRef}
        className={
          active
            ? "pr__icon-btn midi-keyboard__toggle is-active"
            : "pr__icon-btn midi-keyboard__toggle"
        }
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        MIDI
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            className="pr__popover midi-keyboard__panel"
            style={{ top: anchor.top, left: anchor.left }}
            role="group"
            aria-label="MIDI キーボード"
          >
            {!active ? (
              <button type="button" onClick={() => void enable()}>
                MIDI キーボードを使う
              </button>
            ) : (
              <>
                <label>
                  入力
                  <select
                    value={choice}
                    onChange={(e) => {
                      setChoice(e.target.value);
                      choiceRef.current = e.target.value;
                      writePref(e.target.value);
                      listeningRef.current?.resetParsers();
                    }}
                  >
                    <option value={ALL_DEVICES}>すべて</option>
                    {inputs.map((input) => (
                      <option
                        key={input.id}
                        value={input.name ? `n:${input.name}` : `i:${input.id}`}
                      >
                        {input.name || "名前のない MIDI 入力"}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={disable}>
                  使うのをやめる
                </button>
              </>
            )}
            {message && <p role="status">{message}</p>}
            {active && (
              <p className="midi-keyboard__hint">
                選んだ楽器トラックの音が、鍵盤を押している間だけ鳴ります(録音はまだできません)。
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
