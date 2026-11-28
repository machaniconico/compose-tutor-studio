import { useMemo, useState } from 'react';
import type { CompingPattern } from '@cts/theory-engine';
import { STUDIO_SYNTH_PRESETS } from '../tracklist/trackPresentation';
import {
  COMPING_DEFAULT_PRESET,
  COMPING_PATTERN_OPTIONS,
  COMPING_REGISTER_OPTIONS,
  generateCompingClip,
  projectBarCount,
} from '../../state/compingGeneration';
import { useStore } from '../../state/store';

/** 伴奏パターン: コードトラックから、選んだ楽器トラックの小節範囲へ新しいクリップを作る。 */
export function CompingAssistant() {
  const project = useStore((s) => s.project);
  const barCount = useMemo(() => projectBarCount(project), [project]);
  const [preset, setPreset] = useState(COMPING_DEFAULT_PRESET);
  const [startBar, setStartBar] = useState(1);
  const [endBar, setEndBar] = useState(Math.max(1, Math.min(4, barCount)));
  const [pattern, setPattern] = useState<CompingPattern>('whole');
  const [register, setRegister] = useState(55);
  const [voiceLeading, setVoiceLeading] = useState(true);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const onGenerate = () => {
    const result = generateCompingClip({ preset, startBar, endBar, pattern, register, voiceLeading });
    setMessage(result.ok ? { ok: true, text: result.message } : { ok: false, text: result.reason });
  };

  const parseBar = (value: string, fallback: number) => {
    const bar = Number.parseInt(value, 10);
    return Number.isSafeInteger(bar) ? bar : fallback;
  };

  return (
    <section className="panel-section" aria-label="伴奏パターン">
      <p className="panel-section__title">伴奏パターン</p>
      {barCount > 0 ? (
        <>
          <p className="assistant__hint">
            コードトラックから、新しいトラック「伴奏」を作り、選んだ小節の範囲に伴奏を入れます。いまのトラックには触れません。
          </p>
          <div className="assistant__comping-form">
            <label>
              音色
              <select value={preset} onChange={(event) => setPreset(event.target.value)}>
                {STUDIO_SYNTH_PRESETS.map((option) => (
                  <option key={option.name} value={option.name}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              はじめの小節
              <input
                type="number"
                min={1}
                max={Math.max(1, barCount)}
                value={startBar}
                onChange={(event) => setStartBar(parseBar(event.target.value, startBar))}
              />
            </label>
            <label>
              おわりの小節
              <input
                type="number"
                min={1}
                max={Math.max(1, barCount)}
                value={endBar}
                onChange={(event) => setEndBar(parseBar(event.target.value, endBar))}
              />
            </label>
            <label>
              音域
              <select value={register} onChange={(event) => setRegister(Number(event.target.value))}>
                {COMPING_REGISTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="assistant__modes" role="group" aria-label="伴奏パターン">
            {COMPING_PATTERN_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`assistant__mode${pattern === option.value ? ' is-active' : ''}`}
                aria-pressed={pattern === option.value}
                onClick={() => setPattern(option.value)}
                title={option.hint}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="assistant__hint">{COMPING_PATTERN_OPTIONS.find((option) => option.value === pattern)?.hint}</p>
          <label className="assistant__comping-check">
            <input
              type="checkbox"
              checked={voiceLeading}
              onChange={(event) => setVoiceLeading(event.target.checked)}
            />
            前のコードから近い音でつなぐ
          </label>
          <button type="button" className="assistant__generate" onClick={onGenerate}>
            伴奏を作る
          </button>
          {message ? (
            <p
              className={`assistant__comping-message${message.ok ? '' : ' is-error'}`}
              role={message.ok ? 'status' : 'alert'}
            >
              {message.text}
            </p>
          ) : null}
        </>
      ) : (
        <p className="empty-hint">曲の長さが読み取れないため、伴奏を作れません。</p>
      )}
    </section>
  );
}
