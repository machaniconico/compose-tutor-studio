/**
 * High-level MIDI export: converts a Project to Standard MIDI File (format 1)
 * bytes. See docs/02_feature_specification.md section 10 (Export).
 */

import {
  beatsPerBar as beatsPerBarForTimeSignature,
  buildClipIndex,
  compileDrumStepProjector,
  compileMusicalTime,
  countMidiClipNoteOccurrences,
  CURRENT_SCHEMA_VERSION,
  MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER,
  MAX_AUDIO_TAKE_FOLDERS,
  MAX_AUDIO_TAKES_PER_FOLDER,
  MAX_DRUM_STEPS_PER_BAR,
  MAX_PROJECT_STRING_LENGTH,
  MAX_PROJECT_TIMELINE_BEATS,
  MAX_PROJECT_TOTAL_ITEMS,
  MIN_EVENT_DURATION_BEATS,
  projectDrumStep,
  realizeChordTrack,
  resolveClipContent,
  SHA256_PATTERN,
  visitMidiClipNoteOccurrences,
  type AudioAsset,
  type Project,
  type NoteEvent,
  type DrumLane,
  type Track,
  type Clip,
  type ClipIndex,
  type MidiClipNoteOccurrence,
  type MusicalTimeIndex,
  type RealizedChordNote,
  type TempoMapEvent,
  type TimeSignatureMapEvent,
} from '@cts/project-model';
import {
  PPQ,
  MAX_MIDI_VAR_LEN,
  writeVarLen,
  buildHeaderChunk,
  buildTrackChunk,
  concatChunks,
} from './smf.js';
import type { MidiMessage } from './smf.js';

/** GM percussion note numbers for each DrumLane (channel 9). */
const DRUM_NOTE: Record<DrumLane, number> = {
  kick: 36,
  snare: 38,
  closedHat: 42,
  openHat: 46,
  clap: 39,
  perc: 37,
};

/** Fixed sounding duration for a drum hit, in beats. */
const DRUM_HIT_DURATION_BEATS = 0.25; // 1/4 beat

/** GM percussion channel (0-indexed). */
const DRUM_CHANNEL = 9;
const MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15] as const;
const MAX_MIDI_PORT = 0x7f;

export const MAX_MIDI_EXPORT_EVENTS = 200_000;
const MAX_MIDI_TEXT_BYTES = 4_096;
const MAX_MIDI_PPQ = 0x7fff;
const AUDIO_CLIP_FIELDS = [
  'audioAssetId',
  'sourceStartFrame',
  'sourceFrameCount',
  'fadeInFrames',
  'fadeOutFrames',
  'gainDb',
] as const;
const READY_AUDIO_ASSET_FIELDS = [
  'checksumSha256',
  'originalName',
  'mediaType',
  'byteLength',
  'sampleRate',
  'channelCount',
  'frameCount',
] as const;
const AUDIO_MEDIA_TYPES = new Set(['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/aac']);
const AUDIO_TAKE_FOLDER_SCHEMA_VERSION = 5;
const AUDIO_COMP_BEAT_EPSILON = 1e-9;
const AUDIO_TAKE_FOLDER_FIELDS = [
  'id',
  'trackId',
  'startBeat',
  'lengthBeats',
  'crossfadeMs',
  'takes',
  'compSegments',
] as const;
const AUDIO_TAKE_FIELDS = [
  'id',
  'audioAssetId',
  'offsetBeats',
  'lengthBeats',
  'sourceStartFrame',
  'sourceFrameCount',
  'fadeInFrames',
  'fadeOutFrames',
  'gainDb',
] as const;
const AUDIO_COMP_SEGMENT_FIELDS = [
  'id',
  'takeId',
  'offsetBeats',
  'lengthBeats',
] as const;
type AudioTakeFolderExportRecord = Record<string, unknown> & Readonly<{
  takes: unknown[];
  compSegments: unknown[];
}>;

export type MidiExportErrorCode =
  | 'invalid-options'
  | 'invalid-project'
  | 'overlapping-note'
  | 'timing-out-of-range'
  | 'event-limit-exceeded'
  | 'serialization-failed';

export type MidiExportFailure = Readonly<{
  code: MidiExportErrorCode;
  message: string;
  limit?: number;
  observed?: number;
}>;

export type MidiExportResult =
  | Readonly<{ ok: true; bytes: Uint8Array; eventCount: number }>
  | Readonly<{ ok: false; error: MidiExportFailure }>;

export type MidiExportOptions = Readonly<{
  ppq?: number;
  /** May lower the hard event ceiling for constrained callers/tests. */
  maxEvents?: number;
}>;

export class MidiExportError extends Error {
  readonly code: MidiExportErrorCode;
  readonly limit: number | undefined;
  readonly observed: number | undefined;

  constructor(readonly failure: MidiExportFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = 'MidiExportError';
    this.code = failure.code;
    this.limit = failure.limit;
    this.observed = failure.observed;
  }
}

class MidiExportBudget {
  private used = 0;
  private noteOccurrenceWorkUsed = 0;

  constructor(readonly limit: number) {}

  get eventCount(): number {
    return this.used;
  }

  get remaining(): number {
    return this.limit - this.used;
  }

  reserve(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.remaining) {
      const observed = Number.isSafeInteger(count) && count >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, this.used + count)
        : this.limit + 1;
      throw new MidiExportError({
        code: 'event-limit-exceeded',
        message: `MIDI export exceeds ${this.limit} events`,
        limit: this.limit,
        observed,
      });
    }
    this.used += count;
  }

  /** Bound allocation-free loop projection work across the whole export. */
  reserveNoteOccurrenceWork(count: number): void {
    const workLimit = Math.floor(this.limit / 2);
    if (
      !Number.isSafeInteger(count)
      || count < 0
      || count > workLimit - this.noteOccurrenceWorkUsed
    ) {
      throw new MidiExportError({
        code: 'event-limit-exceeded',
        message: 'MIDI clip note projection exceeds the bounded export work budget',
        limit: this.limit,
        observed: this.limit + 1,
      });
    }
    this.noteOccurrenceWorkUsed += count;
  }
}

function exportFailure(
  code: MidiExportErrorCode,
  message: string,
  details: Readonly<{ limit?: number; observed?: number }> = {},
): never {
  throw new MidiExportError({ code, message, ...details });
}

function resolveExportOptions(options: MidiExportOptions | undefined): {
  ppq: number;
  maxEvents: number;
} {
  const ppq = options?.ppq ?? PPQ;
  if (!Number.isSafeInteger(ppq) || ppq <= 0 || ppq > MAX_MIDI_PPQ) {
    exportFailure('invalid-options', `ppq must be an integer in 1..${MAX_MIDI_PPQ}`, {
      limit: MAX_MIDI_PPQ,
      observed: ppq,
    });
  }
  const maxEvents = options?.maxEvents ?? MAX_MIDI_EXPORT_EVENTS;
  if (
    !Number.isSafeInteger(maxEvents)
    || maxEvents <= 0
    || maxEvents > MAX_MIDI_EXPORT_EVENTS
  ) {
    exportFailure(
      'invalid-options',
      `maxEvents must be an integer in 1..${MAX_MIDI_EXPORT_EVENTS}`,
      { limit: MAX_MIDI_EXPORT_EVENTS, observed: maxEvents },
    );
  }
  return { ppq, maxEvents };
}

// --- Meta event builders ---

