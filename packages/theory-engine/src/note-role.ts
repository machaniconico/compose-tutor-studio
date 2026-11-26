/**
 * ピアノロールの色分け用に、MIDI ノート 1 つの役割を返す純粋関数。
 *
 * pitch class(0-11)で比べるので、オクターブ違いのコードトーンも同じ扱いにする。
 * スケール外は「誤り」ではなく outside(彩りの音)として返す。
 */

import type { ScaleName } from './types';
import { pitchClassOf } from './pitch';
import { getScalePitchClasses } from './scales';

export type NoteRole = 'chordTone' | 'scaleTone' | 'outside';

/**
 * @param midi 判定するノートのオクターブ付き MIDI 番号
 * @param chordNotes そのノートが鳴る拍のコード構成音(MIDI 番号。無ければ undefined)
 * @param key キー文字列。不正ならスケール判定は空として扱う(throw しない)
 */
export function classifyNoteRole(
  midi: number,
  chordNotes: readonly number[] | undefined,
  key: string,
  scale: ScaleName,
): NoteRole {
  if (!Number.isFinite(midi)) return 'outside';
  const pc = pitchClassOf(Math.round(midi));
  if (chordNotes?.some((n) => Number.isFinite(n) && pitchClassOf(Math.round(n)) === pc)) return 'chordTone';
  let scalePcs: number[] = [];
  try {
    scalePcs = getScalePitchClasses(key, scale);
  } catch {
    scalePcs = [];
  }
  return scalePcs.includes(pc) ? 'scaleTone' : 'outside';
}
