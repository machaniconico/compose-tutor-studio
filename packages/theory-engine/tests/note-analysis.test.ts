import { describe, it, expect } from 'vitest';
import { getNoteScaleDegree, describeNoteInKey, detectChordTensions } from '../src/index';

describe('getNoteScaleDegree', () => {
  it('C major スケールの各音に正しい度数を返す', () => {
    expect(getNoteScaleDegree('C', 'C', 'major')).toBe('Ⅰ');
    expect(getNoteScaleDegree('D', 'C', 'major')).toBe('Ⅱ');
    expect(getNoteScaleDegree('E', 'C', 'major')).toBe('Ⅲ');
    expect(getNoteScaleDegree('F', 'C', 'major')).toBe('Ⅳ');
    expect(getNoteScaleDegree('G', 'C', 'major')).toBe('Ⅴ');
    expect(getNoteScaleDegree('A', 'C', 'major')).toBe('Ⅵ');
    expect(getNoteScaleDegree('B', 'C', 'major')).toBe('Ⅶ');
  });

  it('MIDIノート番号でも正しく動作する', () => {
    // C4 = MIDI 60, pitch class 0 -> Ⅰ in C major
    expect(getNoteScaleDegree(60, 'C', 'major')).toBe('Ⅰ');
    // E4 = MIDI 64, pitch class 4 -> Ⅲ in C major
    expect(getNoteScaleDegree(64, 'C', 'major')).toBe('Ⅲ');
    // G4 = MIDI 67 -> Ⅴ in C major
    expect(getNoteScaleDegree(67, 'C', 'major')).toBe('Ⅴ');
  });

  it('スケール外の音は null を返す', () => {
    expect(getNoteScaleDegree('F#', 'C', 'major')).toBeNull();
    expect(getNoteScaleDegree('Bb', 'C', 'major')).toBeNull();
    expect(getNoteScaleDegree('Eb', 'C', 'major')).toBeNull();
  });

  it('A naturalMinor スケールの各音に正しい度数を返す', () => {
    expect(getNoteScaleDegree('A', 'A', 'naturalMinor')).toBe('Ⅰ');
    expect(getNoteScaleDegree('B', 'A', 'naturalMinor')).toBe('Ⅱ');
    expect(getNoteScaleDegree('C', 'A', 'naturalMinor')).toBe('Ⅲ');
    expect(getNoteScaleDegree('D', 'A', 'naturalMinor')).toBe('Ⅳ');
    expect(getNoteScaleDegree('E', 'A', 'naturalMinor')).toBe('Ⅴ');
    expect(getNoteScaleDegree('F', 'A', 'naturalMinor')).toBe('Ⅵ');
    expect(getNoteScaleDegree('G', 'A', 'naturalMinor')).toBe('Ⅶ');
  });

  it('不正な音名は null を返す', () => {
    expect(getNoteScaleDegree('X', 'C', 'major')).toBeNull();
  });

  it('不正なキーは null を返す', () => {
    expect(getNoteScaleDegree('C', 'Z', 'major')).toBeNull();
  });

  it('G major スケール: F# は Ⅶ を返す', () => {
    expect(getNoteScaleDegree('F#', 'G', 'major')).toBe('Ⅶ');
  });

  it('F major スケール: Bb は Ⅳ を返す', () => {
    expect(getNoteScaleDegree('Bb', 'F', 'major')).toBe('Ⅳ');
  });
});

describe('describeNoteInKey', () => {
  it('スケール内の音は度数ラベルを含む文字列を返す', () => {
    const result = describeNoteInKey('E', 'C', 'major');
    expect(result).toContain('Ⅲ');
    expect(result).toContain('スケール内');
  });

  it('C major のルートは Ⅰ度を返す', () => {
    const result = describeNoteInKey('C', 'C', 'major');
    expect(result).toContain('Ⅰ');
  });

  it('スケール外の音はスケール外の説明を返す (一律に誤りとしない)', () => {
    const result = describeNoteInKey('F#', 'C', 'major');
    // ♭Ⅴ / トライトン / ブルーノートなど文脈説明が含まれる
    expect(result).not.toBe('');
    // 「間違い」「誤り」という断定的な語を含まない
    expect(result).not.toContain('間違い');
    expect(result).not.toContain('誤り');
  });

  it('Eb over C major: ♭Ⅲ (ブルーノート系) の説明を返す', () => {
    const result = describeNoteInKey('Eb', 'C', 'major');
    expect(result).toContain('♭Ⅲ');
  });

  it('不正な音名は "解析不能" を返す', () => {
    expect(describeNoteInKey('X', 'C', 'major')).toBe('解析不能');
  });
});

describe('detectChordTensions', () => {
  it('C major トライアドに対して C major スケールのテンション (9th, 11th, 13th) を返す', () => {
    const tensions = detectChordTensions('C', 'C', 'major');
    // C major triad: C E G (intervals 0,4,7)
    // C major scale: C D E F G A B
    // 9th = D (interval 2) -> スケール内 -> 9th
    // 11th = F (interval 5) -> スケール内 -> 11th
    // 13th = A (interval 9) -> スケール内 -> 13th
    expect(tensions).toContain('9th');
    expect(tensions).toContain('11th');
    expect(tensions).toContain('13th');
    // ♭9th = Db (interval 1) -> スケール外 -> 含まない
    expect(tensions).not.toContain('♭9th');
    // ♯11th = F# (interval 6) -> スケール外 -> 含まない
    expect(tensions).not.toContain('♯11th');
  });

  it('G7 に対して C major スケールのテンション (9th, 13th) を返す', () => {
    const tensions = detectChordTensions('G7', 'C', 'major');
    // G7: G B D F (intervals 0,4,7,10)
    // C major scale: C D E F G A B
    // 9th = A (interval 2 from G) -> スケール内 -> 9th
    // 11th = C (interval 5 from G) -> スケール内 -> 11th
    // 13th = E (interval 9 from G) -> スケール内 -> 13th
    expect(tensions).toContain('9th');
    // 7th (interval 10) はコード構成音なので除外済み
    expect(tensions).not.toContain('♭13th');
  });

  it('不正なコードシンボルは空配列を返す', () => {
    expect(detectChordTensions('XYZ', 'C', 'major')).toEqual([]);
  });

  it('Dm7 に対して C major スケールのテンション (11th, ...) を返す', () => {
    const tensions = detectChordTensions('Dm7', 'C', 'major');
    // Dm7: D F A C (intervals 0,3,7,10)
    // C major scale から D ルートへのテンション:
    // 9th = E (interval 2 from D) -> スケール内 -> 9th
    // 11th = G (interval 5 from D) -> スケール内 -> 11th
    // 13th = B (interval 9 from D) -> スケール内 -> 13th
    expect(tensions).toContain('9th');
    expect(tensions).toContain('11th');
    expect(tensions).toContain('13th');
  });

  it('コード構成音のインターバルに対応するテンション名を返さない', () => {
    // dominant7 は interval 10 (短7度) を持つ。その音はテンション候補から除外される
    const tensions = detectChordTensions('G7', 'C', 'major');
    // G7 の interval 4 は B、これはコード構成音。♯9th (interval 3) は A# = スケール外なので不包含
    expect(tensions).not.toContain('♯9th');
  });
});
