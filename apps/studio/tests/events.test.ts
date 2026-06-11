import { describe, expect, it } from 'vitest';
import type { Clip, Project, Track } from '@cts/project-model';
import {
  buildScheduleEvents,
  drumStepToBeat,
  type DrumScheduleEvent,
  type NoteScheduleEvent,
} from '../src/audio/events';

describe('drumStepToBeat', () => {
  it('places step 0 at the clip start', () => {
    expect(drumStepToBeat(0, 16, 4, 0)).toBe(0);
    expect(drumStepToBeat(0, 16, 4, 8)).toBe(8);
  });

  it('spaces 16 steps over a 4-beat bar (0.25 beats/step)', () => {
    expect(drumStepToBeat(1, 16, 4, 0)).toBeCloseTo(0.25, 10);
    expect(drumStepToBeat(4, 16, 4, 0)).toBeCloseTo(1.0, 10); // one beat in
    expect(drumStepToBeat(8, 16, 4, 0)).toBeCloseTo(2.0, 10);
    expect(drumStepToBeat(16, 16, 4, 0)).toBeCloseTo(4.0, 10); // next bar
  });

  it('honors the clip start offset', () => {
    expect(drumStepToBeat(4, 16, 4, 8)).toBeCloseTo(9.0, 10); // 8 + 1 beat
  });

  it('handles 8 steps per bar (0.5 beats/step)', () => {
    expect(drumStepToBeat(1, 8, 4, 0)).toBeCloseTo(0.5, 10);
    expect(drumStepToBeat(2, 8, 4, 0)).toBeCloseTo(1.0, 10);
  });

  it('falls back to defaults for non-positive args', () => {
    expect(drumStepToBeat(4, 0, 4, 0)).toBeCloseTo(1.0, 10); // stepsPerBar -> 16
    expect(drumStepToBeat(8, 16, 0, 0)).toBeCloseTo(2.0, 10); // beatsPerBar -> 4
  });
});

// --- buildScheduleEvents ---------------------------------------------------

function instrumentTrack(id: string, preset: string, clip: Clip): Track {
  return {
    id,
    name: id,
    type: 'instrument',
    clips: [clip],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'synth', preset },
    effects: [],
  };
}

function drumTrack(id: string, clip: Clip): Track {
  return {
    id,
    name: id,
    type: 'drum',
    clips: [clip],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'drumkit', preset: 'basic' },
    effects: [],
  };
}

function project(tracks: Track[]): Project {
  return {
    id: 'p',
    schemaVersion: 1,
    title: 't',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    tracks,
    chordTrack: [],
    sections: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
}

describe('buildScheduleEvents', () => {
  it('emits note events at clip.startBeat + note.startBeat with the track preset', () => {
    const clip: Clip = {
      id: 'c1',
      trackId: 'mel',
      type: 'midi',
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      notes: [
        { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
        { id: 'n2', pitch: 64, startBeat: 1, durationBeats: 1, velocity: 90 },
      ],
    };
    const events = buildScheduleEvents(project([instrumentTrack('mel', 'brightLead', clip)]));
    expect(events).toHaveLength(2);
    const first = events[0]?.payload as NoteScheduleEvent;
    expect(first.kind).toBe('note');
    expect(first.preset).toBe('brightLead');
    expect(events[0]?.beat).toBe(4); // 4 + 0
    expect(events[1]?.beat).toBe(5); // 4 + 1
    expect((events[1]?.payload as NoteScheduleEvent).pitch).toBe(64);
  });

  it('emits drum events at the step beat honoring the clip start', () => {
    const clip: Clip = {
      id: 'd1',
      trackId: 'dr',
      type: 'drum',
      startBeat: 8,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [
        { id: 'e0', lane: 'kick', stepIndex: 0, velocity: 110 },
        { id: 'e1', lane: 'snare', stepIndex: 4, velocity: 100 },
      ],
    };
    const events = buildScheduleEvents(project([drumTrack('dr', clip)]));
    expect(events).toHaveLength(2);
    expect(events[0]?.beat).toBe(8); // clip start + step 0
    expect(events[1]?.beat).toBeCloseTo(9, 10); // 8 + (4 * 0.25)
    const kick = events[0]?.payload as DrumScheduleEvent;
    expect(kick.kind).toBe('drum');
    expect(kick.lane).toBe('kick');
    expect(kick.trackId).toBe('dr');
  });

  it('skips the master track and empty clips', () => {
    const master: Track = {
      id: 'm',
      name: 'Master',
      type: 'master',
      clips: [],
      volume: 0.9,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    };
    const emptyClip: Clip = {
      id: 'c',
      trackId: 'mel',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [],
    };
    const events = buildScheduleEvents(
      project([instrumentTrack('mel', 'warmPad', emptyClip), master]),
    );
    expect(events).toEqual([]);
  });
});
