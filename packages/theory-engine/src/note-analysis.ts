/**
 * 単音解析 (analyzeNoteAgainstChordAndScale) — prompt 02 関数 9。
 *
 * 1音をコード・キー・スケールの文脈で分類する:
 *   - chordTone: コード構成音 (安定)
 *   - scaleTone: スケール内だがコード外 (準安定/経過音になりうる)
 *   - tension: コードに対するテンション (9th/11th/13th 等の色付け)
 *   - nonScale: スケール外 (経過音やブルーノートとして使える場合もある)
 *
 * Musical Correctness Rules に従い、非スケール音を一律に「誤り」とは断定しない。
 */

import type { ScaleName } from './types';
import { pitchClassOf } from './pitch';
import { parseNoteName } from './notes';
import { getScalePitchClasses } from './scales';
import { parseChordSymbol } from './parse-chord';

/** 単音解析の関係種別。 */
export type NoteRelation = 'chordTone' | 'scaleTone' | 'tension' | 'nonScale';

/** analyzeNoteAgainstChordAndScale の戻り値。 */
export type NoteAnalysis = {
  relation: NoteRelation;
  /** コード構成音だった場合の度数表記 (例 "3度", "5度")。 */
  degreeInChord?: string;
  severity: 'info' | 'warn';
  message: string;
};

/** コードのルートからの半音差を「テンション度数」日本語ラベルへ。 */
function tensionLabel(semitones: number): string {
  switch (((semitones % 12) + 12) % 12) {
    case 1:
      return '♭9th';
    case 2:
      return '9th';
    case 5:
      return '11th（4度）';
    case 6:
      return '♯11th';
    case 8:
      return '♭13th';
    case 9:
      return '13th（6度）';
    default:
      return `${semitones}半音上`;
  }
}

/** コード構成音の度数を「N度」で返す (chordTone 用)。 */
function chordToneDegreeLabel(semitonesFromRoot: number, intervalIndex: number): string {
  const iv = ((semitonesFromRoot % 12) + 12) % 12;
  if (iv === 0) return 'ルート（1度）';
  if (iv === 2) return '2度';
  if (iv === 3) return '3度（短3度）';
  if (iv === 4) return '3度';
  if (iv === 5) return '4度';
  if (iv === 6) return '5度（♭5）';
  if (iv === 7) return '5度';
  if (iv === 8) return '5度（♯5）';
  if (iv === 9) return '6度';
  if (iv === 10) return '7度';
  if (iv === 11) return '7度（長7度）';
  return `第${intervalIndex + 1}構成音`;
}

/** 入力 note を ピッチクラスへ解決する。null なら解析不能。 */
function resolvePitchClass(note: number | string): number | null {
  if (typeof note === 'number') {
    if (!Number.isFinite(note)) return null;
    return pitchClassOf(Math.trunc(note));
  }
  const parsed = parseNoteName(note);
  if (parsed === null) return null;
  return parsed.pitchClass;
}

/**
 * 1音をコード・キー・スケールに照らして解析する。
 * @param note MIDI番号 (例 64) または音名 (例 "E", "E4")
 * @param chordSymbol コードシンボル (例 "C", "G7")
 * @param key キー (例 "C")
 * @param scale スケール名
 */
export function analyzeNoteAgainstChordAndScale(
  note: number | string,
  chordSymbol: string,
  key: string,
  scale: ScaleName,
): NoteAnalysis {
  const notePc = resolvePitchClass(note);
  if (notePc === null) {
    return {
      relation: 'nonScale',
      severity: 'warn',
      message: `音「${String(note)}」を解釈できませんでした。`,
    };
  }

  const chord = parseChordSymbol(chordSymbol);
  if (chord === null) {
    return {
      relation: 'nonScale',
      severity: 'warn',
      message: `コード「${chordSymbol}」を解釈できませんでした。`,
    };
  }

  const chordRootPc = chord.pitchClasses[0] ?? notePc;
  const nameFromInput = typeof note === 'string' ? parseNoteName(note)?.name : undefined;
  const nameFromChord = chord.notes.find((_, i) => chord.pitchClasses[i] === notePc);
  const noteLabel = nameFromInput ?? nameFromChord ?? `pc${notePc}`;

  // コード構成音か。
  const chordIdx = chord.pitchClasses.indexOf(notePc);
  if (chordIdx >= 0) {
    const interval = chord.intervals[chordIdx] ?? (notePc - chordRootPc + 12) % 12;
    const degreeLabel = chordToneDegreeLabel(interval, chordIdx);
    return {
      relation: 'chordTone',
      degreeInChord: degreeLabel,
      severity: 'info',
      message: `${noteLabel}は${chord.symbol}コードの${degreeLabel}（安定音）です。`,
    };
  }

  const scalePcs = getScalePitchClasses(key, scale);
  if (scalePcs.includes(notePc)) {
    return {
      relation: 'scaleTone',
      severity: 'info',
      message: `${noteLabel}は${key}スケール内の音で、${chord.symbol}コードに対しては経過音などとして自然に使えます。`,
    };
  }

  // スケール外。コードに対するテンション (9/11/13系・変化音) かを確認する。
  const fromRoot = (notePc - chordRootPc + 12) % 12;
  const isTensionInterval =
    fromRoot === 1 ||
    fromRoot === 2 ||
    fromRoot === 5 ||
    fromRoot === 6 ||
    fromRoot === 8 ||
    fromRoot === 9;
  if (isTensionInterval) {
    return {
      relation: 'tension',
      severity: 'info',
      message: `${noteLabel}は${chord.symbol}コードに対する${tensionLabel(fromRoot)}のテンション（色付け）です。文脈次第で効果的に使えます。`,
    };
  }

  return {
    relation: 'nonScale',
    severity: 'warn',
    message: `${noteLabel}は${key}スケールにも${chord.symbol}コードにも含まれない音です。経過音やブルーノートとして意図的に使う場合を除き、響きを確認しましょう。`,
  };
}
