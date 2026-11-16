import { useEffect, useRef, useState } from 'react';
import { getAudioEngine } from '../../audio/engine';
import { spectrumBars } from '../../audio/metering';

const BAR_COUNT = 24;
const SILENT_BARS: number[] = Array.from({ length: BAR_COUNT }, () => 0);

/**
 * Optional master spectrum view. Off by default: the AnalyserNode is only
 * created and connected while the toggle is on (see AudioEngine).
 */
export function SpectrumView() {
  const [enabled, setEnabled] = useState(false);
  const [bars, setBars] = useState<number[]>(SILENT_BARS);
  const binsRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    const engine = getAudioEngine();
    engine.setSpectrumEnabled(enabled);
    if (!enabled) {
      setBars(SILENT_BARS);
      return undefined;
    }

    let frame = 0;
    let active = true;
    const tick = () => {
      const analyser = engine.getSpectrumAnalyser();
      if (analyser) {
        let bins = binsRef.current;
        if (!bins || bins.length !== analyser.frequencyBinCount) {
          bins = new Uint8Array(analyser.frequencyBinCount);
          binsRef.current = bins;
        }
        analyser.getByteFrequencyData(bins);
        setBars(spectrumBars(bins, BAR_COUNT));
      }
      if (active) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      engine.setSpectrumEnabled(false);
    };
  }, [enabled]);

  return (
    <div className="spectrum-view">
      <label className="spectrum-view__toggle">
        <input
          type="checkbox"
          checked={enabled}
          aria-label="スペクトラム表示"
          onChange={(event) => setEnabled(event.target.checked)}
        />
        スペクトラム(低い音〜高い音の量)
      </label>
      {enabled ? (
        <div
          className="spectrum-view__bars"
          role="img"
          aria-label="全体の音の高さごとの量。左が低い音、右が高い音です"
        >
          {bars.map((value, index) => (
            <span
              // Fixed-length bar list; position is the identity.
              key={index}
              className="spectrum-view__bar"
              style={{ transform: `scaleY(${value})` }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
