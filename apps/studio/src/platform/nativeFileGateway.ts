import { invoke as invokeTauriCommand } from '@tauri-apps/api/core';
import {
  MAX_SOURCE_AUDIO_FILE_BYTES,
  SourceAudioFileError,
  inspectSourceAudioFile,
  type SourceAudioDescriptor,
} from '../audio/sourceAudio';
import {
  MAX_PORTABLE_PROJECT_BUNDLE_BYTES,
  MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES,
  PORTABLE_PROJECT_BUNDLE_HEADER_BYTES,
  PORTABLE_PROJECT_BUNDLE_MAGIC,
  PORTABLE_PROJECT_BUNDLE_VERSION,
} from '@cts/project-bundle';
import type { HeavyAudioResourceReservation } from '../audio/audioResourceReservation';

export const NATIVE_PROJECT_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const NATIVE_MIDI_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const NATIVE_AUDIO_FILE_MAX_BYTES = MAX_SOURCE_AUDIO_FILE_BYTES;
export const NATIVE_WAV_FILE_MAX_BYTES = 192 * 1024 * 1024;
export const NATIVE_PROJECT_BUNDLE_MAX_BYTES = MAX_PORTABLE_PROJECT_BUNDLE_BYTES;
export const NATIVE_PROJECT_BUNDLE_MANIFEST_MAX_BYTES =
  MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES;
export const NATIVE_PROJECT_BUNDLE_RESERVATION_BYTES = 384 * 1024 * 1024;
export const SUGGESTED_FILENAME_HEADER = 'x-cts-suggested-filename';
export const MAX_SUGGESTED_FILENAME_UTF8_BYTES = 240;

export const NATIVE_FILE_COMMANDS = {
  openProject: 'file_open_project',
  openProjectBundle: 'file_open_project_bundle',
  openMidi: 'file_open_midi',
  openAudio: 'file_open_audio',
  exportProject: 'file_export_project',
  exportProjectBundle: 'file_export_project_bundle',
  exportMidi: 'file_export_midi',
  exportWav: 'file_export_wav',
} as const;

export type NativeFileCommand =
  (typeof NATIVE_FILE_COMMANDS)[keyof typeof NATIVE_FILE_COMMANDS];

export type NativeOpenFileResult =
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{ status: 'opened'; fileName: string; bytes: Uint8Array }>;

export type NativeOpenAudioFileResult =
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{
      status: 'opened';
      fileName: string;
      bytes: Uint8Array;
      descriptor: SourceAudioDescriptor;
    }>;

export type NativeExportFileResult = Readonly<{
  status: 'saved' | 'cancelled';
}>;

export type NativeRawInvokeOptions = Readonly<{
  headers: Readonly<Record<string, string>>;
}>;

export type NativeRawInvoke = (
  command: NativeFileCommand,
  payload?: Uint8Array,
  options?: NativeRawInvokeOptions,
) => Promise<unknown>;

export type NativeFileGatewayErrorCode =
  | 'invalid-envelope'
  | 'invalid-filename'
  | 'invalid-file'
  | 'unsupported-version'
  | 'file-too-large'
  | 'caller-not-allowed'
  | 'invalid-request'
  | 'dialog-unavailable'
  | 'read-failed'
  | 'write-failed'
  | 'invalid-response';

export class NativeFileGatewayError extends Error {
  constructor(readonly code: NativeFileGatewayErrorCode) {
    super(code);
    this.name = 'NativeFileGatewayError';
  }
}

type FileFormat = 'project' | 'midi' | 'audio' | 'wav';

const OPEN_CANCELLED_TAG = 0;
const OPEN_FILE_TAG = 1;
const OPEN_FILE_HEADER_BYTES = 5;
const MAX_FILENAME_UTF8_BYTES = 1_024;
export const NATIVE_AUDIO_OPEN_ENVELOPE_MAX_BYTES =
  OPEN_FILE_HEADER_BYTES + MAX_FILENAME_UTF8_BYTES + NATIVE_AUDIO_FILE_MAX_BYTES;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();
