import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  textUndoProps,
  useStore,
  type SaveState,
  type Difficulty,
} from '../../state/store';
import { findShortcut, isEditableShortcutTarget, type ShortcutAction } from '../../state/keymap';
import type { MusicalKey, ScaleName } from '@cts/project-model';
import {
  beatsPerBar as beatsPerBarOf,
  MAX_SONG_BARS as MAX_LENGTH_BARS,
  MAX_SWING_PERCENT,
  maxSongBars,
  tapTempo,
} from '@cts/project-model';
import { pushToast } from '../../state/tutorialBridge';
import { formatPosition, keyboardSeekBeat } from '../timeline';
import { initAudioBridge, restartAt, startMidiRecording, stopMidiRecording } from '../../audio/playback';
import { recordingPhase, subscribeRecordingPhase } from '../../audio/recorder';
import { ProjectMenu } from '../projectMenu/ProjectMenu';
import { ExportMenu } from '../export/ExportMenu';
import { SupportMenu } from '../support/SupportMenu';
import { isAnyDialogOpen } from '../common/dialogState';
import { ShortcutHelpDialog } from '../common/ShortcutHelpDialog';
import { Dialog } from '../common/Dialog';
import { setSwing, transposeSongToKey, type RecordingSettings } from '../../state/editorActions';
import { keyShiftSemitones } from '@cts/theory-engine';

const KEYS: MusicalKey[] = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'F#'];

const DIFFICULTIES: { value: Difficulty; label: string }[] = [
  { value: 'beginner', label: '初級' },
  { value: 'standard', label: '標準' },
  { value: 'advanced', label: '上級' },
];

/**
 * Time signatures offered in the UI. 6/8 is computed correctly but stays hidden
 * until the metronome accent and drum patterns are tuned for it.
 */
export const TIME_SIGNATURES: { value: string; signature: [number, number]; label: string }[] = [
  { value: '4/4', signature: [4, 4], label: '4/4(1小節に4拍)' },
  { value: '3/4', signature: [3, 4], label: '3/4(1小節に3拍)' },
];

/** Song length limits for the bar-count input. */
export const MIN_LENGTH_BARS = 4;
export { MAX_LENGTH_BARS };

const SCALES: { value: ScaleName; label: string }[] = [
  { value: 'major', label: 'メジャー' },
  { value: 'naturalMinor', label: 'ナチュラルマイナー' },
  { value: 'harmonicMinor', label: 'ハーモニックマイナー' },
  { value: 'melodicMinor', label: 'メロディックマイナー' },
  { value: 'majorPentatonic', label: 'メジャーペンタ' },
  { value: 'minorPentatonic', label: 'マイナーペンタ' },
  { value: 'blues', label: 'ブルース' },
];

export type TransportShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'target'
> &
  Partial<Pick<KeyboardEvent, 'code' | 'defaultPrevented'>>;

type TransportShortcutActions = {
  isPlaying: boolean;
  play: () => void;
  redo: () => void;
  saveToLocalStorage: () => void;
  seek?: (action: 'seekToStart' | 'seekBarBack' | 'seekBarForward') => void;
  showShortcutHelp: () => void;
  stop: () => void;
  undo: () => void;
};

export { isEditableShortcutTarget } from '../../state/keymap';

export function getTransportShortcut(event: TransportShortcutEvent): ShortcutAction | null {
  if (event.defaultPrevented || isEditableShortcutTarget(event.target) || isAnyDialogOpen()) {
    return null;
  }
  return findShortcut('global', event);
}

export function handleTransportShortcutKeyDown(
  event: KeyboardEvent,
  actions: TransportShortcutActions,
): void {
  const shortcut = getTransportShortcut(event);
  if (!shortcut) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  if (shortcut === 'save') {
    actions.saveToLocalStorage();
  } else if (shortcut === 'togglePlayback') {
    if (actions.isPlaying) actions.stop();
    else actions.play();
  } else if (shortcut === 'undo') {
    actions.undo();
  } else if (shortcut === 'redo') {
    actions.redo();
  } else if (
    shortcut === 'seekToStart' ||
    shortcut === 'seekBarBack' ||
    shortcut === 'seekBarForward'
  ) {
    actions.seek?.(shortcut);
  } else if (shortcut === 'showShortcutHelp') {
    actions.showShortcutHelp();
  }
}

