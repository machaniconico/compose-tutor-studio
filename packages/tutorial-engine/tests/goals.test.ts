import { describe, expect, it } from 'vitest';
import { checkGoalOnEvent, evaluateProjectPredicate } from '../src/goals.js';
import type { AppEvent } from '../src/types.js';
import {
  makeDrumEvent,
  makeDrumTrack,
  makeMelodyTrack,
  makeNote,
  makeProject,
  makeSection,
} from './helpers.js';

// ─── chordCountAtLeast ────────────────────────────────────────────────────────

describe('chordCountAtLeast', () => {
  it('returns false when chord track is empty', () => {
    const project = makeProject({ chordTrack: [] });
    expect(
      evaluateProjectPredicate({ type: 'chordCountAtLeast', value: 4 }, project),
    ).toBe(false);
  });

  it('returns true when chord count meets minimum', () => {
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
        { id: '3', startBeat: 8, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'minor', notes: [] },
        { id: '4', startBeat: 12, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [] },
      ],
    });
    expect(
      evaluateProjectPredicate({ type: 'chordCountAtLeast', value: 4 }, project),
    ).toBe(true);
  });

  it('returns false when count is below minimum', () => {
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
      ],
    });
    expect(
      evaluateProjectPredicate({ type: 'chordCountAtLeast', value: 4 }, project),
    ).toBe(false);
  });
});

// ─── progressionEquals ───────────────────────────────────────────────────────

describe('progressionEquals', () => {
  it('returns true for matching progression', () => {
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
        { id: '3', startBeat: 8, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'minor', notes: [] },
        { id: '4', startBeat: 12, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [] },
      ],
    });
    expect(
      evaluateProjectPredicate(
        { type: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        project,
      ),
    ).toBe(true);
  });

  it('returns false for wrong progression', () => {
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [] },
      ],
    });
    expect(
      evaluateProjectPredicate(
        { type: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        project,
      ),
    ).toBe(false);
  });

  it('sorts by startBeat before comparing', () => {
    const project = makeProject({
      chordTrack: [
        { id: '3', startBeat: 8, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'minor', notes: [] },
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '4', startBeat: 12, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
      ],
    });
    expect(
      evaluateProjectPredicate(
        { type: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        project,
      ),
    ).toBe(true);
  });
});

// ─── drumLaneActive ───────────────────────────────────────────────────────────

describe('drumLaneActive', () => {
  it('returns true when kick lane has enough steps', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('kick', 0), makeDrumEvent('kick', 8)])],
    });
    expect(
      evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'kick', minSteps: 2 }, project),
    ).toBe(true);
  });

  it('returns false when kick lane has fewer steps than required', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('kick', 0)])],
    });
    expect(
      evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'kick', minSteps: 2 }, project),
    ).toBe(false);
  });

  it('returns false when no drum track exists', () => {
    const project = makeProject({ tracks: [] });
    expect(
      evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'snare', minSteps: 1 }, project),
    ).toBe(false);
  });
});

// ─── noteCountAtLeast ─────────────────────────────────────────────────────────

