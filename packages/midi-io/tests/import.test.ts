import { describe, expect, it } from 'vitest';
import type { Project } from '@cts/project-model';
import { projectToMidi } from '../src/export.js';
import { parseMidi, type ParsedMidiNote } from '../src/import.js';
import { buildHeaderChunk, concatChunks, PPQ, writeVarLen } from '../src/smf.js';

function trackChunk(data: number[]): Uint8Array {
  const header = [
    0x4d, 0x54, 0x72, 0x6b,
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
  ];
  return new Uint8Array([...header, ...data]);
}

function noteSummary(note: ParsedMidiNote): Omit<ParsedMidiNote, 'channel'> {
  return {
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
  };
}

describe('parseMidi', () => {
  it('parses format 0 notes with running status, tempo, and time signature', () => {
    const track = trackChunk([
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08,
      0x00, 0x90, 60, 100,
      ...writeVarLen(PPQ), 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const parsed = parseMidi(concatChunks(buildHeaderChunk(0, 1, PPQ), track));

    expect(parsed.format).toBe(0);
    expect(parsed.ppq).toBe(PPQ);
    expect(parsed.bpm).toBe(120);
    expect(parsed.timeSignature).toEqual([3, 4]);
    expect(parsed.tempos[0]?.microsecondsPerQuarter).toBe(500000);
    expect(parsed.timeSignatures[0]?.numerator).toBe(3);

    const note = parsed.tracks[0]?.notes[0];
    expect(note).toBeDefined();
    expect(note ? noteSummary(note) : null).toEqual({
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 100,
    });
  });

  it('round-trips projectToMidi format 1 instrument notes', () => {
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
              id: 'lead-clip',
              trackId: 'lead',
              type: 'midi',
              startBeat: 1,
              lengthBeats: 4,
              loop: false,
              notes: [
                { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 0.5, velocity: 96 },
                { id: 'n2', pitch: 64, startBeat: 1.25, durationBeats: 1.5, velocity: 88 },
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
          id: 'harmony',
          name: 'Harmony',
          type: 'instrument',
          clips: [
            {
              id: 'harmony-clip',
              trackId: 'harmony',
              type: 'midi',
              startBeat: 0,
              lengthBeats: 4,
              loop: false,
              notes: [
                { id: 'n3', pitch: 67, startBeat: 2, durationBeats: 1, velocity: 72 },
              ],
            },
          ],
          volume: 0.8,
          pan: 0.25,
          mute: false,
          solo: false,
          effects: [],
        },
      ],
      chordTrack: [],
      sections: [],
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
    };

    const parsed = parseMidi(projectToMidi(project));

    expect(parsed.format).toBe(1);
    expect(parsed.ppq).toBe(PPQ);
    expect(parsed.bpm).toBeCloseTo(90, 3);
    expect(parsed.timeSignature).toEqual([4, 4]);
    expect(parsed.tracks.map((track) => track.name)).toEqual(['Round Trip', 'Lead', 'Harmony']);
    expect(parsed.tracks[1]?.notes.map(noteSummary)).toEqual([
      { pitch: 60, startBeat: 1, durationBeats: 0.5, velocity: 96 },
      { pitch: 64, startBeat: 2.25, durationBeats: 1.5, velocity: 88 },
    ]);
    expect(parsed.tracks[2]?.notes.map(noteSummary)).toEqual([
      { pitch: 67, startBeat: 2, durationBeats: 1, velocity: 72 },
    ]);
  });
});
