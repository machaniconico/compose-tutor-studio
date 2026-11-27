// P23 acceptance helpers (shared by the v12-*.test.ts files). Implementers must not edit.
//
// There is no real OfflineAudioContext under vitest, so `installRecordingOfflineContext()` stubs one:
// - Every `create*()` returns a node whose AudioParams are automation-timeline recorders
//   (set / linear / exponential ramps, cancel). Any property that is not a known plain property is
//   treated as an AudioParam; plain properties (type, buffer, loop, ...) are stored and logged.
// - `startRendering()` returns a stereo buffer whose samples are a pure function of the NORMALIZED
//   command log, so two renders are byte-identical (through the real `encodeWav`) exactly when they
//   issued the same graph commands. Normalization drops every command on a BiquadFilterNode's
//   `detune` whose value is 0, because a detune of 0 is the AudioParam default and sounds identical
//   to never scheduling it. Nothing else is normalized away.
// - `filters()` exposes the BiquadFilterNodes so a test can read `detune.valueAt(time)`.
//
// Contract the implementation must satisfy for the cutoff lane: the offset is applied by scheduling
// `value * 1200` (cents) on the `detune` AudioParam of the track's synth-voice BiquadFilterNode
// (the lowpass the synth creates per voice) directly, not through a helper node.
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import {
  createEmptyProject,
  type AutomationLane,
  type AutomationPoint,
  type AutomationTarget,
  type Project,
  type Track,
} from '@cts/project-model';

export const clock = () => new Date('2026-01-01T00:00:00.000Z');
export const CUTOFF_TYPE = 'track-filter-cutoff' as AutomationTarget['type'];

type Cmd = { kind: string; value?: number; time: number };

export class RecordingParam {
  private current = 0;
  readonly cmds: Cmd[] = [];
  private events: Array<{ kind: 'set' | 'linear' | 'exponential'; time: number; value: number }> = [];

  constructor(readonly owner: string, readonly name: string) {}

  get value(): number {
    return this.current;
  }

  set value(value: number) {
    this.current = value;
    this.cmds.push({ kind: 'value', value, time: -1 });
  }

  private insert(kind: 'set' | 'linear' | 'exponential', value: number, time: number): void {
    this.cmds.push({ kind, value, time });
    const at = this.events.findIndex((event) => event.time > time);
    const event = { kind, time, value };
    if (at < 0) this.events.push(event);
    else this.events.splice(at, 0, event);
  }

  setValueAtTime(value: number, time: number): this {
    this.insert('set', value, time);
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.insert('linear', value, time);
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.insert('exponential', value, time);
    return this;
  }

  setTargetAtTime(value: number, time: number): this {
    this.cmds.push({ kind: 'target', value, time });
    return this;
  }

  setValueCurveAtTime(_values: unknown, time: number): this {
    this.cmds.push({ kind: 'curve', time });
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.cmds.push({ kind: 'cancel', time });
    this.events = this.events.filter((event) => event.time < time);
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    this.cmds.push({ kind: 'hold', time });
    return this;
  }

  /** Web Audio automation-timeline evaluation (set / linear / exponential). */
  valueAt(time: number): number {
    let previous: { kind: string; time: number; value: number } | undefined;
    for (const event of this.events) {
      if (event.time <= time) {
        previous = event;
        continue;
      }
      if (event.kind === 'set' || previous === undefined) break;
      const progress = (time - previous.time) / (event.time - previous.time);
      return event.kind === 'linear'
        ? previous.value + (event.value - previous.value) * progress
        : previous.value * (event.value / previous.value) ** progress;
    }
    return previous?.value ?? this.current;
  }
}

const METHODS = new Set(['connect', 'disconnect', 'start', 'stop', 'setPeriodicWave', 'getFloatFrequencyData']);
const PLAIN = new Set([
  'type', 'buffer', 'loop', 'loopStart', 'loopEnd', 'onended', 'curve', 'oversample', 'fftSize',
  'minDecibels', 'maxDecibels', 'smoothingTimeConstant', 'channelCount', 'channelCountMode',
  'channelInterpretation', 'normalize', 'reduction', 'playbackRate',
]);

export class RecordingNode {
  readonly params = new Map<string, RecordingParam>();
  readonly plain = new Map<string, unknown>();
  constructor(readonly id: number, readonly kind: string, private readonly log: string[]) {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
        if (METHODS.has(prop)) {
          return (...args: unknown[]) => {
            const arg = args[0];
            const label = arg instanceof RecordingNode
              ? `n${arg.id}`
              : typeof arg === 'number' ? arg.toFixed(9) : '';
            target.log.push(`n${target.id}.${prop}(${label})`);
            return arg instanceof RecordingNode ? arg : undefined;
          };
        }
        if (PLAIN.has(prop)) return target.plain.get(prop) ?? (prop === 'buffer' || prop === 'onended' ? null : undefined);
        let param = target.params.get(prop);
        if (!param) {
          param = new RecordingParam(`n${target.id}`, prop);
          target.params.set(prop, param);
        }
        return param;
      },
      set: (target, prop, value) => {
        if (typeof prop === 'symbol') return Reflect.set(target, prop, value);
        target.plain.set(prop, value);
        const shown = typeof value === 'function' || value === null || value === undefined
          ? String(value === null || value === undefined ? value : 'fn')
          : typeof value === 'object'
            ? `len${(value as { length?: number }).length ?? '?'}`
            : String(value);
        target.log.push(`n${target.id}.${prop}=${shown}`);
        return true;
      },
    });
  }
}

