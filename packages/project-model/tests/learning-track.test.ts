import { describe, expect, it } from 'vitest';
import {
  createEmptyProject,
  findLearningTrack,
  isLearningTrack,
  isLearningTrackName,
  isReservedLearningTrackName,
  normalizeLearningTrackName,
} from '../src/index';

describe('schema-v2 learning track roles', () => {
  it.each([
    ['  cHoRdS\n', 'Chords'],
    ['\tBASS  ', 'Bass'],
    [' MeLoDy ', 'Melody'],
  ] as const)('normalizes %j to the canonical %s role', (value, expected) => {
    expect(normalizeLearningTrackName(value)).toBe(expected);
    expect(isLearningTrackName(value)).toBe(true);
    expect(isReservedLearningTrackName(value)).toBe(true);
  });

  it.each(['', '   ', 'Bassoon', 'Melody 2', 'Chord', 'constructor', '__proto__', 'toString'])(
    'rejects unrelated name %j',
    (value) => {
      expect(normalizeLearningTrackName(value)).toBeNull();
      expect(isLearningTrackName(value)).toBe(false);
    },
  );

  it('requires an instrument track and distinguishes each requested role', () => {
    expect(isLearningTrack({ name: '  mElOdY ', type: 'instrument' })).toBe(true);
    expect(isLearningTrack({ name: '  mElOdY ', type: 'instrument' }, 'Melody')).toBe(true);
    expect(isLearningTrack({ name: '  mElOdY ', type: 'instrument' }, 'Bass')).toBe(false);
    expect(isLearningTrack({ name: 'Melody', type: 'drum' })).toBe(false);
  });

  it('finds case and whitespace variants while ignoring a non-instrument impostor', () => {
    const project = createEmptyProject({
      clock: () => new Date('2026-07-16T00:00:00.000Z'),
    });
    const melody = project.tracks.find((track) => track.name === 'Melody');
    const drums = project.tracks.find((track) => track.type === 'drum');
    if (!melody || !drums) throw new Error('learning-track fixture is incomplete');
    melody.name = '  mElOdY\n';
    drums.name = 'Melody';
    project.tracks = [drums, ...project.tracks.filter((track) => track.id !== drums.id)];

    expect(findLearningTrack(project, 'Melody')?.id).toBe(melody.id);
  });
});
