import { CURRENT_SCHEMA_VERSION } from './factories';
import { migrateProject, ProjectMigrationError } from './migrations';
import type {
  ChordEvent,
  Clip,
  DrumEvent,
  DrumGrooveSettings,
  EffectConfig,
  InstrumentConfig,
  NoteEvent,
  Project,
  Section,
  Track,
} from './types';
import { validateProject } from './validation';

export const DEFAULT_MAX_PROJECT_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_PROJECT_CODEC_ISSUES = 100;
export const MAX_PROJECT_COLLECTION_ITEMS = 100_000;
export const MAX_PROJECT_TOTAL_ITEMS = 200_000;
export const MAX_PROJECT_STRING_LENGTH = 4_096;

export type ProjectCodecIssueCode =
  | 'required'
  | 'invalid-type'
  | 'unknown-key'
  | 'not-finite'
  | 'not-integer'
  | 'out-of-range'
  | 'invalid-timestamp'
  | 'invalid-reference'
  | 'duplicate-id';

export type ProjectCodecIssue = Readonly<{
  path: string;
  code: ProjectCodecIssueCode;
  message: string;
}>;

export type ProjectDecodeErrorCode =
  | 'too-large'
  | 'invalid-json'
  | 'invalid-root'
  | 'invalid-schema-version'
  | 'future-schema-version'
  | 'migration-unavailable'
  | 'migration-failed'
  | 'invalid-project'
  | 'validation-exception';

export type ProjectDecodeResult =
  | Readonly<{
      ok: true;
      project: Project;
      sourceSchemaVersion: number;
      migrated: boolean;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: ProjectDecodeErrorCode;
        issues: readonly ProjectCodecIssue[];
      }>;
    }>;

export type ProjectEncodeResult =
  | Readonly<{ ok: true; json: string; bytes: number }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: 'invalid-project' | 'serialization-failed' | 'too-large';
        issues: readonly ProjectCodecIssue[];
      }>;
    }>;

type UnknownRecord = Record<string, unknown>;