describe('noteCountAtLeast', () => {
  it('returns true when Melody track has enough notes', () => {
    const project = makeProject({
      tracks: [makeMelodyTrack([makeNote(60), makeNote(62), makeNote(64)])],
    });
    expect(
      evaluateProjectPredicate(
        { type: 'noteCountAtLeast', trackName: 'Melody', value: 3 },
        project,
      ),
    ).toBe(true);
  });

  it('returns false when track not found', () => {
    const project = makeProject({ tracks: [] });
    expect(
      evaluateProjectPredicate(
        { type: 'noteCountAtLeast', trackName: 'Melody', value: 1 },
        project,
      ),
    ).toBe(false);
  });

  it('counts notes across multiple clips', () => {
    const track = {
      id: 'melody',
      name: 'Melody',
      type: 'instrument' as const,
      role: 'learning.melody' as const,
      clips: [
        {
          id: 'c1',
          trackId: 'melody',
          type: 'midi' as const,
          startBeat: 0,
          lengthBeats: 8,
          loop: false,
          notes: [makeNote(60), makeNote(62)],
        },
        {
          id: 'c2',
          trackId: 'melody',
          type: 'midi' as const,
          startBeat: 8,
          lengthBeats: 8,
          loop: false,
          notes: [makeNote(64), makeNote(65), makeNote(67)],
        },
      ],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    };
    const project = makeProject({ tracks: [track] });
    expect(
      evaluateProjectPredicate(
        { type: 'noteCountAtLeast', trackName: 'Melody', value: 5 },
        project,
      ),
    ).toBe(true);
  });

  it('counts linked MIDI content once per timeline instance', () => {
    const track = makeMelodyTrack([makeNote(60), makeNote(64)]);
    const source = track.clips[0]!;
    source.trackId = track.id;
    track.clips.push({
      id: 'linked-melody',
      trackId: track.id,
      type: 'midi',
      startBeat: 16,
      lengthBeats: source.lengthBeats,
      loop: false,
      aliasOf: source.id,
    });
    const project = makeProject({ schemaVersion: 2, tracks: [track] });

    expect(evaluateProjectPredicate(
      { type: 'noteCountAtLeast', trackName: 'Melody', value: 4 },
      project,
    )).toBe(true);
  });

  it('does not count a dangling linked MIDI instance', () => {
    const track = makeMelodyTrack([makeNote(60), makeNote(64)]);
    track.clips[0]!.trackId = track.id;
    track.clips.push({
      id: 'dangling-melody',
      trackId: track.id,
      type: 'midi',
      startBeat: 16,
      lengthBeats: 16,
      loop: false,
      aliasOf: 'missing-source',
    });
    const project = makeProject({ schemaVersion: 2, tracks: [track] });

    expect(evaluateProjectPredicate(
      { type: 'noteCountAtLeast', trackName: 'Melody', value: 3 },
      project,
    )).toBe(false);
  });
});

describe('linked drum predicates', () => {
  it('counts active linked drum steps once per timeline instance', () => {
    const track = makeDrumTrack([
      makeDrumEvent('kick', 0),
      makeDrumEvent('kick', 8),
    ]);
    const source = track.clips[0]!;
    source.trackId = track.id;
    track.clips.push({
      id: 'linked-drums',
      trackId: track.id,
      type: 'drum',
      startBeat: 16,
      lengthBeats: source.lengthBeats,
      loop: false,
      aliasOf: source.id,
    });
    const project = makeProject({ schemaVersion: 2, tracks: [track] });

    expect(evaluateProjectPredicate(
      { type: 'drumLaneActive', lane: 'kick', minSteps: 4 },
      project,
    )).toBe(true);
  });
});

// ─── hasSection ───────────────────────────────────────────────────────────────

describe('hasSection', () => {
  it('returns true when chorus section exists', () => {
    const project = makeProject({ sections: [makeSection('chorus')] });
    expect(
      evaluateProjectPredicate({ type: 'hasSection', sectionType: 'chorus' }, project),
    ).toBe(true);
  });

  it('returns false when chorus section is absent', () => {
    const project = makeProject({ sections: [makeSection('verse')] });
    expect(
      evaluateProjectPredicate({ type: 'hasSection', sectionType: 'chorus' }, project),
    ).toBe(false);
  });
});

// ─── bpmInRange ───────────────────────────────────────────────────────────────

describe('bpmInRange', () => {
  it('returns true when bpm is within range', () => {
    const project = makeProject({ bpm: 120 });
    expect(
      evaluateProjectPredicate({ type: 'bpmInRange', min: 60, max: 180 }, project),
    ).toBe(true);
  });

  it('returns false when bpm is below range', () => {
    const project = makeProject({ bpm: 40 });
    expect(
      evaluateProjectPredicate({ type: 'bpmInRange', min: 60, max: 180 }, project),
    ).toBe(false);
  });

  it('returns true at exact lower boundary', () => {
    const project = makeProject({ bpm: 60 });
    expect(
      evaluateProjectPredicate({ type: 'bpmInRange', min: 60, max: 180 }, project),
    ).toBe(true);
  });
});

// ─── trackVolumeInRange ───────────────────────────────────────────────────────

