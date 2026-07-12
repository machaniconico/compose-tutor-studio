import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  validateProject,
  type ChordEvent,
  type Clip,
  type NoteEvent,
  type Project,
  type Track,
} from '@cts/project-model';
import {
  MidiExportError,
  projectToMidi,
  projectToMidiResult,
} from '../src/index.js';

function note(
  id: string,
  pitch: number,
  startBeat: number,
  durationBeats: number,
): NoteEvent {
  return { id, pitch, startBeat, durationBeats, velocity: 100 };
}

function midiClip(
  id: string,
  trackId: string,
  startBeat: number,
  lengthBeats: number,
  notes: NoteEvent[],
  loop = false,
): Clip {
  return { id, trackId, type: 'midi', startBeat, lengthBeats, loop, notes };
}

function instrumentTrack(id: string, name: string, clips: Clip[]): Track {
  return {
    id,
    name,
    type: 'instrument',
    clips,
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'synth', preset: 'softKeys' },
    effects: [],
  };
}

function project(tracks: Track[], chordTrack: ChordEvent[] = []): Project {
  return {
    id: 'overlap-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Overlap',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 4,
    tracks,
    chordTrack,
    sections: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
}

function expectOverlapFailure(candidate: Project, options?: { ppq: number }): void {
  expect(validateProject(candidate).ok).toBe(true);
  const result = projectToMidiResult(candidate, options);
  expect(result).toEqual({
    ok: false,
    error: expect.objectContaining({ code: 'overlapping-note' }),
  });
  expect('bytes' in result).toBe(false);
  expect(() => projectToMidi(candidate, options)).toThrowError(
    expect.objectContaining({
      name: 'MidiExportError',
      code: 'overlapping-note',
    }) as MidiExportError,
  );
}

describe('ambiguous same-pitch MIDI overlap', () => {
  it.each([
    {
      label: 'nested',
      notes: [note('outer', 60, 0, 2), note('inner', 60, 1, 0.5)],
    },
    {
      label: 'crossing',
      notes: [note('first', 60, 0, 2), note('second', 60, 1, 2)],
    },
  ])('fails closed for $label intervals', ({ notes }) => {
    expectOverlapFailure(project([
      instrumentTrack('lead', 'Lead', [midiClip('lead-clip', 'lead', 0, 4, notes)]),
    ]));
  });

  it('allows adjacent same-pitch notes and overlapping different pitches', () => {
    const candidate = project([
      instrumentTrack('lead', 'Lead', [midiClip('lead-clip', 'lead', 0, 4, [
        note('adjacent-a', 60, 0, 1),
        note('adjacent-b', 60, 1, 1),
        note('different-pitch', 64, 0.5, 1),
      ])]),
    ]);

    expect(validateProject(candidate).ok).toBe(true);
    expect(projectToMidiResult(candidate).ok).toBe(true);
  });

  it('allows the same pitch to overlap on independently routed Project tracks', () => {
    const candidate = project([
      instrumentTrack('lead-a', 'Lead A', [
        midiClip('clip-a', 'lead-a', 0, 4, [note('note-a', 60, 0, 2)]),
      ]),
      instrumentTrack('lead-b', 'Lead B', [
        midiClip('clip-b', 'lead-b', 0, 4, [note('note-b', 60, 1, 0.5)]),
      ]),
    ]);

    expect(validateProject(candidate).ok).toBe(true);
    expect(projectToMidiResult(candidate).ok).toBe(true);
  });

  it('detects overlap across linked and independent Clip placements', () => {
    const source = midiClip('source', 'lead', 0, 4, [note('shared', 60, 0, 2)]);
    const linked: Clip = {
      id: 'linked',
      trackId: 'lead',
      type: 'midi',
      startBeat: 1,
      lengthBeats: 4,
      loop: false,
      aliasOf: source.id,
    };
    expectOverlapFailure(project([
      instrumentTrack('lead', 'Lead', [source, linked]),
    ]));

    const independent = midiClip('independent', 'lead', 1, 4, [
      note('independent-note', 60, 0, 0.5),
    ]);
    expectOverlapFailure(project([
      instrumentTrack('lead', 'Lead', [source, independent]),
    ]));
  });

  it('detects authored overlap inside a looped MIDI pattern', () => {
    expectOverlapFailure(project([
      instrumentTrack('lead', 'Lead', [midiClip('loop', 'lead', 0, 4, [
        note('outer', 60, 0, 2),
        note('inner', 60, 1, 0.5),
      ], true)]),
    ]));
  });

  it('checks overlap after tick quantization', () => {
    const candidate = project([
      instrumentTrack('lead', 'Lead', [midiClip('quantized', 'lead', 0, 1, [
        note('first', 60, 0, 0.25),
        note('second', 60, 0.25, 0.25),
      ])]),
    ]);

    expect(projectToMidiResult(candidate).ok).toBe(true);
    expectOverlapFailure(candidate, { ppq: 1 });
  });

  it('checks realized chord notes and repeated drum lanes too', () => {
    const chords: ChordEvent[] = [
      {
        id: 'chord-a',
        startBeat: 0,
        durationBeats: 2,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [0, 4, 7],
      },
      {
        id: 'chord-b',
        startBeat: 1,
        durationBeats: 0.5,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [0, 4, 7],
      },
    ];
    expectOverlapFailure(project([
      instrumentTrack('chords', 'Chords', [midiClip('chords-clip', 'chords', 0, 4, [])]),
    ], chords));

    const drumClip: Clip = {
      id: 'drums-clip',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 32,
      drumEvents: [
        { id: 'kick-a', lane: 'kick', stepIndex: 0, velocity: 100 },
        { id: 'kick-b', lane: 'kick', stepIndex: 1, velocity: 100 },
      ],
    };
    expectOverlapFailure(project([{
      id: 'drums',
      name: 'Drums',
      type: 'drum',
      clips: [drumClip],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      instrument: { type: 'drumkit', preset: 'basic' },
      effects: [],
    }]));
  });
});
