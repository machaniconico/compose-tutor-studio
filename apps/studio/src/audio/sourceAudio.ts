/**
 * Bounded source-audio validation shared by the web picker and the native IPC
 * gateway. This is intentionally a small allowlist: every accepted container
 * must also be decodable by the host WebView before vocal-cut processing.
 */

export const MAX_SOURCE_AUDIO_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_SOURCE_AUDIO_STRUCTURE_ITEMS = 100_000;
export const SOURCE_AUDIO_ACCEPT = [
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
].join(',');

export type SourceAudioFormat = 'wav' | 'mp3' | 'm4a' | 'aac';

export type SourceAudioDescriptor = Readonly<{
  format: SourceAudioFormat;
  mimeType: string;
  /** Canonical sample rate declared by the validated audio stream. */
  sampleRate: number;
  channelCount: number;
  /** Maximum channel allocation implied by any decoder resynchronization candidate. */
  decodeChannelCountUpperBound: number;
  /** Duration declared by the validated canonical container/frame chain. */
  containerDurationSeconds: number;
  /** Conservative upper bound for the PCM duration decodeAudioData may allocate. */
  decodeDurationSeconds: number;
}>;

export type SourceAudioFileErrorCode =
  | 'file-too-large'
  | 'invalid-filename'
  | 'invalid-file';

export class SourceAudioFileError extends Error {
  constructor(readonly code: SourceAudioFileErrorCode) {
    super(code);
    this.name = 'SourceAudioFileError';
  }
}

const SOURCE_AUDIO_EXTENSIONS: Readonly<Record<SourceAudioFormat, string>> = {
  wav: '.wav',
  mp3: '.mp3',
  m4a: '.m4a',
  aac: '.aac',
};

const SOURCE_AUDIO_MIME_TYPES: Readonly<Record<SourceAudioFormat, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

function hasAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function extensionFormat(fileName: string): SourceAudioFormat | null {
  const lower = fileName.toLowerCase();
  for (const format of Object.keys(SOURCE_AUDIO_EXTENSIONS) as SourceAudioFormat[]) {
    if (lower.endsWith(SOURCE_AUDIO_EXTENSIONS[format])) return format;
  }
  return null;
}

function readUint32(bytes: Uint8Array, offset: number, littleEndian: boolean): number | null {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, littleEndian);
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number | null {
  if (offset < 0 || offset + 2 > bytes.byteLength) return null;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, littleEndian);
}

type StructureBudget = { remaining: number };

function consumeStructureItem(budget: StructureBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

type SourceAudioMediaInfo = Readonly<{
  sampleRate: number;
  channelCount: number;
  decodeChannelCountUpperBound: number;
  containerDurationSeconds: number;
  decodeDurationSeconds: number;
}>;

function addSampleCount(
  samplesByRate: Map<number, number>,
  sampleRate: number,
  samples: number,
): boolean {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(samples) ||
    samples <= 0
  ) {
    return false;
  }
  const previous = samplesByRate.get(sampleRate) ?? 0;
  if (samples > Number.MAX_SAFE_INTEGER - previous) return false;
  samplesByRate.set(sampleRate, previous + samples);
  return true;
}

