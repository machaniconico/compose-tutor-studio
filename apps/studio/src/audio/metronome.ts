// Metronome click voice.
//
// A short filtered sine "tick", brighter and louder on the first beat of each
// bar (the accent). The metronome bypasses the per-track mix and connects
// straight to the master bus so it is always audible and never recorded into
// the WAV render (the render simply never schedules it).

import type { MusicalTimeIndex } from '@cts/project-model';
import type { LoopRegion } from './scheduler';

/** A metronome click resolved to a beat position. */
export type MetronomeClick = {
  beat: number;
  /** True on the first beat of a bar. */
  accent: boolean;
};

export type ScheduledMetronomeClick = {
  /** Stop a future/in-flight click and disconnect every node. Idempotent. */
  cancel: () => void;
};

/**
 * Enumerate metronome clicks across a beat range `[fromBeat, toBeat)`.
 * Clicks land on whole beats; the accent is the first beat of each bar.
 *
 * Pure: useful for both live scheduling and tests.
 */
export function metronomeBeatEvents(
  fromBeat: number,
  toBeat: number,
  beatsPerBar: number,
): MetronomeClick[] {
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const clicks: MetronomeClick[] = [];
  // `|| 0` normalises a -0 result (e.g. Math.ceil(-1e-9)) to +0.
  const first = Math.ceil(fromBeat - 1e-9) || 0;
  for (let beat = first; beat < toBeat; beat += 1) {
    const accent = ((beat % bpb) + bpb) % bpb === 0;
    clicks.push({ beat, accent });
  }
  return clicks;
}

function metronomeMapEventsOnce(
  index: MusicalTimeIndex,
  fromBeat: number,
  toBeat: number,
): MetronomeClick[] {
  const clicks: MetronomeClick[] = [];
  for (const segment of index.timeSignatureSegments) {
    const rangeStart = Math.max(fromBeat, segment.startBeat);
    const rangeEnd = Math.min(toBeat, segment.endBeat);
    if (rangeEnd <= rangeStart) continue;

    const beatUnit = 4 / segment.denominator;
    const firstUnit = Math.max(
      0,
      Math.ceil((rangeStart - segment.startBeat) / beatUnit - 1e-9),
    );
    for (
      let unit = firstUnit, beat = segment.startBeat + firstUnit * beatUnit;
      beat < rangeEnd;
      unit += 1, beat = segment.startBeat + unit * beatUnit
    ) {
      clicks.push({
        beat,
        accent: unit % segment.numerator === 0,
      });
    }
  }
  return clicks;
}

/** Enumerate denominator-beat clicks across a changing meter, including loops. */
export function metronomeMapEvents(
  index: MusicalTimeIndex,
  fromBeat: number,
  toBeat: number,
  loop: LoopRegion | null = null,
): MetronomeClick[] {
  if (!(toBeat > fromBeat)) return [];
  if (!loop || !(loop.endBeat > loop.startBeat)) {
    return metronomeMapEventsOnce(index, fromBeat, toBeat);
  }

  const clicks: MetronomeClick[] = [];
  if (fromBeat < loop.startBeat) {
    clicks.push(...metronomeMapEventsOnce(
      index,
      fromBeat,
      Math.min(toBeat, loop.startBeat),
    ));
  }
  if (toBeat <= loop.startBeat) return clicks;

  const loopLength = loop.endBeat - loop.startBeat;
  const firstCycle = Math.floor(
    (Math.max(fromBeat, loop.startBeat) - loop.startBeat) / loopLength,
  );
  const endCycle = Math.ceil((toBeat - loop.startBeat) / loopLength);
  for (let cycle = firstCycle; cycle < endCycle; cycle += 1) {
    const offset = cycle * loopLength;
    const sourceStart = Math.max(loop.startBeat, fromBeat - offset);
    const sourceEnd = Math.min(loop.endBeat, toBeat - offset);
    for (const click of metronomeMapEventsOnce(index, sourceStart, sourceEnd)) {
      clicks.push({ ...click, beat: click.beat + offset });
    }
  }
  return clicks;
}

/** Schedule one metronome click at an absolute audio time. */
export function scheduleMetronomeClick(
  ctx: BaseAudioContext,
  output: AudioNode,
  time: number,
  accent: boolean,
  onEnded?: () => void,
): ScheduledMetronomeClick {
  const osc = ctx.createOscillator();
  let gain: GainNode | null = null;
  let settled = false;

  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    osc.onended = null;
    try {
      osc.disconnect();
    } catch {
      // already disconnected
    }
    try {
      gain?.disconnect();
    } catch {
      // already disconnected
    }
    onEnded?.();
  };

  try {
    osc.type = 'square';
    osc.frequency.setValueAtTime(accent ? 1600 : 1000, time);

    gain = ctx.createGain();
    const peak = accent ? 0.3 : 0.18;
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

    osc.connect(gain);
    gain.connect(output);
    osc.onended = cleanup;
    osc.start(time);
    osc.stop(time + 0.06);
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    cancel: () => {
      if (settled) return;
      try {
        osc.stop();
      } catch {
        // The source may have ended or never reached start(). Disconnecting is
        // still sufficient to keep it out of the output graph.
      }
      cleanup();
    },
  };
}