export type RecordingContext = {
  context: Record<string, unknown>;
  nodes: RecordingNode[];
  log: string[];
  filters(): Array<RecordingNode & { detune: RecordingParam; type: string }>;
  normalizedLog(): string[];
};

function hashLog(lines: readonly string[]): number {
  let hash = 0x811c9dc5;
  for (const line of lines) {
    for (let index = 0; index < line.length; index += 1) {
      hash ^= line.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 10;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function installRecordingOfflineContext(): RecordingContext {
  const nodes: RecordingNode[] = [];
  const log: string[] = [];
  const sampleRate = 44_100;
  const record: RecordingContext = {
    context: {},
    nodes,
    log,
    filters: () => nodes.filter((node) => node.kind === 'BiquadFilter') as never,
    normalizedLog: () => {
      const out: string[] = [];
      for (const node of nodes) {
        for (const [name, param] of node.params) {
          for (const cmd of param.cmds) {
            // A detune of 0 on a filter equals the AudioParam default: not a sound difference.
            if (node.kind === 'BiquadFilter' && name === 'detune' && (cmd.value ?? NaN) === 0) continue;
            out.push(`n${node.id}.${name}.${cmd.kind}(${cmd.value ?? ''},${cmd.time.toFixed(9)})`);
          }
        }
      }
      return [...log, ...out];
    },
  };
  let nextId = 0;
  const makeNode = (kind: string) => {
    const node = new RecordingNode(nextId, kind, log);
    nextId += 1;
    nodes.push(node);
    log.push(`create:${kind}#${nextId - 1}`);
    return node;
  };
  const destination = makeNode('Destination');
  const length = { frames: 0 };
  const context = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'destination') return destination;
      if (prop === 'sampleRate') return sampleRate;
      if (prop === 'currentTime') return 0;
      if (prop === 'state') return 'suspended';
      if (prop === 'length') return length.frames;
      if (prop === 'createBuffer') {
        return (channels: number, frames: number, rate: number) => {
          const data = Array.from({ length: channels }, () => new Float32Array(frames));
          return {
            numberOfChannels: channels,
            length: frames,
            sampleRate: rate,
            duration: frames / rate,
            getChannelData: (channel: number) => data[channel]!,
            copyToChannel: (source: Float32Array, channel: number) => data[channel]!.set(source),
          };
        };
      }
      if (prop === 'startRendering') {
        return async () => {
          const seed = hashLog(record.normalizedLog());
          const frames = length.frames;
          const channels = [new Float32Array(frames), new Float32Array(frames)];
          let state = seed || 1;
          for (const channel of channels) {
            for (let index = 0; index < frames; index += 1) {
              state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
              channel[index] = (state / 0xffffffff - 0.5) * 0.5;
            }
          }
          return {
            numberOfChannels: 2,
            length: frames,
            sampleRate,
            duration: frames / sampleRate,
            getChannelData: (channel: number) => channels[channel]!,
          };
        };
      }
      if (typeof prop === 'string' && prop.startsWith('create')) {
        return () => makeNode(prop.slice('create'.length).replace(/Node$/, ''));
      }
      return undefined;
    },
  });
  record.context = context;
  vi.stubGlobal(
    'OfflineAudioContext',
    vi.fn(function OfflineAudioContext(_channels: number, frames: number) {
      length.frames = frames;
      return context;
    }),
  );
  return record;
}

export function trackNamed(project: Project, name: string): Track {
  const track = project.tracks.find((candidate) => candidate.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track;
}

export function cutoffLane(
  trackId: string,
  points: ReadonlyArray<Pick<AutomationPoint, 'beat' | 'value' | 'interpolation'>>,
  overrides: Partial<Pick<AutomationLane, 'bypassed' | 'id'>> = {},
): AutomationLane {
  const id = overrides.id ?? 'lane-cutoff';
  return {
    id,
    bypassed: overrides.bypassed ?? false,
    target: { type: CUTOFF_TYPE, trackId },
    points: points.map((point, index) => ({ id: `${id}-p${index}`, ...point })),
  };
}

export type NoteSpec = { pitch: number; startBeat: number; durationBeats: number };

/**
 * A 4-beat (120 bpm, 2 s) v12 project where only the Melody (instrument) track sounds `notes`.
 * Chords / Bass / Drums clips are emptied so every BiquadFilter in the render is a Melody voice filter.
 */
export function melodyOnlyProject(notes: NoteSpec[], lanes: AutomationLane[] = []): Project {
  const project = createEmptyProject({ clock, lengthBars: 1 });
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.type === 'midi') clip.notes = [];
      if (clip.type === 'drum') clip.drumEvents = [];
    }
  }
  const melody = trackNamed(project, 'Melody');
  const clip = melody.clips[0]!;
  clip.startBeat = 0;
  clip.lengthBeats = 4;
  if (clip.type !== 'midi') throw new Error('Melody clip must be midi');
  clip.notes = notes.map((note, index) => ({ id: `n${index}`, velocity: 100, ...note }));
  project.automationLanes = lanes;
  return project;
}

/** sha256 of the WAV bytes (compared as strings so a mismatch does not print a huge byte diff). */
export async function blobSha256(blob: Blob): Promise<string> {
  return createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
}