const nativeCommandErrorCodes = new Set<NativeFileGatewayErrorCode>([
  'caller-not-allowed',
  'invalid-request',
  'invalid-filename',
  'invalid-file',
  'unsupported-version',
  'file-too-large',
  'dialog-unavailable',
  'read-failed',
  'write-failed',
]);

function defaultRawInvoke(
  command: NativeFileCommand,
  payload?: Uint8Array,
  options?: NativeRawInvokeOptions,
): Promise<unknown> {
  return invokeTauriCommand<unknown>(command, payload, options);
}

function hasOnlyStatus(value: unknown): value is NativeExportFileResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 1 &&
    (candidate.status === 'saved' || candidate.status === 'cancelled')
  );
}

function nativeCommandFailure(error: unknown): NativeFileGatewayError {
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const candidate = error as Record<string, unknown>;
    if (
      Object.keys(candidate).length === 1 &&
      typeof candidate.code === 'string' &&
      nativeCommandErrorCodes.has(candidate.code as NativeFileGatewayErrorCode)
    ) {
      return new NativeFileGatewayError(candidate.code as NativeFileGatewayErrorCode);
    }
  }
  // Never pass an unexpected native rejection through to beginner-facing UI:
  // it could contain implementation details that are outside this wire contract.
  return new NativeFileGatewayError('invalid-response');
}

function hasAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function validateProjectMagic(bytes: Uint8Array): boolean {
  try {
    const text = utf8Decoder.decode(bytes);
    return text.replace(/^\uFEFF/, '').trimStart().startsWith('{');
  } catch {
    return false;
  }
}

function validateProjectBundleHeader(bytes: Uint8Array): void {
  if (bytes.byteLength > NATIVE_PROJECT_BUNDLE_MAX_BYTES) {
    throw new NativeFileGatewayError('file-too-large');
  }
  if (bytes.byteLength < PORTABLE_PROJECT_BUNDLE_HEADER_BYTES) {
    throw new NativeFileGatewayError('invalid-file');
  }
  if (!hasAscii(bytes, 0, PORTABLE_PROJECT_BUNDLE_MAGIC)) {
    throw new NativeFileGatewayError('invalid-file');
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint16(8, true) !== PORTABLE_PROJECT_BUNDLE_VERSION) {
    throw new NativeFileGatewayError('unsupported-version');
  }
  const manifestLength = header.getUint32(12, true);
  const projectLength = header.getUint32(16, true);
  const declaredTotal = header.getUint32(24, true);
  if (
    manifestLength > NATIVE_PROJECT_BUNDLE_MANIFEST_MAX_BYTES
    || projectLength > NATIVE_PROJECT_FILE_MAX_BYTES
  ) {
    throw new NativeFileGatewayError('file-too-large');
  }
  if (
    header.getUint16(10, true) !== 0
    || header.getUint32(28, true) !== 0
    || declaredTotal !== bytes.byteLength
    || manifestLength > declaredTotal - PORTABLE_PROJECT_BUNDLE_HEADER_BYTES
    || projectLength
      > declaredTotal - PORTABLE_PROJECT_BUNDLE_HEADER_BYTES - manifestLength
  ) {
    throw new NativeFileGatewayError('invalid-file');
  }
  const manifestStart = PORTABLE_PROJECT_BUNDLE_HEADER_BYTES;
  const manifestEnd = manifestStart + manifestLength;
  let manifest: unknown;
  try {
    manifest = JSON.parse(utf8Decoder.decode(bytes.subarray(manifestStart, manifestEnd)));
  } catch {
    throw new NativeFileGatewayError('invalid-file');
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new NativeFileGatewayError('invalid-file');
  }
  const record = manifest as Record<string, unknown>;
  const project = record.project;
  const assets = record.assets;
  if (
    record.format !== 'ctsbundle'
    || record.version !== PORTABLE_PROJECT_BUNDLE_VERSION
    || typeof project !== 'object'
    || project === null
    || Array.isArray(project)
    || !Array.isArray(assets)
    || assets.length !== header.getUint32(20, true)
    || (project as Record<string, unknown>).byteLength !== projectLength
  ) {
    throw new NativeFileGatewayError('invalid-file');
  }
  let payloadEnd = manifestEnd + projectLength;
  for (const asset of assets) {
    if (
      typeof asset !== 'object'
      || asset === null
      || Array.isArray(asset)
      || !Number.isSafeInteger((asset as Record<string, unknown>).byteLength)
      || ((asset as Record<string, unknown>).byteLength as number) <= 0
    ) {
      throw new NativeFileGatewayError('invalid-file');
    }
    payloadEnd += (asset as Record<string, unknown>).byteLength as number;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > bytes.byteLength) {
      throw new NativeFileGatewayError('invalid-file');
    }
  }
  if (payloadEnd !== bytes.byteLength) {
    throw new NativeFileGatewayError('invalid-file');
  }
}

