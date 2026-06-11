import { describe, expect, it } from 'vitest';
import { explainPredicate } from '../src/feedback.js';
import {
  makeDrumEvent,
  makeDrumTrack,
  makeMelodyTrack,
  makeNote,
  makeProject,
  makeSection,
} from './helpers.js';

// ─── chordCountAtLeast ────────────────────────────────────────────────────────

describe('explainPredicate — chordCountAtLeast', () => {
  const predicate = { type: 'chordCountAtLeast' as const, value: 4 };

  it('grade=success when chord count meets target', () => {
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
        { id: '3', startBeat: 8, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'minor', notes: [] },
        { id: '4', startBeat: 12, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [] },
      ],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(true);
    expect(result.grade).toBe('success');
    expect(result.reason).toContain('4');
    expect(result.nextAction).toBe('');
  });

  it('grade=close when some chords placed but below target', () => {
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
      ],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('2');
    expect(result.nextAction).toContain('2');
  });

  it('grade=needs_work when no chords placed', () => {
    const project = makeProject({ chordTrack: [] });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.nextAction).not.toBe('');
  });
});

// ─── progressionEquals ───────────────────────────────────────────────────────

describe('explainPredicate — progressionEquals', () => {
  const symbols = ['C', 'G', 'Am', 'F'];
  const predicate = { type: 'progressionEquals' as const, symbols };

  it('grade=success when progression matches exactly', () => {
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
        { id: '3', startBeat: 8, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'minor', notes: [] },
        { id: '4', startBeat: 12, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [] },
      ],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(true);
    expect(result.grade).toBe('success');
    expect(result.nextAction).toBe('');
  });

  it('grade=close when same length and exactly half symbols match (ceil boundary)', () => {
    // C, G match (2/4 = 50%, ceil(4/2)=2 → at threshold)
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
        { id: '3', startBeat: 8, durationBeats: 4, symbol: 'Dm', root: 'D', quality: 'minor', notes: [] },
        { id: '4', startBeat: 12, durationBeats: 4, symbol: 'Em', root: 'E', quality: 'minor', notes: [] },
      ],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
  });

  it('grade=close when 3 out of 4 symbols match', () => {
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
        { id: '3', startBeat: 8, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'minor', notes: [] },
        { id: '4', startBeat: 12, durationBeats: 4, symbol: 'Em', root: 'E', quality: 'minor', notes: [] },
      ],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
  });

  it('grade=needs_work when empty chord track', () => {
    const project = makeProject({ chordTrack: [] });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.reason).toContain('なし');
  });

  it('grade=needs_work when wrong length (no position comparison possible)', () => {
    const project = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'D', root: 'D', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'E', root: 'E', quality: 'major', notes: [] },
      ],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
  });
});

// ─── drumLaneActive ───────────────────────────────────────────────────────────

describe('explainPredicate — drumLaneActive', () => {
  const predicate = { type: 'drumLaneActive' as const, lane: 'kick' as const, minSteps: 4 };

  it('grade=success when step count meets target', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([
        makeDrumEvent('kick', 0), makeDrumEvent('kick', 4),
        makeDrumEvent('kick', 8), makeDrumEvent('kick', 12),
      ])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(true);
    expect(result.grade).toBe('success');
    expect(result.nextAction).toBe('');
  });

  it('grade=close when some steps placed but below required', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('kick', 0), makeDrumEvent('kick', 8)])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('キック');
  });

  it('grade=close with single step placed (minSteps=4)', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('kick', 0)])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
  });

  it('grade=needs_work with no drum track', () => {
    const project = makeProject({ tracks: [] });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
  });

  it('grade=needs_work when kick lane empty but other lane has steps', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('snare', 4)])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
  });

  it('snare label translated correctly on close grade', () => {
    const snarePredicate = { type: 'drumLaneActive' as const, lane: 'snare' as const, minSteps: 3 };
    const project = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('snare', 4)])],
    });
    const result = explainPredicate(snarePredicate, project);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('スネア');
  });
});

