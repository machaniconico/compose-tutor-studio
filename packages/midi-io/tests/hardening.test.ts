import { describe, expect, it } from 'vitest';
import type { Project } from '@cts/project-model';
import {
  DEFAULT_MIDI_PARSE_LIMITS,
  MAX_MIDI_EXPORT_EVENTS,
  MidiExportError,
  MidiImportError,
  buildHeaderChunk,
  concatChunks,
  exportNotesToMidi,
  parseMidiFile,
  projectToMidi,
  projectToMidiResult,
} from '../src/index.js';

function rawTrack(data: readonly number[]): Uint8Array {
  const result = new Uint8Array(8 + data.length);
  result.set([
    0x4d, 0x54, 0x72, 0x6b,
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
  ]);
  result.set(data, 8);
  return result;
}

function formatZeroMidi(data: readonly number[]): Uint8Array {
  return concatChunks(buildHeaderChunk(0, 1, 480), rawTrack(data));
}

function projectWithLoop(lengthBeats: number): Project {
  return {
    id: 'bounded-export',
    schemaVersion: 1,
    title: 'Bounded export',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    tracks: [
      {
        id: 'lead',
        name: 'Lead',
        type: 'instrument',
        clips: [
          {
            id: 'loop',
            trackId: 'lead',
            type: 'midi',
            startBeat: 0,
            lengthBeats,
            loop: true,
            notes: [
              { id: 'note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
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
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
}

type MidiTextField = 'project title' | 'track name' | 'chord marker';

function setMidiText(project: Project, field: MidiTextField, text: string): void {
  if (field === 'project title') {
    project.title = text;
    return;
  }
  if (field === 'track name') {
    project.tracks[0]!.name = text;
    return;
  }
  project.chordTrack = [
    {
      id: 'bounded-marker',
      startBeat: 0,
      durationBeats: 4,
      symbol: text,
      root: 'C',
      quality: 'major',
      notes: [0, 4, 7],
    },
  ];
}

describe('bounded MIDI parsing', () => {
  it('pairs overlapping same-key notes FIFO without Array.shift semantics', () => {
    const parsed = parseMidiFile(formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x0a, 60, 80,
      0x0a, 60, 0,
      0x0a, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]));

    expect(parsed.tracks[0]!.notes).toEqual([
      expect.objectContaining({ startTick: 0, durationTick: 20, velocity: 100 }),
      expect.objectContaining({ startTick: 10, durationTick: 20, velocity: 80 }),
    ]);
  });

  it('stops at the event budget with a structured error', () => {
    const midi = formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x01, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const parse = () => parseMidiFile(midi, { limits: { maxEvents: 2 } });
    expect(parse).toThrowError(MidiImportError);
    expect(parse).toThrowError(
      expect.objectContaining({ code: 'event-limit-exceeded', limit: 2 }),
    );
  });

  it('stops while producing notes rather than normalizing an oversized array', () => {
    const midi = formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x01, 60, 0,
      0x00, 0x90, 62, 100,
      0x01, 62, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    expect(() => parseMidiFile(midi, { limits: { maxNotes: 1 } })).toThrowError(
      expect.objectContaining({ code: 'note-limit-exceeded', limit: 1 }),
    );
  });

  it('bounds overlapping active-note depth before queue growth', () => {
    const midi = formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x00, 60, 90,
      0x00, 60, 0,
      0x00, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    expect(() =>
      parseMidiFile(midi, { limits: { maxActiveNotesPerKey: 1 } }),
    ).toThrowError(
      expect.objectContaining({
        code: 'active-note-limit-exceeded',
        limit: 1,
      }),
    );
  });

  it('bounds tempo events before building the prefix timeline', () => {
    const midi = formatZeroMidi([
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    expect(() => parseMidiFile(midi, { limits: { maxTempoEvents: 1 } })).toThrowError(
      expect.objectContaining({ code: 'tempo-event-limit-exceeded', limit: 1 }),
    );
  });

  it('uses a tempo prefix timeline across multiple tempo regions', () => {
    const parsed = parseMidiFile(formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x78, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
      0x78, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x78, 0x80, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]));

    // 120 ticks at 120 BPM + 120 at 60 BPM + 120 at 120 BPM, PPQ 480.
    expect(parsed.tracks[0]!.notes[0]!.durationSeconds).toBeCloseTo(0.5);
  });

  it('does not allow callers to raise hard parser ceilings', () => {
    const midi = formatZeroMidi([0x00, 0xff, 0x2f, 0x00]);
    expect(() =>
      parseMidiFile(midi, {
        limits: { maxNotes: DEFAULT_MIDI_PARSE_LIMITS.maxNotes + 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-options' }));
  });
});

describe('bounded MIDI project export', () => {
  it('returns bytes and an exact event count for a normal project', () => {
    const result = projectToMidiResult(projectWithLoop(4));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eventCount).toBe(17); // Includes MIDI Port and both end-of-track events.
    expect(result.bytes).toEqual(projectToMidi(projectWithLoop(4)));
  });

  it('returns a structured limit failure before a huge loop expands', () => {
    const result = projectToMidiResult(projectWithLoop(100_000), { maxEvents: 64 });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'event-limit-exceeded', limit: 64 }),
    });
  });

  it('turns the compatibility API failure into MidiExportError, not RangeError', () => {
    const exportMidi = () => projectToMidi(projectWithLoop(100_000), { maxEvents: 64 });
    expect(exportMidi).toThrowError(MidiExportError);
    expect(exportMidi).toThrowError(
      expect.objectContaining({ code: 'event-limit-exceeded', limit: 64 }),
    );
  });

  it('exports a large bounded loop without spread-call stack overflow', () => {
    const result = projectToMidiResult(projectWithLoop(90_000));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eventCount).toBe(180_009);
    expect(result.bytes.byteLength).toBeGreaterThan(500_000);
  });

  it('rejects subnormal loop patterns before iterating', () => {
    const project = projectWithLoop(32);
    project.tracks[0]!.clips[0]!.notes![0]!.durationBeats = Number.MIN_VALUE;
    const result = projectToMidiResult(project);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'event-limit-exceeded' }),
    });
  });

  it.each([
    { field: 'pitch' as const, value: 128 },
    { field: 'velocity' as const, value: 0 },
  ])('rejects invalid $field even when a low-PPQ occurrence would be omitted', ({
    field,
    value,
  }) => {
    const project = projectWithLoop(0.25);
    const note = project.tracks[0]!.clips[0]!.notes![0]!;
    note.durationBeats = 0.25;
    note[field] = value;

    expect(projectToMidiResult(project, { ppq: 1 })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('bounds cumulative note-projection work across many fully omitted clips', () => {
    const build = (clipCount: number) => {
      const project = projectWithLoop(0.499);
      const source = project.tracks[0]!.clips[0]!;
      project.tracks[0]!.clips = Array.from({ length: clipCount }, (_, index) => ({
        ...source,
        id: `omitted-loop-${index}`,
        notes: [{
          id: `omitted-note-${index}`,
          pitch: 60,
          startBeat: 0,
          durationBeats: 1 / 960,
          velocity: 100,
        }],
      }));
      return project;
    };

    const below = projectToMidiResult(build(208), { ppq: 1 });
    expect(below).toMatchObject({ ok: true, eventCount: 9 });
    expect(projectToMidiResult(build(209), { ppq: 1 })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'event-limit-exceeded',
        limit: MAX_MIDI_EXPORT_EVENTS,
      }),
    });
  });

  it('returns structured option errors', () => {
    expect(projectToMidiResult(projectWithLoop(4), { ppq: 0 })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-options' }),
    });
  });

  it.each([
    { label: 'negative', value: -1 },
    { label: 'above 127', value: 128 },
    { label: 'fractional', value: 60.5 },
    { label: 'NaN', value: Number.NaN },
  ])('rejects a $label authored note pitch before serializing', ({ value }) => {
    const project = projectWithLoop(4);
    project.tracks[0]!.clips[0]!.notes![0]!.pitch = value;

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
    expect(() => exportNotesToMidi(project.tracks[0]!.clips[0]!.notes!, 120)).toThrowError(
      expect.objectContaining({ code: 'invalid-project' }),
    );
  });

  it.each([
    { label: 'zero', value: 0 },
    { label: 'negative', value: -1 },
    { label: 'above 127', value: 128 },
    { label: 'fractional', value: 100.5 },
    { label: 'NaN', value: Number.NaN },
  ])('rejects a $label authored note velocity before serializing', ({ value }) => {
    const project = projectWithLoop(4);
    project.tracks[0]!.clips[0]!.notes![0]!.velocity = value;

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
    expect(() => exportNotesToMidi(project.tracks[0]!.clips[0]!.notes!, 120)).toThrowError(
      expect.objectContaining({ code: 'invalid-project' }),
    );
  });

  it.each([
    { label: 'zero', value: 0 },
    { label: 'above 127', value: 128 },
    { label: 'fractional', value: 80.5 },
    { label: 'NaN', value: Number.NaN },
  ])('rejects a $label drum velocity before serializing', ({ value }) => {
    const project = projectWithLoop(4);
    const track = project.tracks[0]!;
    track.type = 'drum';
    track.clips = [
      {
        id: 'drum-clip',
        trackId: track.id,
        type: 'drum',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        stepsPerBar: 16,
        drumEvents: [{ id: 'drum-hit', lane: 'kick', stepIndex: 0, velocity: value }],
      },
    ];

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects an unknown runtime drum lane instead of writing an undefined pitch byte', () => {
    const project = projectWithLoop(4);
    const track = project.tracks[0]!;
    track.type = 'drum';
    track.clips = [
      {
        id: 'drum-clip',
        trackId: track.id,
        type: 'drum',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        stepsPerBar: 16,
        drumEvents: [
          {
            id: 'drum-hit',
            lane: 'unknown' as never,
            stepIndex: 0,
            velocity: 100,
          },
        ],
      },
    ];

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects a drum clip on an instrument track before destinations can collide', () => {
    const project = projectWithLoop(4);
    const track = project.tracks[0]!;
    track.clips = [{
      id: 'wrong-drum-clip',
      trackId: track.id,
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'kick', lane: 'kick', stepIndex: 0, velocity: 100 }],
    }];

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects a MIDI clip on a drum track instead of reinterpreting pitches as percussion', () => {
    const project = projectWithLoop(4);
    project.tracks[0]!.type = 'drum';

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects conflicting clip payloads and containing-track references', () => {
    const conflicting = projectWithLoop(4);
    conflicting.tracks[0]!.clips[0]!.drumEvents = [
      { id: 'kick', lane: 'kick', stepIndex: 0, velocity: 100 },
    ];
    expect(projectToMidiResult(conflicting)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });

    const mismatchedTrack = projectWithLoop(4);
    mismatchedTrack.tracks[0]!.clips[0]!.trackId = 'another-track';
    expect(projectToMidiResult(mismatchedTrack)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it.each([60.5, -1, 128, Number.NaN])(
    'rejects invalid source chord pitch %s before chord realization',
    (pitch) => {
      const project = projectWithLoop(4);
      project.chordTrack = [{
        id: 'invalid-chord',
        startBeat: 0,
        durationBeats: 4,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [pitch],
      }];

      expect(projectToMidiResult(project)).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'invalid-project' }),
      });
    },
  );

  it('deliberately omits valid automation and audio clips from the MIDI projection', () => {
    const project = projectWithLoop(4);
    const instrument = project.tracks[0]!;
    instrument.clips.push({
      id: 'automation',
      trackId: instrument.id,
      type: 'automation',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
    });
    project.tracks.push({
      id: 'audio-track',
      name: 'Audio',
      type: 'audio',
      clips: [{
        id: 'audio-clip',
        trackId: 'audio-track',
        type: 'audio',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        audioAssetId: 'asset-1',
      }],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    });

    const result = projectToMidiResult(project);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.bytes).toEqual(projectToMidi(projectWithLoop(4)));
    const parsed = parseMidiFile(result.bytes);
    expect(parsed.tracks.some((track) => track.name === 'Audio')).toBe(false);
    expect(parsed.tracks.filter((track) => track.notes.length > 0)).toHaveLength(1);
  });

  it('rejects a 129th independent drum port instead of wrapping the port byte', () => {
    const project = projectWithLoop(4);
    const source = project.tracks[0]!;
    project.tracks = Array.from({ length: 129 }, (_, index) => ({
      ...source,
      id: `drum-${index}`,
      name: `Drums ${index + 1}`,
      type: 'drum' as const,
      clips: [],
    }));

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-project',
        limit: 127,
        observed: 128,
      }),
    });
  });

  it.each([
    { field: 'volume' as const, value: Number.NaN },
    { field: 'volume' as const, value: Number.POSITIVE_INFINITY },
    { field: 'volume' as const, value: 2.01 },
    { field: 'pan' as const, value: Number.NaN },
    { field: 'pan' as const, value: Number.NEGATIVE_INFINITY },
    { field: 'pan' as const, value: 1.01 },
  ])('rejects invalid track $field=$value before writing CC data', ({ field, value }) => {
    const project = projectWithLoop(4);
    project.tracks[0]![field] = value;

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it.each<MidiTextField>(['project title', 'track name', 'chord marker'])(
    'accepts a %s whose UTF-8 encoding is exactly 4096 bytes',
    (field) => {
      const project = projectWithLoop(4);
      setMidiText(project, field, `${'界'.repeat(1_365)}a`);

      expect(projectToMidiResult(project)).toMatchObject({ ok: true });
    },
  );

  it.each<MidiTextField>(['project title', 'track name', 'chord marker'])(
    'rejects a %s whose UTF-8 encoding exceeds 4096 bytes',
    (field) => {
      const project = projectWithLoop(4);
      setMidiText(project, field, `${'界'.repeat(1_365)}ab`);

      expect(projectToMidiResult(project)).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: 'invalid-project',
          limit: 4_096,
          observed: 4_097,
        }),
      });
    },
  );

  it('preserves the one-byte ASCII boundary', () => {
    const accepted = projectWithLoop(4);
    accepted.title = 'a'.repeat(4_096);
    const rejected = projectWithLoop(4);
    rejected.title = 'a'.repeat(4_097);

    expect(projectToMidiResult(accepted)).toMatchObject({ ok: true });
    expect(projectToMidiResult(rejected)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-project',
        limit: 4_096,
        observed: 4_097,
      }),
    });
  });
});
