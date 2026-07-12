import { describe, expect, it } from 'vitest';
import {
  CHORD_VOICING_VELOCITY,
  createEmptyProject,
  realizeChordTrack,
  type ChordEvent,
  type Project,
} from '../src/index';

const clock = () => new Date('2026-07-10T00:00:00.000Z');

function projectWithChords(chords: ChordEvent[]): Project {
  return { ...createEmptyProject({ clock }), chordTrack: chords };
}

describe('realizeChordTrack', () => {
  it('creates deterministic close voicings with source timing on the Chords track', () => {
    const project = projectWithChords([
      {
        id: 'c-major',
        startBeat: 2,
        durationBeats: 3,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [7, 0, 4],
      },
      {
        id: 'g-major',
        startBeat: 5,
        durationBeats: 1.5,
        symbol: 'G',
        root: 'G',
        quality: 'major',
        notes: [7, 11, 2],
      },
    ]);
    const before = JSON.stringify(project);

    const first = realizeChordTrack(project);
    const second = realizeChordTrack(project);

    expect(first).toEqual(second);
    expect(JSON.stringify(project)).toBe(before);
    expect(first?.track.name).toBe('Chords');
    expect(first?.track.instrument?.preset).toBe('pad');
    expect(first?.notes).toEqual([
      {
        chordId: 'c-major',
        pitch: 48,
        startBeat: 2,
        durationBeats: 3,
        velocity: CHORD_VOICING_VELOCITY,
      },
      {
        chordId: 'c-major',
        pitch: 52,
        startBeat: 2,
        durationBeats: 3,
        velocity: CHORD_VOICING_VELOCITY,
      },
      {
        chordId: 'c-major',
        pitch: 55,
        startBeat: 2,
        durationBeats: 3,
        velocity: CHORD_VOICING_VELOCITY,
      },
      {
        chordId: 'g-major',
        pitch: 55,
        startBeat: 5,
        durationBeats: 1.5,
        velocity: CHORD_VOICING_VELOCITY,
      },
      {
        chordId: 'g-major',
        pitch: 59,
        startBeat: 5,
        durationBeats: 1.5,
        velocity: CHORD_VOICING_VELOCITY,
      },
      {
        chordId: 'g-major',
        pitch: 62,
        startBeat: 5,
        durationBeats: 1.5,
        velocity: CHORD_VOICING_VELOCITY,
      },
    ]);
  });

  it('preserves absolute MIDI chord tones from legacy/imported projects', () => {
    const project = projectWithChords([
      {
        id: 'absolute',
        startBeat: 0,
        durationBeats: 4,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [67, 60, 64],
      },
    ]);

    expect(realizeChordTrack(project)?.notes.map((note) => note.pitch)).toEqual([60, 64, 67]);
  });

  it('derives common chord tones when a legacy chord has no stored notes', () => {
    const project = projectWithChords([
      {
        id: 'derived',
        startBeat: 0,
        durationBeats: 4,
        symbol: 'Am',
        root: 'A',
        quality: 'minor',
        notes: [],
      },
    ]);

    expect(realizeChordTrack(project)?.notes.map((note) => note.pitch)).toEqual([57, 60, 64]);
  });

  it('returns null when the dedicated track has explicit notes to prevent doubling', () => {
    const project = projectWithChords([
      {
        id: 'c-major',
        startBeat: 0,
        durationBeats: 4,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [0, 4, 7],
      },
    ]);
    const chordsTrack = project.tracks.find((track) => track.name === 'Chords');
    const clip = chordsTrack?.clips[0];
    if (!clip) throw new Error('test project is missing its Chords clip');
    clip.notes = [{ id: 'authored', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 100 }];

    expect(realizeChordTrack(project)).toBeNull();
  });

  it('returns an empty realization for an empty chord track', () => {
    const result = realizeChordTrack(projectWithChords([]));
    expect(result?.track.name).toBe('Chords');
    expect(result?.notes).toEqual([]);
  });

  it('does not route harmony to an unrelated instrument when Chords is absent', () => {
    const project = projectWithChords([
      {
        id: 'c-major',
        startBeat: 0,
        durationBeats: 4,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [0, 4, 7],
      },
    ]);
    project.tracks = project.tracks.filter((track) => track.name !== 'Chords');

    expect(realizeChordTrack(project)).toBeNull();
  });
});
