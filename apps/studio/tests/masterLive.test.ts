import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, deserializeProject, type Project, type Track } from '@cts/project-model';
import { getAudioEngine } from '../src/audio/engine';
import { previewNote } from '../src/audio/livePreview';
import { initAudioBridge } from '../src/audio/playback';
import { useStore } from '../src/state/store';

const ramp = { time: 0.25, timeConstant: 0.01 };

vi.mock('../src/audio/scheduler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/scheduler')>()),
  Scheduler: class {
    isRunning = false;
    start(): void {
      this.isRunning = true;
    }
    stop(): void {
      this.isRunning = false;
    }
    currentBeat(): number {
      return 0;
    }
  },
}));
vi.mock('../src/audio/graph', () => ({
  applyMixState: vi.fn(),
  buildTrackGraphs: () => new Map(),
}));

class FakeParam {
  value = 1;
  readonly ramps: { value: number; when: number; timeConstant: number }[] = [];
  setTargetAtTime(value: number, when: number, timeConstant: number): FakeParam {
    this.ramps.push({ value, when, timeConstant });
    return this;
  }
  setValueAtTime(): FakeParam {
    return this;
  }
  linearRampToValueAtTime(): FakeParam {
    return this;
  }
  cancelScheduledValues(): FakeParam {
    return this;
  }
}

class FakeAudioContext {
  readonly currentTime = ramp.time;
  readonly destination = {};
  state = 'running';
  private node() {
    return {
      gain: new FakeParam(),
      threshold: new FakeParam(),
      knee: new FakeParam(),
      ratio: new FakeParam(),
      attack: new FakeParam(),
      release: new FakeParam(),
      frequency: new FakeParam(),
      detune: new FakeParam(),
      Q: new FakeParam(),
      type: '',
      connect: (target: unknown) => target,
      start: () => undefined,
      stop: () => undefined,
    };
  }
  createGain = () => this.node();
  createAnalyser = () => this.node();
  createDynamicsCompressor = () => this.node();
  createOscillator = () => this.node();
  createBiquadFilter = () => this.node();
  close = async () => undefined;
}

function masterTrack(volume: number): Track {
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

function migratedFromV1(): Project {
  const project = createEmptyProject({ clock: () => new Date('2026-06-11T00:00:00.000Z') });
  return deserializeProject(
    JSON.stringify({ ...project, schemaVersion: 1, tracks: [masterTrack(0.8)] }),
  );
}

describe('live master gain', () => {
  let teardown: () => void;

  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    teardown = initAudioBridge();
  });

  afterEach(() => {
    if (useStore.getState().transport.isPlaying) useStore.getState().stop();
    teardown();
    vi.unstubAllGlobals();
  });

  it('plays a v1 project at gain 1, then ramps to the master fader while playing', async () => {
    useStore.getState().loadProjectForPreview(migratedFromV1());
    useStore.getState().play();

    const bus = (await getAudioEngine().ensureContext()).master.gain as unknown as FakeParam;
    await vi.waitFor(() => expect(bus.ramps).toHaveLength(1));
    expect(bus.ramps[0]).toEqual({ value: 1, when: ramp.time, timeConstant: ramp.timeConstant });
    await vi.waitFor(() => expect(useStore.getState().transport.isPlaying).toBe(true));

    useStore.getState().setTrackVolume('master', 0.5);

    await vi.waitFor(() => expect(bus.ramps).toHaveLength(2));
    expect(bus.ramps[1]).toEqual({ value: 0.5, when: ramp.time, timeConstant: ramp.timeConstant });
  });

  it('a first preview before any play follows the master fader (0)', async () => {
    await getAudioEngine().dispose();
    useStore.getState().loadProjectForPreview(migratedFromV1());
    useStore.getState().setTrackVolume('master', 0);
    await previewNote(undefined, 60);
    const bus = getAudioEngine().requireMaster().gain as unknown as FakeParam;
    expect(bus.value).toBe(0);
  });

  it('follows master fader changes while stopped, so previews hear them', async () => {
    useStore.getState().loadProjectForPreview(migratedFromV1());
    useStore.getState().setTrackVolume('master', 0);
    const bus = (await getAudioEngine().ensureContext()).master.gain as unknown as FakeParam;
    expect(useStore.getState().transport.isPlaying).toBe(false);
    const before = bus.ramps.length;
    useStore.getState().setTrackVolume('master', 1);
    expect(bus.ramps).toHaveLength(before + 1);
    expect(bus.ramps[bus.ramps.length - 1]).toEqual({
      value: 1,
      when: ramp.time,
      timeConstant: ramp.timeConstant,
    });
  });
});