function assertPortableReservation(
  reservation: HeavyAudioResourceReservation | undefined,
): asserts reservation is HeavyAudioResourceReservation {
  if (
    reservation === undefined
    || reservation.released
    || reservation.bytes !== NATIVE_PROJECT_BUNDLE_RESERVATION_BYTES
  ) {
    throw new NativeFileGatewayError('invalid-request');
  }
}

function validateFileMagic(
  format: FileFormat,
  bytes: Uint8Array,
  fileName?: string,
): boolean {
  if (format === 'project') return validateProjectMagic(bytes);
  if (format === 'midi') {
    return bytes.byteLength >= 14 && hasAscii(bytes, 0, 'MThd');
  }
  if (format === 'audio') {
    if (!fileName) return false;
    try {
      inspectSourceAudioFile(fileName, bytes, bytes.byteLength);
      return true;
    } catch (error) {
      if (error instanceof SourceAudioFileError) return false;
      throw error;
    }
  }
  return (
    bytes.byteLength >= 12 &&
    hasAscii(bytes, 0, 'RIFF') &&
    hasAscii(bytes, 8, 'WAVE')
  );
}

function maximumBytes(format: FileFormat): number {
  if (format === 'project') return NATIVE_PROJECT_FILE_MAX_BYTES;
  if (format === 'midi') return NATIVE_MIDI_FILE_MAX_BYTES;
  if (format === 'audio') return NATIVE_AUDIO_FILE_MAX_BYTES;
  return NATIVE_WAV_FILE_MAX_BYTES;
}

function normalizedUnicode(value: string): string {
  let normalized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    normalized +=
      character.length === 1 && codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff
        ? '_'
        : character;
  }
  return normalized;
}

function extensionFor(format: FileFormat, fileName: string): string | null {
  if (format === 'project') return fileName.toLowerCase().endsWith('.ctsproj.json')
    ? fileName.slice(-'.ctsproj.json'.length)
    : fileName.toLowerCase().endsWith('.json')
      ? fileName.slice(-'.json'.length)
      : null;
  if (format === 'midi') {
    const match = fileName.match(/\.(?:mid|midi)$/i);
    return match?.[0] ?? null;
  }
  if (format === 'audio') {
    const match = fileName.match(/\.(?:wav|mp3|m4a|aac)$/i);
    return match?.[0] ?? null;
  }
  return fileName.toLowerCase().endsWith('.wav') ? fileName.slice(-'.wav'.length) : null;
}

