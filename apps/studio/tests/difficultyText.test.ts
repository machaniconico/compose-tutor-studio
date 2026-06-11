import { describe, expect, it } from 'vitest';
import {
  harmonicFunctionLabel,
  degreeLabel,
  tensionLabel,
  advancedChordNote,
  noteRelationLabel,
  scalePresenceLabel,
  simplifyExplanation,
  type Difficulty,
} from '../src/features/inspector/difficultyText';
import { analyzeChord } from '@cts/theory-engine';

describe('harmonicFunctionLabel', () => {
  const cases: Array<{ fn: string; difficulty: Difficulty; contains: string }> = [
    { fn: 'T', difficulty: 'beginner', contains: '安らぐ' },
    { fn: 'SD', difficulty: 'beginner', contains: '動き出す' },
    { fn: 'D', difficulty: 'beginner', contains: 'もどりたく' },
    { fn: 'T', difficulty: 'standard', contains: 'トニック（安定）' },
    { fn: 'SD', difficulty: 'standard', contains: 'サブドミナント（展開）' },
    { fn: 'D', difficulty: 'standard', contains: 'ドミナント（緊張）' },
    { fn: 'T', difficulty: 'advanced', contains: 'Tonic' },
    { fn: 'SD', difficulty: 'advanced', contains: 'SubDominant' },
    { fn: 'D', difficulty: 'advanced', contains: 'セカンダリドミナント' },
    { fn: 'Other', difficulty: 'beginner', contains: 'その他' },
    { fn: 'Other', difficulty: 'advanced', contains: 'Other' },
  ];

  for (const { fn, difficulty, contains } of cases) {
    it(`fn=${fn} difficulty=${difficulty} → contains "${contains}"`, () => {
      expect(harmonicFunctionLabel(fn, difficulty)).toContain(contains);
    });
  }
});

describe('degreeLabel', () => {
  it('beginner: V7 is humanized', () => {
    const result = degreeLabel('V', 'beginner');
    // Roman numerals get replaced with ordinals
    expect(result).not.toBe('V');
  });

  it('standard: degree passes through unchanged', () => {
    expect(degreeLabel('V7', 'standard')).toBe('V7');
    expect(degreeLabel('IIm7', 'standard')).toBe('IIm7');
  });

  it('advanced: degree passes through unchanged', () => {
    expect(degreeLabel('V7', 'advanced')).toBe('V7');
  });

  it('empty/dash values pass through', () => {
    expect(degreeLabel('—', 'beginner')).toBe('—');
    expect(degreeLabel('', 'beginner')).toBe('');
  });
});

describe('tensionLabel', () => {
  it('beginner: no tensions → シンプルな形', () => {
    expect(tensionLabel([], 'beginner')).toContain('シンプルな形');
  });

  it('standard: no tensions → 基本形', () => {
    expect(tensionLabel([], 'standard')).toContain('基本形');
  });

  it('beginner: with tensions adds 色が増す音', () => {
    expect(tensionLabel(['9th', '13th'], 'beginner')).toContain('色が増す音');
  });

  it('advanced: with tensions adds アボイドノート', () => {
    expect(tensionLabel(['9th'], 'advanced')).toContain('アボイドノート');
  });

  it('standard: tensions joined with ・', () => {
    expect(tensionLabel(['9th', '13th'], 'standard')).toBe('9th・13th');
  });
});

describe('advancedChordNote', () => {
  it('D function includes dominant resolution hint', () => {
    expect(advancedChordNote('D', 'V7')).toContain('トニックへ強く進みます');
  });

  it('D function includes secondary dominant hint', () => {
    expect(advancedChordNote('D', 'V7')).toContain('セカンダリドミナント');
  });

  it('SD function includes modal interchange hint', () => {
    expect(advancedChordNote('SD', 'IVm')).toContain('借用和音');
  });

  it('T function includes tonic stability hint', () => {
    expect(advancedChordNote('T', 'I')).toContain('安定');
  });

  it('T function uses 平行短調 (relative minor), not 同主マイナー (parallel minor)', () => {
    const result = advancedChordNote('T', 'I');
    expect(result).toContain('平行短調');
    expect(result).not.toContain('同主マイナー');
  });

  it('returns empty string for unknown function', () => {
    expect(advancedChordNote('Other', 'VII')).toBe('');
  });
});

describe('noteRelationLabel', () => {
  const relations = ['chordTone', 'scaleTone', 'tension', 'nonScale'] as const;

  for (const rel of relations) {
    it(`beginner ${rel} is beginner-friendly`, () => {
      const result = noteRelationLabel(rel, 'beginner');
      // Beginner labels avoid standard music jargon
      expect(result.length).toBeGreaterThan(0);
      // Ensure not the same as standard
      expect(result).not.toBe(noteRelationLabel(rel, 'standard'));
    });

    it(`advanced ${rel} has more detail than standard`, () => {
      const adv = noteRelationLabel(rel, 'advanced');
      const std = noteRelationLabel(rel, 'standard');
      expect(adv.length).toBeGreaterThanOrEqual(std.length);
    });
  }

  it('chordTone beginner is friendly phrasing', () => {
    expect(noteRelationLabel('chordTone', 'beginner')).toContain('ぴったり');
  });

  it('tension advanced mentions 9th/11th/13th', () => {
    expect(noteRelationLabel('tension', 'advanced')).toContain('9th');
  });
});

