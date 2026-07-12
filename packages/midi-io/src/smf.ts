/**
 * Low-level Standard MIDI File (SMF) writer primitives.
 * Format 1 (multi-track synchronous), no external dependencies.
 */

export const PPQ = 480;
export const MAX_MIDI_VAR_LEN = 0x0fff_ffff;

/**
 * Encode a non-negative integer as a MIDI variable-length quantity (VLQ).
 * Each byte uses 7 bits of data; the MSB of every byte except the last is 1.
 */
export function writeVarLen(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MIDI_VAR_LEN) {
    throw new RangeError(
      `writeVarLen: value must be a safe integer in 0..${MAX_MIDI_VAR_LEN}, got ${value}`,
    );
  }
  if (value === 0) return [0x00];

  const bytes: number[] = [];
  let v = value;
  while (v > 0) {
    bytes.unshift(v & 0x7f);
    v = v >>> 7;
  }
  // Set continuation bit on all but last byte
  for (let i = 0; i < bytes.length - 1; i++) {
    bytes[i] = (bytes[i] ?? 0) | 0x80;
  }
  return bytes;
}

/** A MIDI message with an absolute tick position. */
export type MidiMessage = {
  tick: number;
  bytes: number[];
};

/**
 * Build an MTrk chunk from a list of absolute-tick MIDI messages.
 * - Sorts by tick, with note-off before note-on at the same tick so repeated
 *   pitches are retriggered instead of immediately silenced.
 * - Converts to delta times.
 * - Appends end-of-track meta event (FF 2F 00).
 * - Wraps with "MTrk" + 4-byte big-endian length.
 */
export function buildTrackChunk(messages: MidiMessage[]): Uint8Array {
  const noteOrder = (message: MidiMessage): number => {
    const status = (message.bytes[0] ?? 0) & 0xf0;
    if (status === 0x80 || (status === 0x90 && message.bytes[2] === 0)) return 0;
    if (status === 0x90) return 2;
    return 1;
  };
  const sorted = [...messages].sort(
    (a, b) => a.tick - b.tick || noteOrder(a) - noteOrder(b),
  );

  const trackData: number[] = [];
  let prevTick = 0;

  for (const msg of sorted) {
    if (!Number.isSafeInteger(msg.tick) || msg.tick < prevTick || msg.tick > MAX_MIDI_VAR_LEN) {
      throw new RangeError(
        `buildTrackChunk: tick must be a safe integer in ${prevTick}..${MAX_MIDI_VAR_LEN}, got ${msg.tick}`,
      );
    }
    const delta = msg.tick - prevTick;
    for (const byte of writeVarLen(delta)) trackData.push(byte);
    for (const byte of msg.bytes) trackData.push(byte);
    prevTick = msg.tick;
  }

  // End-of-track meta event: delta=0, FF 2F 00
  trackData.push(0x00, 0xff, 0x2f, 0x00);

  // Build chunk: "MTrk" + 4-byte length + data
  const header = [
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (trackData.length >>> 24) & 0xff,
    (trackData.length >>> 16) & 0xff,
    (trackData.length >>> 8) & 0xff,
    trackData.length & 0xff,
  ];

  const result = new Uint8Array(header.length + trackData.length);
  result.set(header, 0);
  result.set(trackData, header.length);
  return result;
}

/**
 * Build an MThd chunk.
 * format: 0 = single track, 1 = multi-track synchronous, 2 = multi-track sequential.
 */
export function buildHeaderChunk(
  format: number,
  numTracks: number,
  ticksPerQuarter: number,
): Uint8Array {
  const data = new Uint8Array(14);
  const view = new DataView(data.buffer);

  // "MThd"
  data[0] = 0x4d; data[1] = 0x54; data[2] = 0x68; data[3] = 0x64;
  // Chunk length = 6
  view.setUint32(4, 6, false);
  // format
  view.setUint16(8, format, false);
  // number of tracks
  view.setUint16(10, numTracks, false);
  // division (ticks per quarter note)
  view.setUint16(12, ticksPerQuarter, false);

  return data;
}

/** Concatenate multiple Uint8Array chunks into one. */
export function concatChunks(...chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Human-readable note name for a MIDI pitch (e.g. 60 -> "C4").
 * Uses the common convention where MIDI note 60 is middle C ("C4").
 */
export function midiNoteName(pitch: number): string {
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) {
    throw new RangeError(`midiNoteName requires a MIDI pitch 0..127, got ${pitch}`);
  }
  const name = NOTE_NAMES[pitch % 12]!;
  const octave = Math.floor(pitch / 12) - 1;
  return `${name}${octave}`;
}
