import { beatTick, eventsToNotes, PPQ, type NoteEvent, type RecordingEvent } from '@cts/project-model';
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

export const MAX_PERFORMANCE_EVENTS = 20_000;
const PERFORMANCE_WINDOW_MS = 60_000;

export type PerformanceEvent = Omit<RecordingEvent, 'timeBeat'> & {
  timeStamp: number;
  positionBeat: number;
};

/** The most recent input edges, ordered by event time (including delayed arrivals). */
export class PerformanceBuffer {
  private readonly events: PerformanceEvent[] = [];
  private head = 0;
  private size = 0;

  private index(offset: number): number {
    return (this.head + offset) % MAX_PERFORMANCE_EVENTS;
  }

  private discardOldest(): void {
    delete this.events[this.head];
    this.head = this.index(1);
    this.size--;
  }

  private expire(timeStamp: number): void {
    const cutoff = timeStamp - PERFORMANCE_WINDOW_MS;
    while (this.size && this.events[this.head]!.timeStamp < cutoff) this.discardOldest();
  }

  append(event: PerformanceEvent): void {
    const newest = this.size ? this.events[this.index(this.size - 1)] : undefined;
    const time = Math.max(newest?.timeStamp ?? event.timeStamp, event.timeStamp);
    this.expire(time);
    if (event.timeStamp < time - PERFORMANCE_WINDOW_MS) return;
    if (this.size === MAX_PERFORMANCE_EVENTS) {
      if (event.timeStamp < this.events[this.head]!.timeStamp) return;
      this.discardOldest();
    }

    let offset = this.size;
    // Normally this is an O(1) append. Move later events aside for a delayed edge.
    while (offset && this.events[this.index(offset - 1)]!.timeStamp > event.timeStamp) {
      this.events[this.index(offset)] = this.events[this.index(offset - 1)]!;
      offset--;
    }
    this.events[this.index(offset)] = event;
    this.size++;
  }

  snapshot(timeStamp: number): PerformanceEvent[] {
    this.expire(timeStamp);
    return Array.from({ length: this.size }, (_, i) => this.events[this.index(i)]!)
      .filter((event) => event.timeStamp <= timeStamp);
  }

  /** Close idle notes before recording starts, preserving their timeline anchor. */
  closeHeld(timeStamp: number, bpm: number): void {
    const events = this.snapshot(timeStamp);
    const last = events.at(-1);
    if (!last) return;
    const held = new Set<number>();
    for (const event of events) {
      if (event.on) held.add(event.midi);
      else held.delete(event.midi);
    }
    const positionBeat = last.positionBeat + (timeStamp - last.timeStamp) * bpm / 60_000;
    for (const midi of held) this.append({ midi, on: false, velocity: 0, timeStamp, positionBeat });
  }

  clear(): void {
    this.events.length = 0;
    this.head = 0;
    this.size = 0;
  }
}

/** Pair on a continuous timeline so early notes are available for drop counts. */
export function lastPerformanceNotes(events: readonly PerformanceEvent[], now: number, bpm: number): NoteEvent[] {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return [];
  const beatsSinceLast = (timeStamp: number): number => (timeStamp - last.timeStamp) * bpm / 60_000;
  // eventsToNotes only accepts nonnegative input. Shift by whole beats and
  // subtract that offset afterwards to retain song-absolute tick alignment.
  const offset = Math.max(0, Math.ceil(-last.positionBeat - beatsSinceLast(first.timeStamp)));
  const anchor = last.positionBeat + offset;
  const stop = anchor + beatsSinceLast(now);
  return eventsToNotes(
    events.map((event) => ({ ...event, timeBeat: Math.max(0, anchor + beatsSinceLast(event.timeStamp)) })),
    { clipStartBeat: 0, stopBeat: Math.max(stop, (beatTick(anchor) + 1) / PPQ) },
  ).map((note) => ({ ...note, startBeat: (beatTick(note.startBeat) - offset * PPQ) / PPQ }));
}
