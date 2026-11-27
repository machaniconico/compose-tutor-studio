import type { InstrumentConfig, InstrumentMacros, Track } from '@cts/project-model';
import { previewChord, previewNote } from '../../audio/livePreview';
import { NEUTRAL_MACROS } from '../../audio/macros';
import {
  PRESET_CATEGORY_LABELS,
  PRESET_LIST,
  type PresetCategory,
  type PresetInfo,
} from '../../audio/synth';
import { changeInstrumentMacros, changeInstrumentPreset } from '../../state/editorActions';
import { sliderUndoProps, useStore } from '../../state/store';

/** The four beginner macros with a short explanation each. */
const MACRO_CONTROLS: { key: keyof InstrumentMacros; label: string; help: string }[] = [
  { key: 'brightness', label: '明るさ', help: '高い音の成分。右ほどくっきり、左ほどこもった音。' },
  { key: 'release', label: '余韻', help: '鍵盤を離してから音が消えるまでの長さ。' },
  { key: 'width', label: '広がり', help: '左右の広さ。右ほど音が左右に散らばる。' },
  { key: 'attack', label: '立ち上がり', help: '音が出るまでの速さ。右ほどゆっくりふわっと鳴る。' },
];

const CATEGORY_ORDER: PresetCategory[] = ['keys', 'pad', 'bass', 'lead', 'other'];

/** Preview length when a preset or macro is tried, milliseconds. */
const TRY_DURATION_MS = 700;

/** Play a short sample of `instrument`: a chord for keys / pads, a single note otherwise. */
function tryInstrument(instrument: InstrumentConfig, category: PresetCategory | undefined): void {
  if (category === 'bass') {
    void previewNote(instrument, 40, undefined, TRY_DURATION_MS);
  } else if (category === 'keys' || category === 'pad') {
    void previewChord([60, 64, 67], instrument, undefined, TRY_DURATION_MS);
  } else {
    void previewNote(instrument, 67, undefined, TRY_DURATION_MS);
  }
}

function findPreset(id: string): PresetInfo | undefined {
  return PRESET_LIST.find((p) => p.id === id);
}

/**
 * Sound picker for one synth track: presets grouped by category (tried through
 * the live preview when chosen) and four simple macro sliders.
 */
export function InstrumentPicker({ track }: { track: Track }) {
  if (track.type === 'drum' || track.type === 'master') return null;
  const instrument = track.instrument ?? { type: 'synth', preset: 'warmPad' };
  const current = findPreset(instrument.preset);
  const macros = instrument.macros ?? NEUTRAL_MACROS;

  const choose = (id: string): void => {
    if (!changeInstrumentPreset(track.id, id)) return;
    tryInstrument({ ...instrument, type: 'synth', preset: id }, findPreset(id)?.category);
  };

  const setMacro = (key: keyof InstrumentMacros, value: number): void => {
    changeInstrumentMacros(track.id, { ...macros, [key]: value });
  };

  // After a slider drag, try the sound as it is now in the store.
  const tryLatest = (): void => {
    const latest = useStore.getState().project.tracks.find((t) => t.id === track.id)?.instrument;
    if (latest) tryInstrument(latest, findPreset(latest.preset)?.category);
  };

  return (
    <div className="instrument-picker" onClick={(e) => e.stopPropagation()}>
      <label className="instrument-picker__row">
        <span className="instrument-picker__label">音色</span>
        <select
          className="instrument-picker__select"
          value={instrument.preset}
          aria-label={`${track.name} の音色`}
          title={current?.description ?? '音色を選ぶと試しに鳴ります'}
          onChange={(e) => choose(e.target.value)}
        >
          {current ? null : <option value={instrument.preset}>いまの音色</option>}
          {CATEGORY_ORDER.map((category) => (
            <optgroup key={category} label={PRESET_CATEGORY_LABELS[category]}>
              {PRESET_LIST.filter((p) => p.category === category).map((p) => (
                <option key={p.id} value={p.id} title={p.description}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className="mini-btn"
          aria-label={`${track.name} の音色を試聴`}
          onClick={() => tryInstrument(instrument, current?.category)}
        >
          試聴
        </button>
      </label>
      {current ? <p className="instrument-picker__desc">{current.description}</p> : null}
      <details className="instrument-picker__macros">
        <summary>かんたん調整</summary>
        {MACRO_CONTROLS.map(({ key, label, help }) => (
          <label key={key} className="instrument-picker__macro">
            <span className="instrument-picker__macro-label">{label}</span>
            <input
              type="range"
              {...sliderUndoProps}
              min={0}
              max={1}
              step={0.01}
              value={macros[key]}
              aria-label={`${track.name} の${label}`}
              title={help}
              onChange={(e) => setMacro(key, Number(e.target.value))}
              onPointerUp={tryLatest}
            />
            <span className="instrument-picker__help">{help}</span>
          </label>
        ))}
        <button
          type="button"
          className="mini-btn"
          disabled={instrument.macros === undefined}
          onClick={() => changeInstrumentMacros(track.id, undefined)}
        >
          調整をリセット
        </button>
      </details>
    </div>
  );
}