/** Convert exact sample/time-unit counts to a conservative, bounded microsecond ceiling. */
function durationUpperBoundMicroseconds(
  countsByTimescale: ReadonlyMap<number, number>,
): number | null {
  let totalMicroseconds = 0n;
  for (const [timescale, count] of countsByTimescale) {
    if (
      !Number.isSafeInteger(timescale) ||
      timescale <= 0 ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      return null;
    }
    const scale = BigInt(timescale);
    const microseconds =
      (BigInt(count) * 1_000_000n + scale - 1n) / scale;
    totalMicroseconds += microseconds;
    if (totalMicroseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  }
  if (totalMicroseconds <= 0n) return null;
  return Number(totalMicroseconds);
}

function durationUpperBoundSeconds(
  countsByTimescale: ReadonlyMap<number, number>,
): number | null {
  const microseconds = durationUpperBoundMicroseconds(countsByTimescale);
  if (microseconds === null) return null;
  const seconds = microseconds / 1_000_000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

type WavSampleFormat = 'pcm' | 'float';

function supportedWavSampleFormat(
  bytes: Uint8Array,
  start: number,
  size: number,
  bitsPerSample: number,
): WavSampleFormat | null {
  const formatTag = readUint16(bytes, start, true);
  const sampleFormat: WavSampleFormat | null =
    formatTag === 1 ? 'pcm' : formatTag === 3 ? 'float' : null;
  if (sampleFormat !== null) {
    const allowedBits = sampleFormat === 'pcm' ? [8, 16, 24, 32] : [32];
    return allowedBits.includes(bitsPerSample) ? sampleFormat : null;
  }
  if (formatTag !== 0xfffe || size !== 40) return null;
  const extensionSize = readUint16(bytes, start + 16, true);
  const validBitsPerSample = readUint16(bytes, start + 18, true);
  if (
    extensionSize !== 22 ||
    validBitsPerSample === null ||
    validBitsPerSample <= 0 ||
    validBitsPerSample > bitsPerSample
  ) {
    return null;
  }
  const subformatTag = readUint32(bytes, start + 24, true);
  const extensibleFormat: WavSampleFormat | null =
    subformatTag === 1 ? 'pcm' : subformatTag === 3 ? 'float' : null;
  const allowedBits = extensibleFormat === 'pcm' ? [8, 16, 24, 32] : [32];
  if (
    extensibleFormat === null ||
    !allowedBits.includes(bitsPerSample) ||
    (extensibleFormat === 'float' && validBitsPerSample !== bitsPerSample)
  ) {
    return null;
  }
  return (
    readUint16(bytes, start + 28, true) === 0 &&
    readUint16(bytes, start + 30, true) === 0x0010 &&
    hasAscii(bytes, start + 32, '\u0080\u0000\u0000\u00aa\u00008\u009bq')
  )
    ? extensibleFormat
    : null;
}

function sourceWavMediaInfo(bytes: Uint8Array): SourceAudioMediaInfo | null {
  if (
    bytes.byteLength < 12 ||
    !hasAscii(bytes, 0, 'RIFF') ||
    !hasAscii(bytes, 8, 'WAVE')
  ) {
    return null;
  }
  const declaredSize = readUint32(bytes, 4, true);
  if (declaredSize === null || declaredSize + 8 !== bytes.byteLength) return null;

  let offset = 12;
  let channelCount: number | null = null;
  let sampleRate: number | null = null;
  let blockAlign: number | null = null;
  let dataBytes = 0;
  const budget: StructureBudget = { remaining: MAX_SOURCE_AUDIO_STRUCTURE_ITEMS };
  while (offset < bytes.byteLength) {
    if (!consumeStructureItem(budget)) return null;
    const chunkSize = readUint32(bytes, offset + 4, true);
    if (chunkSize === null) return null;
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.byteLength) return null;
    if (hasAscii(bytes, offset, 'fmt ')) {
      const channels = chunkSize >= 16 ? readUint16(bytes, dataStart + 2, true) : null;
      const rate = chunkSize >= 16 ? readUint32(bytes, dataStart + 4, true) : null;
      const byteRate = chunkSize >= 16 ? readUint32(bytes, dataStart + 8, true) : null;
      const alignment = chunkSize >= 16 ? readUint16(bytes, dataStart + 12, true) : null;
      const bitsPerSample = chunkSize >= 16 ? readUint16(bytes, dataStart + 14, true) : null;
      const sampleFormat =
        bitsPerSample === null
          ? null
          : supportedWavSampleFormat(bytes, dataStart, chunkSize, bitsPerSample);
      if (
        channels === null ||
        channels <= 0 ||
        rate === null ||
        rate < 8_000 ||
        rate > 192_000 ||
        byteRate === null ||
        alignment === null ||
        alignment <= 0 ||
        bitsPerSample === null ||
        bitsPerSample <= 0 ||
        bitsPerSample % 8 !== 0 ||
        channelCount !== null ||
        sampleFormat === null ||
        alignment !== channels * (bitsPerSample / 8) ||
        byteRate !== rate * alignment
      ) {
        return null;
      }
      channelCount = channels;
      sampleRate = rate;
      blockAlign = alignment;
    }
    if (hasAscii(bytes, offset, 'data') && chunkSize > 0) {
      if (chunkSize > Number.MAX_SAFE_INTEGER - dataBytes) return null;
      dataBytes += chunkSize;
    }
    if (
      hasAscii(bytes, offset, 'slnt') ||
      (hasAscii(bytes, offset, 'LIST') && chunkSize >= 4 && hasAscii(bytes, dataStart, 'wavl'))
    ) {
      return null;
    }
    const next = dataEnd + (chunkSize & 1);
    if (!Number.isSafeInteger(next) || next > bytes.byteLength) return null;
    offset = next;
  }
  if (
    offset !== bytes.byteLength ||
    channelCount === null ||
    sampleRate === null ||
    blockAlign === null ||
    dataBytes <= 0 ||
    dataBytes % blockAlign !== 0
  ) {
    return null;
  }
  const frames = dataBytes / blockAlign;
  const decodeDurationSeconds = durationUpperBoundSeconds(
    new Map([[sampleRate, frames]]),
  );
  return decodeDurationSeconds === null
      ? null
      : {
        sampleRate,
        channelCount,
        decodeChannelCountUpperBound: channelCount,
        containerDurationSeconds: decodeDurationSeconds,
        decodeDurationSeconds,
      };
}

function id3AudioOffset(bytes: Uint8Array): number | null {
  if (!hasAscii(bytes, 0, 'ID3')) return 0;
  if (bytes.byteLength < 10) return null;
  const version = bytes[3] ?? 0;
  const allowedFlags = version === 2 ? 0xc0 : version === 3 ? 0xe0 : version === 4 ? 0xf0 : null;
  const revision = bytes[4] ?? 0xff;
  const flags = bytes[5] ?? 0xff;
  if (allowedFlags === null || revision === 0xff || (flags & ~allowedFlags) !== 0) return null;
  let tagSize = 0;
  for (let offset = 6; offset < 10; offset += 1) {
    const byte = bytes[offset] ?? 0x80;
    if ((byte & 0x80) !== 0) return null;
    tagSize = (tagSize << 7) | byte;
  }
  const tagEnd = 10 + tagSize;
  let audioOffset = tagEnd;
  if (version === 4 && (flags & 0x10) !== 0) {
    if (tagEnd + 10 > bytes.byteLength || !hasAscii(bytes, tagEnd, '3DI')) return null;
    if (
      bytes[tagEnd + 3] !== bytes[3] ||
      bytes[tagEnd + 4] !== bytes[4] ||
      bytes[tagEnd + 5] !== bytes[5]
    ) {
      return null;
    }
    for (let offset = 6; offset < 10; offset += 1) {
      if (bytes[tagEnd + offset] !== bytes[offset]) return null;
    }
    audioOffset += 10;
  }
  return Number.isSafeInteger(audioOffset) && audioOffset < bytes.byteLength
    ? audioOffset
    : null;
}

function audioEndBeforeApeV2(
  bytes: Uint8Array,
  audioOffset: number,
  audioEnd: number,
  budget: StructureBudget,
): number | null {
  const footerStart = audioEnd - 32;
  if (footerStart < audioOffset || !hasAscii(bytes, footerStart, 'APETAGEX')) {
    return audioEnd;
  }
  const version = readUint32(bytes, footerStart + 8, true);
  const tagSize = readUint32(bytes, footerStart + 12, true);
  const itemCount = readUint32(bytes, footerStart + 16, true);
  const flags = readUint32(bytes, footerStart + 20, true);
  if (
    version !== 2_000 ||
    tagSize === null ||
    tagSize < 32 ||
    tagSize > audioEnd - audioOffset ||
    itemCount === null ||
    itemCount > MAX_SOURCE_AUDIO_STRUCTURE_ITEMS ||
    flags !== 0 ||
    !hasOnlyZeroBytes(bytes, footerStart + 24, audioEnd)
  ) {
    return null;
  }
  const tagStart = audioEnd - tagSize;
  let offset = tagStart;
  const keys = new Set<string>();
  for (let index = 0; index < itemCount; index += 1) {
    if (!consumeStructureItem(budget) || offset + 8 > footerStart) return null;
    const valueSize = readUint32(bytes, offset, true);
    const itemFlags = readUint32(bytes, offset + 4, true);
    if (valueSize === null || itemFlags === null || (itemFlags & ~1) !== 0) return null;
    const keyStart = offset + 8;
    const keyEnd = bytes.indexOf(0, keyStart);
    if (
      keyEnd < keyStart + 2 ||
      keyEnd >= footerStart ||
      keyEnd - keyStart > 255
    ) {
      return null;
    }
    for (let keyOffset = keyStart; keyOffset < keyEnd; keyOffset += 1) {
      const byte = bytes[keyOffset] ?? 0;
      if (byte < 0x20 || byte > 0x7e || byte === 0x3d) return null;
    }
    const key = asciiSlice(bytes, keyStart, keyEnd).toLowerCase();
    if (keys.has(key)) return null;
    keys.add(key);
    const valueEnd = keyEnd + 1 + valueSize;
    if (!Number.isSafeInteger(valueEnd) || valueEnd > footerStart) return null;
    offset = valueEnd;
  }
  return offset === footerStart ? tagStart : null;
}

const MPEG1_LAYER1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const MPEG1_LAYER2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const MPEG1_LAYER3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const MPEG2_LAYER2_OR_3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function mpegBitrateKbps(version: number, layer: number, index: number): number | null {
  if (index < 1 || index > 14) return null;
  if (version === 3 && layer === 3) return MPEG1_LAYER1[index] ?? null;
  if (version === 3 && layer === 2) return MPEG1_LAYER2[index] ?? null;
  if (version === 3 && layer === 1) return MPEG1_LAYER3[index] ?? null;
  if ((version === 0 || version === 2) && layer === 3) return MPEG2_LAYER1[index] ?? null;
  if ((version === 0 || version === 2) && (layer === 1 || layer === 2)) {
    return MPEG2_LAYER2_OR_3[index] ?? null;
  }
  return null;
}

type MpegFrameInfo = Readonly<{
  length: number;
  channelCount: number;
  sampleRate: number;
  samplesPerFrame: number;
  version: number;
  layer: number;
}>;

function mpegFrameInfo(bytes: Uint8Array, offset: number): MpegFrameInfo | null {
  const header = readUint32(bytes, offset, false);
  if (header === null || ((header & 0xffe0_0000) >>> 0) !== 0xffe0_0000) return null;
  const version = (header >>> 19) & 0x03;
  const layer = (header >>> 17) & 0x03;
  const bitrateIndex = (header >>> 12) & 0x0f;
  const sampleRateIndex = (header >>> 10) & 0x03;
  if (version === 1 || layer === 0 || sampleRateIndex === 3 || (header & 0x03) === 0x02) {
    return null;
  }
  const bitrateKbps = mpegBitrateKbps(version, layer, bitrateIndex);
  if (bitrateKbps === null) return null;
  const bitrate = bitrateKbps * 1_000;
  const sampleRate =
    version === 3
      ? [44_100, 48_000, 32_000][sampleRateIndex]
      : version === 2
        ? [22_050, 24_000, 16_000][sampleRateIndex]
        : [11_025, 12_000, 8_000][sampleRateIndex];
  if (!sampleRate) return null;
  const padding = (header >>> 9) & 1;
  const frameLength =
    layer === 3
      ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
      : layer === 2
        ? Math.floor((144 * bitrate) / sampleRate) + padding
        : Math.floor(((version === 3 ? 144 : 72) * bitrate) / sampleRate) + padding;
  if (!Number.isSafeInteger(frameLength) || frameLength < 4) return null;
  const channelMode = (header >>> 6) & 0x03;
  const samplesPerFrame =
    layer === 3 ? 384 : layer === 2 || version === 3 ? 1_152 : 576;
  return {
    length: frameLength,
    channelCount: channelMode === 3 ? 1 : 2,
    sampleRate,
    samplesPerFrame,
    version,
    layer,
  };
}

type DecodeFrameCandidate = Readonly<{
  start: number;
  end: number;
  durationMicroseconds: number;
}>;

type Mp3DecodeFrameCandidate = DecodeFrameCandidate & Readonly<{
  configuration: string;
}>;

function maximumNonOverlappingDurationSeconds(
  candidates: readonly DecodeFrameCandidate[],
): number | null {
  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort(
    (left, right) => left.end - right.end || left.start - right.start,
  );
  const ends = ordered.map((candidate) => candidate.end);
  const maximumMicroseconds = new Array<number>(ordered.length + 1).fill(0);
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    if (!candidate) return null;
    let low = 0;
    let high = index;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((ends[middle - 1] ?? Number.MAX_SAFE_INTEGER) <= candidate.start) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    const withCandidate =
      (maximumMicroseconds[low] ?? 0) + candidate.durationMicroseconds;
    const withoutCandidate = maximumMicroseconds[index] ?? 0;
    maximumMicroseconds[index + 1] = Math.max(withoutCandidate, withCandidate);
  }
  const total = maximumMicroseconds[ordered.length] ?? 0;
  return Number.isSafeInteger(total) && total > 0 ? total / 1_000_000 : null;
}

