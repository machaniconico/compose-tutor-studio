// ピアノロールのノート色分け。判定は theory-engine の純粋関数に任せ、
// ここでは表示用のラベル・記号・段階に整える。React にも store にも依存しない。
//
// 区別する量: pitch class(0-11)、オクターブ付き MIDI、スケール度数、コードトーン。
// スケール外の音は「誤り」ではなく「彩りの音」と書く(Musical Correctness Rules)。

import type { ChordEvent } from '@cts/project-model';
import { classifyNoteRole, getNoteScaleDegree, isScaleName, type ScaleName } from '@cts/theory-engine';
import { simplifyExplanation, type Difficulty } from '../inspector/difficultyText';

export type NoteColorMode = 'plain' | 'chordTone' | 'degree' | 'velocity';
export type NoteColorCategory = 'plain' | 'chordTone' | 'scaleTone' | 'outside' | 'degree' | 'velocity';

export const NOTE_COLOR_MODES: ReadonlyArray<{ mode: NoteColorMode; label: string }> = [
  { mode: 'plain', label: '色分けなし' },
  { mode: 'chordTone', label: 'コードの音' },
  { mode: 'degree', label: 'スケールの度数' },
  { mode: 'velocity', label: '音の強さ' },
];

export type NoteColor = {
  category: NoteColorCategory;
  /** 色以外の手がかり(ノート内に出す小さな記号・文字)。plain は空。 */
  symbol: string;
  /** 標準の文面。初心者向けは noteColorLabel で言い換える。 */
  label: string;
  /** velocity モードの 4 段階(0 が弱い)。それ以外は 0。 */
  level: 0 | 1 | 2 | 3;
  /** CSS 用の修飾名(`pr__note--<className>`)。plain は空。 */
  className: string;
};

const ROLE_VIEW = {
  chordTone: { symbol: '●', label: 'コードの音' },
  scaleTone: { symbol: '○', label: 'スケールの音(経過音の候補)' },
  outside: { symbol: '◇', label: 'スケール外(彩りの音)' },
} as const;

const UNKNOWN_SCALE_LABEL = 'このスケールは色分けに対応していません(コードの音だけ判定します)';

const VELOCITY_VIEW = [
  { symbol: '▁', label: '音の強さ: 弱め' },
  { symbol: '▃', label: '音の強さ: ふつう' },
  { symbol: '▅', label: '音の強さ: 強め' },
  { symbol: '█', label: '音の強さ: とても強い' },
] as const;

/** ベロシティ(0-127)を 4 段階に分ける。範囲外・非数は端に丸める。 */
function velocityLevel(velocity: number | undefined): 0 | 1 | 2 | 3 {
  if (velocity === undefined || !Number.isFinite(velocity)) return 0;
  return Math.min(3, Math.max(0, Math.floor(velocity / 32))) as 0 | 1 | 2 | 3;
}

/**
 * ノート 1 つの色分けを返す。
 * @param midi オクターブ付き MIDI 番号
 * @param chordAtBeat そのノートが鳴る拍のコード。絶対拍(clip.startBeat + note.startBeat)で引いたものを渡す
 * @param velocity velocity モードでだけ使う
 */
export function classifyNote(
  midi: number,
  chordAtBeat: ChordEvent | undefined,
  key: string,
  scale: ScaleName,
  mode: NoteColorMode,
  velocity?: number,
): NoteColor {
  if (mode === 'plain') return { category: 'plain', symbol: '', label: '', level: 0, className: '' };
  if (mode === 'velocity') {
    const level = velocityLevel(velocity);
    return { category: 'velocity', ...VELOCITY_VIEW[level], level, className: `v${level}` };
  }
  // 保存データの scale は検査されない。未知の名前では度数もスケール判定も出さず、説明を返す。
  if (!isScaleName(scale)) {
    // コードの音の判定はスケールに依存しない(pitch class でコード構成音と比べるだけ)。
    const inChord = mode === 'chordTone' && classifyNoteRole(midi, chordAtBeat?.notes, key, 'major') === 'chordTone';
    return inChord
      ? { category: 'chordTone', ...ROLE_VIEW.chordTone, level: 0, className: 'chordTone' }
      : { category: 'plain', symbol: '', label: UNKNOWN_SCALE_LABEL, level: 0, className: '' };
  }
  const role = classifyNoteRole(midi, chordAtBeat?.notes, key, scale);
  if (mode === 'degree') {
    const degree = getNoteScaleDegree(midi, key, scale);
    return degree === null
      ? { category: 'degree', symbol: '◇', label: ROLE_VIEW.outside.label, level: 0, className: 'outside' }
      : { category: 'degree', symbol: degree, label: `スケールの${degree}度`, level: 0, className: role };
  }
  return { category: role, ...ROLE_VIEW[role], level: 0, className: role };
}

/** 難易度に合わせたラベル(初心者向けは専門語をやさしく言い換える)。 */
export function noteColorLabel(color: NoteColor, difficulty: Difficulty): string {
  return simplifyExplanation(color.label, difficulty);
}
