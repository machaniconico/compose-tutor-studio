import { detectProjectFormat } from '../project-format';
import type { ChordEvent, Clip, EffectConfig, InstrumentConfig, Project, Section, Track } from '../types';

export type LegacyClip = Omit<Clip, 'audioWarp' | 'drumGroove'> & {
  contentLengthBeats?: number;
  legacyClipSettings?: unknown;
};

export type LegacyEffect = Omit<EffectConfig, 'type'> & { type: string };

export type LegacyTrack = Omit<Track, 'clips' | 'role' | 'instrument' | 'effects'> & {
  clips: LegacyClip[];
  role?: string;
  effects: LegacyEffect[];
  instrument?: InstrumentConfig & { macros?: Record<string, number> };
  sends?: Record<string, number>;
  automation?: Record<string, { points: { beat: number; value: number }[] }>;
};

export type LegacyProject = Pick<Project,
  'id' | 'title' | 'bpm' | 'timeSignature' | 'key' | 'scale' | 'lengthBars' | 'createdAt' | 'updatedAt'
> & {
  tracks: LegacyTrack[];
  chordTrack: ChordEvent[];
  sections: Section[];
  swing?: number;
  legacyBarLimit?: number;
  loopRange?: unknown;
};

export class OverLimit extends Error {}

function ownData(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) throw new TypeError('Missing own property');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected a data property');
  return descriptor.value;
}

/** Reuse the main discriminator with the file's own keys, without reading accessors. */
export function detectOwnProjectFormat(value: object): ReturnType<typeof detectProjectFormat> {
  if (!Object.hasOwn(value, 'schemaVersion')) return 'main';
  const schemaVersion = ownData(value, 'schemaVersion');
  if (schemaVersion !== 3) return 'main';
  const header = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) header[key] = undefined;
  header.schemaVersion = schemaVersion;
  return detectProjectFormat(header);
}

/** Copy JSON data without invoking getters, following prototypes, or using toJSON. */
export function copyOwnJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    typeof value === 'number' || value === undefined) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Expected JSON data');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = ownData(value, 'length') as number;
      const items: unknown[] = [];
      for (let index = 0; index < length; index++) {
        items.push(copyOwnJson(ownData(value, String(index)), ancestors));
      }
      return items;
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) record[key] = copyOwnJson(ownData(value, key), ancestors);
    return record;
  } finally {
    ancestors.delete(value);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
