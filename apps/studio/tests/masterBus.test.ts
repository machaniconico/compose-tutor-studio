import { describe, expect, it, vi } from 'vitest';
import {
  MASTER_LIMITER,
  MASTER_LIMITER_LOOKAHEAD_SECONDS,
  buildMasterBus,
} from '../src/audio/masterBus';
import { DYNAMICS_COMPRESSOR_LOOKAHEAD_SECONDS } from '../src/audio/voiceTiming';

function param() {
  return { value: 0 };
}

describe('buildMasterBus', () => {
  it('builds the one shared live/offline limiter topology', () => {
    const master = {
      gain: param(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const limiter = {
      threshold: param(),
      knee: param(),
      ratio: param(),
      attack: param(),
      release: param(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const destination = {} as AudioNode;
    const context = {
      createGain: vi.fn(() => master),
      createDynamicsCompressor: vi.fn(() => limiter),
    } as unknown as BaseAudioContext;

    expect(buildMasterBus(context, destination)).toEqual({ master, limiter });
    expect(master.gain.value).toBe(1);
    expect(limiter.threshold.value).toBe(MASTER_LIMITER.threshold);
    expect(limiter.knee.value).toBe(MASTER_LIMITER.knee);
    expect(limiter.ratio.value).toBe(MASTER_LIMITER.ratio);
    expect(limiter.attack.value).toBe(MASTER_LIMITER.attack);
    expect(limiter.release.value).toBe(MASTER_LIMITER.release);
    expect(master.connect).toHaveBeenCalledWith(limiter);
    expect(limiter.connect).toHaveBeenCalledWith(destination);
    expect(MASTER_LIMITER_LOOKAHEAD_SECONDS).toBe(
      DYNAMICS_COMPRESSOR_LOOKAHEAD_SECONDS,
    );
  });

  it('disconnects partial nodes when construction fails', () => {
    const master = {
      gain: param(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      createGain: vi.fn(() => master),
      createDynamicsCompressor: vi.fn(() => {
        throw new Error('limiter unavailable');
      }),
    } as unknown as BaseAudioContext;

    expect(() => buildMasterBus(context, {} as AudioNode)).toThrow('limiter unavailable');
    expect(master.disconnect).toHaveBeenCalledOnce();
  });
});
