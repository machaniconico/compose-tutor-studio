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
import { pitchClassOf, noteNameToPitchClass, parseKeyRoot } from './pitch';
import { parseNoteName } from './notes';
import { getScalePitchClasses, getScaleIntervals } from './scales';
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

/**
 * コードに対して使えるテンション音を構成音から判定して日本語ラベルの配列で返す。
 *
 * テンションは「9th / ♭9th / ♯9th / 11th / ♯11th / 13th / ♭13th」。
 * スケール構成音に含まれるテンションインターバル(コードルートからの半音差)を列挙する。
 * コード構成音と重複するインターバルは除外する。
 *
 * @param chordSymbol コードシンボル (例 "C", "G7", "Dm7")
 * @param key キー文字列 (例 "C", "F#")
 * @param scale スケール名
 * @returns テンション日本語ラベルの配列 (例 ["9th", "13th"])
 */
export function detectChordTensions(
  chordSymbol: string,
  key: string,
  scale: ScaleName,
): string[] {
  const chord = parseChordSymbol(chordSymbol);
  if (chord === null) return [];

  let scalePcs: number[];
  try {
    scalePcs = getScalePitchClasses(key, scale);
  } catch {
    return [];
  }

  const chordRootPc = chord.pitchClasses[0] ?? 0;
  // テンションインターバル定義 (半音差 -> ラベル)
  const TENSION_INTERVALS: Array<[number, string]> = [
    [1, '♭9th'],
    [2, '9th'],
    [3, '♯9th'],
    [5, '11th'],
    [6, '♯11th'],
    [8, '♭13th'],
    [9, '13th'],
  ];

  const chordIntervalSet = new Set(chord.intervals.map((iv) => ((iv % 12) + 12) % 12));

  return TENSION_INTERVALS.filter(([semitones]) => {
    const tensorPc = (chordRootPc + semitones) % 12;
    // コード構成音に含まれるインターバルは除外
    if (chordIntervalSet.has(semitones)) return false;
    // スケール内にある場合のみテンションとして提示
    return scalePcs.includes(tensorPc);
  }).map(([, label]) => label);
}

/**
 * コードの構成音インターバル（ルートからの半音差の配列）から
 * テンション (9th/11th/13th 等) を判定して日本語ラベルの配列で返す純粋関数。
 *
 * detectChordTensions がキー/スケールを参照するのに対し、
 * analyzeChordTensions はコード構成音のインターバルのみから
 * 「コードに含まれていないテンションインターバルが構成音として追加されている場合」を検出する。
 * add9 や maj7#11 などの拡張コードのテンション音を返す。
 *
 * @param intervals ルートからの半音差の配列 (例: [0,4,7] = メジャートライアド、[0,4,7,14] = add9)
 * @returns テンション日本語ラベルの配列 (例 ["9th"])。テンションなしのとき空配列。
 */
export function analyzeChordTensions(intervals: number[]): string[] {
  // テンションインターバル定義 (オクターブ内正規化後の半音差 -> ラベル)
  const TENSION_INTERVALS: Array<[number, string]> = [
    [1, '♭9th'],
    [2, '9th'],
    [3, '♯9th'],
    [5, '11th'],
    [6, '♯11th'],
    [8, '♭13th'],
    [9, '13th'],
  ];
  const BASIC_TRIAD_AND_7TH = new Set([0, 3, 4, 6, 7, 8, 10, 11]);

  // 構成音をオクターブ内正規化してセットにまとめる
  const normalizedSet = new Set(intervals.map((iv) => ((iv % 12) + 12) % 12));

  return TENSION_INTERVALS.filter(([semitones]) => {
    // 構成音に含まれているインターバルのみテンションとして検出
    if (!normalizedSet.has(semitones)) return false;
    // 基本音程（トライアド/7th の主要インターバル）は除外しない — 明示的に追加されたものは全て対象
    // ただしルート(0)・長短3度(3,4)・完全5度(7)は基本トライアド構成音なのでテンション扱いしない
    if (semitones === 0 || semitones === 3 || semitones === 4 || semitones === 7) return false;
    return true;
  }).map(([, label]) => label);
}

/** スケール度数のローマ数字ラベル (1始まり)。 */
const DEGREE_LABELS = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ'] as const;

/**
 * MIDIノート番号（または音名）をキー/スケールに対する度数ラベルへ変換する。
 * スケール構成音であれば "Ⅰ" ～ "Ⅶ" を返す。スケール外なら null を返す。
 *
 * @param note MIDI番号または音名
 * @param key  キー文字列 (例 "C", "F#")
 * @param scale スケール名
 */
export function getNoteScaleDegree(
  note: number | string,
  key: string,
  scale: ScaleName,
): string | null {
  const notePc = resolvePitchClass(note);
  if (notePc === null) return null;

  let keyRootPc: number;
  try {
    keyRootPc = noteNameToPitchClass(parseKeyRoot(key));
  } catch {
    return null;
  }

  const intervals = getScaleIntervals(scale);
  const scalePcs = getScalePitchClasses(key, scale);

  const idx = scalePcs.indexOf(notePc);
  if (idx < 0) return null;

  const label = DEGREE_LABELS[idx];
  return label ?? null;
}

/**
 * ノートのスケール内文脈を日本語ラベルで返す。
 * スケール内なら度数ラベル (例 "Ⅲ度")、スケール外なら文脈に応じた説明を返す。
 */
export function describeNoteInKey(
  note: number | string,
  key: string,
  scale: ScaleName,
): string {
  const notePc = resolvePitchClass(note);
  if (notePc === null) return '解析不能';

  const scalePcs = getScalePitchClasses(key, scale);
  const idx = scalePcs.indexOf(notePc);
  if (idx >= 0) {
    const label = DEGREE_LABELS[idx];
    return label ? `${label}度（スケール内）` : 'スケール内';
  }

  // スケール外: キーのルートとの音程から文脈を推定する
  let keyRootPc: number;
  try {
    keyRootPc = noteNameToPitchClass(parseKeyRoot(key));
  } catch {
    return 'スケール外';
  }
  const fromRoot = ((notePc - keyRootPc) + 12) % 12;
  const chromatic: Record<number, string> = {
    1: '♭Ⅱ（半音上のアプローチ音）',
    3: '♭Ⅲ（ブルーノート系）',
    6: '♭Ⅴ（トライトン／ブルーノート）',
    8: '♭Ⅵ（借用音）',
    10: '♭Ⅶ（借用音）',
  };
  return chromatic[fromRoot] ?? 'スケール外（経過音・アプローチ音として使えます）';
}
