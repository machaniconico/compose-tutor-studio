/**
 * スケールに沿った移調と、スケール音への丸め (純粋関数)。
 *
 * - 入出力はオクターブ付きの MIDI ノート番号。判定はピッチクラス(0-11)、
 *   移動はスケール度数(ルートから何段目か)で行い、この 3 つを混同しない。
 * - 結果は 0〜127 に収めない。範囲の判定は呼び出し側が行う。
 * - スケール外の音は「間違い」ではない(経過音・ブルーノートなど)。ここでは
 *   利用者が求めたときだけスケール音へ寄せる。
 */

import type { ScaleName } from './types';
import { noteNameToPitchClass, parseKeyRoot, pitchClassOf } from './pitch';
import { getScaleIntervals, isInScale } from './scales';

/** 整数でない値(NaN・Infinity・小数)を拒む。 */
function requireInteger(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} は有限の整数で指定してください: ${value}`);
  }
}

/** 等距離のときにどちらへ寄せるか。 */
export type ScaleTie = 'up' | 'down';

/**
 * MIDI ノートに最も近いスケール音(MIDI ノート)を返す。スケール内ならそのまま。
 * 上下が等距離のときは `tie`(既定 `down`)の側を選ぶ。`midi` が整数でなければ RangeError。
 */
export function nearestScalePitch(
  midi: number,
  key: string,
  scale: ScaleName,
  tie: ScaleTie = 'down',
): number {
  requireInteger('midi', midi);
  // 全スケールの音の間隔は 6 半音以下なので、6 までに必ず見つかる。
  for (let distance = 0; distance <= 6; distance += 1) {
    const down = isInScale(midi - distance, key, scale);
    const up = isInScale(midi + distance, key, scale);
    if (down && up) return tie === 'up' ? midi + distance : midi - distance;
    if (down) return midi - distance;
    if (up) return midi + distance;
  }
  throw new Error(`スケール音が見つかりません: ${key} ${scale}`);
}

/**
 * スケールに沿って `degrees` 段動かした MIDI ノートを返す(1 段 = 2 度、
 * 負の値で下へ)。スケール外の音は、先に nearestScalePitch(down)で
 * スケール音へ丸めてから動かす(C major の C#4 を 1 段上げると C4→D4)。
 * `midi` と `degrees` は有限の整数に限り、それ以外は RangeError。
 */
export function transposeByDegree(
  midi: number,
  degrees: number,
  key: string,
  scale: ScaleName,
): number {
  requireInteger('midi', midi);
  requireInteger('degrees', degrees);
  const intervals = getScaleIntervals(scale);
  const rootPc = noteNameToPitchClass(parseKeyRoot(key));
  const snapped = nearestScalePitch(midi, key, scale, 'down');
  // ルートの音からの半音差を、オクターブとスケール度数に分ける。
  const fromRoot = snapped - rootPc;
  const octave = Math.floor(fromRoot / 12);
  const degree = intervals.indexOf(pitchClassOf(fromRoot));
  const target = degree + degrees;
  const size = intervals.length;
  const targetOctave = octave + Math.floor(target / size);
  const interval = intervals[((target % size) + size) % size] as number;
  return rootPc + targetOctave * 12 + interval;
}
