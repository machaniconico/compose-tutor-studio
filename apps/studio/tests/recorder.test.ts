import { describe, expect, it, vi } from 'vitest';
import { MAX_RECORDING_EVENTS, RecordingBuffer, recordingBeat, recordingBeatAtAudioTime } from '../src/audio/recorder';

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