/** Track name meta event (FF 03). */
function trackNameMeta(name: string): number[] {
  const encoded = utf8Bytes(name);
  return [0xff, 0x03, ...writeVarLen(encoded.length), ...encoded];
}

/** Marker meta event (FF 06) — used for chord symbols on the tempo track. */
function markerMeta(text: string): number[] {
  const encoded = utf8Bytes(text);
  return [0xff, 0x06, ...writeVarLen(encoded.length), ...encoded];
}

/** MIDI Port meta event (FF 21) used to isolate repeated channel numbers. */
function midiPortMeta(port: number): number[] {
  if (!Number.isSafeInteger(port) || port < 0 || port > MAX_MIDI_PORT) {
    exportFailure(
      'invalid-project',
      `MIDI port must be an integer in 0..${MAX_MIDI_PORT}, got ${port}`,
      { limit: MAX_MIDI_PORT, observed: port },
    );
  }
  return [0xff, 0x21, 0x01, port];
}

/** Tempo meta event (FF 51 03) from BPM. */
function tempoMeta(bpm: number): number[] {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    exportFailure('invalid-project', `bpm must be a positive finite number, got ${bpm}`);
  }
  const usPerBeat = Math.round(60_000_000 / bpm);
  if (usPerBeat <= 0 || usPerBeat > 0xff_ffff) {
    exportFailure('invalid-project', `bpm ${bpm} cannot be represented as a MIDI tempo`);
  }
  return [
    0xff, 0x51, 0x03,
    (usPerBeat >>> 16) & 0xff,
    (usPerBeat >>> 8) & 0xff,
    usPerBeat & 0xff,
  ];
}

/** Time signature meta event (FF 58 04). */
function timeSigMeta(num: number, denom: number): number[] {
  if (
    !Number.isSafeInteger(num)
    || num <= 0
    || num > 0xff
    || !Number.isSafeInteger(denom)
    || denom <= 0
    || (denom & (denom - 1)) !== 0
  ) {
    exportFailure('invalid-project', `invalid MIDI time signature ${num}/${denom}`);
  }
  const denomLog2 = Math.round(Math.log2(denom));
  return [0xff, 0x58, 0x04, num, denomLog2, 24, 8];
}

/** Encode MIDI text as UTF-8 while bounding the serialized byte length. */
function utf8Bytes(text: string): number[] {
  if (typeof text !== 'string') {
    exportFailure('invalid-project', 'MIDI text must be a string');
  }
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength > MAX_MIDI_TEXT_BYTES) {
    exportFailure(
      'invalid-project',
      `MIDI text exceeds ${MAX_MIDI_TEXT_BYTES} bytes`,
      { limit: MAX_MIDI_TEXT_BYTES, observed: encoded.byteLength },
    );
  }
  return Array.from(encoded);
}

/** Clamp a number into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Validate a channel-message data byte before it reaches the SMF writer. */
function midiDataByte(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7f) {
    exportFailure('invalid-project', `${label} must be an integer in 0..127, got ${value}`);
  }
  return value;
}

/** Note-on velocity 0 means note-off and is invalid in the project model. */
function midiVelocity(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7f) {
    exportFailure('invalid-project', `${label} must be an integer in 1..127, got ${value}`);
  }
  return value;
}

function trackVolumeCc(value: number, trackId: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    exportFailure(
      'invalid-project',
      `track ${trackId} volume must be a finite number in 0..2, got ${value}`,
    );
  }
  return midiDataByte(volumeToCc(value), `track ${trackId} CC7 value`);
}

function trackPanCc(value: number, trackId: string): number {
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    exportFailure(
      'invalid-project',
      `track ${trackId} pan must be a finite number in -1..1, got ${value}`,
    );
  }
  return midiDataByte(panToCc(value), `track ${trackId} CC10 value`);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    exportFailure('invalid-project', `${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireExactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    exportFailure('invalid-project', `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    if (!hasOwn(record, field) || record[field] === undefined) {
      exportFailure('invalid-project', `${label} requires ${field}`);
    }
  }
  const unexpectedField = Object.keys(record).find((field) => !fields.includes(field));
  if (unexpectedField !== undefined) {
    exportFailure('invalid-project', `${label} has unsupported field ${unexpectedField}`);
  }
  return record;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    exportFailure('invalid-project', `${label} must be a non-empty string`);
  }
  if (value.length > MAX_PROJECT_STRING_LENGTH) {
    exportFailure(
      'invalid-project',
      `${label} must contain at most ${MAX_PROJECT_STRING_LENGTH} characters`,
      { limit: MAX_PROJECT_STRING_LENGTH, observed: value.length },
    );
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    exportFailure('invalid-project', `${label} must be a finite number`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    exportFailure('invalid-project', `${label} must be a safe integer`);
  }
  return value as number;
}

function sameAudioCompBeat(left: number, right: number): boolean {
  return Math.abs(left - right) <= AUDIO_COMP_BEAT_EPSILON;
}

function validateExportAudioAssets(project: Project): ReadonlyMap<string, AudioAsset> {
  const rawAssets = (project as Partial<Pick<Project, 'audioAssets'>>).audioAssets;
  if (rawAssets === undefined) return new Map();
  if (!Array.isArray(rawAssets)) {
    exportFailure('invalid-project', 'audioAssets must be an array');
  }

  const assets = new Map<string, AudioAsset>();
  for (const [index, rawAsset] of rawAssets.entries()) {
    const label = `audioAssets[${index}]`;
    if (typeof rawAsset !== 'object' || rawAsset === null || Array.isArray(rawAsset)) {
      exportFailure('invalid-project', `${label} must be an object`);
    }
    const asset = rawAsset as unknown as Record<string, unknown>;
    if (typeof asset.id !== 'string' || asset.id.length === 0) {
      exportFailure('invalid-project', `${label} id must be a non-empty string`);
    }
    if (assets.has(asset.id)) {
      exportFailure('invalid-project', `audio asset id ${asset.id} must be unique`);
    }

    if (asset.availability === 'ready') {
      if (hasOwn(asset, 'legacyAssetId') || hasOwn(asset, 'reason')) {
        exportFailure('invalid-project', `${label} ready metadata is mutually exclusive`);
      }
      if (
        typeof asset.checksumSha256 !== 'string'
        || !SHA256_PATTERN.test(asset.checksumSha256)
      ) {
        exportFailure(
          'invalid-project',
          `${label} checksumSha256 must be 64 lowercase hexadecimal digits`,
        );
      }
      if (typeof asset.originalName !== 'string' || asset.originalName.length === 0) {
        exportFailure('invalid-project', `${label} originalName must be a non-empty string`);
      }
      if (typeof asset.mediaType !== 'string' || !AUDIO_MEDIA_TYPES.has(asset.mediaType)) {
        exportFailure('invalid-project', `${label} has an unsupported mediaType`);
      }
      requirePositiveSafeInteger(asset.byteLength, `${label} byteLength`);
      if (
        !Number.isSafeInteger(asset.sampleRate)
        || (asset.sampleRate as number) < 8_000
        || (asset.sampleRate as number) > 384_000
      ) {
        exportFailure('invalid-project', `${label} sampleRate must be an integer in 8000..384000`);
      }
      if (
        !Number.isSafeInteger(asset.channelCount)
        || (asset.channelCount as number) < 1
        || (asset.channelCount as number) > 32
      ) {
        exportFailure('invalid-project', `${label} channelCount must be an integer in 1..32`);
      }
      requirePositiveSafeInteger(asset.frameCount, `${label} frameCount`);
    } else if (asset.availability === 'unresolved') {
      if (READY_AUDIO_ASSET_FIELDS.some((field) => hasOwn(asset, field))) {
        exportFailure('invalid-project', `${label} unresolved metadata is mutually exclusive`);
      }
      if (asset.reason !== 'legacy-reference' && asset.reason !== 'missing-reference') {
        exportFailure('invalid-project', `${label} has an unsupported unresolved reason`);
      }
      if (
        asset.reason === 'legacy-reference'
        && (typeof asset.legacyAssetId !== 'string' || asset.legacyAssetId.length === 0)
      ) {
        exportFailure(
          'invalid-project',
          `${label} legacy-reference requires a non-empty legacyAssetId`,
        );
      }
      if (asset.reason === 'missing-reference' && hasOwn(asset, 'legacyAssetId')) {
        exportFailure(
          'invalid-project',
          `${label} missing-reference must not contain legacyAssetId`,
        );
      }
    } else {
      exportFailure('invalid-project', `${label} has an unsupported availability`);
    }
    assets.set(asset.id, rawAsset);
  }
  return assets;
}

