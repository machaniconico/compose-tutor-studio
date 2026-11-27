// Loop-range WAV export (P53). The synth and track graph are replaced by
// recorders so the test can assert absolute scheduling times and the trim.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProject,
  createInstrumentTrack,
  createMidiClip,
  createNoteEvent,
  resolveExportRange,
  type Project,
} from '@cts/project-model';

const recorded = vi.hoisted(() => ({
  notes: [] as Array<{
    pitch: number;
    time: number;
    duration: number;
    detune?: (param: unknown, stopTime: number) => void;
  }>,
  automation: [] as Array<{ trackId: string; type: string; value: number; time: number }>,
}));

vi.mock('../src/audio/synth', () => ({
  SynthVoiceManager: class {
    noteOn(
      pitch: number,
      time: number,
      duration: number,
      _velocity: unknown,
      _options: unknown,
      detune?: (param: unknown, stopTime: number) => void,
    ): void {
      recorded.notes.push({ pitch, time, duration, ...(detune ? { detune } : {}) });
    }
    dispose(): void {}
  },
}));

vi.mock('../src/audio/drums', () => ({
  createNoiseBuffer: () => ({}),
  DrumVoiceManager: class {
    trigger(): void {}
    dispose(): void {}
  },
}));

vi.mock('../src/audio/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/graph')>();
  return {
    ...actual,
    buildTrackGraphs: (
      _ctx: unknown,
      _destination: unknown,
      project: Project,
    ) => new Map(project.tracks.map((track) => [track.id, {
      input: {},
      scheduleAutomation: (type: string, value: number, time: number) => {
        recorded.automation.push({ trackId: track.id, type, value, time });
      },
      dispose: () => undefined,
    }])),
  };
});

import { encodeWav, renderProjectToWav } from '../src/audio/wav';
import { sha256Hex } from '../src/audio/audioAssetResolver';

const RATE = 44_100;

