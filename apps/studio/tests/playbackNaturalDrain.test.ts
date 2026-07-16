import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  type EffectConfig,
  type Project,
  type Track,
} from '@cts/project-model';
import type { NoteScheduleEvent } from '../src/audio/events';
import {
  beginRuntimeNaturalDrain,
  planRuntimeAudioTail,
  restoreRuntimeMaster,
} from '../src/audio/playback';
import type { ScheduledEvent } from '../src/audio/scheduler';
import { FINAL_TAIL_FADE_SECONDS } from '../src/audio/tail';
import { MASTER_LIMITER_LOOKAHEAD_SECONDS } from '../src/audio/masterBus';

function fakeOutput(initialGain = 1): {
  output: GainNode;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
} {
  const cancelScheduledValues = vi.fn();
  const setValueAtTime = vi.fn();
  const linearRampToValueAtTime = vi.fn();
  return {
    output: {
      gain: {
        value: initialGain,
        cancelScheduledValues,
        setValueAtTime,
        linearRampToValueAtTime,
      },
    } as unknown as GainNode,
    cancelScheduledValues,
    setValueAtTime,
    linearRampToValueAtTime,
  };
}

function instrumentTrack(effects: EffectConfig[] = [], mute = false): Track {
  return {
    id: 'instrument',
    name: 'Instrument',
    type: 'instrument',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute,
    solo: false,
    instrument: { type: 'synth', preset: 'softPad' },
    effects,
  };
}