function validateExportAudioClip(
  track: Track,
  clip: Clip,
  audioAssets: ReadonlyMap<string, AudioAsset>,
): void {
  const rawClip = clip as unknown as Record<string, unknown>;
  for (const field of AUDIO_CLIP_FIELDS) {
    if (!hasOwn(rawClip, field) || rawClip[field] === undefined) {
      exportFailure('invalid-project', `audio clip ${clip.id} requires ${field}`);
    }
  }
  if (typeof clip.audioAssetId !== 'string' || clip.audioAssetId.length === 0) {
    exportFailure('invalid-project', `audio clip ${clip.id} requires a non-empty audioAssetId`);
  }
  const asset = audioAssets.get(clip.audioAssetId);
  if (asset === undefined) {
    exportFailure(
      'invalid-project',
      `audio clip ${clip.id} references missing asset ${clip.audioAssetId}`,
    );
  }
  if (!Number.isFinite(clip.gainDb) || clip.gainDb! < -96 || clip.gainDb! > 24) {
    exportFailure('invalid-project', `audio clip ${clip.id} gainDb must be in -96..24`);
  }

  const frameFields = [
    'sourceStartFrame',
    'sourceFrameCount',
    'fadeInFrames',
    'fadeOutFrames',
  ] as const;
  for (const field of frameFields) {
    if (!Number.isSafeInteger(clip[field])) {
      exportFailure('invalid-project', `audio clip ${clip.id} ${field} must be a safe integer`);
    }
  }

  if (asset.availability === 'unresolved') {
    if (frameFields.some((field) => clip[field] !== 0)) {
      exportFailure('invalid-project', `unresolved audio clip ${clip.id} must use a zero range`);
    }
    return;
  }
  if (track.type !== 'audio') {
    exportFailure('invalid-project', `ready audio clip ${clip.id} must belong to an audio track`);
  }
  if (clip.sourceStartFrame! < 0) {
    exportFailure('invalid-project', `audio clip ${clip.id} sourceStartFrame must be non-negative`);
  }
  if (clip.sourceFrameCount! <= 0) {
    exportFailure('invalid-project', `audio clip ${clip.id} sourceFrameCount must be positive`);
  }
  if (clip.fadeInFrames! < 0 || clip.fadeOutFrames! < 0) {
    exportFailure('invalid-project', `audio clip ${clip.id} fades must be non-negative`);
  }
  if (clip.sourceStartFrame! > asset.frameCount - clip.sourceFrameCount!) {
    exportFailure('invalid-project', `audio clip ${clip.id} source range exceeds its asset`);
  }
  if (clip.fadeInFrames! > clip.sourceFrameCount! - clip.fadeOutFrames!) {
    exportFailure('invalid-project', `audio clip ${clip.id} fades exceed its source range`);
  }
}

/**
 * Validate v5 Audio take data independently at the MIDI export boundary.
 * Audio take folders are intentionally not projected into SMF, but accepting
 * malformed discarded data would let export report success for a corrupt
 * current-schema project.
 */
