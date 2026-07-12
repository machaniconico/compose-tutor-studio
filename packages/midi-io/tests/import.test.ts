import { describe, it, expect } from 'vitest';
import {
  MidiImportError,
  parseMidiFile,
  projectToMidi,
  exportNotesToMidi,
} from '../src/index.js';
import { buildHeaderChunk, concatChunks, writeVarLen } from '../src/smf.js';
import type { NoteEvent, Project } from '@cts/project-model';

describe('parseMidiFile', () => {
  it('parses format 0 notes exported by exportNotesToMidi', () => {
    const notes: NoteEvent[] = [
      { id: 'n1', pitch: 72, startBeat: 0.5, durationBeats: 1.25, velocity: 77 },
    ];

    const midi = exportNotesToMidi(notes, 150, { ppq: 240, channel: 2 });
    const parsed = parseMidiFile(midi);

    expect(parsed.format).toBe(0);
    expect(parsed.ppq).toBe(240);
    expect(parsed.tempoBpm).toBeCloseTo(150);
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0]!.notes).toHaveLength(1);
    expect(parsed.tracks[0]!.notes[0]).toMatchObject({
      pitch: 72,
      startTick: 120,
      durationTick: 300,
      velocity: 77,
      channel: 2,
      startBeat: 0.5,
      durationBeat: 1.25,
    });
    expect(parsed.tracks[0]!.notes[0]!.durationSeconds).toBeCloseTo(0.5);
  });

  it('round-trips projectToMidi format 1 notes by tick', () => {
    const project: Project = {
      id: 'p',
      schemaVersion: 1,
      title: 'Round Trip',
      bpm: 90,
      timeSignature: [4, 4],
      key: 'C',
      scale: 'major',
      lengthBars: 2,
      tracks: [
        {
          id: 'lead',
          name: 'Lead',
          type: 'instrument',
          clips: [
            {
              id: 'clip-1',
              trackId: 'lead',
              type: 'midi',
              startBeat: 1,
              lengthBeats: 4,
              loop: false,
              notes: [
                { id: 'n1', pitch: 60, startBeat: 0.5, durationBeats: 0.75, velocity: 100 },
                { id: 'n2', pitch: 64, startBeat: 1.25, durationBeats: 1, velocity: 88 },
              ],
            },
          ],
          volume: 1,
          pan: 0,
          mute: false,
          solo: false,
          effects: [],
        },
        {
          id: 'drums',
          name: 'Drums',
          type: 'drum',
          clips: [
            {
              id: 'clip-2',
              trackId: 'drums',
              type: 'drum',
              startBeat: 0,
              lengthBeats: 4,
              loop: false,
              stepsPerBar: 16,
              drumEvents: [
                { id: 'kick', lane: 'kick', stepIndex: 0, velocity: 110 },
                { id: 'snare', lane: 'snare', stepIndex: 4, velocity: 105 },
              ],
            },
          ],
          volume: 1,
          pan: 0,
          mute: false,
          solo: false,
          effects: [],
        },
      ],
      chordTrack: [],
      sections: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const parsed = parseMidiFile(projectToMidi(project, { ppq: 960 }));
    const lead = parsed.tracks.find((track) => track.name === 'Lead');
    const drums = parsed.tracks.find((track) => track.name === 'Drums');

    expect(parsed.format).toBe(1);
    expect(parsed.ppq).toBe(960);
    expect(parsed.tempoBpm).toBeCloseTo(90);
    expect(lead?.notes).toEqual([
      expect.objectContaining({ pitch: 60, startTick: 1440, durationTick: 720, velocity: 100 }),
      expect.objectContaining({ pitch: 64, startTick: 2160, durationTick: 960, velocity: 88 }),
    ]);
    expect(drums?.notes).toEqual([
      expect.objectContaining({ pitch: 36, startTick: 0, durationTick: 240, velocity: 110 }),
      expect.objectContaining({ pitch: 38, startTick: 960, durationTick: 240, velocity: 105 }),
    ]);
  });

  it('handles variable-length delta times and running status', () => {
    const track = buildRawTrack([
      0x00, 0xff, 0x03, 0x07, ...asciiBytes('Running'),
      0x00, 0xff, 0x51, 0x03, 0x09, 0x27, 0xc0,
      ...writeVarLen(128), 0x90, 60, 100,
      0x00, 64, 80,
      ...writeVarLen(480), 60, 0,
      0x00, 64, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);

    const parsed = parseMidiFile(concatChunks(buildHeaderChunk(0, 1, 480), track));

    expect(parsed.tempoBpm).toBeCloseTo(100);
    expect(parsed.tracks[0]!.name).toBe('Running');
    expect(parsed.tracks[0]!.notes).toEqual([
      expect.objectContaining({ pitch: 60, startTick: 128, durationTick: 480, velocity: 100 }),
      expect.objectContaining({ pitch: 64, startTick: 128, durationTick: 480, velocity: 80 }),
    ]);
    expect(parsed.tracks[0]!.notes[0]!.startSeconds).toBeCloseTo(0.16);
    expect(parsed.tracks[0]!.notes[0]!.durationSeconds).toBeCloseTo(0.6);
  });

  it('uses the default initial tempo before later tempo changes', () => {
    const track = buildRawTrack([
      0x00, 0x90, 60, 100,
      ...writeVarLen(480), 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
      ...writeVarLen(480), 0x80, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);

    const parsed = parseMidiFile(concatChunks(buildHeaderChunk(0, 1, 480), track));

    expect(parsed.tempoBpm).toBeCloseTo(120);
    expect(parsed.tracks[0]!.notes[0]).toMatchObject({
      pitch: 60,
      startTick: 0,
      durationTick: 960,
    });
    expect(parsed.tracks[0]!.notes[0]!.durationSeconds).toBeCloseTo(1.5);
  });

  it('distinguishes literal Track N names from synthesized and blank track names', () => {
    const explicitTrack1 = buildRawTrack([
      0x00, 0xff, 0x03, 0x07, ...asciiBytes('Track 1'),
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const explicitTrack2 = buildRawTrack([
      0x00, 0xff, 0x03, 0x07, ...asciiBytes('Track 2'),
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const missingName = buildRawTrack([
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const blankName = buildRawTrack([
      0x00, 0xff, 0x03, 0x03, ...asciiBytes('   '),
      0x00, 0xff, 0x2f, 0x00,
    ]);

    const parsed = parseMidiFile(concatChunks(
      buildHeaderChunk(1, 4, 480),
      explicitTrack1,
      explicitTrack2,
      missingName,
      blankName,
    ));

    expect(parsed.tracks.map(({ name, hasExplicitName }) => ({ name, hasExplicitName })))
      .toEqual([
        { name: 'Track 1', hasExplicitName: true },
        { name: 'Track 2', hasExplicitName: true },
        { name: 'Track 3', hasExplicitName: false },
        { name: 'Track 4', hasExplicitName: false },
      ]);
  });

  it('retains sorted tempo, meter, marker, and UTF-8 track metadata deterministically', () => {
    const japaneseName = utf8Bytes('主旋律');
    const japaneseMarker = utf8Bytes('Aメロ');
    const track0 = buildRawTrack([
      0x00, 0xff, 0x03, ...writeVarLen(japaneseName.length), ...japaneseName,
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tick 0: 120 BPM
      0x00, 0xff, 0x58, 0x04, 0x06, 0x03, 0x24, 0x08, // tick 0: 6/8
      0x00, 0xff, 0x59, 0x02, 0xfe, 0x01, // tick 0: two flats, minor
      ...writeVarLen(240), 0xff, 0x06, ...writeVarLen(japaneseMarker.length), ...japaneseMarker,
      ...writeVarLen(240), 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40, // tick 480: 60 BPM
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const track1 = buildRawTrack([
      0x00, 0xff, 0x03, 0x04, ...asciiBytes('Bass'),
      0x00, 0xff, 0x06, 0x05, ...asciiBytes('Start'),
      ...writeVarLen(120), 0xff, 0x51, 0x03, 0x06, 0x1a, 0x80, // tick 120: 150 BPM
      0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08, // tick 120: 3/4
      ...writeVarLen(120), 0xff, 0x06, 0x01, ...asciiBytes('B'),
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const midi = concatChunks(buildHeaderChunk(1, 2, 480), track0, track1);

    const parsed = parseMidiFile(midi);

    expect(parsed).toEqual(parseMidiFile(midi));
    expect(parsed.format).toBe(1);
    expect(parsed.tempoBpm).toBeCloseTo(120);
    expect(parsed.tempoEvents).toEqual([
      { tick: 0, bpm: 120 },
      { tick: 120, bpm: 150 },
      { tick: 480, bpm: 60 },
    ]);
    expect(parsed.timeSignatures).toEqual([
      { tick: 0, numerator: 6, denominator: 8 },
      { tick: 120, numerator: 3, denominator: 4 },
    ]);
    expect(parsed.markers).toEqual([
      { tick: 0, text: 'Start', trackIndex: 1 },
      { tick: 240, text: 'Aメロ', trackIndex: 0 },
      { tick: 240, text: 'B', trackIndex: 1 },
    ]);
    expect(parsed.keySignatures).toEqual([
      { tick: 0, sharpsFlats: -2, minor: true, trackIndex: 0 },
    ]);
    expect(parsed.tracks.map((track) => track.name)).toEqual(['主旋律', 'Bass']);
  });

  it('captures only tick-zero program, bank, volume, and pan snapshots in channel order', () => {
    const track = buildRawTrack([
      0x00, 0xb5, 0x00, 0x03,
      0x00, 0xc5, 0x0a,
      0x00, 0xb2, 0x00, 0x01,
      0x00, 0xb2, 0x20, 0x02,
      0x00, 0xb2, 0x07, 0x64,
      0x00, 0xb2, 0x0a, 0x20,
      0x00, 0xc2, 0x27,
      0x00, 0xc2, 0x28, // last tick-zero program wins
      0x00, 0x92, 0x3c, 0x5a,
      0x0a, 0xc2, 0x29, // later program automation is not an initial snapshot
      0x00, 0xb2, 0x07, 0x0c, // later volume automation is not an initial snapshot
      0x0a, 0x82, 0x3c, 0x00,
      0x00, 0xff, 0x2f, 0x00,
    ]);

    const parsed = parseMidiFile(concatChunks(buildHeaderChunk(0, 1, 480), track));

    expect(parsed.tracks[0]!.initialChannels).toEqual([
      {
        channel: 2,
        program: 40,
        bankMsb: 1,
        bankLsb: 2,
        volumeCc: 100,
        panCc: 32,
      },
      { channel: 5, program: 10, bankMsb: 3 },
    ]);
    expect(parsed.tracks[0]!.notes[0]).toMatchObject({
      channel: 2,
      startTick: 0,
      durationTick: 20,
    });
    expect(parsed.tracks[0]!.hasChannelAutomation).toBe(true);
  });

  it('falls back to the legacy byte-to-Latin-1 text mapping for invalid UTF-8', () => {
    const track = buildRawTrack([
      0x00, 0xff, 0x03, 0x04, 0x43, 0x61, 0x66, 0xe9,
      0x00, 0xff, 0x06, 0x01, 0xff,
      0x00, 0xff, 0x2f, 0x00,
    ]);

    const parsed = parseMidiFile(concatChunks(buildHeaderChunk(0, 1, 480), track));

    expect(parsed.tracks[0]!.name).toBe('Café');
    expect(parsed.markers).toEqual([{ tick: 0, text: 'ÿ', trackIndex: 0 }]);
    expect(parsed.textEncodingFallbackCount).toBe(2);
  });

  it.each([
    [0, 2],
    [4, 31],
  ])('rejects unsafe time-signature metadata (%i, exponent %i)', (numerator, exponent) => {
    const track = buildRawTrack([
      0x00, 0xff, 0x58, 0x04, numerator, exponent, 0x18, 0x08,
      0x00, 0xff, 0x2f, 0x00,
    ]);

    expect(() =>
      parseMidiFile(concatChunks(buildHeaderChunk(0, 1, 480), track)),
    ).toThrow('Invalid MIDI time signature');
  });

  it.each([
    [8, 0],
    [0, 2],
  ])('rejects invalid key-signature metadata (%i, mode %i)', (sharpsFlats, mode) => {
    const track = buildRawTrack([
      0x00, 0xff, 0x59, 0x02, sharpsFlats, mode,
      0x00, 0xff, 0x2f, 0x00,
    ]);

    expect(() =>
      parseMidiFile(concatChunks(buildHeaderChunk(0, 1, 480), track)),
    ).toThrow('Invalid MIDI key signature');
  });

  it.each([
    ['tempo', 0x51, 3, [0x07, 0xa1]],
    ['time signature', 0x58, 4, [0x04, 0x02, 0x18]],
    ['key signature', 0x59, 2, [0x00]],
    ['end of track', 0x2f, 0, [0x00]],
  ] as const)(
    'rejects a %s meta event with the wrong fixed length',
    (label, metaType, expectedLength, data) => {
      const track = buildRawTrack([
        0x00, 0xff, metaType, ...writeVarLen(data.length), ...data,
        0x00, 0xff, 0x2f, 0x00,
      ]);
      const parse = () =>
        parseMidiFile(concatChunks(buildHeaderChunk(0, 1, 480), track));

      expect(parse).toThrowError(MidiImportError);
      expect(parse).toThrowError(
        expect.objectContaining({
          code: 'invalid-midi',
          message: `Invalid MIDI ${label} metadata length: expected ${expectedLength}, got ${data.length}`,
        }),
      );
    },
  );

  it('reports unmatched note events instead of silently treating them as imported notes', () => {
    const track = buildRawTrack([
      0x00, 0x80, 60, 0,
      0x00, 0x90, 61, 100,
      0x00, 0x90, 62, 90,
      0x78, 0x80, 62, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);

    const parsed = parseMidiFile(concatChunks(buildHeaderChunk(0, 1, 480), track));

    expect(parsed.tracks[0]?.notes).toEqual([
      expect.objectContaining({ pitch: 62, durationTick: 120 }),
    ]);
    expect(parsed.noteIssues).toEqual({ unmatchedNoteOns: 1, orphanNoteOffs: 1 });
  });
});

function buildRawTrack(data: number[]): Uint8Array {
  return new Uint8Array([
    0x4d, 0x54, 0x72, 0x6b,
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
    ...data,
  ]);
}

function asciiBytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    bytes.push(text.charCodeAt(i) & 0xff);
  }
  return bytes;
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}
