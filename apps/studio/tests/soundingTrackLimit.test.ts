import { expect, it } from 'vitest';
import { projectToMidi } from '@cts/midi-io';
import { validateProject } from '@cts/project-model';
import {
  fromMidiBytes, fromScheduled, makeProject, makeTrack, midiClip, tickOf,
} from '../../../packages/project-model/tests/acceptance/helpers';
import { buildScheduleEvents } from '../src/audio/events';
import { renderScheduleEvents } from '../src/audio/wav';

it('keeps live, WAV, and MIDI notes in sync when the tempo track would exceed the SMF track limit', () => {
  const tracks = Array.from({ length: 65_535 }, (_, index) => {
    const id = `t${index}`;
    return makeTrack(id, 'instrument', index === 0 ? [midiClip('a', id, 0, 1, [[0, 1, 60]])] : []);
  });
  const project = makeProject(tracks);
  expect(validateProject(project).errors).toEqual([]);

  const live = fromScheduled(buildScheduleEvents(project));
  expect(live.ons).toHaveLength(1);
  expect(live.offs).toEqual([`t0|${tickOf(1)}|60`]);
  expect(fromScheduled(renderScheduleEvents(project))).toEqual(live);
  expect(fromMidiBytes(projectToMidi(project), project)).toEqual(live);
});