function validateExportAudioTakeFolders(
  project: Project,
  audioAssets: ReadonlyMap<string, AudioAsset>,
): void {
  const rawFolders = (
    project as Partial<Pick<Project, 'audioTakeFolders'>>
  ).audioTakeFolders;
  if (rawFolders === undefined) {
    // Pre-v5 projects are still supported by the MIDI compatibility path.
    if (
      project.schemaVersion === CURRENT_SCHEMA_VERSION
      && CURRENT_SCHEMA_VERSION >= AUDIO_TAKE_FOLDER_SCHEMA_VERSION
    ) {
      exportFailure('invalid-project', 'audioTakeFolders is required by the current schema');
    }
    return;
  }
  if (!Array.isArray(rawFolders)) {
    exportFailure('invalid-project', 'audioTakeFolders must be an array');
  }
  if (rawFolders.length > MAX_AUDIO_TAKE_FOLDERS) {
    exportFailure(
      'invalid-project',
      `audioTakeFolders must contain at most ${MAX_AUDIO_TAKE_FOLDERS} items`,
      { limit: MAX_AUDIO_TAKE_FOLDERS, observed: rawFolders.length },
    );
  }

  /*
   * Bound the whole take subtree before walking any take or segment object.
   * Per-folder limits alone would otherwise permit more than four million
   * nested entries across 1,024 folders.
   */
  const folderRecords: AudioTakeFolderExportRecord[] = [];
  let takeNestedItems = rawFolders.length;
  for (const [folderIndex, rawFolder] of rawFolders.entries()) {
    const label = `audioTakeFolders[${folderIndex}]`;
    const folder = requireExactRecord(rawFolder, AUDIO_TAKE_FOLDER_FIELDS, label);
    if (!Array.isArray(folder.takes)) {
      exportFailure('invalid-project', `${label} takes must be an array`);
    }
    if (
      folder.takes.length < 2
      || folder.takes.length > MAX_AUDIO_TAKES_PER_FOLDER
    ) {
      exportFailure(
        'invalid-project',
        `${label} must contain 2..${MAX_AUDIO_TAKES_PER_FOLDER} takes`,
        { limit: MAX_AUDIO_TAKES_PER_FOLDER, observed: folder.takes.length },
      );
    }
    if (!Array.isArray(folder.compSegments)) {
      exportFailure('invalid-project', `${label} compSegments must be an array`);
    }
    if (
      folder.compSegments.length < 1
      || folder.compSegments.length > MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER
    ) {
      exportFailure(
        'invalid-project',
        `${label} must contain 1..${MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER} comp segments`,
        {
          limit: MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER,
          observed: folder.compSegments.length,
        },
      );
    }
    const folderNestedItems = folder.takes.length + folder.compSegments.length;
    if (folderNestedItems > MAX_PROJECT_TOTAL_ITEMS - takeNestedItems) {
      exportFailure(
        'invalid-project',
        `audioTakeFolders exceeds ${MAX_PROJECT_TOTAL_ITEMS} nested items`,
        {
          limit: MAX_PROJECT_TOTAL_ITEMS,
          observed: takeNestedItems + folderNestedItems,
        },
      );
    }
    takeNestedItems += folderNestedItems;
    folderRecords.push(folder as AudioTakeFolderExportRecord);
  }

  // Project ids are globally unique in schema v5. Seed the registry from the
  // rest of the project so new Audio take ids cannot collide across domains.
  const claimedIds = new Set<string>();
  const reserveId = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) claimedIds.add(value);
  };
  const reserveItemIds = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        reserveId((item as Record<string, unknown>).id);
      }
    }
  };
  reserveId(project.id);
  reserveItemIds((project as Partial<Pick<Project, 'tempoMap'>>).tempoMap);
  reserveItemIds(
    (project as Partial<Pick<Project, 'timeSignatureMap'>>).timeSignatureMap,
  );
  reserveItemIds(project.audioAssets);
  reserveItemIds(project.tracks);
  reserveItemIds(project.chordTrack);
  reserveItemIds(project.sections);
  const rawAutomationLanes = (
    project as Partial<Pick<Project, 'automationLanes'>>
  ).automationLanes;
  reserveItemIds(rawAutomationLanes);
  reserveItemIds(project.audioRouting?.sends);
  for (const track of project.tracks) {
    reserveItemIds(track.effects);
    reserveItemIds(track.clips);
    if (Array.isArray(track.clips)) {
      for (const clip of track.clips) {
        reserveItemIds(clip.notes);
        reserveItemIds(clip.drumEvents);
      }
    }
  }
  if (Array.isArray(rawAutomationLanes)) {
    for (const lane of rawAutomationLanes) reserveItemIds(lane.points);
  }

  const claimId = (value: unknown, label: string): string => {
    const id = requireNonEmptyString(value, label);
    if (claimedIds.has(id)) {
      exportFailure('invalid-project', `audio take data id ${id} must be unique`);
    }
    claimedIds.add(id);
    return id;
  };

  const folderWindows: Array<Readonly<{
    trackId: string;
    startBeat: number;
    lengthBeats: number;
  }>> = [];
  for (const [folderIndex, folder] of folderRecords.entries()) {
    const label = `audioTakeFolders[${folderIndex}]`;
    claimId(folder.id, `${label} id`);

    const trackId = requireNonEmptyString(folder.trackId, `${label} trackId`);
    const track = project.tracks.find((candidate) => candidate.id === trackId);
    if (track === undefined) {
      exportFailure('invalid-project', `${label} references missing track ${trackId}`);
    }
    if (track.type !== 'audio') {
      exportFailure('invalid-project', `${label} must belong to an audio track`);
    }

    const startBeat = requireFiniteNumber(folder.startBeat, `${label} startBeat`);
    const lengthBeats = requireFiniteNumber(folder.lengthBeats, `${label} lengthBeats`);
    if (startBeat < 0 || startBeat > MAX_PROJECT_TIMELINE_BEATS) {
      exportFailure(
        'invalid-project',
        `${label} startBeat must be in 0..${MAX_PROJECT_TIMELINE_BEATS}`,
      );
    }
    if (
      lengthBeats < MIN_EVENT_DURATION_BEATS
      || lengthBeats > MAX_PROJECT_TIMELINE_BEATS
    ) {
      exportFailure(
        'invalid-project',
        `${label} lengthBeats must be in ${MIN_EVENT_DURATION_BEATS}..${MAX_PROJECT_TIMELINE_BEATS}`,
      );
    }
    const folderEndBeat = startBeat + lengthBeats;
    if (
      !Number.isFinite(project.lengthBeats)
      || !Number.isFinite(folderEndBeat)
      || folderEndBeat > project.lengthBeats
    ) {
      exportFailure('invalid-project', `${label} must end within the project timeline`);
    }
    if (folderWindows.some((window) => (
      window.trackId === trackId
      && sameAudioCompBeat(window.startBeat, startBeat)
      && sameAudioCompBeat(window.lengthBeats, lengthBeats)
    ))) {
      exportFailure(
        'invalid-project',
        `${label} duplicates an Audio take folder on the same track and timeline window`,
      );
    }
    folderWindows.push({ trackId, startBeat, lengthBeats });

    const crossfadeMs = requireFiniteNumber(folder.crossfadeMs, `${label} crossfadeMs`);
    if (crossfadeMs < 0 || crossfadeMs > 50) {
      exportFailure('invalid-project', `${label} crossfadeMs must be in 0..50`);
    }
    const takeWindows = new Map<
      string,
      Readonly<{ offsetBeats: number; lengthBeats: number }>
    >();
    for (const [takeIndex, rawTake] of folder.takes.entries()) {
      const takeLabel = `${label}.takes[${takeIndex}]`;
      const take = requireExactRecord(rawTake, AUDIO_TAKE_FIELDS, takeLabel);
      const takeId = claimId(take.id, `${takeLabel} id`);
      const audioAssetId = requireNonEmptyString(
        take.audioAssetId,
        `${takeLabel} audioAssetId`,
      );
      const asset = audioAssets.get(audioAssetId);
      if (asset === undefined) {
        exportFailure(
          'invalid-project',
          `${takeLabel} references missing asset ${audioAssetId}`,
        );
      }
      if (asset.availability !== 'ready') {
        exportFailure('invalid-project', `${takeLabel} requires a ready audio asset`);
      }

      const offsetBeats = requireFiniteNumber(take.offsetBeats, `${takeLabel} offsetBeats`);
      const takeLengthBeats = requireFiniteNumber(
        take.lengthBeats,
        `${takeLabel} lengthBeats`,
      );
      if (offsetBeats < 0 || offsetBeats > lengthBeats) {
        exportFailure('invalid-project', `${takeLabel} offset must fall within its folder`);
      }
      if (
        takeLengthBeats < MIN_EVENT_DURATION_BEATS
        || takeLengthBeats > MAX_PROJECT_TIMELINE_BEATS
        || takeLengthBeats > lengthBeats
        || !Number.isFinite(offsetBeats + takeLengthBeats)
        || offsetBeats + takeLengthBeats > lengthBeats
      ) {
        exportFailure('invalid-project', `${takeLabel} range must fit within its folder`);
      }

      const sourceStartFrame = requireSafeInteger(
        take.sourceStartFrame,
        `${takeLabel} sourceStartFrame`,
      );
      const sourceFrameCount = requireSafeInteger(
        take.sourceFrameCount,
        `${takeLabel} sourceFrameCount`,
      );
      const fadeInFrames = requireSafeInteger(
        take.fadeInFrames,
        `${takeLabel} fadeInFrames`,
      );
      const fadeOutFrames = requireSafeInteger(
        take.fadeOutFrames,
        `${takeLabel} fadeOutFrames`,
      );
      if (sourceStartFrame < 0) {
        exportFailure('invalid-project', `${takeLabel} sourceStartFrame must be non-negative`);
      }
      if (sourceFrameCount <= 0) {
        exportFailure('invalid-project', `${takeLabel} sourceFrameCount must be positive`);
      }
      if (fadeInFrames < 0 || fadeOutFrames < 0) {
        exportFailure('invalid-project', `${takeLabel} fades must be non-negative`);
      }
      // Subtraction avoids overflowing a malicious sourceStart + sourceCount.
      if (
        sourceFrameCount > asset.frameCount
        || sourceStartFrame > asset.frameCount - sourceFrameCount
      ) {
        exportFailure('invalid-project', `${takeLabel} source range exceeds its asset`);
      }
      if (fadeInFrames > sourceFrameCount - fadeOutFrames) {
        exportFailure('invalid-project', `${takeLabel} fades exceed its source range`);
      }
      const gainDb = requireFiniteNumber(take.gainDb, `${takeLabel} gainDb`);
      if (gainDb < -96 || gainDb > 24) {
        exportFailure('invalid-project', `${takeLabel} gainDb must be in -96..24`);
      }
      takeWindows.set(takeId, { offsetBeats, lengthBeats: takeLengthBeats });
    }

    let expectedOffsetBeats = 0;
    let previousTakeId: string | undefined;
    for (const [segmentIndex, rawSegment] of folder.compSegments.entries()) {
      const segmentLabel = `${label}.compSegments[${segmentIndex}]`;
      const segment = requireExactRecord(
        rawSegment,
        AUDIO_COMP_SEGMENT_FIELDS,
        segmentLabel,
      );
      claimId(segment.id, `${segmentLabel} id`);
      const takeId = requireNonEmptyString(segment.takeId, `${segmentLabel} takeId`);
      const takeWindow = takeWindows.get(takeId);
      if (takeWindow === undefined) {
        exportFailure(
          'invalid-project',
          `${segmentLabel} references missing take ${takeId}`,
        );
      }
      if (takeId === previousTakeId) {
        exportFailure(
          'invalid-project',
          `${segmentLabel} must be merged with its adjacent same-take segment`,
        );
      }

      const offsetBeats = requireFiniteNumber(
        segment.offsetBeats,
        `${segmentLabel} offsetBeats`,
      );
      const segmentLengthBeats = requireFiniteNumber(
        segment.lengthBeats,
        `${segmentLabel} lengthBeats`,
      );
      if (offsetBeats < 0) {
        exportFailure('invalid-project', `${segmentLabel} offsetBeats must be non-negative`);
      }
      if (
        segmentLengthBeats < MIN_EVENT_DURATION_BEATS
        || segmentLengthBeats > MAX_PROJECT_TIMELINE_BEATS
      ) {
        exportFailure(
          'invalid-project',
          `${segmentLabel} lengthBeats must be in ${MIN_EVENT_DURATION_BEATS}..${MAX_PROJECT_TIMELINE_BEATS}`,
        );
      }
      if (!sameAudioCompBeat(offsetBeats, expectedOffsetBeats)) {
        exportFailure(
          'invalid-project',
          offsetBeats < expectedOffsetBeats
            ? `${segmentLabel} overlaps or is not sorted`
            : `${segmentLabel} leaves a gap or is not sorted`,
        );
      }
      const segmentEndBeat = offsetBeats + segmentLengthBeats;
      if (!Number.isFinite(segmentEndBeat) || segmentEndBeat > lengthBeats) {
        exportFailure('invalid-project', `${segmentLabel} must fit within its folder`);
      }
      const takeEndBeat = takeWindow.offsetBeats + takeWindow.lengthBeats;
      if (
        offsetBeats < takeWindow.offsetBeats
        || segmentEndBeat > takeEndBeat
      ) {
        exportFailure(
          'invalid-project',
          `${segmentLabel} must fit within its selected take`,
        );
      }
      expectedOffsetBeats = segmentEndBeat;
      previousTakeId = takeId;
    }
    if (!sameAudioCompBeat(expectedOffsetBeats, lengthBeats)) {
      exportFailure('invalid-project', `${label} compSegments must exactly cover the folder`);
    }
  }
}