// ─── drumPatternHas ───────────────────────────────────────────────────────────

describe('explainPredicate — drumPatternHas', () => {
  const predicate = {
    type: 'drumPatternHas' as const,
    lanes: [
      { lane: 'kick' as const, minSteps: 2 },
      { lane: 'snare' as const, minSteps: 2 },
    ],
  };

  it('grade=success when all lanes meet requirements', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([
        makeDrumEvent('kick', 0), makeDrumEvent('kick', 8),
        makeDrumEvent('snare', 4), makeDrumEvent('snare', 12),
      ])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(true);
    expect(result.grade).toBe('success');
    expect(result.nextAction).toBe('');
  });

  it('grade=close when kick met but snare missing (1/2 lanes done)', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('kick', 0), makeDrumEvent('kick', 8)])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('スネア');
  });

  it('grade=close when snare met but kick missing (1/2 lanes done)', () => {
    const project = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('snare', 4), makeDrumEvent('snare', 12)])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('キック');
  });

  it('grade=needs_work when no lanes met (no tracks)', () => {
    const project = makeProject({ tracks: [] });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
  });

  it('grade=needs_work when drum track has no events', () => {
    const project = makeProject({ tracks: [makeDrumTrack([])] });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
  });
});

// ─── noteCountAtLeast ─────────────────────────────────────────────────────────