function truncateUtf8(value: string, maximum: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Encoder.encode(character).byteLength;
    if (bytes + characterBytes > maximum) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function normalizeSuggestedFileName(format: FileFormat, fileName: string): string {
  if (
    fileName.length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    /[\u0000-\u001f\u007f/\\<>:"|?*]/.test(fileName)
  ) {
    throw new NativeFileGatewayError('invalid-filename');
  }
  const extension = extensionFor(format, fileName);
  if (!extension) throw new NativeFileGatewayError('invalid-filename');
  const extensionBytes = utf8Encoder.encode(extension).byteLength;
  const normalizedBase = normalizedUnicode(fileName.slice(0, -extension.length))
    .replace(/[. ]+$/g, '') || 'project';
  const safeBase = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(normalizedBase)
    ? `_${normalizedBase}`
    : normalizedBase;
  const boundedBase = truncateUtf8(
    safeBase,
    MAX_SUGGESTED_FILENAME_UTF8_BYTES - extensionBytes,
  ) || 'project';
  return `${boundedBase}${extension}`;
}

function hasExpectedExtension(format: FileFormat, fileName: string): boolean {
  if (format === 'project') return fileName.toLowerCase().endsWith('.json');
  if (format === 'midi') return /\.(?:mid|midi)$/i.test(fileName);
  if (format === 'audio') return /\.(?:wav|mp3|m4a|aac)$/i.test(fileName);
  return fileName.toLowerCase().endsWith('.wav');
}

function validateFileName(format: FileFormat, fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    /[\u0000-\u001f\u007f/\\]/.test(fileName) ||
    utf8Encoder.encode(fileName).byteLength > MAX_FILENAME_UTF8_BYTES ||
    !hasExpectedExtension(format, fileName)
  ) {
    throw new NativeFileGatewayError('invalid-filename');
  }
  // encodeURIComponent is also the export-header encoding. It rejects lone
  // surrogate code units instead of silently replacing them.
  try {
    encodeURIComponent(fileName);
  } catch {
    throw new NativeFileGatewayError('invalid-filename');
  }
}

function validateFileBytes(
  format: FileFormat,
  bytes: Uint8Array,
  fileName?: string,
): SourceAudioDescriptor | null {
  if (bytes.byteLength > maximumBytes(format)) {
    throw new NativeFileGatewayError('file-too-large');
  }
  if (bytes.byteLength === 0) {
    throw new NativeFileGatewayError('invalid-file');
  }
  if (format === 'audio') {
    if (!fileName) throw new NativeFileGatewayError('invalid-file');
    try {
      return inspectSourceAudioFile(fileName, bytes, bytes.byteLength);
    } catch (error) {
      if (error instanceof SourceAudioFileError) {
        throw new NativeFileGatewayError(
          error.code === 'file-too-large' ? 'file-too-large' : 'invalid-file',
        );
      }
      throw error;
    }
  }
  if (!validateFileMagic(format, bytes, fileName)) {
    throw new NativeFileGatewayError('invalid-file');
  }
  return null;
}

export function decodeNativeOpenEnvelope(
  value: unknown,
  format: 'audio',
): NativeOpenAudioFileResult;
export function decodeNativeOpenEnvelope(
  value: unknown,
  format: 'project' | 'midi',
): NativeOpenFileResult;
export function decodeNativeOpenEnvelope(
  value: unknown,
  format: Exclude<FileFormat, 'wav'>,
): NativeOpenFileResult | NativeOpenAudioFileResult {
  const maximumEnvelopeBytes = OPEN_FILE_HEADER_BYTES + MAX_FILENAME_UTF8_BYTES + maximumBytes(format);
  let envelope: Uint8Array;
  if (value instanceof ArrayBuffer) {
    envelope = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    envelope = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (Array.isArray(value)) {
    if (value.length > maximumEnvelopeBytes) {
      throw new NativeFileGatewayError('file-too-large');
    }
    for (const byte of value) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new NativeFileGatewayError('invalid-envelope');
      }
    }
    envelope = Uint8Array.from(value as number[]);
  } else {
    throw new NativeFileGatewayError('invalid-envelope');
  }
  if (envelope.byteLength > maximumEnvelopeBytes) {
    throw new NativeFileGatewayError('file-too-large');
  }
  const tag = envelope[0];
  if (tag === OPEN_CANCELLED_TAG && envelope.byteLength === 1) {
    return { status: 'cancelled' };
  }
  if (tag !== OPEN_FILE_TAG || envelope.byteLength < OPEN_FILE_HEADER_BYTES) {
    throw new NativeFileGatewayError('invalid-envelope');
  }

  const fileNameLength = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(1, true);
  if (
    fileNameLength === 0 ||
    fileNameLength > MAX_FILENAME_UTF8_BYTES ||
    fileNameLength > envelope.byteLength - OPEN_FILE_HEADER_BYTES
  ) {
    throw new NativeFileGatewayError('invalid-envelope');
  }

  const dataOffset = OPEN_FILE_HEADER_BYTES + fileNameLength;
  let fileName: string;
  try {
    fileName = utf8Decoder.decode(envelope.subarray(OPEN_FILE_HEADER_BYTES, dataOffset));
  } catch {
    throw new NativeFileGatewayError('invalid-filename');
  }
  validateFileName(format, fileName);

  const bytes = envelope.subarray(dataOffset);
  const descriptor = validateFileBytes(format, bytes, fileName);
  if (format === 'audio') {
    if (!descriptor) throw new NativeFileGatewayError('invalid-file');
    return { status: 'opened', fileName, bytes, descriptor };
  }
  return { status: 'opened', fileName, bytes };
}