function sourceMp3MediaInfo(bytes: Uint8Array): SourceAudioMediaInfo | null {
  const audioOffset = id3AudioOffset(bytes);
  if (audioOffset === null) return null;
  const hasId3v1 =
    bytes.byteLength - audioOffset >= 128 &&
    hasAscii(bytes, bytes.byteLength - 128, 'TAG');
  const budget: StructureBudget = { remaining: MAX_SOURCE_AUDIO_STRUCTURE_ITEMS };
  const beforeId3v1 = hasId3v1 ? bytes.byteLength - 128 : bytes.byteLength;
  const audioEnd = audioEndBeforeApeV2(bytes, audioOffset, beforeId3v1, budget);
  if (audioEnd === null) return null;
  if (audioOffset >= audioEnd) return null;
  let offset: number = audioOffset;
  let channelCount: number | null = null;
  let sampleRate: number | null = null;
  let hasFrame = false;
  let streamConfiguration: string | null = null;
  const primarySamplesByRate = new Map<number, number>();
  while (offset < audioEnd) {
    if (!consumeStructureItem(budget)) return null;
    const frame = mpegFrameInfo(bytes, offset);
    const configuration = frame
      ? `${frame.version}:${frame.layer}:${frame.sampleRate}:${frame.channelCount}`
      : null;
    if (
      !frame ||
      (channelCount !== null && frame.channelCount !== channelCount) ||
      (streamConfiguration !== null && configuration !== streamConfiguration)
    ) {
      return null;
    }
    const frameEnd = offset + frame.length;
    if (!Number.isSafeInteger(frameEnd) || frameEnd > audioEnd) return null;
    channelCount = frame.channelCount;
    sampleRate = frame.sampleRate;
    streamConfiguration = configuration;
    if (!addSampleCount(primarySamplesByRate, frame.sampleRate, frame.samplesPerFrame)) {
      return null;
    }
    hasFrame = true;
    offset = frameEnd;
  }

  // Chromium may resynchronize to a valid MPEG header embedded inside a forged
  // outer frame. Count every bounded candidate as a conservative decode upper bound.
  const rawCandidates: Mp3DecodeFrameCandidate[] = [];
  let decodeChannelCountUpperBound = 0;
  let candidateOffset = audioOffset;
  while (candidateOffset < audioEnd) {
    const found = bytes.indexOf(0xff, candidateOffset);
    if (found < 0 || found >= audioEnd) break;
    if (!consumeStructureItem(budget)) return null;
    const candidate = mpegFrameInfo(bytes, found);
    if (candidate) {
      const durationMicroseconds = durationUpperBoundMicroseconds(
        new Map([[candidate.sampleRate, candidate.samplesPerFrame]]),
      );
      if (durationMicroseconds === null) return null;
      rawCandidates.push({
        start: found,
        end: Math.min(audioEnd, found + candidate.length),
        durationMicroseconds,
        configuration: `${candidate.version}:${candidate.layer}:${candidate.sampleRate}:${candidate.channelCount}`,
      });
      decodeChannelCountUpperBound = Math.max(
        decodeChannelCountUpperBound,
        candidate.channelCount,
      );
    }
    candidateOffset = found + 1;
  }
  const containerDurationSeconds = durationUpperBoundSeconds(primarySamplesByRate);
  // A random payload byte sequence can resemble one MPEG header. Chromium only
  // gains meaningful extra decoded duration when it can resynchronize to a
  // consecutive, configuration-stable frame chain. Keep every canonical frame
  // through the container duration, and add only candidates with a matching
  // predecessor or successor. This still catches forged outer-frame lengths
  // without inflating normal MP3s by payload false positives.
  const configurationsByStart = new Map<number, Set<string>>();
  const configurationsByEnd = new Map<number, Set<string>>();
  for (const candidate of rawCandidates) {
    const starts = configurationsByStart.get(candidate.start) ?? new Set<string>();
    starts.add(candidate.configuration);
    configurationsByStart.set(candidate.start, starts);
    const ends = configurationsByEnd.get(candidate.end) ?? new Set<string>();
    ends.add(candidate.configuration);
    configurationsByEnd.set(candidate.end, ends);
  }
  const chainedCandidates = rawCandidates.filter(
    (candidate) =>
      configurationsByEnd.get(candidate.start)?.has(candidate.configuration) === true ||
      configurationsByStart.get(candidate.end)?.has(candidate.configuration) === true,
  );
  const candidateDurationSeconds =
    maximumNonOverlappingDurationSeconds(chainedCandidates);
  const decodeDurationSeconds =
    containerDurationSeconds === null
      ? null
      : Math.max(containerDurationSeconds, candidateDurationSeconds ?? 0);
  return hasFrame &&
    offset === audioEnd &&
    channelCount !== null &&
    sampleRate !== null &&
    decodeChannelCountUpperBound > 0 &&
    containerDurationSeconds !== null &&
    decodeDurationSeconds !== null
    ? {
        sampleRate,
        channelCount,
        decodeChannelCountUpperBound,
        containerDurationSeconds,
        decodeDurationSeconds,
      }
    : null;
}

const AAC_SAMPLE_RATES = [
  96_000,
  88_200,
  64_000,
  48_000,
  44_100,
  32_000,
  24_000,
  22_050,
  16_000,
  12_000,
  11_025,
  8_000,
  7_350,
] as const;

type AacFrameInfo = Readonly<{
  length: number;
  sampleRate: number;
  channelCount: number | null;
  decodeChannelCountUpperBound: number;
  profile: number;
  rawDataBlocks: number;
}>;

function aacFrameInfo(bytes: Uint8Array, offset: number): AacFrameInfo | null {
  if (offset < 0 || offset + 7 > bytes.byteLength) return null;
  const first = bytes[offset] ?? 0;
  const second = bytes[offset + 1] ?? 0;
  if (first !== 0xff || (second & 0xf6) !== 0xf0) return null;
  const sampleRateIndex = ((bytes[offset + 2] ?? 0) >>> 2) & 0x0f;
  const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex];
  if (!sampleRate) return null;
  const profile = ((bytes[offset + 2] ?? 0) >>> 6) & 0x03;
  const channelConfiguration =
    (((bytes[offset + 2] ?? 0) & 0x01) << 2) |
    (((bytes[offset + 3] ?? 0) >>> 6) & 0x03);
  const configuredChannels = [0, 1, 2, 3, 4, 5, 6, 8][channelConfiguration];
  if (configuredChannels === undefined) return null;
  const headerLength = (second & 1) === 0 ? 9 : 7;
  const frameLength =
    (((bytes[offset + 3] ?? 0) & 0x03) << 11) |
    ((bytes[offset + 4] ?? 0) << 3) |
    ((bytes[offset + 5] ?? 0) >>> 5);
  if (frameLength <= headerLength) return null;
  return {
    length: frameLength,
    sampleRate,
    channelCount: configuredChannels > 0 ? configuredChannels : null,
    decodeChannelCountUpperBound: configuredChannels > 0 ? configuredChannels : 32,
    profile,
    rawDataBlocks: ((bytes[offset + 6] ?? 0) & 0x03) + 1,
  };
}