describe('scalePresenceLabel', () => {
  it('beginner inScale → キーに合っている', () => {
    expect(scalePresenceLabel(true, 'beginner')).toContain('キーに合っている');
  });

  it('beginner outOfScale → 個性的', () => {
    expect(scalePresenceLabel(false, 'beginner')).toContain('個性的');
  });

  it('standard inScale → 内（自然な音）', () => {
    expect(scalePresenceLabel(true, 'standard')).toContain('自然な音');
  });

  it('standard outOfScale → 外（色付けの音）', () => {
    expect(scalePresenceLabel(false, 'standard')).toContain('色付け');
  });

  it('advanced outOfScale → クロマチック', () => {
    expect(scalePresenceLabel(false, 'advanced')).toContain('クロマチック');
  });
});

// ---------------------------------------------------------------------------
// 上級用語の置換リスト
// ---------------------------------------------------------------------------
const ADVANCED_TERMS = [
  'ダイアトニック',
  '借用和音',
  'モーダルインターチェンジ',
  'セカンダリドミナント',
];

describe('simplifyExplanation', () => {
  it('standard: text passes through unchanged', () => {
    const text = 'ダイアトニックのコードです。セカンダリドミナントも使えます。';
    expect(simplifyExplanation(text, 'standard')).toBe(text);
  });

  it('advanced: text passes through unchanged', () => {
    const text = 'モーダルインターチェンジや借用和音の説明です。';
    expect(simplifyExplanation(text, 'advanced')).toBe(text);
  });

  it('beginner: セカンダリドミナント → 置き換えられる', () => {
    const result = simplifyExplanation('これはセカンダリドミナントです。', 'beginner');
    expect(result).not.toContain('セカンダリドミナント');
    expect(result.length).toBeGreaterThan(0);
  });

  it('beginner: モーダルインターチェンジ → 置き換えられる', () => {
    const result = simplifyExplanation('モーダルインターチェンジの例。', 'beginner');
    expect(result).not.toContain('モーダルインターチェンジ');
  });

  it('beginner: 借用和音 → 置き換えられる', () => {
    const result = simplifyExplanation('これは借用和音です。', 'beginner');
    expect(result).not.toContain('借用和音');
  });

  it('beginner: ダイアトニック → 置き換えられる', () => {
    const result = simplifyExplanation('ダイアトニックコードの解説。', 'beginner');
    expect(result).not.toContain('ダイアトニック');
  });

  it('empty string returns empty string', () => {
    expect(simplifyExplanation('', 'beginner')).toBe('');
  });

  // -----------------------------------------------------------------------
  // analyzeChord の実文字列で上級用語がない事を検証
  // -----------------------------------------------------------------------
  it('beginner: diatonic chord explanation (analyzeChord) contains no advanced terms', () => {
    // Cメジャーキーの I (C) — ダイアトニックコード
    const result = analyzeChord({ symbol: 'C', key: 'C', scale: 'major' });
    const simplified = simplifyExplanation(result.explanation, 'beginner');
    for (const term of ADVANCED_TERMS) {
      expect(simplified, `"${term}" should not appear in beginner explanation`).not.toContain(term);
    }
  });

  it('beginner: secondary dominant explanation (analyzeChord) contains no advanced terms', () => {
    // Cメジャーキーの A7 — セカンダリドミナント (V7/ii)
    const result = analyzeChord({ symbol: 'A7', key: 'C', scale: 'major' });
    expect(result.tags).toContain('secondaryDominant');
    const simplified = simplifyExplanation(result.explanation, 'beginner');
    for (const term of ADVANCED_TERMS) {
      expect(simplified, `"${term}" should not appear in beginner explanation`).not.toContain(term);
    }
  });

  it('beginner: borrowed chord explanation (analyzeChord) contains no advanced terms', () => {
    // Cメジャーキーの Db — ルートがキー外の和音 (非ダイアトニック/借用の説明文を通る)
    const result = analyzeChord({ symbol: 'Db', key: 'C', scale: 'major' });
    // 前提: 生の説明文には上級用語が少なくとも1つ含まれている (簡略化の意味があるケース)
    expect(ADVANCED_TERMS.some((term) => result.explanation.includes(term))).toBe(true);
    const simplified = simplifyExplanation(result.explanation, 'beginner');
    for (const term of ADVANCED_TERMS) {
      expect(simplified, `"${term}" should not appear in beginner explanation`).not.toContain(term);
    }
  });

  it('standard: secondary dominant explanation retains advanced terms', () => {
    const result = analyzeChord({ symbol: 'A7', key: 'C', scale: 'major' });
    const kept = simplifyExplanation(result.explanation, 'standard');
    expect(kept).toContain('セカンダリドミナント');
  });
});
