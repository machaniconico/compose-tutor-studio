import { describe, expect, it } from 'vitest';
import {
  createPrng,
  getScalePitchClasses,
  isInScale,
  nearestScalePitch,
  randomInt,
  SCALE_NAMES,
  transposeByDegree,
} from '../src/index';

// `degrees` は「スケールの段数」。1 段上げる = 2 度上(C→D)、2 段 = 3 度上(C→E)。
describe('transposeByDegree(C major)', () => {
  it('C4 を 2 度上(1 段)げると D4、3 度上(2 段)げると E4', () => {
    expect(transposeByDegree(60, 1, 'C', 'major')).toBe(62);
    expect(transposeByDegree(60, 2, 'C', 'major')).toBe(64);
  });

  it('B3 を 1 段上げるとオクターブ境界をまたいで C4、C4 を 1 段下げると B3', () => {
    expect(transposeByDegree(59, 1, 'C', 'major')).toBe(60);
    expect(transposeByDegree(60, -1, 'C', 'major')).toBe(59);
  });

  it('スケール外の C#4 は先に下のスケール音(C4)へ丸めてから動かすので、2 度上は D4', () => {
    expect(transposeByDegree(61, 1, 'C', 'major')).toBe(62);
    // 0 段でも丸めだけ行う。
    expect(transposeByDegree(61, 0, 'C', 'major')).toBe(60);
  });

  it('7 段でちょうど 1 オクターブ', () => {
    expect(transposeByDegree(60, 7, 'C', 'major')).toBe(72);
    expect(transposeByDegree(60, -7, 'C', 'major')).toBe(48);
  });
});

describe('transposeByDegree(マイナーキー・モード・5 音/6 音のスケール)', () => {
  it('A natural minor: G4 を 1 段上げると A4、A4 を 1 段下げると G4', () => {
    expect(transposeByDegree(67, 1, 'A', 'naturalMinor')).toBe(69);
    expect(transposeByDegree(69, -1, 'A', 'naturalMinor')).toBe(67);
  });

  it('A harmonic minor は G# を含むので、F4 を 1 段上げると G#4', () => {
    expect(transposeByDegree(65, 1, 'A', 'harmonicMinor')).toBe(68);
  });

  it('C major pentatonic: E4 を 1 段上げると G4(F を飛ばす)', () => {
    expect(transposeByDegree(64, 1, 'C', 'majorPentatonic')).toBe(67);
  });

  it('A minor pentatonic: G4 を 1 段上げると次のオクターブの A4', () => {
    expect(transposeByDegree(67, 1, 'A', 'minorPentatonic')).toBe(69);
  });

  it('フラット系のキー(Bb major)と「Am」表記のキーも扱える', () => {
    expect(transposeByDegree(70, 1, 'Bb', 'major')).toBe(72);
    expect(transposeByDegree(57, 2, 'Am', 'naturalMinor')).toBe(60);
  });

  it('範囲外の結果もそのまま返す(0〜127 の判定は呼び出し側)', () => {
    expect(transposeByDegree(127, 1, 'C', 'major')).toBe(129); // G9 → A9
    expect(transposeByDegree(0, -1, 'C', 'major')).toBe(-1);
  });
});

describe('nearestScalePitch', () => {
  it('スケール内の音はそのまま返す', () => {
    expect(nearestScalePitch(60, 'C', 'major')).toBe(60);
    expect(nearestScalePitch(59, 'C', 'major', 'up')).toBe(59);
  });

  it('C major の C#4 は C4 と D4 から等距離: down(既定)で C4、up で D4', () => {
    expect(nearestScalePitch(61, 'C', 'major')).toBe(60);
    expect(nearestScalePitch(61, 'C', 'major', 'down')).toBe(60);
    expect(nearestScalePitch(61, 'C', 'major', 'up')).toBe(62);
  });

  it('等距離でなければ近い方: C minor pentatonic の D4 は C4(2) より Eb4(1) が近い', () => {
    expect(nearestScalePitch(62, 'C', 'minorPentatonic')).toBe(63);
  });

  it('オクターブ境界をまたいで丸める: Db major で C の行はスケール内、D は C#/Eb の等距離', () => {
    expect(nearestScalePitch(72, 'Db', 'major')).toBe(72);
    expect(nearestScalePitch(62, 'Db', 'major')).toBe(61);
    expect(nearestScalePitch(62, 'Db', 'major', 'up')).toBe(63);
  });
});

describe('入力の守り', () => {
  it.each([Infinity, -Infinity, NaN, 0.5])('degrees = %s は RangeError', (degrees) => {
    expect(() => transposeByDegree(60, degrees, 'C', 'major')).toThrow(RangeError);
  });

  it.each([Infinity, NaN, 60.5])('midi = %s は RangeError', (midi) => {
    expect(() => transposeByDegree(midi, 1, 'C', 'major')).toThrow(RangeError);
    expect(() => nearestScalePitch(midi, 'C', 'major')).toThrow(RangeError);
  });
});

describe('プロパティ(seed 固定)', () => {
  const KEYS = ['C', 'G', 'D', 'F', 'Bb', 'Eb', 'A', 'E', 'F#', 'Ab', 'Am', 'C#'];

  it('nearestScalePitch は常にスケール内で、元の音から 6 半音以内', () => {
    const rng = createPrng(20261127);
    for (let i = 0; i < 2000; i += 1) {
      const key = KEYS[randomInt(rng, 0, KEYS.length - 1)]!;
      const scale = SCALE_NAMES[randomInt(rng, 0, SCALE_NAMES.length - 1)]!;
      const midi = randomInt(rng, 0, 127);
      for (const tie of ['down', 'up'] as const) {
        const out = nearestScalePitch(midi, key, scale, tie);
        expect(isInScale(out, key, scale)).toBe(true);
        expect(Math.abs(out - midi)).toBeLessThanOrEqual(6);
      }
    }
  });

  it('スケール内の音は +n 段して −n 段すると元に戻り、結果はスケール内', () => {
    const rng = createPrng(14);
    for (let i = 0; i < 2000; i += 1) {
      const key = KEYS[randomInt(rng, 0, KEYS.length - 1)]!;
      const scale = SCALE_NAMES[randomInt(rng, 0, SCALE_NAMES.length - 1)]!;
      const pcs = getScalePitchClasses(key, scale);
      const pc = pcs[randomInt(rng, 0, pcs.length - 1)]!;
      const midi = pc + 12 * randomInt(rng, 0, 9);
      const n = randomInt(rng, -15, 15);
      const up = transposeByDegree(midi, n, key, scale);
      expect(isInScale(up, key, scale)).toBe(true);
      expect(transposeByDegree(up, -n, key, scale)).toBe(midi);
      // 段数の符号どおりに動く。
      expect(Math.sign(up - midi)).toBe(Math.sign(n));
    }
  });
});
