import { CURRENT_SCHEMA_VERSION } from './factories';
import { migrateProject, ProjectMigrationError } from './migrations';
import type {
  AudioAsset,
  AudioCompSegment,
  AudioRouteDestination,
  AudioRouting,
  AudioSend,
  AudioTake,
  AudioTakeFolder,
  AutomationLane,
  AutomationPoint,
  AutomationReadState,
  AutomationTarget,
  ChordEvent,
  Clip,
  DrumEvent,
  DrumGrooveSettings,
  EffectConfig,
  InstrumentConfig,
  NoteEvent,
  Project,
  Section,
  TempoMapEvent,
  TimeSignatureMapEvent,
  Track,
  TrackOutputRoute,
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
const TRACK_ROLES = [
  'general',
  'learning.chords',
  'learning.bass',
  'learning.melody',
] as const;
const CLIP_TYPES = ['midi', 'drum', 'audio', 'automation'] as const;
const DRUM_LANES = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'] as const;
const EFFECT_TYPES = ['filter', 'delay', 'reverb', 'compressor', 'eq'] as const;
const SECTION_TYPES = ['intro', 'verse', 'preChorus', 'chorus', 'bridge', 'outro'] as const;
const CHORD_FUNCTIONS = ['T', 'SD', 'D', 'Other'] as const;
const AUDIO_AVAILABILITIES = ['ready', 'unresolved'] as const;
const AUDIO_MEDIA_TYPES = ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/aac'] as const;
const UNRESOLVED_AUDIO_REASONS = ['legacy-reference', 'missing-reference'] as const;
const AUTOMATION_TARGET_TYPES = ['track-volume', 'track-pan'] as const;
const AUTOMATION_INTERPOLATIONS = ['hold', 'linear'] as const;
const AUDIO_SEND_POSITIONS = ['pre-fader', 'post-fader'] as const;
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

  takeItems(itemCount: number, maximum: number, path: string): number {
    const remaining = Math.max(0, MAX_PROJECT_TOTAL_ITEMS - this.decodedItems);
    const count = Math.min(itemCount, maximum, remaining);
    if (count < itemCount && remaining < itemCount) {
      this.issue(path, 'out-of-range', `project exceeds ${MAX_PROJECT_TOTAL_ITEMS} nested items`);
    }
    this.decodedItems += count;
    return count;
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

  safeInteger(value: unknown, path: string): number {
    const decoded = this.number(value, path);
    if (!Number.isSafeInteger(decoded)) {
      this.issue(path, 'not-integer', 'expected a safe integer');
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
    const count = this.takeItems(value.length, MAX_PROJECT_COLLECTION_ITEMS, path);
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
  const count = decoder.takeItems(entries.length, 2_048, path);
  for (const [key, item] of entries.slice(0, count)) {
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

function decodeClip(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
  schemaVersion = CURRENT_SCHEMA_VERSION,
): Clip {
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
    ...(schemaVersion >= 3
      ? ['sourceStartFrame', 'sourceFrameCount', 'fadeInFrames', 'fadeOutFrames', 'gainDb']
      : []),
  ]) ?? {};
  const type = decoder.member(
    decoder.required(record, 'type', `${path}.type`),
    CLIP_TYPES,
    `${path}.type`,
  );
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
  const requiresAudioPayload = schemaVersion >= 3 && type === 'audio';
  const audioAssetId = requiresAudioPayload
    ? decoder.string(
        decoder.required(record, 'audioAssetId', `${path}.audioAssetId`),
        `${path}.audioAssetId`,
      )
    : decoder.optionalString(record, 'audioAssetId', `${path}.audioAssetId`);
  const decodeFrameField = (key: string): number | undefined => {
    if (requiresAudioPayload) {
      return decoder.safeInteger(decoder.required(record, key, `${path}.${key}`), `${path}.${key}`);
    }
    return Object.prototype.hasOwnProperty.call(record, key)
      ? decoder.safeInteger(record[key], `${path}.${key}`)
      : undefined;
  };
  const sourceStartFrame = decodeFrameField('sourceStartFrame');
  const sourceFrameCount = decodeFrameField('sourceFrameCount');
  const fadeInFrames = decodeFrameField('fadeInFrames');
  const fadeOutFrames = decodeFrameField('fadeOutFrames');
  const gainDb = requiresAudioPayload
    ? decoder.number(decoder.required(record, 'gainDb', `${path}.gainDb`), `${path}.gainDb`)
    : Object.prototype.hasOwnProperty.call(record, 'gainDb')
      ? decoder.number(record.gainDb, `${path}.gainDb`)
      : undefined;
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    trackId: decoder.string(decoder.required(record, 'trackId', `${path}.trackId`), `${path}.trackId`),
    type,
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
    ...(sourceStartFrame !== undefined ? { sourceStartFrame } : {}),
    ...(sourceFrameCount !== undefined ? { sourceFrameCount } : {}),
    ...(fadeInFrames !== undefined ? { fadeInFrames } : {}),
    ...(fadeOutFrames !== undefined ? { fadeOutFrames } : {}),
    ...(gainDb !== undefined ? { gainDb } : {}),
  };
}

function decodeTrack(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
  schemaVersion = CURRENT_SCHEMA_VERSION,
): Track {
  const record = decoder.record(value, path, [
    'id',
    'name',
    'type',
    ...(schemaVersion >= 3 ? ['role'] : []),
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
    role: schemaVersion >= 3
      ? decoder.member(
          decoder.required(record, 'role', `${path}.role`),
          TRACK_ROLES,
          `${path}.role`,
        )
      : 'general',
    ...(color !== undefined ? { color } : {}),
    clips: decoder.array(
      decoder.required(record, 'clips', `${path}.clips`),
      `${path}.clips`,
      (item, itemPath) => decodeClip(decoder, item, itemPath, schemaVersion),
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

function decodeTempoMapEvent(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): TempoMapEvent {
  const record = decoder.record(value, path, ['id', 'beat', 'bpm']) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    beat: decoder.number(decoder.required(record, 'beat', `${path}.beat`), `${path}.beat`),
    bpm: decoder.number(decoder.required(record, 'bpm', `${path}.bpm`), `${path}.bpm`),
  };
}

function decodeTimeSignatureMapEvent(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): TimeSignatureMapEvent {
  const record = decoder.record(value, path, ['id', 'beat', 'numerator', 'denominator']) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    beat: decoder.number(decoder.required(record, 'beat', `${path}.beat`), `${path}.beat`),
    numerator: decoder.safeInteger(
      decoder.required(record, 'numerator', `${path}.numerator`),
      `${path}.numerator`,
    ),
    denominator: decoder.safeInteger(
      decoder.required(record, 'denominator', `${path}.denominator`),
      `${path}.denominator`,
    ),
  };
}

function decodeAudioAsset(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AudioAsset {
  const record = decoder.record(value, path, [
    'id',
    'availability',
    'checksumSha256',
    'originalName',
    'mediaType',
    'byteLength',
    'sampleRate',
    'channelCount',
    'frameCount',
    'legacyAssetId',
    'reason',
  ]) ?? {};
  const availability = decoder.member(
    decoder.required(record, 'availability', `${path}.availability`),
    AUDIO_AVAILABILITIES,
    `${path}.availability`,
  );
  const id = decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`);

  if (availability === 'ready') {
    for (const key of ['legacyAssetId', 'reason']) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        decoder.issue(`${path}.${key}`, 'unknown-key', `property is not allowed for a ready asset`);
      }
    }
    return {
      id,
      availability,
      checksumSha256: decoder.string(
        decoder.required(record, 'checksumSha256', `${path}.checksumSha256`),
        `${path}.checksumSha256`,
      ),
      originalName: decoder.string(
        decoder.required(record, 'originalName', `${path}.originalName`),
        `${path}.originalName`,
      ),
      mediaType: decoder.member(
        decoder.required(record, 'mediaType', `${path}.mediaType`),
        AUDIO_MEDIA_TYPES,
        `${path}.mediaType`,
      ),
      byteLength: decoder.positiveSafeInteger(
        decoder.required(record, 'byteLength', `${path}.byteLength`),
        `${path}.byteLength`,
      ),
      sampleRate: decoder.positiveSafeInteger(
        decoder.required(record, 'sampleRate', `${path}.sampleRate`),
        `${path}.sampleRate`,
      ),
      channelCount: decoder.positiveSafeInteger(
        decoder.required(record, 'channelCount', `${path}.channelCount`),
        `${path}.channelCount`,
      ),
      frameCount: decoder.positiveSafeInteger(
        decoder.required(record, 'frameCount', `${path}.frameCount`),
        `${path}.frameCount`,
      ),
    };
  }

  for (const key of [
    'checksumSha256',
    'originalName',
    'mediaType',
    'byteLength',
    'sampleRate',
    'channelCount',
    'frameCount',
  ]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      decoder.issue(`${path}.${key}`, 'unknown-key', `property is not allowed for an unresolved asset`);
    }
  }
  const legacyAssetId = decoder.optionalString(record, 'legacyAssetId', `${path}.legacyAssetId`);
  return {
    id,
    availability: 'unresolved',
    ...(legacyAssetId !== undefined ? { legacyAssetId } : {}),
    reason: decoder.member(
      decoder.required(record, 'reason', `${path}.reason`),
      UNRESOLVED_AUDIO_REASONS,
      `${path}.reason`,
    ),
  };
}

function decodeAudioTake(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AudioTake {
  const record = decoder.record(value, path, [
    'id',
    'audioAssetId',
    'offsetBeats',
    'lengthBeats',
    'sourceStartFrame',
    'sourceFrameCount',
    'fadeInFrames',
    'fadeOutFrames',
    'gainDb',
  ]) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    audioAssetId: decoder.string(
      decoder.required(record, 'audioAssetId', `${path}.audioAssetId`),
      `${path}.audioAssetId`,
    ),
    offsetBeats: decoder.number(
      decoder.required(record, 'offsetBeats', `${path}.offsetBeats`),
      `${path}.offsetBeats`,
    ),
    lengthBeats: decoder.number(
      decoder.required(record, 'lengthBeats', `${path}.lengthBeats`),
      `${path}.lengthBeats`,
    ),
    sourceStartFrame: decoder.safeInteger(
      decoder.required(record, 'sourceStartFrame', `${path}.sourceStartFrame`),
      `${path}.sourceStartFrame`,
    ),
    sourceFrameCount: decoder.safeInteger(
      decoder.required(record, 'sourceFrameCount', `${path}.sourceFrameCount`),
      `${path}.sourceFrameCount`,
    ),
    fadeInFrames: decoder.safeInteger(
      decoder.required(record, 'fadeInFrames', `${path}.fadeInFrames`),
      `${path}.fadeInFrames`,
    ),
    fadeOutFrames: decoder.safeInteger(
      decoder.required(record, 'fadeOutFrames', `${path}.fadeOutFrames`),
      `${path}.fadeOutFrames`,
    ),
    gainDb: decoder.number(
      decoder.required(record, 'gainDb', `${path}.gainDb`),
      `${path}.gainDb`,
    ),
  };
}

function decodeAudioCompSegment(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AudioCompSegment {
  const record = decoder.record(value, path, [
    'id',
    'takeId',
    'offsetBeats',
    'lengthBeats',
  ]) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    takeId: decoder.string(
      decoder.required(record, 'takeId', `${path}.takeId`),
      `${path}.takeId`,
    ),
    offsetBeats: decoder.number(
      decoder.required(record, 'offsetBeats', `${path}.offsetBeats`),
      `${path}.offsetBeats`,
    ),
    lengthBeats: decoder.number(
      decoder.required(record, 'lengthBeats', `${path}.lengthBeats`),
      `${path}.lengthBeats`,
    ),
  };
}

function decodeAudioTakeFolder(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AudioTakeFolder {
  const record = decoder.record(value, path, [
    'id',
    'trackId',
    'startBeat',
    'lengthBeats',
    'crossfadeMs',
    'takes',
    'compSegments',
  ]) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    trackId: decoder.string(
      decoder.required(record, 'trackId', `${path}.trackId`),
      `${path}.trackId`,
    ),
    startBeat: decoder.number(
      decoder.required(record, 'startBeat', `${path}.startBeat`),
      `${path}.startBeat`,
    ),
    lengthBeats: decoder.number(
      decoder.required(record, 'lengthBeats', `${path}.lengthBeats`),
      `${path}.lengthBeats`,
    ),
    crossfadeMs: decoder.number(
      decoder.required(record, 'crossfadeMs', `${path}.crossfadeMs`),
      `${path}.crossfadeMs`,
    ),
    takes: decoder.array(
      decoder.required(record, 'takes', `${path}.takes`),
      `${path}.takes`,
      (item, itemPath) => decodeAudioTake(decoder, item, itemPath),
    ),
    compSegments: decoder.array(
      decoder.required(record, 'compSegments', `${path}.compSegments`),
      `${path}.compSegments`,
      (item, itemPath) => decodeAudioCompSegment(decoder, item, itemPath),
    ),
  };
}

function decodeAutomationTarget(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AutomationTarget {
  const record = decoder.record(value, path, ['type', 'trackId']) ?? {};
  return {
    type: decoder.member(
      decoder.required(record, 'type', `${path}.type`),
      AUTOMATION_TARGET_TYPES,
      `${path}.type`,
    ),
    trackId: decoder.string(
      decoder.required(record, 'trackId', `${path}.trackId`),
      `${path}.trackId`,
    ),
  };
}

function decodeAutomationPoint(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AutomationPoint {
  const record = decoder.record(value, path, ['id', 'beat', 'value', 'interpolation']) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    beat: decoder.number(decoder.required(record, 'beat', `${path}.beat`), `${path}.beat`),
    value: decoder.number(decoder.required(record, 'value', `${path}.value`), `${path}.value`),
    interpolation: decoder.member(
      decoder.required(record, 'interpolation', `${path}.interpolation`),
      AUTOMATION_INTERPOLATIONS,
      `${path}.interpolation`,
    ),
  };
}

function decodeAutomationLane(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AutomationLane {
  const record = decoder.record(value, path, ['id', 'bypassed', 'target', 'points']) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    bypassed: decoder.boolean(
      decoder.required(record, 'bypassed', `${path}.bypassed`),
      `${path}.bypassed`,
    ),
    target: decodeAutomationTarget(
      decoder,
      decoder.required(record, 'target', `${path}.target`),
      `${path}.target`,
    ),
    points: decoder.array(
      decoder.required(record, 'points', `${path}.points`),
      `${path}.points`,
      (item, itemPath) => decodeAutomationPoint(decoder, item, itemPath),
    ),
  };
}

function inspectLegacyAutomationLane(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6,
): void {
  const record = decoder.record(
    value,
    path,
    schemaVersion >= 6 ? ['id', 'bypassed', 'target', 'points'] : ['id', 'target', 'points'],
  ) ?? {};
  decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`);
  if (schemaVersion >= 6) {
    decoder.boolean(
      decoder.required(record, 'bypassed', `${path}.bypassed`),
      `${path}.bypassed`,
    );
  }
  decodeAutomationTarget(
    decoder,
    decoder.required(record, 'target', `${path}.target`),
    `${path}.target`,
  );
  decoder.array(
    decoder.required(record, 'points', `${path}.points`),
    `${path}.points`,
    (item, itemPath) => decodeAutomationPoint(decoder, item, itemPath),
  );
}

function decodeAutomationReadState(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AutomationReadState {
  const record = decoder.record(value, path, ['globalEnabled', 'disabledTrackIds']) ?? {};
  return {
    globalEnabled: decoder.boolean(
      decoder.required(record, 'globalEnabled', `${path}.globalEnabled`),
      `${path}.globalEnabled`,
    ),
    disabledTrackIds: decoder.array(
      decoder.required(record, 'disabledTrackIds', `${path}.disabledTrackIds`),
      `${path}.disabledTrackIds`,
      (item, itemPath) => decoder.string(item, itemPath),
    ),
  };
}

function decodeAudioRouteDestination(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AudioRouteDestination {
  const record = decoder.record(value, path, ['type', 'trackId']) ?? {};
  const type = decoder.member(
    decoder.required(record, 'type', `${path}.type`),
    ['master', 'bus'],
    `${path}.type`,
  );
  if (type === 'master') {
    if (Object.prototype.hasOwnProperty.call(record, 'trackId')) {
      decoder.issue(`${path}.trackId`, 'unknown-key', 'Master destination must not contain trackId');
    }
    return { type: 'master' };
  }
  return {
    type: 'bus',
    trackId: decoder.string(
      decoder.required(record, 'trackId', `${path}.trackId`),
      `${path}.trackId`,
    ),
  };
}

function decodeTrackOutputRoute(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): TrackOutputRoute {
  const record = decoder.record(value, path, ['sourceTrackId', 'destination']) ?? {};
  return {
    sourceTrackId: decoder.string(
      decoder.required(record, 'sourceTrackId', `${path}.sourceTrackId`),
      `${path}.sourceTrackId`,
    ),
    destination: decodeAudioRouteDestination(
      decoder,
      decoder.required(record, 'destination', `${path}.destination`),
      `${path}.destination`,
    ),
  };
}

function decodeAudioSend(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AudioSend {
  const record = decoder.record(value, path, [
    'id',
    'sourceTrackId',
    'targetBusId',
    'position',
    'gain',
    'enabled',
  ]) ?? {};
  return {
    id: decoder.string(decoder.required(record, 'id', `${path}.id`), `${path}.id`),
    sourceTrackId: decoder.string(
      decoder.required(record, 'sourceTrackId', `${path}.sourceTrackId`),
      `${path}.sourceTrackId`,
    ),
    targetBusId: decoder.string(
      decoder.required(record, 'targetBusId', `${path}.targetBusId`),
      `${path}.targetBusId`,
    ),
    position: decoder.member(
      decoder.required(record, 'position', `${path}.position`),
      AUDIO_SEND_POSITIONS,
      `${path}.position`,
    ),
    gain: decoder.number(decoder.required(record, 'gain', `${path}.gain`), `${path}.gain`),
    enabled: decoder.boolean(
      decoder.required(record, 'enabled', `${path}.enabled`),
      `${path}.enabled`,
    ),
  };
}

function decodeAudioRouting(
  decoder: StructureDecoder,
  value: unknown,
  path: string,
): AudioRouting {
  const record = decoder.record(value, path, ['outputs', 'sends']) ?? {};
  return {
    outputs: decoder.array(
      decoder.required(record, 'outputs', `${path}.outputs`),
      `${path}.outputs`,
      (item, itemPath) => decodeTrackOutputRoute(decoder, item, itemPath),
    ),
    sends: decoder.array(
      decoder.required(record, 'sends', `${path}.sends`),
      `${path}.sends`,
      (item, itemPath) => decodeAudioSend(decoder, item, itemPath),
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
      'lengthBeats',
      'tempoMap',
      'timeSignatureMap',
      'audioAssets',
      'audioTakeFolders',
      'automationLanes',
      'automationReadState',
      'audioRouting',
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
      lengthBeats: decoder.number(
        decoder.required(record, 'lengthBeats', 'lengthBeats'),
        'lengthBeats',
      ),
      tempoMap: decoder.array(
        decoder.required(record, 'tempoMap', 'tempoMap'),
        'tempoMap',
        (item, itemPath) => decodeTempoMapEvent(decoder, item, itemPath),
      ),
      timeSignatureMap: decoder.array(
        decoder.required(record, 'timeSignatureMap', 'timeSignatureMap'),
        'timeSignatureMap',
        (item, itemPath) => decodeTimeSignatureMapEvent(decoder, item, itemPath),
      ),
      audioAssets: decoder.array(
        decoder.required(record, 'audioAssets', 'audioAssets'),
        'audioAssets',
        (item, itemPath) => decodeAudioAsset(decoder, item, itemPath),
      ),
      audioTakeFolders: decoder.array(
        decoder.required(record, 'audioTakeFolders', 'audioTakeFolders'),
        'audioTakeFolders',
        (item, itemPath) => decodeAudioTakeFolder(decoder, item, itemPath),
      ),
      automationLanes: decoder.array(
        decoder.required(record, 'automationLanes', 'automationLanes'),
        'automationLanes',
        (item, itemPath) => decodeAutomationLane(decoder, item, itemPath),
      ),
      automationReadState: decodeAutomationReadState(
        decoder,
        decoder.required(record, 'automationReadState', 'automationReadState'),
        'automationReadState',
      ),
      audioRouting: decodeAudioRouting(
        decoder,
        decoder.required(record, 'audioRouting', 'audioRouting'),
        'audioRouting',
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

/** Reject fields that were not part of the declared legacy transport shape. */
function inspectLegacyProjectStructure(
  input: unknown,
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6,
): ProjectCodecIssue[] {
  const decoder = new StructureDecoder();
  const record = decoder.record(input, '', [
    'id',
    'schemaVersion',
    'title',
    'bpm',
    'timeSignature',
    'key',
    'scale',
    'lengthBars',
    ...(schemaVersion >= 3
      ? ['lengthBeats', 'tempoMap', 'timeSignatureMap', 'audioAssets', 'automationLanes']
      : []),
    ...(schemaVersion >= 4 ? ['audioRouting'] : []),
    ...(schemaVersion >= 5 ? ['audioTakeFolders'] : []),
    'tracks',
    'chordTrack',
    'sections',
    'createdAt',
    'updatedAt',
  ]);
  if (!record) return decoder.issues;

  decoder.string(decoder.required(record, 'id', 'id'), 'id');
  decoder.positiveSafeInteger(
    decoder.required(record, 'schemaVersion', 'schemaVersion'),
    'schemaVersion',
  );
  decoder.string(decoder.required(record, 'title', 'title'), 'title');
  decoder.number(decoder.required(record, 'bpm', 'bpm'), 'bpm');
  const timeSignature = decoder.required(record, 'timeSignature', 'timeSignature');
  if (!Array.isArray(timeSignature)) {
    decoder.issue('timeSignature', 'invalid-type', 'expected a two-item array');
  } else {
    if (timeSignature.length !== 2) {
      decoder.issue('timeSignature', 'out-of-range', 'expected exactly two items');
    }
    decoder.number(timeSignature[0], 'timeSignature[0]');
    decoder.number(timeSignature[1], 'timeSignature[1]');
  }
  decoder.member(decoder.required(record, 'key', 'key'), PROJECT_KEYS, 'key');
  decoder.member(decoder.required(record, 'scale', 'scale'), PROJECT_SCALES, 'scale');
  decoder.number(decoder.required(record, 'lengthBars', 'lengthBars'), 'lengthBars');
  if (schemaVersion >= 3) {
    decoder.number(decoder.required(record, 'lengthBeats', 'lengthBeats'), 'lengthBeats');
    decoder.array(
      decoder.required(record, 'tempoMap', 'tempoMap'),
      'tempoMap',
      (item, itemPath) => decodeTempoMapEvent(decoder, item, itemPath),
    );
    decoder.array(
      decoder.required(record, 'timeSignatureMap', 'timeSignatureMap'),
      'timeSignatureMap',
      (item, itemPath) => decodeTimeSignatureMapEvent(decoder, item, itemPath),
    );
    decoder.array(
      decoder.required(record, 'audioAssets', 'audioAssets'),
      'audioAssets',
      (item, itemPath) => decodeAudioAsset(decoder, item, itemPath),
    );
    decoder.array(
      decoder.required(record, 'automationLanes', 'automationLanes'),
      'automationLanes',
      (item, itemPath) => inspectLegacyAutomationLane(
        decoder,
        item,
        itemPath,
        schemaVersion,
      ),
    );
  }
  if (schemaVersion >= 4) {
    decodeAudioRouting(
      decoder,
      decoder.required(record, 'audioRouting', 'audioRouting'),
      'audioRouting',
    );
  }
  if (schemaVersion >= 5) {
    decoder.array(
      decoder.required(record, 'audioTakeFolders', 'audioTakeFolders'),
      'audioTakeFolders',
      (item, itemPath) => decodeAudioTakeFolder(decoder, item, itemPath),
    );
  }
  decoder.array(
    decoder.required(record, 'tracks', 'tracks'),
    'tracks',
    (item, itemPath) => decodeTrack(decoder, item, itemPath, schemaVersion),
  );
  decoder.array(
    decoder.required(record, 'chordTrack', 'chordTrack'),
    'chordTrack',
    (item, itemPath) => decodeChord(decoder, item, itemPath),
  );
  decoder.array(
    decoder.required(record, 'sections', 'sections'),
    'sections',
    (item, itemPath) => decodeSection(decoder, item, itemPath),
  );
  decoder.timestamp(decoder.required(record, 'createdAt', 'createdAt'), 'createdAt');
  decoder.timestamp(decoder.required(record, 'updatedAt', 'updatedAt'), 'updatedAt');
  return decoder.issues;
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
    const legacyIssues = inspectLegacyProjectStructure(
      input,
      version.version as 1 | 2 | 3 | 4 | 5 | 6,
    );
    if (legacyIssues.length > 0) {
      return { ok: false, error: { code: 'invalid-project', issues: legacyIssues } };
    }
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