export class NativeFileGateway {
  constructor(private readonly invoke: NativeRawInvoke = defaultRawInvoke) {}

  async openProject(): Promise<NativeOpenFileResult> {
    return decodeNativeOpenEnvelope(
      await this.invokeChecked(NATIVE_FILE_COMMANDS.openProject),
      'project',
    );
  }

  async openMidi(): Promise<NativeOpenFileResult> {
    return decodeNativeOpenEnvelope(
      await this.invokeChecked(NATIVE_FILE_COMMANDS.openMidi),
      'midi',
    );
  }

  async openAudio(): Promise<NativeOpenAudioFileResult> {
    return decodeNativeOpenEnvelope(
      await this.invokeChecked(NATIVE_FILE_COMMANDS.openAudio),
      'audio',
    );
  }

  async openProjectBundle(
    reservation: HeavyAudioResourceReservation,
  ): Promise<NativeOpenFileResult> {
    assertPortableReservation(reservation);
    const result = decodeNativeProjectBundleOpenEnvelope(
      await this.invokeChecked(NATIVE_FILE_COMMANDS.openProjectBundle),
    );
    assertPortableReservation(reservation);
    return result;
  }

  exportProject(bytes: Uint8Array, suggestedFileName: string): Promise<NativeExportFileResult> {
    return this.exportFile(
      NATIVE_FILE_COMMANDS.exportProject,
      'project',
      bytes,
      suggestedFileName,
    );
  }

  exportMidi(bytes: Uint8Array, suggestedFileName: string): Promise<NativeExportFileResult> {
    return this.exportFile(
      NATIVE_FILE_COMMANDS.exportMidi,
      'midi',
      bytes,
      suggestedFileName,
    );
  }

  exportWav(bytes: Uint8Array, suggestedFileName: string): Promise<NativeExportFileResult> {
    return this.exportFile(
      NATIVE_FILE_COMMANDS.exportWav,
      'wav',
      bytes,
      suggestedFileName,
    );
  }

  async exportProjectBundle(
    bytes: Uint8Array,
    suggestedFileName: string,
    reservation: HeavyAudioResourceReservation,
  ): Promise<NativeExportFileResult> {
    assertPortableReservation(reservation);
    validateProjectBundleHeader(bytes);
    const normalizedFileName = normalizeProjectBundleSuggestedFileName(suggestedFileName);
    const response = await this.invokeChecked(
      NATIVE_FILE_COMMANDS.exportProjectBundle,
      bytes,
      {
        headers: {
          [SUGGESTED_FILENAME_HEADER]: encodeURIComponent(normalizedFileName),
        },
      },
    );
    assertPortableReservation(reservation);
    if (!hasOnlyStatus(response)) {
      throw new NativeFileGatewayError('invalid-response');
    }
    return { status: response.status };
  }

