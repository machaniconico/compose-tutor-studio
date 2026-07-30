import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compileAudioRouting,
  CURRENT_SCHEMA_VERSION,
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  ScheduleEventLimitError,
} from '@cts/project-model';
import type {
  AudioClip,
  Clip,
  DrumEvent,
  Project,
  ReadyAudioAsset,
  Track,
} from '@cts/project-model';
import {
  buildScheduleEvents,
  type DrumScheduleEvent,
  type NoteScheduleEvent,
} from '../src/audio/events';
import {
  AudioAssetPlaybackCache,
  AudioAssetPlaybackError,
  getAudioAssetPlaybackCache,
  setAudioAssetBytesResolver,
  sha256Hex,
} from '../src/audio/audioAssetResolver';
import {
  MAX_HEAVY_AUDIO_RESOURCE_BYTES,
  getReservedHeavyAudioResourceBytes,
  reserveHeavyAudioResources,
} from '../src/audio/audioResourceReservation';
import {
  AudioClipBufferCache,
  estimateAudioWarpResourcePeakBytes,
  getAudioClipBufferCache,
  type DerivedAudioBufferLease,
} from '../src/audio/audioClipBuffers';
import { compileAudioWarpRenderRequests } from '../src/audio/audioWarpPlan';
import { resolveAudioRoutingMix } from '../src/audio/graph';
import { acquireRuntimeProjectAudioBuffers } from '../src/audio/playback';
import {
  nextEventsInWindow,
} from '../src/audio/scheduler';
import {
  MAX_WAV_RENDER_ESTIMATED_BYTES,
  MAX_WAV_RENDER_SECONDS,
  MAX_WAV_SCHEDULE_EVENTS,
  MAX_WAV_TOTAL_ESTIMATED_BYTES,
  RENDER_CHANNELS,
  RENDER_SAMPLE_RATE,
  WavRenderLimitError,
  assertWavProjectCombinedResourceBudget,
  assertWavSourceOccurrenceBudget,
  buildWavAudioClipPlans,
  buildWavScheduleEvents,
  encodeWav,
  floatToInt16,
  planWavRender,
  renderProjectToWav,
  renderSelectedTrackToWav,
  resolveSelectedTrackRoutingMix,
  resolveWavRenderProject,
  scheduleWavFinalFade,
} from '../src/audio/wav';
import { MASTER_LIMITER_LOOKAHEAD_SECONDS } from '../src/audio/masterBus';
import { useStore } from '../src/state/store';

type DrumGrooveSettings = {
  swing: number;
  probability: number;
  humanizeVelocity: number;
  seed: number;
};

type DrumEventWithGroove = DrumEvent & {
  probability?: number;
};

type DrumClipWithGroove = Clip & {
  drumGroove?: Partial<DrumGrooveSettings>;
  drumEvents?: DrumEventWithGroove[];
};

/** Read a 4-char ASCII tag from an ArrayBuffer at an offset. */
function ascii(buffer: ArrayBuffer, offset: number, length = 4): string {
  const bytes = new Uint8Array(buffer, offset, length);
  return String.fromCharCode(...bytes);
}

function drumTrack(clip: Clip): Track {
  return {
    id: 'drums',
    name: 'Drums',
    type: 'drum',
    role: 'general',
    clips: [clip],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'drumkit', preset: 'basic' },
    effects: [],
  };
}

