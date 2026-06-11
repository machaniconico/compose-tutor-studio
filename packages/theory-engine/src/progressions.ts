/**
 * 進行テンプレート
 *
 * 度数表記の定番進行を保持し、指定キーで実際のコードシンボル列へ展開する。
 * 各テンプレートは日本語の名前と説明を持つ。
 */

import type { ChordQuality, ProgressionTemplate, ScaleName } from './types';
import { buildChordSymbol } from './chords';
import { noteNameToPitchClass, parseKeyRoot } from './pitch';
import { keyModeOf } from './analysis';

/** 度数トークンの解釈結果。 */
type DegreeToken = {
  token: string;
  index: number;
  qualityOverride?: ChordQuality;
};

const ROMAN_INDEX: Record<string, number> = {
  i: 0,
  ii: 1,
  iii: 2,
  iv: 3,
  v: 4,
  vi: 5,
  vii: 6,
};

/** メジャーキーのダイアトニック品質。 */
const MAJOR_QUALITIES: ChordQuality[] = [
  'major',
  'minor',
  'minor',
  'major',
  'major',
  'minor',
  'diminished',
];
/** マイナーキーのダイアトニック品質。 */
const MINOR_QUALITIES: ChordQuality[] = [
  'minor',
  'diminished',
  'major',
  'minor',
  'minor',
  'major',
  'major',
];

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

/** 定番進行テンプレート一覧。 */
export const PROGRESSION_TEMPLATES: ProgressionTemplate[] = [
  {
    id: 'I-V-vi-IV',
    name: '王道進行 (I-V-vi-IV)',
    description: '明るく前向きで、ポップスで最も多用される進行です。覚えておくと万能です。',
    degrees: ['I', 'V', 'vi', 'IV'],
  },
  {
    id: 'vi-IV-I-V',
    name: '感動系進行 (vi-IV-I-V)',
    description: '切なく始まり盛り上がる、サビでよく使われる人気の進行です。',
    degrees: ['vi', 'IV', 'I', 'V'],
  },
  {
    id: 'ii-V-I',
    name: 'ツーファイブワン (ii-V-I)',
    description: 'ジャズの基本。緊張から解決へ向かう最も自然なケーデンスです。',
    degrees: ['ii', 'V', 'I'],
  },
  {
    id: 'I-vi-IV-V',
    name: '50年代進行 (I-vi-IV-V)',
    description: '懐かしくキャッチー。古典的なポップス/ドゥーワップの定番です。',
    degrees: ['I', 'vi', 'IV', 'V'],
  },
  {
    id: 'I-IV-V',
    name: 'スリーコード (I-IV-V)',
    description: '最もシンプルな3コード。フォークやロックの土台になります。',
    degrees: ['I', 'IV', 'V'],
  },
  {
    id: 'canon',
    name: 'カノン進行 (I-V-vi-iii-IV-I-IV-V)',
    description: 'パッヘルベルのカノンで有名な、滑らかに下行する華やかな進行です。',
    degrees: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'],
  },
  {
    id: '12-bar-blues',
    name: '12小節ブルース',
    description: 'ブルース/ロックンロールの基本形。すべてドミナント7thで演奏します。',
    degrees: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'],
  },
];

/** 度数トークンをパースする。'V7' -> {index:4, qualityOverride:'dominant7'} など。 */
function parseDegreeToken(token: string): DegreeToken {
  const match = token.trim().match(/^([iIvV]+)(.*)$/);
  if (!match) {
    throw new Error(`不正な度数トークンです: ${token}`);
  }
  const [, roman = '', suffix = ''] = match;
  const index = ROMAN_INDEX[roman.toLowerCase()];
  if (index === undefined) {
    throw new Error(`不明なローマ数字です: ${roman}`);
  }
  let qualityOverride: ChordQuality | undefined;
  const s = suffix.trim();
  if (s === '7') {
    // 大文字小文字で長/短を区別: 'V7'->dominant7, 'ii7'->minor7
    qualityOverride = roman === roman.toUpperCase() ? 'dominant7' : 'minor7';
  } else if (s === 'maj7') {
    qualityOverride = 'major7';
  } else if (s === 'm7') {
    qualityOverride = 'minor7';
  } else if (s === 'ø' || s === 'm7b5') {
    qualityOverride = 'minor7b5';
  } else if (s === '°' || s === 'dim') {
    qualityOverride = 'diminished';
  }
  const result: DegreeToken = { token, index };
  if (qualityOverride !== undefined) {
    result.qualityOverride = qualityOverride;
  }
  return result;
}

/**
 * 度数列を指定キーのコードシンボル列へ展開する。
 */
export function realizeDegrees(degrees: string[], key: string, scale: ScaleName): string[] {
  const keyRootPc = noteNameToPitchClass(parseKeyRoot(key));
  const mode = keyModeOf(scale);
  const diatonicQualities = mode === 'major' ? MAJOR_QUALITIES : MINOR_QUALITIES;

  return degrees.map((token) => {
    const parsed = parseDegreeToken(token);
    const step = MAJOR_STEPS[parsed.index];
    if (step === undefined) {
      throw new Error(`度数を解決できません: ${token}`);
    }
    const rootPc = (keyRootPc + step) % 12;
    const quality = parsed.qualityOverride ?? diatonicQualities[parsed.index] ?? 'major';
    return buildChordSymbol(rootPc, quality, key);
  });
}

/**
 * テンプレートIDと キー/スケールから、コードシンボル列を生成する。
 */
export function realizeProgression(templateId: string, key: string, scale: ScaleName): string[] {
  const template = PROGRESSION_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    throw new Error(`進行テンプレートが見つかりません: ${templateId}`);
  }
  return realizeDegrees(template.degrees, key, scale);
}

/** テンプレートをIDで取得する。 */
export function getProgressionTemplate(templateId: string): ProgressionTemplate | undefined {
  return PROGRESSION_TEMPLATES.find((t) => t.id === templateId);
}
