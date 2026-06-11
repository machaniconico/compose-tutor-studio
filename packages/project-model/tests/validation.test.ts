import { describe, it, expect } from 'vitest';
import { createEmptyProject, validateProject } from '../src/index';
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
      const project: Project = { ...baseProject(), timeSignature: [4, den] };
      expect(validateProject(project).valid).toBe(true);
    }
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
});