const PROJECT_KEYS = [
  'C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb',
  'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B',
] as const;
const PROJECT_SCALES = [
  'major',
  'naturalMinor',
  'harmonicMinor',
  'melodicMinor',
  'majorPentatonic',
  'minorPentatonic',
  'blues',
] as const;
const TRACK_TYPES = ['instrument', 'drum', 'audio', 'bus', 'master'] as const;
const CLIP_TYPES = ['midi', 'drum', 'audio', 'automation'] as const;
const DRUM_LANES = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'] as const;
const EFFECT_TYPES = ['filter', 'delay', 'reverb', 'compressor', 'eq'] as const;
const SECTION_TYPES = ['intro', 'verse', 'preChorus', 'chorus', 'bridge', 'outro'] as const;
const CHORD_FUNCTIONS = ['T', 'SD', 'D', 'Other'] as const;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class StructureDecoder {
  readonly issues: ProjectCodecIssue[] = [];
  private decodedItems = 0;

  issue(path: string, code: ProjectCodecIssueCode, message: string): void {
    if (this.issues.length < MAX_PROJECT_CODEC_ISSUES) {
      this.issues.push({ path, code, message });
    }
  }

  record(value: unknown, path: string, allowedKeys: readonly string[]): UnknownRecord | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.issue(path, 'invalid-type', 'expected an object');
      return null;
    }
    const record = value as UnknownRecord;
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        this.issue(path ? `${path}.${key}` : key, 'unknown-key', 'unknown property');
      }
    }
    return record;
  }

  required(record: UnknownRecord, key: string, path: string): unknown {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      this.issue(path, 'required', 'required property is missing');
      return undefined;
    }
    return record[key];
  }

  string(value: unknown, path: string): string {
    if (typeof value !== 'string') {
      this.issue(path, 'invalid-type', 'expected a string');
      return '';
    }
    if (value.length > MAX_PROJECT_STRING_LENGTH) {
      this.issue(path, 'out-of-range', `string exceeds ${MAX_PROJECT_STRING_LENGTH} characters`);
    }
    return value;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') {
      this.issue(path, 'invalid-type', 'expected a boolean');
      return false;
    }
    return value;
  }

  number(value: unknown, path: string): number {
    if (typeof value !== 'number') {
      this.issue(path, 'invalid-type', 'expected a number');
      return 0;
    }
    if (!Number.isFinite(value)) {
      this.issue(path, 'not-finite', 'number must be finite');
      return 0;
    }
    return value;
  }

  positiveSafeInteger(value: unknown, path: string): number {
    const decoded = this.number(value, path);
    if (!Number.isSafeInteger(decoded)) {
      this.issue(path, 'not-integer', 'expected a safe integer');
    } else if (decoded <= 0) {
      this.issue(path, 'out-of-range', 'expected a positive integer');
    }
    return decoded;
  }

  member<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
    const decoded = this.string(value, path);
    if (!(values as readonly string[]).includes(decoded)) {
      this.issue(path, 'out-of-range', `unsupported value "${decoded}"`);
    }
    return decoded as T[number];
  }

  timestamp(value: unknown, path: string): string {
    const decoded = this.string(value, path);
    let normalized = '';
    try {
      normalized = new Date(decoded).toISOString();
    } catch {
      // Report through the common branch below.
    }
    if (!ISO_UTC_TIMESTAMP.test(decoded) || normalized !== decoded) {
      this.issue(path, 'invalid-timestamp', 'expected a canonical UTC ISO timestamp');
    }
    return decoded;
  }

  array<T>(
    value: unknown,
    path: string,
    decodeItem: (item: unknown, itemPath: string) => T,
  ): T[] {
    if (!Array.isArray(value)) {
      this.issue(path, 'invalid-type', 'expected an array');
      return [];
    }
    if (value.length > MAX_PROJECT_COLLECTION_ITEMS) {
      this.issue(path, 'out-of-range', `array exceeds ${MAX_PROJECT_COLLECTION_ITEMS} items`);
    }
    const remaining = Math.max(0, MAX_PROJECT_TOTAL_ITEMS - this.decodedItems);
    const count = Math.min(value.length, MAX_PROJECT_COLLECTION_ITEMS, remaining);
    if (count < value.length && remaining < value.length) {
      this.issue(path, 'out-of-range', `project exceeds ${MAX_PROJECT_TOTAL_ITEMS} nested items`);
    }
    this.decodedItems += count;
    const decoded: T[] = [];
    for (let index = 0; index < count; index += 1) {
      decoded.push(decodeItem(value[index], `${path}[${index}]`));
    }
    return decoded;
  }

  optionalString(record: UnknownRecord, key: string, path: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(record, key)
      ? this.string(record[key], path)
      : undefined;
  }
}

