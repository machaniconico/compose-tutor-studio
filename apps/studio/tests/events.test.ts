import { describe, expect, it, vi } from 'vitest';
import type { Clip, Project, Track } from '@cts/project-model';
import { deserializeProject, expandClip, serializeProject, validateProject } from '@cts/project-model';
import { exportProjectToMidi, parseMidi } from '@cts/midi-io';
import { renderScheduleEvents } from '../src/audio/wav';
import {
  buildScheduleEvents,
  drumStepToBeat,
  type DrumScheduleEvent,
  type NoteScheduleEvent,
} from '../src/audio/events';

// Pass-through spy: playback must expand clips through expandClip (US-007).
vi.mock('@cts/project-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cts/project-model')>();
  return { ...actual, expandClip: vi.fn(actual.expandClip) };
});

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
  it.each(['bus', 'audio'] as const)('keeps notes from a v2 %s track in live playback and WAV', (type) => {
    const clip: Clip = {
      id: 'c-bus',
      trackId: 'bus',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [{ id: 'n', pitch: 60, startBeat: 1, durationBeats: 1, velocity: 100 }],
    };
    const bus: Track = {
      ...instrumentTrack('bus', 'roundBass', clip),
      type,
      pan: -0.4,
      solo: true,
      effects: [{ id: 'fx-bus', type: 'delay', enabled: true, params: { timeSeconds: 0.25 } }],
    };
    const legacy = { ...project([bus]), schemaVersion: 2 };
    expect(validateProject(legacy).errors.filter((e) => e.path !== 'schemaVersion')).toEqual([]);
    const migrated = deserializeProject(serializeProject(legacy));
    expect(validateProject(migrated).errors).toEqual([]);
    const expected = {
      kind: 'note', trackId: bus.id, preset: 'roundBass', pitch: 60, durationBeats: 1, velocity: 100,
    };
    expect(buildScheduleEvents(migrated)).toEqual([{ beat: 1, payload: expected }]);
    expect(renderScheduleEvents(migrated)).toMatchObject([{ time: 0.5, payload: expected }]);
    expect(migrated.tracks[0]).toMatchObject({ ...bus, type: 'instrument' });
  });

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

  it('spreads a 3/4 bar over 3 quarter-note beats (12 steps = 0.25 beats/step)', () => {
    const clip: Clip = {
      id: 'd1',
      trackId: 'dr',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 6,
      loop: false,
      stepsPerBar: 12,
      drumEvents: [
        { id: 'e0', lane: 'kick', stepIndex: 0, velocity: 110 },
        { id: 'e1', lane: 'snare', stepIndex: 4, velocity: 100 },
        { id: 'e2', lane: 'kick', stepIndex: 12, velocity: 110 },
      ],
    };
    const threeFour: Project = { ...project([drumTrack('dr', clip)]), timeSignature: [3, 4] };
    expect(buildScheduleEvents(threeFour).map((e) => e.beat)).toEqual([0, 1, 3]);
    // 6/8 has the same 3 quarter-note beats per bar.
    const sixEight: Project = { ...threeFour, timeSignature: [6, 8] };
    expect(buildScheduleEvents(sixEight).map((e) => e.beat)).toEqual([0, 1, 3]);
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

describe('buildScheduleEvents uses expandClip', () => {
  it('expands every clip through expandClip, honoring length and links', () => {
    const source: Clip = {
      id: 'src',
      trackId: 'mel',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [
        { id: 'n1', pitch: 60, startBeat: 3.5, durationBeats: 2, velocity: 100 },
        { id: 'n2', pitch: 62, startBeat: 5, durationBeats: 1, velocity: 100 },
      ],
    };
    const linked: Clip = { ...source, id: 'link', startBeat: 8, aliasOf: 'src', notes: [] };
    const track = instrumentTrack('mel', 'warmPad', source);
    track.clips.push(linked);
    const spy = vi.mocked(expandClip);
    spy.mockClear();

    const events = buildScheduleEvents(project([track]));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map(([clip]) => clip.id)).toEqual(['src', 'link']);
    expect(events.map((e) => [e.beat, (e.payload as NoteScheduleEvent).durationBeats])).toEqual([
      [3.5, 0.5],
      [11.5, 0.5],
    ]);
  });
});

describe('live playback and MIDI export expand the same project the same way', () => {
  it('calls expandClip for the same clips and sounds the same beats on both paths', () => {
    // One project for both paths: a looping drum-type clip on an instrument
    // track that holds notes, a midi-type clip linked to it, a note past the
    // clip end, and a 0.3-beat period whose 4th repeat lands on the end only
    // by rounding.
    const looped: Clip = {
      id: 'looped',
      trackId: 'mel',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      contentLengthBeats: 2,
      loop: true,
      notes: [
        { id: 'a', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
        { id: 'late', pitch: 62, startBeat: 5, durationBeats: 1, velocity: 100 },
      ],
    };
    const linked: Clip = { id: 'linked', trackId: 'mel', type: 'midi', startBeat: 4, lengthBeats: 2, loop: false, aliasOf: 'looped' };
    const fractional: Clip = {
      id: 'fractional',
      trackId: 'mel',
      type: 'midi',
      startBeat: 8,
      lengthBeats: 1,
      contentLengthBeats: 0.3,
      loop: true,
      notes: [{ id: 'f', pitch: 64, startBeat: 0.1, durationBeats: 0.1, velocity: 100 }],
    };
    const track = instrumentTrack('mel', 'warmPad', looped);
    track.clips.push(linked, fractional);
    const shared = project([track]);
    const spy = vi.mocked(expandClip);

    spy.mockClear();
    const live = buildScheduleEvents(shared);
    const liveCalls = spy.mock.calls.map(([clip]) => clip.id);
    spy.mockClear();
    const midi = parseMidi(exportProjectToMidi(shared));
    const midiCalls = spy.mock.calls.map(([clip]) => clip.id);

    expect(liveCalls).toEqual(['looped', 'linked', 'fractional']);
    expect(midiCalls).toEqual(liveCalls);
    const liveNotes = live
      .map((e) => [e.beat, (e.payload as NoteScheduleEvent).pitch] as const)
      .sort((x, y) => x[0] - y[0]);
    const midiNotes = midi.tracks
      .flatMap((t) => t.notes)
      .map((n) => [n.startBeat, n.pitch] as const)
      .sort((x, y) => x[0] - y[0]);
    expect(midiNotes).toHaveLength(liveNotes.length);
    midiNotes.forEach(([beat, pitch], i) => {
      expect(beat).toBeCloseTo(liveNotes[i]![0], 2);
      expect(pitch).toBe(liveNotes[i]![1]);
    });
    expect(liveNotes.map(([beat]) => Math.round(beat * 10) / 10)).toEqual([0, 2, 4, 8.1, 8.4, 8.7]);
  });

  it('sounds a link placed on an audio track on neither path (instrument note at 0, link at 4)', () => {
    const source: Clip = {
      id: 'src',
      trackId: 'keys',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    const linked: Clip = { id: 'link', trackId: 'aud', type: 'midi', startBeat: 4, lengthBeats: 4, loop: false, aliasOf: 'src' };
    const audio: Track = { ...instrumentTrack('aud', 'warmPad', linked), type: 'audio' };
    const shared = project([instrumentTrack('keys', 'warmPad', source), audio]);

    const liveStarts = buildScheduleEvents(shared).map((e) => e.beat).sort((a, b) => a - b);
    const midiStarts = parseMidi(exportProjectToMidi(shared))
      .tracks.flatMap((t) => t.notes)
      .map((n) => n.startBeat)
      .sort((a, b) => a - b);
    expect(liveStarts).toEqual([0]);
    expect(midiStarts).toEqual(liveStarts);
  });
});
