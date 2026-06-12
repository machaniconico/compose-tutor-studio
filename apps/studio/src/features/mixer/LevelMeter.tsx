import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  METER_FLOOR_DB,
  isClipPeak,
  meterFillFromDb,
  peakDbFromSamples,
} from '../../audio/metering';
import { getAudioEngine } from '../../audio/engine';
import { getTrackAnalyser } from '../../audio/graph';

const DECAY_DB_PER_FRAME = 4;

export type LevelMeterSource =
  | { kind: 'master' }
  | { kind: 'track'; trackId: string };

export type LevelMeterReading = {
  peakDb: number;
  displayDb: number;
  fill: number;
  clipping: boolean;
};

type MeterState = LevelMeterReading;

type LevelMeterProps = {
  label: string;
  source: LevelMeterSource;
  onLevelChange?: (reading: LevelMeterReading) => void;
};

const SILENT_STATE: MeterState = {
  peakDb: Number.NEGATIVE_INFINITY,
  displayDb: Number.NEGATIVE_INFINITY,
  fill: 0,
  clipping: false,
};

export function LevelMeter({ label, source, onLevelChange }: LevelMeterProps) {
  const [meter, setMeter] = useState<MeterState>(SILENT_STATE);
  const meterRef = useRef<MeterState>(SILENT_STATE);
  const bufferRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const lastReportRef = useRef<LevelMeterReading>(SILENT_STATE);
  const sourceKind = source.kind;
  const sourceKey = source.kind === 'master' ? 'master' : source.trackId;

  const ariaValueNow = Number.isFinite(meter.displayDb)
    ? Math.max(METER_FLOOR_DB, Math.min(0, meter.displayDb))
    : METER_FLOOR_DB;
  const readout = useMemo(() => formatDb(meter.displayDb), [meter.displayDb]);

  useEffect(() => {
    let frame = 0;
    let active = true;

    const tick = () => {
      const analyser = resolveAnalyser(sourceKind, sourceKey);
      const peakDb = analyser ? readAnalyserPeakDb(analyser, bufferRef) : Number.NEGATIVE_INFINITY;
      const clipping = isClipPeak(peakDb);
      const current = meterRef.current;
      const displayDb = decayDisplayDb(current.displayDb, peakDb);
      const fill = meterFillFromDb(displayDb);
      const next = { peakDb, displayDb, fill, clipping };
      const previousReport = lastReportRef.current;
      if (shouldReport(previousReport, next)) {
        lastReportRef.current = next;
        onLevelChange?.(next);
      }
      if (!sameMeterState(current, next)) {
        meterRef.current = next;
        setMeter(next);
      }

      if (active) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [onLevelChange, sourceKind, sourceKey]);

  return (
    <div
      className={`level-meter${meter.clipping ? ' is-clipping' : ''}`}
      role="meter"
      aria-label={`${label} レベル`}
      aria-valuemin={METER_FLOOR_DB}
      aria-valuemax={0}
      aria-valuenow={ariaValueNow}
      aria-valuetext={readout}
    >
      <div className="level-meter__rail" aria-hidden="true">
        <span
          className="level-meter__fill"
          style={{ transform: `scaleY(${meter.fill})` }}
        />
      </div>
      <span className="level-meter__readout">{readout}</span>
    </div>
  );
}

function resolveAnalyser(sourceKind: LevelMeterSource['kind'], sourceKey: string): AnalyserNode | null {
  if (sourceKind === 'master') {
    return getAudioEngine().getMasterAnalyser();
  }
  return getTrackAnalyser(sourceKey);
}

function readAnalyserPeakDb(
  analyser: AnalyserNode,
  bufferRef: MutableRefObject<Float32Array<ArrayBuffer> | null>,
): number {
  let buffer = bufferRef.current;
  if (!buffer || buffer.length !== analyser.fftSize) {
    buffer = new Float32Array(analyser.fftSize);
    bufferRef.current = buffer;
  }
  analyser.getFloatTimeDomainData(buffer);
  return peakDbFromSamples(buffer);
}

function decayDisplayDb(currentDb: number, targetDb: number): number {
  if (!Number.isFinite(targetDb)) {
    if (!Number.isFinite(currentDb)) return Number.NEGATIVE_INFINITY;
    const next = currentDb - DECAY_DB_PER_FRAME;
    return next <= METER_FLOOR_DB ? Number.NEGATIVE_INFINITY : next;
  }
  if (!Number.isFinite(currentDb) || targetDb >= currentDb) return targetDb;
  return Math.max(targetDb, currentDb - DECAY_DB_PER_FRAME);
}

function shouldReport(previous: LevelMeterReading, next: LevelMeterReading): boolean {
  if (previous.clipping !== next.clipping) return true;
  if (!Number.isFinite(previous.displayDb) && !Number.isFinite(next.displayDb)) return false;
  return Math.abs(previous.displayDb - next.displayDb) >= 0.5;
}

function sameMeterState(previous: MeterState, next: MeterState): boolean {
  return (
    previous.clipping === next.clipping &&
    previous.fill === next.fill &&
    previous.peakDb === next.peakDb &&
    previous.displayDb === next.displayDb
  );
}

function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '-∞';
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}
