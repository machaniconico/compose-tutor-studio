import { describe, it, expect } from 'vitest';
import { analyzeNoteAgainstChordAndScale } from '../src/index';

// prompt 02 関数 9 (analyzeNoteAgainstChordAndScale)。

describe('analyzeNoteAgainstChordAndScale (prompt 02)', () => {
  it('E over C chord => chordTone (3度), 正確なメッセージ', () => {
    const r = analyzeNoteAgainstChordAndScale('E', 'C', 'C', 'major');
    expect(r.relation).toBe('chordTone');
    expect(r.degreeInChord).toBe('3度');
    expect(r.severity).toBe('info');
    expect(r.message).toBe('EはCコードの3度（安定音）です。');
  });

  it('MIDI 64 (E4) over C chord => chordTone', () => {
    const r = analyzeNoteAgainstChordAndScale(64, 'C', 'C', 'major');
    expect(r.relation).toBe('chordTone');
    expect(r.degreeInChord).toBe('3度');
  });

  it('D over C chord in C major => scaleTone', () => {
    const r = analyzeNoteAgainstChordAndScale('D', 'C', 'C', 'major');
    expect(r.relation).toBe('scaleTone');
    expect(r.severity).toBe('info');
  });

  it('G over C chord => chordTone 5度', () => {
    const r = analyzeNoteAgainstChordAndScale('G', 'C', 'C', 'major');
    expect(r.relation).toBe('chordTone');
    expect(r.degreeInChord).toBe('5度');
  });

  it('F# over C chord in C major => tension (♯11 の色付け)', () => {
    // F# はスケール外だが C に対して ♯11 のテンションとして解釈する
    // (Musical Correctness Rules: 非スケール音を一律に誤りとしない)。
    const r = analyzeNoteAgainstChordAndScale('F#', 'C', 'C', 'major');
    expect(r.relation).toBe('tension');
    expect(r.severity).toBe('info');
  });

  it('Eb over C chord in C major => nonScale (warn)', () => {
    // Eb はコード構成音でもスケール音でも認識テンションでもない。
    const r = analyzeNoteAgainstChordAndScale('Eb', 'C', 'C', 'major');
    expect(r.relation).toBe('nonScale');
    expect(r.severity).toBe('warn');
  });

  it('不正なコードは warn を返し落ちない', () => {
    const r = analyzeNoteAgainstChordAndScale('C', 'Hxyz', 'C', 'major');
    expect(r.severity).toBe('warn');
  });
});