function sourceAacMediaInfo(bytes: Uint8Array): SourceAudioMediaInfo | null {
  let offset = 0;
  let hasFrame = false;
  let channelCount: number | null = null;
  let sampleRate: number | null = null;
  let streamConfiguration: string | null = null;
  const primarySamplesByRate = new Map<number, number>();
  const budget: StructureBudget = { remaining: MAX_SOURCE_AUDIO_STRUCTURE_ITEMS };
  while (offset < bytes.byteLength) {
    if (!consumeStructureItem(budget)) return null;
    const frame = aacFrameInfo(bytes, offset);
    const configuration = frame
      ? `${frame.profile}:${frame.sampleRate}:${frame.channelCount ?? 'pce'}`
      : null;
    if (
      !frame ||
      frame.channelCount === null ||
      (channelCount !== null && frame.channelCount !== channelCount) ||
      (streamConfiguration !== null && configuration !== streamConfiguration)
    ) {
      return null;
    }
    const frameEnd = offset + frame.length;
    if (!Number.isSafeInteger(frameEnd) || frameEnd > bytes.byteLength) return null;
    offset = frameEnd;
    channelCount = frame.channelCount;
    sampleRate = frame.sampleRate;
    streamConfiguration = configuration;
    if (
      !addSampleCount(
        primarySamplesByRate,
        frame.sampleRate,
        frame.rawDataBlocks * 1_024,
      )
    ) {
      return null;
    }
    hasFrame = true;
  }

  const candidateSamplesByRate = new Map<number, number>();
  let decodeChannelCountUpperBound = 0;
  let candidateOffset = 0;
  while (candidateOffset < bytes.byteLength) {
    const found = bytes.indexOf(0xff, candidateOffset);
    if (found < 0) break;
    if (!consumeStructureItem(budget)) return null;
    const candidate = aacFrameInfo(bytes, found);
    const candidateConfiguration = candidate
      ? `${candidate.profile}:${candidate.sampleRate}:${candidate.channelCount ?? 'pce'}`
      : null;
    if (
      candidate &&
      candidate.channelCount !== null &&
      candidateConfiguration === streamConfiguration
    ) {
      if (
        !addSampleCount(
          candidateSamplesByRate,
          candidate.sampleRate,
          candidate.rawDataBlocks * 1_024,
        )
      ) {
        return null;
      }
      decodeChannelCountUpperBound = Math.max(
        decodeChannelCountUpperBound,
        candidate.decodeChannelCountUpperBound,
      );
    }
    candidateOffset = found + 1;
  }
  const containerDurationSeconds = durationUpperBoundSeconds(primarySamplesByRate);
  const decodeDurationSeconds = durationUpperBoundSeconds(candidateSamplesByRate);
  return hasFrame &&
    offset === bytes.byteLength &&
    channelCount !== null &&
    sampleRate !== null &&
    decodeChannelCountUpperBound > 0 &&
    containerDurationSeconds !== null &&
    decodeDurationSeconds !== null
    ? {
        sampleRate,
        channelCount,
        decodeChannelCountUpperBound,
        containerDurationSeconds,
        decodeDurationSeconds,
      }
    : null;
}

type IsoBox = Readonly<{
  kind: string;
  payloadStart: number;
  end: number;
}>;

function readUint64Safe(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 8 > bytes.byteLength) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  const value = view.getBigUint64(0, false);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function nextIsoBox(bytes: Uint8Array, offset: number, limit: number): IsoBox | null {
  if (limit > bytes.byteLength || offset + 8 > limit) return null;
  const size32 = readUint32(bytes, offset, false);
  if (size32 === null) return null;
  const kind = String.fromCharCode(
    bytes[offset + 4] ?? 0,
    bytes[offset + 5] ?? 0,
    bytes[offset + 6] ?? 0,
    bytes[offset + 7] ?? 0,
  );
  let headerSize = 8;
  let boxSize = size32;
  if (size32 === 0) boxSize = limit - offset;
  if (size32 === 1) {
    headerSize = 16;
    const extended = readUint64Safe(bytes, offset + 8);
    if (extended === null) return null;
    boxSize = extended;
  }
  if (boxSize < headerSize) return null;
  const end = offset + boxSize;
  if (!Number.isSafeInteger(end) || end > limit) return null;
  return { kind, payloadStart: offset + headerSize, end };
}

const SUPPORTED_M4A_BRANDS = new Set(['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42', 'qt  ']);
const SUPPORTED_M4A_SAMPLE_BIT_DEPTH_TAGS = new Set([
  'I8',
  'I16',
  'I24',
  'I32',
  'F32',
  'F64',
]);

function asciiSlice(bytes: Uint8Array, start: number, end: number): string {
  let result = '';
  for (let offset = start; offset < end; offset += 1) {
    result += String.fromCharCode(bytes[offset] ?? 0);
  }
  return result;
}

function hasOnlyZeroBytes(bytes: Uint8Array, start: number, end: number): boolean {
  if (start < 0 || end < start || end > bytes.byteLength) return false;
  for (let offset = start; offset < end; offset += 1) {
    if (bytes[offset] !== 0) return false;
  }
  return true;
}

function validM4aFtyp(
  bytes: Uint8Array,
  box: IsoBox,
  budget: StructureBudget,
): boolean {
  const payloadLength = box.end - box.payloadStart;
  if (payloadLength < 8 || (payloadLength - 8) % 4 !== 0) return false;
  if (SUPPORTED_M4A_BRANDS.has(asciiSlice(bytes, box.payloadStart, box.payloadStart + 4))) {
    return true;
  }
  for (let offset = box.payloadStart + 8; offset < box.end; offset += 4) {
    if (!consumeStructureItem(budget)) return false;
    if (SUPPORTED_M4A_BRANDS.has(asciiSlice(bytes, offset, offset + 4))) return true;
  }
  return false;
}

type M4aMediaInfo = Readonly<{
  handler: 'soun' | 'vide';
  sampleRate: number | null;
  channelCount: number | null;
  decodeChannelCountUpperBound: number | null;
  containerDurationSeconds: number | null;
  decodeDurationSeconds: number | null;
  sampleLayout: M4aSampleLayout | null;
}>;

type M4aMediaHeader = Readonly<{
  timescale: number;
  durationUnits: number;
}>;

type M4aSampleTableInfo = Readonly<{
  channelCount: number;
  sampleRate: number;
  durationUnits: number;
  sampleCount: number;
  sampleSizes: M4aSampleSizes;
  chunkOffsets: readonly number[];
  sampleToChunk: readonly M4aSampleToChunkEntry[];
}>;

type M4aTimeToSampleInfo = Readonly<{
  sampleCount: number;
  durationUnits: number;
}>;

type M4aSampleSizes = Readonly<{
  sampleCount: number;
  fixedSize: number | null;
  sizes: readonly number[] | null;
}>;

type M4aSampleToChunkEntry = Readonly<{
  firstChunk: number;
  samplesPerChunk: number;
}>;

type M4aSampleLayout = Readonly<{
  sampleSizes: M4aSampleSizes;
  chunkOffsets: readonly number[];
  sampleToChunk: readonly M4aSampleToChunkEntry[];
}>;

type Mpeg4Descriptor = Readonly<{
  tag: number;
  payloadStart: number;
  end: number;
}>;

function nextMpeg4Descriptor(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  budget: StructureBudget,
): Mpeg4Descriptor | null {
  if (!consumeStructureItem(budget) || offset < 0 || offset + 2 > limit) return null;
  const tag = bytes[offset];
  if (tag === undefined) return null;
  let cursor = offset + 1;
  let size = 0;
  let complete = false;
  for (let index = 0; index < 4; index += 1) {
    const byte = bytes[cursor];
    if (byte === undefined || cursor >= limit) return null;
    cursor += 1;
    size = size * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(size)) return null;
    if ((byte & 0x80) === 0) {
      complete = true;
      break;
    }
  }
  if (!complete) return null;
  const end = cursor + size;
  return Number.isSafeInteger(end) && end <= limit
    ? { tag, payloadStart: cursor, end }
    : null;
}

function readBits(
  bytes: Uint8Array,
  start: number,
  end: number,
  bitOffset: number,
  bitCount: number,
): number | null {
  if (bitCount <= 0 || bitCount > 24 || bitOffset < 0) return null;
  let value = 0;
  for (let index = 0; index < bitCount; index += 1) {
    const absolute = bitOffset + index;
    const byteOffset = start + Math.floor(absolute / 8);
    if (byteOffset >= end) return null;
    const byte = bytes[byteOffset];
    if (byte === undefined) return null;
    value = value * 2 + ((byte >>> (7 - (absolute % 8))) & 1);
  }
  return value;
}

