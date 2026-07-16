import { describe, it, expect } from 'vitest';
import {
  writeVarLen,
  buildHeaderChunk,
  buildTrackChunk,
  concatChunks,
  PPQ,
} from '../src/smf.js';
import type { MidiMessage } from '../src/smf.js';
import { exportProjectToMidi, exportNotesToMidi } from '../src/export.js';
import type { Project, NoteEvent } from '@cts/project-model';

type ParsedMidiEvent = {
  tick: number;
  status: number;
  data: number[];
};

function readVarLenAt(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor++] ?? 0;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { value, offset: cursor };
}

function midiTracks(midi: Uint8Array): Uint8Array[] {
  const view = new DataView(midi.buffer, midi.byteOffset, midi.byteLength);
  const tracks: Uint8Array[] = [];
  let offset = 14;
  while (offset < midi.length) {
    const length = view.getUint32(offset + 4, false);
    tracks.push(midi.slice(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return tracks;
}

function parseTrackEvents(track: Uint8Array): ParsedMidiEvent[] {
  const events: ParsedMidiEvent[] = [];
  let offset = 0;
  let tick = 0;
  let runningStatus = 0;

  while (offset < track.length) {
    const delta = readVarLenAt(track, offset);
    tick += delta.value;
    offset = delta.offset;

    let status = track[offset++] ?? 0;
    if (status < 0x80) {
      offset--;
      status = runningStatus;
    } else if (status < 0xf0) {
      runningStatus = status;
    }

    if (status === 0xff) {
      const type = track[offset++] ?? 0;
      const length = readVarLenAt(track, offset);
      offset = length.offset + length.value;
      if (type === 0x2f) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = readVarLenAt(track, offset);
      offset = length.offset + length.value;
      continue;
    }

    const dataLength = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
    const data = Array.from(track.slice(offset, offset + dataLength));
    offset += dataLength;
    events.push({ tick, status, data });
  }

  return events;
}

function noteOnTicks(midi: Uint8Array, status: number, pitch: number): number[] {
  return midiTracks(midi)
    .flatMap((track) => parseTrackEvents(track))
    .filter((event) => event.status === status && event.data[0] === pitch && (event.data[1] ?? 0) > 0)
    .map((event) => event.tick);
}

function drumStepToBeat(
  stepIndex: number,
  stepsPerBar: number,
  beatsPerBar: number,
  clipStartBeat: number,
): number {
  const steps = stepsPerBar > 0 ? stepsPerBar : 16;
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  return clipStartBeat + stepIndex * (bpb / steps);
}

// ---------------------------------------------------------------------------
// writeVarLen
// ---------------------------------------------------------------------------
describe('writeVarLen', () => {
  it('encodes 0 as [0x00]', () => {
    expect(writeVarLen(0)).toEqual([0x00]);
  });

  it('encodes 127 as [0x7F]', () => {
    expect(writeVarLen(127)).toEqual([0x7f]);
  });

  it('encodes 128 as [0x81, 0x00]', () => {
    expect(writeVarLen(128)).toEqual([0x81, 0x00]);
  });

  // SMF spec: the value that encodes to [0x81, 0x80, 0x80, 0x00] is 0x200000 (2^21).
  // 0x100000 (2^20) encodes as [0xC0, 0x80, 0x00] (3 bytes).
  it('encodes 0x200000 as [0x81, 0x80, 0x80, 0x00]', () => {
    expect(writeVarLen(0x200000)).toEqual([0x81, 0x80, 0x80, 0x00]);
  });

  it('encodes 0x100000 as [0xC0, 0x80, 0x00]', () => {
    expect(writeVarLen(0x100000)).toEqual([0xc0, 0x80, 0x00]);
  });

  it('throws for negative values', () => {
    expect(() => writeVarLen(-1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// buildHeaderChunk
// ---------------------------------------------------------------------------
describe('buildHeaderChunk', () => {
  it('starts with ASCII "MThd"', () => {
    const hdr = buildHeaderChunk(1, 3, PPQ);
    expect(hdr[0]).toBe(0x4d); // M
    expect(hdr[1]).toBe(0x54); // T
    expect(hdr[2]).toBe(0x68); // h
    expect(hdr[3]).toBe(0x64); // d
  });

  it('has chunk length 6', () => {
    const hdr = buildHeaderChunk(1, 3, PPQ);
    const view = new DataView(hdr.buffer);
    expect(view.getUint32(4, false)).toBe(6);
  });

  it('encodes format correctly', () => {
    const hdr = buildHeaderChunk(1, 3, PPQ);
    const view = new DataView(hdr.buffer);
    expect(view.getUint16(8, false)).toBe(1);
  });

  it('encodes numTracks correctly', () => {
    const hdr = buildHeaderChunk(1, 5, PPQ);
    const view = new DataView(hdr.buffer);
    expect(view.getUint16(10, false)).toBe(5);
  });

  it('encodes ticksPerQuarter correctly', () => {
    const hdr = buildHeaderChunk(1, 3, 960);
    const view = new DataView(hdr.buffer);
    expect(view.getUint16(12, false)).toBe(960);
  });
});

// ---------------------------------------------------------------------------
// buildTrackChunk
// ---------------------------------------------------------------------------
describe('buildTrackChunk', () => {
  it('starts with ASCII "MTrk"', () => {
    const trk = buildTrackChunk([]);
    expect(trk[0]).toBe(0x4d); // M
    expect(trk[1]).toBe(0x54); // T
    expect(trk[2]).toBe(0x72); // r
    expect(trk[3]).toBe(0x6b); // k
  });

  it('ends with end-of-track meta (FF 2F 00)', () => {
    const trk = buildTrackChunk([]);
    // After 8-byte header: delta(0x00) FF 2F 00
    expect(trk[8]).toBe(0x00);
    expect(trk[9]).toBe(0xff);
    expect(trk[10]).toBe(0x2f);
    expect(trk[11]).toBe(0x00);
  });

  it('sorts messages by tick', () => {
    const msgs: MidiMessage[] = [
      { tick: 480, bytes: [0x90, 60, 100] },
      { tick: 0, bytes: [0x90, 62, 90] },
    ];
    const trk = buildTrackChunk(msgs);
    // First event after header (8 bytes): delta=0 then 0x90 62 90
    expect(trk[8]).toBe(0x00); // delta
    expect(trk[9]).toBe(0x90);
    expect(trk[10]).toBe(62);
  });

  it('converts absolute ticks to delta times', () => {
    const msgs: MidiMessage[] = [
      { tick: 0, bytes: [0x90, 60, 100] },
      { tick: 480, bytes: [0x80, 60, 0] },
    ];
    const trk = buildTrackChunk(msgs);
    // Second event delta: 480 encoded as varlen [0x83, 0x60]
    // After header(8) + delta(1) + 3 bytes = index 12 for second delta
    const secondDelta = trk.slice(12, 14);
    expect(Array.from(secondDelta)).toEqual([0x83, 0x60]);
  });
});

// ---------------------------------------------------------------------------
// concatChunks
// ---------------------------------------------------------------------------
describe('concatChunks', () => {
  it('concatenates multiple arrays', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const result = concatChunks(a, b);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles empty input', () => {
    expect(concatChunks().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tempo meta bytes for bpm=120
// ---------------------------------------------------------------------------
describe('exportNotesToMidi tempo meta', () => {
  it('encodes bpm=120 as 500000 µs/qtr (FF 51 03 07 A1 20)', () => {
    const note: NoteEvent = { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 };
    const midi = exportNotesToMidi([note], 120);
    // Header is 14 bytes, then MTrk chunk starts
    // MTrk header is 8 bytes, then delta(0x00), then FF 51 03 07 A1 20
    const trackStart = 14 + 8;
    expect(midi[trackStart]).toBe(0x00);     // delta
    expect(midi[trackStart + 1]).toBe(0xff); // meta
    expect(midi[trackStart + 2]).toBe(0x51); // tempo type
    expect(midi[trackStart + 3]).toBe(0x03); // length
    // 500000 = 0x07A120
    expect(midi[trackStart + 4]).toBe(0x07);
    expect(midi[trackStart + 5]).toBe(0xa1);
    expect(midi[trackStart + 6]).toBe(0x20);
  });
});

// ---------------------------------------------------------------------------
// exportNotesToMidi: single-note round-trip
// ---------------------------------------------------------------------------
describe('exportNotesToMidi', () => {
  it('produces valid SMF bytes starting with MThd', () => {
    const note: NoteEvent = { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 };
    const midi = exportNotesToMidi([note], 120);
    expect(midi[0]).toBe(0x4d); // M
    expect(midi[1]).toBe(0x54); // T
    expect(midi[2]).toBe(0x68); // h
    expect(midi[3]).toBe(0x64); // d
  });

  it('contains at least one MTrk', () => {
    const note: NoteEvent = { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 };
    const midi = exportNotesToMidi([note], 120);
    let found = false;
    for (let i = 0; i < midi.length - 3; i++) {
      if (midi[i] === 0x4d && midi[i+1] === 0x54 && midi[i+2] === 0x72 && midi[i+3] === 0x6b) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('contains a noteOn (0x90) for the exported note', () => {
    const note: NoteEvent = { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 };
    const midi = exportNotesToMidi([note], 120);
    const hasNoteOn = Array.from(midi).some((b, i) =>
      b === 0x90 && midi[i + 1] === 60 && midi[i + 2] === 100,
    );
    expect(hasNoteOn).toBe(true);
  });

  it('contains a matching noteOff (0x80) for the exported note', () => {
    const note: NoteEvent = { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 };
    const midi = exportNotesToMidi([note], 120);
    const hasNoteOff = Array.from(midi).some((b, i) =>
      b === 0x80 && midi[i + 1] === 60,
    );
    expect(hasNoteOff).toBe(true);
  });

  it('keeps a positive note at least one tick long with very low PPQ', () => {
    const note: NoteEvent = {
      id: 'short',
      pitch: 60,
      startBeat: 0,
      durationBeats: 0.25,
      velocity: 100,
    };
    const midi = exportNotesToMidi([note], 120, { ppq: 1 });
    const track = midiTracks(midi)[0];
    expect(track).toBeDefined();
    const noteEvents = parseTrackEvents(track!).filter(
      (event) =>
        ((event.status & 0xf0) === 0x80 || (event.status & 0xf0) === 0x90) &&
        event.data[0] === note.pitch,
    );

    expect(noteEvents).toEqual([
      { tick: 0, status: 0x90, data: [60, 100] },
      { tick: 1, status: 0x80, data: [60, 0] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// exportProjectToMidi: integration test with inline Project literal
// ---------------------------------------------------------------------------
describe('exportProjectToMidi', () => {
  const project: Project = {
    id: 'test-project',
    schemaVersion: 1,
    title: 'Test Song',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 4,
    lengthBeats: 16,
    tempoMap: [{ id: 'test-tempo-0', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'test-meter-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    automationLanes: [],
    audioRouting: {
      outputs: [{ sourceTrackId: 'track-1', destination: { type: 'master' } }],
      sends: [],
    },
    tracks: [
      {
        id: 'track-1',
        name: 'Piano',
        type: 'instrument',
        role: 'general',
        clips: [
          {
            id: 'clip-1',
            trackId: 'track-1',
            type: 'midi',
            startBeat: 0,
            lengthBeats: 4,
            loop: false,
            notes: [
              { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
              { id: 'n2', pitch: 64, startBeat: 1, durationBeats: 1, velocity: 90 },
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
    chordTrack: [
      {
        id: 'chord-1',
        startBeat: 0,
        durationBeats: 4,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [60, 64, 67],
      },
    ],
    sections: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('starts with MThd', () => {
    const midi = exportProjectToMidi(project);
    expect(midi[0]).toBe(0x4d);
    expect(midi[1]).toBe(0x54);
    expect(midi[2]).toBe(0x68);
    expect(midi[3]).toBe(0x64);
  });

  it('declares format 1 in header', () => {
    const midi = exportProjectToMidi(project);
    const view = new DataView(midi.buffer);
    expect(view.getUint16(8, false)).toBe(1);
  });

  it('declares correct track count (tempo/meta + 1 instrument = 2; chords are markers)', () => {
    const midi = exportProjectToMidi(project);
    const view = new DataView(midi.buffer);
    expect(view.getUint16(10, false)).toBe(2);
  });

  it('writes chord symbols as FF 06 marker meta events on the tempo track', () => {
    const midi = exportProjectToMidi(project);
    // FF 06 01 'C' (0x43) — marker meta for the "C" chord symbol.
    const hasMarker = Array.from(midi).some((b, i) =>
      b === 0xff && midi[i + 1] === 0x06 && midi[i + 2] === 0x01 && midi[i + 3] === 0x43,
    );
    expect(hasMarker).toBe(true);
  });

  it('contains at least one MTrk', () => {
    const midi = exportProjectToMidi(project);
    let found = false;
    for (let i = 0; i < midi.length - 3; i++) {
      if (midi[i] === 0x4d && midi[i+1] === 0x54 && midi[i+2] === 0x72 && midi[i+3] === 0x6b) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('contains noteOn bytes for pitch 60', () => {
    const midi = exportProjectToMidi(project);
    const hasNoteOn = Array.from(midi).some((b, i) =>
      b === 0x90 && midi[i + 1] === 60,
    );
    expect(hasNoteOn).toBe(true);
  });

  it('uses PPQ 480 by default', () => {
    const midi = exportProjectToMidi(project);
    const view = new DataView(midi.buffer);
    expect(view.getUint16(12, false)).toBe(480);
  });

  it('accepts custom ppq option', () => {
    const midi = exportProjectToMidi(project, { ppq: 960 });
    const view = new DataView(midi.buffer);
    expect(view.getUint16(12, false)).toBe(960);
  });

  it('exports 3/4 drum steps at the same beats as drumStepToBeat', () => {
    const drumProject: Project = {
      ...project,
      timeSignature: [3, 4],
      lengthBars: 2,
      lengthBeats: 6,
      timeSignatureMap: [{
        id: 'test-meter-three-four',
        beat: 0,
        numerator: 3,
        denominator: 4,
      }],
      tracks: [
        {
          id: 'track-drums',
          name: 'Drums',
          type: 'drum',
          role: 'general',
          clips: [
            {
              id: 'clip-drums',
              trackId: 'track-drums',
              type: 'drum',
              startBeat: 3,
              lengthBeats: 6,
              loop: false,
              stepsPerBar: 16,
              drumEvents: [
                { id: 'd1', lane: 'kick', stepIndex: 0, velocity: 100 },
                { id: 'd2', lane: 'kick', stepIndex: 8, velocity: 100 },
                { id: 'd3', lane: 'kick', stepIndex: 16, velocity: 100 },
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
    };

    const midi = exportProjectToMidi(drumProject);
    const expectedBeats = [0, 8, 16].map((stepIndex) => drumStepToBeat(stepIndex, 16, 3, 3));
    expect(noteOnTicks(midi, 0x99, 36)).toEqual(expectedBeats.map((beat) => Math.round(beat * PPQ)));
  });

  it('exports 6/8 drum steps in quarter-note beats', () => {
    const drumProject: Project = {
      ...project,
      timeSignature: [6, 8],
      lengthBars: 1,
      lengthBeats: 3,
      timeSignatureMap: [{
        id: 'test-meter-six-eight',
        beat: 0,
        numerator: 6,
        denominator: 8,
      }],
      tracks: [
        {
          id: 'track-six-eight',
          name: 'Six Eight Drums',
          type: 'drum',
          role: 'general',
          clips: [
            {
              id: 'clip-six-eight',
              trackId: 'track-six-eight',
              type: 'drum',
              startBeat: 0,
              lengthBeats: 3,
              loop: false,
              stepsPerBar: 16,
              drumEvents: [{ id: 'middle', lane: 'kick', stepIndex: 8, velocity: 100 }],
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
    };

    const midi = exportProjectToMidi(drumProject);
    expect(noteOnTicks(midi, 0x99, 36)).toEqual([Math.round(1.5 * PPQ)]);
  });

  it('rejects invalid 3/4 drum stepsPerBar instead of applying a playback fallback', () => {
    const drumProject: Project = {
      ...project,
      timeSignature: [3, 4],
      lengthBars: 2,
      lengthBeats: 6,
      timeSignatureMap: [{
        id: 'test-meter-fallback-three-four',
        beat: 0,
        numerator: 3,
        denominator: 4,
      }],
      tracks: [
        {
          id: 'track-drums',
          name: 'Drums',
          type: 'drum',
          role: 'general',
          clips: [
            {
              id: 'clip-drums',
              trackId: 'track-drums',
              type: 'drum',
              startBeat: 3,
              lengthBeats: 6,
              loop: false,
              stepsPerBar: 0,
              drumEvents: [
                { id: 'd1', lane: 'kick', stepIndex: 8, velocity: 100 },
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
    };

    expect(() => exportProjectToMidi(drumProject)).toThrowError(
      expect.objectContaining({ code: 'invalid-project' }),
    );
  });

  it('keeps 4/4 drum step export timing unchanged', () => {
    const drumProject: Project = {
      ...project,
      tracks: [
        {
          id: 'track-drums',
          name: 'Drums',
          type: 'drum',
          role: 'general',
          clips: [
            {
              id: 'clip-drums',
              trackId: 'track-drums',
              type: 'drum',
              startBeat: 0,
              lengthBeats: 4,
              loop: false,
              stepsPerBar: 16,
              drumEvents: [
                { id: 'd1', lane: 'kick', stepIndex: 0, velocity: 100 },
                { id: 'd2', lane: 'kick', stepIndex: 8, velocity: 100 },
                { id: 'd3', lane: 'kick', stepIndex: 16, velocity: 100 },
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
    };

    const midi = exportProjectToMidi(drumProject);
    expect(noteOnTicks(midi, 0x99, 36)).toEqual([0, 2 * PPQ, 4 * PPQ]);
  });
});
