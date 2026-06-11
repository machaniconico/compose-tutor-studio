import { describe, it, expect } from 'vitest';
import { createEmptyProject, validateProject, projectLengthBeats } from '../src/index';

const fixedClock = () => new Date('2026-06-11T00:00:00.000Z');

describe('createEmptyProject', () => {
  it('applies sensible defaults', () => {
    const project = createEmptyProject({ clock: fixedClock });
    expect(project.title).toBe('Untitled');
    expect(project.bpm).toBe(120);
    expect(project.key).toBe('C');
    expect(project.scale).toBe('major');
    expect(project.timeSignature).toEqual([4, 4]);
    expect(project.lengthBars).toBe(8);
    expect(project.schemaVersion).toBe(1);
    expect(project.createdAt).toBe('2026-06-11T00:00:00.000Z');
    expect(project.updatedAt).toBe('2026-06-11T00:00:00.000Z');
  });

  it('honors overrides', () => {
    const project = createEmptyProject({
      title: 'My Song',
      bpm: 90,
      key: 'G',
      scale: 'minorPentatonic',
      timeSignature: [3, 4],
      lengthBars: 16,
      clock: fixedClock,
    });
    expect(project.title).toBe('My Song');
    expect(project.bpm).toBe(90);
    expect(project.key).toBe('G');
    expect(project.scale).toBe('minorPentatonic');
    expect(project.timeSignature).toEqual([3, 4]);
    expect(project.lengthBars).toBe(16);
  });

  it('creates the default track set', () => {
    const project = createEmptyProject({ clock: fixedClock });
    const names = project.tracks.map((t) => t.name);
    expect(names).toEqual(['Chords', 'Bass', 'Melody', 'Drums', 'Master']);
    const types = project.tracks.map((t) => t.type);
    expect(types).toEqual(['instrument', 'instrument', 'instrument', 'drum', 'master']);
  });

  it('gives each instrument/drum track one default clip covering the project length', () => {
    const project = createEmptyProject({ clock: fixedClock });
    const lengthBeats = projectLengthBeats(project);
    const chords = project.tracks[0]!;
    const drums = project.tracks[3]!;
    const master = project.tracks[4]!;
    expect(chords.clips).toHaveLength(1);
    expect(chords.clips[0]!.startBeat).toBe(0);
    expect(chords.clips[0]!.lengthBeats).toBe(lengthBeats);
    expect(drums.clips).toHaveLength(1);
    expect(drums.clips[0]!.type).toBe('drum');
    expect(drums.clips[0]!.stepsPerBar).toBe(16);
    expect(master.clips).toHaveLength(0);
  });

  it('produces unique ids and valid clip back-references', () => {
    const project = createEmptyProject({ clock: fixedClock });
    project.tracks.forEach((track) => {
      track.clips.forEach((clip) => {
        expect(clip.trackId).toBe(track.id);
      });
    });
    const result = validateProject(project);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