function inspectAacAudioSpecificConfig(
  bytes: Uint8Array,
  start: number,
  end: number,
): Readonly<{ sampleRate: number; channelCount: number }> | null {
  const audioObjectType = readBits(bytes, start, end, 0, 5);
  const frequencyIndex = readBits(bytes, start, end, 5, 4);
  if (audioObjectType !== 2 || frequencyIndex === null) return null;
  let bitOffset = 9;
  let sampleRate: number | undefined;
  if (frequencyIndex === 15) {
    return null;
  } else {
    sampleRate = AAC_SAMPLE_RATES[frequencyIndex];
  }
  const channelConfiguration = readBits(bytes, start, end, bitOffset, 4);
  const channelCount =
    channelConfiguration === null
      ? 0
      : ([0, 1, 2, 3, 4, 5, 6, 8][channelConfiguration] ?? 0);
  bitOffset += 4;
  const frameLengthFlag = readBits(bytes, start, end, bitOffset, 1);
  const dependsOnCoreCoder = readBits(bytes, start, end, bitOffset + 1, 1);
  const extensionFlag = readBits(bytes, start, end, bitOffset + 2, 1);
  if (
    !sampleRate ||
    channelCount <= 0 ||
    frameLengthFlag !== 0 ||
    dependsOnCoreCoder !== 0 ||
    extensionFlag !== 0
  ) {
    return null;
  }
  let trailingBit = bitOffset + 3;
  const totalBits = (end - start) * 8;
  if (totalBits - trailingBit >= 17) {
    const syncExtensionType = readBits(bytes, start, end, trailingBit, 11);
    const extensionAudioObjectType = readBits(bytes, start, end, trailingBit + 11, 5);
    const sbrPresentFlag = readBits(bytes, start, end, trailingBit + 16, 1);
    // FFmpeg writes an explicit "SBR absent" sync extension for ordinary AAC-LC.
    if (
      syncExtensionType !== 0x2b7 ||
      extensionAudioObjectType !== 5 ||
      sbrPresentFlag !== 0
    ) {
      return null;
    }
    trailingBit += 17;
  }
  for (; trailingBit < totalBits; trailingBit += 1) {
    if (readBits(bytes, start, end, trailingBit, 1) !== 0) return null;
  }
  return { sampleRate, channelCount };
}

function inspectM4aEsds(
  bytes: Uint8Array,
  box: IsoBox,
  budget: StructureBudget,
): Readonly<{ sampleRate: number; channelCount: number }> | null {
  if (
    box.end - box.payloadStart < 4 ||
    bytes[box.payloadStart] !== 0 ||
    bytes[box.payloadStart + 1] !== 0 ||
    bytes[box.payloadStart + 2] !== 0 ||
    bytes[box.payloadStart + 3] !== 0
  ) {
    return null;
  }
  const es = nextMpeg4Descriptor(bytes, box.payloadStart + 4, box.end, budget);
  if (!es || es.tag !== 0x03 || es.end !== box.end || es.payloadStart + 3 > es.end) {
    return null;
  }
  let cursor = es.payloadStart + 2;
  const flags = bytes[cursor];
  if (flags === undefined) return null;
  cursor += 1;
  if ((flags & 0x80) !== 0) cursor += 2;
  if ((flags & 0x40) !== 0) {
    const urlLength = bytes[cursor];
    if (urlLength === undefined) return null;
    cursor += 1 + urlLength;
  }
  if ((flags & 0x20) !== 0) cursor += 2;
  if (cursor > es.end) return null;

  const decoder = nextMpeg4Descriptor(bytes, cursor, es.end, budget);
  if (!decoder || decoder.tag !== 0x04 || decoder.payloadStart + 13 > decoder.end) {
    return null;
  }
  const objectType = bytes[decoder.payloadStart];
  const streamType = bytes[decoder.payloadStart + 1];
  if (objectType !== 0x40 || streamType === undefined || ((streamType >>> 2) & 0x3f) !== 5) {
    return null;
  }
  const specific = nextMpeg4Descriptor(
    bytes,
    decoder.payloadStart + 13,
    decoder.end,
    budget,
  );
  if (!specific || specific.tag !== 0x05 || specific.end !== decoder.end) return null;
  const audioConfig = inspectAacAudioSpecificConfig(
    bytes,
    specific.payloadStart,
    specific.end,
  );
  if (!audioConfig) return null;

  const sl = nextMpeg4Descriptor(bytes, decoder.end, es.end, budget);
  if (!sl || sl.tag !== 0x06 || sl.end !== es.end) return null;
  return audioConfig;
}

function inspectM4aMediaHeader(bytes: Uint8Array, box: IsoBox): M4aMediaHeader | null {
  const payloadLength = box.end - box.payloadStart;
  const version = bytes[box.payloadStart];
  if (
    (version !== 0 && version !== 1) ||
    bytes[box.payloadStart + 1] !== 0 ||
    bytes[box.payloadStart + 2] !== 0 ||
    bytes[box.payloadStart + 3] !== 0 ||
    payloadLength !== (version === 0 ? 24 : 36)
  ) {
    return null;
  }
  const timescaleOffset = box.payloadStart + (version === 0 ? 12 : 20);
  const durationOffset = box.payloadStart + (version === 0 ? 16 : 24);
  const timescale = readUint32(bytes, timescaleOffset, false);
  const durationUnits =
    version === 0
      ? readUint32(bytes, durationOffset, false)
      : readUint64Safe(bytes, durationOffset);
  if (
    timescale === null ||
    timescale <= 0 ||
    durationUnits === null ||
    durationUnits <= 0 ||
    (version === 0 && durationUnits === 0xffff_ffff)
  ) {
    return null;
  }
  return { timescale, durationUnits };
}

function inspectM4aTimeToSample(
  bytes: Uint8Array,
  box: IsoBox,
  budget: StructureBudget,
): M4aTimeToSampleInfo | null {
  if (
    box.end - box.payloadStart < 8 ||
    bytes[box.payloadStart] !== 0 ||
    bytes[box.payloadStart + 1] !== 0 ||
    bytes[box.payloadStart + 2] !== 0 ||
    bytes[box.payloadStart + 3] !== 0
  ) {
    return null;
  }
  const entryCount = readUint32(bytes, box.payloadStart + 4, false);
  if (entryCount === null || entryCount <= 0) return null;
  const entriesBytes = entryCount * 8;
  const expectedEnd = box.payloadStart + 8 + entriesBytes;
  if (!Number.isSafeInteger(entriesBytes) || expectedEnd !== box.end) return null;
  let offset = box.payloadStart + 8;
  let totalSamples = 0;
  let durationUnits = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (!consumeStructureItem(budget)) return null;
    const sampleCount = readUint32(bytes, offset, false);
    const sampleDelta = readUint32(bytes, offset + 4, false);
    if (
      sampleCount === null ||
      sampleCount <= 0 ||
      sampleDelta === null ||
      sampleDelta <= 0 ||
      sampleDelta > 1_024 ||
      (index < entryCount - 1 && sampleDelta !== 1_024) ||
      (index === entryCount - 1 && sampleDelta < 1_024 && sampleCount !== 1) ||
      sampleCount > Number.MAX_SAFE_INTEGER - totalSamples ||
      sampleCount > Math.floor((Number.MAX_SAFE_INTEGER - durationUnits) / sampleDelta)
    ) {
      return null;
    }
    totalSamples += sampleCount;
    durationUnits += sampleCount * sampleDelta;
    offset += 8;
  }
  return offset === box.end && totalSamples > 0 && durationUnits > 0
    ? { sampleCount: totalSamples, durationUnits }
    : null;
}