function decodeNumberRecord(decoder: StructureDecoder, value: unknown, path: string): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    decoder.issue(path, 'invalid-type', 'expected an object of numeric parameters');
    return {};
  }
  const result: Record<string, number> = {};
  const entries = Object.entries(value);
  if (entries.length > 2_048) {
    decoder.issue(path, 'out-of-range', 'parameter map exceeds 2048 entries');
  }
  for (const [key, item] of entries.slice(0, 2_048)) {
    if (key.length > MAX_PROJECT_STRING_LENGTH) {
      decoder.issue(`${path}.${key.slice(0, 32)}`, 'out-of-range', 'parameter name is too long');
      continue;
    }
    Object.defineProperty(result, key, {
      value: decoder.number(item, `${path}.${key}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function decodeInstrument(decoder: StructureDecoder, value: unknown, path: string): InstrumentConfig {
  const record = decoder.record(value, path, ['type', 'preset', 'params']) ?? {};
  const params = Object.prototype.hasOwnProperty.call(record, 'params')
    ? decodeNumberRecord(decoder, record.params, `${path}.params`)
    : undefined;
  return {
    type: decoder.member(decoder.required(record, 'type', `${path}.type`), ['synth', 'drumkit'], `${path}.type`),
    preset: decoder.string(decoder.required(record, 'preset', `${path}.preset`), `${path}.preset`),
    ...(params !== undefined ? { params } : {}),
  };
}

function decodeEffect(decoder: StructureDecoder, value: unknown, path: string): EffectConfig {
  const record = decoder.record(value, path, ['id', 'type', 'enabled', 'params']) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    type: decoder.member(decoder.required(record, 'type', `${path}.type`), EFFECT_TYPES, `${path}.type`),
    enabled: decoder.boolean(decoder.required(record, 'enabled', `${path}.enabled`), `${path}.enabled`),
    params: decodeNumberRecord(
      decoder,
      decoder.required(record, 'params', `${path}.params`),
      `${path}.params`,
    ),
  };
}

function decodeNote(decoder: StructureDecoder, value: unknown, path: string): NoteEvent {
  const record = decoder.record(value, path, ['id', 'pitch', 'startBeat', 'durationBeats', 'velocity']) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    pitch: decoder.number(decoder.required(record, 'pitch', `${path}.pitch`), `${path}.pitch`),
    startBeat: decoder.number(decoder.required(record, 'startBeat', `${path}.startBeat`), `${path}.startBeat`),
    durationBeats: decoder.number(
      decoder.required(record, 'durationBeats', `${path}.durationBeats`),
      `${path}.durationBeats`,
    ),
    velocity: decoder.number(decoder.required(record, 'velocity', `${path}.velocity`), `${path}.velocity`),
  };
}

function decodeDrum(decoder: StructureDecoder, value: unknown, path: string): DrumEvent {
  const record = decoder.record(value, path, ['id', 'lane', 'stepIndex', 'velocity', 'probability']) ?? {};
  const probability = Object.prototype.hasOwnProperty.call(record, 'probability')
    ? decoder.number(record.probability, `${path}.probability`)
    : undefined;
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    lane: decoder.member(decoder.required(record, 'lane', `${path}.lane`), DRUM_LANES, `${path}.lane`),
    stepIndex: decoder.number(
      decoder.required(record, 'stepIndex', `${path}.stepIndex`),
      `${path}.stepIndex`,
    ),
    velocity: decoder.number(decoder.required(record, 'velocity', `${path}.velocity`), `${path}.velocity`),
    ...(probability !== undefined ? { probability } : {}),
  };
}

function decodeDrumGroove(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): DrumGrooveSettings {
  const record =
    decoder.record(value, path, ['swing', 'probability', 'humanizeVelocity', 'seed']) ?? {};
  return {
    swing: decoder.number(decoder.required(record, 'swing', `${path}.swing`), `${path}.swing`),
    probability: decoder.number(
      decoder.required(record, 'probability', `${path}.probability`),
      `${path}.probability`,
    ),
    humanizeVelocity: decoder.number(
      decoder.required(record, 'humanizeVelocity', `${path}.humanizeVelocity`),
      `${path}.humanizeVelocity`,
    ),
    seed: decoder.positiveSafeInteger(
      decoder.required(record, 'seed', `${path}.seed`),
      `${path}.seed`,
    ),
  };
}

function decodeClip(decoder: StructureDecoder, value: unknown, path: string): Clip {
  const record = decoder.record(value, path, [
    'id',
    'trackId',
    'type',
    'startBeat',
    'lengthBeats',
    'loop',
    'aliasOf',
    'notes',
    'drumEvents',
    'stepsPerBar',
    'drumGroove',
    'audioAssetId',
  ]) ?? {};
  const notes = Object.prototype.hasOwnProperty.call(record, 'notes')
    ? decoder.array(record.notes, `${path}.notes`, (item, itemPath) => decodeNote(decoder, item, itemPath))
    : undefined;
  const drumEvents = Object.prototype.hasOwnProperty.call(record, 'drumEvents')
    ? decoder.array(record.drumEvents, `${path}.drumEvents`, (item, itemPath) =>
        decodeDrum(decoder, item, itemPath),
      )
    : undefined;
  const stepsPerBar = Object.prototype.hasOwnProperty.call(record, 'stepsPerBar')
    ? decoder.positiveSafeInteger(record.stepsPerBar, `${path}.stepsPerBar`)
    : undefined;
  const drumGroove = Object.prototype.hasOwnProperty.call(record, 'drumGroove')
    ? decodeDrumGroove(decoder, record.drumGroove, `${path}.drumGroove`)
    : undefined;
  const aliasOf = decoder.optionalString(record, 'aliasOf', `${path}.aliasOf`);
  const audioAssetId = decoder.optionalString(record, 'audioAssetId', `${path}.audioAssetId`);
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    trackId: decoder.string(decoder.required(record, 'trackId', `${path}.trackId`), `${path}.trackId`),
    type: decoder.member(decoder.required(record, 'type', `${path}.type`), CLIP_TYPES, `${path}.type`),
    startBeat: decoder.number(decoder.required(record, 'startBeat', `${path}.startBeat`), `${path}.startBeat`),
    lengthBeats: decoder.number(
      decoder.required(record, 'lengthBeats', `${path}.lengthBeats`),
      `${path}.lengthBeats`,
    ),
    loop: decoder.boolean(decoder.required(record, 'loop', `${path}.loop`), `${path}.loop`),
    ...(aliasOf !== undefined ? { aliasOf } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(drumEvents !== undefined ? { drumEvents } : {}),
    ...(stepsPerBar !== undefined ? { stepsPerBar } : {}),
    ...(drumGroove !== undefined ? { drumGroove } : {}),
    ...(audioAssetId !== undefined ? { audioAssetId } : {}),
  };
}

function decodeTrack(decoder: StructureDecoder, value: unknown, path: string): Track {
  const record = decoder.record(value, path, [
    'id',
    'name',
    'type',
    'color',
    'clips',
    'volume',
    'pan',
    'mute',
    'solo',
    'instrument',
    'effects',
  ]) ?? {};
  const color = decoder.optionalString(record, 'color', `${path}.color`);
  const instrument = Object.prototype.hasOwnProperty.call(record, 'instrument')
    ? decodeInstrument(decoder, record.instrument, `${path}.instrument`)
    : undefined;
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    name: decoder.string(decoder.required(record, 'name', `${path}.name`), `${path}.name`),
    type: decoder.member(decoder.required(record, 'type', `${path}.type`), TRACK_TYPES, `${path}.type`),
    ...(color !== undefined ? { color } : {}),
    clips: decoder.array(
      decoder.required(record, 'clips', `${path}.clips`),
      `${path}.clips`,
      (item, itemPath) => decodeClip(decoder, item, itemPath),
    ),
    volume: decoder.number(decoder.required(record, 'volume', `${path}.volume`), `${path}.volume`),
    pan: decoder.number(decoder.required(record, 'pan', `${path}.pan`), `${path}.pan`),
    mute: decoder.boolean(decoder.required(record, 'mute', `${path}.mute`), `${path}.mute`),
    solo: decoder.boolean(decoder.required(record, 'solo', `${path}.solo`), `${path}.solo`),
    ...(instrument !== undefined ? { instrument } : {}),
    effects: decoder.array(
      decoder.required(record, 'effects', `${path}.effects`),
      `${path}.effects`,
      (item, itemPath) => decodeEffect(decoder, item, itemPath),
    ),
  };
}

function decodeChord(decoder: StructureDecoder, value: unknown, path: string): ChordEvent {
  const record = decoder.record(value, path, [
    'id',
    'startBeat',
    'durationBeats',
    'symbol',
    'root',
    'quality',
    'notes',
    'degree',
    'function',
    'tags',
  ]) ?? {};
  const degree = decoder.optionalString(record, 'degree', `${path}.degree`);
  const chordFunction = Object.prototype.hasOwnProperty.call(record, 'function')
    ? decoder.member(record.function, CHORD_FUNCTIONS, `${path}.function`)
    : undefined;
  const tags = Object.prototype.hasOwnProperty.call(record, 'tags')
    ? decoder.array(record.tags, `${path}.tags`, (item, itemPath) => decoder.string(item, itemPath))
    : undefined;
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    startBeat: decoder.number(decoder.required(record, 'startBeat', `${path}.startBeat`), `${path}.startBeat`),
    durationBeats: decoder.number(
      decoder.required(record, 'durationBeats', `${path}.durationBeats`),
      `${path}.durationBeats`,
    ),
    symbol: decoder.string(decoder.required(record, 'symbol', `${path}.symbol`), `${path}.symbol`),
    root: decoder.string(decoder.required(record, 'root', `${path}.root`), `${path}.root`),
    quality: decoder.string(decoder.required(record, 'quality', `${path}.quality`), `${path}.quality`),
    notes: decoder.array(
      decoder.required(record, 'notes', `${path}.notes`),
      `${path}.notes`,
      (item, itemPath) => decoder.number(item, itemPath),
    ),
    ...(degree !== undefined ? { degree } : {}),
    ...(chordFunction !== undefined ? { function: chordFunction } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
}

function decodeSection(decoder: StructureDecoder, value: unknown, path: string): Section {
  const record = decoder.record(value, path, ['id', 'name', 'type', 'startBar', 'lengthBars']) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    name: decoder.string(decoder.required(record, 'name', `${path}.name`), `${path}.name`),
    type: decoder.member(decoder.required(record, 'type', `${path}.type`), SECTION_TYPES, `${path}.type`),
    startBar: decoder.number(decoder.required(record, 'startBar', `${path}.startBar`), `${path}.startBar`),
    lengthBars: decoder.number(
      decoder.required(record, 'lengthBars', `${path}.lengthBars`),
      `${path}.lengthBars`,
    ),
  };
}

function decodeCurrentProject(input: unknown): ProjectDecodeResult {
  const decoder = new StructureDecoder();
  try {
    const record = decoder.record(input, '', [
      'id',
      'schemaVersion',
      'title',
      'bpm',
      'timeSignature',
      'key',
      'scale',
      'lengthBars',
      'tracks',
      'chordTrack',
      'sections',
      'createdAt',
      'updatedAt',
    ]);
    if (!record) {
      return { ok: false, error: { code: 'invalid-root', issues: decoder.issues } };
    }

    const timeSignatureRaw = decoder.required(record, 'timeSignature', 'timeSignature');
    let timeSignature: [number, number] = [0, 0];
    if (!Array.isArray(timeSignatureRaw)) {
      decoder.issue('timeSignature', 'invalid-type', 'expected a two-item array');
    } else {
      if (timeSignatureRaw.length !== 2) {
        decoder.issue('timeSignature', 'out-of-range', 'expected exactly two items');
      }
      timeSignature = [
        decoder.number(timeSignatureRaw[0], 'timeSignature[0]'),
        decoder.number(timeSignatureRaw[1], 'timeSignature[1]'),
      ];
    }

    const project: Project = {
      id: decoder.string(decoder.required(record, 'id', 'id'), 'id'),
      schemaVersion: decoder.positiveSafeInteger(
        decoder.required(record, 'schemaVersion', 'schemaVersion'),
        'schemaVersion',
      ),
      title: decoder.string(decoder.required(record, 'title', 'title'), 'title'),
      bpm: decoder.number(decoder.required(record, 'bpm', 'bpm'), 'bpm'),
      timeSignature,
      key: decoder.member(decoder.required(record, 'key', 'key'), PROJECT_KEYS, 'key'),
      scale: decoder.member(decoder.required(record, 'scale', 'scale'), PROJECT_SCALES, 'scale'),
      lengthBars: decoder.number(
        decoder.required(record, 'lengthBars', 'lengthBars'),
        'lengthBars',
      ),
      tracks: decoder.array(
        decoder.required(record, 'tracks', 'tracks'),
        'tracks',
        (item, itemPath) => decodeTrack(decoder, item, itemPath),
      ),
      chordTrack: decoder.array(
        decoder.required(record, 'chordTrack', 'chordTrack'),
        'chordTrack',
        (item, itemPath) => decodeChord(decoder, item, itemPath),
      ),
      sections: decoder.array(
        decoder.required(record, 'sections', 'sections'),
        'sections',
        (item, itemPath) => decodeSection(decoder, item, itemPath),
      ),
      createdAt: decoder.timestamp(decoder.required(record, 'createdAt', 'createdAt'), 'createdAt'),
      updatedAt: decoder.timestamp(decoder.required(record, 'updatedAt', 'updatedAt'), 'updatedAt'),
    };

    if (decoder.issues.length > 0) {
      return { ok: false, error: { code: 'invalid-project', issues: decoder.issues } };
    }

    let validation;
    try {
      validation = validateProject(project);
    } catch {
      return { ok: false, error: { code: 'validation-exception', issues: [] } };
    }
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: 'invalid-project',
          issues: validation.errors.slice(0, MAX_PROJECT_CODEC_ISSUES).map((error) => ({
            path: error.path,
            code:
              error.message.includes('duplicate id')
                ? 'duplicate-id'
                : error.message.includes('references') || error.message.includes('does not match')
                  ? 'invalid-reference'
                  : error.message.includes('integer')
                    ? 'not-integer'
                    : 'out-of-range',
            message: error.message,
          })),
        },
      };
    }
    return { ok: true, project, sourceSchemaVersion: CURRENT_SCHEMA_VERSION, migrated: false };
  } catch {
    return { ok: false, error: { code: 'validation-exception', issues: decoder.issues } };
  }
}

function schemaVersionOf(input: unknown):
  | { ok: true; version: number }
  | { ok: false; result: ProjectDecodeResult } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: {
          code: 'invalid-root',
          issues: [{ path: '', code: 'invalid-type', message: 'expected an object' }],
        },
      },
    };
  }
  let version: unknown;
  try {
    version = (input as UnknownRecord).schemaVersion;
  } catch {
    version = undefined;
  }
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    return {
      ok: false,
      result: {
        ok: false,
        error: {
          code: 'invalid-schema-version',
          issues: [
            {
              path: 'schemaVersion',
              code: version === undefined ? 'required' : 'not-integer',
              message: 'schemaVersion must be a positive safe integer',
            },
          ],
        },
      },
    };
  }
  if ((version as number) > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      result: {
        ok: false,
        error: {
          code: 'future-schema-version',
          issues: [
            {
              path: 'schemaVersion',
              code: 'out-of-range',
              message: `schemaVersion ${String(version)} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
            },
          ],
        },
      },
    };
  }
  return { ok: true, version: version as number };
}

