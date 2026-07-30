export const CANONICAL_PCM16_SAMPLE_RATE = 48_000;
export const MAX_CANONICAL_PCM16_CHANNELS = 2;

export type CanonicalPcm16ErrorCode =
  | 'invalid-wav'
  | 'unsupported-format'
  | 'metadata-mismatch'
  | 'resource-limit';

export class CanonicalPcm16Error extends Error {
  constructor(
    readonly code: CanonicalPcm16ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalPcm16Error';
  }
}

export type CanonicalPcm16 = Readonly<{
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  channels: readonly Float32Array[];
}>;

export type CanonicalPcm16Expectation = Readonly<{
  sampleRate?: number;
  channelCount?: number;
  frameCount?: number;
}>;

export type CanonicalPcm16Window = Readonly<{
  startFrame: number;
  frameCount: number;
}>;

const text = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** Parse a verified canonical WAV without mutating or retaining its source bytes. */
export function parseCanonicalPcm16(
  bytes: Uint8Array,
  expected: CanonicalPcm16Expectation = {},
): CanonicalPcm16 {
  const inspected = inspectCanonicalPcm16(bytes, expected);
  return decodeCanonicalPcm16Window(inspected, {
    startFrame: 0,
    frameCount: inspected.frameCount,
  });
}

/**
 * Decode only one verified source window. The full WAV metadata is still
 * checked, but PCM outside the requested clip range is never materialized.
 */
export function parseCanonicalPcm16Window(
  bytes: Uint8Array,
  expected: CanonicalPcm16Expectation,
  window: CanonicalPcm16Window,
): CanonicalPcm16 {
  const inspected = inspectCanonicalPcm16(bytes, expected);
  if (
    !Number.isSafeInteger(window.startFrame)
    || window.startFrame < 0
    || !Number.isSafeInteger(window.frameCount)
    || window.frameCount <= 0
    || window.startFrame > inspected.frameCount - window.frameCount
  ) {
    throw new CanonicalPcm16Error(
      'metadata-mismatch',
      'Canonical PCM window exceeds the verified AudioAsset.',
    );
  }
  return decodeCanonicalPcm16Window(inspected, window);
}

type InspectedCanonicalPcm16 = Readonly<{
  view: DataView;
  dataOffset: number;
  sampleRate: number;
  channelCount: 1 | 2;
  frameCount: number;
}>;

function inspectCanonicalPcm16(
  bytes: Uint8Array,
  expected: CanonicalPcm16Expectation,
): InspectedCanonicalPcm16 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) {
    throw new CanonicalPcm16Error('invalid-wav', 'Canonical WAV header is missing.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (text(bytes, 0) !== 'RIFF' || text(bytes, 8) !== 'WAVE') {
    throw new CanonicalPcm16Error('invalid-wav', 'Canonical audio must be a RIFF/WAVE file.');
  }
  const riffSize = view.getUint32(4, true);
  if (riffSize + 8 !== bytes.byteLength) {
    throw new CanonicalPcm16Error('invalid-wav', 'RIFF length does not match the verified bytes.');
  }

  let format: Readonly<{
    audioFormat: number;
    channelCount: number;
    sampleRate: number;
    blockAlign: number;
    bitsPerSample: number;
  }> | null = null;
  let dataOffset = -1;
  let dataLength = -1;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = text(bytes, offset);
    const length = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    const end = payload + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
      throw new CanonicalPcm16Error('invalid-wav', 'WAV chunk exceeds the verified bytes.');
    }
    if (id === 'fmt ') {
      if (format !== null || length < 16) {
        throw new CanonicalPcm16Error('invalid-wav', 'WAV must contain one PCM format chunk.');
      }
      format = {
        audioFormat: view.getUint16(payload, true),
        channelCount: view.getUint16(payload + 2, true),
        sampleRate: view.getUint32(payload + 4, true),
        blockAlign: view.getUint16(payload + 12, true),
        bitsPerSample: view.getUint16(payload + 14, true),
      };
    } else if (id === 'data') {
      if (dataOffset >= 0) {
        throw new CanonicalPcm16Error('invalid-wav', 'WAV must contain one data chunk.');
      }
      dataOffset = payload;
      dataLength = length;
    }
    offset = end + (length & 1);
  }
  if (offset !== bytes.byteLength || format === null || dataOffset < 0) {
    throw new CanonicalPcm16Error('invalid-wav', 'WAV chunks are incomplete.');
  }
  const { audioFormat, channelCount, sampleRate, blockAlign, bitsPerSample } = format;
  if (
    audioFormat !== 1
    || bitsPerSample !== 16
    || sampleRate !== CANONICAL_PCM16_SAMPLE_RATE
    || (channelCount !== 1 && channelCount !== MAX_CANONICAL_PCM16_CHANNELS)
    || blockAlign !== channelCount * Int16Array.BYTES_PER_ELEMENT
    || dataLength <= 0
    || dataLength % blockAlign !== 0
  ) {
    throw new CanonicalPcm16Error(
      'unsupported-format',
      'Elastic Audio requires 48 kHz mono or stereo PCM16 WAV.',
    );
  }
  const frameCount = dataLength / blockAlign;
  if (!Number.isSafeInteger(frameCount)) {
    throw new CanonicalPcm16Error('resource-limit', 'PCM frame count is unsafe.');
  }
  if (
    (expected.sampleRate !== undefined && expected.sampleRate !== sampleRate)
    || (expected.channelCount !== undefined && expected.channelCount !== channelCount)
    || (expected.frameCount !== undefined && expected.frameCount !== frameCount)
  ) {
    throw new CanonicalPcm16Error(
      'metadata-mismatch',
      'Canonical WAV metadata does not match the ready AudioAsset.',
    );
  }
  return {
    view,
    dataOffset,
    sampleRate,
    channelCount,
    frameCount,
  };
}

function decodeCanonicalPcm16Window(
  inspected: InspectedCanonicalPcm16,
  window: CanonicalPcm16Window,
): CanonicalPcm16 {
  const {
    view,
    dataOffset,
    sampleRate,
    channelCount,
  } = inspected;
  const channels = Array.from(
    { length: channelCount },
    () => new Float32Array(window.frameCount),
  );
  for (let frame = 0; frame < window.frameCount; frame += 1) {
    const sourceFrame = window.startFrame + frame;
    for (let channel = 0; channel < channelCount; channel += 1) {
      channels[channel]![frame] = view.getInt16(
        dataOffset + (sourceFrame * channelCount + channel) * 2,
        true,
      ) / 32_768;
    }
  }
  return Object.freeze({
    sampleRate,
    channelCount,
    frameCount: window.frameCount,
    channels: Object.freeze(channels),
  });
}

export const decodeCanonicalPcm16Wav = parseCanonicalPcm16;
