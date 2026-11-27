import { describe, expect, it, vi } from 'vitest';
import { lastPerformanceNotes, MAX_PERFORMANCE_EVENTS, MAX_RECORDING_EVENTS, PerformanceBuffer, RecordingBuffer, recordingBeat, recordingBeatAtAudioTime } from '../src/audio/recorder';

describe('recorder timing', () => {
  it('aligns the performance and audio clocks to an unwrapped recording beat', () => {
    const clock = { audioTime: 10, performanceTime: 55_000, recordTime: 12, bpm: 120 };
    expect(recordingBeat(clock, 55_000)).toBe(-4);
    expect(recordingBeat(clock, 56_999)).toBeLessThan(0);
    expect(recordingBeat(clock, 57_000)).toBe(0);
    expect(recordingBeat(clock, 59_625)).toBe(5.25);
    expect(recordingBeatAtAudioTime(clock, 14.625)).toBe(5.25);
  });

  it('ignores count-in and caps input at 100,000 events with one notification', () => {
    const onLimit = vi.fn();
    const buffer = new RecordingBuffer(onLimit);
    const event = { timeBeat: 0, midi: 60, velocity: 100, on: true };
    buffer.append({ ...event, timeBeat: -0.001 });
    expect(buffer.captured).toHaveLength(0);
    for (let i = 0; i < MAX_RECORDING_EVENTS + 2; i++) buffer.append(event);
    expect(buffer.captured).toHaveLength(100_000);
    expect(onLimit).toHaveBeenCalledTimes(1);
  });
});

function edge(timeStamp: number, midi = 60, on = true, positionBeat = 4) {
  return { timeStamp, midi, on, positionBeat, velocity: 92 };
}

describe('recent performance buffer', () => {
  it('keeps only the last 60 seconds of event time, even for delayed arrivals', () => {
    const buffer = new PerformanceBuffer();
    buffer.append(edge(2000));
    buffer.append(edge(62_001, 62));
    buffer.append(edge(2000, 64));
    buffer.append(edge(2001, 65));
    expect(buffer.snapshot(62_001)).toEqual([edge(2001, 65), edge(62_001, 62)]);
    expect(buffer.snapshot(122_002)).toEqual([]);
  });

  it('keeps the newest 20,000 inputs after wrapping and after late arrivals', () => {
    const buffer = new PerformanceBuffer();
    for (let i = 0; i < MAX_PERFORMANCE_EVENTS + 5; i++) buffer.append(edge(i * 2));
    buffer.append(edge(0, 63));
    buffer.append(edge(13, 65));
    const events = buffer.snapshot(50_000);
    expect(events).toHaveLength(MAX_PERFORMANCE_EVENTS);
    expect(events.slice(0, 3)).toEqual([edge(12), edge(13, 65), edge(14)]);
    expect(events.at(-1)).toEqual(edge((MAX_PERFORMANCE_EVENTS + 4) * 2));
    buffer.clear();
    expect(buffer.snapshot(50_000)).toEqual([]);
  });

  it('anchors on the last event, counts earlier onsets through beat zero, and closes a held note at capture', () => {
    const buffer = new PerformanceBuffer();
    buffer.append(edge(1000, 61));
    buffer.append(edge(1500, 61, false));
    buffer.append(edge(2000, 62, true, 0.5));
    expect(lastPerformanceNotes(buffer.snapshot(2250), 2250, 120)).toEqual([
      { id: 'take-1', pitch: 61, velocity: 92, startBeat: -1.5, durationBeats: 1 },
      { id: 'take-2', pitch: 62, velocity: 92, startBeat: 0.5, durationBeats: 0.5 },
    ]);
    expect(lastPerformanceNotes(buffer.snapshot(2000), 2000, 120).at(-1)?.durationBeats).toBe(1 / 480);
  });
});