function projectWithDrumClip(clip: Clip): Project {
  const lengthBars = Math.max(
    1,
    Math.ceil((clip.startBeat + clip.lengthBeats) / 4),
  );
  return {
    id: 'project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'WAV test',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars,
    lengthBeats: lengthBars * 4,
    tempoMap: [{ id: 'wav-tempo-0', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'wav-meter-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    audioTakeFolders: [],
    automationLanes: [],
    automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    audioRouting: {
      outputs: [{ sourceTrackId: 'drums', destination: { type: 'master' } }],
      sends: [],
    },
    tracks: [drumTrack(clip)],
    chordTrack: [],
    sections: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
}

function projectWithMasterOnly(): Project {
  return {
    ...projectWithDrumClip({
      id: 'empty',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      drumEvents: [],
    }),
    tracks: [
      {
        id: 'master',
        name: 'Master',
        type: 'master',
        role: 'general',
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
    ],
    audioRouting: { outputs: [], sends: [] },
  };
}

function canonicalMonoPcm16Wav(frameCount: number): Uint8Array {
  const bytes = new Uint8Array(44 + frameCount * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, frameCount * 2, true);
  for (let frame = 0; frame < frameCount; frame += 1) {
    view.setInt16(44 + frame * 2, Math.round(Math.sin(frame / 17) * 12_000), true);
  }
  return bytes;
}

async function projectWithAudioClip(bytes: Uint8Array): Promise<Project> {
  const checksumSha256 = await sha256Hex(bytes);
  return {
    ...projectWithMasterOnly(),
    lengthBars: 2,
    lengthBeats: 8,
    audioAssets: [{
      id: 'wav-audio-asset',
      availability: 'ready',
      checksumSha256,
      originalName: 'canonical.wav',
      mediaType: 'audio/wav',
      byteLength: bytes.byteLength,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 48_000,
    }],
    tracks: [{
      id: 'wav-audio-track',
      name: 'Audio',
      type: 'audio',
      role: 'general',
      clips: [{
        id: 'wav-audio-clip',
        trackId: 'wav-audio-track',
        type: 'audio',
        startBeat: 1,
        lengthBeats: 4,
        loop: true,
        audioAssetId: 'wav-audio-asset',
        sourceStartFrame: 12_000,
        sourceFrameCount: 24_000,
        fadeInFrames: 2_400,
        fadeOutFrames: 4_800,
        gainDb: -3,
      }],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    }],
    audioRouting: {
      outputs: [{ sourceTrackId: 'wav-audio-track', destination: { type: 'master' } }],
      sends: [],
    },
  };
}

class DeterministicAudioWarpWorker {
  static instances: DeterministicAudioWarpWorker[] = [];
  readonly messages: unknown[] = [];
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor() {
    DeterministicAudioWarpWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
    const candidate = message as {
      type?: string;
      id?: number;
      generation?: number;
      request?: {
        targetSampleRate: number;
        outputFrameCount: number;
        channelCount: number;
      };
    };
    if (candidate.type !== 'render' || !candidate.request) return;
    const channels = Array.from(
      { length: candidate.request.channelCount },
      (_, channel) => Float32Array.from(
        { length: candidate.request!.outputFrameCount },
        (_unused, frame) => ((frame + channel * 7) % 31 - 15) / 16,
      ).buffer,
    );
    queueMicrotask(() => {
      const event = {
        data: {
          type: 'rendered',
          id: candidate.id,
          generation: candidate.generation,
          pcm: {
            sampleRate: candidate.request!.targetSampleRate,
            frameCount: candidate.request!.outputFrameCount,
            channelCount: candidate.request!.channelCount,
            channels,
          },
        },
      } as MessageEvent;
      for (const listener of this.listeners.get('message') ?? []) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    });
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {}
}

function liveAudioContext(frameCount: number) {
  return {
    sampleRate: 48_000,
    state: 'running',
    decodeAudioData: vi.fn(async () => ({
      duration: frameCount / 48_000,
      length: frameCount,
      sampleRate: 48_000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(frameCount),
    }) as unknown as AudioBuffer),
    createBuffer: vi.fn((channels: number, frames: number, sampleRate: number) => ({
      duration: frames / sampleRate,
      length: frames,
      sampleRate,
      numberOfChannels: channels,
      copyToChannel: vi.fn(),
    }) as unknown as AudioBuffer),
  } as unknown as AudioContext;
}

async function float32ChannelsSha256(
  channels: readonly Float32Array[],
): Promise<string> {
  const totalBytes = channels.reduce((total, channel) => total + channel.byteLength, 0);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const channel of channels) {
    bytes.set(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength), offset);
    offset += channel.byteLength;
  }
  return sha256Hex(bytes);
}

function installOfflineContext(startRendering: () => Promise<AudioBuffer>) {
  const master = {
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const limiter = {
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const context = {
    destination: {},
    createGain: vi.fn(() => master),
    createDynamicsCompressor: vi.fn(() => limiter),
    createAnalyser: vi.fn(() => {
      throw new Error('offline meters must stay disabled');
    }),
    startRendering: vi.fn(startRendering),
  };
  vi.stubGlobal(
    'OfflineAudioContext',
    vi.fn(function OfflineAudioContext() {
      return context;
    }),
  );
  return { context, master, limiter };
}

class AudioClipFakeParam {
  value = 0;
  readonly commands: Array<{ kind: string; value?: number; time: number }> = [];

  cancelScheduledValues(time: number): void {
    this.commands.push({ kind: 'cancel', time });
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.commands.push({ kind: 'set', value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.commands.push({ kind: 'linear', value, time });
  }
}

class AudioClipFakeNode {
  readonly connections: AudioClipFakeNode[] = [];
  readonly connectionHistory: AudioClipFakeNode[] = [];
  disconnectCalls = 0;

  connect(destination: AudioClipFakeNode): AudioClipFakeNode {
    this.connections.push(destination);
    this.connectionHistory.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connections.length = 0;
  }
}

class AudioClipFakeGain extends AudioClipFakeNode {
  readonly gain = new AudioClipFakeParam();
}

class AudioClipFakePanner extends AudioClipFakeNode {
  readonly pan = new AudioClipFakeParam();
}

class AudioClipFakeCompressor extends AudioClipFakeNode {
  readonly threshold = new AudioClipFakeParam();
  readonly knee = new AudioClipFakeParam();
  readonly ratio = new AudioClipFakeParam();
  readonly attack = new AudioClipFakeParam();
  readonly release = new AudioClipFakeParam();
}

class AudioClipFakeSource extends AudioClipFakeNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  readonly starts: Array<{ when: number; offset: number; duration: number }> = [];
  readonly stops: number[] = [];

  start(when: number, offset: number, duration: number): void {
    this.starts.push({ when, offset, duration });
  }

  stop(when: number): void {
    this.stops.push(when);
  }
}

function installAudioClipOfflineContext() {
  const sources: AudioClipFakeSource[] = [];
  const gains: AudioClipFakeGain[] = [];
  const destination = new AudioClipFakeNode();
  const decoded = {
    duration: 1,
    length: 44_100,
    sampleRate: 44_100,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(44_100),
  } as unknown as AudioBuffer;
  const rendered = {
    duration: 4,
    length: 1,
    sampleRate: 44_100,
    numberOfChannels: 2,
    getChannelData: () => new Float32Array(1),
  } as unknown as AudioBuffer;
  const context = {
    currentTime: 0,
    sampleRate: 44_100,
    destination,
    createGain: vi.fn(() => {
      const gain = new AudioClipFakeGain();
      gains.push(gain);
      return gain;
    }),
    createStereoPanner: vi.fn(() => new AudioClipFakePanner()),
    createDynamicsCompressor: vi.fn(() => new AudioClipFakeCompressor()),
    createBufferSource: vi.fn(() => {
      const source = new AudioClipFakeSource();
      sources.push(source);
      return source;
    }),
    createBuffer: vi.fn((channels: number, frames: number, sampleRate: number) => {
      const copied = Array.from({ length: channels }, () => new Float32Array(frames));
      return {
        numberOfChannels: channels,
        length: frames,
        sampleRate,
        duration: frames / sampleRate,
        copyToChannel: (source: Float32Array, channel: number) => {
          copied[channel]!.set(source);
        },
        copied,
      } as unknown as AudioBuffer;
    }),
    decodeAudioData: vi.fn(async () => decoded),
    startRendering: vi.fn(async () => rendered),
  };
  vi.stubGlobal(
    'OfflineAudioContext',
    vi.fn(function OfflineAudioContext() {
      return context;
    }),
  );
  return { context, sources, gains, destination };
}

function enablePreserveWarp(project: Project): AudioClip {
  project.lengthBars = 1;
  project.lengthBeats = 4;
  project.bpm = 240;
  project.tempoMap = [{ id: 'wav-preserve-tempo', beat: 0, bpm: 240 }];
  const clip = project.tracks[0]?.clips[0];
  if (!clip || clip.type !== 'audio') throw new Error('Audio fixture clip required');
  const audioClip = clip as AudioClip;
  audioClip.startBeat = 0;
  audioClip.lengthBeats = 4;
  audioClip.loop = false;
  audioClip.audioWarp = {
    algorithm: 'wsola-v1',
    formantMode: 'preserve',
    timingEnabled: true,
    pitchEnabled: true,
    markers: [
      { sourceFrame: audioClip.sourceStartFrame, targetBeatOffset: 0 },
      {
        sourceFrame: audioClip.sourceStartFrame + audioClip.sourceFrameCount,
        targetBeatOffset: 4,
      },
    ],
    pitchRegions: [{
      sourceStartFrame: audioClip.sourceStartFrame,
      sourceFrameCount: audioClip.sourceFrameCount,
      sourcePitchCents: 6_900,
      targetPitchCents: 7_000,
      correctionAmount: 1,
      transitionFrames: 0,
    }],
  };
  return audioClip;
}

async function addSecondaryCanonicalAudioTrack(
  project: Project,
  bytes: Uint8Array,
): Promise<ReadyAudioAsset> {
  const asset: ReadyAudioAsset = {
    id: 'wav-secondary-asset',
    availability: 'ready',
    checksumSha256: await sha256Hex(bytes),
    originalName: 'secondary.wav',
    mediaType: 'audio/wav',
    byteLength: bytes.byteLength,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 48_000,
  };
  project.audioAssets = [...project.audioAssets, asset];
  project.tracks = [...project.tracks, {
    id: 'wav-secondary-track',
    name: 'Secondary Audio',
    type: 'audio',
    role: 'general',
    clips: [{
      id: 'wav-secondary-clip',
      trackId: 'wav-secondary-track',
      type: 'audio',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      audioAssetId: asset.id,
      sourceStartFrame: 0,
      sourceFrameCount: 48_000,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      gainDb: 0,
    }],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  }];
  project.audioRouting = {
    ...project.audioRouting,
    outputs: [
      ...project.audioRouting.outputs,
      { sourceTrackId: 'wav-secondary-track', destination: { type: 'master' } },
    ],
  };
  return asset;
}

function wavScopeResourceThreshold(
  project: Project,
  scope: Readonly<
    | { kind: 'mix' }
    | { kind: 'selected-track'; trackId: string }
  >,
): Readonly<{ sourceProject: Project; thresholdBytes: number }> {
  const sourceProject = resolveWavRenderProject(project, scope);
  const compiled = compileAudioRouting(project);
  if (!compiled.ok) throw new Error('WAV threshold fixture routing must compile');
  const routingMix = scope.kind === 'mix'
    ? resolveAudioRoutingMix(project, compiled.plan)
    : resolveSelectedTrackRoutingMix(project, scope.trackId, compiled.plan);
  const renderPlan = planWavRender(
    project,
    buildWavScheduleEvents(sourceProject),
    buildWavAudioClipPlans(sourceProject),
    {
      plan: compiled.plan,
      audibleChannelIds: routingMix.audibleChannelIds,
      activeEdgeIds: routingMix.activeEdgeIds,
    },
  );
  const freshCache = new AudioClipBufferCache();
  const warpResources = estimateAudioWarpResourcePeakBytes(sourceProject, freshCache);
  return {
    sourceProject,
    thresholdBytes: assertWavProjectCombinedResourceBudget(
      renderPlan,
      sourceProject,
      0,
      warpResources.estimatedPeakBytes,
    ) - warpResources.retainedDerivedBytes,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('floatToInt16', () => {
  it('maps 0 to 0', () => {
    expect(floatToInt16(0)).toBe(0);
  });
  it('maps +1 to 0x7FFF and -1 to -0x8000', () => {
    expect(floatToInt16(1)).toBe(0x7fff);
    expect(floatToInt16(-1)).toBe(-0x8000);
  });
  it('clamps out-of-range samples', () => {
    expect(floatToInt16(2)).toBe(0x7fff);
    expect(floatToInt16(-2)).toBe(-0x8000);
  });
  it('scales mid values', () => {
    expect(floatToInt16(0.5)).toBe(Math.round(0.5 * 0x7fff));
    expect(floatToInt16(-0.5)).toBe(Math.round(-0.5 * 0x8000));
  });
});

describe('encodeWav header (stereo)', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, -1, 1, 0]);
  const buffer = encodeWav([left, right], 44100);
  const view = new DataView(buffer);

  it('writes RIFF / WAVE / fmt  / data tags', () => {
    expect(ascii(buffer, 0)).toBe('RIFF');
    expect(ascii(buffer, 8)).toBe('WAVE');
    expect(ascii(buffer, 12)).toBe('fmt ');
    expect(ascii(buffer, 36)).toBe('data');
  });

  it('has correct fmt fields for 16-bit PCM stereo', () => {
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint16(32, true)).toBe(4); // block align = 2ch * 2 bytes
    expect(view.getUint32(28, true)).toBe(44100 * 4); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('computes chunk sizes from the frame count', () => {
    const numFrames = 4;
    const blockAlign = 4;
    const dataSize = numFrames * blockAlign; // 16 bytes
    expect(view.getUint32(40, true)).toBe(dataSize); // data chunk size
    expect(view.getUint32(4, true)).toBe(36 + dataSize); // RIFF chunk size
    expect(buffer.byteLength).toBe(44 + dataSize);
  });

  it('interleaves L/R samples and clamps them', () => {
    // frame 0: L=0, R=0
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0);
    // frame 1: L=0.5, R=-1
    expect(view.getInt16(48, true)).toBe(floatToInt16(0.5));
    expect(view.getInt16(50, true)).toBe(-0x8000);
    // frame 3: L=1 (clamps to 0x7FFF), R=0
    expect(view.getInt16(56, true)).toBe(0x7fff);
    expect(view.getInt16(58, true)).toBe(0);
  });
});

describe('encodeWav (mono)', () => {
  it('produces a single-channel header', () => {
    const mono = new Float32Array([0.25, -0.25]);
    const buffer = encodeWav([mono], 22050);
    const view = new DataView(buffer);
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint16(32, true)).toBe(2); // block align = 1ch * 2 bytes
    expect(view.getUint32(40, true)).toBe(2 * 2); // 2 frames * 2 bytes
  });
});

describe('buildWavScheduleEvents drum groove parity', () => {
  it('stably orders an earlier linked instance before its later source for voice allocation', () => {
    const pitches = Array.from({ length: 20 }, (_, index) => 48 + index);
    const source: Clip = {
      id: 'later-source',
      trackId: 'lead',
      type: 'midi',
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      notes: pitches.map((pitch, index) => ({
        id: `ordered-note-${index}`,
        pitch,
        startBeat: 0,
        durationBeats: 1,
        velocity: 90,
      })),
    };
    const alias: Clip = {
      id: 'earlier-alias',
      trackId: 'lead',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      aliasOf: source.id,
    };
    const project: Project = {
      id: 'ordered-linked-project',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      title: 'Ordered linked WAV',
      bpm: 120,
      timeSignature: [4, 4],
      key: 'C',
      scale: 'major',
      lengthBars: 2,
      lengthBeats: 8,
      tempoMap: [{ id: 'ordered-tempo-0', beat: 0, bpm: 120 }],
      timeSignatureMap: [{
        id: 'ordered-meter-0',
        beat: 0,
        numerator: 4,
        denominator: 4,
      }],
      audioAssets: [],
      audioTakeFolders: [],
      automationLanes: [],
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
      audioRouting: {
        outputs: [{ sourceTrackId: 'lead', destination: { type: 'master' } }],
        sends: [],
      },
      tracks: [{
        id: 'lead',
        name: 'Lead',
        type: 'instrument',
        role: 'general',
        // Deliberately store the later source first to reproduce project-order
        // traversal that used to steal future voices before they started.
        clips: [source, alias],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'brightLead' },
        effects: [],
      }],
      chordTrack: [],
      sections: [],
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    };

    const schedule = buildWavScheduleEvents(project);
    expect(schedule).toHaveLength(40);
    expect(schedule.map((event) => event.beat)).toEqual([
      ...Array.from({ length: 20 }, () => 0),
      ...Array.from({ length: 20 }, () => 4),
    ]);
    expect(
      schedule.slice(0, 20).map(
        (event) => (event.payload as NoteScheduleEvent).pitch,
      ),
    ).toEqual(pitches);
    expect(
      schedule.slice(20).map(
        (event) => (event.payload as NoteScheduleEvent).pitch,
      ),
    ).toEqual(pitches);
  });

  it('resolves swung drum onset beats to the same time as live drum groove playback', () => {
    const clip: DrumClipWithGroove = {
      id: 'drum-clip',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumGroove: { swing: 0.6, probability: 1, humanizeVelocity: 0, seed: 23 },
      drumEvents: [{ id: 'kick-1', lane: 'kick', stepIndex: 1, velocity: 100 }],
    };
    const project = projectWithDrumClip(clip);
    const live = nextEventsInWindow(buildScheduleEvents(project), 0, 1, 120, 0, 0, null);
    const exported = buildWavScheduleEvents(project);

    expect(live).toHaveLength(1);
    expect(exported).toHaveLength(1);
    expect(exported[0]?.beat).toBeCloseTo((live[0]?.time ?? 0) * 2, 10);
    expect((exported[0]?.payload as DrumScheduleEvent).velocity)
      .toBe((live[0]?.payload as DrumScheduleEvent).velocity);
    expect((exported[0]?.payload as DrumScheduleEvent).voiceSeed)
      .toBe((live[0]?.payload as DrumScheduleEvent).voiceSeed);
  });

  it('drops a persisted probability-zero hit without UI runtime state', () => {
    const clip: DrumClipWithGroove = {
      id: 'drum-clip',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumGroove: { swing: 0, probability: 1, humanizeVelocity: 0, seed: 17 },
      drumEvents: [{ id: 'kick-0', lane: 'kick', stepIndex: 0, velocity: 100, probability: 0 }],
    };
    const project = projectWithDrumClip(clip);

    expect(buildWavScheduleEvents(project)).toEqual([]);
    expect(buildWavScheduleEvents(project)).toEqual([]);
  });

  it('matches live hit count, onset, and velocity across clips with different grooves', () => {
    const clipA: DrumClipWithGroove = {
      id: 'clip-a',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumGroove: { swing: 0, probability: 0, humanizeVelocity: 0, seed: 1 },
      drumEvents: [
        { id: 'muted-by-clip', lane: 'kick', stepIndex: 0, velocity: 100 },
        { id: 'event-override', lane: 'closedHat', stepIndex: 2, velocity: 80, probability: 1 },
      ],
    };
    const clipB: DrumClipWithGroove = {
      id: 'clip-b',
      trackId: 'drums',
      type: 'drum',
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumGroove: { swing: 1, probability: 1, humanizeVelocity: 100, seed: 99 },
      drumEvents: [
        { id: 'swung-humanized', lane: 'snare', stepIndex: 1, velocity: 64 },
      ],
    };
    const project = projectWithDrumClip(clipA);
    project.lengthBars = 2;
    project.lengthBeats = 8;
    project.tracks[0]!.clips = [clipA, clipB];

    const live = nextEventsInWindow(
      buildScheduleEvents(project),
      0,
      8,
      project.bpm,
      0,
      0,
      null,
    ).map((event) => ({
      beat: event.time * 2,
      lane: (event.payload as DrumScheduleEvent).lane,
      velocity: (event.payload as DrumScheduleEvent).velocity,
    }));
    const wav = buildWavScheduleEvents(project).map((event) => ({
      beat: event.beat,
      lane: (event.payload as DrumScheduleEvent).lane,
      velocity: (event.payload as DrumScheduleEvent).velocity,
    }));

    expect(wav).toEqual(live);
    expect(wav.map(({ lane }) => lane)).toEqual(['closedHat', 'snare']);
    expect(wav[1]?.beat).toBe(4.375);
  });

  it('drops valid raw final steps when swing moves them beyond partial clip ends', () => {
    const partial = (id: string, startBeat: number): DrumClipWithGroove => ({
      id,
      trackId: 'drums',
      type: 'drum',
      startBeat,
      lengthBeats: 0.3,
      loop: false,
      stepsPerBar: 16,
      drumGroove: { swing: 1, probability: 1, humanizeVelocity: 0, seed: 1 },
      drumEvents: [{ id: `${id}-final`, lane: 'kick', stepIndex: 1, velocity: 100 }],
    });
    const midProject = partial('mid-project', 1.7);
    const projectEnd = partial('project-end', 3.7);
    const project = projectWithDrumClip(midProject);
    project.tracks[0]!.clips = [midProject, projectEnd];
    const raw = buildScheduleEvents(project);

    expect(raw.map((event) => event.beat)).toEqual([1.95, 3.95]);
    expect(raw.map((event) => (event.payload as DrumScheduleEvent).clipEndBeat))
      .toEqual([2, 4]);
    expect(nextEventsInWindow(raw, 0, 5, 120, 0, 0, null)).toEqual([]);
    expect(buildWavScheduleEvents(project)).toEqual([]);
  });

  it('keeps default no-groove drum clips identical apart from resolved voice seeds', () => {
    const clip: Clip = {
      id: 'drum-clip',
      trackId: 'drums',
      type: 'drum',
      startBeat: 8,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [
        { id: 'kick-0', lane: 'kick', stepIndex: 0, velocity: 110 },
        { id: 'snare-4', lane: 'snare', stepIndex: 4, velocity: 90 },
      ],
    };
    const project = projectWithDrumClip(clip);
    const wavEvents = buildWavScheduleEvents(project);
    const sharedEvents = buildScheduleEvents(project);

    expect(wavEvents).toHaveLength(sharedEvents.length);
    for (const [index, wavEvent] of wavEvents.entries()) {
      const sharedEvent = sharedEvents[index];
      const wavPayload = wavEvent.payload as DrumScheduleEvent;
      const sharedPayload = sharedEvent?.payload as DrumScheduleEvent;
      expect(wavEvent.beat).toBe(sharedEvent?.beat);
      expect(wavPayload).toEqual({
        ...sharedPayload,
        voiceSeed: expect.any(Number),
      });
    }
    expect((wavEvents[0]?.payload as DrumScheduleEvent).velocity).toBe(110);
    expect((wavEvents[1]?.payload as DrumScheduleEvent).velocity).toBe(90);
  });

  it('uses denominator-aware quarter-note beats for 6/8 drum timing', () => {
    const clip: Clip = {
      id: 'six-eight-drums',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 3,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'middle', lane: 'kick', stepIndex: 8, velocity: 100 }],
    };
    const project = {
      ...projectWithDrumClip(clip),
      timeSignature: [6, 8] as [number, number],
      lengthBeats: 3,
      timeSignatureMap: [{
        id: 'wav-meter-six-eight',
        beat: 0,
        numerator: 6,
        denominator: 8,
      }],
    };

    expect(buildWavScheduleEvents(project)[0]?.beat).toBe(1.5);
  });
});

describe('MIDI Clip loop live/WAV parity', () => {
  function loopProject(lengthBeats: number, notes: NonNullable<Clip['notes']>): Project {
    const clip: Clip = {
      id: 'wav-midi-loop',
      trackId: 'lead',
      type: 'midi',
      startBeat: 0,
      lengthBeats,
      loop: true,
      notes,
    };
    return {
      id: 'wav-midi-loop-project',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      title: 'MIDI loop parity',
      bpm: 120,
      timeSignature: [4, 4],
      key: 'C',
      scale: 'major',
      lengthBars: Math.ceil(lengthBeats / 4),
      lengthBeats: Math.ceil(lengthBeats / 4) * 4,
      tempoMap: [{ id: 'wav-loop-tempo-0', beat: 0, bpm: 120 }],
      timeSignatureMap: [{
        id: 'wav-loop-meter-0',
        beat: 0,
        numerator: 4,
        denominator: 4,
      }],
      audioAssets: [],
      audioTakeFolders: [],
      automationLanes: [],
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
      audioRouting: {
        outputs: [{ sourceTrackId: 'lead', destination: { type: 'master' } }],
        sends: [],
      },
      tracks: [{
        id: 'lead',
        name: 'Lead',
        type: 'instrument',
        role: 'general',
        clips: [clip],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'brightLead' },
        effects: [],
      }],
      chordTrack: [],
      sections: [],
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    };
  }

  it('uses the shared expanded beats and final partial duration', () => {
    const project = loopProject(3.5, [
      { id: 'pulse', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
    ]);
    project.tracks[0]!.clips[0]!.startBeat = 4.5;
    project.lengthBars = 2;
    project.lengthBeats = 8;

    const readNotes = (events: ReturnType<typeof buildScheduleEvents>) =>
      events.map((event) => ({
        beat: event.beat,
        duration: (event.payload as NoteScheduleEvent).durationBeats,
      }));

    expect(readNotes(buildWavScheduleEvents(project))).toEqual(
      readNotes(buildScheduleEvents(project)),
    );
    expect(readNotes(buildWavScheduleEvents(project))).toEqual([
      { beat: 4.5, duration: 1 },
      { beat: 5.5, duration: 1 },
      { beat: 6.5, duration: 1 },
      { beat: 7.5, duration: 0.5 },
    ]);
  });

  it('accepts exactly 10,000 expanded WAV notes and rejects one more', () => {
    const notes = [
      { id: 'boundary-a', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 },
      { id: 'boundary-b', pitch: 64, startBeat: 0.5, durationBeats: 0.5, velocity: 90 },
    ];

    expect(buildWavScheduleEvents(loopProject(5_000, notes))).toHaveLength(10_000);
    expect(() => buildWavScheduleEvents(loopProject(5_000.25, notes))).toThrowError(
      expect.objectContaining({
        reason: 'total',
        limit: MAX_WAV_SCHEDULE_EVENTS,
        observed: 10_001,
      }) as ScheduleEventLimitError,
    );
  });
});

describe('WAV render allocation budget', () => {
  it('rejects a dense linked onset window before constructing OfflineAudioContext', async () => {
    const source: Clip = {
      id: 'bounded-drum-source',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: Array.from({ length: 3 }, (_, index) => ({
        id: `bounded-hit-${index}`,
        lane: 'kick' as const,
        stepIndex: 0,
        velocity: 100,
      })),
    };
    const project = projectWithDrumClip(source);
    project.schemaVersion = CURRENT_SCHEMA_VERSION;
    project.tracks[0]!.clips = [
      source,
      ...Array.from({ length: 99 }, (_, index): Clip => ({
        id: `bounded-drum-alias-${index}`,
        trackId: 'drums',
        type: 'drum',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        aliasOf: source.id,
      })),
    ];
    const offlineContext = vi.fn(() => {
      throw new Error('OfflineAudioContext must not be allocated');
    });
    vi.stubGlobal('OfflineAudioContext', offlineContext);

    await expect(renderProjectToWav(project)).rejects.toMatchObject({
      name: 'ScheduleEventLimitError',
      code: 'schedule-event-limit-exceeded',
      reason: 'density',
      limit: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
      observed: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW + 1,
    } satisfies Partial<ScheduleEventLimitError>);
    expect(offlineContext).not.toHaveBeenCalled();
  });

  it('applies the lower whole-song WAV schedule ceiling before allocation', () => {
    const source: Clip = {
      id: 'wav-total-source',
      trackId: 'drums',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 1,
      loop: false,
      notes: Array.from({ length: 11 }, (_, index) => ({
        id: `wav-total-note-${index}`,
        pitch: 60 + index,
        startBeat: index / 16,
        durationBeats: 1 / 32,
        velocity: 90,
      })),
    };
    const track: Track = {
      id: 'wav-total-track',
      name: 'Lead',
      type: 'instrument',
      role: 'general',
      clips: [source],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    };
    source.trackId = track.id;
    track.clips = [
      source,
      ...Array.from({ length: 999 }, (_, index): Clip => ({
        id: `wav-total-alias-${index}`,
        trackId: track.id,
        type: 'midi',
        startBeat: index + 1,
        lengthBeats: 1,
        loop: false,
        aliasOf: source.id,
      })),
    ];
    const project: Project = {
      ...projectWithDrumClip({
        id: 'unused',
        trackId: 'drums',
        type: 'drum',
        startBeat: 0,
        lengthBeats: 1,
        loop: false,
        drumEvents: [],
      }),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lengthBars: 256,
      lengthBeats: 1_024,
      tracks: [track],
    };

    expect(() => buildWavScheduleEvents(project)).toThrowError(
      expect.objectContaining({
        reason: 'total',
        limit: MAX_WAV_SCHEDULE_EVENTS,
        observed: 11_000,
      }) as ScheduleEventLimitError,
    );
  });

  it('shares one offline source-node ceiling across notes/drums and Audio Clips', () => {
    const scheduled = Array.from({ length: 6_000 }, () => ({}));
    const audioClips = Array.from({ length: 4_001 }, () => ({}));

    expect(() => assertWavSourceOccurrenceBudget(
      scheduled as never[],
      audioClips as never[],
    )).toThrowError(expect.objectContaining({
      name: 'ScheduleEventLimitError',
      reason: 'total',
      limit: MAX_WAV_SCHEDULE_EVENTS,
      observed: MAX_WAV_SCHEDULE_EVENTS + 1,
    }) as ScheduleEventLimitError);
  });

  it('combines offline output and decoded audio before context allocation', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const project = await projectWithAudioClip(bytes);
    project.lengthBars = 150;
    project.lengthBeats = 600;
    const sourceAsset = project.audioAssets[0];
    if (!sourceAsset || sourceAsset.availability !== 'ready') {
      throw new Error('ready WAV fixture asset required');
    }
    project.audioAssets[0] = {
      ...sourceAsset,
      // Exactly the resolver's individual 256 MiB decoded ceiling at 48 kHz;
      // the 44.1 kHz decode plus a five-minute output exceeds the shared cap.
      frameCount: 67_108_864,
    };
    const offlineContext = vi.fn(() => {
      throw new Error('OfflineAudioContext must not be allocated');
    });
    vi.stubGlobal('OfflineAudioContext', offlineContext);

    await expect(renderProjectToWav(project, {
      audioAssetResolver: { resolve: async () => bytes },
      audioAssetCache: new AudioAssetPlaybackCache(),
    })).rejects.toMatchObject({
      name: 'AudioAssetPlaybackError',
      code: 'resource-limit',
      assetId: 'wav-audio-asset',
    });
    expect(offlineContext).not.toHaveBeenCalled();
  });

  it('takes the larger resolver/hash phase before reading a raw-heavy asset', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const project = await projectWithAudioClip(bytes);
    const sourceAsset = project.audioAssets[0];
    if (!sourceAsset || sourceAsset.availability !== 'ready') {
      throw new Error('ready WAV fixture asset required');
    }
    project.audioAssets[0] = {
      ...sourceAsset,
      byteLength: Math.floor(MAX_WAV_TOTAL_ESTIMATED_BYTES / 3) + 1,
    };
    const resolve = vi.fn(async () => bytes);
    const offlineContext = vi.fn(() => {
      throw new Error('OfflineAudioContext must not be allocated');
    });
    vi.stubGlobal('OfflineAudioContext', offlineContext);

    await expect(renderProjectToWav(project, {
      audioAssetResolver: { resolve },
      audioAssetCache: new AudioAssetPlaybackCache(),
    })).rejects.toMatchObject({
      name: 'AudioAssetPlaybackError',
      code: 'resource-limit',
      assetId: 'wav-audio-asset',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(offlineContext).not.toHaveBeenCalled();
  });

  it('rejects a competing WAV reservation before resolver or context allocation', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const project = await projectWithAudioClip(bytes);
    const resolve = vi.fn(async () => bytes);
    const offlineContext = vi.fn(() => {
      throw new Error('OfflineAudioContext must not be allocated');
    });
    vi.stubGlobal('OfflineAudioContext', offlineContext);
    const first = reserveHeavyAudioResources(MAX_HEAVY_AUDIO_RESOURCE_BYTES - 1);

    try {
      await expect(renderProjectToWav(project, {
        audioAssetResolver: { resolve },
        audioAssetCache: new AudioAssetPlaybackCache(),
      })).rejects.toMatchObject({
        name: 'AudioAssetPlaybackError',
        code: 'resource-limit',
        assetId: 'wav-audio-asset',
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(offlineContext).not.toHaveBeenCalled();
    } finally {
      first.release();
    }
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('enforces each scoped preserve WAV T boundary before any T-1 allocation', async () => {
    const bytes = canonicalMonoPcm16Wav(48_000);
    const secondaryBytes = canonicalMonoPcm16Wav(48_000);
    new DataView(secondaryBytes.buffer).setInt16(44, 1_234, true);
    const project = await projectWithAudioClip(bytes);
    const audioClip = enablePreserveWarp(project);
    const secondaryAsset = await addSecondaryCanonicalAudioTrack(project, secondaryBytes);
    const bytesByAssetId = new Map([
      ['wav-audio-asset', bytes],
      [secondaryAsset.id, secondaryBytes],
    ]);
    const cache = getAudioClipBufferCache();
    const defaultAssetCache = getAudioAssetPlaybackCache();
    cache.clearUnused();
    defaultAssetCache.clearUnused();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);

    const consumers = [
      {
        name: 'full',
        scope: { kind: 'mix' } as const,
        render: (
          assetCache: AudioAssetPlaybackCache,
          derivedCache: AudioClipBufferCache,
          resolve: (
            asset: ReadyAudioAsset,
          ) => Promise<Uint8Array>,
        ) => renderProjectToWav(project, {
          audioAssetResolver: { resolve },
          audioAssetCache: assetCache,
          audioClipBufferCache: derivedCache,
        }),
      },
      {
        name: 'selected',
        scope: { kind: 'selected-track', trackId: audioClip.trackId } as const,
        render: (
          assetCache: AudioAssetPlaybackCache,
          derivedCache: AudioClipBufferCache,
          resolve: (
            asset: ReadyAudioAsset,
          ) => Promise<Uint8Array>,
        ) => renderSelectedTrackToWav(
          project,
          audioClip.trackId,
          {
            audioAssetResolver: { resolve },
            audioAssetCache: assetCache,
            audioClipBufferCache: derivedCache,
          },
        ),
      },
    ];
    const thresholds = consumers.map((consumer) => ({
      ...consumer,
      ...wavScopeResourceThreshold(project, consumer.scope),
    }));
    expect(thresholds[0]!.sourceProject).toBe(project);
    expect(thresholds[1]!.sourceProject).not.toBe(project);
    expect(thresholds[0]!.thresholdBytes).toBeGreaterThan(
      thresholds[1]!.thresholdBytes,
    );

    for (const consumer of thresholds) {
      for (const remaining of [null, consumer.thresholdBytes] as const) {
        cache.clearUnused();
        defaultAssetCache.clearUnused();
        const assetCache = new AudioAssetPlaybackCache();
        const derivedCache = new AudioClipBufferCache();
        const resolve = vi.fn(async (asset: ReadyAudioAsset) => {
          const resolved = bytesByAssetId.get(asset.id);
          if (!resolved) throw new Error(`Unexpected asset ${asset.id}`);
          return resolved;
        });
        DeterministicAudioWarpWorker.instances = [];
        vi.stubGlobal('Worker', DeterministicAudioWarpWorker);
        const { context } = installAudioClipOfflineContext();
        const competing = remaining === null
          ? null
          : reserveHeavyAudioResources(
            MAX_HEAVY_AUDIO_RESOURCE_BYTES - remaining,
          );
        let rendered: Awaited<ReturnType<typeof renderProjectToWav>> | null = null;
        try {
          rendered = await consumer.render(assetCache, derivedCache, resolve);
          expect(resolve).toHaveBeenCalled();
          expect(DeterministicAudioWarpWorker.instances).toHaveLength(1);
          expect(context.createBuffer).toHaveBeenCalled();
          expect(derivedCache.entryCount).toBe(1);
          rendered.release();
          derivedCache.clearUnused();
          assetCache.clearUnused();
          competing?.release();
          expect(getReservedHeavyAudioResourceBytes()).toBe(0);
        } finally {
          rendered?.release();
          derivedCache.clearUnused();
          assetCache.clearUnused();
          competing?.release();
        }
      }

      cache.clearUnused();
      defaultAssetCache.clearUnused();
      const assetCache = new AudioAssetPlaybackCache();
      const derivedCache = new AudioClipBufferCache();
      const resolve = vi.fn(async (asset: ReadyAudioAsset) => {
        const resolved = bytesByAssetId.get(asset.id);
        if (!resolved) throw new Error(`Unexpected asset ${asset.id}`);
        return resolved;
      });
      const createBuffer = vi.fn();
      const offlineContext = vi.fn(() => ({ createBuffer }));
      DeterministicAudioWarpWorker.instances = [];
      vi.stubGlobal('OfflineAudioContext', offlineContext);
      vi.stubGlobal('Worker', DeterministicAudioWarpWorker);
      const acquireSpy = vi.spyOn(AudioClipBufferCache.prototype, 'acquire');
      const competing = reserveHeavyAudioResources(
        MAX_HEAVY_AUDIO_RESOURCE_BYTES - consumer.thresholdBytes + 1,
      );
      try {
        await expect(consumer.render(assetCache, derivedCache, resolve)).rejects.toMatchObject({
          name: 'AudioAssetPlaybackError',
          code: 'resource-limit',
        });
        expect(resolve, `${consumer.name} resolver`).not.toHaveBeenCalled();
        expect(DeterministicAudioWarpWorker.instances).toHaveLength(0);
        expect(offlineContext).not.toHaveBeenCalled();
        expect(createBuffer).not.toHaveBeenCalled();
        expect(acquireSpy).not.toHaveBeenCalled();
        expect(derivedCache.entryCount).toBe(0);
        expect(derivedCache.retainedDerivedBytes).toBe(0);
        expect(assetCache.retainedDecodedBytes).toBe(0);
        expect(defaultAssetCache.retainedDecodedBytes).toBe(0);
        expect(getReservedHeavyAudioResourceBytes()).toBe(competing.bytes);
      } finally {
        acquireSpy.mockRestore();
        competing.release();
        derivedCache.clearUnused();
        assetCache.clearUnused();
      }
      expect(getReservedHeavyAudioResourceBytes()).toBe(0);
    }
  });

  it('rejects an hours-long valid timeline before constructing OfflineAudioContext', () => {
    const project = projectWithDrumClip({
      id: 'long',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 1,
      loop: false,
      drumEvents: [],
    });
    project.lengthBars = 100;
    project.lengthBeats = 400;
    project.timeSignature = [4, 4];
    project.bpm = 20;
    project.tempoMap = [{ id: 'wav-tempo-slow', beat: 0, bpm: 20 }];

    expect(() => planWavRender(project)).toThrow(WavRenderLimitError);
  });

  it('returns a bounded plan for an ordinary short song', () => {
    const project = projectWithDrumClip({
      id: 'short',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      drumEvents: [],
    });
    const plan = planWavRender(project);

    expect(plan.songSeconds).toBe(2);
    expect(plan.tailSeconds).toBe(0);
    expect(plan.totalSeconds).toBe(2);
    expect(plan.postLimiterTailSeconds).toBe(0);
    expect(plan.fadeStartSeconds).toBeNull();
    expect(plan.fadeEndSeconds).toBeNull();
    expect(plan.songSeconds).toBeLessThan(MAX_WAV_RENDER_SECONDS);
    expect(plan.frames).toBe(2 * RENDER_SAMPLE_RATE);
    expect(plan.estimatedBytes).toBe(
      plan.frames * RENDER_CHANNELS * Float32Array.BYTES_PER_ELEMENT
        + 44
        + plan.frames * RENDER_CHANNELS * 2,
    );
    expect(plan.exportEstimatedBytes).toBe(
      plan.frames * RENDER_CHANNELS * Float32Array.BYTES_PER_ELEMENT
        + (44 + plan.frames * RENDER_CHANNELS * 2) * 4,
    );
  });

  it('accepts the end-to-end export reservation boundary and rejects one byte over', () => {
    const project = projectWithMasterOnly();
    const plan = planWavRender(project);

    expect(assertWavProjectCombinedResourceBudget({
      ...plan,
      exportEstimatedBytes: MAX_WAV_TOTAL_ESTIMATED_BYTES,
    }, project)).toBe(MAX_WAV_TOTAL_ESTIMATED_BYTES);
    expect(() => assertWavProjectCombinedResourceBudget({
      ...plan,
      exportEstimatedBytes: MAX_WAV_TOTAL_ESTIMATED_BYTES + 1,
    }, project)).toThrowError(expect.objectContaining({
      name: 'AudioAssetPlaybackError',
      code: 'resource-limit',
    }) as AudioAssetPlaybackError);
  });

  it('allocates the resolved final open-hat source tail instead of a fixed second', () => {
    const project = projectWithDrumClip({
      id: 'final-hat',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'hat-15', lane: 'openHat', stepIndex: 15, velocity: 100 }],
    });
    const plan = planWavRender(project);

    expect(plan.tailSeconds).toBeCloseTo(0.251, 10);
    expect(plan.totalSeconds).toBeCloseTo(2.251, 10);
    expect(plan.postLimiterTailSeconds).toBe(MASTER_LIMITER_LOOKAHEAD_SECONDS);
    expect(plan.fadeEndSeconds).toBeCloseTo(2.245, 10);
    expect(plan.frames).toBe(Math.ceil(plan.totalSeconds * RENDER_SAMPLE_RATE));
  });

  it('allocates coefficient-derived filter ringing before the limiter cleanup frames', () => {
    const project = projectWithDrumClip({
      id: 'filtered-final-hat',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'hat-15', lane: 'openHat', stepIndex: 15, velocity: 100 }],
    });
    const dry = planWavRender(project);
    project.tracks[0]!.effects = [{
      id: 'max-filter',
      type: 'filter',
      enabled: true,
      params: { cutoff: 0, resonance: 1 },
    }];
    const filtered = planWavRender(project);

    expect(filtered.tailSeconds).toBeGreaterThan(dry.tailSeconds + 0.3);
    expect(filtered.fadeEndSeconds).toBeCloseTo(
      filtered.totalSeconds - MASTER_LIMITER_LOOKAHEAD_SECONDS,
      12,
    );
    expect(filtered.frames).toBe(Math.ceil(filtered.totalSeconds * RENDER_SAMPLE_RATE));
    expect(filtered.frames).toBeGreaterThan(dry.frames);
  });

  it('caps recursive inserts, accounts for their bytes, and schedules the final fade', () => {
    const project = projectWithDrumClip({
      id: 'final-hat',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'hat-15', lane: 'openHat', stepIndex: 15, velocity: 100 }],
    });
    project.tracks[0]!.effects = [
      {
        id: 'delay-1',
        type: 'delay',
        enabled: true,
        params: { delayTime: 1, feedback: 1, mix: 1 },
      },
      {
        id: 'delay-2',
        type: 'delay',
        enabled: true,
        params: { delayTime: 1, feedback: 1, mix: 1 },
      },
    ];
    const plan = planWavRender(project);
    const param = {
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    } as unknown as AudioParam;

    scheduleWavFinalFade(param, plan);

    expect(plan.tailCapped).toBe(true);
    expect(plan.tailSeconds).toBe(40);
    expect(plan.totalSeconds).toBe(42);
    expect(plan.estimatedBytes).toBe(
      plan.frames * RENDER_CHANNELS * Float32Array.BYTES_PER_ELEMENT
        + 44
        + plan.frames * RENDER_CHANNELS * 2,
    );
    expect(plan.estimatedBytes).toBeLessThan(MAX_WAV_RENDER_ESTIMATED_BYTES);
    expect(plan.fadeEndSeconds).toBe(42 - MASTER_LIMITER_LOOKAHEAD_SECONDS);
    expect(param.setValueAtTime).toHaveBeenCalledWith(
      1,
      42 - MASTER_LIMITER_LOOKAHEAD_SECONDS - 0.05,
    );
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(
      0,
      42 - MASTER_LIMITER_LOOKAHEAD_SECONDS,
    );
  });

  it('allows a five-minute song body plus its bounded tail under the 192 MiB budget', () => {
    const project = projectWithDrumClip({
      id: 'five-minute-final-hat',
      trackId: 'drums',
      type: 'drum',
      startBeat: 596,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'hat-599-75', lane: 'openHat', stepIndex: 15, velocity: 100 }],
    });
    project.lengthBars = 150;
    project.lengthBeats = 600;
    project.tracks[0]!.effects = [
      {
        id: 'delay-1',
        type: 'delay',
        enabled: true,
        params: { delayTime: 1, feedback: 1, mix: 1 },
      },
      {
        id: 'delay-2',
        type: 'delay',
        enabled: true,
        params: { delayTime: 1, feedback: 1, mix: 1 },
      },
    ];

    const plan = planWavRender(project);

    expect(plan.songSeconds).toBe(MAX_WAV_RENDER_SECONDS);
    expect(plan.tailSeconds).toBe(40);
    expect(plan.totalSeconds).toBe(340);
    expect(plan.estimatedBytes).toBeLessThan(MAX_WAV_RENDER_ESTIMATED_BYTES);
  });
});