/**
 * Reject domain-invalid shapes before allocation or chord realization can
 * reinterpret them. Audio and automation clips are valid lossy projections:
 * they are deliberately omitted from MIDI, but their payload still has to
 * match the declared clip type.
 */
function validateExportProjectShape(project: Project): void {
  if (!Array.isArray(project.tracks) || !Array.isArray(project.chordTrack)) {
    exportFailure('invalid-project', 'project tracks and chordTrack must be arrays');
  }

  for (const chord of project.chordTrack) {
    if (!Array.isArray(chord.notes)) {
      exportFailure('invalid-project', `chord ${chord.id} notes must be an array`);
    }
    for (const pitch of chord.notes) {
      midiDataByte(pitch, `chord ${chord.id} note pitch`);
    }
  }

  const audioAssets = validateExportAudioAssets(project);
  validateExportAudioTakeFolders(project, audioAssets);
  for (const track of project.tracks) {
    if (!Array.isArray(track.clips)) {
      exportFailure('invalid-project', `track ${track.id} clips must be an array`);
    }
    for (const clip of track.clips) {
      if (clip.trackId !== track.id) {
        exportFailure(
          'invalid-project',
          `clip ${clip.id} trackId must match containing track ${track.id}`,
        );
      }
      if (clip.type === 'midi' && track.type !== 'instrument') {
        exportFailure('invalid-project', `MIDI clip ${clip.id} must belong to an instrument track`);
      }
      if (clip.type === 'drum' && track.type !== 'drum') {
        exportFailure('invalid-project', `drum clip ${clip.id} must belong to a drum track`);
      }
      if (!['midi', 'drum', 'audio', 'automation'].includes(clip.type)) {
        exportFailure('invalid-project', `clip ${clip.id} has an unsupported type`);
      }
      if (clip.notes !== undefined && (clip.type !== 'midi' || !Array.isArray(clip.notes))) {
        exportFailure('invalid-project', `clip ${clip.id} notes are only valid on MIDI clips`);
      }
      if (
        clip.drumEvents !== undefined
        && (clip.type !== 'drum' || !Array.isArray(clip.drumEvents))
      ) {
        exportFailure('invalid-project', `clip ${clip.id} drumEvents are only valid on drum clips`);
      }
      if (
        (clip.stepsPerBar !== undefined || clip.drumGroove !== undefined)
        && clip.type !== 'drum'
      ) {
        exportFailure('invalid-project', `clip ${clip.id} drum settings are only valid on drum clips`);
      }
      if (clip.type === 'audio') {
        validateExportAudioClip(track, clip, audioAssets);
      } else {
        const rawClip = clip as unknown as Record<string, unknown>;
        const audioField = AUDIO_CLIP_FIELDS.find(
          (field) => hasOwn(rawClip, field) && rawClip[field] !== undefined,
        );
        if (audioField !== undefined) {
          exportFailure(
            'invalid-project',
            `clip ${clip.id} ${audioField} is only valid on audio clips`,
          );
        }
      }
    }
  }

  const clipsById = new Map<string, { clip: Clip; track: Track }>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clipsById.has(clip.id)) {
        exportFailure('invalid-project', `clip id ${clip.id} must be unique`);
      }
      clipsById.set(clip.id, { clip, track });
    }
  }
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.aliasOf === undefined) continue;
      const source = clipsById.get(clip.aliasOf);
      if (
        (clip.type !== 'midi' && clip.type !== 'drum')
        || clip.aliasOf === clip.id
        || !source
        || source.track.id !== track.id
        || source.clip.trackId !== track.id
        || source.clip.type !== clip.type
        || source.clip.aliasOf !== undefined
        || source.clip.lengthBeats !== clip.lengthBeats
        || clip.notes !== undefined
        || clip.drumEvents !== undefined
        || clip.stepsPerBar !== undefined
        || clip.drumGroove !== undefined
        || clip.audioAssetId !== undefined
      ) {
        exportFailure('invalid-project', `clip ${clip.id} has an invalid linked source`);
      }
    }
  }
}

