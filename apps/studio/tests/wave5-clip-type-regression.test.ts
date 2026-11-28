import { convertWave5Project } from '@cts/project-model';
import { expect, it } from 'vitest';
import { clipOf, goldenOf, inputOf, mainEventsOf, reportItems, type Json } from './acceptance/p70-helpers';

it('preserves MIDI playback from a Wave5 drum-typed clip on an instrument track', () => {
  const input = inputOf('type-mismatch-content');
  const [drumTrack, instrumentTrack, masterTrack] = input.tracks as [Json, Json, Json];
  const instrumentClip = instrumentTrack.clips[0];
  delete instrumentClip.drumEvents;
  delete instrumentClip.stepsPerBar;
  instrumentClip.notes = [drumTrack.clips[0].notes[0]];
  input.tracks = [instrumentTrack, masterTrack];

  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(clipOf(result.project, 'c-id').type).toBe('midi');
  const { pitch, velocity, startTick, endTick } = goldenOf('clip-type-mismatch-played').events[0]!;
  expect(mainEventsOf(result.project)).toMatchObject([{ pitch, velocity, startTick, endTick }]);
  expect(reportItems(result, 'clip-type-changed')).toMatchObject([
    { clipId: 'c-id', severity: 'changed', detail: { from: 'drum', to: 'midi' } },
  ]);
});
