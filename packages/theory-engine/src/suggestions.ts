/**
 * 次コード候補生成
 *
 * 現在キー + 直前コードから、次に置くと自然なコード候補をランク付けして返す。
 * - ダイアトニックを優先
 * - 続いてセカンダリドミナント / 借用
 * 各候補に日本語の理由を付ける ("V7はIへ解決しやすい" 形式)。
 */

import type { ChordQuality, ChordSuggestion, ScaleName } from './types';
import { parseChord, buildChordSymbol } from './chords';
import { noteNameToPitchClass, parseKeyRoot } from './pitch';
import { keyModeOf, scaleDegreeIndex } from './analysis';

/** メジャーキーのダイアトニック度数 -> 品質。 */
const MAJOR_QUALITIES: ChordQuality[] = [
  'major',
  'minor',
  'minor',
  'major',
  'major',
  'minor',
  'diminished',
];
/** マイナーキーのダイアトニック度数 -> 品質。 */
const MINOR_QUALITIES: ChordQuality[] = [
  'minor',
  'diminished',
  'major',
  'minor',
  'minor',
  'major',
  'major',
];

const ROMAN_UPPER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

/** メジャーキーで、ある度数(0-6)からの一般的な次度数と理由。 */
const MAJOR_TRANSITIONS: Record<number, { to: number; score: number; reason: string }[]> = {
  0: [
    { to: 3, score: 0.8, reason: 'I(トニック)からIV(サブドミナント)へは明るく広がる定番の流れです。' },
    { to: 4, score: 0.85, reason: 'I からV(ドミナント)へ進むと、次にIへ戻る緊張と解決が作れます。' },
    { to: 5, score: 0.8, reason: 'I からvi へは雰囲気を少し切なくする人気の流れです。' },
    { to: 1, score: 0.6, reason: 'I からii はツーファイブ(ii-V)へ向かう準備になります。' },
  ],
  1: [
    { to: 4, score: 0.92, reason: 'ii からV はツーファイブ。最も自然なドミナントへの流れです。' },
    { to: 6, score: 0.5, reason: 'ii からviiø へは緊張を高める選択肢です。' },
  ],
  2: [
    { to: 5, score: 0.7, reason: 'iii からvi へは滑らかに下行する流れです。' },
    { to: 3, score: 0.6, reason: 'iii からIV へは順次進行で素直に進みます。' },
  ],
  3: [
    { to: 4, score: 0.88, reason: 'IV からV へはサブドミナントからドミナントへの王道です。' },
    { to: 0, score: 0.75, reason: 'IV からI へはアーメン終止のような落ち着く流れです。' },
    { to: 1, score: 0.6, reason: 'IV からii へは近い響きでの寄り道です。' },
  ],
  4: [
    { to: 0, score: 0.95, reason: 'V7はIへ解決しやすい、最も強い終止(ドミナントモーション)です。' },
    { to: 5, score: 0.7, reason: 'V からvi は期待を裏切る偽終止で、曲を続けたいときに有効です。' },
  ],
  5: [
    { to: 3, score: 0.85, reason: 'vi からIV は王道進行(I-V-vi-IV)の後半で頻出します。' },
    { to: 1, score: 0.7, reason: 'vi からii はツーファイブへ向かう準備です。' },
    { to: 4, score: 0.65, reason: 'vi からV は再びドミナントを呼び込みます。' },
  ],
  6: [{ to: 0, score: 0.85, reason: 'viiø からI へは半音上行で強く解決します。' }],
};

/** マイナーキー用の簡易遷移 (主要なもの)。 */
const MINOR_TRANSITIONS: Record<number, { to: number; score: number; reason: string }[]> = {
  0: [
    { to: 3, score: 0.8, reason: 'i からiv はマイナーらしい落ち着いた流れです。' },
    { to: 4, score: 0.85, reason: 'i からV(またはv)はドミナントで緊張を作ります。' },
    { to: 5, score: 0.75, reason: 'i からVI は明るい色を差し込みます。' },
  ],
  3: [
    { to: 4, score: 0.85, reason: 'iv からV はドミナントへの王道です。' },
    { to: 0, score: 0.7, reason: 'iv からi は落ち着く終止です。' },
  ],
  4: [
    { to: 0, score: 0.95, reason: 'V7はi へ強く解決します(マイナーのドミナントモーション)。' },
    { to: 5, score: 0.65, reason: 'V からVI は偽終止で意外性を出せます。' },
  ],
  5: [
    { to: 6, score: 0.7, reason: 'VI からVII はクライマックスへ盛り上げます。' },
    { to: 3, score: 0.7, reason: 'VI からiv は柔らかく戻る流れです。' },
  ],
  6: [{ to: 0, score: 0.8, reason: 'VII からi は力強く解決します。' }],
};

