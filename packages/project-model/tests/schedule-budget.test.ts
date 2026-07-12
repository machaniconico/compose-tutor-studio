import { describe, expect, it } from 'vitest';
import {
  MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  MAX_RUNTIME_SCHEDULE_EVENTS,
  ScheduleEventLimitError,
  assertScheduleEventBudget,
  createEmptyProject,
  preflightScheduleEventBudget,
  validateProject,
  type Clip,
  type NoteEvent,
} from '../src/index';

const clock = () => new Date('2026-07-12T00:00:00.000Z');

function linkedNoteProject(notesPerSource: number, instanceCount: number) {
  const project = createEmptyProject({ lengthBars: 1, clock });
  const track = project.tracks.find((candidate) => candidate.name === 'Melody');
  const source = track?.clips[0];
  if (!track || !source) throw new Error('Melody fixture is missing');

  source.notes = Array.from({ length: notesPerSource }, (_, index): NoteEvent => ({
    id: `budget-note-${index}`,
    pitch: 60,
    startBeat: 0,
    durationBeats: 1,
    velocity: 90,
  }));
  const aliases = Array.from({ length: instanceCount - 1 }, (_, index): Clip => ({
    id: `budget-alias-${index}`,
    trackId: track.id,
    type: 'midi',
    startBeat: 0,
    lengthBeats: source.lengthBeats,
    loop: false,
    aliasOf: source.id,
  }));
  track.clips = [source, ...aliases];
  return project;
}