function masterTrack(volume: number): Track {
  return {
    id: 'master',
    name: 'Master',
    type: 'master',
    role: 'general',
    clips: [],
    volume,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
}

function project(track: Track): Project {
  return {
    id: 'live-tail-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Live tail test',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [{ id: 'live-tail-tempo-0', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'live-tail-meter-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    automationLanes: [],
    tracks: [track],
    chordTrack: [],
    sections: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
}

function finalNote(): ScheduledEvent {
  return {
    beat: 3.9,
    payload: {
      kind: 'note',
      trackId: 'instrument',
      preset: 'softPad',
      pitch: 60,
      durationBeats: 0.1,
      velocity: 100,
    } satisfies NoteScheduleEvent,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('beginRuntimeNaturalDrain', () => {
  it('stops controls immediately but keeps graphs until the absolute tail deadline', () => {
    vi.useFakeTimers();
    const { output, cancelScheduledValues, setValueAtTime, linearRampToValueAtTime } =
      fakeOutput(0.42);
    const scheduler = { stop: vi.fn() };
    const stopPositionUpdates = vi.fn();
    const cancelMetronomeClicks = vi.fn();
    const disposeGraphs = vi.fn();
    const onComplete = vi.fn(() => disposeGraphs());

    beginRuntimeNaturalDrain({
      scheduler,
      output,
      now: () => 10.02,
      projectEndTime: 10,
      tailSeconds: 0.37,
      postLimiterTailSeconds: MASTER_LIMITER_LOOKAHEAD_SECONDS,
      stopPositionUpdates,
      cancelMetronomeClicks,
      onComplete,
    });

    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(stopPositionUpdates).toHaveBeenCalledOnce();
    expect(cancelMetronomeClicks).toHaveBeenCalledOnce();
    expect(disposeGraphs).not.toHaveBeenCalled();
    expect(cancelScheduledValues.mock.calls[0]?.[0]).toBeCloseTo(10.314, 10);
    expect(setValueAtTime.mock.calls[0]?.[0]).toBe(0.42);
    expect(setValueAtTime.mock.calls[0]?.[1]).toBeCloseTo(10.314, 10);
    expect(linearRampToValueAtTime.mock.calls[0]?.[0]).toBe(0);
    expect(linearRampToValueAtTime.mock.calls[0]?.[1]).toBeCloseTo(10.364, 10);

    vi.advanceTimersByTime(349);
    expect(onComplete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(disposeGraphs).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('anchors a late callback fade to project end instead of extending from now', () => {
    vi.useFakeTimers();
    const { output, setValueAtTime, linearRampToValueAtTime } = fakeOutput();
    const onComplete = vi.fn();

    beginRuntimeNaturalDrain({
      scheduler: { stop: vi.fn() },
      output,
      now: () => 10.98,
      projectEndTime: 10,
      tailSeconds: 1,
      postLimiterTailSeconds: MASTER_LIMITER_LOOKAHEAD_SECONDS,
      stopPositionUpdates: vi.fn(),
      cancelMetronomeClicks: vi.fn(),
      onComplete,
    });

    expect(setValueAtTime).toHaveBeenCalledWith(1, 10.98);
    expect(linearRampToValueAtTime).toHaveBeenCalledWith(0, 10.994);
    expect(10.98).toBeGreaterThan(
      10.994 - FINAL_TAIL_FADE_SECONDS,
    );
    vi.advanceTimersByTime(21);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('silences immediately when only the limiter cleanup window remains', () => {
    vi.useFakeTimers();
    const { output, setValueAtTime, linearRampToValueAtTime } = fakeOutput();
    const onComplete = vi.fn();

    beginRuntimeNaturalDrain({
      scheduler: { stop: vi.fn() },
      output,
      now: () => 10.997,
      projectEndTime: 10,
      tailSeconds: 1,
      postLimiterTailSeconds: MASTER_LIMITER_LOOKAHEAD_SECONDS,
      stopPositionUpdates: vi.fn(),
      cancelMetronomeClicks: vi.fn(),
      onComplete,
    });

    expect(setValueAtTime).toHaveBeenCalledWith(0, 10.997);
    expect(linearRampToValueAtTime).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3);
    expect(onComplete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('completes promptly when the absolute cleanup deadline already passed', () => {
    vi.useFakeTimers();
    const { output, setValueAtTime, linearRampToValueAtTime } = fakeOutput();
    const cancelMetronomeClicks = vi.fn();
    const onComplete = vi.fn();

    beginRuntimeNaturalDrain({
      scheduler: { stop: vi.fn() },
      output,
      now: () => 12,
      projectEndTime: 10,
      tailSeconds: 0.5,
      postLimiterTailSeconds: MASTER_LIMITER_LOOKAHEAD_SECONDS,
      stopPositionUpdates: vi.fn(),
      cancelMetronomeClicks,
      onComplete,
    });

    expect(cancelMetronomeClicks).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(setValueAtTime).not.toHaveBeenCalled();
    expect(linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets immediate disposal cancel the bounded cleanup timer', () => {
    vi.useFakeTimers();
    const { output } = fakeOutput();
    const onComplete = vi.fn();
    const cancelDrain = beginRuntimeNaturalDrain({
      scheduler: { stop: vi.fn() },
      output,
      now: () => 10,
      projectEndTime: 10,
      tailSeconds: 2,
      postLimiterTailSeconds: MASTER_LIMITER_LOOKAHEAD_SECONDS,
      stopPositionUpdates: vi.fn(),
      cancelMetronomeClicks: vi.fn(),
      onComplete,
    });

    expect(vi.getTimerCount()).toBe(1);
    cancelDrain();
    cancelDrain();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('cancels pending fade automation and restores project master gain on disposal', () => {
    vi.useFakeTimers();
    const { output, cancelScheduledValues, setValueAtTime } = fakeOutput(0.42);
    const cancelDrain = beginRuntimeNaturalDrain({
      scheduler: { stop: vi.fn() },
      output,
      now: () => 10,
      projectEndTime: 10,
      tailSeconds: 1,
      postLimiterTailSeconds: MASTER_LIMITER_LOOKAHEAD_SECONDS,
      stopPositionUpdates: vi.fn(),
      cancelMetronomeClicks: vi.fn(),
      onComplete: vi.fn(),
    });

    cancelDrain();
    restoreRuntimeMaster(output, [masterTrack(0.65)], 10.1);

    expect(vi.getTimerCount()).toBe(0);
    expect(cancelScheduledValues.mock.calls[0]?.[0]).toBeCloseTo(10.944, 10);
    expect(cancelScheduledValues).toHaveBeenNthCalledWith(2, 10.1);
    expect(setValueAtTime.mock.calls[0]?.[0]).toBe(0.42);
    expect(setValueAtTime.mock.calls[0]?.[1]).toBeCloseTo(10.944, 10);
    expect(setValueAtTime).toHaveBeenNthCalledWith(2, 0.65, 10.1);
  });
});

describe('planRuntimeAudioTail', () => {
  it('uses compatible effects added after start and never undercounts a once-audible track', () => {
    const snapshotTrack = instrumentTrack();
    const snapshot = project(snapshotTrack);
    const noEffect = planRuntimeAudioTail(
      snapshot,
      snapshot.tracks,
      [finalNote()],
      0,
      4,
      new Set(['instrument']),
    );
    const latestReverb: EffectConfig = {
      id: 'late-reverb',
      type: 'reverb',
      enabled: true,
      params: { wet: 1, decay: 1 },
    };
    const withLateEffect = planRuntimeAudioTail(
      snapshot,
      [instrumentTrack([latestReverb], true)],
      [finalNote()],
      0,
      4,
      new Set(['instrument']),
    );

    expect(withLateEffect.tailSeconds).toBeGreaterThan(noEffect.tailSeconds);
    expect(withLateEffect.tailSeconds).toBeGreaterThan(0);
  });

  it('uses the live AudioContext sample rate for coefficient-derived filter tails', () => {
    const filter: EffectConfig = {
      id: 'max-filter',
      type: 'filter',
      enabled: true,
      params: { cutoff: 0, resonance: 1 },
    };
    const snapshot = project(instrumentTrack([filter]));
    const plan = (sampleRate: number) => planRuntimeAudioTail(
      snapshot,
      snapshot.tracks,
      [finalNote()],
      0,
      4,
      new Set(['instrument']),
      sampleRate,
    );
    const fortyFour = plan(44_100);
    const ninetySix = plan(96_000);

    expect(fortyFour.tailSeconds).not.toBe(ninetySix.tailSeconds);
    expect(fortyFour.fadeEndSeconds).toBeCloseTo(
      fortyFour.totalSeconds - MASTER_LIMITER_LOOKAHEAD_SECONDS,
      12,
    );
    expect(ninetySix.fadeEndSeconds).toBeCloseTo(
      ninetySix.totalSeconds - MASTER_LIMITER_LOOKAHEAD_SECONDS,
      12,
    );
  });
});
