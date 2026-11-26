import { describe, expect, it } from 'vitest';
import { expandClip, validateProject } from '@cts/project-model';
import { checkGoalOnEvent, evaluateProjectPredicate } from '../src/goals.js';
import { resolveTrack, resolveTrackByPredicateName, roleForTrackName } from '../src/trackResolve.js';
import type { AppEvent } from '../src/types.js';
import {
  makeDrumEvent,
  makeBassTrack,
  makeBrokenLinkProject,
  makeDrumTrack,
  makeMelodyTrack,
  makeNote,
  makeProject,
  makeSection,
  makeChord,
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
});

// ─── hasSection ───────────────────────────────────────────────────────────────

describe('role による役割解決 (trackName はフォールバック)', () => {
  const renamedBass = () =>
    makeBassTrack([makeNote(36), makeNote(38)], { name: 'ベース', role: 'bass', volume: 0.7 });

  it('role=bass で名前が「ベース」でも trackName:Bass の noteCountAtLeast が通る', () => {
    const project = makeProject({ tracks: [renamedBass()] });
    expect(
      evaluateProjectPredicate({ type: 'noteCountAtLeast', trackName: 'Bass', value: 2 }, project),
    ).toBe(true);
    expect(
      evaluateProjectPredicate({ type: 'noteCountAtLeast', trackName: 'Bass', value: 3 }, project),
    ).toBe(false);
  });

  it('role=bass で名前が「ベース」でも trackName:Bass の trackVolumeInRange が通る', () => {
    const project = makeProject({ tracks: [renamedBass()] });
    expect(
      evaluateProjectPredicate(
        { type: 'trackVolumeInRange', trackName: 'Bass', min: 0.6, max: 0.8 },
        project,
      ),
    ).toBe(true);
  });

  it('role が無く名前も一致しなければ満たさない', () => {
    const project = makeProject({
      tracks: [makeBassTrack([makeNote(36)], { name: 'ベース' })],
    });
    expect(
      evaluateProjectPredicate({ type: 'noteCountAtLeast', trackName: 'Bass', value: 1 }, project),
    ).toBe(false);
  });
});

