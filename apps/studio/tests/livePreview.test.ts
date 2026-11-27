import { beforeEach, describe, expect, it, vi } from 'vitest';

const playbackMock = vi.hoisted(() => ({
  initAudioBridge: vi.fn(),
  restartAt: vi.fn(),
  audioPlaybackFailureMessage: vi.fn(),
}));
vi.mock('../src/audio/playback', () => playbackMock);

import { LivePreview, MAX_PREVIEW_VOICES, fitEnvelope, type PreviewTarget } from '../src/audio/livePreview';
import { resolvePreset } from '../src/audio/synth';

type MockParam = {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
};

function param(value = 1): MockParam {
  return {
    value,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

type MockOsc = {
  type: string;
  frequency: MockParam;
  detune: MockParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onended?: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function createMockContext(state: 'suspended' | 'running') {
  const oscillators: MockOsc[] = [];
  const gains: { gain: MockParam; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const ctx = {
    state,
    currentTime: 1,
    resume: vi.fn(async () => {
      ctx.state = 'running';
    }),
    createOscillator: vi.fn(() => {
      const osc: MockOsc = {
        type: 'sine',
        frequency: param(),
        detune: param(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }),
    createBiquadFilter: vi.fn(() => ({
      type: 'lowpass',
      frequency: param(),
      Q: param(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createGain: vi.fn(() => {
      const gain = { gain: param(), connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain);
      return gain;
    }),
  };
  return { ctx, oscillators, gains };
}

/** When an oscillator really stops: the earliest stop() time it was given. */
function stopTime(osc: MockOsc): number {
  return Math.min(...osc.stop.mock.calls.map((c) => c[0] as number));
}

function startTime(osc: MockOsc): number {
  return osc.start.mock.calls[0]?.[0] as number;
}

/** Oscillators sounding at time `t` (started at or before t, not yet stopped). */
function soundingAt(oscillators: MockOsc[], t: number): number {
  return oscillators.filter((o) => startTime(o) <= t && stopTime(o) > t).length;
}

describe('LivePreview', () => {
  let mock: ReturnType<typeof createMockContext>;
  let master: { connect: ReturnType<typeof vi.fn> };
  let preview: LivePreview;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockContext('running');
    master = { connect: vi.fn() };
    preview = new LivePreview(async () => ({
      context: mock.ctx as unknown as BaseAudioContext,
      master: master as unknown as AudioNode,
    }));
  });

  it('caps voices at 8 and stops the oldest one', async () => {
    const instrument = { type: 'synth' as const, preset: 'brightLead' };
    for (let i = 0; i < 9; i += 1) {
      await preview.previewNote(instrument, 60 + i, 100, 300);
    }
    expect(MAX_PREVIEW_VOICES).toBe(8);
    expect(preview.activeVoiceCount()).toBeLessThanOrEqual(8);
    // Each voice uses two oscillators; the first voice is stolen (stopped again early).
    const [oldA, oldB] = mock.oscillators;
    expect(oldA?.stop).toHaveBeenCalledTimes(2);
    expect(oldB?.stop).toHaveBeenCalledTimes(2);
    // The newest voice only has its own scheduled stop.
    const newest = mock.oscillators[mock.oscillators.length - 1];
    expect(newest?.stop).toHaveBeenCalledTimes(1);
    // Voices 2..8 are still playing untouched.
    expect(mock.oscillators[2]?.stop).toHaveBeenCalledTimes(1);
  });

  it('never has more than 8 voices sounding at once, even for 9 clicks in one task', async () => {
    const instrument = { type: 'synth' as const, preset: 'warmPad' };
    await Promise.all(
      Array.from({ length: 9 }, () => preview.previewNote(instrument, 60, 100, 300)),
    );
    expect(mock.oscillators).toHaveLength(18);
    const newest = mock.oscillators[17] as MockOsc;
    const oldest = mock.oscillators[0] as MockOsc;
    // The oldest voice stops at the same moment the newest one starts.
    expect(stopTime(oldest)).toBeCloseTo(startTime(newest), 9);
    expect(stopTime(mock.oscillators[1] as MockOsc)).toBeCloseTo(startTime(newest), 9);
    // Check every instant where the set of sounding oscillators can change.
    const instants = mock.oscillators.flatMap((o) => [startTime(o), stopTime(o)]);
    for (const t of instants) {
      expect(soundingAt(mock.oscillators, t)).toBeLessThanOrEqual(MAX_PREVIEW_VOICES * 2);
    }
    expect(preview.activeVoiceCount()).toBe(MAX_PREVIEW_VOICES);
  });

  it('a 300ms warmPad preview ends 300ms after it starts', async () => {
    await preview.previewNote({ type: 'synth', preset: 'warmPad' }, 60, 100, 300);
    const now = mock.ctx.currentTime;
    for (const osc of mock.oscillators) {
      expect(startTime(osc)).toBeCloseTo(now, 9);
      expect(stopTime(osc)).toBeCloseTo(now + 0.3, 9);
    }
    // The voice's envelope (second gain: the first is the preview bus) is silent by then.
    const voiceGain = mock.gains[1]?.gain;
    const rampTimes = voiceGain?.linearRampToValueAtTime.mock.calls.map((c) => c[1] as number) ?? [];
    expect(rampTimes.length).toBeGreaterThan(0);
    expect(Math.max(...rampTimes)).toBeLessThanOrEqual(now + 0.3);
    expect(voiceGain?.linearRampToValueAtTime.mock.calls.at(-1)?.[0]).toBe(0);
  });

  it('reserves a voice for a pending preview when another voice expires during a steal', async () => {
    mock.ctx.currentTime = 0;
    for (let i = 0; i < 7; i += 1) {
      await preview.previewNote(undefined, 60 + i, 100, 1000);
    }
    await preview.previewNote(undefined, 67, 100, 300);

    mock.ctx.currentTime = 0.298;
    await preview.previewNote(undefined, 68, 100, 300);
    mock.ctx.currentTime = 0.301;
    await preview.previewNote(undefined, 69, 100, 300);

    expect(soundingAt(mock.oscillators, 0.350)).toBe(MAX_PREVIEW_VOICES * 2);
    for (const osc of mock.oscillators) {
      expect(soundingAt(mock.oscillators, startTime(osc))).toBeLessThanOrEqual(MAX_PREVIEW_VOICES * 2);
    }
  });

  it('fitEnvelope keeps every preset inside the requested length', () => {
    for (const name of ['warmPad', 'roundBass', 'brightLead']) {
      const env = resolvePreset(name).env;
      for (const total of [0.03, 0.1, 0.3, 2]) {
        const fitted = fitEnvelope(env, total);
        expect(fitted.env.attack + fitted.env.decay).toBeLessThanOrEqual(fitted.hold + 1e-12);
        expect(fitted.hold + fitted.env.release + 0.02).toBeCloseTo(total, 9);
        expect(fitted.env.attack).toBeGreaterThanOrEqual(0);
        expect(fitted.env.decay).toBeGreaterThanOrEqual(0);
      }
    }
    // A long preview keeps the preset envelope as is.
    expect(fitEnvelope(resolvePreset('roundBass').env, 2).env).toEqual(resolvePreset('roundBass').env);
  });

  it('routes through its own gain node connected to the master input', async () => {
    await preview.previewNote(undefined, 60, 100, 300);
    const previewGain = mock.gains[0];
    expect(previewGain?.connect).toHaveBeenCalledWith(master);
  });

  it('resumes a suspended context before sounding', async () => {
    mock = createMockContext('suspended');
    preview = new LivePreview(async () => ({
      context: mock.ctx as unknown as BaseAudioContext,
      master: master as unknown as AudioNode,
    }));
    await preview.previewNote(undefined, 60, 100, 300);
    expect(mock.ctx.resume).toHaveBeenCalledTimes(1);
    const resumeOrder = mock.ctx.resume.mock.invocationCallOrder[0] ?? Infinity;
    const oscOrder = mock.ctx.createOscillator.mock.invocationCallOrder[0] ?? -Infinity;
    expect(resumeOrder).toBeLessThan(oscOrder);
  });

  it('previews a chord as one voice per note', async () => {
    await preview.previewChord([60, 64, 67]);
    expect(preview.activeVoiceCount()).toBe(3);
    expect(mock.oscillators).toHaveLength(6);
  });

  it('ignores an unplayable request without stealing a voice', async () => {
    for (let i = 0; i < MAX_PREVIEW_VOICES; i += 1) {
      await preview.previewNote(undefined, 60 + i, 100, 300);
    }
    await preview.previewNote(undefined, Number.NaN);
    await preview.previewNote(undefined, 60, Number.NaN);
    await preview.previewNote(undefined, 60, 100, Number.POSITIVE_INFINITY);
    expect(mock.oscillators).toHaveLength(MAX_PREVIEW_VOICES * 2);
    expect(mock.oscillators.every((o) => o.stop.mock.calls.length === 1)).toBe(true);
    expect(preview.activeVoiceCount()).toBe(MAX_PREVIEW_VOICES);
  });

  it('keeps a fading stolen voice counted when the new voice fails to start', async () => {
    for (let i = 0; i < MAX_PREVIEW_VOICES; i += 1) {
      await preview.previewNote(undefined, 60 + i, 100, 300);
    }
    // The next voice fails inside note-on, after the oldest voice was stolen.
    mock.ctx.createOscillator.mockImplementationOnce(() => {
      throw new TypeError('note-on failed');
    });
    await expect(preview.previewNote(undefined, 70, 100, 300)).rejects.toThrow('note-on failed');
    await preview.previewNote(undefined, 72, 100, 300);
    const instants = mock.oscillators.flatMap((o) => [startTime(o), stopTime(o)]);
    for (const t of instants) {
      expect(soundingAt(mock.oscillators, t)).toBeLessThanOrEqual(MAX_PREVIEW_VOICES * 2);
    }
    expect(preview.activeVoiceCount()).toBeLessThanOrEqual(MAX_PREVIEW_VOICES);
  });

  it('sustains until noteOff, avoids duplicates, and disconnects released nodes', async () => {
    await preview.noteOn(60);
    await preview.noteOn(60);
    expect(mock.oscillators).toHaveLength(2);
    mock.ctx.currentTime += 60;
    expect(preview.activeVoiceCount()).toBe(1);
    expect(mock.oscillators.every((osc) => osc.stop.mock.calls.length === 0)).toBe(true);

    preview.noteOff(61);
    expect(mock.oscillators.every((osc) => osc.stop.mock.calls.length === 0)).toBe(true);
    preview.noteOff(60);
    preview.noteOff(60);
    expect(preview.activeVoiceCount()).toBe(0);

    const [oscA, oscB] = mock.oscillators;
    for (const osc of mock.oscillators) {
      expect(osc.stop).toHaveBeenCalledTimes(1);
      expect(stopTime(osc)).toBeCloseTo(mock.ctx.currentTime + 0.05);
      expect(osc.disconnect).not.toHaveBeenCalled();
    }
    oscB?.onended?.();
    expect(oscA?.disconnect).toHaveBeenCalledTimes(1);
    expect(oscB?.disconnect).toHaveBeenCalledTimes(1);
    expect(mock.ctx.createBiquadFilter.mock.results[0]?.value.disconnect).toHaveBeenCalledTimes(1);
    expect(mock.gains[1]?.disconnect).toHaveBeenCalledTimes(1);
    expect(mock.gains[0]?.disconnect).not.toHaveBeenCalled();
  });

  it('allNotesOff releases held notes and lets a timed preview finish', async () => {
    await preview.previewNote(undefined, 60);
    await Promise.all([preview.noteOn(60), preview.noteOn(62)]);
    mock.ctx.currentTime += 0.1;

    preview.allNotesOff();
    expect(preview.activeVoiceCount()).toBe(1);
    expect(mock.oscillators[0]?.stop).toHaveBeenCalledExactlyOnceWith(1.3);
    for (const osc of mock.oscillators.slice(2)) {
      expect(stopTime(osc)).toBeCloseTo(1.15);
    }
  });

  it('cancels pending starts on noteOff and allNotesOff and allows the same pitch to restart', async () => {
    let resolveTarget!: (target: PreviewTarget) => void;
    const target = new Promise<PreviewTarget>((resolve) => { resolveTarget = resolve; });
    preview = new LivePreview(() => target);
    const released = preview.noteOn(60);
    preview.noteOff(60);
    const stopped = preview.noteOn(62);
    preview.allNotesOff();
    const current = preview.noteOn(60);
    resolveTarget({
      context: mock.ctx as unknown as BaseAudioContext,
      master: master as unknown as AudioNode,
    });
    await Promise.all([released, stopped, current]);
    expect(mock.oscillators).toHaveLength(2);
    expect(preview.activeVoiceCount()).toBe(1);
    preview.noteOff(60);
    expect(preview.activeVoiceCount()).toBe(0);
  });

  it('allows a pitch to be retried after audio initialization fails', async () => {
    const getTarget = vi.fn(async () => ({
      context: mock.ctx as unknown as BaseAudioContext,
      master: master as unknown as AudioNode,
    })).mockRejectedValueOnce(new Error('audio startup failed'));
    preview = new LivePreview(getTarget);
    await expect(preview.noteOn(60)).rejects.toThrow('audio startup failed');
    await preview.noteOn(60);
    expect(preview.activeVoiceCount()).toBe(1);
  });

  it('never touches the playback schedule', async () => {
    await preview.previewNote(undefined, 60, 100, 300);
    await preview.previewChord([48, 52, 55]);
    const calls = Object.values(playbackMock).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
    expect(calls).toBe(0);
  });
});