export type SuggestInput = {
  key: string;
  scale: ScaleName;
  previousChord: string;
};

/**
 * 次コード候補をランク付けして返す。
 * ダイアトニック候補を優先し、続いてセカンダリドミナント候補を加える。
 */
export function suggestNextChords(input: SuggestInput): ChordSuggestion[] {
  const { key, scale, previousChord } = input;
  const keyRootName = parseKeyRoot(key);
  const keyRootPc = noteNameToPitchClass(keyRootName);
  const mode = keyModeOf(scale);
  const parsed = parseChord(previousChord, key);
  const prevDegree = scaleDegreeIndex(parsed.rootPc, keyRootPc);

  const qualities = mode === 'major' ? MAJOR_QUALITIES : MINOR_QUALITIES;
  const transitions = mode === 'major' ? MAJOR_TRANSITIONS : MINOR_TRANSITIONS;

  const suggestions: ChordSuggestion[] = [];
  const seen = new Set<string>();

  const addDiatonic = (degreeIdx: number, score: number, reason: string): void => {
    const quality = qualities[degreeIdx];
    if (quality === undefined) return;
    const stepInterval = MAJOR_STEPS[degreeIdx];
    if (stepInterval === undefined) return;
    const rootPc = (keyRootPc + stepInterval) % 12;
    const symbol = buildChordSymbol(rootPc, quality, key);
    const degree = romanFor(degreeIdx, quality);
    if (seen.has(symbol)) return;
    seen.add(symbol);
    suggestions.push({ symbol, degree, category: 'diatonic', score, reason });
  };

  const prevTransitions = prevDegree >= 0 ? transitions[prevDegree] : undefined;
  if (prevTransitions) {
    for (const t of prevTransitions) {
      addDiatonic(t.to, t.score, t.reason);
    }
  } else {
    addDiatonic(0, 0.8, 'まずはトニックへ戻ると進行が安定します。');
    addDiatonic(3, 0.6, 'サブドミナントで一度広げてから展開できます。');
    addDiatonic(4, 0.6, 'ドミナントで緊張を作り、その後トニックへ解決できます。');
  }

  // セカンダリドミナント候補: 各ダイアトニック(I/i 以外)へのV7を提案
  for (let targetIdx = 1; targetIdx < 7; targetIdx += 1) {
    if (mode === 'major' && targetIdx === 6) continue;
    const targetQuality = qualities[targetIdx];
    if (targetQuality === undefined || targetQuality === 'diminished') continue;
    const targetStep = MAJOR_STEPS[targetIdx];
    if (targetStep === undefined) continue;
    const targetRootPc = (keyRootPc + targetStep) % 12;
    const domRootPc = (targetRootPc + 7) % 12;
    const symbol = buildChordSymbol(domRootPc, 'dominant7', key);
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const targetRoman = romanFor(targetIdx, targetQuality);
    suggestions.push({
      symbol,
      degree: `V7/${targetRoman}`,
      category: 'secondaryDominant',
      score: 0.45,
      reason: `${symbol}は${targetRoman}へのセカンダリドミナントで、${targetRoman}へ強く進めたいときに効果的です。`,
    });
  }

  return suggestions.sort((a, b) => b.score - a.score);
}

/** 度数index/品質からローマ数字を作る。 */
function romanFor(degreeIdx: number, quality: ChordQuality): string {
  const upper = ROMAN_UPPER[degreeIdx] ?? '?';
  if (quality === 'minor') return upper.toLowerCase();
  if (quality === 'diminished') return `${upper.toLowerCase()}°`;
  return upper;
}