describe('resolveTrack', () => {
  it('role 一致を名前一致より優先し、どちらも無ければ null', () => {
    const byName = makeBassTrack([], { id: 'by-name', name: 'Bass' });
    const byRole = makeBassTrack([], { id: 'by-role', name: 'ベース', role: 'bass' });
    const project = makeProject({ tracks: [byName, byRole] });
    expect(resolveTrack(project, { role: 'bass', trackName: 'Bass' })?.id).toBe('by-role');
    expect(resolveTrack(project, { trackName: 'Bass' })?.id).toBe('by-name');
    expect(resolveTrack(project, { role: 'melody', trackName: 'Nope' })).toBeNull();
    expect(resolveTrack(project, {})).toBeNull();
  });

  it('roleForTrackName は標準名を role に対応づける', () => {
    expect(roleForTrackName('Bass')).toBe('bass');
    expect(roleForTrackName('Chords')).toBe('chords');
    expect(roleForTrackName('Melody')).toBe('melody');
    expect(roleForTrackName('Drums')).toBe('drums');
    expect(roleForTrackName('Piano')).toBeUndefined();
  });

  it('roleForTrackName は Object のプロトタイプ名を role と誤認しない', () => {
    expect(roleForTrackName('constructor')).toBeUndefined();
    expect(roleForTrackName('__proto__')).toBeUndefined();
    expect(roleForTrackName('toString')).toBeUndefined();
    expect(roleForTrackName('')).toBeUndefined();
  });

  it('プロトタイプ名の trackName でも名前一致だけで解決する', () => {
    const named = makeBassTrack([], { id: 'proto', name: 'constructor' });
    const project = makeProject({ tracks: [named] });
    expect(resolveTrackByPredicateName(project, 'constructor')?.id).toBe('proto');
    expect(resolveTrackByPredicateName(project, '__proto__')).toBeNull();
  });
});

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

  describe('EventMatch.trackName と role', () => {
    const goal = {
      kind: 'event' as const,
      eventType: 'note.added' as const,
      count: 1,
      match: { trackName: 'Bass' },
    };
    const noteOn = (trackId: string, trackName: string): AppEvent => ({
      type: 'note.added',
      payload: { pitch: 36, startBeat: 0, durationBeats: 1, trackId, trackName, inScale: true },
    });

    it('role=bass で名前が「ベース」のトラックのイベントが通る', () => {
      const bass = makeBassTrack([], { id: 'b', name: 'ベース', role: 'bass' });
      const p = makeProject({ tracks: [bass] });
      expect(checkGoalOnEvent(goal, noteOn('b', 'ベース'), p, 0).satisfied).toBe(true);
    });

    it('同じ role のトラックが複数あれば、判定対象の先頭トラックへのイベントだけが通る', () => {
      const first = makeBassTrack([], { id: 'b1', name: 'ベース1', role: 'bass' });
      const second = makeBassTrack([], { id: 'b2', name: 'ベース2', role: 'bass' });
      const p = makeProject({ tracks: [first, second] });
      expect(checkGoalOnEvent(goal, noteOn('b1', 'ベース1'), p, 0).satisfied).toBe(true);
      expect(checkGoalOnEvent(goal, noteOn('b2', 'ベース2'), p, 0).satisfied).toBe(false);
    });

    it('イベント・ノート数・音楽的判定はすべて同じトラックを見る', () => {
      const bassNotes = [makeNote(36, 0), makeNote(36, 1), makeNote(36, 2), makeNote(36, 3)];
      const melody = makeMelodyTrack([], { id: 'm', name: 'メロディ', role: 'melody' });
      const chords = [makeChord('C', 0)];
      const noteCount = {
        kind: 'project' as const,
        predicate: { type: 'noteCountAtLeast' as const, trackName: 'Bass', value: 4 },
      };
      const bassRoot = {
        type: 'hasBassRootOnDownbeat' as const,
        trackName: 'Bass',
        minRatio: 1,
      };
      const withinScale = {
        type: 'hasNotesWithinScale' as const,
        trackName: 'Bass',
        minRatio: 1,
      };

      const onFirst = makeProject({
        chordTrack: chords,
        tracks: [
          melody,
          makeBassTrack(bassNotes, { id: 'b1', name: 'ベース1', role: 'bass' }),
          makeBassTrack([], { id: 'b2', name: 'ベース2', role: 'bass' }),
        ],
      });
      expect(checkGoalOnEvent(goal, noteOn('b1', 'ベース1'), onFirst, 0).satisfied).toBe(true);
      expect(checkGoalOnEvent(noteCount, noteOn('b1', 'ベース1'), onFirst, 0).satisfied).toBe(true);
      expect(evaluateProjectPredicate(bassRoot, onFirst)).toBe(true);
      expect(evaluateProjectPredicate(withinScale, onFirst)).toBe(true);

      const onSecond = makeProject({
        chordTrack: chords,
        tracks: [
          melody,
          makeBassTrack([], { id: 'b1', name: 'ベース1', role: 'bass' }),
          makeBassTrack(bassNotes, { id: 'b2', name: 'ベース2', role: 'bass' }),
        ],
      });
      expect(checkGoalOnEvent(goal, noteOn('b2', 'ベース2'), onSecond, 0).satisfied).toBe(false);
      expect(checkGoalOnEvent(noteCount, noteOn('b2', 'ベース2'), onSecond, 0).satisfied).toBe(
        false,
      );
      expect(evaluateProjectPredicate(bassRoot, onSecond)).toBe(false);
      expect(evaluateProjectPredicate(withinScale, onSecond)).toBe(false);
    });

    it('別 role のトラックは、名前が Bass でも role=bass が別にあれば通らない', () => {
      const realBass = makeBassTrack([], { id: 'b', name: 'ベース', role: 'bass' });
      const misnamed = makeMelodyTrack([], { id: 'm', name: 'Bass', role: 'melody' });
      const p = makeProject({ tracks: [realBass, misnamed] });
      expect(checkGoalOnEvent(goal, noteOn('m', 'Bass'), p, 0).satisfied).toBe(false);
    });

    it('role の無い旧プロジェクトは名前一致で通り、別名なら通らない', () => {
      const legacy = makeBassTrack([], { id: 'b', name: 'Bass' });
      const other = makeMelodyTrack([], { id: 'm', name: 'ベース' });
      const p = makeProject({ tracks: [legacy, other] });
      expect(checkGoalOnEvent(goal, noteOn('b', 'Bass'), p, 0).satisfied).toBe(true);
      expect(checkGoalOnEvent(goal, noteOn('m', 'ベース'), p, 0).satisfied).toBe(false);
    });

    it('プロジェクトに無い trackId はイベントの名前で判定する', () => {
      const p = makeProject({ tracks: [] });
      expect(checkGoalOnEvent(goal, noteOn('gone', 'Bass'), p, 0).satisfied).toBe(true);
      expect(checkGoalOnEvent(goal, noteOn('gone', 'Piano'), p, 0).satisfied).toBe(false);
    });
  });

  it('exercise goal never satisfied by events', () => {
    const event: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    const goal = { kind: 'exercise' as const };
    const result = checkGoalOnEvent(goal, event, project, 0);
    expect(result.satisfied).toBe(false);
  });
});

// ─── exportCompleted predicate via checkGoalOnEvent ───────────────────────────

