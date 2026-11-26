import { describe, it, expect, vi } from 'vitest';
import {
  writeVarLen,
  buildHeaderChunk,
  buildTrackChunk,
  concatChunks,
  PPQ,
} from '../src/smf.js';
import type { MidiMessage } from '../src/smf.js';
import { exportProjectToMidi, exportNotesToMidi } from '../src/export.js';
import { parseMidi } from '../src/import.js';
import { deserializeProject, expandClip, soundingEvents, serializeProject, setLengthBars, validateProject } from '@cts/project-model';
import type { Clip, Project, NoteEvent } from '@cts/project-model';

// Pass-through spy: MIDI export must map the shared sounding events.
vi.mock('@cts/project-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cts/project-model')>();
  return { ...actual, soundingEvents: vi.fn(actual.soundingEvents) };
});

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
    tracks: [
      {
        id: 'track-1',
        name: 'Piano',
        type: 'instrument',
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

  it('places 3/4 drum steps (12 per bar) a quarter beat apart', () => {
    const drumProject: Project = {
      ...project,
      timeSignature: [3, 4],
      tracks: [
        {
          id: 'track-drums',
          name: 'Drums',
          type: 'drum',
          clips: [
            {
              id: 'clip-drums',
              trackId: 'track-drums',
              type: 'drum',
              startBeat: 0,
              lengthBeats: 6, // two 3/4 bars, so step 12 is inside the clip
              loop: false,
              stepsPerBar: 12,
              drumEvents: [
                { id: 'd1', lane: 'kick', stepIndex: 0, velocity: 100 },
                { id: 'd2', lane: 'snare', stepIndex: 4, velocity: 100 },
                { id: 'd3', lane: 'kick', stepIndex: 12, velocity: 100 },
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
    };
    const parsed = parseMidi(exportProjectToMidi(drumProject));
    const drums = parsed.tracks.find((t) => t.name === 'Drums');
    const onsets = drums?.notes.map((n) => n.startBeat).sort((a, b) => a - b);
    // 1 step = 1/4 beat: step 4 is beat 1 (the 2nd beat), step 12 is beat 3 (bar 2).
    expect(onsets).toEqual([0, 1, 3]);
    expect(drums?.notes.every((n) => n.channel === 9)).toBe(true);
  });

  it('ends the exported notes at the song end after the song is shortened across a note', () => {
    // 8 bars of 4/4 with a note that starts in bar 4 and rings 8 beats, past the 4-bar line.
    const longProject: Project = {
      ...project,
      lengthBars: 8,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({
          ...c,
          lengthBeats: 32,
          notes: [
            ...(c.notes ?? []),
            { id: 'n-cross', pitch: 67, startBeat: 15, durationBeats: 8, velocity: 100 },
          ],
        })),
      })),
    };
    const shortened = setLengthBars(longProject, 4, () => new Date('2026-01-02T00:00:00Z'));
    const parsed = parseMidi(exportProjectToMidi(shortened));
    const piano = parsed.tracks.find((t) => t.name === 'Piano');
    const crossing = piano?.notes.find((n) => n.startBeat === 15);
    expect(crossing?.durationBeats).toBe(1);
    const lastEnd = Math.max(...(piano?.notes.map((n) => n.startBeat + n.durationBeats) ?? [0]));
    expect(lastEnd).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// Clip expansion is shared with live playback (US-007)
// ---------------------------------------------------------------------------
describe('exportProjectToMidi uses soundingEvents', () => {
  const loopClip: Clip = {
    id: 'loop',
    trackId: 'track-1',
    type: 'midi',
    startBeat: 4,
    lengthBeats: 8,
    contentLengthBeats: 2,
    loop: true,
    notes: [
      { id: 'a', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
      { id: 'b', pitch: 67, startBeat: 1.5, durationBeats: 1, velocity: 80 },
    ],
  };
  const loopProject: Project = {
    id: 'loop-project',
    schemaVersion: 2,
    title: 'Loop',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 4,
    tracks: [
      {
        id: 'track-1',
        name: 'Keys',
        type: 'instrument',
        clips: [loopClip],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
    ],
    chordTrack: [],
    sections: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('maps the project through soundingEvents', () => {
    const spy = vi.mocked(soundingEvents);
    spy.mockClear();
    exportProjectToMidi(loopProject);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(loopProject);
  });

  it('writes the same notes for a loop clip as expandClip returns', () => {
    const expected = expandClip(loopClip, [loopClip]).notes.map((n) => ({
      pitch: n.pitch,
      startBeat: n.startBeat,
      durationBeats: n.durationBeats,
      velocity: n.velocity,
    }));
    const parsed = parseMidi(exportProjectToMidi(loopProject));
    const written = parsed.tracks
      .flatMap((track) => track.notes)
      .map(({ pitch, startBeat, durationBeats, velocity }) => ({ pitch, startBeat, durationBeats, velocity }))
      .sort((x, y) => x.startBeat - y.startBeat || x.pitch - y.pitch);
    expect(expected).toHaveLength(8);
    expect(written).toEqual(expected);
  });

  it('has no loop unrolling of its own (no repeat by the notes\' extent)', () => {
    // The removed export-only rule repeated a loop every max(note end) beats,
    // which would write 4 notes here. expandClip's period is lengthBeats: 1 note.
    const shortPattern: Clip = { ...loopClip, contentLengthBeats: undefined, lengthBeats: 4 };
    shortPattern.notes = [{ id: 'a', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }];
    const parsed = parseMidi(
      exportProjectToMidi({ ...loopProject, tracks: [{ ...loopProject.tracks[0]!, clips: [shortPattern] }] }),
    );
    const written = parsed.tracks.flatMap((track) => track.notes).map((n) => n.startBeat);
    expect(written).toEqual(expandClip(shortPattern, [shortPattern]).notes.map((n) => n.startBeat));
    expect(written).toEqual([4]);
  });

  it('exports migrated v2 clips with the same single pass as legacy playback', () => {
    const clip: Clip = {
      ...loopClip,
      startBeat: 0,
      lengthBeats: 4,
      contentLengthBeats: undefined,
      notes: [{ id: 'a', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    const legacy = { ...loopProject, tracks: [{ ...loopProject.tracks[0]!, clips: [clip] }] };
    const migrated = deserializeProject(serializeProject(legacy));
    const reloaded = deserializeProject(serializeProject(migrated));
    for (const project of [migrated, reloaded]) {
      const written = parseMidi(exportProjectToMidi(project)).tracks.flatMap((track) => track.notes);
      expect(written.map((note) => note.startBeat)).toEqual([0]);
      expect(project.tracks[0]!.clips[0]).toMatchObject({ lengthBeats: 4, loop: false });
      expect(project.tracks[0]!.clips[0]).not.toHaveProperty('contentLengthBeats');
      expect(validateProject(project).errors).toEqual([]);
    }
  });

  it('keeps the v3 explicit loop period and the link after save and reload', () => {
    const linked: Clip = { ...loopClip, id: 'linked', startBeat: loopClip.startBeat + loopClip.lengthBeats, aliasOf: loopClip.id, notes: [] };
    const project = { ...loopProject, schemaVersion: 3, tracks: [{ ...loopProject.tracks[0]!, clips: [loopClip, linked] }] };
    const reloaded = deserializeProject(serializeProject(project));
    expect(reloaded.tracks[0]!.clips).toEqual([loopClip, linked]);
  });

  it.each([1, 2])('recovers authored v%i clip settings after saving and uses legacy live timing in MIDI', (schemaVersion) => {
    const clip: Clip = {
      ...loopClip,
      startBeat: 0,
      aliasOf: 'source',
      notes: [{ id: 'own', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    const source: Clip = { ...loopClip, id: 'source', startBeat: 8, loop: false, notes: [] };
    const legacy = { ...loopProject, schemaVersion, tracks: [{ ...loopProject.tracks[0]!, clips: [clip, source] }] };
    const migrated = deserializeProject(serializeProject(legacy));
    const reloaded = deserializeProject(serializeProject(migrated));
    for (const project of [migrated, reloaded]) {
      expect(validateProject(project).errors).toEqual([]);
      const written = parseMidi(exportProjectToMidi(project)).tracks.flatMap((track) => track.notes);
      // Legacy MIDI repeated every beat. Legacy live playback sounded the clip's own note once.
      expect(written.map(({ pitch, startBeat }) => [pitch, startBeat])).toEqual([[60, 0]]);
      expect(project.tracks[0]!.clips[0]?.legacyClipSettings).toEqual({
        loop: true, aliasOf: 'source', contentLengthBeats: 2,
      });
    }
  });
});

describe('exportProjectToMidi: long loops and mixed clip types (US-007)', () => {
  const baseTrack = {
    name: 'Part',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
  const projectWith = (tracks: Project['tracks']): Project => ({
    id: 'p',
    schemaVersion: 2,
    title: 'Long',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 32,
    tracks,
    chordTrack: [],
    sections: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });

  it('exports a drum loop of 81,920 hits without overflowing the call stack', () => {
    // 128 beats / (1/32 beat) = 4096 repeats x 20 hits = 81,920 hits.
    const drumEvents = Array.from({ length: 20 }, (_, i) => ({
      id: `h${i}`,
      lane: 'closedHat' as const,
      stepIndex: i,
      velocity: 90,
    }));
    const clip: Clip = {
      id: 'dense',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 128,
      contentLengthBeats: 1 / 32,
      loop: true,
      stepsPerBar: 4096,
      drumEvents,
    };
    const expanded = expandClip(clip, [clip], 4);
    expect(expanded.drumHits).toHaveLength(81_920);

    const bytes = exportProjectToMidi(
      projectWith([{ ...baseTrack, id: 'drums', type: 'drum', clips: [clip] }]),
    );
    const written = parseMidi(bytes).tracks.flatMap((track) => track.notes);
    expect(written).toHaveLength(81_920);
  });

  it('writes notes linked into a drum-type clip, the same as live playback', () => {
    // A midi clip at beat 0 and a drum-type clip at beat 4 that links to it, on
    // one instrument track. Playback sounds the linked notes at 0 and 4.
    const source: Clip = {
      id: 'src',
      trackId: 'keys',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    const linked: Clip = {
      id: 'link',
      trackId: 'keys',
      type: 'drum',
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      aliasOf: 'src',
    };
    const bytes = exportProjectToMidi(
      projectWith([{ ...baseTrack, id: 'keys', type: 'instrument', clips: [source, linked] }]),
    );
    const starts = parseMidi(bytes).tracks.flatMap((track) => track.notes).map((n) => n.startBeat);
    expect(starts.sort((a, b) => a - b)).toEqual([0, 4]);
  });

  it('writes no notes on a drum track and no drum hits on an instrument track, like playback', () => {
    const notesClip: Clip = {
      id: 'notes',
      trackId: 'drums',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    const hitsClip: Clip = {
      id: 'hits',
      trackId: 'keys',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'k', lane: 'kick', stepIndex: 0, velocity: 100 }],
    };
    const bytes = exportProjectToMidi(
      projectWith([
        { ...baseTrack, id: 'drums', type: 'drum', clips: [notesClip] },
        { ...baseTrack, id: 'keys', type: 'instrument', clips: [hitsClip] },
      ]),
    );
    expect(parseMidi(bytes).tracks.flatMap((track) => track.notes)).toEqual([]);
  });

  it('omits a note whose onset rounds to the clip end tick', () => {
    const clip: Clip = {
      id: 'cut',
      trackId: 'keys',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [{ id: 'tail', pitch: 64, startBeat: 3.9999, durationBeats: 1, velocity: 100 }],
    };
    expect(expandClip(clip, [clip]).notes).toEqual([]);
    const bytes = exportProjectToMidi(
      projectWith([{ ...baseTrack, id: 'keys', type: 'instrument', clips: [clip] }]),
    );
    const notes = parseMidi(bytes).tracks.flatMap((track) => track.notes);
    expect(notes).toEqual([]);
  });

  it('writes nothing that starts at or after the song end, like playback', () => {
    const clip: Clip = {
      id: 'late',
      trackId: 'keys',
      type: 'midi',
      startBeat: 124,
      lengthBeats: 8,
      loop: false,
      notes: [
        { id: 'in', pitch: 60, startBeat: 3, durationBeats: 1, velocity: 100 },
        { id: 'end', pitch: 62, startBeat: 4, durationBeats: 1, velocity: 100 },
      ],
    };
    // 32 bars of 4/4 end at beat 128: the note at 127 is written, the one at 128 is not.
    const bytes = exportProjectToMidi(
      projectWith([{ ...baseTrack, id: 'keys', type: 'instrument', clips: [clip] }]),
    );
    const starts = parseMidi(bytes).tracks.flatMap((track) => track.notes).map((n) => n.startBeat);
    expect(starts).toEqual([127]);
  });
});

describe('exportProjectToMidi: many tracks (US-010)', () => {
  /** Note-on status bytes of each MTrk chunk, read straight from the file bytes. */
  function noteOnStatusesPerTrack(bytes: Uint8Array): number[][] {
    const result: number[][] = [];
    let pos = 14; // after the MThd chunk
    while (pos < bytes.length) {
      const length = (bytes[pos + 4]! << 24) | (bytes[pos + 5]! << 16) | (bytes[pos + 6]! << 8) | bytes[pos + 7]!;
      const end = pos + 8 + length;
      let p = pos + 8;
      const statuses: number[] = [];
      const readVarLen = (): number => {
        let value = 0;
        let byte: number;
        do {
          byte = bytes[p++]!;
          value = (value << 7) | (byte & 0x7f);
        } while (byte & 0x80);
        return value;
      };
      while (p < end) {
        readVarLen(); // delta
        const status = bytes[p++]!;
        expect(status & 0x80).toBe(0x80); // the writer never uses running status
        if (status === 0xff || status === 0xf0 || status === 0xf7) {
          if (status === 0xff) p += 1; // meta type
          const dataLength = readVarLen();
          p += dataLength;
        } else {
          const kind = status & 0xf0;
          if (kind === 0x90 && bytes[p + 1]! > 0) statuses.push(status);
          p += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
        }
      }
      result.push(statuses);
      pos = end;
    }
    return result;
  }

  function projectWithInstrumentTracks(count: number): Project {
    return {
      id: 'many',
      schemaVersion: 2,
      title: 'Many',
      bpm: 120,
      timeSignature: [4, 4],
      key: 'C',
      scale: 'major',
      lengthBars: 1,
      tracks: Array.from({ length: count }, (_, i) => ({
        id: `t${i}`,
        name: `楽器 ${i + 1}`,
        type: 'instrument' as const,
        clips: [
          {
            id: `c${i}`,
            trackId: `t${i}`,
            type: 'midi' as const,
            startBeat: 0,
            lengthBeats: 4,
            loop: false,
            notes: [{ id: `n${i}`, pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
          },
        ],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      })),
      chordTrack: [],
      sections: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  // Channels 0-15 without the percussion channel 9, in order, then from 0 again.
  const CYCLE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

  it('keeps every note-on of 20 instrument tracks in 0x90-0x9F and off channel 9', () => {
    const perTrack = noteOnStatusesPerTrack(exportProjectToMidi(projectWithInstrumentTracks(20)));
    const instrumentTracks = perTrack.slice(1); // track 0 is the tempo track
    expect(instrumentTracks).toHaveLength(20);
    instrumentTracks.forEach((statuses, i) => {
      expect(statuses).toHaveLength(1);
      const status = statuses[0]!;
      expect(status).toBeGreaterThanOrEqual(0x90);
      expect(status).toBeLessThanOrEqual(0x9f);
      expect(status & 0x0f).not.toBe(9);
      expect(status & 0x0f).toBe(CYCLE[i % CYCLE.length]);
    });
  });

  it('wraps the channels so the 26th instrument track does not land on the drum channel', () => {
    const perTrack = noteOnStatusesPerTrack(exportProjectToMidi(projectWithInstrumentTracks(30)));
    const channels = perTrack.slice(1).map((statuses) => statuses[0]! & 0x0f);
    expect(channels).toEqual(Array.from({ length: 30 }, (_, i) => CYCLE[i % CYCLE.length]));
    expect(channels).not.toContain(9);
  });

  it('writes a Japanese track name as UTF-8', () => {
    const bytes = exportProjectToMidi(projectWithInstrumentTracks(1));
    const expected = new TextEncoder().encode('楽器 1');
    const at = bytes.findIndex(
      (b, i) => b === 0xff && bytes[i + 1] === 0x03 && bytes[i + 2] === expected.length,
    );
    expect(at).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.slice(at + 3, at + 3 + expected.length))).toBe('楽器 1');
  });

  it('preserves a Japanese track name across export and import', () => {
    const midi = exportProjectToMidi(projectWithInstrumentTracks(4));
    expect(parseMidi(midi).tracks.map((track) => track.name)).toContain('楽器 4');
  });

  it('preserves the legacy byte values when a track name is invalid UTF-8', () => {
    const events: MidiMessage[] = [
      { tick: 0, bytes: [0xff, 0x03, 5, 0x43, 0x61, 0x66, 0xe9, 0x80] },
      { tick: 0, bytes: [0x90, 60, 100] },
      { tick: PPQ, bytes: [0x80, 60, 0] },
    ];
    const midi = concatChunks(buildHeaderChunk(0, 1, PPQ), buildTrackChunk(events));
    expect(parseMidi(midi).tracks[0]?.name).toBe('Café\u0080');
  });

  it('refuses a song whose tracks do not fit the 16-bit track count of the header', () => {
    // 65,535 instrument tracks plus the tempo track would wrap the count to 0.
    expect(() => exportProjectToMidi(projectWithInstrumentTracks(65535))).toThrow(RangeError);
  });

  it('omits silent tracks when needed and keeps the channel of a sounding track at the end', () => {
    const project = projectWithInstrumentTracks(1);
    const sounding = project.tracks[0]!;
    const silent = Array.from({ length: 65_534 }, (_, i) => ({
      ...sounding,
      id: `silent${i}`,
      clips: [],
    }));
    project.tracks = [...silent, sounding];

    const bytes = exportProjectToMidi(project);
    expect(new DataView(bytes.buffer).getUint16(10)).toBe(2);
    expect(noteOnStatusesPerTrack(bytes)).toEqual([[], [0x9f]]);
    expect(parseMidi(bytes).tracks.map((track) => track.name)).toEqual([project.title, sounding.name]);
  });
});
