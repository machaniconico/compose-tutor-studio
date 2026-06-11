/**
 * Standard MIDI File importer.
 *
 * Parses SMF format 0/1 bytes into beat-based note events and top-level tempo
 * / time-signature metadata. The parser is intentionally pure and dependency
 * free so UI code can decide how to map the result into a project.
 */

export type ParsedMidiNote = {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
  channel: number;
};

export type ParsedMidiTempo = {
  tick: number;
  beat: number;
  bpm: number;
  microsecondsPerQuarter: number;
};

export type ParsedMidiTimeSignature = {
  tick: number;
  beat: number;
  numerator: number;
  denominator: number;
};

export type ParsedMidiTrack = {
  index: number;
  name: string | null;
  notes: ParsedMidiNote[];
};

export type ParsedMidi = {
  format: 0 | 1;
  ppq: number;
  tracks: ParsedMidiTrack[];
  tempos: ParsedMidiTempo[];
  timeSignatures: ParsedMidiTimeSignature[];
  bpm: number;
  timeSignature: [number, number];
};

type Chunk = {
  id: string;
  start: number;
  end: number;
};

type ActiveNote = {
  tick: number;
  velocity: number;
};

const DEFAULT_BPM = 120;
const DEFAULT_TIME_SIGNATURE: [number, number] = [4, 4];

/** Parse a Standard MIDI File (format 0 or 1) into beat-based notes. */
export function parseMidi(bytes: Uint8Array): ParsedMidi {
  const reader = new ByteReader(bytes);
  const header = reader.readChunk();
  if (!header || header.id !== 'MThd') {
    throw new Error('MIDIヘッダーが見つかりません。Standard MIDI Fileを選んでください。');
  }
  if (header.end - header.start < 6) {
    throw new Error('MIDIヘッダーが短すぎます。ファイルが壊れている可能性があります。');
  }

  const formatValue = reader.u16At(header.start);
  if (formatValue !== 0 && formatValue !== 1) {
    throw new Error('対応しているMIDI形式は Format 0 と Format 1 だけです。');
  }

  const declaredTracks = reader.u16At(header.start + 2);
  const division = reader.u16At(header.start + 4);
  if ((division & 0x8000) !== 0) {
    throw new Error('SMPTE時間形式のMIDIにはまだ対応していません。拍ベースのMIDIを書き出して読み込んでください。');
  }
  if (division <= 0) {
    throw new Error('MIDIの拍解像度を読み取れませんでした。');
  }

  reader.seek(header.end);
  const trackChunks: Chunk[] = [];
  while (!reader.done() && trackChunks.length < declaredTracks) {
    const chunk = reader.readChunk();
    if (!chunk) break;
    if (chunk.id === 'MTrk') {
      trackChunks.push(chunk);
    }
    reader.seek(chunk.end);
  }

  if (trackChunks.length !== declaredTracks) {
    throw new Error('MIDIトラック数がヘッダー情報と一致しません。ファイルが途中で切れている可能性があります。');
  }

  const context: ParseContext = {
    bytes,
    ppq: division,
    tempos: [],
    timeSignatures: [],
  };
  const tracks = trackChunks.map((chunk, index) => parseTrack(context, chunk, index));
  const firstTempo = [...context.tempos].sort((a, b) => a.tick - b.tick)[0];
  const firstTimeSignature = [...context.timeSignatures].sort((a, b) => a.tick - b.tick)[0];

  return {
    format: formatValue,
    ppq: division,
    tracks,
    tempos: context.tempos,
    timeSignatures: context.timeSignatures,
    bpm: firstTempo?.bpm ?? DEFAULT_BPM,
    timeSignature: firstTimeSignature
      ? [firstTimeSignature.numerator, firstTimeSignature.denominator]
      : [...DEFAULT_TIME_SIGNATURE],
  };
}

type ParseContext = {
  bytes: Uint8Array;
  ppq: number;
  tempos: ParsedMidiTempo[];
  timeSignatures: ParsedMidiTimeSignature[];
};