describe('trackVolumeInRange', () => {
  it('returns true when melody volume is in range', () => {
    const project = makeProject({ tracks: [makeMelodyTrack([])] });
    expect(
      evaluateProjectPredicate(
        { type: 'trackVolumeInRange', trackName: 'Melody', min: 0.8, max: 1.2 },
        project,
      ),
    ).toBe(true);
  });

  it('returns false when volume out of range', () => {
    const track = { ...makeMelodyTrack([]), volume: 0.5 };
    const project = makeProject({ tracks: [track] });
    expect(
      evaluateProjectPredicate(
        { type: 'trackVolumeInRange', trackName: 'Melody', min: 0.8, max: 1.2 },
        project,
      ),
    ).toBe(false);
  });
});

// ─── event goal via checkGoalOnEvent ─────────────────────────────────────────

describe('checkGoalOnEvent — event kind', () => {
  const project = makeProject();

  it('satisfies on first matching event when count=1', () => {
    const event: AppEvent = {
      type: 'chord.added',
      payload: { bar: 0, chordSymbol: 'C' },
    };
    const goal = { kind: 'event' as const, eventType: 'chord.added' as const, count: 1 };
    const result = checkGoalOnEvent(goal, event, project, 0);
    expect(result.satisfied).toBe(true);
    expect(result.newEventCount).toBe(1);
  });

  it('requires count=3 events before satisfying', () => {
    const event: AppEvent = {
      type: 'note.added',
      payload: {
        pitch: 60,
        startBeat: 0,
        durationBeats: 1,
        trackId: 'mel',
        trackName: 'Melody',
        inScale: true,
      },
    };
    const goal = { kind: 'event' as const, eventType: 'note.added' as const, count: 3 };
    const r1 = checkGoalOnEvent(goal, event, project, 0);
    expect(r1.satisfied).toBe(false);
    const r2 = checkGoalOnEvent(goal, event, project, r1.newEventCount);
    expect(r2.satisfied).toBe(false);
    const r3 = checkGoalOnEvent(goal, event, project, r2.newEventCount);
    expect(r3.satisfied).toBe(true);
  });

  it('ignores non-matching event types', () => {
    const event: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
    const goal = { kind: 'event' as const, eventType: 'chord.added' as const, count: 1 };
    const result = checkGoalOnEvent(goal, event, project, 0);
    expect(result.satisfied).toBe(false);
    expect(result.newEventCount).toBe(0);
  });

  it('filters by EventMatch.chordSymbol', () => {
    const wrongEvent: AppEvent = {
      type: 'chord.added',
      payload: { bar: 0, chordSymbol: 'G' },
    };
    const goal = {
      kind: 'event' as const,
      eventType: 'chord.added' as const,
      count: 1,
      match: { chordSymbol: 'C' },
    };
    expect(checkGoalOnEvent(goal, wrongEvent, project, 0).satisfied).toBe(false);

    const rightEvent: AppEvent = {
      type: 'chord.added',
      payload: { bar: 0, chordSymbol: 'C' },
    };
    expect(checkGoalOnEvent(goal, rightEvent, project, 0).satisfied).toBe(true);
  });

  it.each([
    { key: 'C', scale: 'major', satisfied: true },
    { key: 'C', scale: 'naturalMinor', satisfied: false },
    { key: 'G', scale: 'major', satisfied: false },
    { key: 'G', scale: 'naturalMinor', satisfied: false },
  ] as const)(
    'matches scale snap only for the exact key/scale pair: $key $scale',
    ({ key, scale, satisfied }) => {
      const event: AppEvent = {
        type: 'scale_snap.enabled',
        payload: { key, scale },
      };
      const goal = {
        kind: 'event' as const,
        eventType: 'scale_snap.enabled' as const,
        count: 1,
        match: { key: 'C', scale: 'major' } as const,
      };

      expect(checkGoalOnEvent(goal, event, project, 0)).toEqual({
        satisfied,
        newEventCount: satisfied ? 1 : 0,
      });
    },
  );

  it('exercise goal never satisfied by events', () => {
    const event: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    const goal = { kind: 'exercise' as const };
    const result = checkGoalOnEvent(goal, event, project, 0);
    expect(result.satisfied).toBe(false);
  });
});