describe('WAV Audio Clip integration', () => {
  it('uses the shared interval planner for source range, clip loop, gain, and fades', async () => {
    const project = await projectWithAudioClip(Uint8Array.from([1, 2, 3, 4]));
    const [plan] = buildWavAudioClipPlans(project);

    expect(plan).toMatchObject({
      trackId: 'wav-audio-track',
      clipId: 'wav-audio-clip',
      assetId: 'wav-audio-asset',
      startBeat: 1,
      endBeat: 5,
      sourceOffsetSeconds: 0.25,
      durationSeconds: 2,
      loopStartSeconds: 0.25,
      loopEndSeconds: 0.75,
    });
    expect(plan?.gainPoints[0]?.value).toBe(0);
    expect(plan?.gainPoints.at(-1)?.value).toBe(0);
  });

  it('reports an Audio Clip-only source overflow as the shared event limit', async () => {
    const project = await projectWithAudioClip(Uint8Array.from([1, 2, 3, 4]));
    const source = project.tracks[0]?.clips[0];
    if (!source || source.type !== 'audio') throw new Error('audio fixture clip required');
    project.tracks[0]!.clips = Array.from(
      { length: MAX_WAV_SCHEDULE_EVENTS + 1 },
      (_, index) => ({ ...source, id: `wav-audio-clip-${index}` }),
    );

    expect(() => buildWavAudioClipPlans(project)).toThrowError(
      expect.objectContaining({
        name: 'ScheduleEventLimitError',
        code: 'schedule-event-limit-exceeded',
        reason: 'total',
        limit: MAX_WAV_SCHEDULE_EVENTS,
        observed: MAX_WAV_SCHEDULE_EVENTS + 1,
      }) as ScheduleEventLimitError,
    );
  });

  it('rejects a missing asset before constructing OfflineAudioContext', async () => {
    const project = await projectWithAudioClip(Uint8Array.from([1, 2, 3, 4]));
    const offlineContext = vi.fn(() => {
      throw new Error('OfflineAudioContext must not be allocated');
    });
    vi.stubGlobal('OfflineAudioContext', offlineContext);
    const missing = new AudioAssetPlaybackError(
      'asset-missing',
      'wav-audio-asset',
    );

    await expect(renderProjectToWav(project, {
      audioAssetResolver: { resolve: async () => { throw missing; } },
    })).rejects.toBe(missing);
    expect(offlineContext).not.toHaveBeenCalled();
  });

  it('rejects changed bytes before constructing OfflineAudioContext', async () => {
    const project = await projectWithAudioClip(Uint8Array.from([1, 2, 3, 4]));
    const offlineContext = vi.fn(() => {
      throw new Error('OfflineAudioContext must not be allocated');
    });
    vi.stubGlobal('OfflineAudioContext', offlineContext);

    await expect(renderProjectToWav(project, {
      audioAssetResolver: { resolve: async () => Uint8Array.from([1, 2, 3, 9]) },
    })).rejects.toMatchObject({
      code: 'asset-changed',
      assetId: 'wav-audio-asset',
    });
    expect(offlineContext).not.toHaveBeenCalled();
  });

  it('resolves only selected Audio sources and ignores unrelated broken or oversized assets', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const project = await projectWithAudioClip(bytes);
    const selectedTrack = project.tracks[0]!;
    const unrelatedAsset = {
      ...project.audioAssets[0]!,
      id: 'unrelated-broken-asset',
      originalName: 'missing-and-oversized.wav',
      checksumSha256: 'f'.repeat(64),
      byteLength: MAX_HEAVY_AUDIO_RESOURCE_BYTES + 1,
      frameCount: MAX_HEAVY_AUDIO_RESOURCE_BYTES,
    };
    project.audioAssets.push(unrelatedAsset);
    project.tracks.push({
      ...selectedTrack,
      id: 'unrelated-audio-track',
      name: 'Unrelated broken Audio',
      clips: selectedTrack.clips.map((clip) => ({
        ...clip,
        id: 'unrelated-audio-clip',
        trackId: 'unrelated-audio-track',
        audioAssetId: unrelatedAsset.id,
      })),
    });
    project.audioRouting.outputs.push({
      sourceTrackId: 'unrelated-audio-track',
      destination: { type: 'master' },
    });
    const resolve = vi.fn(async (asset: { id: string }) => {
      if (asset.id !== 'wav-audio-asset') throw new Error('unrelated resolver I/O leaked');
      return bytes;
    });
    installAudioClipOfflineContext();

    const rendered = await renderSelectedTrackToWav(project, selectedTrack.id, {
      audioAssetResolver: { resolve },
    });
    rendered.release();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({ id: 'wav-audio-asset' });
  });

  it('fails a selected missing Audio asset before OfflineAudioContext construction', async () => {
    const project = await projectWithAudioClip(Uint8Array.from([1, 2, 3, 4]));
    const offlineContext = vi.fn(() => {
      throw new Error('OfflineAudioContext must not be allocated');
    });
    vi.stubGlobal('OfflineAudioContext', offlineContext);
    const missing = new AudioAssetPlaybackError(
      'asset-missing',
      'wav-audio-asset',
    );

    await expect(renderSelectedTrackToWav(project, 'wav-audio-track', {
      audioAssetResolver: { resolve: async () => { throw missing; } },
    })).rejects.toBe(missing);
    expect(offlineContext).not.toHaveBeenCalled();
  });

  it('decodes, schedules, loops, and releases the planned Audio Clip source', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const project = await projectWithAudioClip(bytes);
    const { context, sources, destination } = installAudioClipOfflineContext();

    const rendered = await renderProjectToWav(project, {
      audioAssetResolver: { resolve: async () => bytes },
    });
    expect(rendered.blob).toBeInstanceOf(Blob);
    rendered.release();

    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      loop: true,
      loopStart: 0.25,
      loopEnd: 0.75,
      starts: [{ when: 0.5, offset: 0.25, duration: 2 }],
      stops: [0],
      disconnectCalls: 1,
    });
    const clipGain = sources[0]?.connectionHistory[0];
    // The source-owned clip gain is gone after finally cleanup; shared output
    // ownership remains with TrackGraph and never reaches the destination.
    expect(clipGain?.disconnectCalls).toBe(1);
    expect(destination.disconnectCalls).toBe(0);
  });

  it('shares one public live preserve derivation with full and selected-track WAV exports', async () => {
    const bytes = canonicalMonoPcm16Wav(48_000);
    const project = await projectWithAudioClip(bytes);
    const clip = enablePreserveWarp(project);
    const [request] = compileAudioWarpRenderRequests(project);
    if (!request) throw new Error('preserve render request required');
    const cache = getAudioClipBufferCache();
    const audioAssetCache = getAudioAssetPlaybackCache();
    cache.clearUnused();
    audioAssetCache.clearUnused();
    DeterministicAudioWarpWorker.instances = [];
    vi.stubGlobal('Worker', DeterministicAudioWarpWorker);
    const resolve = vi.fn(async () => bytes);
    const releaseResolver = setAudioAssetBytesResolver({ resolve });
    const acquireSpy = vi.spyOn(AudioClipBufferCache.prototype, 'acquire');
    const original = useStore.getState();
    useStore.setState({
      project,
      transport: {
        ...original.transport,
        phase: 'starting',
        isPlaying: false,
        playbackRequestId: original.transport.playbackRequestId + 1,
      },
    });
    let liveLease: Awaited<ReturnType<typeof acquireRuntimeProjectAudioBuffers>> | null = null;
    let fullRender: Awaited<ReturnType<typeof renderProjectToWav>> | null = null;
    let selectedRender: Awaited<ReturnType<typeof renderSelectedTrackToWav>> | null = null;

    try {
      liveLease = await acquireRuntimeProjectAudioBuffers(
        project,
        liveAudioContext(48_000),
        () => true,
      );
      installAudioClipOfflineContext();
      fullRender = await renderProjectToWav(project, {
        audioAssetResolver: { resolve },
        audioAssetCache: new AudioAssetPlaybackCache(),
      });
      installAudioClipOfflineContext();
      selectedRender = await renderSelectedTrackToWav(project, clip.trackId, {
        audioAssetResolver: { resolve },
        audioAssetCache: new AudioAssetPlaybackCache(),
      });

      expect(acquireSpy).toHaveBeenCalledTimes(3);
      const cacheKeys = acquireSpy.mock.calls.map(([candidate]) => candidate.cacheKey);
      expect(cacheKeys).toEqual([
        request.cacheKey,
        request.cacheKey,
        request.cacheKey,
      ]);
      const derivedLeases = await Promise.all(
        acquireSpy.mock.results.map(({ value }) => (
          value as Promise<DerivedAudioBufferLease>
        )),
      );
      expect(derivedLeases.map(({ key }) => key)).toEqual(cacheKeys);
      expect(derivedLeases[1]!.pcm).toBe(derivedLeases[0]!.pcm);
      expect(derivedLeases[2]!.pcm).toBe(derivedLeases[0]!.pcm);
      for (const { pcm } of derivedLeases) {
        expect(pcm).toMatchObject({
          sampleRate: request.targetSampleRate,
          frameCount: request.outputFrameCount,
          channelCount: request.channelCount,
        });
        expect(pcm.channels).toHaveLength(request.channelCount);
        expect(pcm.channels.every((channel) => channel.length === request.outputFrameCount))
          .toBe(true);
      }
      const pcmHashes = await Promise.all(
        derivedLeases.map(({ pcm }) => float32ChannelsSha256(pcm.channels)),
      );
      expect(new Set(pcmHashes).size).toBe(1);
      const renderMessages = DeterministicAudioWarpWorker.instances.flatMap(
        ({ messages }) => messages.filter(
          (message) => (message as { type?: string }).type === 'render',
        ),
      );
      expect(DeterministicAudioWarpWorker.instances).toHaveLength(1);
      expect(renderMessages).toHaveLength(1);
      expect(cache.entryCount).toBe(1);

      fullRender.release();
      selectedRender.release();
      expect(cache.entryCount).toBe(1);
      liveLease.release();
      cache.clearUnused();
      audioAssetCache.clearUnused();
      expect(cache.entryCount).toBe(0);
      expect(cache.retainedDerivedBytes).toBe(0);
      expect(getReservedHeavyAudioResourceBytes()).toBe(0);
    } finally {
      fullRender?.release();
      selectedRender?.release();
      liveLease?.release();
      releaseResolver();
      cache.clearUnused();
      audioAssetCache.clearUnused();
      acquireSpy.mockRestore();
      vi.unstubAllGlobals();
      useStore.setState({
        project: original.project,
        transport: original.transport,
      });
    }
  });

  it('uses the Track scalar for a bypassed lane in offline WAV scheduling', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const readProject = await projectWithAudioClip(bytes);
    readProject.tracks[0] = { ...readProject.tracks[0]!, volume: 0.73 };
    readProject.automationLanes = [{
      id: 'wav-volume-automation',
      bypassed: false,
      target: { type: 'track-volume', trackId: 'wav-audio-track' },
      points: [{
        id: 'wav-volume-point',
        beat: 0,
        value: 0.25,
        interpolation: 'hold',
      }],
    }];
    const readContext = installAudioClipOfflineContext();
    const readRender = await renderProjectToWav(readProject, {
      audioAssetResolver: { resolve: async () => bytes },
    });
    const readBytes = new Uint8Array(await readRender.blob.arrayBuffer());
    readRender.release();

    expect(readContext.gains.some((gain) =>
      gain.gain.commands.some((command) =>
        command.kind === 'set' && command.value === 0.25))).toBe(true);
    const readGainCommands = readContext.gains.map((gain) => gain.gain.commands);

    vi.unstubAllGlobals();
    const bypassedProject: Project = {
      ...readProject,
      automationLanes: readProject.automationLanes.map((lane) => ({
        ...lane,
        bypassed: true,
      })),
    };
    const bypassedContext = installAudioClipOfflineContext();
    const bypassedRender = await renderProjectToWav(bypassedProject, {
      audioAssetResolver: { resolve: async () => bytes },
    });
    const bypassedBytes = new Uint8Array(await bypassedRender.blob.arrayBuffer());
    bypassedRender.release();

    expect(bypassedContext.gains.some((gain) =>
      gain.gain.commands.some((command) =>
        command.kind === 'set' && command.value === 0.25))).toBe(false);
    expect(bypassedContext.gains.some((gain) =>
      gain.gain.commands.some((command) =>
        command.kind === 'set' && command.value === 0.73 && command.time === 0))).toBe(true);
    expect(bypassedBytes).toEqual(readBytes);

    for (const automationReadState of [
      { globalEnabled: false, disabledTrackIds: [] },
      { globalEnabled: true, disabledTrackIds: ['wav-audio-track'] },
    ]) {
      vi.unstubAllGlobals();
      const disabledContext = installAudioClipOfflineContext();
      const disabledRender = await renderProjectToWav({
        ...readProject,
        automationReadState,
      }, {
        audioAssetResolver: { resolve: async () => bytes },
      });
      disabledRender.release();
      expect(disabledContext.gains.some((gain) =>
        gain.gain.commands.some((command) =>
          command.kind === 'set' && command.value === 0.25))).toBe(false);
      expect(disabledContext.gains.some((gain) =>
        gain.gain.commands.some((command) =>
          command.kind === 'set' && command.value === 0.73 && command.time === 0))).toBe(true);
    }

    vi.unstubAllGlobals();
    const reenabledContext = installAudioClipOfflineContext();
    const reenabledRender = await renderProjectToWav({
      ...readProject,
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    }, {
      audioAssetResolver: { resolve: async () => bytes },
    });
    reenabledRender.release();
    expect(reenabledContext.gains.map((gain) => gain.gain.commands)).toEqual(readGainCommands);
    expect(readProject.automationLanes[0]?.points).toEqual([{
      id: 'wav-volume-point',
      beat: 0,
      value: 0.25,
      interpolation: 'hold',
    }]);
  });

  it('uses identical variable-tempo automation commands for mix and selected bounce Read states', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const project = await projectWithAudioClip(bytes);
    project.tempoMap = [
      { id: 'tempo-0', beat: 0, bpm: 120 },
      { id: 'tempo-1', beat: 2, bpm: 60 },
    ];
    project.automationLanes = [{
      id: 'wav-variable-tempo-volume',
      bypassed: false,
      target: { type: 'track-volume', trackId: 'wav-audio-track' },
      points: [
        { id: 'point-0', beat: 0, value: 0.25, interpolation: 'hold' },
        { id: 'point-1', beat: 3, value: 0.75, interpolation: 'linear' },
      ],
    }];

    for (const variant of [
      project,
      { ...project, automationReadState: { globalEnabled: false, disabledTrackIds: [] } },
      {
        ...project,
        automationReadState: {
          globalEnabled: true,
          disabledTrackIds: ['wav-audio-track'],
        },
      },
      {
        ...project,
        automationLanes: project.automationLanes.map((lane) => ({
          ...lane,
          bypassed: true,
        })),
      },
    ] satisfies Project[]) {
      vi.unstubAllGlobals();
      const mixContext = installAudioClipOfflineContext();
      const mix = await renderProjectToWav(variant, {
        audioAssetResolver: { resolve: async () => bytes },
      });
      mix.release();
      const mixCommands = mixContext.gains.map((gain) => gain.gain.commands);

      vi.unstubAllGlobals();
      const selectedContext = installAudioClipOfflineContext();
      const selected = await renderSelectedTrackToWav(
        variant,
        'wav-audio-track',
        { audioAssetResolver: { resolve: async () => bytes } },
      );
      selected.release();
      expect(selectedContext.gains.map((gain) => gain.gain.commands)).toEqual(mixCommands);
    }
  });

  it('applies the same effective Master volume curve to mix and selected bounce', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const project = await projectWithAudioClip(bytes);
    project.tracks.push({
      id: 'wav-master',
      name: 'Master',
      type: 'master',
      role: 'general',
      clips: [],
      volume: 0.9,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    });
    project.automationLanes = [{
      id: 'wav-master-volume-lane',
      bypassed: false,
      target: { type: 'track-volume', trackId: 'wav-master' },
      points: [
        { id: 'master-point-0', beat: 0, value: 0.35, interpolation: 'linear' },
        { id: 'master-point-1', beat: 2, value: 0.8, interpolation: 'hold' },
      ],
    }];

    const renderCommands = async (selected: boolean) => {
      const offline = installAudioClipOfflineContext();
      const rendered = selected
        ? await renderSelectedTrackToWav(project, 'wav-audio-track', {
          audioAssetResolver: { resolve: async () => bytes },
        })
        : await renderProjectToWav(project, {
          audioAssetResolver: { resolve: async () => bytes },
        });
      rendered.release();
      return offline.gains[0]?.gain.commands ?? [];
    };

    const mixCommands = await renderCommands(false);
    vi.unstubAllGlobals();
    const selectedCommands = await renderCommands(true);

    expect(selectedCommands).toEqual(mixCommands);
    expect(mixCommands).toContainEqual({ kind: 'set', value: 0.35, time: 0 });
    expect(mixCommands).toContainEqual({ kind: 'linear', value: 0.8, time: 1 });

    vi.unstubAllGlobals();
    const disabledContext = installAudioClipOfflineContext();
    const disabled = await renderProjectToWav({
      ...project,
      automationReadState: {
        globalEnabled: true,
        disabledTrackIds: ['wav-master'],
      },
    }, {
      audioAssetResolver: { resolve: async () => bytes },
    });
    disabled.release();
    const disabledMasterCommands = disabledContext.gains[0]?.gain.commands ?? [];
    expect(disabledMasterCommands).toContainEqual({
      kind: 'set',
      value: 0.9,
      time: 0,
    });
    expect(disabledMasterCommands.some((command) => command.value === 0.35)).toBe(false);
  });

  it('does not schedule automation for a Track outside the selected routing closure', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const project = await projectWithAudioClip(bytes);
    project.tracks.push({
      id: 'unrelated-automated-track',
      name: 'Unrelated automated Track',
      type: 'instrument',
      role: 'general',
      clips: [],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      instrument: { type: 'synth', preset: 'softPad' },
      effects: [],
    });
    project.audioRouting.outputs.push({
      sourceTrackId: 'unrelated-automated-track',
      destination: { type: 'master' },
    });
    project.automationLanes = [{
      id: 'unrelated-volume-lane',
      bypassed: false,
      target: {
        type: 'track-volume',
        trackId: 'unrelated-automated-track',
      },
      points: [{
        id: 'unrelated-volume-point',
        beat: 0,
        value: 1.91,
        interpolation: 'hold',
      }],
    }];
    const context = installAudioClipOfflineContext();

    const rendered = await renderSelectedTrackToWav(
      project,
      'wav-audio-track',
      { audioAssetResolver: { resolve: async () => bytes } },
    );
    rendered.release();

    expect(context.gains.some((gain) =>
      gain.gain.commands.some((command) => command.value === 1.91))).toBe(false);
  });
});

