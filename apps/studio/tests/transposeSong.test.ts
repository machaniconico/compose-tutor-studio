import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createEmptyProject,
  type ChordEvent,
  type Clip,
  type Project,
  type ScaleName,
  type Track,
} from '@cts/project-model';
import { analyzeChord, keySignatureUsesFlats, transposeChordSymbol } from '@cts/theory-engine';
import { buildScheduleEvents } from '../src/audio/events';
import { KEY_OPTIONS } from '../src/features/transport/keyOptions';
import { spellPitchClassInKey } from '../src/state/keySpelling';
import { installLocalStorage } from './localStorageStub';
import {
  transposeProjectBySemitones,
  type TransposeSongResult,
} from '../src/state/transposeActions';

let useStore: typeof import('../src/state/store')['useStore'];
let transposeSong: typeof import('../src/state/transposeActions')['transposeSong'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ transposeSong } = await import('../src/state/transposeActions'));
});

function chord(id: string, startBeat: number, symbol: string, notes: number[], degree: string): ChordEvent {
  return { id, startBeat, durationBeats: 4, symbol, root: symbol.match(/^[A-G][#b]?/)?.[0] ?? symbol, quality: 'major', notes, function: 'T', degree };
}

function song(pitches: number[] = [60, 64, 67], over: Partial<Project> = {}): Project {
  const base = createEmptyProject({ key: over.key ?? 'C', scale: over.scale ?? 'major' });
  const tracks = base.tracks.map((track): Track => {
    if (track.type === 'instrument' && track.role === 'learning.melody') {
      const clip: Clip = {
        id: 'mel', trackId: track.id, type: 'midi', startBeat: 0, lengthBeats: 8, loop: false,
        notes: pitches.map((pitch, i) => ({ id: `n${i}`, pitch, startBeat: i, durationBeats: 1, velocity: 90 })),
      };
      return { ...track, clips: [clip] };
    }
    if (track.type === 'drum') {
      const clip: Clip = {
        id: 'dr', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 8, loop: false,
        stepsPerBar: 16, drumEvents: [{ id: 'd0', lane: 'kick', stepIndex: 0, velocity: 100 }],
      };
      return { ...track, clips: [clip] };
    }
    return track;
  });
  return {
    ...base,
    tracks,
    chordTrack: [chord('c1', 0, 'C', [0, 4, 7], 'I'), chord('c2', 4, 'Am7', [9, 0, 4, 7], 'vi7')],
    ...over,
  };
}

function ok(result: TransposeSongResult): Extract<TransposeSongResult, { ok: true }> {
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe('transposeProjectBySemitones', () => {
  it('moves notes, chords and key; drums stay', () => {
    const before = song();
    const after = ok(transposeProjectBySemitones(before, 2)).project;
    expect(after.key).toBe('D');
    const mel = after.tracks.flatMap((t) => t.clips).find((c) => c.id === 'mel')!;
    expect(mel.notes!.map((n) => n.pitch)).toEqual([62, 66, 69]);
    expect(after.chordTrack.map((c) => c.symbol)).toEqual(['D', 'Bm7']);
    expect(after.chordTrack[1]!.notes).toEqual([11, 2, 6, 9]);
    expect(after.chordTrack[1]!.root).toBe('B');
    const drumTrackBefore = before.tracks.find((t) => t.type === 'drum')!;
    expect(after.tracks.find((t) => t.type === 'drum')).toBe(drumTrackBefore);
  });

  it('keeps scale-degree labels and spells chords for the new key', () => {
    const before = song();
    const after = ok(transposeProjectBySemitones(before, -1)).project;
    expect(after.key).toBe('B');
    expect(after.chordTrack.map((c) => c.degree)).toEqual(['I', 'vi7']);
    const flat = ok(transposeProjectBySemitones(before, 5)).project; // F major
    expect(flat.key).toBe('F');
    expect(flat.chordTrack.map((c) => c.symbol)).toEqual(['F', 'Dm7']);
    const gb = ok(transposeProjectBySemitones(before, 1)).project; // Db major
    expect(gb.key).toBe('Db');
    expect(keySignatureUsesFlats(`${gb.key} ${gb.scale}`)).toBe(true);
    expect(gb.chordTrack.map((c) => c.symbol)).toEqual(['Db', 'Bbm7']);
    const analysis = analyzeChord({ symbol: gb.chordTrack[0]!.symbol, key: gb.key, scale: gb.scale });
    expect(analysis.degree).toBe(analyzeChord({ symbol: 'C', key: 'C', scale: 'major' }).degree);
  });

  it('round-trips chord symbols and notes', () => {
    const before = song();
    const there = ok(transposeProjectBySemitones(before, 7)).project;
    const back = ok(transposeProjectBySemitones(there, -7)).project;
    expect(back.key).toBe('C');
    expect(back.chordTrack.map((c) => c.symbol)).toEqual(['C', 'Am7']);
    expect(back.chordTrack.map((c) => c.notes)).toEqual(before.chordTrack.map((c) => c.notes));
    expect(transposeChordSymbol('Am7', 0, 'C major')).toBe('Am7');
  });

  it('refuses the whole move when the highest note would pass 127, naming it', () => {
    const before = song([60, 126]);
    const result = transposeProjectBySemitones(before, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('F#9');
    // the highest source note reaches exactly 127: allowed
    expect(transposeProjectBySemitones(before, 1).ok).toBe(true);
  });

  it('refuses the whole move when the lowest note would pass below 0, naming it', () => {
    const before = song([1, 60]);
    const result = transposeProjectBySemitones(before, -2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('C#-1');
    expect(transposeProjectBySemitones(before, -1).ok).toBe(true);
  });

  it('refuses out-of-range and non-integer amounts, and 0 changes nothing', () => {
    const before = song();
    for (const n of [13, -13, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(transposeProjectBySemitones(before, n).ok).toBe(false);
    }
    const zero = ok(transposeProjectBySemitones(before, 0));
    expect(zero.changed).toBe(false);
    expect(zero.project).toBe(before);
  });

  it('refuses an unreadable chord symbol and tolerates {toString:null} values', () => {
    const before = { ...song(), chordTrack: [chord('x', 0, 'H??', [0], 'I')] };
    const result = transposeProjectBySemitones(before, 2);
    expect(result.ok).toBe(false);
    const weird = { ...song(), key: { toString: null } as unknown as Project['key'] };
    expect(() => transposeProjectBySemitones(weird, 2)).not.toThrow();
    expect(transposeProjectBySemitones(weird, 2).ok).toBe(false);
  });

  it('does not move notes on a drumkit instrument track or drum notes, and leaves audio untouched', () => {
    const base = song();
    const kitTrack: Track = {
      ...base.tracks[0]!, id: 'kit', role: 'general', instrument: { type: 'drumkit', preset: 'acoustic' },
      clips: [{ id: 'kitclip', trackId: 'kit', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, notes: [{ id: 'k', pitch: 36, startBeat: 0, durationBeats: 1, velocity: 90 }] }],
    };
    const audioTrack: Track = {
      ...base.tracks[0]!, id: 'aud', type: 'audio', role: 'general', instrument: undefined as never,
      clips: [{ id: 'ac', trackId: 'aud', type: 'audio', startBeat: 0, lengthBeats: 4, loop: false }],
    };
    const before: Project = { ...base, tracks: [...base.tracks, kitTrack, audioTrack] };
    const after = ok(transposeProjectBySemitones(before, 3)).project;
    expect(after.tracks.find((t) => t.id === 'kit')).toBe(kitTrack);
    expect(after.tracks.find((t) => t.id === 'aud')).toBe(audioTrack);
  });

  it('keeps timing, durations and drum hits in the schedule (seeded fuzz)', () => {
    let seed = 20261128;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 200; i += 1) {
      const pitches = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => Math.floor(rnd() * 128));
      const n = Math.floor(rnd() * 25) - 12;
      const before = song(pitches);
      const result = transposeProjectBySemitones(before, n);
      const fits = pitches.every((p) => p + n >= 0 && p + n <= 127);
      expect(result.ok).toBe(fits);
      if (!result.ok) {
        continue;
      }
      const a = buildScheduleEvents(before);
      const b = buildScheduleEvents(result.project);
      expect(b.length).toBe(a.length);
      a.forEach((x, k) => {
        expect(b[k]!.beat).toBe(x.beat);
        const px = x.payload as { kind: string; pitch?: number; trackId: string };
        const py = b[k]!.payload as { kind: string; pitch?: number };
        expect(py.kind).toBe(px.kind);
        if (px.kind === 'drum') expect(py).toEqual(px);
        else expect(((py.pitch ?? 0) - (px.pitch ?? 0) - n) % 12 === 0).toBe(true);
      });
    }
  });
});

describe('P35 review findings', () => {
  const one = (symbol: string, notes: number[], over: Partial<Project> = {}): Project =>
    song([60], { chordTrack: [chord('x', 0, symbol, notes, 'I')], ...over });
  const chordsOf = (r: TransposeSongResult) => ok(r).project.chordTrack[0]!;

  it('1: A minor F +6 spells Cb in Eb minor', () => {
    const r = transposeProjectBySemitones(one('F', [5, 9, 0], { key: 'A', scale: 'naturalMinor' }), 6);
    expect(ok(r).key).toBe('Eb');
    expect(chordsOf(r).symbol).toBe('Cb');
    expect(chordsOf(r).root).toBe('Cb');
  });

  it('2: C major G7/B +6 is C#7/E# in F# major', () => {
    const r = transposeProjectBySemitones(one('G7/B', [7, 11, 2, 5]), 6);
    expect(ok(r).key).toBe('F#');
    expect(chordsOf(r).symbol).toBe('C#7/E#');
    expect(chordsOf(r).root).toBe('C#');
  });

  it('3: A minor F +5 gives symbol and root Bb', () => {
    const r = transposeProjectBySemitones(one('F', [5, 9, 0], { key: 'A', scale: 'naturalMinor' }), 5);
    expect(ok(r).key).toBe('D');
    expect(chordsOf(r).symbol).toBe('Bb');
    expect(chordsOf(r).root).toBe('Bb');
  });

  it('4: pitch-class chord +12 keeps the backing register', () => {
    const before = one('C', [0, 4, 7]);
    const r = ok(transposeProjectBySemitones(before, 12));
    expect(r.project.chordTrack[0]).toEqual(before.chordTrack[0]);
    const pitches = (p: Project) => buildScheduleEvents(p)
      .map((e) => e.payload as { kind: string; trackId: string; pitch?: number })
      .filter((e) => e.kind === 'note' && e.trackId === p.tracks.find((t) => t.role === 'learning.chords')!.id)
      .map((e) => e.pitch);
    expect(pitches(r.project)).toEqual(pitches(before));
  });

  it('5: absolute chord notes move exactly and are range-checked', () => {
    const moved = transposeProjectBySemitones(one('C', [24, 28, 31]), -12);
    expect(chordsOf(moved).notes).toEqual([12, 16, 19]);
    expect(chordsOf(moved).symbol).toBe('C');
    const low = transposeProjectBySemitones(one('C', [12, 16, 19]), -12);
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.reason).toMatch(/1小節目.*「C」.*低すぎて音の高さが保てません/);
    expect(transposeProjectBySemitones(one('C', [3, 14]), -12).ok).toBe(false);
    expect(transposeProjectBySemitones(one('C', [120, 127]), 12).ok).toBe(false);
  });

  it('6: octave moves keep key name and symbols', () => {
    for (const [key, sym] of [['Gb', 'Gb'], ['C#', 'C#']] as const) {
      const before = one(sym, [0, 4, 7], { key });
      for (const n of [12, -12]) {
        const r = ok(transposeProjectBySemitones(before, n));
        expect(r.key).toBe(key);
        expect(r.project.chordTrack[0]!.symbol).toBe(sym);
        expect(r.project.chordTrack[0]!.root).toBe(sym);
      }
    }
  });

  it('7: the new key is always one the key selector offers', () => {
    const r = ok(transposeProjectBySemitones(song([60], { key: 'C', scale: 'naturalMinor' }), 1));
    expect(r.key).toBe('Db');
    for (const key of KEY_OPTIONS) {
      for (const scale of ['major', 'naturalMinor'] as const) {
        for (let n = -11; n <= 11; n += 1) {
          const res = transposeProjectBySemitones(song([60], { key, scale }), n);
          if (res.ok && n !== 0) expect(KEY_OPTIONS).toContain(res.key);
        }
      }
    }
  });

  it('spells diatonic notes by key signature for every scale main offers, in all 12 keys', () => {
    const tables: Record<string, Record<string, string>> = {
      major: {
        C: 'C D E F G A B', G: 'G A B C D E F#', D: 'D E F# G A B C#', A: 'A B C# D E F# G#',
        E: 'E F# G# A B C# D#', B: 'B C# D# E F# G# A#', F: 'F G A Bb C D E', Bb: 'Bb C D Eb F G A',
        Eb: 'Eb F G Ab Bb C D', Ab: 'Ab Bb C Db Eb F G', Db: 'Db Eb F Gb Ab Bb C', 'F#': 'F# G# A# B C# D# E#',
      },
      naturalMinor: {
        A: 'A B C D E F G', E: 'E F# G A B C D', B: 'B C# D E F# G A', 'F#': 'F# G# A B C# D E',
        C: 'C D Eb F G Ab Bb', G: 'G A Bb C D Eb F', D: 'D E F G A Bb C', Bb: 'Bb C Db Eb F Gb Ab',
        Eb: 'Eb F Gb Ab Bb Cb Db', Ab: 'Ab Bb Cb Db Eb Fb Gb', Db: 'Db Eb Fb Gb Ab A Cb', F: 'F G Ab Bb C Db Eb',
      },
      harmonicMinor: {
        A: 'A B C D E F G#', E: 'E F# G A B C D#', B: 'B C# D E F# G A#', 'F#': 'F# G# A B C# D E#',
        C: 'C D Eb F G Ab B', G: 'G A Bb C D Eb F#', D: 'D E F G A Bb C#', Bb: 'Bb C Db Eb F Gb A',
        Eb: 'Eb F Gb Ab Bb Cb D', Ab: 'Ab Bb Cb Db Eb Fb G', Db: 'Db Eb Fb Gb Ab A C', F: 'F G Ab Bb C Db E',
      },
      melodicMinor: {
        A: 'A B C D E F# G#', E: 'E F# G A B C# D#', B: 'B C# D E F# G# A#', 'F#': 'F# G# A B C# D# E#',
        C: 'C D Eb F G A B', G: 'G A Bb C D E F#', D: 'D E F G A B C#', Bb: 'Bb C Db Eb F G A',
        Eb: 'Eb F Gb Ab Bb C D', Ab: 'Ab Bb Cb Db Eb F G', Db: 'Db Eb Fb Gb Ab Bb C', F: 'F G Ab Bb C D E',
      },
    };
    const offsets: Record<string, number[]> = {
      major: [0, 2, 4, 5, 7, 9, 11], naturalMinor: [0, 2, 3, 5, 7, 8, 10],
      harmonicMinor: [0, 2, 3, 5, 7, 8, 11], melodicMinor: [0, 2, 3, 5, 7, 9, 11],
    };
    const pcOf: Record<string, number> = { C: 0, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11, Db: 1 };
    for (const [scale, table] of Object.entries(tables)) {
      for (const [tonic, names] of Object.entries(table)) {
        const spelled = names.split(' ').map((_, i) =>
          spellPitchClassInKey((pcOf[tonic]! + offsets[scale]![i]!) % 12, tonic, scale as ScaleName));
        expect(spelled.join(' '), `${tonic} ${scale}`).toBe(names);
      }
    }
    // Pentatonic and blues use their parent major / minor's key-signature spelling.
    for (const tonic of Object.keys(tables.major!)) {
      for (let pc = 0; pc < 12; pc += 1) {
        expect(spellPitchClassInKey(pc, tonic, 'majorPentatonic')).toBe(spellPitchClassInKey(pc, tonic, 'major'));
        expect(spellPitchClassInKey(pc, tonic, 'minorPentatonic')).toBe(spellPitchClassInKey(pc, tonic, 'naturalMinor'));
        expect(spellPitchClassInKey(pc, tonic, 'blues')).toBe(spellPitchClassInKey(pc, tonic, 'naturalMinor'));
      }
    }
  });

  it('R2-1: refuses when the chord-backing track uses a drumkit', () => {
    const base = song();
    const tracks = base.tracks.map((t) => (t.role === 'learning.chords' ? { ...t, instrument: { type: 'drumkit' as const, preset: 'acoustic' } } : t));
    const r = transposeProjectBySemitones({ ...base, tracks }, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/コード.*ドラム.*楽器/);
  });

  it('R2-2: A harmonic minor E7/G# +5 is A7/C# in D harmonic minor', () => {
    const r = transposeProjectBySemitones(one('E7/G#', [4, 8, 11, 2], { key: 'A', scale: 'harmonicMinor' }), 5);
    expect(ok(r).key).toBe('D');
    expect(chordsOf(r).symbol).toBe('A7/C#');
    expect(chordsOf(r).root).toBe('A');
  });

  it('R2-3: root always equals the symbol root, also on octave moves', () => {
    const before = song([60], { chordTrack: [{ ...chord('x', 0, 'Db', [1, 5, 8], 'I'), root: 'C#' }], key: 'Db' });
    for (const n of [12, -12, 2]) {
      const c = chordsOf(transposeProjectBySemitones(before, n));
      expect(c.root).toBe(c.symbol.match(/^[A-G][#b]?/)![0]);
    }
    expect(chordsOf(transposeProjectBySemitones(before, 12)).root).toBe('Db');
  });

  it('is exactly one undo step', () => {
    const before = useStore.getState().project;
    const result = transposeSong(4);
    expect(result.ok ? '' : result.reason).toBe('');
    expect(useStore.getState().project.key).toBe('E');
    expect(useStore.getState().past.length).toBe(1);
    useStore.getState().undo();
    expect(useStore.getState().project.key).toBe('C');
    expect(useStore.getState().project.chordTrack).toEqual(before.chordTrack);
    expect(useStore.getState().past.length).toBe(0);
  });

  it('applies nothing when refused', () => {
    useStore.setState({ project: { ...song([120]), id: useStore.getState().project.id }, past: [], future: [] });
    const before = useStore.getState().project;
    const result = transposeSong(12);
    expect(result.ok).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past.length).toBe(0);
  });

  it('refuses while recording', () => {
    useStore.setState({ audioRecordingOperationId: 1 });
    const before = useStore.getState().project;
    const result = transposeSong(2);
    expect(result.ok).toBe(false);
    expect(useStore.getState().project).toBe(before);
    useStore.setState({ audioRecordingOperationId: null });
  });
});
