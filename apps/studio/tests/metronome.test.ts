import { describe, expect, it, vi } from 'vitest';
import { metronomeBeatEvents, scheduleMetronomeClick } from '../src/audio/metronome';

describe('metronomeBeatEvents', () => {
  it('emits one click per whole beat in [from, to)', () => {
    const clicks = metronomeBeatEvents(0, 4, 4);
    expect(clicks.map((c) => c.beat)).toEqual([0, 1, 2, 3]);
  });

  it('accents the first beat of each 4/4 bar', () => {
    const clicks = metronomeBeatEvents(0, 8, 4);
    expect(clicks.filter((c) => c.accent).map((c) => c.beat)).toEqual([0, 4]);
  });

  it('starts at the next whole beat when from is fractional', () => {
    const clicks = metronomeBeatEvents(1.4, 4, 4);
    expect(clicks.map((c) => c.beat)).toEqual([2, 3]);
  });

  it('accents on the bar start for a 3/4 meter', () => {
    const clicks = metronomeBeatEvents(0, 6, 3);
    expect(clicks.filter((c) => c.accent).map((c) => c.beat)).toEqual([0, 3]);
  });

  it('returns nothing for an empty range', () => {
    expect(metronomeBeatEvents(4, 4, 4)).toEqual([]);
  });

  it('cancels and disconnects a lookahead click before it can outlive its session', () => {
    const oscillator = {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
    } as unknown as BaseAudioContext;
    const output = {} as AudioNode;
    const ended = vi.fn();

    const click = scheduleMetronomeClick(context, output, 10, true, ended);
    click.cancel();
    click.cancel();

    expect(oscillator.stop).toHaveBeenLastCalledWith();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
  });
});
