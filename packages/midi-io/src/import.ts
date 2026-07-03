/**
 * Standard MIDI File (SMF) import.
 *
 * Supports format 0 and format 1 with PPQ timing. The parser intentionally
 * keeps the return shape small and deterministic for round-tripping exported
 * project notes back into app-level structures.
 */

const DEFAULT_TEMPO_US_PER_QUARTER = 500_000;
const META_END_OF_TRACK = 0x2f;
const META_TRACK_NAME = 0x03;
const META_TEMPO = 0x51;

export type ImportedMidiNote = {
  pitch: number;
  startTick: number;
  durationTick: number;
  velocity: number;
  channel: number;
  startBeat: number;
  durationBeat: number;
  startSeconds: number;
  durationSeconds: number;
};

export type ImportedMidiTrack = {
  name: string;
  notes: ImportedMidiNote[];
};

export type ParsedMidiFile = {
  ppq: number;
  tempoBpm: number;
  tracks: ImportedMidiTrack[];
};

type RawMidiNote = {
  pitch: number;
  startTick: number;
  durationTick: number;
  velocity: number;
  channel: number;
};

type ActiveNote = {
  pitch: number;
  startTick: number;
  velocity: number;
  channel: number;
};

type RawTempoEvent = {
  tick: number;
  microsecondsPerQuarter: number;
};

type TempoEvent = RawTempoEvent & {
  order: number;
};

type ParsedTrackData = {
  name: string;
  notes: RawMidiNote[];
  tempoEvents: RawTempoEvent[];
};

class MidiReader {
  private pos: number;

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
    private readonly end = bytes.length,
  ) {
    this.pos = start;
  }

  get position(): number {
    return this.pos;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  ensure(count: number): void {
    if (count < 0 || this.pos + count > this.end) {
      throw new Error(`Unexpected end of MIDI data at byte ${this.pos}`);
    }
  }

  skip(count: number): void {
    this.ensure(count);
    this.pos += count;
  }

  readUint8(): number {
    this.ensure(1);
    const value = this.bytes[this.pos];
    this.pos += 1;
    if (value === undefined) {
      throw new Error(`Unexpected end of MIDI data at byte ${this.pos - 1}`);
    }
    return value;
  }

  readDataByte(): number {
    const value = this.readUint8();
    if ((value & 0x80) !== 0) {
      throw new Error(`Expected MIDI data byte at byte ${this.pos - 1}`);
    }
    return value;
  }

  readUint16(): number {
    return (this.readUint8() << 8) | this.readUint8();
  }

  readUint32(): number {
    return (
      this.readUint8() * 0x1000000
      + this.readUint8() * 0x10000
      + this.readUint8() * 0x100
      + this.readUint8()
    );
  }

  readAscii(length: number): string {
    let text = '';
    for (let i = 0; i < length; i++) {
      text += String.fromCharCode(this.readUint8());
    }
    return text;
  }

  readBytes(length: number): Uint8Array {
    this.ensure(length);
    const start = this.pos;
    this.pos += length;
    return this.bytes.slice(start, this.pos);
  }

  readVarLen(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.readUint8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error(`Invalid MIDI variable-length quantity at byte ${this.pos}`);
  }
}

/**
 * Parse a Standard MIDI File into note tracks.
 */
export function parseMidiFile(bytes: Uint8Array): ParsedMidiFile {
  const reader = new MidiReader(bytes);
  if (reader.readAscii(4) !== 'MThd') {
    throw new Error('Invalid MIDI file: missing MThd header');
  }

  const headerLength = reader.readUint32();
  if (headerLength < 6) {
    throw new Error(`Invalid MIDI header length: ${headerLength}`);
  }

  const format = reader.readUint16();
  const trackCount = reader.readUint16();
  const division = reader.readUint16();
  reader.skip(headerLength - 6);

  if (format !== 0 && format !== 1) {
    throw new Error(`Unsupported MIDI format ${format}; only format 0 and 1 are supported`);
  }
  if (format === 0 && trackCount !== 1) {
    throw new Error(`Invalid format 0 MIDI file: expected 1 track, got ${trackCount}`);
  }
  if ((division & 0x8000) !== 0) {
    throw new Error('Unsupported MIDI division: SMPTE timing is not supported');
  }
  if (division === 0) {
    throw new Error('Invalid MIDI division: PPQ must be greater than zero');
  }

  const parsedTracks: ParsedTrackData[] = [];
  while (!reader.done && parsedTracks.length < trackCount) {
    const chunkType = reader.readAscii(4);
    const chunkLength = reader.readUint32();
    const chunkStart = reader.position;
    reader.skip(chunkLength);

    if (chunkType === 'MTrk') {
      parsedTracks.push(parseTrack(bytes, chunkStart, chunkStart + chunkLength, parsedTracks.length));
    }
  }

  if (parsedTracks.length !== trackCount) {
    throw new Error(`Invalid MIDI file: expected ${trackCount} track chunks, found ${parsedTracks.length}`);
  }

  const tempoEvents = collectTempoEvents(parsedTracks);
  const tempoBpm = usPerQuarterToBpm(initialTempoUsPerQuarter(tempoEvents));

  const tracks = parsedTracks.map((track, index) => ({
    name: track.name || `Track ${index + 1}`,
    notes: [...track.notes]
      .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch || a.channel - b.channel)
      .map((note) => enrichNote(note, division, tempoEvents)),
  }));

  return { ppq: division, tempoBpm, tracks };
}