function beatToTick(beat: number, ppq: number, label: string): number {
  const tick = Math.round(beat * ppq);
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > MAX_MIDI_VAR_LEN) {
    exportFailure(
      'timing-out-of-range',
      `${label} cannot be represented as a MIDI tick`,
      { limit: MAX_MIDI_VAR_LEN, observed: tick },
    );
  }
  return tick;
}

function requireFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    exportFailure('timing-out-of-range', `${label} must be a finite non-negative number`);
  }
}

function requireFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    exportFailure('timing-out-of-range', `${label} must be a finite positive number`);
  }
}

function timelineMapEvents<T extends Readonly<{ beat: number }>>(
  raw: unknown,
  fallback: readonly T[],
  label: string,
  validateEvent: (event: unknown, index: number) => T,
): readonly T[] {
  if (raw === undefined) return fallback;
  if (!Array.isArray(raw) || raw.length === 0) {
    exportFailure('invalid-project', `${label} must be a non-empty array`);
  }

  const events: T[] = [];
  let previousBeat = Number.NEGATIVE_INFINITY;
  for (const [index, value] of raw.entries()) {
    const event = validateEvent(value, index);
    const beat = event.beat;
    if (!Number.isFinite(beat) || beat < 0) {
      exportFailure(
        'timing-out-of-range',
        `${label}[${index}] beat must be a finite non-negative number`,
      );
    }
    if (index === 0 && beat !== 0) {
      exportFailure('invalid-project', `${label} must start at beat 0`);
    }
    if (beat <= previousBeat) {
      exportFailure('invalid-project', `${label} beats must be strictly increasing`);
    }
    previousBeat = beat;
    events.push(event);
  }
  return events;
}

function timelineEventRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    exportFailure('invalid-project', `${label} must be an object`);
  }
  const event = value as Record<string, unknown>;
  if (typeof event.id !== 'string' || event.id.length === 0) {
    exportFailure('invalid-project', `${label} id must be a non-empty string`);
  }
  return event;
}

function projectTempoMap(project: Project): readonly TempoMapEvent[] {
  const raw = (project as Partial<Pick<Project, 'tempoMap'>>).tempoMap;
  return timelineMapEvents(
    raw,
    [{ id: 'legacy-tempo-0', beat: 0, bpm: project.bpm }],
    'tempoMap',
    (value, index) => {
      const event = timelineEventRecord(value, `tempoMap[${index}]`);
      return {
        id: event.id as string,
        beat: event.beat as number,
        bpm: event.bpm as number,
      };
    },
  );
}

function projectTimeSignatureMap(
  project: Project,
): readonly TimeSignatureMapEvent[] {
  const raw = (project as Partial<Pick<Project, 'timeSignatureMap'>>).timeSignatureMap;
  return timelineMapEvents(
    raw,
    [{
      id: 'legacy-time-signature-0',
      beat: 0,
      numerator: project.timeSignature[0],
      denominator: project.timeSignature[1],
    }],
    'timeSignatureMap',
    (value, index) => {
      const event = timelineEventRecord(value, `timeSignatureMap[${index}]`);
      return {
        id: event.id as string,
        beat: event.beat as number,
        numerator: event.numerator as number,
        denominator: event.denominator as number,
      };
    },
  );
}

/** Preserve every positive musical duration as at least one MIDI tick. */
function quantizedEndTick(
  startTick: number,
  endBeat: number,
  ppq: number,
  label: string,
): number {
  const rounded = beatToTick(endBeat, ppq, label);
  if (rounded > startTick) return rounded;
  if (startTick >= MAX_MIDI_VAR_LEN) {
    exportFailure('timing-out-of-range', `${label} leaves no room for a positive MIDI duration`);
  }
  return startTick + 1;
}

/** Map track volume (0..2) to a CC7 value (0..127). */
export function volumeToCc(volume: number): number {
  return Math.round(clamp(volume / 2, 0, 1) * 127);
}

/** Map track pan (-1..1) to a CC10 value (0..127, 64 = center). */
export function panToCc(pan: number): number {
  return Math.round((clamp(pan, -1, 1) + 1) / 2 * 127);
}

// --- Note / clip conversion ---

/**
 * Convert a single clip's notes into absolute-tick MIDI messages.
 * Honors `clip.loop`: when true, the clip's notes are unrolled across the clip
 * length (`clip.lengthBeats`) using the note pattern's natural length.
 */
function appendClipNotes(
  clip: Clip,
  channel: number,
  ppq: number,
  messages: MidiMessage[],
  budget: MidiExportBudget,
): void {
  const notes = clip.notes ?? [];
  if (notes.length === 0) return;

  requireFiniteNonNegative(clip.startBeat, `clip ${clip.id} start`);
  requireFinitePositive(clip.lengthBeats, `clip ${clip.id} length`);
  for (const note of notes) {
    requireFiniteNonNegative(note.startBeat, `note ${note.id} start`);
    requireFinitePositive(note.durationBeats, `note ${note.id} duration`);
    // Validate authored payload even when tick quantization later omits a
    // sub-tick occurrence at the clip boundary.
    midiDataByte(note.pitch, `note ${note.id} pitch`);
    midiVelocity(note.velocity, `note ${note.id} velocity`);
  }

  const occurrenceCount = countMidiClipNoteOccurrences(clip);
  // Bound even the allocation-free representability pass by the hard export
  // ceiling. The remaining budget is checked against the exact emitted count.
  if (occurrenceCount > Math.floor(budget.limit / 2)) {
    exportFailure(
      'event-limit-exceeded',
      `clip ${clip.id} exceeds the MIDI export event budget`,
      { limit: budget.limit, observed: budget.limit + 1 },
    );
  }
  budget.reserveNoteOccurrenceWork(occurrenceCount);
  const clipEndBeat = clip.startBeat + clip.lengthBeats;
  const clipEndTick = beatToTick(clipEndBeat, ppq, `clip ${clip.id} end`);
  const occurrenceTicks = (
    occurrence: MidiClipNoteOccurrence,
  ): Readonly<{ startTick: number; endTick: number }> | null => {
    const { note } = occurrence;
    const startBeat = clip.startBeat + occurrence.localStartBeat;
    const endBeat = Math.min(
      clipEndBeat,
      startBeat + occurrence.durationBeats,
    );
    const startTick = beatToTick(startBeat, ppq, `note ${note.id} start`);
    // A sub-tick fragment rounded onto the half-open clip boundary cannot be
    // represented without leaking beyond the clip, so omit it deterministically.
    if (startTick >= clipEndTick) return null;
    const endTick = Math.min(
      clipEndTick,
      quantizedEndTick(startTick, endBeat, ppq, `note ${note.id} end`),
    );
    return endTick > startTick ? { startTick, endTick } : null;
  };

  let representableOccurrences = 0;
  visitMidiClipNoteOccurrences(clip, occurrenceCount, (occurrence) => {
    if (occurrenceTicks(occurrence)) representableOccurrences += 1;
  });
  if (representableOccurrences > Math.floor(budget.remaining / 2)) {
    exportFailure(
      'event-limit-exceeded',
      `clip ${clip.id} exceeds the MIDI export event budget`,
      { limit: budget.limit, observed: budget.limit + 1 },
    );
  }
  budget.reserve(representableOccurrences * 2);

  visitMidiClipNoteOccurrences(clip, occurrenceCount, (occurrence) => {
    const ticks = occurrenceTicks(occurrence);
    if (!ticks) return;
    const { note } = occurrence;

    const pitch = midiDataByte(note.pitch, `note ${note.id} pitch`);
    const velocity = midiVelocity(note.velocity, `note ${note.id} velocity`);
    messages.push({ tick: ticks.startTick, bytes: [0x90 | channel, pitch, velocity] });
    messages.push({ tick: ticks.endTick, bytes: [0x80 | channel, pitch, 0] });
  });
}