function inspectAudioSampleDescriptions(
  bytes: Uint8Array,
  box: IsoBox,
  budget: StructureBudget,
): Readonly<{ channelCount: number; sampleRate: number }> | null {
  if (
    box.end - box.payloadStart < 8 ||
    bytes[box.payloadStart] !== 0 ||
    bytes[box.payloadStart + 1] !== 0 ||
    bytes[box.payloadStart + 2] !== 0 ||
    bytes[box.payloadStart + 3] !== 0
  ) {
    return null;
  }
  const entryCount = readUint32(bytes, box.payloadStart + 4, false);
  if (entryCount !== 1) return null;
  let offset = box.payloadStart + 8;
  if (!consumeStructureItem(budget)) return null;
  const entry = nextIsoBox(bytes, offset, box.end);
  if (!entry || entry.kind !== 'mp4a' || entry.end - entry.payloadStart < 28) return null;
  const version = readUint16(bytes, entry.payloadStart + 8, false);
  const dataReferenceIndex = readUint16(bytes, entry.payloadStart + 6, false);
  const channelCount = readUint16(bytes, entry.payloadStart + 16, false);
  const sampleSize = readUint16(bytes, entry.payloadStart + 18, false);
  const fixedSampleRate = readUint32(bytes, entry.payloadStart + 24, false);
  if (
    !hasOnlyZeroBytes(bytes, entry.payloadStart, entry.payloadStart + 6) ||
    dataReferenceIndex !== 1 ||
    version !== 0 ||
    !hasOnlyZeroBytes(bytes, entry.payloadStart + 10, entry.payloadStart + 16) ||
    channelCount === null ||
    channelCount <= 0 ||
    sampleSize !== 16 ||
    !hasOnlyZeroBytes(bytes, entry.payloadStart + 20, entry.payloadStart + 24) ||
    fixedSampleRate === null ||
    (fixedSampleRate & 0xffff) !== 0
  ) {
    return null;
  }
  const sampleRate = fixedSampleRate >>> 16;
  if (sampleRate <= 0) return null;
  offset = entry.payloadStart + 28;
  let codecConfig: Readonly<{ sampleRate: number; channelCount: number }> | null = null;
  while (offset < entry.end) {
    if (!consumeStructureItem(budget)) return null;
    const child = nextIsoBox(bytes, offset, entry.end);
    if (!child) return null;
    if (child.kind === 'esds') {
      if (codecConfig !== null) return null;
      codecConfig = inspectM4aEsds(bytes, child, budget);
      if (codecConfig === null) return null;
    } else if (child.kind === 'btrt') {
      if (child.end - child.payloadStart !== 12) return null;
    } else if (child.kind === 'sbtd') {
      if (
        child.end - child.payloadStart < 6 ||
        child.end - child.payloadStart > 7 ||
        !hasOnlyZeroBytes(bytes, child.payloadStart, child.payloadStart + 4) ||
        !SUPPORTED_M4A_SAMPLE_BIT_DEPTH_TAGS.has(
          asciiSlice(bytes, child.payloadStart + 4, child.end),
        )
      ) {
        return null;
      }
    } else {
      return null;
    }
    offset = child.end;
  }
  return offset === entry.end &&
    entry.end === box.end &&
    codecConfig !== null &&
    (codecConfig.sampleRate === sampleRate ||
      (codecConfig.sampleRate > 65_535 && codecConfig.sampleRate === sampleRate * 2)) &&
    codecConfig.channelCount === channelCount
    ? { channelCount, sampleRate: codecConfig.sampleRate }
    : null;
}

function hasZeroFullBoxHeader(bytes: Uint8Array, box: IsoBox): boolean {
  return (
    box.end - box.payloadStart >= 4 &&
    bytes[box.payloadStart] === 0 &&
    bytes[box.payloadStart + 1] === 0 &&
    bytes[box.payloadStart + 2] === 0 &&
    bytes[box.payloadStart + 3] === 0
  );
}

function inspectM4aSampleSizes(
  bytes: Uint8Array,
  box: IsoBox,
  budget: StructureBudget,
): M4aSampleSizes | null {
  if (!hasZeroFullBoxHeader(bytes, box) || box.end - box.payloadStart < 12) return null;
  const fixedSize = readUint32(bytes, box.payloadStart + 4, false);
  const sampleCount = readUint32(bytes, box.payloadStart + 8, false);
  if (
    fixedSize === null ||
    sampleCount === null ||
    sampleCount <= 0 ||
    sampleCount > MAX_SOURCE_AUDIO_STRUCTURE_ITEMS
  ) {
    return null;
  }
  if (fixedSize > 0) {
    return box.payloadStart + 12 === box.end
      ? { sampleCount, fixedSize, sizes: null }
      : null;
  }
  const sizesBytes = sampleCount * 4;
  if (
    !Number.isSafeInteger(sizesBytes) ||
    box.payloadStart + 12 + sizesBytes !== box.end
  ) {
    return null;
  }
  const sizes: number[] = [];
  let offset = box.payloadStart + 12;
  for (let index = 0; index < sampleCount; index += 1) {
    if (!consumeStructureItem(budget)) return null;
    const size = readUint32(bytes, offset, false);
    if (size === null || size <= 0) return null;
    sizes.push(size);
    offset += 4;
  }
  return offset === box.end ? { sampleCount, fixedSize: null, sizes } : null;
}

function inspectM4aCompactSampleSizes(
  bytes: Uint8Array,
  box: IsoBox,
  budget: StructureBudget,
): M4aSampleSizes | null {
  if (!hasZeroFullBoxHeader(bytes, box) || box.end - box.payloadStart < 12) return null;
  const fieldSize = bytes[box.payloadStart + 7];
  const sampleCount = readUint32(bytes, box.payloadStart + 8, false);
  if (
    (fieldSize !== 4 && fieldSize !== 8 && fieldSize !== 16) ||
    sampleCount === null ||
    sampleCount <= 0 ||
    sampleCount > MAX_SOURCE_AUDIO_STRUCTURE_ITEMS
  ) {
    return null;
  }
  const sizeBytes = Math.ceil((sampleCount * fieldSize) / 8);
  if (!Number.isSafeInteger(sizeBytes) || box.payloadStart + 12 + sizeBytes !== box.end) {
    return null;
  }
  const sizes: number[] = [];
  const start = box.payloadStart + 12;
  for (let index = 0; index < sampleCount; index += 1) {
    if (!consumeStructureItem(budget)) return null;
    let size: number;
    if (fieldSize === 4) {
      const packed = bytes[start + Math.floor(index / 2)];
      if (packed === undefined) return null;
      size = index % 2 === 0 ? packed >>> 4 : packed & 0x0f;
    } else if (fieldSize === 8) {
      const byte = bytes[start + index];
      if (byte === undefined) return null;
      size = byte;
    } else {
      const value = readUint16(bytes, start + index * 2, false);
      if (value === null) return null;
      size = value;
    }
    if (size <= 0) return null;
    sizes.push(size);
  }
  return { sampleCount, fixedSize: null, sizes };
}

function inspectM4aSampleToChunk(
  bytes: Uint8Array,
  box: IsoBox,
  budget: StructureBudget,
): readonly M4aSampleToChunkEntry[] | null {
  if (!hasZeroFullBoxHeader(bytes, box) || box.end - box.payloadStart < 8) return null;
  const entryCount = readUint32(bytes, box.payloadStart + 4, false);
  if (
    entryCount === null ||
    entryCount <= 0 ||
    entryCount > MAX_SOURCE_AUDIO_STRUCTURE_ITEMS ||
    box.payloadStart + 8 + entryCount * 12 !== box.end
  ) {
    return null;
  }
  const entries: M4aSampleToChunkEntry[] = [];
  let offset = box.payloadStart + 8;
  let previousFirstChunk = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (!consumeStructureItem(budget)) return null;
    const firstChunk = readUint32(bytes, offset, false);
    const samplesPerChunk = readUint32(bytes, offset + 4, false);
    const sampleDescriptionIndex = readUint32(bytes, offset + 8, false);
    if (
      firstChunk === null ||
      firstChunk <= previousFirstChunk ||
      (index === 0 && firstChunk !== 1) ||
      samplesPerChunk === null ||
      samplesPerChunk <= 0 ||
      sampleDescriptionIndex !== 1
    ) {
      return null;
    }
    entries.push({ firstChunk, samplesPerChunk });
    previousFirstChunk = firstChunk;
    offset += 12;
  }
  return entries;
}

function inspectM4aChunkOffsets(
  bytes: Uint8Array,
  box: IsoBox,
  budget: StructureBudget,
): readonly number[] | null {
  if (!hasZeroFullBoxHeader(bytes, box) || box.end - box.payloadStart < 8) return null;
  const entryCount = readUint32(bytes, box.payloadStart + 4, false);
  const width = box.kind === 'co64' ? 8 : 4;
  if (
    entryCount === null ||
    entryCount <= 0 ||
    entryCount > MAX_SOURCE_AUDIO_STRUCTURE_ITEMS ||
    box.payloadStart + 8 + entryCount * width !== box.end
  ) {
    return null;
  }
  const offsets: number[] = [];
  let offset = box.payloadStart + 8;
  let previous = -1;
  for (let index = 0; index < entryCount; index += 1) {
    if (!consumeStructureItem(budget)) return null;
    const value =
      width === 8
        ? readUint64Safe(bytes, offset)
        : readUint32(bytes, offset, false);
    if (value === null || value <= previous) return null;
    offsets.push(value);
    previous = value;
    offset += width;
  }
  return offsets;
}

