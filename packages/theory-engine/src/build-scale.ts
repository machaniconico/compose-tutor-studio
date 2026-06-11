/**
 * 公開 buildScale API
 *
 * 7音スケール (major / naturalMinor / harmonicMinor / melodicMinor) は
 * 「1度数につき1レターネーム」で綴る (F major は Bb、G major は F#、
 * C major と A naturalMinor は臨時記号なし)。
 * ペンタトニック/ブルースなど非ヘプタトニックはピッチクラス基準で綴る。
 */

import type { ScaleName } from './types';
import { getScaleIntervals } from './scales';
import { parseNoteName } from './notes';

/** レターネーム順 (C-B の循環)。 */
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;

/** 各レターのナチュラルピッチクラス。 */
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** ヘプタトニック (各レターを1回ずつ使う) スケール。 */
const HEPTATONIC: ReadonlySet<ScaleName> = new Set<ScaleName>([
  'major',
  'naturalMinor',
  'harmonicMinor',
  'melodicMinor',
]);

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** buildScale の戻り値。 */
export type BuiltScale = {
  root: string;
  scaleName: ScaleName;
  pitchClasses: number[];
  notes: string[];
};

/** 目標ピッチクラスを指定レターで綴る (臨時記号 #/b/x/bb を付与)。範囲外は null。 */
function spellWithLetter(letter: string, targetPc: number): string | null {
  const natural = LETTER_PC[letter];
  if (natural === undefined) return null;
  let diff = (targetPc - natural + 12) % 12;
  // -2..+2 の範囲に正規化 (6 以上は下方向の臨時記号として扱う)。
  if (diff > 6) diff -= 12;
  if (diff === 0) return letter;
  if (diff === 1) return `${letter}#`;
  if (diff === 2) return `${letter}x`;
  if (diff === -1) return `${letter}b`;
  if (diff === -2) return `${letter}bb`;
  return null;
}

/** ヘプタトニック以外/異常時の綴り: ルートの臨時記号の向きに合わせる。 */
function fallbackSpell(pc: number, rootName: string): string {
  const preferFlats = rootName.includes('b') || rootName === 'F';
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  const normalized = ((pc % 12) + 12) % 12;
  return names[normalized] as string;
}

/**
 * ルート音名とスケール名から構成音を組み立てる。
 * @param root 例 "C", "F", "A", "Bb"
 * @param scaleName スケール名
 */
export function buildScale(root: string, scaleName: ScaleName): BuiltScale {
  const parsedRoot = parseNoteName(root);
  if (parsedRoot === null) {
    throw new Error(`不正なルート音名です: ${root}`);
  }
  const rootName = parsedRoot.name;
  const rootPc = parsedRoot.pitchClass;
  const intervals = getScaleIntervals(scaleName);
  const pitchClasses = intervals.map((iv) => (rootPc + iv) % 12);

  let notes: string[];
  if (HEPTATONIC.has(scaleName)) {
    const rootLetter = rootName.charAt(0);
    const startIdx = LETTERS.indexOf(rootLetter as (typeof LETTERS)[number]);
    notes = pitchClasses.map((pc, degree) => {
      const letter = LETTERS[(startIdx + degree) % LETTERS.length] as string;
      return spellWithLetter(letter, pc) ?? fallbackSpell(pc, rootName);
    });
  } else {
    notes = pitchClasses.map((pc) => fallbackSpell(pc, rootName));
  }

  return { root: rootName, scaleName, pitchClasses, notes };
}
