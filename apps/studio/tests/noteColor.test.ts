import { describe, expect, it } from 'vitest';
import type { ChordEvent } from '@cts/project-model';
import { SCALE_NAMES } from '@cts/theory-engine';
import { classifyNote, noteColorLabel, NOTE_COLOR_MODES } from '../src/features/pianoRoll/noteColor';

const cMajor: ChordEvent = {
  id: 'c1',
  startBeat: 0,
  durationBeats: 4,
  symbol: 'C',
  root: 'C',
  quality: 'major',
  notes: [60, 64, 67],
};

describe('classifyNote (C major, chord C)', () => {
  it('E4 はコードの音', () => {
    const r = classifyNote(64, cMajor, 'C', 'major', 'chordTone');
    expect(r.category).toBe('chordTone');
    expect(r.label).toContain('コードの音');
  });
  it('コードの音はオクターブが違っても同じ(pitch class で比べる)', () => {
    expect(classifyNote(40, cMajor, 'C', 'major', 'chordTone').category).toBe('chordTone');
  });
  it('D4 はスケールの音(経過音の候補)', () => {
    const r = classifyNote(62, cMajor, 'C', 'major', 'chordTone');
    expect(r.category).toBe('scaleTone');
    expect(r.label).toContain('経過音の候補');
  });
  it('C#4 はスケール外(彩りの音)で、「誤り」とは書かない', () => {
    const r = classifyNote(61, cMajor, 'C', 'major', 'chordTone');
    expect(r.category).toBe('outside');
    expect(r.label).toContain('彩りの音');
    expect(r.label).not.toContain('誤り');
    expect(noteColorLabel(r, 'beginner')).not.toContain('誤り');
  });
  it('色だけでなく記号でも区別できる(3 種で記号が異なる)', () => {
    const symbols = [64, 62, 61].map((m) => classifyNote(m, cMajor, 'C', 'major', 'chordTone').symbol);
    expect(new Set(symbols).size).toBe(3);
    expect(symbols.every((s) => s.length > 0)).toBe(true);
  });
  it('コードが無い拍ではスケールだけで判定する', () => {
    expect(classifyNote(64, undefined, 'C', 'major', 'chordTone').category).toBe('scaleTone');
    expect(classifyNote(61, undefined, 'C', 'major', 'chordTone').category).toBe('outside');
  });
  it('plain は常に plain', () => {
    expect(classifyNote(61, cMajor, 'C', 'major', 'plain').category).toBe('plain');
  });
  it('degree はスケール度数を返し、スケール外は彩りの音', () => {
    const r = classifyNote(67, cMajor, 'C', 'major', 'degree');
    expect(r.category).toBe('degree');
    expect(r.symbol).toBe('Ⅴ');
    expect(classifyNote(61, cMajor, 'C', 'major', 'degree').label).not.toContain('誤り');
  });
  it('不正なキーでも落ちず、コードの音だけ判定できる', () => {
    expect(classifyNote(64, cMajor, 'H?', 'major', 'chordTone').category).toBe('chordTone');
    expect(classifyNote(62, cMajor, 'H?', 'major', 'chordTone').category).toBe('outside');
  });
  it('4 つのモードが公開されている', () => {
    expect(NOTE_COLOR_MODES.map((m) => m.mode)).toEqual(['plain', 'chordTone', 'degree', 'velocity']);
  });
});

describe('classifyNote velocity モード', () => {
  const level = (v: number) => classifyNote(60, cMajor, 'C', 'major', 'velocity', v).level;
  it('4 段階に分かれる(境界を含む)', () => {
    expect([0, 31, 32, 63, 64, 95, 96, 127].map(level)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(new Set([10, 40, 70, 110].map(level)).size).toBe(4);
  });
  it('範囲外・未指定でも落ちない', () => {
    expect(level(-5)).toBe(0);
    expect(level(500)).toBe(3);
    expect(classifyNote(60, cMajor, 'C', 'major', 'velocity').level).toBe(0);
  });
});

describe('noteColorLabel の難易度', () => {
  it('初心者向けは「経過音」をやさしく言い換える', () => {
    const r = classifyNote(62, cMajor, 'C', 'major', 'chordTone');
    expect(noteColorLabel(r, 'standard')).toContain('経過音の候補');
    expect(noteColorLabel(r, 'beginner')).not.toContain('経過音');
  });
});

describe('スケール名の取りこぼし(validateProject は scale を検査しない)', () => {
  const modes = ['plain', 'chordTone', 'degree', 'velocity'] as const;
  it('theory-engine が持つすべてのスケールで、全モードが落ちない', () => {
    for (const scale of SCALE_NAMES) {
      for (const mode of modes) {
        expect(() => classifyNote(64, cMajor, 'C', scale, mode, 80)).not.toThrow();
      }
    }
  });
  it('未知のスケール名(dorian など)でも throw せず、度数は出さず説明文を返す', () => {
    for (const scale of ['dorian', 'constructor', '__proto__', '', 'toString']) {
      for (const mode of modes) {
        expect(() => classifyNote(64, undefined, 'C', scale as never, mode, 80)).not.toThrow();
      }
      const r = classifyNote(64, undefined, 'C', scale as never, 'degree');
      expect(r.symbol).toBe('');
      expect(r.label).toContain('対応していません');
      expect(r.label).not.toContain('誤り');
      const c = classifyNote(62, undefined, 'C', scale as never, 'chordTone');
      expect(c.category).not.toBe('outside');
      expect(c.label).toContain('対応していません');
    }
  });
  it('未知のスケールでもコードの音は判定できる', () => {
    expect(classifyNote(64, cMajor, 'C', 'dorian' as never, 'chordTone').category).toBe('chordTone');
  });
});

describe('保存データの型が壊れていても落ちない', () => {
  const modes = ['plain', 'chordTone', 'degree', 'velocity'] as const;
  const weird: unknown[] = [null, undefined, 0, 1, NaN, true, {}, { toString: null }, { toString: () => 'major' }, [], ['major'], '__proto__', 'hasOwnProperty'];
  it('scale が文字列以外・特殊名でも throw しない', () => {
    for (const scale of weird) {
      for (const mode of modes) {
        expect(() => classifyNote(64, cMajor, 'C', scale as never, mode, 80)).not.toThrow();
      }
      expect(classifyNote(62, undefined, 'C', scale as never, 'chordTone').label).toContain('対応していません');
    }
  });
  it('key が文字列以外でも throw しない', () => {
    for (const key of weird) {
      for (const mode of modes) {
        expect(() => classifyNote(64, cMajor, key as never, 'major', mode, 80)).not.toThrow();
      }
    }
  });
});
