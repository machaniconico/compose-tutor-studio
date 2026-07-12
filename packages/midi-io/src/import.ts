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
const META_MARKER = 0x06;
const META_TEMPO = 0x51;
const META_TIME_SIGNATURE = 0x58;
const META_KEY_SIGNATURE = 0x59;

export type MidiImportErrorCode =
  | 'invalid-options'
  | 'input-too-large'
  | 'track-limit-exceeded'
  | 'event-limit-exceeded'
  | 'note-limit-exceeded'
  | 'active-note-limit-exceeded'
  | 'tempo-event-limit-exceeded'
  | 'metadata-too-large'
  | 'invalid-midi';

export type MidiParseLimits = Readonly<{
  maxBytes: number;
  maxTracks: number;
  maxEvents: number;
  maxNotes: number;
  maxActiveNotes: number;
  maxActiveNotesPerKey: number;
  maxTempoEvents: number;
  maxTrackNameBytes: number;
}>;

/**
 * Hard parser ceilings. Callers may lower individual limits, but cannot raise
 * them: parsing happens on the renderer thread and MIDI bytes are untrusted.
 */
export const DEFAULT_MIDI_PARSE_LIMITS: MidiParseLimits = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxTracks: 256,
  maxEvents: 100_000,
  maxNotes: 20_000,
  maxActiveNotes: 2_048,
  maxActiveNotesPerKey: 256,
  maxTempoEvents: 4_096,
  maxTrackNameBytes: 4_096,
});

export type MidiParseOptions = Readonly<{
  limits?: Partial<MidiParseLimits>;
}>;

export class MidiImportError extends Error {
  readonly code: MidiImportErrorCode;
  readonly limit: number | undefined;
  readonly observed: number | undefined;

  constructor(
    code: MidiImportErrorCode,
    message: string,
    details: Readonly<{ limit?: number; observed?: number }> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MidiImportError';
    this.code = code;
    this.limit = details.limit;
    this.observed = details.observed;
  }
}

const MIDI_PARSE_LIMIT_KEYS = Object.freeze([
  'maxBytes',
  'maxTracks',
  'maxEvents',
  'maxNotes',
  'maxActiveNotes',
  'maxActiveNotesPerKey',
  'maxTempoEvents',
  'maxTrackNameBytes',
] as const satisfies readonly (keyof MidiParseLimits)[]);