  private async exportFile(
    command: NativeFileCommand,
    format: FileFormat,
    bytes: Uint8Array,
    suggestedFileName: string,
  ): Promise<NativeExportFileResult> {
    validateFileBytes(format, bytes);
    const normalizedFileName = normalizeSuggestedFileName(format, suggestedFileName);
    validateFileName(format, normalizedFileName);
    const encodedFileName = encodeURIComponent(normalizedFileName);
    const response = await this.invokeChecked(command, bytes, {
      headers: { [SUGGESTED_FILENAME_HEADER]: encodedFileName },
    });
    if (!hasOnlyStatus(response)) {
      throw new NativeFileGatewayError('invalid-response');
    }
    return { status: response.status };
  }

  private async invokeChecked(
    command: NativeFileCommand,
    payload?: Uint8Array,
    options?: NativeRawInvokeOptions,
  ): Promise<unknown> {
    try {
      if (options !== undefined) return await this.invoke(command, payload, options);
      if (payload !== undefined) return await this.invoke(command, payload);
      return await this.invoke(command);
    } catch (error) {
      throw nativeCommandFailure(error);
    }
  }
}

function normalizeProjectBundleSuggestedFileName(fileName: string): string {
  if (
    fileName.length === 0
    || fileName === '.'
    || fileName === '..'
    || /[\u0000-\u001f\u007f/\\<>:"|?*]/u.test(fileName)
    || !fileName.toLowerCase().endsWith('.ctsbundle')
  ) {
    throw new NativeFileGatewayError('invalid-filename');
  }
  const extension = fileName.slice(-'.ctsbundle'.length);
  const base = normalizedUnicode(fileName.slice(0, -extension.length))
    .replace(/[. ]+$/gu, '') || 'project';
  const safeBase = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(base)
    ? `_${base}`
    : base;
  const boundedBase = truncateUtf8(
    safeBase,
    MAX_SUGGESTED_FILENAME_UTF8_BYTES - utf8Encoder.encode(extension).byteLength,
  ) || 'project';
  return `${boundedBase}${extension}`;
}

export function decodeNativeProjectBundleOpenEnvelope(value: unknown): NativeOpenFileResult {
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
    throw new NativeFileGatewayError('invalid-envelope');
  }
  const envelope = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const maximumEnvelopeBytes =
    OPEN_FILE_HEADER_BYTES + MAX_FILENAME_UTF8_BYTES + NATIVE_PROJECT_BUNDLE_MAX_BYTES;
  if (envelope.byteLength > maximumEnvelopeBytes) {
    throw new NativeFileGatewayError('file-too-large');
  }
  if (envelope[0] === OPEN_CANCELLED_TAG && envelope.byteLength === 1) {
    return { status: 'cancelled' };
  }
  if (envelope[0] !== OPEN_FILE_TAG || envelope.byteLength < OPEN_FILE_HEADER_BYTES) {
    throw new NativeFileGatewayError('invalid-envelope');
  }
  const fileNameLength = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(1, true);
  if (
    fileNameLength === 0
    || fileNameLength > MAX_FILENAME_UTF8_BYTES
    || fileNameLength > envelope.byteLength - OPEN_FILE_HEADER_BYTES
  ) {
    throw new NativeFileGatewayError('invalid-envelope');
  }
  const dataOffset = OPEN_FILE_HEADER_BYTES + fileNameLength;
  let fileName: string;
  try {
    fileName = utf8Decoder.decode(envelope.subarray(OPEN_FILE_HEADER_BYTES, dataOffset));
  } catch {
    throw new NativeFileGatewayError('invalid-filename');
  }
  if (
    /[\u0000-\u001f\u007f/\\]/u.test(fileName)
    || !fileName.toLowerCase().endsWith('.ctsbundle')
  ) {
    throw new NativeFileGatewayError('invalid-filename');
  }
  const bytes = envelope.subarray(dataOffset);
  validateProjectBundleHeader(bytes);
  return { status: 'opened', fileName, bytes };
}

export const nativeFileGateway = new NativeFileGateway();
