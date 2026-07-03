import { describe, it, expect } from 'vitest';
import { parseMidiFile, projectToMidi, exportNotesToMidi } from '../src/index.js';
import { buildHeaderChunk, concatChunks, writeVarLen } from '../src/smf.js';
import type { NoteEvent, Project } from '@cts/project-model';

describe('parseMidiFile', () => {
  it('parses format 0 notes exported by exportNotesToMidi', () => {
    const notes: NoteEvent[] = [
      { id: 'n1', pitch: 72, startBeat: 0.5, durationBeats: 1.25, velocity: 77 },
    ];

    const midi = exportNotesToMidi(notes, 150, { ppq: 240, channel: 2 });
    const parsed = parseMidiFile(midi);

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
