/**
 * ピッチユーティリティ
 *
 * - 音名 <-> MIDI番号
 * - ピッチクラス抽出
 * - キーに応じたエンハーモニック綴り (フラット系キーはフラット、シャープ系キーはシャープ)
 *
 * 用語の区別 (Musical Correctness Rules):
 * - pitch class: 0-11 のオクターブ非依存クラス
 * - MIDI note: オクターブ込みの 0-127
 */

/** シャープ綴りのピッチクラス名 (C=0)。 */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** フラット綴りのピッチクラス名 (C=0)。 */
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

type NoteNameList = typeof SHARP_NAMES | typeof FLAT_NAMES;

/** オクターブ表記を含んでもよい音名のパース結果。 */
export type ParsedPitchNoteName = {
  name: string;
  pitchClass: number;
  octave?: number;
};

/** 自然音 (ナチュラル) のピッチクラス。 */
const NATURAL_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/**
 * 明示的にシャープで綴るナチュラルキールート。
 * これら以外のナチュラルキー (C, F) はフラット/ナチュラル扱い。
 */
const SHARP_KEY_ROOTS = new Set(['G', 'D', 'A', 'E', 'B']);

/** 臨時記号を正規化する (♯->#, ♭->b)。 */
function normalizeAccidentals(accidentals: string): string {
  return accidentals.replace(/♯/g, '#').replace(/♭/g, 'b');
}

function normalizePitchClass(pc: number): number {
  return ((pc % 12) + 12) % 12;
}

function namesForSpelling(flats = false): NoteNameList {
  return flats ? FLAT_NAMES : SHARP_NAMES;
}

/**
 * 音名を正規化してピッチクラス(0-11)を返す。
 * 受理する綴り: C, C#, Db, B#, Cb, Fx(ダブルシャープ), Bbb(ダブルフラット) 等。
 * 不正な場合は例外を投げる。
 */
export function noteNameToPitchClass(name: string): number {
  const trimmed = name.trim();
  const letter = trimmed.charAt(0).toUpperCase();
  const base = NATURAL_PC[letter];
  if (base === undefined) {
    throw new Error(`不正な音名です: ${name}`);
  }
  let pc = base;
  for (const ch of trimmed.slice(1)) {
    if (ch === '#' || ch === '♯') pc += 1;
    else if (ch === 'x' || ch === 'X') pc += 2;
    else if (ch === 'b' || ch === '♭') pc -= 1;
    else throw new Error(`不正な臨時記号です: ${name}`);
  }
  return normalizePitchClass(pc);
}

/** 音名文字列を、オクターブの有無を保ったままパースする。 */
export function parsePitchNoteName(input: string): ParsedPitchNoteName {
  const match = input.trim().match(/^([A-Ga-g])([#x♯b♭]*)(-?\d+)?$/);
  if (!match) {
    throw new Error(`不正な音名です: ${input}`);
  }

  const [, letterRaw = '', accidentalsRaw = '', octaveStr] = match;
  const name = letterRaw.toUpperCase() + normalizeAccidentals(accidentalsRaw);
  const pitchClass = noteNameToPitchClass(name);

  if (octaveStr === undefined) {
    return { name, pitchClass };
  }
  return { name, pitchClass, octave: Number.parseInt(octaveStr, 10) };
}

/** パース済み音名を MIDI 番号へ変換する。 */
export function parsedNoteNameToMidi(parsed: ParsedPitchNoteName, defaultOctave = 4): number {
  const octave = parsed.octave ?? defaultOctave;
  return (octave + 1) * 12 + parsed.pitchClass;
}

/**
 * MIDIノート番号を音名へ変換する共有実装。
 * notes.ts の公開APIは既存挙動に合わせて pitch class 側だけ整数化する。
 */
export function formatMidiNoteName(
  midi: number,
  opts?: { flats?: boolean; truncatePitchClass?: boolean },
): string {
  const midiForPitchClass = opts?.truncatePitchClass ? Math.trunc(midi) : midi;
  const pc = normalizePitchClass(midiForPitchClass);
  const octave = Math.floor(midi / 12) - 1;
  const names = namesForSpelling(opts?.flats);
  return `${names[pc]}${octave}`;
}

/**
 * MIDIノート番号を音名へ。デフォルトはシャープ綴り。
 * オクターブ番号付き (MIDI 60 -> "C4")。
 */
export function midiToNoteName(midi: number, opts?: { flats?: boolean }): string {
  return formatMidiNoteName(midi, opts);
}

/**
 * 音名(オクターブ付き、例 "C4" / "Bb3" / "F#5")を MIDI番号へ。
 * オクターブが無い場合は4オクターブを既定とする。
 */
export function noteNameToMidi(name: string): number {
  return parsedNoteNameToMidi(parsePitchNoteName(name));
}

/** MIDIノート番号からピッチクラス(0-11)を抽出する。 */
export function pitchClassOf(midi: number): number {
  return normalizePitchClass(midi);
}

/** キー文字列から先頭のルート音名部分を取り出す ("Cm" -> "C", "Bbmaj" -> "Bb")。 */
export function parseKeyRoot(key: string): string {
  const match = key.trim().match(/^([A-Ga-g][#b♯♭]*)/);
  if (!match || match[1] === undefined) {
    throw new Error(`不正なキーです: ${key}`);
  }
  const letter = match[1].charAt(0).toUpperCase();
  const accidentals = normalizeAccidentals(match[1].slice(1));
  return letter + accidentals;
}

/**
 * キーがフラット綴りを好むか判定する。
 * メジャー/マイナーを問わずルート音名のみで決める簡易ロジック。
 * - 明示フラット (Bb, Eb, ...) や F は flats
 * - 明示シャープ (G#, ...) や シャープ系ナチュラル (G,D,A,E,B) は sharps
 * - C はナチュラルのみなので sharps を既定とする
 */
export function keyPrefersFlats(key: string): boolean {
  const root = parseKeyRoot(key);
  if (root.includes('b')) return true;
  if (root.includes('#')) return false;
  if (root === 'F') return true;
  if (SHARP_KEY_ROOTS.has(root)) return false;
  return false;
}

/**
 * ピッチクラスを、指定キーに適した綴りで音名(オクターブ無し)にする。
 * フラット系キーならフラット、シャープ系キーならシャープを使う。
 */
export function spellPitchClass(pc: number, key: string): string {
  const normalized = normalizePitchClass(pc);
  const flats = keyPrefersFlats(key);
  const names = namesForSpelling(flats);
  const name = names[normalized];
  if (name === undefined) {
    throw new Error(`不正なピッチクラスです: ${pc}`);
  }
  return name;
}

/** キーに依らずシャープ綴りで音名(オクターブ無し)を返す。 */
export function pitchClassToSharpName(pc: number): string {
  const normalized = normalizePitchClass(pc);
  const name = SHARP_NAMES[normalized];
  if (name === undefined) {
    throw new Error(`不正なピッチクラスです: ${pc}`);
  }
  return name;
}

/** 音名定数を読み取り専用で公開 (テスト/内部用)。 */
export { SHARP_NAMES, FLAT_NAMES };