/** Convert realized project-level chord notes into absolute-tick messages. */
function appendRealizedChordNotes(
  notes: readonly RealizedChordNote[],
  channel: number,
  ppq: number,
  messages: MidiMessage[],
  budget: MidiExportBudget,
): void {
  budget.reserve(notes.length * 2);
  for (const note of notes) {
    requireFiniteNonNegative(note.startBeat, 'realized chord note start');
    requireFinitePositive(note.durationBeats, 'realized chord note duration');
    const startTick = beatToTick(note.startBeat, ppq, 'realized chord note start');
    const endTick = quantizedEndTick(
      startTick,
      note.startBeat + note.durationBeats,
      ppq,
      'realized chord note end',
    );
    const pitch = midiDataByte(note.pitch, 'realized chord note pitch');
    const velocity = midiVelocity(note.velocity, 'realized chord note velocity');
    messages.push({ tick: startTick, bytes: [0x90 | channel, pitch, velocity] });
    messages.push({ tick: endTick, bytes: [0x80 | channel, pitch, 0] });
  }
}

/** Convert a drum clip's events into absolute-tick MIDI messages on channel 9. */
function appendClipDrums(
  clip: Clip,
  ppq: number,
  musicalTime: MusicalTimeIndex,
  messages: MidiMessage[],
  budget: MidiExportBudget,
): void {
  const events = clip.drumEvents ?? [];
  const clipStepsPerBar = clip.stepsPerBar ?? 16;
  if (
    !Number.isSafeInteger(clipStepsPerBar)
    || clipStepsPerBar < 1
    || clipStepsPerBar > MAX_DRUM_STEPS_PER_BAR
  ) {
    exportFailure(
      'invalid-project',
      `clip ${clip.id} stepsPerBar must be an integer in 1..${MAX_DRUM_STEPS_PER_BAR}`,
    );
  }
  const stepsPerBar = clipStepsPerBar;
  for (const [index, event] of events.entries()) {
    if (!Number.isSafeInteger(event?.stepIndex) || event.stepIndex < 0) {
      exportFailure(
        'invalid-project',
        `drum event ${event?.id ?? index} stepIndex must be a non-negative safe integer`,
      );
    }
  }
  if (events.length === 0) return;

  requireFiniteNonNegative(clip.startBeat, `clip ${clip.id} start`);
  const drumProjector = compileDrumStepProjector(
    stepsPerBar,
    clip.startBeat,
    musicalTime,
  );
  budget.reserve(events.length * 2);
  for (const evt of events) {
    const pitch = midiDataByte(DRUM_NOTE[evt.lane], `drum event ${evt.id} pitch`);
    const timing = projectDrumStep(drumProjector, evt.stepIndex);
    requireFinitePositive(timing.beatsPerBar, `clip ${clip.id} beats per bar`);
    const startBeat = timing.beat;
    const startTick = beatToTick(startBeat, ppq, `drum event ${evt.id} start`);
    const endTick = quantizedEndTick(
      startTick,
      startBeat + DRUM_HIT_DURATION_BEATS,
      ppq,
      `drum event ${evt.id} end`,
    );
    const velocity = midiVelocity(evt.velocity, `drum event ${evt.id} velocity`);
    messages.push({ tick: startTick, bytes: [0x90 | DRUM_CHANNEL, pitch, velocity] });
    messages.push({ tick: endTick, bytes: [0x80 | DRUM_CHANNEL, pitch, 0] });
  }
}

/**
 * MIDI Note Off does not identify which same-pitch Note On it ends. Reject a
 * part whose quantized intervals overlap so external players and re-import do
 * not silently shorten or lengthen valid Project notes.
 */
function assertNoAmbiguousNoteOverlap(
  messages: readonly MidiMessage[],
  track: Track,
): void {
  const boundaries: Array<{
    tick: number;
    channel: number;
    pitch: number;
    noteOn: boolean;
  }> = [];
  for (const message of messages) {
    const statusByte = message.bytes[0] ?? 0;
    const status = statusByte & 0xf0;
    const velocity = message.bytes[2] ?? 0;
    const noteOn = status === 0x90 && velocity > 0;
    const noteOff = status === 0x80 || (status === 0x90 && velocity === 0);
    if (!noteOn && !noteOff) continue;
    boundaries.push({
      tick: message.tick,
      channel: statusByte & 0x0f,
      pitch: message.bytes[1] ?? 0,
      noteOn,
    });
  }

  // Match buildTrackChunk: Note Off precedes Note On at the same tick, so
  // exactly adjacent repetitions remain representable.
  boundaries.sort(
    (left, right) => left.tick - right.tick || Number(left.noteOn) - Number(right.noteOn),
  );
  const active = new Set<number>();
  for (const boundary of boundaries) {
    const key = boundary.channel * 128 + boundary.pitch;
    if (!boundary.noteOn) {
      active.delete(key);
      continue;
    }
    if (active.has(key)) {
      exportFailure(
        'overlapping-note',
        `track ${track.id} has overlapping MIDI pitch ${boundary.pitch}; shorten or merge same-pitch notes before exporting`,
      );
    }
    active.add(key);
  }
}

/** Build one MTrk for an instrument/drum track, including CC7/CC10 at start. */
function buildInstrumentTrack(
  project: Project,
  clipIndex: ClipIndex,
  track: Track,
  channel: number,
  port: number,
  ppq: number,
  musicalTime: MusicalTimeIndex,
  budget: MidiExportBudget,
  realizedChordNotes: readonly RealizedChordNote[] = [],
): Uint8Array {
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 15) {
    exportFailure('invalid-project', `track ${track.id} cannot be assigned a MIDI channel`);
  }
  const volumeCc = trackVolumeCc(track.volume, track.id);
  const panCc = trackPanCc(track.pan, track.id);
  // Port + track name + CC7 + CC10 + the end-of-track event added by buildTrackChunk.
  budget.reserve(5);
  const msgs: MidiMessage[] = [
    { tick: 0, bytes: midiPortMeta(port) },
    { tick: 0, bytes: trackNameMeta(track.name) },
    { tick: 0, bytes: [0xb0 | channel, 7, volumeCc] },
    { tick: 0, bytes: [0xb0 | channel, 10, panCc] },
  ];

  for (const clip of track.clips) {
    const effectiveClip = resolveClipContent(project, clip, clipIndex);
    if (!effectiveClip) {
      exportFailure('invalid-project', `clip ${clip.id} has an invalid linked source`);
    }
    if (effectiveClip.type === 'drum') {
      appendClipDrums(effectiveClip, ppq, musicalTime, msgs, budget);
    } else if (effectiveClip.type === 'midi') {
      appendClipNotes(effectiveClip, channel, ppq, msgs, budget);
    }
  }
  appendRealizedChordNotes(realizedChordNotes, channel, ppq, msgs, budget);
  assertNoAmbiguousNoteOverlap(msgs, track);
  return buildTrackChunk(msgs);
}

