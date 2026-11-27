import type { RecordingEvent } from '@cts/project-model';
import { timeToBeat } from './scheduler';

export const MAX_RECORDING_EVENTS = 100_000;

export type RecordingClock = {
  /** Audio and performance clock readings taken together at the count-in start. */
  audioTime: number;
  performanceTime: number;
  /** Audio time of the first recordable beat. */
  recordTime: number;
  bpm: number;
};

/** Unwrapped beats relative to the end of the count-in. Negative is count-in. */
export function recordingBeat(clock: RecordingClock, performanceTime: number): number {
  return recordingBeatAtAudioTime(clock, clock.audioTime + (performanceTime - clock.performanceTime) / 1000);
}

export function recordingBeatAtAudioTime(clock: RecordingClock, audioTime: number): number {
  return timeToBeat(audioTime, clock.bpm, 0, clock.recordTime);
}

/** Input handlers only timestamp and buffer. Pairing and project edits run after stop. */
export class RecordingBuffer {
  private readonly events: RecordingEvent[] = [];

  constructor(private readonly onLimit: () => void) {}

  append(event: RecordingEvent): void {
    if (!(event.timeBeat >= 0) || this.events.length >= MAX_RECORDING_EVENTS) return;
    this.events.push(event);
    if (this.events.length === MAX_RECORDING_EVENTS) this.onLimit();
  }

  get captured(): readonly RecordingEvent[] {
    return this.events;
  }
}

type Phase = 'idle' | 'count-in' | 'recording';
const listeners = new Set<() => void>();
let phase: Phase = 'idle';

export function recordingPhase(): Phase {
  return phase;
}

export function subscribeRecordingPhase(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setRecordingPhase(next: Phase): void {
  if (phase === next) return;
  phase = next;
  for (const listener of listeners) listener();
}
