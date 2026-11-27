// プロジェクトの key / scale から Key Signature メタ(FF 59)を作る。
import type { MusicalKey, ScaleName } from '@cts/project-model';

const PITCH_CLASS: Readonly<Record<MusicalKey, number>> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

const SCALES: ReadonlySet<string> = new Set([
  'major', 'naturalMinor', 'harmonicMinor', 'melodicMinor',
  'majorPentatonic', 'minorPentatonic', 'blues',
]);

/** 実行時に壊れた値(型を信用できない入力)を弾く。 */
export function isKnownKeyAndScale(key: unknown, scale: unknown): key is MusicalKey {
  return typeof key === 'string' && Object.hasOwn(PITCH_CLASS, key)
    && typeof scale === 'string' && SCALES.has(scale);
}

// 長調の主音(半音 0〜11)ごとの調号。異名同音は # / b の少ないほう。
// 6 個ずつで同数の F# / Gb だけは決められないので、呼び出し側の綴りに従う。
const MAJOR_SF = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5] as const;

// 短調系・長調系のスケール。調号を持たないスケールは親の調号を使う
// (ペンタトニックとブルースは同じ主音の長調 / 短調の調号)。
const MINOR_SCALES: ReadonlySet<ScaleName> = new Set([
  'naturalMinor', 'harmonicMinor', 'melodicMinor', 'minorPentatonic', 'blues',
]);

/** Key Signature メタの sf(-7〜7)と mi(0 長調 / 1 短調)。 */
export function keySignatureFor(key: MusicalKey, scale: ScaleName): { sf: number; mi: 0 | 1 } {
  const minor = MINOR_SCALES.has(scale);
  const tonic = PITCH_CLASS[key];
  const majorPc = minor ? (tonic + 3) % 12 : tonic;
  let sf: number = MAJOR_SF[majorPc]!;
  if (Math.abs(sf) === 6) sf = key.includes('b') ? -6 : 6;
  return { sf, mi: minor ? 1 : 0 };
}

/** FF 59 02 sf mi。sf は符号付き 1 バイト。 */
export function keySignatureMeta(key: MusicalKey, scale: ScaleName): number[] {
  const { sf, mi } = keySignatureFor(key, scale);
  return [0xff, 0x59, 0x02, sf & 0xff, mi];
}
