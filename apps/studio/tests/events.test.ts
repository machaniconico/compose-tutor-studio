import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  MAX_RUNTIME_SCHEDULE_EVENTS,
  ScheduleEventLimitError,
  decodeProject,
  type ChordEvent,
  type Clip,
  type Project,
  type Track,
} from '@cts/project-model';
import {
  buildScheduleEvents,
  drumStepToBeat,
  type DrumScheduleEvent,
  type NoteScheduleEvent,
} from '../src/audio/events';
import { nextEventsInWindow } from '../src/audio/scheduler';
import { createDefaultProject } from '../src/state/defaultProject';

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
    schemaVersion: CURRENT_SCHEMA_VERSION,
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
  it('makes the default eight-chord project audible on its backing instrument', () => {
    const source = createDefaultProject();
    const chordsTrack = source.tracks.find((track) => track.name === 'Chords');
    const events = buildScheduleEvents(source);
    const payloads = events.map((event) => event.payload as NoteScheduleEvent);

    expect(chordsTrack).toBeDefined();
    expect(events).toHaveLength(8 * 3);
    expect(payloads.every((payload) => payload.kind === 'note')).toBe(true);
    expect(payloads.every((payload) => payload.trackId === chordsTrack?.id)).toBe(true);
    expect(
      payloads.every(
        (payload) =>
          payload.preset === 'warmPad' &&
          payload.durationBeats === 4,
      ),
    ).toBe(true);
    expect(events.slice(0, 3).map((event) => event.beat)).toEqual([0, 0, 0]);
    expect(payloads.slice(0, 3).map((payload) => payload.pitch)).toEqual([48, 52, 55]);
    expect(events.slice(-3).map((event) => event.beat)).toEqual([28, 28, 28]);
  });

  it('uses source timing, track id, and instrument preset for realized chords', () => {
    const clip: Clip = {
      id: 'chords-clip',
      trackId: 'chords-track',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 8,
      loop: false,
      notes: [],
    };
    const track = instrumentTrack('chords-track', 'softPad', clip);
    track.name = 'Chords';
    const chord: ChordEvent = {
      id: 'g7',
      startBeat: 2.5,
      durationBeats: 1.5,
      symbol: 'G7',
      root: 'G',
      quality: 'dominant7',
      notes: [7, 11, 2, 5],
    };
    const source = { ...project([track]), chordTrack: [chord] };

    const events = buildScheduleEvents(source);

    expect(events).toHaveLength(4);
    expect(events.map((event) => event.beat)).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(events.map((event) => event.payload)).toEqual([
      {
        kind: 'note',
        trackId: 'chords-track',
        preset: 'softPad',
        pitch: 55,
        durationBeats: 1.5,
        velocity: 80,
      },
      {
        kind: 'note',
        trackId: 'chords-track',
        preset: 'softPad',
        pitch: 59,
        durationBeats: 1.5,
        velocity: 80,
      },
      {
        kind: 'note',
        trackId: 'chords-track',
        preset: 'softPad',
        pitch: 62,
        durationBeats: 1.5,
        velocity: 80,
      },
      {
        kind: 'note',
        trackId: 'chords-track',
        preset: 'softPad',
        pitch: 65,
        durationBeats: 1.5,
        velocity: 80,
      },
    ]);
  });

  it('does not double chord harmony when Chords already has explicit notes', () => {
    const clip: Clip = {
      id: 'chords-clip',
      trackId: 'chords-track',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [{ id: 'authored', pitch: 72, startBeat: 1, durationBeats: 0.5, velocity: 99 }],
    };
    const track = instrumentTrack('chords-track', 'softPad', clip);
    track.name = 'Chords';
    const source = {
      ...project([track]),
      chordTrack: [
        {
          id: 'c-major',
          startBeat: 0,
          durationBeats: 4,
          symbol: 'C',
          root: 'C',
          quality: 'major',
          notes: [0, 4, 7],
        },
      ],
    } satisfies Project;

    const events = buildScheduleEvents(source);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      beat: 1,
      payload: {
        kind: 'note',
        trackId: 'chords-track',
        preset: 'softPad',
        pitch: 72,
        durationBeats: 0.5,
        velocity: 99,
      },
    });
  });

  it('keeps an empty Chord Track silent', () => {
    const clip: Clip = {
      id: 'chords-clip',
      trackId: 'chords-track',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [],
    };
    const track = instrumentTrack('chords-track', 'softPad', clip);
    track.name = 'Chords';

    expect(buildScheduleEvents(project([track]))).toEqual([]);
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

  it('expands a MIDI clip loop and clips its final partial note', () => {
    const clip: Clip = {
      id: 'looped-midi',
      trackId: 'mel',
      type: 'midi',
      startBeat: 2,
      lengthBeats: 3.5,
      loop: true,
      notes: [
        { id: 'pulse', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
      ],
    };

    const events = buildScheduleEvents(project([
      instrumentTrack('mel', 'brightLead', clip),
    ]));

    expect(events.map((event) => event.beat)).toEqual([2, 3, 4, 5]);
    expect(events.map(
      (event) => (event.payload as NoteScheduleEvent).durationBeats,
    )).toEqual([1, 1, 1, 0.5]);
  });

  it('composes MIDI Clip loop projection with transport loop passes', () => {
    const clip: Clip = {
      id: 'clip-and-transport-loop',
      trackId: 'mel',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: true,
      notes: [
        { id: 'pulse', pitch: 60, startBeat: 0, durationBeats: 2, velocity: 100 },
      ],
    };
    const sourceEvents = buildScheduleEvents(project([
      instrumentTrack('mel', 'brightLead', clip),
    ]));

    const due = nextEventsInWindow(
      sourceEvents,
      0,
      8,
      120,
      0,
      0,
      { startBeat: 0, endBeat: 4 },
    );

    expect(sourceEvents.map((event) => event.beat)).toEqual([0, 2]);
    expect(due.map((event) => event.time * 2)).toEqual([0, 2, 4, 6]);
  });

  it('plays linked MIDI content at every instance placement', () => {
    const source: Clip = {
      id: 'source-midi',
      trackId: 'mel',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [
        { id: 'shared-note', pitch: 62, startBeat: 1, durationBeats: 0.5, velocity: 96 },
      ],
    };
    const alias: Clip = {
      id: 'linked-midi',
      trackId: 'mel',
      type: 'midi',
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      aliasOf: source.id,
    };
    const track = instrumentTrack('mel', 'brightLead', source);
    track.clips = [source, alias];

    const events = buildScheduleEvents(project([track]));

    expect(events.map((event) => event.beat)).toEqual([1, 5]);
    expect(
      events.map((event) => (event.payload as NoteScheduleEvent).pitch),
    ).toEqual([62, 62]);
  });

  it('uses the linked instance loop flag without changing its source', () => {
    const source: Clip = {
      id: 'source-midi-loop-setting',
      trackId: 'mel',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [
        { id: 'shared-pulse', pitch: 62, startBeat: 0, durationBeats: 1, velocity: 96 },
      ],
    };
    const alias: Clip = {
      id: 'linked-midi-loop-setting',
      trackId: 'mel',
      type: 'midi',
      startBeat: 4,
      lengthBeats: 4,
      loop: true,
      aliasOf: source.id,
    };
    const track = instrumentTrack('mel', 'brightLead', source);
    track.clips = [source, alias];

    const events = buildScheduleEvents(project([track]));

    expect(source.loop).toBe(false);
    expect(events.map((event) => event.beat)).toEqual([0, 4, 5, 6, 7]);

    source.loop = true;
    alias.loop = false;
    expect(buildScheduleEvents(project([track])).map((event) => event.beat))
      .toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects linked amplification before reading note payloads', () => {
    const notes = Array.from({ length: 101 }, (_, index) => ({
      id: `bounded-note-${index}`,
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 90,
    }));
    Object.defineProperty(notes[0], 'pitch', {
      get: () => { throw new Error('schedule allocation started'); },
      enumerable: true,
    });
    const source: Clip = {
      id: 'bounded-source',
      trackId: 'mel',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes,
    };
    const track = instrumentTrack('mel', 'brightLead', source);
    track.clips = [
      source,
      ...Array.from({ length: 999 }, (_, index): Clip => ({
        id: `bounded-alias-${index}`,
        trackId: 'mel',
        type: 'midi',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        aliasOf: source.id,
      })),
    ];

    expect(() => buildScheduleEvents(project([track]))).toThrowError(
      expect.objectContaining({
        name: 'ScheduleEventLimitError',
        limit: MAX_RUNTIME_SCHEDULE_EVENTS,
        observed: 101_000,
      }) as ScheduleEventLimitError,
    );
  });

  it('rejects a dense linked onset window before reading drum voice payloads', () => {
    const drumEvents = Array.from({ length: 3 }, (_, index) => ({
      id: `dense-hit-${index}`,
      lane: 'kick' as const,
      stepIndex: 0,
      velocity: 100,
    }));
    Object.defineProperty(drumEvents[0], 'lane', {
      get: () => { throw new Error('drum voice payload construction started'); },
      enumerable: true,
    });
    const source: Clip = {
      id: 'dense-source',
      trackId: 'dr',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents,
    };
    const track = drumTrack('dr', source);
    track.clips = [
      source,
      ...Array.from({ length: 99 }, (_, index): Clip => ({
        id: `dense-alias-${index}`,
        trackId: 'dr',
        type: 'drum',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        aliasOf: source.id,
      })),
    ];

    expect(() => buildScheduleEvents(project([track]))).toThrowError(
      expect.objectContaining({
        name: 'ScheduleEventLimitError',
        reason: 'density',
        limit: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
        observed: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW + 1,
      }) as ScheduleEventLimitError,
    );
  });

  it('keeps v1 inert-alias payload sounding after migration removes the link', () => {
    const legacyClip: Clip = {
      id: 'legacy-independent',
      trackId: 'mel',
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      aliasOf: 'legacy-unused-source',
      notes: [{ id: 'legacy-own-note', pitch: 67, startBeat: 1, durationBeats: 1, velocity: 91 }],
    };
    const legacy = project([instrumentTrack('mel', 'brightLead', legacyClip)]);
    legacy.schemaVersion = 1;
    legacy.createdAt = '2026-07-12T00:00:00.000Z';
    legacy.updatedAt = '2026-07-12T00:00:00.000Z';
    const decoded = decodeProject(legacy);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const independent = structuredClone(decoded.project);
    const migratedClip = decoded.project.tracks[0]?.clips[0];
    const independentClip = independent.tracks[0]?.clips[0];
    expect(migratedClip).not.toHaveProperty('aliasOf');
    if (independentClip) delete independentClip.aliasOf;
    expect(buildScheduleEvents(decoded.project)).toEqual(buildScheduleEvents(independent));
    expect((buildScheduleEvents(decoded.project)[0]?.payload as NoteScheduleEvent).pitch).toBe(67);
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
    expect(kick).toMatchObject({
      clipId: 'd1',
      eventId: 'e0',
      sourceStepIndex: 0,
      clipEndBeat: 12,
      stepsPerBar: 16,
      beatsPerBar: 4,
      probability: 1,
      swing: 0,
      humanizeVelocity: 0,
      seed: 1,
    });
  });

  it('keeps linked drum instance identity while sharing source events', () => {
    const source: Clip = {
      id: 'source-drums',
      trackId: 'dr',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'shared-kick', lane: 'kick', stepIndex: 0, velocity: 110 }],
    };
    const alias: Clip = {
      id: 'linked-drums',
      trackId: 'dr',
      type: 'drum',
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      aliasOf: source.id,
    };
    const track = drumTrack('dr', source);
    track.clips = [source, alias];

    const events = buildScheduleEvents(project([track]));
    const payloads = events.map((event) => event.payload as DrumScheduleEvent);

    expect(events.map((event) => event.beat)).toEqual([0, 4]);
    expect(payloads.map((payload) => payload.clipId)).toEqual([
      'source-drums',
      'linked-drums',
    ]);
    expect(payloads.map((payload) => payload.eventId)).toEqual([
      'shared-kick',
      'shared-kick',
    ]);
  });

  it('embeds persisted per-event and per-clip groove in every raw drum payload', () => {
    const clip: Clip = {
      id: 'groove-clip',
      trackId: 'dr',
      type: 'drum',
      startBeat: 0.25,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 8,
      drumGroove: { swing: 0.6, probability: 0.4, humanizeVelocity: 100, seed: 77 },
      drumEvents: [
        { id: 'fallback-probability', lane: 'kick', stepIndex: 0, velocity: 90 },
        { id: 'event-probability', lane: 'snare', stepIndex: 1, velocity: 80, probability: 0.9 },
      ],
    };

    const payloads = buildScheduleEvents(project([drumTrack('dr', clip)]))
      .map((event) => event.payload as DrumScheduleEvent);

    expect(payloads).toEqual([
      expect.objectContaining({
        clipId: 'groove-clip',
        eventId: 'fallback-probability',
        sourceStepIndex: 0,
        clipEndBeat: 4.25,
        stepsPerBar: 8,
        beatsPerBar: 4,
        probability: 0.4,
        swing: 0.6,
        humanizeVelocity: 100,
        seed: 77,
      }),
      expect.objectContaining({
        eventId: 'event-probability',
        probability: 0.9,
      }),
    ]);
  });

  it('uses three quarter-note beats per bar for 6/8 drum scheduling', () => {
    const clip: Clip = {
      id: 'six-eight',
      trackId: 'dr',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 3,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'middle', lane: 'kick', stepIndex: 8, velocity: 100 }],
    };
    const source = { ...project([drumTrack('dr', clip)]), timeSignature: [6, 8] as [number, number] };

    expect(buildScheduleEvents(source)[0]?.beat).toBe(1.5);
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