function sampleCountFromChunkTable(
  entries: readonly M4aSampleToChunkEntry[],
  chunkCount: number,
): number | null {
  if (entries.length === 0 || chunkCount <= 0) return null;
  let total = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const next = entries[index + 1];
    if (!entry || entry.firstChunk > chunkCount) return null;
    const endChunk = next?.firstChunk ?? chunkCount + 1;
    const runChunks = endChunk - entry.firstChunk;
    if (
      runChunks <= 0 ||
      entry.samplesPerChunk > Math.floor((Number.MAX_SAFE_INTEGER - total) / runChunks)
    ) {
      return null;
    }
    total += runChunks * entry.samplesPerChunk;
  }
  return total > 0 ? total : null;
}

function inspectSampleTable(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: StructureBudget,
): M4aSampleTableInfo | null {
  let offset = start;
  let sampleDescription: Readonly<{ channelCount: number; sampleRate: number }> | null = null;
  let timeToSample: M4aTimeToSampleInfo | null = null;
  let sampleSizes: M4aSampleSizes | null = null;
  let sampleToChunk: readonly M4aSampleToChunkEntry[] | null = null;
  let chunkOffsets: readonly number[] | null = null;
  while (offset < end) {
    if (!consumeStructureItem(budget)) return null;
    const box = nextIsoBox(bytes, offset, end);
    if (!box) return null;
    if (box.kind === 'stsd') {
      if (sampleDescription !== null) return null;
      sampleDescription = inspectAudioSampleDescriptions(bytes, box, budget);
      if (sampleDescription === null) return null;
    } else if (box.kind === 'stts') {
      if (timeToSample !== null) return null;
      timeToSample = inspectM4aTimeToSample(bytes, box, budget);
      if (timeToSample === null) return null;
    } else if (box.kind === 'stsz' || box.kind === 'stz2') {
      if (sampleSizes !== null) return null;
      sampleSizes =
        box.kind === 'stsz'
          ? inspectM4aSampleSizes(bytes, box, budget)
          : inspectM4aCompactSampleSizes(bytes, box, budget);
      if (sampleSizes === null) return null;
    } else if (box.kind === 'stsc') {
      if (sampleToChunk !== null) return null;
      sampleToChunk = inspectM4aSampleToChunk(bytes, box, budget);
      if (sampleToChunk === null) return null;
    } else if (box.kind === 'stco' || box.kind === 'co64') {
      if (chunkOffsets !== null) return null;
      chunkOffsets = inspectM4aChunkOffsets(bytes, box, budget);
      if (chunkOffsets === null) return null;
    }
    offset = box.end;
  }
  if (
    offset !== end ||
    sampleDescription === null ||
    timeToSample === null ||
    sampleSizes === null ||
    sampleToChunk === null ||
    chunkOffsets === null ||
    timeToSample.sampleCount !== sampleSizes.sampleCount ||
    sampleCountFromChunkTable(sampleToChunk, chunkOffsets.length) !== sampleSizes.sampleCount
  ) {
    return null;
  }
  return {
    channelCount: sampleDescription.channelCount,
    sampleRate: sampleDescription.sampleRate,
    durationUnits: timeToSample.durationUnits,
    sampleCount: sampleSizes.sampleCount,
    sampleSizes,
    chunkOffsets,
    sampleToChunk,
  };
}

function inspectM4aDataInformation(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: StructureBudget,
): boolean {
  let offset = start;
  let hasDataReference = false;
  while (offset < end) {
    if (!consumeStructureItem(budget)) return false;
    const box = nextIsoBox(bytes, offset, end);
    if (!box || box.kind !== 'dref' || hasDataReference) return false;
    if (!hasZeroFullBoxHeader(bytes, box) || box.end - box.payloadStart < 8) return false;
    const entryCount = readUint32(bytes, box.payloadStart + 4, false);
    if (entryCount !== 1 || !consumeStructureItem(budget)) return false;
    const entry = nextIsoBox(bytes, box.payloadStart + 8, box.end);
    if (
      !entry ||
      entry.kind !== 'url ' ||
      entry.end !== box.end ||
      entry.end - entry.payloadStart !== 4 ||
      bytes[entry.payloadStart] !== 0 ||
      bytes[entry.payloadStart + 1] !== 0 ||
      bytes[entry.payloadStart + 2] !== 0 ||
      bytes[entry.payloadStart + 3] !== 1
    ) {
      return false;
    }
    hasDataReference = true;
    offset = box.end;
  }
  return offset === end && hasDataReference;
}

function inspectMediaInformation(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: StructureBudget,
): M4aSampleTableInfo | null {
  let offset = start;
  let sampleTable: M4aSampleTableInfo | null = null;
  let hasSelfContainedDataReference = false;
  while (offset < end) {
    if (!consumeStructureItem(budget)) return null;
    const box = nextIsoBox(bytes, offset, end);
    if (!box) return null;
    if (box.kind === 'dinf') {
      if (
        hasSelfContainedDataReference ||
        !inspectM4aDataInformation(bytes, box.payloadStart, box.end, budget)
      ) {
        return null;
      }
      hasSelfContainedDataReference = true;
    } else if (box.kind === 'stbl') {
      if (sampleTable !== null) return null;
      sampleTable = inspectSampleTable(bytes, box.payloadStart, box.end, budget);
      if (sampleTable === null) return null;
    }
    offset = box.end;
  }
  return offset === end && hasSelfContainedDataReference ? sampleTable : null;
}

function inspectM4aMedia(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: StructureBudget,
): M4aMediaInfo | null {
  let offset = start;
  let handler: 'soun' | 'vide' | null = null;
  let mediaHeader: M4aMediaHeader | null = null;
  let sampleTable: M4aSampleTableInfo | null = null;
  while (offset < end) {
    if (!consumeStructureItem(budget)) return null;
    const box = nextIsoBox(bytes, offset, end);
    if (!box) return null;
    if (box.kind === 'mdhd') {
      if (mediaHeader !== null) return null;
      mediaHeader = inspectM4aMediaHeader(bytes, box);
      if (mediaHeader === null) return null;
    } else if (box.kind === 'hdlr') {
      if (handler !== null || box.end - box.payloadStart < 24) return null;
      const kind = asciiSlice(bytes, box.payloadStart + 8, box.payloadStart + 12);
      if (kind !== 'soun' && kind !== 'vide') return null;
      handler = kind;
    } else if (box.kind === 'minf') {
      if (sampleTable !== null) return null;
      sampleTable = inspectMediaInformation(bytes, box.payloadStart, box.end, budget);
      if (sampleTable === null) return null;
    }
    offset = box.end;
  }
  if (offset !== end || handler === null) return null;
  if (handler !== 'soun') {
    return {
      handler,
      sampleRate: null,
      channelCount: null,
      decodeChannelCountUpperBound: null,
      containerDurationSeconds: null,
      decodeDurationSeconds: null,
      sampleLayout: null,
    };
  }
  if (
    mediaHeader === null ||
    sampleTable === null ||
    mediaHeader.timescale !== sampleTable.sampleRate ||
    mediaHeader.durationUnits !== sampleTable.durationUnits
  ) {
    return null;
  }
  if (sampleTable.sampleCount > Math.floor(Number.MAX_SAFE_INTEGER / 1_024)) {
    return null;
  }
  const containerDurationSeconds = durationUpperBoundSeconds(
    new Map([[mediaHeader.timescale, mediaHeader.durationUnits]]),
  );
  const decodeDurationSeconds = durationUpperBoundSeconds(
    new Map([[sampleTable.sampleRate, sampleTable.sampleCount * 1_024]]),
  );
  return containerDurationSeconds === null || decodeDurationSeconds === null
    ? null
    : {
        handler,
        sampleRate: sampleTable.sampleRate,
        channelCount: sampleTable.channelCount,
        decodeChannelCountUpperBound: sampleTable.channelCount,
        containerDurationSeconds,
        decodeDurationSeconds,
        sampleLayout: {
          sampleSizes: sampleTable.sampleSizes,
          chunkOffsets: sampleTable.chunkOffsets,
          sampleToChunk: sampleTable.sampleToChunk,
        },
      };
}

