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
import { FLAT_NAMES, SHARP_NAMES, noteNameToPitchClass, parseKeyRoot, pitchClassOf } from './pitch';
import { getScaleIntervals, isScaleName } from './scales';
import { parseBoundedChord } from './chords';
import { parseChordTokens } from './parse-chord';

function requireKeyText(key: string): void {
  if (typeof key !== 'string' || key.length > 1024) {
    throw new RangeError('キーは1024文字以内の文字列で指定してください。');
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
  requireSafeInteger('midi', midi);
  requireKeyText(key);
  if (!isScaleName(scale)) throw new RangeError('対応しているスケールを指定してください。');
  const rootPc = noteNameToPitchClass(parseKeyRoot(key));
  const intervals = getScaleIntervals(scale);
  const relativePc = pitchClassOf(pitchClassOf(midi) - rootPc);
  // 全スケールの音の間隔は 6 半音以下なので、6 までに必ず見つかる。
  for (let distance = 0; distance <= 6; distance += 1) {
    const down = intervals.includes(pitchClassOf(relativePc - distance));
    const up = intervals.includes(pitchClassOf(relativePc + distance));
    if (!down && !up) continue;
    const result = down && !(up && tie === 'up') ? midi - distance : midi + distance;
    requireSafeInteger('midi', result);
    return result;
  }
  throw new Error(`スケール音が見つかりません: ${key} ${scale}`);
}

/**
 * スケールに沿って `degrees` 段動かした MIDI ノートを返す(1 段 = 2 度、
 * 負の値で下へ)。スケール外の音は、先に nearestScalePitch(down)で
 * スケール音へ丸めてから動かす(C major の C#4 を 1 段上げると C4→D4)。
 * `midi`、`degrees`、結果は安全な整数に限り、それ以外は RangeError。
 */
export function transposeByDegree(
  midi: number,
  degrees: number,
  key: string,
  scale: ScaleName,
): number {
  requireSafeInteger('degrees', degrees);
  const snapped = nearestScalePitch(midi, key, scale, 'down');
  const intervals = getScaleIntervals(scale);
  const rootPc = noteNameToPitchClass(parseKeyRoot(key));
  const relativePc = pitchClassOf(pitchClassOf(snapped) - rootPc);
  const degree = intervals.indexOf(relativePc);
  const target = BigInt(degree) + BigInt(degrees);
  const size = BigInt(intervals.length);
  const targetDegree = ((target % size) + size) % size;
  const octaveShift = (target - targetDegree) / size;
  const interval = intervals[Number(targetDegree)]!;
  const result = Number(BigInt(snapped) + octaveShift * 12n + BigInt(interval - relativePc));
  requireSafeInteger('midi', result);
  return result;
}

/** 安全な整数(Number.isSafeInteger)でない値を拒む。巨大でも精度を失わずに 12 で割れる範囲に限る。 */
function requireSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} は安全な範囲の整数で指定してください。`);
  }
}

/** 移調量を 0〜11 の半音に直す(足す前に余りを取り、巨大な量でも精度を失わない)。 */
function semitoneClass(semitones: number): number {
  return ((semitones % 12) + 12) % 12;
}

/** マイナーとして扱うモード・スケール名(メジャー/マイナーの調号を決めるためだけに使う)。 */
const MINOR_MODES = new Set(['m', 'min', 'minor', 'naturalminor', 'harmonicminor', 'melodicminor', 'minorpentatonic', 'blues']);
const MAJOR_MODES = new Set(['', 'maj', 'major', 'majorpentatonic']);
/** ナチュラルのルートで調号がフラットになるキー(F major / D・G・C・F minor)。 */
const FLAT_NATURAL_MAJOR = new Set(['F']);
const FLAT_NATURAL_MINOR = new Set(['D', 'G', 'C', 'F']);
/** 移調後のキー名に使う綴り(調号の臨時記号が少ない方。6 つ同士は F# major / Eb minor)。 */
const MAJOR_KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const MINOR_KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'] as const;

/**
 * キー("D major" / "Dm" / "F♯ minor" / "D naturalMinor" / "D")を読む。
 * ルートの ♯/♭ は #/b と同じに扱い(parseKeyRoot)、ルートは ASCII で返す。
 * 読めないルート・モードは Error。
 */
function readKey(key: string): { root: string; pitchClass: number; minor: boolean } {
  requireKeyText(key);
  const root = parseKeyRoot(key);
  const trimmed = key.trim();
  const mode = trimmed.slice(trimmed.match(/^[A-Ga-g][#b♯♭]*/)![0].length).trim().toLowerCase();
  const minor = MINOR_MODES.has(mode);
  if (!minor && !MAJOR_MODES.has(mode)) throw new Error(`不正なキーです: ${key}`);
  return { root, pitchClass: noteNameToPitchClass(root), minor };
}

/**
 * キーの調号がフラット系か。ルートに b(♭)があればフラット、#(♯)があればシャープ。
 * ナチュラルのルートは同じ調号のメジャーキーで決める(F major と D・G・C・F minor が
 * フラット、調号の無い C major / A minor はシャープを既定とする)。読めないキーは Error。
 */
export function keySignatureUsesFlats(key: string): boolean {
  const { root, minor } = readKey(key);
  if (root.includes('b')) return true;
  if (root.includes('#')) return false;
  return (minor ? FLAT_NATURAL_MINOR : FLAT_NATURAL_MAJOR).has(root);
}

/** キー `from` から `to` へ近い方向に動く半音数(-5〜+6)。♯/♭ も読む。読めないキーは Error。 */
export function keyShiftSemitones(from: string, to: string): number {
  const up = semitoneClass(readKey(to).pitchClass - readKey(from).pitchClass);
  return up > 6 ? up - 12 : up;
}

/**
 * キー `key`(モード付き可)を `semitones` 動かした後のルート名(ASCII)。メジャーは
 * Db・Eb・Ab・Bb・F#、マイナーは C#・Eb・G#・Bb・F# のように調号の少ない綴りを選ぶ。
 * `semitones` は安全な整数に限り、それ以外は RangeError。
 */
export function transposeKeyName(key: string, semitones: number): string {
  requireSafeInteger('semitones', semitones);
  const { pitchClass, minor } = readKey(key);
  return (minor ? MINOR_KEY_NAMES : MAJOR_KEY_NAMES)[(pitchClass + semitoneClass(semitones)) % 12] as string;
}

/**
 * コード名を `semitones` 半音動かし、移調後のキー `keyAfter` の調号に合わせて書く
 * (例: キー D major で 'Am7' +2 → 'Bm7'、'C/E' +2 → 'D/F#')。
 *
 * - 読み取りはコード入力欄と同じ規則(parseChord。♯/♭ も読む)。読めない記号は日本語の理由つきの Error。
 * - 動かすのはルートと分数コードのベース(ピッチクラス)だけ。品質・テンション部分
 *   (m7、m7b5、add9、maj9 など)は書かれたまま残す。
 * - 音名は 12 音の綴り(C# / Db など)だけを使い、Cb・E#・ダブルシャープは使わない。
 * - `semitones` は安全な整数(Number.isSafeInteger)に限り、それ以外は RangeError。
 *   足す前に 12 で割った余りに直すので、巨大な量でも結果は正しい。
 */
export function transposeChordSymbol(symbol: string, semitones: number, keyAfter: string): string {
  requireSafeInteger('semitones', semitones);
  const names = keySignatureUsesFlats(keyAfter) ? FLAT_NAMES : SHARP_NAMES;
  let parsed: ReturnType<typeof parseBoundedChord>;
  try {
    parsed = parseBoundedChord(symbol);
  } catch {
    const label = typeof symbol === 'string' && symbol.length <= 1024 ? `「${symbol}」` : '入力された文字列';
    throw new Error(
      `${label}はコード名として読み取れません。C、Am、G7、Dm7/G のような書き方に直してから移調してください。`,
    );
  }
  const { suffix, bassSpelling } = parseChordTokens(symbol, { allowSlash: true });
  const shift = semitoneClass(semitones);
  const spell = (pc: number) => names[(pc + shift) % 12] as string;
  const body = `${spell(parsed.rootPc)}${suffix.trimEnd()}`;
  return bassSpelling ? `${body}/${spell(parsed.bassPc)}` : body;
}
