import { useEffect } from 'react';
import { useStore, type SaveState, type Difficulty } from '../../state/store';
import type { MusicalKey, ScaleName } from '@cts/project-model';
import { formatPosition } from '../timeline';
import { initAudioBridge } from '../../audio/playback';
import { ProjectMenu } from '../projectMenu/ProjectMenu';
import { ExportMenu } from '../export/ExportMenu';
import { SupportMenu } from '../support/SupportMenu';

const KEYS: MusicalKey[] = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'F#'];

const DIFFICULTIES: { value: Difficulty; label: string }[] = [
  { value: 'beginner', label: '初級' },
  { value: 'standard', label: '標準' },
  { value: 'advanced', label: '上級' },
];

const SCALES: { value: ScaleName; label: string }[] = [
  { value: 'major', label: 'メジャー' },
  { value: 'naturalMinor', label: 'ナチュラルマイナー' },
  { value: 'harmonicMinor', label: 'ハーモニックマイナー' },
  { value: 'melodicMinor', label: 'メロディックマイナー' },
  { value: 'majorPentatonic', label: 'メジャーペンタ' },
  { value: 'minorPentatonic', label: 'マイナーペンタ' },
  { value: 'blues', label: 'ブルース' },
];

export type TransportShortcut = 'save' | 'togglePlayback' | 'undo' | 'redo';

export type TransportShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'target'
> &
  Partial<Pick<KeyboardEvent, 'code' | 'defaultPrevented'>>;

type EditableTarget = EventTarget & {
  getAttribute?: (name: string) => string | null;
  isContentEditable?: boolean;
  parentElement?: EditableTarget | null;
  tagName?: string;
};

type TransportShortcutActions = {
  isPlaying: boolean;
  play: () => void;
  redo: () => void;
  saveToLocalStorage: () => void;
  stop: () => void;
  undo: () => void;
};

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  let element = target as EditableTarget | null;

  while (element) {
    const tagName = element.tagName?.toUpperCase();
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
    if (element.isContentEditable) return true;

    const contentEditable = element.getAttribute?.('contenteditable')?.toLowerCase();
    if (contentEditable === 'false') return false;
    if (contentEditable === '' || contentEditable === 'true' || contentEditable === 'plaintext-only') {
      return true;
    }

    element = element.parentElement ?? null;
  }

  return false;
}

export function getTransportShortcut(event: TransportShortcutEvent): TransportShortcut | null {
  if (event.defaultPrevented || isEditableShortcutTarget(event.target)) return null;

  const key = event.key.toLowerCase();
  const usesCommandKey = event.ctrlKey || event.metaKey;

  if (usesCommandKey) {
    if (key === 's') return 'save';
    if (!event.altKey && key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (!event.altKey && !event.shiftKey && key === 'y') return 'redo';
  }

  const isSpace =
    event.key === ' ' || event.key === 'Space' || event.key === 'Spacebar' || event.code === 'Space';
  if (!usesCommandKey && !event.altKey && !event.shiftKey && isSpace) return 'togglePlayback';

  return null;
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
  } else {
    actions.redo();
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

/** Top transport + project metadata bar. */
export function TransportBar() {
  const project = useStore((s) => s.project);
  const transport = useStore((s) => s.transport);
  const save = useStore((s) => s.save);
  const isPlaying = transport.isPlaying;
  const play = useStore((s) => s.play);
  const stop = useStore((s) => s.stop);
  const toggleLoop = useStore((s) => s.toggleLoop);
  const toggleMetronome = useStore((s) => s.toggleMetronome);
  const setBpm = useStore((s) => s.setBpm);
  const setKey = useStore((s) => s.setKey);
  const setScale = useStore((s) => s.setScale);
  const setTitle = useStore((s) => s.setTitle);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const saveToLocalStorage = useStore((s) => s.saveToLocalStorage);
  const difficulty = useStore((s) => s.editor.difficulty);
  const setDifficulty = useStore((s) => s.setDifficulty);

  // Connect the store to the audio engine once. The bridge subscribes to
  // transport.isPlaying so the play/stop buttons below only touch store state.
  useEffect(() => initAudioBridge(), []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      handleTransportShortcutKeyDown(event, {
        isPlaying,
        play,
        redo,
        saveToLocalStorage,
        stop,
        undo,
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isPlaying, play, redo, saveToLocalStorage, stop, undo]);

  const beatsPerBar = project.timeSignature[0];

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
          onClick={() => toggleLoop()}
        >
          ループ
        </button>

        <button
          type="button"
          className={transport.metronome ? 'is-active' : ''}
          aria-pressed={transport.metronome}
          onClick={() => toggleMetronome()}
        >
          メトロノーム
        </button>

        <div className="position-display" aria-label="再生位置">
          {formatPosition(transport.positionBeat, beatsPerBar)}
        </div>

        <div className="field">
          <label htmlFor="bpm-input">BPM</label>
          <input
            id="bpm-input"
            type="number"
            min={20}
            max={300}
            value={project.bpm}
            onChange={(e) => setBpm(Number(e.target.value) || project.bpm)}
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

        <span
          className={`save-indicator save-indicator--${save.status}`}
          role={save.status === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {saveIndicatorText(save)}
        </span>
      </div>
    </header>
  );
}