function parseTrack(bytes: Uint8Array, start: number, end: number, trackIndex: number): ParsedTrackData {
  const reader = new MidiReader(bytes, start, end);
  const notes: RawMidiNote[] = [];
  const activeNotes = new Map<number, ActiveNote[]>();
  const tempoEvents: RawTempoEvent[] = [];
  let name = '';
  let tick = 0;
  let runningStatus: number | undefined;

  while (!reader.done) {
    tick += reader.readVarLen();

    const firstByte = reader.readUint8();
    let status: number;
    let firstDataByte: number | undefined;

    if ((firstByte & 0x80) !== 0) {
      status = firstByte;
      if (status >= 0x80 && status <= 0xef) {
        runningStatus = status;
      }
    } else {
      if (runningStatus === undefined) {
        throw new Error(`Missing running status in track ${trackIndex + 1} at byte ${reader.position - 1}`);
      }
      status = runningStatus;
      firstDataByte = firstByte;
    }

    if (status === 0xff) {
      runningStatus = undefined;
      const metaType = reader.readUint8();
      const length = reader.readVarLen();
      const data = reader.readBytes(length);
      if (metaType === META_TRACK_NAME) {
        name = bytesToAscii(data);
      } else if (metaType === META_TEMPO && data.length === 3) {
        tempoEvents.push({
          tick,
          microsecondsPerQuarter: (data[0]! << 16) | (data[1]! << 8) | data[2]!,
        });
      } else if (metaType === META_END_OF_TRACK) {
        break;
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      runningStatus = undefined;
      reader.skip(reader.readVarLen());
      continue;
    }

    if (status >= 0x80 && status <= 0xef) {
      parseChannelEvent(status, firstDataByte, reader, tick, activeNotes, notes);
      continue;
    }

    runningStatus = undefined;
    skipSystemEvent(status, reader);
  }

  return { name, notes, tempoEvents };
}

function parseChannelEvent(
  status: number,
  firstDataByte: number | undefined,
  reader: MidiReader,
  tick: number,
  activeNotes: Map<number, ActiveNote[]>,
  notes: RawMidiNote[],
): void {
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const dataLength = channelEventDataLength(kind);
  const data1 = firstDataByte ?? reader.readDataByte();
  const data2 = dataLength === 2 ? reader.readDataByte() : undefined;

  if (kind === 0x90 && data2 !== undefined && data2 > 0) {
    const key = noteKey(channel, data1);
    const pending = activeNotes.get(key) ?? [];
    pending.push({ pitch: data1, startTick: tick, velocity: data2, channel });
    activeNotes.set(key, pending);
    return;
  }

  if (kind === 0x80 || (kind === 0x90 && data2 === 0)) {
    const key = noteKey(channel, data1);
    const pending = activeNotes.get(key);
    const started = pending?.shift();
    if (pending !== undefined && pending.length === 0) {
      activeNotes.delete(key);
    }
    if (started !== undefined) {
      notes.push({
        pitch: started.pitch,
        startTick: started.startTick,
        durationTick: tick - started.startTick,
        velocity: started.velocity,
        channel: started.channel,
      });
    }
  }
}

function channelEventDataLength(kind: number): 1 | 2 {
  if (kind === 0xc0 || kind === 0xd0) return 1;
  return 2;
}

function skipSystemEvent(status: number, reader: MidiReader): void {
  switch (status) {
    case 0xf1:
    case 0xf3:
      reader.skip(1);
      return;
    case 0xf2:
      reader.skip(2);
      return;
    case 0xf6:
    case 0xf8:
    case 0xf9:
    case 0xfa:
    case 0xfb:
    case 0xfc:
    case 0xfe:
      return;
    default:
      throw new Error(`Unsupported MIDI event status 0x${status.toString(16)}`);
  }
}

function collectTempoEvents(tracks: ParsedTrackData[]): TempoEvent[] {
  const events: TempoEvent[] = [];
  for (const track of tracks) {
    for (const event of track.tempoEvents) {
      events.push({ ...event, order: events.length });
    }
  }
  return events.sort((a, b) => a.tick - b.tick || a.order - b.order);
}

function initialTempoUsPerQuarter(tempoEvents: TempoEvent[]): number {
  let usPerQuarter = DEFAULT_TEMPO_US_PER_QUARTER;
  for (const event of tempoEvents) {
    if (event.tick > 0) break;
    usPerQuarter = event.microsecondsPerQuarter;
  }
  return usPerQuarter;
}

function enrichNote(note: RawMidiNote, ppq: number, tempoEvents: TempoEvent[]): ImportedMidiNote {
  const endTick = note.startTick + note.durationTick;
  const startSeconds = tickToSeconds(note.startTick, ppq, tempoEvents);
  return {
    ...note,
    startBeat: note.startTick / ppq,
    durationBeat: note.durationTick / ppq,
    startSeconds,
    durationSeconds: tickToSeconds(endTick, ppq, tempoEvents) - startSeconds,
  };
}

function tickToSeconds(tick: number, ppq: number, tempoEvents: TempoEvent[]): number {
  let seconds = 0;
  let lastTick = 0;
  let usPerQuarter = DEFAULT_TEMPO_US_PER_QUARTER;

  for (const event of tempoEvents) {
    if (event.tick > tick) break;
    seconds += ticksToSeconds(event.tick - lastTick, ppq, usPerQuarter);
    lastTick = event.tick;
    usPerQuarter = event.microsecondsPerQuarter;
  }

  return seconds + ticksToSeconds(tick - lastTick, ppq, usPerQuarter);
}

function ticksToSeconds(ticks: number, ppq: number, usPerQuarter: number): number {
  return (ticks / ppq) * (usPerQuarter / 1_000_000);
}

function usPerQuarterToBpm(usPerQuarter: number): number {
  return 60_000_000 / usPerQuarter;
}

function noteKey(channel: number, pitch: number): number {
  return channel * 128 + pitch;
}

function bytesToAscii(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}