/** Decode an untrusted project value into a detached, validated Project. */
export function decodeProject(input: unknown): ProjectDecodeResult {
  const version = schemaVersionOf(input);
  if (!version.ok) return version.result;

  let current: unknown = input;
  if (version.version < CURRENT_SCHEMA_VERSION) {
    try {
      current = migrateProject(input as Readonly<Record<string, unknown>>);
    } catch (error) {
      const code =
        error instanceof ProjectMigrationError
          ? error.code
          : 'migration-failed';
      return { ok: false, error: { code, issues: [] } };
    }
  }

  const decoded = decodeCurrentProject(current);
  if (!decoded.ok) return decoded;
  return {
    ...decoded,
    sourceSchemaVersion: version.version,
    migrated: version.version !== CURRENT_SCHEMA_VERSION,
  };
}

/** Parse and decode untrusted project JSON with a bounded input size. */
export function decodeProjectJson(
  json: string,
  options: Readonly<{ maxBytes?: number }> = {},
): ProjectDecodeResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PROJECT_JSON_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return {
      ok: false,
      error: {
        code: 'too-large',
        issues: [{ path: '', code: 'out-of-range', message: 'maxBytes must be positive' }],
      },
    };
  }
  const normalized = json.startsWith('\uFEFF') ? json.slice(1) : json;
  if (normalized.length > maxBytes || new TextEncoder().encode(normalized).byteLength > maxBytes) {
    return {
      ok: false,
      error: {
        code: 'too-large',
        issues: [{ path: '', code: 'out-of-range', message: `project JSON exceeds ${maxBytes} bytes` }],
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    return { ok: false, error: { code: 'invalid-json', issues: [] } };
  }
  return decodeProject(parsed);
}

/** Validate, detach, and serialize a project without invoking caller toJSON hooks. */
export function encodeProjectJson(
  input: unknown,
  options: Readonly<{ pretty?: boolean; maxBytes?: number }> = {},
): ProjectEncodeResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PROJECT_JSON_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return {
      ok: false,
      error: {
        code: 'too-large',
        issues: [{ path: '', code: 'out-of-range', message: 'maxBytes must be positive' }],
      },
    };
  }
  const decoded = decodeProject(input);
  if (!decoded.ok) {
    return {
      ok: false,
      error: { code: 'invalid-project', issues: decoded.error.issues },
    };
  }
  try {
    const json = JSON.stringify(decoded.project, null, options.pretty ? 2 : undefined);
    if (typeof json !== 'string') {
      return { ok: false, error: { code: 'serialization-failed', issues: [] } };
    }
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > maxBytes) {
      return {
        ok: false,
        error: {
          code: 'too-large',
          issues: [{ path: '', code: 'out-of-range', message: `project JSON exceeds ${maxBytes} bytes` }],
        },
      };
    }
    return { ok: true, json, bytes };
  } catch {
    return { ok: false, error: { code: 'serialization-failed', issues: [] } };
  }
}

export class ProjectCodecError extends Error {
  readonly code: ProjectDecodeErrorCode | 'serialization-failed';
  readonly issues: readonly ProjectCodecIssue[];

  constructor(
    code: ProjectDecodeErrorCode | 'serialization-failed',
    issues: readonly ProjectCodecIssue[],
  ) {
    const detail = issues[0] ? ` (${issues[0].path}: ${issues[0].message})` : '';
    super(`Project codec failed: ${code}${detail}`);
    this.name = 'ProjectCodecError';
    this.code = code;
    this.issues = issues;
  }
}