function inspectM4aTrack(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: StructureBudget,
): M4aMediaInfo | null {
  let offset = start;
  let media: M4aMediaInfo | null = null;
  while (offset < end) {
    if (!consumeStructureItem(budget)) return null;
    const box = nextIsoBox(bytes, offset, end);
    if (!box) return null;
    if (box.kind === 'mdia') {
      if (media !== null) return null;
      media = inspectM4aMedia(bytes, box.payloadStart, box.end, budget);
      if (!media) return null;
    }
    offset = box.end;
  }
  return offset === end ? media : null;
}

function inspectM4aMovie(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: StructureBudget,
): Readonly<{
  audioMediaInfo: SourceAudioMediaInfo | null;
  audioSampleLayout: M4aSampleLayout | null;
  hasVideo: boolean;
}> | null {
  let offset = start;
  let audioMediaInfo: SourceAudioMediaInfo | null = null;
  let audioSampleLayout: M4aSampleLayout | null = null;
  let hasVideo = false;
  while (offset < end) {
    if (!consumeStructureItem(budget)) return null;
    const box = nextIsoBox(bytes, offset, end);
    if (!box) return null;
    if (box.kind === 'mvex') {
      return null;
    }
    if (box.kind === 'trak') {
      const media = inspectM4aTrack(bytes, box.payloadStart, box.end, budget);
      if (!media) return null;
      if (media.handler === 'vide') {
        hasVideo = true;
      } else {
        if (
          audioMediaInfo !== null ||
          media.sampleRate === null ||
          media.channelCount === null ||
          media.decodeChannelCountUpperBound === null ||
          media.containerDurationSeconds === null ||
          media.decodeDurationSeconds === null ||
          media.sampleLayout === null
        ) {
          return null;
        }
        audioMediaInfo = {
          sampleRate: media.sampleRate,
          channelCount: media.channelCount,
          decodeChannelCountUpperBound: media.decodeChannelCountUpperBound,
          containerDurationSeconds: media.containerDurationSeconds,
          decodeDurationSeconds: media.decodeDurationSeconds,
        };
        audioSampleLayout = media.sampleLayout;
      }
    }
    offset = box.end;
  }
  return offset === end ? { audioMediaInfo, audioSampleLayout, hasVideo } : null;
}

function validateM4aSampleLayout(
  layout: M4aSampleLayout,
  mediaData: IsoBox,
): boolean {
  const { chunkOffsets, sampleSizes, sampleToChunk } = layout;
  if (chunkOffsets.length === 0 || sampleToChunk.length === 0) return false;
  let expectedOffset = mediaData.payloadStart;
  let sampleIndex = 0;
  let tableIndex = 0;
  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex += 1) {
    const oneBasedChunk = chunkIndex + 1;
    while (
      tableIndex + 1 < sampleToChunk.length &&
      (sampleToChunk[tableIndex + 1]?.firstChunk ?? Number.MAX_SAFE_INTEGER) <= oneBasedChunk
    ) {
      tableIndex += 1;
    }
    const mapping = sampleToChunk[tableIndex];
    const chunkOffset = chunkOffsets[chunkIndex];
    if (!mapping || chunkOffset !== expectedOffset) return false;
    for (let index = 0; index < mapping.samplesPerChunk; index += 1) {
      if (sampleIndex >= sampleSizes.sampleCount) return false;
      const sampleSize = sampleSizes.fixedSize ?? sampleSizes.sizes?.[sampleIndex];
      if (
        sampleSize === undefined ||
        sampleSize <= 0 ||
        sampleSize > Number.MAX_SAFE_INTEGER - expectedOffset
      ) {
        return false;
      }
      expectedOffset += sampleSize;
      if (expectedOffset > mediaData.end) return false;
      sampleIndex += 1;
    }
  }
  return sampleIndex === sampleSizes.sampleCount && expectedOffset === mediaData.end;
}

function sourceM4aMediaInfo(bytes: Uint8Array): SourceAudioMediaInfo | null {
  let offset = 0;
  let boxIndex = 0;
  let hasFtyp = false;
  let hasMovie = false;
  let audioMediaInfo: SourceAudioMediaInfo | null = null;
  let audioSampleLayout: M4aSampleLayout | null = null;
  let hasVideo = false;
  let mediaData: IsoBox | null = null;
  const budget: StructureBudget = { remaining: MAX_SOURCE_AUDIO_STRUCTURE_ITEMS };
  while (offset < bytes.byteLength) {
    if (!consumeStructureItem(budget)) return null;
    const box = nextIsoBox(bytes, offset, bytes.byteLength);
    if (!box || (boxIndex === 0 && box.kind !== 'ftyp')) return null;
    if (box.kind === 'ftyp') {
      if (hasFtyp || !validM4aFtyp(bytes, box, budget)) return null;
      hasFtyp = true;
    } else if (box.kind === 'moov') {
      if (hasMovie) return null;
      const inventory = inspectM4aMovie(bytes, box.payloadStart, box.end, budget);
      if (!inventory) return null;
      hasMovie = true;
      audioMediaInfo = inventory.audioMediaInfo;
      audioSampleLayout = inventory.audioSampleLayout;
      hasVideo = inventory.hasVideo;
    } else if (box.kind === 'mdat') {
      if (mediaData !== null || box.payloadStart >= box.end) return null;
      mediaData = box;
    } else if (box.kind === 'moof') {
      return null;
    }
    offset = box.end;
    boxIndex += 1;
  }
  return offset === bytes.byteLength &&
    hasFtyp &&
    hasMovie &&
    audioMediaInfo !== null &&
    audioSampleLayout !== null &&
    !hasVideo &&
    mediaData !== null &&
    validateM4aSampleLayout(audioSampleLayout, mediaData)
    ? audioMediaInfo
    : null;
}

function sourceMediaInfo(
  format: SourceAudioFormat,
  bytes: Uint8Array,
): SourceAudioMediaInfo | null {
  if (format === 'wav') return sourceWavMediaInfo(bytes);
  if (format === 'mp3') return sourceMp3MediaInfo(bytes);
  if (format === 'aac') return sourceAacMediaInfo(bytes);
  return sourceM4aMediaInfo(bytes);
}

/** Validate extension, size and matching container magic without decoding. */
export function inspectSourceAudioFile(
  fileName: string,
  bytes: Uint8Array,
  byteLength: number,
): SourceAudioDescriptor {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new SourceAudioFileError('invalid-file');
  }
  if (byteLength > MAX_SOURCE_AUDIO_FILE_BYTES) {
    throw new SourceAudioFileError('file-too-large');
  }
  if (
    fileName.length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    /[\u0000-\u001f\u007f/\\]/.test(fileName)
  ) {
    throw new SourceAudioFileError('invalid-filename');
  }
  const format = extensionFormat(fileName);
  if (!format) throw new SourceAudioFileError('invalid-filename');
  const mediaInfo =
    bytes.byteLength === byteLength ? sourceMediaInfo(format, bytes) : null;
  if (mediaInfo === null) {
    throw new SourceAudioFileError('invalid-file');
  }
  return { format, mimeType: SOURCE_AUDIO_MIME_TYPES[format], ...mediaInfo };
}

export function validateSourceAudioBlobSize(
  blobSize: number,
  declaredByteLength: number,
): void {
  if (
    !Number.isSafeInteger(blobSize) ||
    blobSize <= 0 ||
    !Number.isSafeInteger(declaredByteLength) ||
    declaredByteLength <= 0 ||
    blobSize !== declaredByteLength
  ) {
    throw new SourceAudioFileError('invalid-file');
  }
  if (declaredByteLength > MAX_SOURCE_AUDIO_FILE_BYTES) {
    throw new SourceAudioFileError('file-too-large');
  }
}

/** Enforce the byte limit before materializing a browser Blob as an ArrayBuffer. */
export async function inspectSourceAudioBlob(
  fileName: string,
  blob: Pick<Blob, 'size' | 'arrayBuffer'>,
  declaredByteLength = blob.size,
): Promise<SourceAudioDescriptor> {
  validateSourceAudioBlobSize(blob.size, declaredByteLength);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return inspectSourceAudioFile(fileName, bytes, declaredByteLength);
}

export function sourceAudioStem(fileName: string): string {
  const format = extensionFormat(fileName);
  return format ? fileName.slice(0, -SOURCE_AUDIO_EXTENSIONS[format].length) : fileName;
}
