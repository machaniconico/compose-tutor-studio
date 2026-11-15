import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, deserializeProject, type Track } from '@cts/project-model';
import { AudioEngine } from '../src/audio/engine';
import { applyMasterVolume, createMasterChain, masterGainFor } from '../src/audio/masterChain';
import { renderLengthSeconds, renderProjectToWav } from '../src/audio/wav';

class FakeParam {
  value = 0;
  setTargetAtTime(value: number): FakeParam {
    this.value = value;
    return this;
  }
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
  readonly pan = new FakeParam();
  readonly delayTime = new FakeParam();
  fftSize = 0;
  smoothingTimeConstant = 0;
  readonly targets: FakeNode[] = [];
  constructor(readonly kind: string) {}
  connect(target: FakeNode): FakeNode {
    this.targets.push(target);
    return target;
  }
  disconnect(): void {
    this.targets.length = 0;
  }
}

class FakeContext {
  readonly destination = new FakeNode('Destination');
  readonly created: FakeNode[] = [];
  state = 'running';
  readonly sampleRate = 44100;
  constructor(..._args: unknown[]) {}
  createGain() {
    return this.make('Gain');
  }
  createAnalyser() {
    return this.make('Analyser');
  }
  createDynamicsCompressor() {
    return this.make('DynamicsCompressor');
  }
  createStereoPanner() {
    return this.make('StereoPanner');
  }
  createDelay() {
    return this.make('Delay');
  }
  async resume(): Promise<void> {}
  async startRendering() {
    return {
      numberOfChannels: 2,
      sampleRate: 44100,
      getChannelData: () => new Float32Array(4),
    };
  }
  private make(kind: string): FakeNode {
    const node = new FakeNode(kind);
    this.created.push(node);
    return node;
  }
}

function master(volume: number): Track {
  return {
    id: 'master',
    name: 'Master',
    type: 'master',
    clips: [],
    volume,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('masterGainFor', () => {
  it('follows the master track volume, defaulting to 1', () => {
    expect(masterGainFor([master(0.5)])).toBe(0.5);
    expect(masterGainFor([master(1)])).toBe(1);
    expect(masterGainFor([])).toBe(1);
    expect(masterGainFor([master(5)])).toBe(2);
  });
});

describe('master chain wiring', () => {
  it('builds gain -> limiter -> destination with a meter tap', () => {
    const ctx = new FakeContext();
    const chain = createMasterChain(ctx as unknown as BaseAudioContext, [master(0.5)]);
    const input = chain.input as unknown as FakeNode;
    expect(input.gain.value).toBe(0.5);
    expect(input.targets).toEqual([chain.analyser, chain.limiter]);
    expect((chain.limiter as unknown as FakeNode).targets).toEqual([ctx.destination]);
    expect((chain.limiter as unknown as FakeNode).threshold.value).toBe(-3);
  });

  it('applyMasterVolume updates the live gain', () => {
    const ctx = new FakeContext();
    const chain = createMasterChain(ctx as unknown as BaseAudioContext, [master(1)]);
    applyMasterVolume(chain.input, [master(0.25)], 0);
    expect((chain.input as unknown as FakeNode).gain.value).toBe(0.25);
  });

  it('live engine goes through the master chain', async () => {
    const created: FakeContext[] = [];
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        constructor() {
          super();
          created.push(this);
        }
      },
    );
    const engine = new AudioEngine();
    const { master: bus } = await engine.ensureContext();
    const ctx = created[0];
    const limiter = ctx?.created.find((n) => n.kind === 'DynamicsCompressor');
    expect((bus as unknown as FakeNode).gain.value).toBe(1);
    expect((bus as unknown as FakeNode).targets).toContain(limiter);
    expect(limiter?.targets).toEqual([ctx?.destination]);
    applyMasterVolume(bus, [master(0.5)], 0);
    expect((bus as unknown as FakeNode).gain.value).toBe(0.5);
  });

  it('WAV render length covers the longest enabled delay', async () => {
    const lengths: unknown[] = [];
    vi.stubGlobal(
      'OfflineAudioContext',
      class extends FakeContext {
        constructor(...args: unknown[]) {
          super(...args);
          lengths.push(args[1]);
        }
      },
    );
    const project = createEmptyProject({
      bpm: 20,
      lengthBars: 1,
      timeSignature: [4, 4],
      clock: () => new Date('2026-06-11T00:00:00.000Z'),
    });
    const melody: Track = {
      ...master(1),
      id: 'melody',
      name: 'Melody',
      type: 'instrument',
      effects: [{ id: 'fx-delay', type: 'delay', enabled: true, params: { timeSeconds: 1.5 } }],
    };
    await renderProjectToWav({ ...project, tracks: [master(1), melody] });
    // 12 s song + 1.5 s delay + 1 s tail, at 44.1 kHz.
    expect(lengths[0]).toBe(Math.ceil(renderLengthSeconds({ ...project, tracks: [melody] }) * 44100));
    expect(lengths[0]).toBe(Math.ceil(14.5 * 44100));
  });

  it('WAV render of a project migrated from v1 uses gain 1', async () => {
    const created: FakeContext[] = [];
    vi.stubGlobal(
      'OfflineAudioContext',
      class extends FakeContext {
        constructor() {
          super();
          created.push(this);
        }
      },
    );
    const project = createEmptyProject({ clock: () => new Date('2026-06-11T00:00:00.000Z') });
    const v1 = { ...project, schemaVersion: 1, tracks: [master(0.8)] };
    const migrated = deserializeProject(JSON.stringify(v1));

    expect(masterGainFor(migrated.tracks)).toBe(1);
    await renderProjectToWav(migrated);
    expect(created[0]?.created.find((n) => n.kind === 'Gain')?.gain.value).toBe(1);
  });

  it.each([
    [0.5, 0.5],
    [1, 1],
  ])('WAV render uses master volume %s as gain %s', async (volume, gain) => {
    const created: FakeContext[] = [];
    vi.stubGlobal(
      'OfflineAudioContext',
      class extends FakeContext {
        constructor() {
          super();
          created.push(this);
        }
      },
    );
    const project = createEmptyProject({ clock: () => new Date('2026-06-11T00:00:00.000Z') });
    await renderProjectToWav({ ...project, tracks: [master(volume)] });
    const ctx = created[0];
    const limiter = ctx?.created.find((n) => n.kind === 'DynamicsCompressor');
    const bus = ctx?.created.find((n) => n.kind === 'Gain');
    expect(bus?.gain.value).toBe(gain);
    expect(bus?.targets).toContain(limiter);
    expect(limiter?.targets).toEqual([ctx?.destination]);
  });
});