describe('renderProjectToWav graph ownership', () => {
  it('keeps the origin/main full-mix WAV characterization byte-identical', async () => {
    const audioBuffer = {
      numberOfChannels: 2,
      sampleRate: 44_100,
      getChannelData: vi.fn(() => new Float32Array([0])),
    } as unknown as AudioBuffer;
    installOfflineContext(() => Promise.resolve(audioBuffer));

    const rendered = await renderProjectToWav(projectWithMasterOnly());
    const bytes = new Uint8Array(await rendered.blob.arrayBuffer());
    rendered.release();

    expect(bytes.byteLength).toBe(48);
    expect(await sha256Hex(bytes)).toBe(
      'aca24651856ecbfcb63cafa9d1f5f17a410730ae09c64e19ea15aa9f910a2083',
    );
  });

  it('transfers the shared reservation to the encoded Blob lease', async () => {
    let finishRendering!: (buffer: AudioBuffer) => void;
    const rendering = new Promise<AudioBuffer>((resolve) => {
      finishRendering = resolve;
    });
    const { context } = installOfflineContext(() => rendering);
    const pending = renderProjectToWav(projectWithMasterOnly());

    await vi.waitFor(() => expect(context.startRendering).toHaveBeenCalledOnce());
    expect(getReservedHeavyAudioResourceBytes()).toBeGreaterThan(0);
    finishRendering({
      numberOfChannels: 2,
      sampleRate: 44_100,
      getChannelData: vi.fn(() => new Float32Array([0])),
    } as unknown as AudioBuffer);
    const rendered = await pending;
    expect(rendered.blob).toBeInstanceOf(Blob);
    expect(rendered.released).toBe(false);
    expect(getReservedHeavyAudioResourceBytes()).toBeGreaterThan(0);
    rendered.release();
    rendered.release();
    expect(rendered.released).toBe(true);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('omits meters and disconnects the offline master graph after success', async () => {
    const audioBuffer = {
      numberOfChannels: 2,
      sampleRate: 44_100,
      getChannelData: vi.fn(() => new Float32Array([0])),
    } as unknown as AudioBuffer;
    const { context, master, limiter } = installOfflineContext(() =>
      Promise.resolve(audioBuffer),
    );

    const rendered = await renderProjectToWav(projectWithMasterOnly());
    expect(rendered.blob).toBeInstanceOf(Blob);
    rendered.release();

    expect(context.createAnalyser).not.toHaveBeenCalled();
    expect(master.disconnect).toHaveBeenCalledTimes(1);
    expect(limiter.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects the offline master graph when rendering fails', async () => {
    const renderFailure = new Error('offline renderer failed');
    const { context, master, limiter } = installOfflineContext(() =>
      Promise.reject(renderFailure),
    );

    await expect(renderProjectToWav(projectWithMasterOnly())).rejects.toBe(renderFailure);

    expect(context.createAnalyser).not.toHaveBeenCalled();
    expect(master.disconnect).toHaveBeenCalledTimes(1);
    expect(limiter.disconnect).toHaveBeenCalledTimes(1);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });
});