describe('explainPredicate — noteCountAtLeast', () => {
  const predicate = { type: 'noteCountAtLeast' as const, trackName: 'Melody', value: 6 };

  it('grade=success when note count meets target', () => {
    const project = makeProject({
      tracks: [makeMelodyTrack([
        makeNote(60), makeNote(62), makeNote(64),
        makeNote(65), makeNote(67), makeNote(69),
      ])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(true);
    expect(result.grade).toBe('success');
    expect(result.nextAction).toBe('');
  });

  it('grade=close when some notes exist but below target', () => {
    const project = makeProject({
      tracks: [makeMelodyTrack([makeNote(60), makeNote(62), makeNote(64)])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('3');
  });

  it('grade=close with a single note placed', () => {
    const project = makeProject({
      tracks: [makeMelodyTrack([makeNote(60)])],
    });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
  });

  it('grade=needs_work when track exists but has no notes', () => {
    const project = makeProject({ tracks: [makeMelodyTrack([])] });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
  });

  it('grade=needs_work when track is missing entirely', () => {
    const project = makeProject({ tracks: [] });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.nextAction).toContain('Melody');
  });
});

// ─── hasSection ───────────────────────────────────────────────────────────────

describe('explainPredicate — hasSection', () => {
  it('grade=success when section present', () => {
    const project = makeProject({ sections: [makeSection('chorus')] });
    const result = explainPredicate({ type: 'hasSection', sectionType: 'chorus' }, project);
    expect(result.satisfied).toBe(true);
    expect(result.grade).toBe('success');
    expect(result.reason).toContain('コーラス');
    expect(result.nextAction).toBe('');
  });

  it('grade=needs_work when section absent (binary — no partial state)', () => {
    const project = makeProject({ sections: [makeSection('verse')] });
    const result = explainPredicate({ type: 'hasSection', sectionType: 'chorus' }, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.reason).toContain('コーラス');
    expect(result.nextAction).toContain('コーラス');
  });

  it('grade=needs_work for verse when only chorus exists', () => {
    const project = makeProject({ sections: [makeSection('chorus')] });
    const result = explainPredicate({ type: 'hasSection', sectionType: 'verse' }, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.reason).toContain('ヴァース');
  });

  it('grade=needs_work with empty sections', () => {
    const project = makeProject({ sections: [] });
    const result = explainPredicate({ type: 'hasSection', sectionType: 'intro' }, project);
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.nextAction).not.toBe('');
  });
});

// ─── bpmInRange ───────────────────────────────────────────────────────────────

describe('explainPredicate — bpmInRange', () => {
  // range 100–140, span=40, tolerance=8
  const predicate = { type: 'bpmInRange' as const, min: 100, max: 140 };

  it('grade=success when BPM in range', () => {
    const project = makeProject({ bpm: 120 });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(true);
    expect(result.grade).toBe('success');
    expect(result.nextAction).toBe('');
  });

  it('grade=success at lower boundary (100)', () => {
    expect(explainPredicate(predicate, makeProject({ bpm: 100 })).grade).toBe('success');
  });

  it('grade=success at upper boundary (140)', () => {
    expect(explainPredicate(predicate, makeProject({ bpm: 140 })).grade).toBe('success');
  });

  it('grade=close when BPM slightly below min (92, within tolerance=8)', () => {
    const result = explainPredicate(predicate, makeProject({ bpm: 92 }));
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('遅');
  });

  it('grade=close when BPM slightly above max (148, within tolerance=8)', () => {
    const result = explainPredicate(predicate, makeProject({ bpm: 148 }));
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('速');
  });

  it('grade=needs_work when BPM far below range', () => {
    const result = explainPredicate(predicate, makeProject({ bpm: 40 }));
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.nextAction).toContain('100');
  });

  it('grade=needs_work when BPM far above range', () => {
    const result = explainPredicate(predicate, makeProject({ bpm: 220 }));
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.nextAction).toContain('140');
  });
});

// ─── trackVolumeInRange ───────────────────────────────────────────────────────

describe('explainPredicate — trackVolumeInRange', () => {
  // range 0.6–1.0, span=0.4, tolerance=max(0.08,0.1)=0.1
  const predicate = {
    type: 'trackVolumeInRange' as const,
    trackName: 'Melody',
    min: 0.6,
    max: 1.0,
  };

  it('grade=success when volume in range (default 1.0)', () => {
    const project = makeProject({ tracks: [makeMelodyTrack([])] });
    const result = explainPredicate(predicate, project);
    expect(result.satisfied).toBe(true);
    expect(result.grade).toBe('success');
    expect(result.nextAction).toBe('');
  });

  it('grade=close when volume slightly below min (0.52, within tolerance=0.1)', () => {
    const track = { ...makeMelodyTrack([]), volume: 0.52 };
    const result = explainPredicate(predicate, makeProject({ tracks: [track] }));
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('小さ');
  });

  it('grade=close when volume slightly above max (1.05, within tolerance=0.1)', () => {
    const track = { ...makeMelodyTrack([]), volume: 1.05 };
    const result = explainPredicate(predicate, makeProject({ tracks: [track] }));
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('close');
    expect(result.reason).toContain('大き');
  });

  it('grade=needs_work when volume far below min (0.2)', () => {
    const track = { ...makeMelodyTrack([]), volume: 0.2 };
    const result = explainPredicate(predicate, makeProject({ tracks: [track] }));
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.nextAction).toContain('60');
  });

  it('grade=needs_work when volume far above max (1.8)', () => {
    const track = { ...makeMelodyTrack([]), volume: 1.8 };
    const result = explainPredicate(predicate, makeProject({ tracks: [track] }));
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.nextAction).toContain('100');
  });

  it('grade=needs_work when track not found', () => {
    const result = explainPredicate(predicate, makeProject({ tracks: [] }));
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.reason).toContain('Melody');
  });
});

// ─── exportCompleted ─────────────────────────────────────────────────────────

describe('explainPredicate — exportCompleted', () => {
  it('grade=needs_work for midi (always unsatisfied from project state)', () => {
    const result = explainPredicate({ type: 'exportCompleted', format: 'midi' }, makeProject());
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.reason).toContain('MIDI');
    expect(result.nextAction).toContain('MIDI');
  });

  it('grade=needs_work for wav', () => {
    const result = explainPredicate({ type: 'exportCompleted', format: 'wav' }, makeProject());
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.reason).toContain('WAV');
  });

  it('grade=needs_work when no format specified', () => {
    const result = explainPredicate({ type: 'exportCompleted' }, makeProject());
    expect(result.satisfied).toBe(false);
    expect(result.grade).toBe('needs_work');
    expect(result.nextAction).toContain('エクスポート');
  });
});
