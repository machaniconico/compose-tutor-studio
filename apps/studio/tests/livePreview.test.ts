import { describe, expect, it, vi } from 'vitest';
import { useStore } from '../src/state/store';
import { listSynthPresets } from '../src/audio/synth';
import {
  canPreview,
  LivePreview,
  MAX_PREVIEW_SECONDS,
  MAX_PREVIEW_VOICES,
  type PreviewTarget,
} from '../src/audio/livePreview';

function param() {
  return { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() };
}
function node() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

function makeContext() {
  const oscillators: Array<ReturnType<typeof node> & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: null | (() => void) }> = [];
  const ctx = {
    currentTime: 10,
    createOscillator: vi.fn(() => {
      const o = { ...node(), type: 'sine', frequency: param(), detune: param(), start: vi.fn(), stop: vi.fn(), onended: null };
      oscillators.push(o);
      return o;
    }),
    createGain: vi.fn(() => ({ ...node(), gain: param() })),
    createBiquadFilter: vi.fn(() => ({ ...node(), type: 'lowpass', frequency: param(), Q: param() })),
  };
  return { ctx, oscillators };
}

function setup() {
  const { ctx, oscillators } = makeContext();
  const target = { context: ctx, master: node() } as unknown as PreviewTarget;
  const getTarget = vi.fn(async () => target);
  const preview = new LivePreview(getTarget);
  return { preview, ctx, oscillators, getTarget };
}

/** Earliest scheduled stop of an oscillator. */
const stopAt = (o: { stop: ReturnType<typeof vi.fn> }) =>
  Math.min(...o.stop.mock.calls.map((c) => c[0] as number));

describe('LivePreview', () => {
  it('bounds every voice: duration is clamped to the hard maximum', async () => {
    const { preview, ctx, oscillators } = setup();
    await preview.play(undefined, [60], 60, false);
    expect(oscillators.length).toBeGreaterThan(0);
    for (const o of oscillators) {
      expect(stopAt(o)).toBeLessThan(ctx.currentTime + MAX_PREVIEW_SECONDS + 1);
      expect(stopAt(o)).toBeGreaterThan(ctx.currentTime);
    }
  });

  it('caps concurrent voices by stealing the oldest', async () => {
    const { preview, oscillators } = setup();
    const perVoice = (await (async () => {
      await preview.play(undefined, [40], 1, false);
      return oscillators.length;
    })());
    for (let i = 1; i <= MAX_PREVIEW_VOICES + 4; i += 1) {
      await preview.play(undefined, [40 + i], 1, false);
    }
    // The oldest voices were soft-stopped (stop rescheduled) once the cap was exceeded.
    const stolen = oscillators.filter((o) => o.stop.mock.calls.length > 1);
    expect(stolen.length).toBeGreaterThanOrEqual(4 * perVoice);
  });

  it('a new chord preview cancels the previous chord', async () => {
    const { preview, oscillators } = setup();
    await preview.play(undefined, [60, 64, 67], 1.2, true);
    const first = oscillators.length;
    await preview.play(undefined, [62, 65, 69], 1.2, true);
    const firstVoices = oscillators.slice(0, first);
    expect(firstVoices.every((o) => o.stop.mock.calls.length > 1)).toBe(true);
    expect(oscillators.length).toBe(first * 2);
  });

  it('cancel releases everything and drops a start still waiting for audio', async () => {
    const { ctx, oscillators } = makeContext();
    let resolve!: (t: PreviewTarget) => void;
    const pending = new Promise<PreviewTarget>((r) => { resolve = r; });
    const preview = new LivePreview(() => pending);
    const started = preview.play(undefined, [60], 1, false);
    preview.cancel();
    resolve({ context: ctx, master: node() } as unknown as PreviewTarget);
    await started;
    expect(oscillators).toHaveLength(0);

    const live = setup();
    await live.preview.play(undefined, [60, 64], 1, false);
    live.preview.cancel();
    expect(live.oscillators.every((o) => o.stop.mock.calls.length > 1)).toBe(true);
  });

  it('ignores unplayable pitches and non-finite durations', async () => {
    const { preview, getTarget } = setup();
    await preview.play(undefined, [NaN, -1, 128, 60.5], 1, false);
    await preview.play(undefined, [60], Infinity, false);
    expect(getTarget).not.toHaveBeenCalled();
  });

  it('dispose disconnects the bus and later plays rebuild it', async () => {
    const { preview, ctx } = setup();
    await preview.play(undefined, [60], 1, false);
    preview.dispose();
    const before = ctx.createGain.mock.calls.length;
    await preview.play(undefined, [60], 1, false);
    expect(ctx.createGain.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('2 s hard maximum covers the release tail', () => {
  it('every preset, with maximum release and attack macros, is silent and stopped by 2 s', async () => {
    for (const { name } of listSynthPresets()) {
      for (const params of [
        { macroRelease: 1, macroAttack: 1 },
        { macroRelease: 1, macroAttack: 0 },
        {},
      ]) {
        const { preview, ctx, oscillators } = setup();
        await preview.play({ preset: name, params } as never, [60], 60, false);
        expect(oscillators.length).toBeGreaterThan(0);
        for (const o of oscillators) {
          expect(stopAt(o) - ctx.currentTime, `${name} ${JSON.stringify(params)}`)
            .toBeLessThanOrEqual(MAX_PREVIEW_SECONDS + 1e-9);
        }
      }
    }
  });
});

describe('a pending preview re-checks the guard after audio init', () => {
  it('does not start voices when recording began while the context was resuming', async () => {
    const { ctx, oscillators } = makeContext();
    let resolve!: (t: PreviewTarget) => void;
    const pending = new Promise<PreviewTarget>((r) => { resolve = r; });
    const preview = new LivePreview(() => pending, canPreview);
    const started = preview.play(undefined, [60], 1, false);
    useStore.setState({ audioRecordingOperationId: 7 });
    resolve({ context: ctx, master: node() } as unknown as PreviewTarget);
    await started;
    useStore.setState({ audioRecordingOperationId: null });
    expect(oscillators).toHaveLength(0);
  });
});

describe('preview guard', () => {
  it('is allowed while playing, refused while a recording owns the audio path', () => {
    expect(canPreview()).toBe(true);
    useStore.setState((s) => ({ transport: { ...s.transport, phase: 'playing' } }));
    expect(canPreview()).toBe(true);
    useStore.setState({ audioRecordingOperationId: 1 });
    expect(canPreview()).toBe(false);
    useStore.setState({ audioRecordingOperationId: null });
    useStore.setState((s) => ({ transport: { ...s.transport, phase: 'stopped' } }));
  });
});
