import { useEffect } from 'react';
import { useStore } from '../../state/store';
import type { MusicalKey, ScaleName } from '@cts/project-model';
import { formatPosition } from '../timeline';
import { initAudioBridge } from '../../audio/playback';

const KEYS: MusicalKey[] = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'F#'];

const SCALES: { value: ScaleName; label: string }[] = [
  { value: 'major', label: 'メジャー' },
  { value: 'naturalMinor', label: 'ナチュラルマイナー' },
  { value: 'harmonicMinor', label: 'ハーモニックマイナー' },
  { value: 'melodicMinor', label: 'メロディックマイナー' },
  { value: 'majorPentatonic', label: 'メジャーペンタ' },
  { value: 'minorPentatonic', label: 'マイナーペンタ' },
  { value: 'blues', label: 'ブルース' },
];

/** Top transport + project metadata bar. */
export function TransportBar() {
  const project = useStore((s) => s.project);
  const transport = useStore((s) => s.transport);
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

  // Connect the store to the audio engine once. The bridge subscribes to
  // transport.isPlaying so the play/stop buttons below only touch store state.
  useEffect(() => initAudioBridge(), []);

  const beatsPerBar = project.timeSignature[0];

  return (
    <header className="transport-bar">
      <div className="transport-bar__row">
        <button
          type="button"
          className={isPlaying ? 'is-active' : ''}
          aria-pressed={isPlaying}
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

        <button type="button" disabled={!canUndo} onClick={() => undo()}>
          元に戻す
        </button>
        <button type="button" disabled={!canRedo} onClick={() => redo()}>
          やり直す
        </button>

        <input
          className="transport-bar__title"
          aria-label="プロジェクト名"
          value={project.title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <button type="button" onClick={() => saveToLocalStorage()}>
          保存
        </button>

        <span className="save-indicator">
          更新: {new Date(project.updatedAt).toLocaleTimeString('ja-JP')}
        </span>
      </div>
    </header>
  );
}
