/**
 * スケール定義とユーティリティ
 *
 * - 各スケールのインターバル (ルートからの半音)
 * - getScalePitchClasses(key, scale): キーのスケール構成ピッチクラス
 * - isInScale(pitch, key, scale): MIDIピッチがスケール内か (オクターブ非依存)
 */

import type { ScaleName } from './types';
import { parseKeyRoot, noteNameToPitchClass, pitchClassOf, spellPitchClass } from './pitch';

/** ルートからの半音インターバル定義 (各スケール)。 */
const SCALE_INTERVALS: Record<ScaleName, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

/** 指定スケールのインターバル配列を返す (コピー)。 */
export function getScaleIntervals(scale: ScaleName): number[] {
  const intervals = SCALE_INTERVALS[scale];
  return [...intervals];
}

/** サポートされている全スケール名。 */
export const SCALE_NAMES: ScaleName[] = [
  'major',
  'naturalMinor',
  'harmonicMinor',
  'melodicMinor',
  'majorPentatonic',
  'minorPentatonic',
  'blues',
];

/**
 * キーとスケールから構成音のピッチクラス配列(0-11)を返す。
 * ルートから昇順に並ぶ (折り返しはしない、各要素は 0-11)。
 */
export function getScalePitchClasses(key: string, scale: ScaleName): number[] {
  const rootPc = noteNameToPitchClass(parseKeyRoot(key));
  return getScaleIntervals(scale).map((iv) => (rootPc + iv) % 12);
}

/**
 * キーとスケールから構成音名の配列を返す (キーに応じた綴り)。
 */
export function getScaleNoteNames(key: string, scale: ScaleName): string[] {
  return getScalePitchClasses(key, scale).map((pc) => spellPitchClass(pc, key));
}

/**
 * MIDIピッチがスケール内かを判定する。
 * オクターブに依存せずピッチクラスで判定する。
 */
export function isInScale(pitch: number, key: string, scale: ScaleName): boolean {
  const pc = pitchClassOf(pitch);
  return getScalePitchClasses(key, scale).includes(pc);
}

/**
 * ピッチクラス(0-11)がスケール内かを判定する補助。
 */
export function isPitchClassInScale(pc: number, key: string, scale: ScaleName): boolean {
  const normalized = ((pc % 12) + 12) % 12;
  return getScalePitchClasses(key, scale).includes(normalized);
}

/**
 * スケール度数 (0始まり) からピッチクラスを得る。
 * degree が範囲外なら循環させる。
 */
export function scaleDegreeToPitchClass(degree: number, key: string, scale: ScaleName): number {
  const pcs = getScalePitchClasses(key, scale);
  const idx = ((degree % pcs.length) + pcs.length) % pcs.length;
  const value = pcs[idx];
  if (value === undefined) {
    throw new Error(`スケール度数を解決できません: ${degree}`);
  }
  return value;
}