function resolveParseLimits(options: MidiParseOptions | undefined): MidiParseLimits {
  const overrides = options?.limits ?? {};
  const resolved = { ...DEFAULT_MIDI_PARSE_LIMITS };
  for (const key of MIDI_PARSE_LIMIT_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (
      !Number.isSafeInteger(value)
      || value <= 0
      || value > DEFAULT_MIDI_PARSE_LIMITS[key]
    ) {
      throw new MidiImportError(
        'invalid-options',
        `${key} must be a positive safe integer no greater than ${DEFAULT_MIDI_PARSE_LIMITS[key]}`,
        { limit: DEFAULT_MIDI_PARSE_LIMITS[key], observed: value },
      );
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

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

export type ImportedMidiTempoEvent = {
  tick: number;
  bpm: number;
};

export type ImportedMidiTimeSignature = {
  tick: number;
  numerator: number;
  denominator: number;
};

export type ImportedMidiMarker = {
  tick: number;
  text: string;
  trackIndex: number;
};

export type ImportedMidiKeySignature = {
  tick: number;
  /** Signed MIDI accidental count, -7 flats through +7 sharps. */
  sharpsFlats: number;
  minor: boolean;
  trackIndex: number;
};

export type ImportedMidiInitialChannel = {
  channel: number;
  program?: number;
  bankMsb?: number;
  bankLsb?: number;
  volumeCc?: number;
  panCc?: number;
};

export type ImportedMidiTrack = {
  name: string;
  notes: ImportedMidiNote[];
  /** True for a non-blank FF 03 name, false for a synthesized name, absent in legacy fixtures. */
  hasExplicitName?: boolean;
  /** Deterministic channel snapshots from channel events at absolute tick zero. */
  initialChannels?: ImportedMidiInitialChannel[];
  /** True when later Program/Bank/CC7/CC10 automation could not become static track mix. */
  hasChannelAutomation?: boolean;
};

export type ParsedMidiFile = {
  /** Present for newly parsed files; optional to keep existing typed fixtures source-compatible. */
  format?: 0 | 1;
  ppq: number;
  tempoBpm: number;
  tempoEvents?: ImportedMidiTempoEvent[];
  timeSignatures?: ImportedMidiTimeSignature[];
  markers?: ImportedMidiMarker[];
  keySignatures?: ImportedMidiKeySignature[];
  /** Number of track/marker strings decoded with the deterministic Latin-1 fallback. */
  textEncodingFallbackCount?: number;
  noteIssues?: Readonly<{
    unmatchedNoteOns: number;
    orphanNoteOffs: number;
  }>;
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

type ActiveNoteQueue = {
  items: Array<ActiveNote | undefined>;
  head: number;
};

type RawTempoEvent = {
  tick: number;
  microsecondsPerQuarter: number;
};

type RawTimeSignatureEvent = {
  tick: number;
  numerator: number;
  denominator: number;
};

type RawMarkerEvent = {
  tick: number;
  text: string;
};

type RawKeySignatureEvent = {
  tick: number;
  sharpsFlats: number;
  minor: boolean;
};

type TempoEvent = RawTempoEvent & {
  order: number;
};

type TempoPoint = {
  tick: number;
  secondsAtTick: number;
  microsecondsPerQuarter: number;
};

type ParsedTrackData = {
  name: string;
  hasExplicitName: boolean;
  notes: RawMidiNote[];
  tempoEvents: RawTempoEvent[];
  timeSignatures: RawTimeSignatureEvent[];
  markers: RawMarkerEvent[];
  keySignatures: RawKeySignatureEvent[];
  initialChannels: ImportedMidiInitialChannel[];
  hasChannelAutomation: boolean;
  textEncodingFallbackCount: number;
  unmatchedNoteOns: number;
  orphanNoteOffs: number;
};

class MidiParseBudget {
  private events = 0;
  private notes = 0;
  private tempoEvents = 0;

  constructor(readonly limits: MidiParseLimits) {}

  consumeEvent(): void {
    this.events += 1;
    this.assertWithin('event-limit-exceeded', this.events, this.limits.maxEvents, 'MIDI event');
  }

  consumeNote(): void {
    this.notes += 1;
    this.assertWithin('note-limit-exceeded', this.notes, this.limits.maxNotes, 'MIDI note');
  }

  consumeTempoEvent(): void {
    this.tempoEvents += 1;
    this.assertWithin(
      'tempo-event-limit-exceeded',
      this.tempoEvents,
      this.limits.maxTempoEvents,
      'tempo event',
    );
  }

  assertActiveDepth(activeNotes: number, perKeyDepth: number): void {
    if (activeNotes > this.limits.maxActiveNotes) {
      throw new MidiImportError(
        'active-note-limit-exceeded',
        `simultaneous active notes exceed ${this.limits.maxActiveNotes}`,
        { limit: this.limits.maxActiveNotes, observed: activeNotes },
      );
    }
    if (perKeyDepth > this.limits.maxActiveNotesPerKey) {
      throw new MidiImportError(
        'active-note-limit-exceeded',
        `overlapping notes for one channel/pitch exceed ${this.limits.maxActiveNotesPerKey}`,
        { limit: this.limits.maxActiveNotesPerKey, observed: perKeyDepth },
      );
    }
  }

  private assertWithin(
    code: MidiImportErrorCode,
    observed: number,
    limit: number,
    label: string,
  ): void {
    if (observed <= limit) return;
    throw new MidiImportError(code, `${label} count exceeds ${limit}`, { limit, observed });
  }
}

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
export function parseMidiFile(bytes: Uint8Array, options?: MidiParseOptions): ParsedMidiFile {
  try {
    const limits = resolveParseLimits(options);
    if (!(bytes instanceof Uint8Array)) {
      throw new MidiImportError('invalid-midi', 'MIDI input must be a Uint8Array');
    }
    if (bytes.byteLength > limits.maxBytes) {
      throw new MidiImportError(
        'input-too-large',
        `MIDI input exceeds ${limits.maxBytes} bytes`,
        { limit: limits.maxBytes, observed: bytes.byteLength },
      );
    }
    return parseMidiFileWithinLimits(bytes, limits);
  } catch (error) {
    if (error instanceof MidiImportError) throw error;
    throw new MidiImportError(
      'invalid-midi',
      error instanceof Error ? error.message : 'Invalid MIDI data',
      {},
      { cause: error },
    );
  }
}

function parseMidiFileWithinLimits(bytes: Uint8Array, limits: MidiParseLimits): ParsedMidiFile {
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
  if (trackCount > limits.maxTracks) {
    throw new MidiImportError(
      'track-limit-exceeded',
      `MIDI track count exceeds ${limits.maxTracks}`,
      { limit: limits.maxTracks, observed: trackCount },
    );
  }

  const budget = new MidiParseBudget(limits);
  const parsedTracks: ParsedTrackData[] = [];
  while (!reader.done && parsedTracks.length < trackCount) {
    const chunkType = reader.readAscii(4);
    const chunkLength = reader.readUint32();
    const chunkStart = reader.position;
    reader.skip(chunkLength);

    if (chunkType === 'MTrk') {
      parsedTracks.push(
        parseTrack(bytes, chunkStart, chunkStart + chunkLength, parsedTracks.length, budget),
      );
    }
  }

  if (parsedTracks.length !== trackCount) {
    throw new Error(`Invalid MIDI file: expected ${trackCount} track chunks, found ${parsedTracks.length}`);
  }

  const tempoEvents = collectTempoEvents(parsedTracks);
  const tempoTimeline = buildTempoTimeline(tempoEvents, division);
  const tempoBpm = usPerQuarterToBpm(tempoTimeline[0]!.microsecondsPerQuarter);
  const importedTempoEvents = tempoEvents.map((event) => ({
    tick: event.tick,
    bpm: usPerQuarterToBpm(event.microsecondsPerQuarter),
  }));
  const timeSignatures = collectTimeSignatures(parsedTracks);
  const markers = collectMarkers(parsedTracks);
  const keySignatures = collectKeySignatures(parsedTracks);

  const tracks = parsedTracks.map((track, index) => ({
    name: track.hasExplicitName ? track.name : `Track ${index + 1}`,
    hasExplicitName: track.hasExplicitName,
    notes: [...track.notes]
      .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch || a.channel - b.channel)
      .map((note) => enrichNote(note, division, tempoTimeline)),
    initialChannels: track.initialChannels,
    hasChannelAutomation: track.hasChannelAutomation,
  }));

  return {
    format,
    ppq: division,
    tempoBpm,
    tempoEvents: importedTempoEvents,
    timeSignatures,
    markers,
    keySignatures,
    textEncodingFallbackCount: parsedTracks.reduce(
      (count, track) => count + track.textEncodingFallbackCount,
      0,
    ),
    noteIssues: {
      unmatchedNoteOns: parsedTracks.reduce(
        (count, track) => count + track.unmatchedNoteOns,
        0,
      ),
      orphanNoteOffs: parsedTracks.reduce(
        (count, track) => count + track.orphanNoteOffs,
        0,
      ),
    },
    tracks,
  };
}

function parseTrack(
  bytes: Uint8Array,
  start: number,
  end: number,
  trackIndex: number,
  budget: MidiParseBudget,
): ParsedTrackData {
  const reader = new MidiReader(bytes, start, end);
  const notes: RawMidiNote[] = [];
  const activeNotes = new Map<number, ActiveNoteQueue>();
  const tempoEvents: RawTempoEvent[] = [];
  const timeSignatures: RawTimeSignatureEvent[] = [];
  const markers: RawMarkerEvent[] = [];
  const keySignatures: RawKeySignatureEvent[] = [];
  const initialChannels = new Map<number, ImportedMidiInitialChannel>();
  const channelAutomation = { value: false };
  const noteIssues = { orphanNoteOffs: 0 };
  let textEncodingFallbackCount = 0;
  let name = '';
  let hasExplicitName = false;
  let tick = 0;
  let runningStatus: number | undefined;
  let activeNoteCount = 0;

  while (!reader.done) {
    tick += reader.readVarLen();
    budget.consumeEvent();

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
      if (metaType === META_TRACK_NAME) {
        if (length > budget.limits.maxTrackNameBytes) {
          throw new MidiImportError(
            'metadata-too-large',
            `MIDI track name exceeds ${budget.limits.maxTrackNameBytes} bytes`,
            { limit: budget.limits.maxTrackNameBytes, observed: length },
          );
        }
        const decoded = bytesToText(reader.readBytes(length));
        name = decoded.text;
        hasExplicitName = name.trim().length > 0;
        if (decoded.usedFallback) textEncodingFallbackCount += 1;
      } else if (metaType === META_MARKER) {
        if (length > budget.limits.maxTrackNameBytes) {
          throw new MidiImportError(
            'metadata-too-large',
            `MIDI marker exceeds ${budget.limits.maxTrackNameBytes} bytes`,
            { limit: budget.limits.maxTrackNameBytes, observed: length },
          );
        }
        const decoded = bytesToText(reader.readBytes(length));
        markers.push({ tick, text: decoded.text });
        if (decoded.usedFallback) textEncodingFallbackCount += 1;
      } else if (metaType === META_TEMPO) {
        assertMetaLength('tempo', length, 3);
        const data = reader.readBytes(length);
        const microsecondsPerQuarter = (data[0]! << 16) | (data[1]! << 8) | data[2]!;
        if (microsecondsPerQuarter <= 0) {
          throw new Error('Invalid MIDI tempo: microseconds per quarter must be greater than zero');
        }
        budget.consumeTempoEvent();
        tempoEvents.push({
          tick,
          microsecondsPerQuarter,
        });
      } else if (metaType === META_TIME_SIGNATURE) {
        assertMetaLength('time signature', length, 4);
        const data = reader.readBytes(length);
        if (data[0] === 0 || data[1]! > 30) {
          throw new Error('Invalid MIDI time signature');
        }
        timeSignatures.push({
          tick,
          numerator: data[0]!,
          denominator: 2 ** data[1]!,
        });
      } else if (metaType === META_KEY_SIGNATURE) {
        assertMetaLength('key signature', length, 2);
        const data = reader.readBytes(length);
        const sharpsFlats = data[0]! > 127 ? data[0]! - 256 : data[0]!;
        const mode = data[1]!;
        if (sharpsFlats < -7 || sharpsFlats > 7 || (mode !== 0 && mode !== 1)) {
          throw new Error('Invalid MIDI key signature');
        }
        keySignatures.push({ tick, sharpsFlats, minor: mode === 1 });
      } else if (metaType === META_END_OF_TRACK) {
        assertMetaLength('end of track', length, 0);
        break;
      } else {
        reader.skip(length);
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      runningStatus = undefined;
      reader.skip(reader.readVarLen());
      continue;
    }

    if (status >= 0x80 && status <= 0xef) {
      activeNoteCount = parseChannelEvent(
        status,
        firstDataByte,
        reader,
        tick,
        activeNotes,
        activeNoteCount,
        notes,
        initialChannels,
        channelAutomation,
        noteIssues,
        budget,
      );
      continue;
    }

    runningStatus = undefined;
    skipSystemEvent(status, reader);
  }

  return {
    name,
    hasExplicitName,
    notes,
    tempoEvents,
    timeSignatures,
    markers,
    keySignatures,
    initialChannels: [...initialChannels.values()].sort((a, b) => a.channel - b.channel),
    hasChannelAutomation: channelAutomation.value,
    textEncodingFallbackCount,
    unmatchedNoteOns: activeNoteCount,
    orphanNoteOffs: noteIssues.orphanNoteOffs,
  };
}

function assertMetaLength(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`Invalid MIDI ${label} metadata length: expected ${expected}, got ${actual}`);
  }
}

function parseChannelEvent(
  status: number,
  firstDataByte: number | undefined,
  reader: MidiReader,
  tick: number,
  activeNotes: Map<number, ActiveNoteQueue>,
  activeNoteCount: number,
  notes: RawMidiNote[],
  initialChannels: Map<number, ImportedMidiInitialChannel>,
  channelAutomation: { value: boolean },
  noteIssues: { orphanNoteOffs: number },
  budget: MidiParseBudget,
): number {
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const dataLength = channelEventDataLength(kind);
  const data1 = firstDataByte ?? reader.readDataByte();
  const data2 = dataLength === 2 ? reader.readDataByte() : undefined;

  if (tick === 0) {
    const initial = initialChannels.get(channel) ?? { channel };
    if (kind === 0xc0) {
      initial.program = data1;
    } else if (kind === 0xb0 && data2 !== undefined) {
      if (data1 === 0) initial.bankMsb = data2;
      else if (data1 === 32) initial.bankLsb = data2;
      else if (data1 === 7) initial.volumeCc = data2;
      else if (data1 === 10) initial.panCc = data2;
    }
    initialChannels.set(channel, initial);
  } else if (
    kind === 0xc0 ||
    (kind === 0xb0 && data2 !== undefined && (data1 === 0 || data1 === 32 || data1 === 7 || data1 === 10))
  ) {
    channelAutomation.value = true;
  }

  if (kind === 0x90 && data2 !== undefined && data2 > 0) {
    const key = noteKey(channel, data1);
    const pending = activeNotes.get(key) ?? { items: [], head: 0 };
    const perKeyDepth = pending.items.length - pending.head + 1;
    budget.assertActiveDepth(activeNoteCount + 1, perKeyDepth);
    pending.items.push({ pitch: data1, startTick: tick, velocity: data2, channel });
    activeNotes.set(key, pending);
    return activeNoteCount + 1;
  }

  if (kind === 0x80 || (kind === 0x90 && data2 === 0)) {
    const key = noteKey(channel, data1);
    const pending = activeNotes.get(key);
    const started = pending?.items[pending.head];
    if (pending !== undefined && started !== undefined) {
      pending.items[pending.head] = undefined;
      pending.head += 1;
      activeNoteCount -= 1;
      if (pending.head === pending.items.length) {
        activeNotes.delete(key);
      } else if (pending.head >= 1_024 && pending.head * 2 >= pending.items.length) {
        // Amortized O(1): occasionally release consumed slots without shifting
        // the remaining queue for every note-off.
        pending.items = pending.items.slice(pending.head);
        pending.head = 0;
      }
    }
    if (started !== undefined) {
      budget.consumeNote();
      notes.push({
        pitch: started.pitch,
        startTick: started.startTick,
        durationTick: tick - started.startTick,
        velocity: started.velocity,
        channel: started.channel,
      });
    } else {
      noteIssues.orphanNoteOffs += 1;
    }
  }
  return activeNoteCount;
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

function collectTimeSignatures(tracks: ParsedTrackData[]): ImportedMidiTimeSignature[] {
  return tracks
    .flatMap((track, trackIndex) =>
      track.timeSignatures.map((event, eventIndex) => ({
        ...event,
        trackIndex,
        eventIndex,
      })),
    )
    .sort(
      (a, b) =>
        a.tick - b.tick || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex,
    )
    .map(({ tick, numerator, denominator }) => ({ tick, numerator, denominator }));
}

function collectMarkers(tracks: ParsedTrackData[]): ImportedMidiMarker[] {
  return tracks
    .flatMap((track, trackIndex) =>
      track.markers.map((event, eventIndex) => ({
        ...event,
        trackIndex,
        eventIndex,
      })),
    )
    .sort(
      (a, b) =>
        a.tick - b.tick || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex,
    )
    .map(({ tick, text, trackIndex }) => ({ tick, text, trackIndex }));
}

function collectKeySignatures(tracks: ParsedTrackData[]): ImportedMidiKeySignature[] {
  return tracks
    .flatMap((track, trackIndex) =>
      track.keySignatures.map((event, eventIndex) => ({
        ...event,
        trackIndex,
        eventIndex,
      })),
    )
    .sort(
      (a, b) =>
        a.tick - b.tick || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex,
    )
    .map(({ tick, sharpsFlats, minor, trackIndex }) => ({
      tick,
      sharpsFlats,
      minor,
      trackIndex,
    }));
}

function buildTempoTimeline(tempoEvents: TempoEvent[], ppq: number): TempoPoint[] {
  const timeline: TempoPoint[] = [
    { tick: 0, secondsAtTick: 0, microsecondsPerQuarter: DEFAULT_TEMPO_US_PER_QUARTER },
  ];
  let seconds = 0;
  let lastTick = 0;
  let microsecondsPerQuarter = DEFAULT_TEMPO_US_PER_QUARTER;

  for (const event of tempoEvents) {
    seconds += ticksToSeconds(event.tick - lastTick, ppq, microsecondsPerQuarter);
    lastTick = event.tick;
    microsecondsPerQuarter = event.microsecondsPerQuarter;
    const previous = timeline[timeline.length - 1]!;
    const point: TempoPoint = { tick: event.tick, secondsAtTick: seconds, microsecondsPerQuarter };
    if (previous.tick === event.tick) timeline[timeline.length - 1] = point;
    else timeline.push(point);
  }
  return timeline;
}

function enrichNote(note: RawMidiNote, ppq: number, tempoTimeline: TempoPoint[]): ImportedMidiNote {
  const endTick = note.startTick + note.durationTick;
  const startSeconds = tickToSeconds(note.startTick, ppq, tempoTimeline);
  return {
    ...note,
    startBeat: note.startTick / ppq,
    durationBeat: note.durationTick / ppq,
    startSeconds,
    durationSeconds: tickToSeconds(endTick, ppq, tempoTimeline) - startSeconds,
  };
}

function tickToSeconds(tick: number, ppq: number, tempoTimeline: TempoPoint[]): number {
  let low = 0;
  let high = tempoTimeline.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (tempoTimeline[middle]!.tick <= tick) low = middle + 1;
    else high = middle - 1;
  }
  const point = tempoTimeline[Math.max(0, high)]!;
  return (
    point.secondsAtTick
    + ticksToSeconds(tick - point.tick, ppq, point.microsecondsPerQuarter)
  );
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

const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function bytesToText(bytes: Uint8Array): { text: string; usedFallback: boolean } {
  try {
    return { text: FATAL_UTF8_DECODER.decode(bytes), usedFallback: false };
  } catch {
    return { text: bytesToAscii(bytes), usedFallback: true };
  }
}

function bytesToAscii(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}
