import { describe, it, expect } from 'vitest';
import {
  MAX_DRUM_STEPS_PER_BAR,
  MAX_PROJECT_LENGTH_BARS,
  MAX_TIME_SIGNATURE_NUMERATOR,
  MAX_PROJECT_VALIDATION_ERRORS,
  createEmptyProject,
  validateProject,
} from '../src/index';
import type { Project } from '../src/index';

const clock = () => new Date('2026-06-11T00:00:00.000Z');

function baseProject(): Project {
  return createEmptyProject({ clock });
}

describe('validateProject', () => {
  it('passes a fresh empty project', () => {
    const result = validateProject(baseProject());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('flags bpm out of range', () => {
    const low = { ...baseProject(), bpm: 10 };
    const high = { ...baseProject(), bpm: 400 };
    expect(validateProject(low).errors.some((e) => e.path === 'bpm')).toBe(true);
    expect(validateProject(high).errors.some((e) => e.path === 'bpm')).toBe(true);
    expect(validateProject({ ...baseProject(), bpm: 20 }).valid).toBe(true);
    expect(validateProject({ ...baseProject(), bpm: 300 }).valid).toBe(true);
  });

  it('flags invalid time signature denominator', () => {
    const project: Project = { ...baseProject(), timeSignature: [4, 3] };
    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'timeSignature[1]')).toBe(true);
  });

  it('accepts allowed denominators', () => {
    for (const den of [2, 4, 8, 16] as const) {
      const project = createEmptyProject({ clock, timeSignature: [4, den] });
      expect(validateProject(project).valid).toBe(true);
    }
  });

  it('uses quarter-note beat length for compound and cut-time timelines', () => {
    const sixEight = createEmptyProject({ clock, lengthBars: 1, timeSignature: [6, 8] });
    expect(sixEight.tracks[0]?.clips[0]?.lengthBeats).toBe(3);
    expect(validateProject(sixEight).ok).toBe(true);
    sixEight.tracks[0]!.clips[0]!.lengthBeats = 5;
    expect(validateProject(sixEight).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracks[0].clips[0].lengthBeats' }),
      ]),
    );

    const cutTime = createEmptyProject({ clock, lengthBars: 1, timeSignature: [2, 2] });
    expect(cutTime.tracks[0]?.clips[0]?.lengthBeats).toBe(4);
    expect(validateProject(cutTime).ok).toBe(true);
  });

  it('caps the denominator-aware project timeline even when each dimension is valid', () => {
    const project = createEmptyProject({ clock, lengthBars: 256, timeSignature: [32, 2] });

    expect(validateProject(project).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'lengthBars',
          message: expect.stringContaining('quarter-note beats'),
        }),
      ]),
    );
  });

  it('flags pitch and velocity out of range', () => {
    const project = baseProject();
    const track = project.tracks[0]!;
    const clip = track.clips[0]!;
    clip.notes = [
      { id: 'n1', pitch: 200, startBeat: 0, durationBeats: 1, velocity: 100 },
      { id: 'n2', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0 },
    ];
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path.endsWith('.pitch'))).toBe(true);
    expect(result.errors.some((e) => e.path.endsWith('.velocity'))).toBe(true);
  });

  it('flags pan and volume out of range', () => {
    const project = baseProject();
    project.tracks[0]!.pan = 2;
    project.tracks[1]!.volume = 5;
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path === 'tracks[0].pan')).toBe(true);
    expect(result.errors.some((e) => e.path === 'tracks[1].volume')).toBe(true);
  });

  it('flags non-positive chord duration', () => {
    const project = baseProject();
    project.chordTrack = [
      { id: 'c1', startBeat: 0, durationBeats: 0, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] },
    ];
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path === 'chordTrack[0].durationBeats')).toBe(true);
  });

  it('flags negative clip start', () => {
    const project = baseProject();
    project.tracks[0]!.clips[0]!.startBeat = -1;
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path.endsWith('.startBeat'))).toBe(true);
  });

  it('detects duplicate ids', () => {
    const project = baseProject();
    project.tracks[1]!.id = project.tracks[0]!.id;
    const result = validateProject(project);
    expect(result.errors.some((e) => e.message.includes('duplicate id'))).toBe(true);
  });

  it('detects clip.trackId mismatch', () => {
    const project = baseProject();
    project.tracks[0]!.clips[0]!.trackId = 'nonexistent';
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path.endsWith('.trackId'))).toBe(true);
  });

  it('caps project dimensions that directly expand UI grids', () => {
    const oversized = baseProject();
    oversized.lengthBars = MAX_PROJECT_LENGTH_BARS + 1;
    oversized.timeSignature = [MAX_TIME_SIGNATURE_NUMERATOR + 1, 4];
    const drumClip = oversized.tracks.find((track) => track.type === 'drum')?.clips[0];
    if (!drumClip) throw new Error('drum fixture missing');
    drumClip.stepsPerBar = MAX_DRUM_STEPS_PER_BAR + 1;

    const result = validateProject(oversized);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'lengthBars' }),
        expect.objectContaining({ path: 'timeSignature[0]' }),
        expect.objectContaining({ path: expect.stringContaining('stepsPerBar') }),
      ]),
    );
  });

  it('includes effect ids in project-wide duplicate detection', () => {
    const project = baseProject();
    project.tracks[0]!.effects = [
      { id: 'duplicate-effect', type: 'filter', enabled: true, params: {} },
      { id: 'duplicate-effect', type: 'delay', enabled: true, params: {} },
    ];

    const result = validateProject(project);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: 'tracks[0].effects[1].id' }),
    );
  });

  it('caps validation work before a hostile project can accumulate unbounded issues', () => {
    const project = baseProject();
    const clip = project.tracks[0]!.clips[0]!;
    clip.notes = Array.from({ length: 1_000 }, (_, index) => ({
      id: `bad-${index}`,
      pitch: 999,
      startBeat: -1,
      durationBeats: 0,
      velocity: 0,
    }));

    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(MAX_PROJECT_VALIDATION_ERRORS);
  });
});