function installContext(frames: () => number, sample: (index: number) => number = (index) => index / 1_000_000) {
  const node = () => ({
    gain: { value: 1, setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() },
    threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  const contextArgs: number[][] = [];
  const context = {
    destination: {},
    createGain: vi.fn(node),
    createDynamicsCompressor: vi.fn(node),
    startRendering: vi.fn(async () => {
      const length = frames();
      // Sample value = frame index, so a trim is visible in the encoded bytes.
      const channel = Float32Array.from({ length }, (_, index) => sample(index));
      return {
        numberOfChannels: 2,
        sampleRate: RATE,
        length,
        getChannelData: () => channel,
      } as unknown as AudioBuffer;
    }),
  };
  vi.stubGlobal('OfflineAudioContext', vi.fn(function OfflineAudioContext(
    ...args: number[]
  ) {
    contextArgs.push(args);
    return context;
  }));
  return { context, contextArgs };
}

/** 120 bpm = 0.5 s per beat, 8 bars. */
function songProject(): Project {
  const project = createDefaultProject({ bpm: 120, lengthBars: 8 });
  const lead = createInstrumentTrack('Lead');
  const clip = createMidiClip(lead.id, 0, 32);
  if (clip.type !== 'midi') throw new Error('midi clip expected');
  clip.notes = [
    createNoteEvent(60, 0, 2, 100), // before the range
    createNoteEvent(62, 3, 4, 100), // starts before the range, sounds inside it
    createNoteEvent(64, 8, 1, 100), // inside the range
    createNoteEvent(65, 15, 4, 100), // starts inside, crosses the range end
    createNoteEvent(67, 16, 1, 100), // starts exactly at the range end
    createNoteEvent(69, 20, 1, 100), // after the range
  ];
  lead.clips = [clip];
  project.tracks.push(lead);
  project.automationLanes = [{
    id: 'lane-volume',
    bypassed: false,
    target: { type: 'track-volume', trackId: lead.id },
    points: [
      { id: 'a', beat: 0, value: 0.2, interpolation: 'hold' },
      { id: 'b', beat: 10, value: 0.9, interpolation: 'hold' },
    ],
  }];
  project.audioRouting = {
    outputs: project.tracks
      .filter((track) => track.type !== 'master')
      .map((track) => ({ sourceTrackId: track.id, destination: { type: 'master' as const } })),
    sends: [],
  };
  return project;
}

const rangeOf = (startBeat: number, endBeat: number) => {
  const resolved = resolveExportRange({ enabled: true, startBeat, endBeat }, 32);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.range;
};
const range = rangeOf(4, 16); // 2 s .. 8 s

afterEach(() => {
  vi.unstubAllGlobals();
  recorded.notes.length = 0;
  recorded.automation.length = 0;
});

describe('loop-range WAV export', () => {
  it('schedules at absolute times, keeps notes sounding at the start, drops later onsets', async () => {
    installContext(() => 100);
    const lease = await renderProjectToWav(songProject(), { range });
    lease.release();

    expect(recorded.notes.map((note) => [note.pitch, note.time])).toEqual([
      [60, 0],
      [62, 1.5],
      [64, 4],
      [65, 7.5],
    ]);
    // The note crossing the range end keeps its full length (full-song release rule).
    expect(recorded.notes.find((note) => note.pitch === 65)?.duration).toBeCloseTo(2, 6);
  });

  it('evaluates automation at absolute times over the whole prefix', async () => {
    installContext(() => 100);
    const lease = await renderProjectToWav(songProject(), { range });
    lease.release();
    const volume = recorded.automation.filter((command) => command.type === 'track-volume');
    expect(volume.map((command) => [command.value, command.time])).toEqual([
      [0.2, 0],
      [0.9, 5],
    ]);
  });

  it('evaluates cutoff detune at absolute times for a note that began before the range', async () => {
    const project = songProject();
    const lead = project.tracks.find((track) => track.name === 'Lead')!;
    project.automationLanes.push({
      id: 'lane-cutoff',
      bypassed: false,
      target: { type: 'track-filter-cutoff', trackId: lead.id },
      points: [
        { id: 'c1', beat: 0, value: 0, interpolation: 'hold' },
        { id: 'c2', beat: 5, value: 0.5, interpolation: 'hold' },
      ],
    });
    installContext(() => 100);
    const lease = await renderProjectToWav(project, { range });
    lease.release();

    const note = recorded.notes.find((candidate) => candidate.pitch === 62)!;
    const commands: Array<[number, number]> = [];
    note.detune!(
      {
        setValueAtTime: (value: number, time: number) => commands.push([value, time]),
        linearRampToValueAtTime: (value: number, time: number) => commands.push([value, time]),
      },
      note.time + note.duration,
    );
    // Beat 5 is 2.5 s after song start, not 0.5 s after the range start.
    expect(commands.some(([, time]) => Math.abs(time - 2.5) < 1e-9)).toBe(true);
  });

  it('sizes the render to the range end plus the tail and trims the start frame', async () => {
    const { contextArgs } = installContext(() => 8 * RATE + 1_000);
    const lease = await renderProjectToWav(songProject(), { range });
    const bytes = new Uint8Array(await lease.blob.arrayBuffer());
    lease.release();

    const [, frames] = contextArgs[0]!;
    expect(frames).toBeGreaterThan(8 * RATE);
    // 2 s start: 88_200 frames removed; the first kept sample is frame 88_200.
    const view = new DataView(bytes.buffer);
    expect((bytes.byteLength - 44) / 4).toBe(8 * RATE + 1_000 - 2 * RATE);
    // The first 5 ms (221 frames) fade in from silence; after that the render is untouched.
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(44 + 221 * 4, true)).toBe(Math.round(((88_200 + 221) / 1_000_000) * 0x7fff));
  });

  it('fades in 5 ms after the trim so a nonzero start sample does not click', async () => {
    installContext(() => 8 * RATE, () => 0.5);
    const lease = await renderProjectToWav(songProject(), { range });
    const view = new DataView(await lease.blob.arrayBuffer());
    lease.release();
    const fadeFrames = Math.round(0.005 * RATE);
    expect(view.getInt16(44, true)).toBe(0);
    // Linear ramp: halfway through the fade the sample is about half of 0.5.
    const mid = view.getInt16(44 + Math.floor(fadeFrames / 2) * 4, true);
    expect(Math.abs(mid - 0.25 * 0x7fff)).toBeLessThan(0.02 * 0x7fff);
    expect(view.getInt16(44 + fadeFrames * 4, true)).toBe(Math.round(0.5 * 0x7fff));
  });

  it('does not fade when the range starts at tick 0', async () => {
    installContext(() => 8 * RATE, () => 0.5);
    const lease = await renderProjectToWav(songProject(), { range: rangeOf(0, 16) });
    const view = new DataView(await lease.blob.arrayBuffer());
    lease.release();
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 0x7fff));
  });

  it('decides the exclusive end by the same rounded tick as MIDI', async () => {
    const project = songProject();
    const lead = project.tracks.find((track) => track.name === 'Lead')!;
    const clip = lead.clips[0]!;
    if (clip.type !== 'midi') throw new Error('midi clip expected');
    // 3.9995 beats rounds to tick 1920 = the exclusive end of [3, 4).
    clip.notes = [createNoteEvent(72, 3.9995, 1, 100), createNoteEvent(73, 3.99, 1, 100)];
    installContext(() => 100);
    const lease = await renderProjectToWav(project, { range: rangeOf(3, 4) });
    lease.release();
    expect(recorded.notes.map((note) => note.pitch)).toEqual([73]);
  });

  it('keeps full-song bytes identical to the unranged render', async () => {
    installContext(() => 3_000);
    const full = await renderProjectToWav(songProject());
    const fullBytes = new Uint8Array(await full.blob.arrayBuffer());
    full.release();
    const channel = Float32Array.from({ length: 3_000 }, (_, index) => index / 1_000_000);
    expect(await sha256Hex(fullBytes)).toBe(
      await sha256Hex(new Uint8Array(encodeWav([channel, channel], RATE))),
    );
  });
});

describe('shared export range rule', () => {
  const enabled = (startBeat: number, endBeat: number) => ({ enabled: true, startBeat, endBeat });

  it('rounds to whole ticks and clamps to the song length', () => {
    const result = resolveExportRange(enabled(1.0004, 99), 32);
    expect(result).toMatchObject({ ok: true, range: { startTick: 480, endTick: 15360 } });
  });

  it('is unavailable when the loop is off or empty', () => {
    expect(resolveExportRange({ enabled: false, startBeat: 0, endBeat: 8 }, 32)).toMatchObject({ ok: false, reason: 'unset' });
    expect(resolveExportRange(enabled(4, 4), 32)).toMatchObject({ ok: false, reason: 'empty' });
    expect(resolveExportRange(enabled(40, 50), 32)).toMatchObject({ ok: false, reason: 'empty' });
    expect(resolveExportRange(enabled(Number.NaN, 8), 32)).toMatchObject({ ok: false, reason: 'empty' });
    expect(resolveExportRange(enabled(1.0001, 1.0002), 32)).toMatchObject({ ok: false, reason: 'empty' });
  });
});