describe('effective schedule-event preflight', () => {
  it('counts expanded MIDI clip loops only in the audible projection', () => {
    const project = linkedNoteProject(1, 1);
    const track = project.tracks.find((candidate) => candidate.name === 'Melody');
    const clip = track?.clips[0];
    if (!clip) throw new Error('Melody fixture is missing');
    clip.loop = true;

    expect(preflightScheduleEventBudget(project, {
      limit: 10,
      projection: 'resolved-stored',
    })).toEqual({ ok: true, eventCount: 1, limit: 10 });
    expect(preflightScheduleEventBudget(project, {
      limit: 10,
      projection: 'audible',
    })).toEqual({ ok: true, eventCount: 4, limit: 10 });
    expect(preflightScheduleEventBudget(project, {
      limit: 3,
      projection: 'audible',
    })).toMatchObject({
      ok: false,
      reason: 'total',
      limit: 3,
      observed: 4,
    });
  });

  it('uses each linked MIDI instance loop flag with the shared source notes', () => {
    const project = linkedNoteProject(1, 2);
    const track = project.tracks.find((candidate) => candidate.name === 'Melody');
    const [source, alias] = track?.clips ?? [];
    if (!source || !alias) throw new Error('linked Melody fixture is missing');
    source.loop = false;
    alias.loop = true;

    expect(preflightScheduleEventBudget(project, {
      limit: 10,
      projection: 'audible',
    })).toEqual({ ok: true, eventCount: 5, limit: 10 });
    expect(preflightScheduleEventBudget(project, {
      limit: 10,
      projection: 'resolved-stored',
    })).toEqual({ ok: true, eventCount: 2, limit: 10 });
  });

  it('applies density limits to expanded MIDI loop onsets', () => {
    const project = linkedNoteProject(1, 1);
    const track = project.tracks.find((candidate) => candidate.name === 'Melody');
    const clip = track?.clips[0];
    const note = clip?.notes?.[0];
    if (!clip || !note) throw new Error('Melody fixture is missing');
    clip.loop = true;
    note.durationBeats = 0.002;

    expect(preflightScheduleEventBudget(project, {
      limit: MAX_RUNTIME_SCHEDULE_EVENTS,
      projection: 'audible',
      density: {
        windowBeats: 0.75,
        maxEventsPerWindow: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
      },
    })).toMatchObject({
      ok: false,
      reason: 'density',
      limit: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
      observed: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW + 1,
      windowStartBeat: 0,
    });
  });

  it('accepts exactly 20,000 expanded runtime notes and rejects one more', () => {
    const buildBoundary = (lengthBeats: number) => {
      const project = linkedNoteProject(1, 1);
      project.lengthBars = 2_048;
      const track = project.tracks.find((candidate) => candidate.name === 'Melody');
      const clip = track?.clips[0];
      if (!clip) throw new Error('Melody fixture is missing');
      clip.lengthBeats = lengthBeats;
      clip.loop = true;
      clip.notes = [
        { id: 'boundary-a', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 },
        { id: 'boundary-b', pitch: 62, startBeat: 0.25, durationBeats: 0.25, velocity: 90 },
        { id: 'boundary-c', pitch: 64, startBeat: 0.5, durationBeats: 0.5, velocity: 90 },
      ];
      return project;
    };

    expect(preflightScheduleEventBudget(buildBoundary(6_666.5), {
      limit: MAX_RUNTIME_SCHEDULE_EVENTS,
      projection: 'audible',
    })).toEqual({
      ok: true,
      eventCount: 20_000,
      limit: MAX_RUNTIME_SCHEDULE_EVENTS,
    });
    expect(preflightScheduleEventBudget(buildBoundary(6_666.51), {
      limit: MAX_RUNTIME_SCHEDULE_EVENTS,
      projection: 'audible',
    })).toMatchObject({
      ok: false,
      reason: 'total',
      observed: 20_001,
    });
  });

  it('counts linked source payload once per timeline instance', () => {
    const project = linkedNoteProject(3, 4);
    expect(preflightScheduleEventBudget(project, {
      limit: MAX_RUNTIME_SCHEDULE_EVENTS,
      projection: 'audible',
    })).toEqual({
      ok: true,
      eventCount: 12,
      limit: MAX_RUNTIME_SCHEDULE_EVENTS,
    });
  });

  it('counts realized chord notes only in the runtime audible projection', () => {
    const project = createEmptyProject({ lengthBars: 1, clock });
    project.chordTrack = [{
      id: 'budget-chord',
      startBeat: 0,
      durationBeats: 1,
      symbol: 'C',
      root: 'C',
      quality: 'major',
      notes: [],
    }];

    expect(preflightScheduleEventBudget(project, {
      limit: 2,
      projection: 'resolved-stored',
    })).toEqual({ ok: true, eventCount: 0, limit: 2 });
    expect(preflightScheduleEventBudget(project, {
      limit: 2,
      projection: 'audible',
    })).toEqual({
      ok: false,
      code: 'schedule-event-limit-exceeded',
      reason: 'total',
      limit: 2,
      observed: 3,
    });
  });

  it('applies the rolling density window to realized chord notes', () => {
    const project = createEmptyProject({ lengthBars: 1, clock });
    project.chordTrack = Array.from({ length: 3 }, (_, index) => ({
      id: `dense-chord-${index}`,
      startBeat: 0,
      durationBeats: 1,
      symbol: 'cluster',
      root: 'C',
      quality: 'major',
      notes: Array.from({ length: 128 }, (__, pitch) => pitch),
    }));

    expect(() => assertScheduleEventBudget(project)).toThrowError(
      expect.objectContaining({
        reason: 'density',
        limit: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
        observed: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW + 1,
        windowStartBeat: 0,
      }) as ScheduleEventLimitError,
    );
  });

  it('keeps a runtime-rejected project persistable below the compatibility ceiling', () => {
    const project = linkedNoteProject(101, 1_000);

    expect(validateProject(project).ok).toBe(true);
    expect(() => assertScheduleEventBudget(project)).toThrowError(
      expect.objectContaining({
        name: 'ScheduleEventLimitError',
        code: 'schedule-event-limit-exceeded',
        limit: MAX_RUNTIME_SCHEDULE_EVENTS,
        observed: 101_000,
      }) as ScheduleEventLimitError,
    );
  });

  it('rejects linked amplification above the persisted compatibility ceiling', () => {
    const project = linkedNoteProject(201, 1_000);
    const preflight = preflightScheduleEventBudget(project, {
      limit: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
      projection: 'resolved-stored',
    });

    expect(preflight).toMatchObject({
      ok: false,
      code: 'schedule-event-limit-exceeded',
      observed: 201_000,
    });
    expect(validateProject(project).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'tracks',
        message: expect.stringContaining('resolved playback events'),
      }),
    ]));
  });

  it('accepts exactly the persisted effective-event ceiling', () => {
    const project = linkedNoteProject(200, 1_000);
    expect(preflightScheduleEventBudget(project, {
      limit: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
      projection: 'resolved-stored',
    })).toEqual({
      ok: true,
      eventCount: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
      limit: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
    });
    expect(validateProject(project).ok).toBe(true);
  });

  it('rejects one occurrence above the persisted effective-event ceiling', () => {
    const project = linkedNoteProject(200, 1_000);
    const track = project.tracks.find((candidate) => candidate.name === 'Melody');
    if (!track) throw new Error('Melody fixture is missing');
    track.clips.push({
      id: 'one-over-independent',
      trackId: track.id,
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [{
        id: 'one-over-note',
        pitch: 60,
        startBeat: 0,
        durationBeats: 1,
        velocity: 90,
      }],
    });
    expect(preflightScheduleEventBudget(project, {
      limit: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
      projection: 'resolved-stored',
    })).toMatchObject({ ok: false, observed: 200_001 });
    expect(validateProject(project).ok).toBe(false);
  });
});
