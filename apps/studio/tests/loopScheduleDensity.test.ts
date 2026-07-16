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
import { buildScheduleEvents } from '../src/audio/events';
import {
  createScheduleEventIndex,
  preflightLoopScheduleDensity,
} from '../src/audio/scheduler';

const timestamp = '2026-07-12T00:00:00.000Z';

function project(tracks: Track[], chordTrack: ChordEvent[] = []): Project {
  return {
    id: 'loop-density-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Loop density integration',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [{ id: 'tempo-1', beat: 0, bpm: 120 }],
    timeSignatureMap: [{ id: 'signature-1', beat: 0, numerator: 4, denominator: 4 }],
    audioAssets: [],
    automationLanes: [],
    audioRouting: {
      outputs: tracks
        .filter((track) => track.type !== 'master')
        .map((track) => ({
          sourceTrackId: track.id,
          destination: { type: 'master' as const },
        })),
      sends: [],
    },
    tracks,
    chordTrack,
    sections: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function instrumentTrack(id: string, name: string, clips: Clip[]): Track {
  return {
    id,
    name,
    type: 'instrument',
    role: 'general',
    clips,
    volume: 0.5,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'synth', preset: 'softKeys' },
    effects: [],
  };
}

function linkedLoopProject(noteCount: number): Project {
  const trackId = 'linked-loop-track';
  const sourceId = 'linked-loop-source';
  const notes = Array.from({ length: noteCount }, (_, index): NoteEvent => ({
    id: `linked-loop-note-${index}`,
    pitch: 60 + (index % 12),
    startBeat: 0,
    durationBeats: 1 / 960,
    velocity: 80,
  }));
  const source: Clip = {
    id: sourceId,
    trackId,
    type: 'midi',
    startBeat: 0,
    lengthBeats: 0.25,
    loop: false,
    notes,
  };
  const atLoopStart: Clip = {
    id: 'linked-loop-at-start',
    trackId,
    type: 'midi',
    startBeat: 1,
    lengthBeats: 0.25,
    loop: false,
    aliasOf: sourceId,
  };
  const atLoopEnd: Clip = {
    id: 'linked-loop-at-end',
    trackId,
    type: 'midi',
    startBeat: 1.25,
    lengthBeats: 0.25,
    loop: false,
    aliasOf: sourceId,
  };
  return project([
    instrumentTrack(trackId, 'Linked Loop', [source, atLoopStart, atLoopEnd]),
  ]);
}

describe('runtime loop-density integration', () => {
  it('expands linked content while filtering source and loop-end instances', () => {
    const loop = { startBeat: 1, endBeat: 1.25 };
    const acceptedProject = linkedLoopProject(85);
    const rejectedProject = linkedLoopProject(86);
    expect(validateProject(acceptedProject).ok).toBe(true);
    expect(validateProject(rejectedProject).ok).toBe(true);

    const acceptedSchedule = buildScheduleEvents(acceptedProject);
    const rejectedSchedule = buildScheduleEvents(rejectedProject);
    expect(acceptedSchedule).toHaveLength(85 * 3);
    expect(rejectedSchedule).toHaveLength(86 * 3);

    const acceptedIndex = createScheduleEventIndex(acceptedSchedule, loop);
    const rejectedIndex = createScheduleEventIndex(rejectedSchedule, loop);
    // Only the alias at the inclusive loop start is reachable. The source is
    // before the loop and the second alias is exactly at its exclusive end.
    expect(acceptedIndex.entries).toHaveLength(85);
    expect(rejectedIndex.entries).toHaveLength(86);
    expect(preflightLoopScheduleDensity(acceptedIndex, 0.75, 256)).toEqual({
      ok: true,
      observed: 255,
      limit: 256,
    });
    expect(preflightLoopScheduleDensity(rejectedIndex, 0.75, 256)).toEqual({
      ok: false,
      observed: 258,
      limit: 256,
      windowStartBeat: 1,
    });
  });

  it('includes realized Chord Track notes in periodic density', () => {
    const chordsTrack = instrumentTrack('chords-track', 'Chords', []);
    chordsTrack.role = 'learning.chords';
    const source = project([chordsTrack], [{
      id: 'loop-chord',
      startBeat: 1,
      durationBeats: 0.25,
      symbol: 'C',
      root: 'C',
      quality: 'major',
      notes: [],
    }]);
    expect(validateProject(source).ok).toBe(true);

    const schedule = buildScheduleEvents(source);
    expect(schedule).toHaveLength(3);
    const index = createScheduleEventIndex(schedule, { startBeat: 1, endBeat: 1.25 });
    expect(preflightLoopScheduleDensity(index, 0.75, 8)).toEqual({
      ok: false,
      observed: 9,
      limit: 8,
      windowStartBeat: 1,
    });
  });
});