function formatSaveTime(value: string | null): string {
  if (!value) return '--:--:--';
  return new Date(value).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function saveIndicatorText(save: SaveState): string {
  if (save.status === 'saving') return '保存中...';
  if (save.status === 'error') return `保存失敗: ${save.errorMessage ?? 'もう一度保存してください。'}`;
  if (save.status === 'saved') return `保存済み ${formatSaveTime(save.lastSavedAt)}`;
  return '未保存';
}

/** A pause this long (ms) between taps starts a new tap-tempo run; 3000ms is 20 BPM. */
const TAP_RESET_MS = 3000;

/** Native button activation must reach the button without a global shortcut. */
function isTapActivation(event: Event, button: HTMLButtonElement | null): boolean {
  if (!(event.target instanceof Node) || !button?.contains(event.target)) return false;
  if (!(event instanceof KeyboardEvent)) return true;
  const plainKey = !event.ctrlKey && !event.metaKey && !event.altKey;
  return plainKey && (event.key === 'Enter' || event.key === ' ');
}

/** Top transport + project metadata bar. */
/** How a key change moves the song, for the dialog ("2 半音上へ"). */
function shiftLabel(semitones: number): string {
  if (semitones === 0) return '高さは変わりません';
  return semitones > 0 ? `${semitones} 半音上へ` : `${-semitones} 半音下へ`;
}

/**
 * 「曲全体を移調」: pick a new key; by default notes and chords move with it
 * (drum tracks never do). One undo step. A refusal shows its reason as a toast
 * and keeps the dialog open.
 */
function TransposeSongDialog({ currentKey, onClose }: { currentKey: MusicalKey; onClose: () => void }) {
  // The select starts on the 12-key option sounding like the saved key (F♯ → F#),
  // so what it shows is always the value held here. '' when the key cannot be read.
  const [startKey] = useState<MusicalKey | ''>(() => {
    try {
      return KEYS.find((k) => keyShiftSemitones(currentKey, k) === 0) ?? '';
    } catch {
      return '';
    }
  });
  const [key, setKey] = useState<MusicalKey | ''>(startKey);
  const [moveNotes, setMoveNotes] = useState(true);
  // A key the theory engine cannot read shows why here; "移調する" then reports it as a toast.
  let shift: string;
  try {
    shift = key === '' ? '新しいキーを選んでください' : shiftLabel(keyShiftSemitones(currentKey, key));
  } catch {
    shift = `今のキー「${currentKey}」を読み取れません`;
  }
  const onApply = (): void => {
    if (key !== '' && transposeSongToKey(key, moveNotes)) onClose();
  };
  return (
    <Dialog title="曲全体を移調" onClose={onClose}>
      <div className="transpose-song">
        <p className="transpose-song__lead">
          キーを変えると曲の高さ全体が変わります。歌いやすい高さを探すときに使います。
        </p>
        <div className="field">
          <label htmlFor="transpose-song-key">新しいキー</label>
          <select id="transpose-song-key" value={key} onChange={(e) => setKey(e.target.value as MusicalKey)}>
            {startKey === '' ? (
              <option value="" disabled>
                選んでください
              </option>
            ) : null}
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <label className="transpose-song__check">
          <input type="checkbox" checked={moveNotes} onChange={(e) => setMoveNotes(e.target.checked)} />
          ノートとコードも動かす
        </label>
        <p className="transpose-song__hint">
          {startKey === ''
            ? `今のキー「${currentKey}」を読み取れません。新しいキーを選ぶと、理由を表示します。`
            : moveNotes
            ? `${currentKey} → ${key}: ${shift}。ドラムのトラックは動きません。`
            : 'キーの設定だけを変えます。ノートとコードはそのままです。'}
        </p>
        <div className="transpose-song__actions">
          <button type="button" onClick={onClose}>
            やめる
          </button>
          <button type="button" disabled={key === '' || key === startKey} onClick={onApply}>
            移調する
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function TransportBar() {
  const project = useStore((s) => s.project);
  const maxLengthBars = maxSongBars(project);
  const transport = useStore((s) => s.transport);
  const save = useStore((s) => s.save);
  const isPlaying = transport.isPlaying;
  const phase = useSyncExternalStore(subscribeRecordingPhase, recordingPhase);
  const recordingActive = phase !== 'idle';
  const [recordingMode, setRecordingMode] = useState<RecordingSettings['mode']>('overdub');
  const [recordingGrid, setRecordingGrid] = useState<RecordingSettings['grid']>(0);
  const play = useStore((s) => s.play);
  const stop = useStore((s) => s.stop);
  const toggleLoop = useStore((s) => s.toggleLoop);
  const toggleMetronome = useStore((s) => s.toggleMetronome);
  const setBpm = useStore((s) => s.setBpm);
  const setKey = useStore((s) => s.setKey);
  const setScale = useStore((s) => s.setScale);
  const setTitle = useStore((s) => s.setTitle);
  const setTimeSignature = useStore((s) => s.setTimeSignature);
  const setLengthBars = useStore((s) => s.setLengthBars);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0 || s.transactionBase !== null);
  const canRedo = useStore((s) => s.future.length > 0);
  const saveToLocalStorage = useStore((s) => s.saveToLocalStorage);
  const difficulty = useStore((s) => s.editor.difficulty);
  const setDifficulty = useStore((s) => s.setDifficulty);
  const cancelTransaction = useStore((s) => s.cancelTransaction);
  const beginTransaction = useStore((s) => s.beginTransaction);
  const commitTransaction = useStore((s) => s.commitTransaction);
  const setLoopRange = useStore((s) => s.setLoopRange);
  const startScreenOpen = useStore((s) => s.startScreenOpen);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [transposeOpen, setTransposeOpen] = useState(false);
  // The bar-count input is committed on blur / Enter so a half-typed number
  // never triggers the "content will be deleted" confirmation.
  const [lengthDraft, setLengthDraft] = useState<string | null>(null);
  // Tap tempo: tap times of the current run. One run of taps is one undo step,
  // closed when the taps pause.
  const tapTimes = useRef<number[]>([]);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onTap = (): void => {
    const now = performance.now();
    const last = tapTimes.current[tapTimes.current.length - 1];
    if (last !== undefined && now - last > TAP_RESET_MS) tapTimes.current = [];
    tapTimes.current = [...tapTimes.current, now].slice(-5);
    if (tapTimer.current !== null) clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null;
      commitTransaction(tapTimes);
    }, TAP_RESET_MS);
    const bpm = tapTempo(tapTimes.current);
    if (bpm === null) return;
    beginTransaction(tapTimes);
    setBpm(bpm);
  };

  const tapButton = useRef<HTMLButtonElement | null>(null);

  // Any other click or key (Undo/Redo included) closes the tap run first, so
  // the next operation (a ruler drag, a clear, an edit) is its own undo step.
  // A window blur closes it too, keeping the tapped tempo. These listeners are
  // added before the shortcut and blur listeners below, so they run first.
  useEffect(() => {
    const closeTapRun = (): void => {
      if (tapTimer.current === null) return;
      clearTimeout(tapTimer.current);
      tapTimer.current = null;
      tapTimes.current = [];
      commitTransaction(tapTimes);
    };
    const onOtherInput = (event: Event): void => {
      if (!isTapActivation(event, tapButton.current)) closeTapRun();
    };
    window.addEventListener('pointerdown', onOtherInput, true);
    window.addEventListener('keydown', onOtherInput, true);
    window.addEventListener('blur', closeTapRun);
    return () => {
      window.removeEventListener('pointerdown', onOtherInput, true);
      window.removeEventListener('keydown', onOtherInput, true);
      window.removeEventListener('blur', closeTapRun);
      closeTapRun();
    };
  }, [commitTransaction]);

  const commitLengthBars = (): void => {
    if (lengthDraft === null) return;
    setLengthDraft(null);
    const parsed = Number.parseInt(lengthDraft, 10);
    if (!Number.isFinite(parsed)) return;
    const bars = Math.min(maxLengthBars, Math.max(MIN_LENGTH_BARS, parsed));
    const warning = setLengthBars(bars);
    if (warning !== null && window.confirm(warning)) setLengthBars(bars, true);
  };

  const onTimeSignatureChange = (value: string): void => {
    const option = TIME_SIGNATURES.find((t) => t.value === value);
    if (!option) return;
    let result = setTimeSignature(option.signature);
    if (result.confirm !== null) {
      if (!window.confirm(result.confirm)) return;
      result = setTimeSignature(option.signature, true);
    }
    for (const warning of result.warnings) pushToast(warning, 'info');
  };

  // Connect the store to the audio engine once. The bridge subscribes to
  // transport.isPlaying so the play/stop buttons below only touch store state.
  useEffect(() => initAudioBridge(), []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTapActivation(event, tapButton.current)) return;
      if ((event.key === ' ' || event.code === 'Space') &&
          event.target instanceof Element && event.target.closest('.live-input button, .transport-recording button')) return;
      handleTransportShortcutKeyDown(event, {
        isPlaying,
        play,
        redo,
        saveToLocalStorage,
        seek: (action) => {
          const { project: p, transport: t } = useStore.getState();
          const bpb = beatsPerBarOf(p.timeSignature);
          restartAt(keyboardSeekBeat(action, t.positionBeat, bpb, p.lengthBars * bpb));
        },
        // The start screen sits above dialogs, so help would open out of sight.
        showShortcutHelp: () => setShortcutHelpOpen(!startScreenOpen),
        stop,
        undo,
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isPlaying, play, redo, saveToLocalStorage, startScreenOpen, stop, undo]);

  // A pointer can be lost when the window loses focus, so an unfinished edit
  // is dropped rather than left open. Focused text inputs commit on their own
  // blur, which fires first.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onWindowBlur = (): void => cancelTransaction();
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [cancelTransaction]);

  const beatsPerBar = beatsPerBarOf(project.timeSignature);
  const timeSignatureValue = `${project.timeSignature[0]}/${project.timeSignature[1]}`;

  return (
    <header className="transport-bar">
      <div className="transport-bar__row">
        <ProjectMenu />

        <button
          type="button"
          className={isPlaying ? 'is-active' : ''}
          aria-pressed={isPlaying}
          title="再生/停止 (Space)"
          onClick={() => (isPlaying ? stop() : play())}
        >
          {isPlaying ? '一時停止' : '再生'}
        </button>

        <button
          type="button"
          aria-label="先頭へ戻す"
          disabled={isPlaying && transport.positionBeat === 0}
          onClick={() => stop(true)}
        >
          先頭へ
        </button>

        <button
          type="button"
          className={transport.loopEnabled ? 'is-active' : ''}
          aria-pressed={transport.loopEnabled}
          title="ループ範囲をくり返し再生します。範囲は定規を左右にドラッグして選べます"
          onClick={() => toggleLoop()}
        >
          ループ
        </button>

        {project.loopRange ? (
          <button
            type="button"
            title="定規で選んだループ範囲(くり返す小節)を消します"
            onClick={() => setLoopRange(null)}
          >
            ループ範囲をクリア
          </button>
        ) : null}

        <button
          type="button"
          className={transport.metronome ? 'is-active' : ''}
          aria-pressed={transport.metronome}
          onClick={() => toggleMetronome()}
        >
          メトロノーム
        </button>

        <div className="transport-recording">
          <button
            type="button"
            className={recordingActive ? 'is-active' : ''}
            aria-pressed={recordingActive}
            disabled={startScreenOpen}
            onClick={() => recordingActive
              ? stopMidiRecording()
              : startMidiRecording({ mode: recordingMode, grid: recordingGrid })}
          >
            {recordingActive ? '■ 録音を止める' : '● 録音'}
          </button>
          <label>
            録り方
            <select value={recordingMode} disabled={recordingActive}
              onChange={(event) => setRecordingMode(event.currentTarget.value === 'replace' ? 'replace' : 'overdub')}>
              <option value="overdub">重ね録り</option>
              <option value="replace">上書き</option>
            </select>
          </label>
          <label>
            音の位置を自動でそろえる
            <select value={recordingGrid} disabled={recordingActive}
              onChange={(event) => {
                const grid = Number(event.currentTarget.value);
                setRecordingGrid(grid === 0.25 || grid === 0.5 ? grid : 0);
              }}>
              <option value={0}>切</option>
              <option value={0.5}>8 分音符</option>
              <option value={0.25}>16 分音符</option>
            </select>
          </label>
          {recordingActive && <span role="status">
            {phase === 'count-in' ? 'カウントイン中。合図のあとに弾いてください。' : '録音中'}
          </span>}
        </div>

        <div className="position-display" aria-label="再生位置(小節.拍)" title="小節.拍">
          {formatPosition(transport.positionBeat, beatsPerBar)}
        </div>

        <div className="field">
          <label htmlFor="bpm-input">BPM</label>
          <input
            {...textUndoProps}
            id="bpm-input"
            type="number"
            min={20}
            max={300}
            value={project.bpm}
            onChange={(e) => setBpm(Number(e.target.value) || project.bpm)}
          />
          <button
            type="button"
            ref={tapButton}
            aria-label="タップテンポ"
            title="曲の速さに合わせて何回か押すと、その速さが BPM(1 分間の拍の数)になります"
            onClick={onTap}
          >
            タップ
          </button>
        </div>

        <div className="field">
          <label htmlFor="swing-input">スウィング</label>
          <input
            {...textUndoProps}
            id="swing-input"
            type="range"
            min={0}
            max={MAX_SWING_PERCENT}
            step={1}
            value={project.swing ?? 0}
            title="裏拍を少し遅らせて、はずむ感じにします(16 分音符の裏だけが遅れます)"
            onChange={(e) => setSwing(Number(e.target.value))}
          />
          <span className="swing-value" aria-hidden="true">{project.swing ?? 0}%</span>
        </div>

        <div className="field">
          <label htmlFor="time-signature-select">拍子</label>
          <select
            id="time-signature-select"
            value={timeSignatureValue}
            title="1小節に入る拍の数。音の位置(拍)はそのまま保たれます"
            onChange={(e) => onTimeSignatureChange(e.target.value)}
          >
            {TIME_SIGNATURES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="length-bars-input">小節数</label>
          <input
            id="length-bars-input"
            type="number"
            min={MIN_LENGTH_BARS}
            max={maxLengthBars}
            title={`曲の長さ(${MIN_LENGTH_BARS}〜${maxLengthBars}小節)。短くすると、はみ出した音は確認のうえ削除します`}
            value={lengthDraft ?? String(project.lengthBars)}
            onChange={(e) => setLengthDraft(e.target.value)}
            onBlur={commitLengthBars}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setLengthDraft(null);
            }}
          />
        </div>

        <div className="field">
          <label htmlFor="key-select">キー</label>
          <select
            id="key-select"
            value={project.key}
            onChange={(e) => setKey(e.target.value as MusicalKey)}
          >
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button
            type="button"
            title="キーを変えて、ノートとコードをまとめて高く・低くします(ドラムは動きません)"
            onClick={() => setTransposeOpen(true)}
          >
            曲全体を移調
          </button>
        </div>

        <div className="field">
          <label htmlFor="scale-select">スケール</label>
          <select
            id="scale-select"
            value={project.scale}
            onChange={(e) => setScale(e.target.value as ScaleName)}
          >
            {SCALES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field difficulty-switcher" role="group" aria-label="難易度">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.value}
              type="button"
              className={difficulty === d.value ? 'is-active' : ''}
              aria-pressed={difficulty === d.value}
              onClick={() => setDifficulty(d.value)}
            >
              {d.label}
            </button>
          ))}
        </div>

        <button type="button" disabled={!canUndo} title="元に戻す (Ctrl/Cmd+Z)" onClick={() => undo()}>
          元に戻す
        </button>
        <button
          type="button"
          disabled={!canRedo}
          title="やり直す (Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y)"
          onClick={() => redo()}
        >
          やり直す
        </button>

        <input
          {...textUndoProps}
          className="transport-bar__title"
          aria-label="プロジェクト名"
          value={project.title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <button type="button" title="保存 (Ctrl/Cmd+S)" onClick={() => saveToLocalStorage()}>
          保存
        </button>

        <ExportMenu />

        <SupportMenu />

        <button
          type="button"
          aria-label="キーボード操作の一覧を見る"
          title="キーボード操作の一覧 (?)"
          onClick={() => setShortcutHelpOpen(true)}
        >
          ？
        </button>

        <span
          className={`save-indicator save-indicator--${save.status}`}
          role={save.status === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {saveIndicatorText(save)}
        </span>
      </div>
      {shortcutHelpOpen ? <ShortcutHelpDialog onClose={() => setShortcutHelpOpen(false)} /> : null}
      {transposeOpen ? <TransposeSongDialog currentKey={project.key} onClose={() => setTransposeOpen(false)} /> : null}
    </header>
  );
}