function parseTrack(context: ParseContext, chunk: Chunk, index: number): ParsedMidiTrack {
  const state = new TrackReader(context.bytes, chunk.start, chunk.end);
  const active = new Map<string, ActiveNote[]>();
  const notes: ParsedMidiNote[] = [];
  let tick = 0;
  let runningStatus: number | null = null;
  let name: string | null = null;

  const startNote = (channel: number, pitch: number, velocity: number): void => {
    const key = noteKey(channel, pitch);
    const stack = active.get(key) ?? [];
    stack.push({ tick, velocity });
    active.set(key, stack);
  };

  const endNote = (channel: number, pitch: number): void => {
    const key = noteKey(channel, pitch);
    const stack = active.get(key);
    const started = stack?.shift();
    if (!started) return;
    if (stack && stack.length === 0) active.delete(key);
    const durationTicks = tick - started.tick;
    if (durationTicks <= 0) return;
    notes.push({
      pitch,
      startBeat: started.tick / context.ppq,
      durationBeats: durationTicks / context.ppq,
      velocity: started.velocity,
      channel,
    });
  };

  while (!state.done()) {
    tick += state.readVarLen();
    const firstByte = state.readByte();
    let status = firstByte;
    let firstDataByte: number | null = null;

    if (firstByte < 0x80) {
      if (runningStatus === null) {
        throw new Error('MIDIイベントのrunning statusを解決できませんでした。');
      }
      status = runningStatus;
      firstDataByte = firstByte;
    } else if (isChannelStatus(firstByte)) {
      runningStatus = firstByte;
    }

    if (status === 0xff) {
      runningStatus = null;
      const metaType = state.readByte();
      const length = state.readVarLen();
      const data = state.readBytes(length);
      if (metaType === 0x03) {
        name = decodeLatin1(data);
      } else if (metaType === 0x51 && data.length === 3) {
        const usPerQuarter = (data[0]! << 16) | (data[1]! << 8) | data[2]!;
        if (usPerQuarter > 0) {
          context.tempos.push({
            tick,
            beat: tick / context.ppq,
            bpm: 60_000_000 / usPerQuarter,
            microsecondsPerQuarter: usPerQuarter,
          });
        }
      } else if (metaType === 0x58 && data.length >= 2) {
        const numerator = data[0]!;
        const denominator = 2 ** data[1]!;
        if (numerator > 0 && denominator > 0) {
          context.timeSignatures.push({
            tick,
            beat: tick / context.ppq,
            numerator,
            denominator,
          });
        }
      } else if (metaType === 0x2f) {
        break;
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      runningStatus = null;
      state.skip(state.readVarLen());
      continue;
    }

    if (status >= 0xf0) {
      runningStatus = null;
      skipSystemEvent(state, status, firstDataByte);
      continue;
    }

    const eventType = status & 0xf0;
    const channel = status & 0x0f;
    const data1 = readDataByte(state, firstDataByte);
    const data2 = channelDataLength(status) === 2 ? state.readByte() : null;

    if (eventType === 0x90) {
      const velocity = data2 ?? 0;
      if (velocity === 0) {
        endNote(channel, data1);
      } else {
        startNote(channel, data1, velocity);
      }
    } else if (eventType === 0x80) {
      endNote(channel, data1);
    }
  }

  notes.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch || a.channel - b.channel);
  return { index, name, notes };
}

function noteKey(channel: number, pitch: number): string {
  return `${channel}:${pitch}`;
}

function isChannelStatus(value: number): boolean {
  return value >= 0x80 && value <= 0xef;
}

function channelDataLength(status: number): 1 | 2 {
  const eventType = status & 0xf0;
  return eventType === 0xc0 || eventType === 0xd0 ? 1 : 2;
}

function readDataByte(state: TrackReader, firstDataByte: number | null): number {
  if (firstDataByte !== null) return firstDataByte;
  return state.readByte();
}

function skipSystemEvent(state: TrackReader, status: number, firstDataByte: number | null): void {
  const length = systemDataLength(status);
  if (length === null) {
    throw new Error(`未対応のMIDIシステムイベントです: 0x${status.toString(16)}`);
  }
  let remaining = length;
  if (firstDataByte !== null) remaining -= 1;
  if (remaining > 0) state.skip(remaining);
}

function systemDataLength(status: number): number | null {
  switch (status) {
    case 0xf1:
    case 0xf3:
      return 1;
    case 0xf2:
      return 2;
    case 0xf6:
    case 0xf8:
    case 0xf9:
    case 0xfa:
    case 0xfb:
    case 0xfc:
    case 0xfe:
      return 0;
    default:
      return null;
  }
}

function decodeLatin1(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) {
    text += String.fromCharCode(b);
  }
  return text;
}

class ByteReader {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  done(): boolean {
    return this.pos >= this.bytes.length;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.bytes.length) {
      throw new Error('MIDIファイルの読み取り位置が範囲外です。');
    }
    this.pos = pos;
  }

  readChunk(): Chunk | null {
    if (this.done()) return null;
    if (this.pos + 8 > this.bytes.length) {
      throw new Error('MIDIチャンクのヘッダーが途中で切れています。');
    }
    const id = this.asciiAt(this.pos, 4);
    const length = this.u32At(this.pos + 4);
    const start = this.pos + 8;
    const end = start + length;
    if (end > this.bytes.length) {
      throw new Error(`MIDIチャンク ${id} が途中で切れています。`);
    }
    this.pos = start;
    return { id, start, end };
  }

  u16At(offset: number): number {
    this.require(offset, 2);
    return (this.bytes[offset]! << 8) | this.bytes[offset + 1]!;
  }

  private u32At(offset: number): number {
    this.require(offset, 4);
    return (
      (this.bytes[offset]! * 0x1000000)
      + (this.bytes[offset + 1]! << 16)
      + (this.bytes[offset + 2]! << 8)
      + this.bytes[offset + 3]!
    );
  }

  private asciiAt(offset: number, length: number): string {
    this.require(offset, length);
    let text = '';
    for (let i = 0; i < length; i += 1) {
      text += String.fromCharCode(this.bytes[offset + i]!);
    }
    return text;
  }

  private require(offset: number, length: number): void {
    if (offset < 0 || offset + length > this.bytes.length) {
      throw new Error('MIDIファイルが途中で切れています。');
    }
  }
}

class TrackReader {
  private pos: number;

  constructor(
    private readonly bytes: Uint8Array,
    start: number,
    private readonly end: number,
  ) {
    this.pos = start;
  }

  done(): boolean {
    return this.pos >= this.end;
  }

  readByte(): number {
    this.require(1);
    const value = this.bytes[this.pos];
    this.pos += 1;
    return value!;
  }

  readBytes(length: number): Uint8Array {
    this.require(length);
    const value = this.bytes.slice(this.pos, this.pos + length);
    this.pos += length;
    return value;
  }

  skip(length: number): void {
    this.require(length);
    this.pos += length;
  }

  readVarLen(): number {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const b = this.readByte();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new Error('MIDIの可変長数量が長すぎます。');
  }

  private require(length: number): void {
    if (length < 0 || this.pos + length > this.end) {
      throw new Error('MIDIトラックが途中で切れています。');
    }
  }
}
