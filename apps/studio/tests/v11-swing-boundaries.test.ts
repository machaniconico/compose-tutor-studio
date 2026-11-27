import { describe, expect, it } from 'vitest';
import { parseMidiFile, projectToMidi } from '@cts/midi-io';
import { createEmptyProject } from '@cts/project-model';
import { buildScheduleEvents } from '../src/audio/events';
import { createScheduleEventIndex, nextIndexedEventsInWindow } from '../src/audio/scheduler';
import { buildWavScheduleEvents } from '../src/audio/wav';

function projectWithBeatPair(
  swing: number,
  startBeat: number,
  endBeat: number,
  localOnset: number,
  stepsPerBar: number,
  stepIndex: number,
) {
  const project = createEmptyProject();
  project.swing = swing;
  const note = project.tracks.find((track) => track.type === 'instrument')!.clips[0]!;
  const drum = project.tracks.find((track) => track.type === 'drum')!.clips[0]!;
  for (const clip of [note, drum]) {
    clip.startBeat = startBeat;
    clip.lengthBeats = endBeat - startBeat;
  }
  note.notes = [{ id: 'note', pitch: 60, startBeat: localOnset, durationBeats: 0.02, velocity: 90 }];
  drum.stepsPerBar = stepsPerBar;
  drum.drumEvents = [{ id: 'drum', lane: 'kick', stepIndex, velocity: 90 }];
  return project;
}

describe('v11 swing boundaries', () => {
  it.each([
    { start: 9, end: 9.3333, onset: 0.25, steps: 16, step: 1, swing: 33.3, earlier: 32 },
    { start: 0.1, end: 0.4005, onset: 0.15, steps: 80, step: 3, swing: 60, earlier: 59 },
  ])('uses the same clip-end tick in live, WAV and MIDI ($start–$end)', ({
    start, end, onset, steps, step, swing, earlier,
  }) => {
    for (const [amount, count] of [[swing, 0], [earlier, 2]] as const) {
      const project = projectWithBeatPair(amount, start, end, onset, steps, step);
      const index = createScheduleEventIndex(buildScheduleEvents(project));
      const live = nextIndexedEventsInWindow(index, 0, project.lengthBeats, 120, 0, 0);
      const wav = buildWavScheduleEvents(project);
      const midi = parseMidiFile(projectToMidi(project)).tracks.flatMap((track) => track.notes);
      expect({ live: live.length, wav: wav.length, midi: midi.length }).toEqual({
        live: count, wav: count, midi: count,
      });
    }
  });

  it('filters notes and drums by swung onset on every loop pass', () => {
    const project = projectWithBeatPair(60, 0, 8, 3.75, 16, 15);
    const events = buildScheduleEvents(project);
    const outside = createScheduleEventIndex(events, { startBeat: 0, endBeat: 3.8 });
    expect(nextIndexedEventsInWindow(outside, 0, 7.6, 120, 0, 0)).toEqual([]);

    const inside = createScheduleEventIndex(events, { startBeat: 0, endBeat: 4 });
    const due = nextIndexedEventsInWindow(inside, 0, 8, 120, 0, 0);
    expect(due.map(({ time, payload }) => [time, (payload as { kind: string }).kind])).toEqual([
      [1.95, 'note'], [1.95, 'drum'], [3.95, 'note'], [3.95, 'drum'],
    ]);
  });
});