// --- Top-level export ---

/**
 * Export a Project to a Format-1 Standard MIDI File (Uint8Array).
 *
 * Track layout:
 *   - Track 0 (tempo track): track name, tempo, time signature, and chord
 *     symbols as marker meta events (FF 06) at each chord's startBeat.
 *   - One track per instrument/drum track, with CC7 (volume) and CC10 (pan)
 *     at the track start. Project-level chord events are realized as playable
 *     notes on the dedicated Chords track unless it already has authored notes.
 *
 * Non-drum tracks use the 15 melodic channels in deterministic round-robin
 * order. Channel 9 remains reserved for GM percussion. Every exported track
 * receives a unique MIDI port/channel pair via FF 21, so reused channel
 * numbers do not share mixer state.
 */
export function projectToMidiResult(
  project: Project,
  options?: MidiExportOptions,
): MidiExportResult {
  try {
    const resolved = resolveExportOptions(options);
    const budget = new MidiExportBudget(resolved.maxEvents);
    const bytes = projectToMidiWithinBudget(project, resolved.ppq, budget);
    return { ok: true, bytes, eventCount: budget.eventCount };
  } catch (error) {
    if (error instanceof MidiExportError) return { ok: false, error: error.failure };
    return {
      ok: false,
      error: {
        code: 'serialization-failed',
        message: error instanceof Error ? error.message : 'MIDI serialization failed',
      },
    };
  }
}

function projectToMidiWithinBudget(
  project: Project,
  ppq: number,
  budget: MidiExportBudget,
): Uint8Array {
  if (typeof project !== 'object' || project === null) {
    exportFailure('invalid-project', 'project must be an object');
  }
  validateExportProjectShape(project);
  const realizedChords = realizeChordTrack(project);
  const clipIndex = buildClipIndex(project);
  const tempoMap = projectTempoMap(project);
  const timeSignatureMap = projectTimeSignatureMap(project);
  const legacyLengthBeats = project.lengthBars
    * beatsPerBarForTimeSignature(project.timeSignature);
  const musicalTime = compileMusicalTime({
    lengthBeats: Number.isFinite(project.lengthBeats)
      ? project.lengthBeats
      : legacyLengthBeats,
    tempoMap,
    timeSignatureMap,
  });

  // --- Track 0: tempo / meta / chord markers ---
  // Track name + every map event + markers + buildTrackChunk's end-of-track.
  budget.reserve(2 + tempoMap.length + timeSignatureMap.length + project.chordTrack.length);
  const metaMessages: MidiMessage[] = [
    { tick: 0, bytes: trackNameMeta(project.title) },
  ];
  // Keep map order canonical. Distinct beats may quantize to the same tick at
  // a low PPQ; stable insertion makes the later map point the effective value.
  for (const event of tempoMap) {
    metaMessages.push({
      tick: beatToTick(event.beat, ppq, `tempo ${event.id} beat`),
      bytes: tempoMeta(event.bpm),
    });
  }
  for (const event of timeSignatureMap) {
    metaMessages.push({
      tick: beatToTick(event.beat, ppq, `time signature ${event.id} beat`),
      bytes: timeSigMeta(event.numerator, event.denominator),
    });
  }
  for (const chord of project.chordTrack) {
    metaMessages.push({
      tick: beatToTick(chord.startBeat, ppq, `chord ${chord.id} start`),
      bytes: markerMeta(chord.symbol),
    });
  }
  const tempoTrack = buildTrackChunk(metaMessages);

  // --- One track per instrument/drum track ---
  const trackChunks: Uint8Array[] = [];
  let nextMelodicChannel = 0;
  let nextDrumPort = 0;
  const allocMelodicDestination = (): { channel: number; port: number } => {
    const channel = MELODIC_CHANNELS[nextMelodicChannel % MELODIC_CHANNELS.length];
    const port = Math.floor(nextMelodicChannel / MELODIC_CHANNELS.length);
    nextMelodicChannel += 1;
    return { channel: channel!, port };
  };
  const allocDrumDestination = (): { channel: number; port: number } => {
    const port = nextDrumPort;
    nextDrumPort += 1;
    return { channel: DRUM_CHANNEL, port };
  };

  for (const track of project.tracks) {
    if (track.type !== 'instrument' && track.type !== 'drum') continue;
    const { channel, port } = track.type === 'drum'
      ? allocDrumDestination()
      : allocMelodicDestination();
    const realizedNotes = realizedChords?.track.id === track.id ? realizedChords.notes : [];
    trackChunks.push(
      buildInstrumentTrack(
        project,
        clipIndex,
        track,
        channel,
        port,
        ppq,
        musicalTime,
        budget,
        realizedNotes,
      ),
    );
  }

  const allTracks = [tempoTrack, ...trackChunks];
  const header = buildHeaderChunk(1, allTracks.length, ppq);
  return concatChunks(header, ...allTracks);
}

/** Compatibility wrapper for existing byte-oriented callers. */
export function projectToMidi(project: Project, options?: MidiExportOptions): Uint8Array {
  const result = projectToMidiResult(project, options);
  if (!result.ok) throw new MidiExportError(result.error);
  return result.bytes;
}

/**
 * @deprecated Use {@link projectToMidi}. Retained for backward compatibility.
 */
export const exportProjectToMidi = projectToMidi;

/**
 * Convenience export: a list of NoteEvents → single-track Format-0 MIDI.
 * Useful for quick previews of a single instrument part.
 */
export function exportNotesToMidi(
  notes: NoteEvent[],
  bpm: number,
  options?: { ppq?: number; channel?: number },
): Uint8Array {
  const ppq = options?.ppq ?? PPQ;
  const channel = options?.channel ?? 0;
  if (!Number.isSafeInteger(ppq) || ppq <= 0 || ppq > MAX_MIDI_PPQ) {
    exportFailure('invalid-options', `ppq must be an integer in 1..${MAX_MIDI_PPQ}`);
  }
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 15) {
    exportFailure('invalid-options', 'channel must be an integer in 0..15');
  }
  if (notes.length > Math.floor((MAX_MIDI_EXPORT_EVENTS - 1) / 2)) {
    exportFailure(
      'event-limit-exceeded',
      `MIDI export exceeds ${MAX_MIDI_EXPORT_EVENTS} events`,
      { limit: MAX_MIDI_EXPORT_EVENTS, observed: 1 + notes.length * 2 },
    );
  }

  const msgs: MidiMessage[] = [{ tick: 0, bytes: tempoMeta(bpm) }];
  for (const note of notes) {
    requireFiniteNonNegative(note.startBeat, `note ${note.id} start`);
    requireFinitePositive(note.durationBeats, `note ${note.id} duration`);
    const startTick = beatToTick(note.startBeat, ppq, `note ${note.id} start`);
    const endTick = quantizedEndTick(
      startTick,
      note.startBeat + note.durationBeats,
      ppq,
      `note ${note.id} end`,
    );
    const pitch = midiDataByte(note.pitch, `note ${note.id} pitch`);
    const velocity = midiVelocity(note.velocity, `note ${note.id} velocity`);
    msgs.push({ tick: startTick, bytes: [0x90 | channel, pitch, velocity] });
    msgs.push({ tick: endTick, bytes: [0x80 | channel, pitch, 0] });
  }

  const track = buildTrackChunk(msgs);
  const header = buildHeaderChunk(0, 1, ppq);
  return concatChunks(header, track);
}