describe('checkGoalOnEvent — exportCompleted predicate', () => {
  const project = makeProject();

  it('satisfies on export.midi event when format is midi', () => {
    const event: AppEvent = { type: 'export.midi', payload: { format: 'midi' } };
    const goal = {
      kind: 'project' as const,
      predicate: { type: 'exportCompleted' as const, format: 'midi' as const },
    };
    const result = checkGoalOnEvent(goal, event, project, 0);
    expect(result.satisfied).toBe(true);
  });

  it('satisfies on export.wav event when format is wav', () => {
    const event: AppEvent = { type: 'export.wav', payload: { format: 'wav' } };
    const goal = {
      kind: 'project' as const,
      predicate: { type: 'exportCompleted' as const, format: 'wav' as const },
    };
    const result = checkGoalOnEvent(goal, event, project, 0);
    expect(result.satisfied).toBe(true);
  });

  it('satisfies on export.midi when format is undefined (any format)', () => {
    const event: AppEvent = { type: 'export.midi', payload: { format: 'midi' } };
    const goal = {
      kind: 'project' as const,
      predicate: { type: 'exportCompleted' as const },
    };
    const result = checkGoalOnEvent(goal, event, project, 0);
    expect(result.satisfied).toBe(true);
  });

  it('does NOT satisfy when format is midi but event is export.wav', () => {
    const event: AppEvent = { type: 'export.wav', payload: { format: 'wav' } };
    const goal = {
      kind: 'project' as const,
      predicate: { type: 'exportCompleted' as const, format: 'midi' as const },
    };
    const result = checkGoalOnEvent(goal, event, project, 0);
    expect(result.satisfied).toBe(false);
  });

  it('does NOT satisfy on non-export event', () => {
    const event: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
    const goal = {
      kind: 'project' as const,
      predicate: { type: 'exportCompleted' as const, format: 'midi' as const },
    };
    const result = checkGoalOnEvent(goal, event, project, 0);
    expect(result.satisfied).toBe(false);
  });
});

// ─── drumLaneActive — dedup step indices ──────────────────────────────────────

describe('drumLaneActive — dedup unique step indices', () => {
  it('counts unique step indices, not raw event count', () => {
    // Same stepIndex toggled twice should count as 1 unique step
    const project = makeProject({
      tracks: [
        makeDrumTrack([
          makeDrumEvent('kick', 0),
          makeDrumEvent('kick', 0), // duplicate
          makeDrumEvent('kick', 4),
        ]),
      ],
    });
    // Only 2 unique steps (0 and 4), not 3 raw events
    expect(
      evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'kick', minSteps: 2 }, project),
    ).toBe(true);
    expect(
      evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'kick', minSteps: 3 }, project),
    ).toBe(false);
  });

  it('returns false when snare lane is empty even if kick is active', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('kick', 0), makeDrumEvent('kick', 8)])],
    });
    expect(
      evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'snare', minSteps: 1 }, project),
    ).toBe(false);
  });

  it('returns true when both kick and snare each meet minSteps independently', () => {
    const project = makeProject({
      tracks: [
        makeDrumTrack([
          makeDrumEvent('kick', 0),
          makeDrumEvent('kick', 8),
          makeDrumEvent('snare', 4),
          makeDrumEvent('snare', 12),
        ]),
      ],
    });
    expect(
      evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'kick', minSteps: 2 }, project),
    ).toBe(true);
    expect(
      evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'snare', minSteps: 2 }, project),
    ).toBe(true);
  });
});

describe('linked (aliasOf) clips', () => {
  it.each(['missing', 'cyclic'] as const)('ignores notes stored on a %s link', (kind) => {
    const project = makeBrokenLinkProject(kind);
    const clips = project.tracks.flatMap((track) => track.clips);
    expect(validateProject(project).valid).toBe(true);
    expect(expandClip(clips[0]!, clips).notes).toEqual([]);
    expect(evaluateProjectPredicate({ type: 'noteCountAtLeast', trackName: 'Melody', value: 1 }, project)).toBe(false);
  });

  it.each(['missing', 'cyclic'] as const)('ignores drum hits stored on a %s link', (kind) => {
    const project = makeBrokenLinkProject(kind);
    expect(evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'kick', minSteps: 1 }, project)).toBe(false);
    expect(evaluateProjectPredicate({ type: 'drumPatternHas', lanes: [{ lane: 'kick', minSteps: 1 }] }, project)).toBe(false);
  });

  it('noteCountAtLeast and drumLaneActive count the content of the clip a link points at', () => {
    const melodySource = { ...makeMelodyTrack([makeNote(60), makeNote(62)]).clips[0]!, id: 'src', trackId: 'Sketch' };
    const drumSource = { ...makeDrumTrack([makeDrumEvent('kick', 0), makeDrumEvent('kick', 4)]).clips[0]!, id: 'drum-src' };
    const project = makeProject({
      tracks: [
        makeMelodyTrack([], {
          clips: [{ id: 'link', trackId: 'Melody', type: 'midi', startBeat: 16, lengthBeats: 16, loop: false, aliasOf: 'src' }],
        }),
        { ...makeDrumTrack([]), clips: [{ ...drumSource, id: 'drum-link', aliasOf: 'drum-src', drumEvents: undefined }] },
        makeMelodyTrack([], { id: 'Sketch', name: 'Sketch', clips: [melodySource, drumSource] }),
      ],
    });
    expect(evaluateProjectPredicate({ type: 'noteCountAtLeast', trackName: 'Melody', value: 2 }, project)).toBe(true);
    expect(evaluateProjectPredicate({ type: 'drumLaneActive', lane: 'kick', minSteps: 2 }, project)).toBe(true);
  });
});
