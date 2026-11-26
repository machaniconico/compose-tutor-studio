import { describe, expect, it } from 'vitest';
import {
  createPrng,
  getScalePitchClasses,
  isInScale,
  keyShiftSemitones,
  keySignatureUsesFlats,
  nearestScalePitch,
  parseChord,
  randomInt,
  SCALE_NAMES,
  transposeByDegree,
  transposeChordSymbol,
  transposeKeyName,
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

// --- US-016: コード名の移調 ---
// 表記規則: 移調後のキーの調号に合わせる(シャープ系はシャープ、フラット系はフラット)。
// 分数コードはルートとベースの両方を動かし、品質・テンション部分(m7, add9, maj9 など)はそのまま残す。
// コード入力欄と同じ規則(parseChord)で読めない記号は理由つきで拒否する。
describe('transposeChordSymbol', () => {
  it("'Am7' を +2 してキー D major で 'Bm7'", () => {
    expect(transposeChordSymbol('Am7', 2, 'D major')).toBe('Bm7');
  });

  it("分数コード 'C/E' を +2 すると 'D/F#'(ルートとベースの両方を動かす)", () => {
    expect(transposeChordSymbol('C/E', 2, 'D major')).toBe('D/F#');
  });

  it("'Bb' を +1 するとキー B major の表記で 'B'", () => {
    expect(transposeChordSymbol('Bb', 1, 'B major')).toBe('B');
  });

  it('フラット系のキーではフラットで書く(F#→Gb ではなく、キー Eb major で A7+1 は Bb7)', () => {
    expect(transposeChordSymbol('A7', 1, 'Eb major')).toBe('Bb7');
    expect(transposeChordSymbol('C', 3, 'Eb major')).toBe('Eb');
    expect(transposeChordSymbol('G/B', 3, 'Bb major')).toBe('Bb/D');
  });

  it('マイナーキーは同じ調号のメジャーキーに従う(D minor はフラット 1 つ、B minor はシャープ 2 つ)', () => {
    expect(transposeChordSymbol('A', 1, 'D minor')).toBe('Bb');
    expect(transposeChordSymbol('A', 1, 'Dm')).toBe('Bb');
    expect(transposeChordSymbol('F', 1, 'B minor')).toBe('F#');
    // ナチュラルの A minor と C major はシャープを既定とする。
    expect(transposeChordSymbol('C', 1, 'A minor')).toBe('C#');
  });

  it('キー名の綴りを尊重する(F# major はシャープ、Gb major はフラット)', () => {
    expect(transposeChordSymbol('C#m', 0, 'Gb major')).toBe('Dbm');
    expect(transposeChordSymbol('Dbm', 0, 'F# major')).toBe('C#m');
  });

  it('品質・テンション部分はそのまま残す(m7b5、add9、maj9、dim7、sus4、m6)', () => {
    expect(transposeChordSymbol('Bm7b5', 2, 'D major')).toBe('C#m7b5');
    expect(transposeChordSymbol('Cadd9', 2, 'D major')).toBe('Dadd9');
    expect(transposeChordSymbol('Fmaj9/A', -5, 'C major')).toBe('Cmaj9/E');
    expect(transposeChordSymbol('Bdim7', 1, 'C major')).toBe('Cdim7');
    expect(transposeChordSymbol('Gsus4', -2, 'F major')).toBe('Fsus4');
    expect(transposeChordSymbol('Em6', 3, 'G major')).toBe('Gm6');
  });

  it('♯/♭ の記号や小文字のルートも読み、出力は # と b に揃える', () => {
    expect(transposeChordSymbol('F♯m', 1, 'G major')).toBe('Gm');
    expect(transposeChordSymbol('E♭', 0, 'Bb major')).toBe('Eb');
    expect(transposeChordSymbol('am', 2, 'D major')).toBe('Bm');
  });

  it('1 オクターブ以上(±12 以上)でもピッチクラスで回り込む', () => {
    expect(transposeChordSymbol('C', 12, 'C major')).toBe('C');
    expect(transposeChordSymbol('C', -13, 'C major')).toBe('B');
    expect(transposeChordSymbol('C', 25, 'C major')).toBe('C#');
  });

  it('読み取れないコード名は日本語の理由つきで拒否する', () => {
    for (const symbol of ['', 'N.C.', 'H7', 'C/H', 'C7b9', 'IV', 'C/E/G', 'Cfoo']) {
      expect(() => transposeChordSymbol(symbol, 2, 'D major')).toThrow(/コード名として読み取れません/);
    }
  });

  it('移調量は有限の整数に限る(NaN・小数・Infinity は RangeError)', () => {
    for (const bad of [Number.NaN, 0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => transposeChordSymbol('C', bad, 'C major')).toThrow(RangeError);
    }
  });

  it('読み取れないキーは拒否する', () => {
    expect(() => transposeChordSymbol('C', 2, 'H major')).toThrow();
    expect(() => transposeChordSymbol('C', 2, 'D dorian')).toThrow();
  });
});

describe('レビュー指摘の回帰(US-016)', () => {
  it('巨大な移調量は 12 で割った余りで動かす(2^53-1 は +7 と同じ)。安全な整数を超える量は拒否する', () => {
    expect(transposeChordSymbol('G/B', 2 ** 53 - 1, 'Ab major')).toBe('D/Gb');
    expect(transposeChordSymbol('G/B', -(2 ** 53 - 1), 'C major')).toBe('C/E');
    expect(transposeChordSymbol('G/B', 8 + 12 * 1e9, 'Ab major')).toBe('Eb/G');
    expect(() => transposeChordSymbol('G/B', 2 ** 53, 'Ab major')).toThrow(RangeError);
  });

  it('キー名の Unicode の ♯/♭ を ASCII の #/b と同じに読む', () => {
    expect(transposeChordSymbol('C', 6, 'F♯ major')).toBe('F#');
    expect(transposeChordSymbol('C', 6, 'G♭ major')).toBe('Gb');
    expect(keySignatureUsesFlats('B♭ minor')).toBe(true);
    expect(keySignatureUsesFlats('C♯ minor')).toBe(false);
    expect(keyShiftSemitones('F♯', 'Gb')).toBe(0);
    expect(keyShiftSemitones('C', 'B♭')).toBe(-2);
    expect(transposeKeyName('F♯ major', 0)).toBe('F#');
    expect(transposeKeyName('E♭ naturalMinor', 0)).toBe('Eb');
  });
});

describe('keyShiftSemitones / transposeKeyName', () => {
  it('近い方向(-5〜+6)の半音数を返す', () => {
    expect(keyShiftSemitones('C', 'D')).toBe(2);
    expect(keyShiftSemitones('C', 'Bb')).toBe(-2);
    expect(keyShiftSemitones('C', 'F#')).toBe(6);
    expect(keyShiftSemitones('C', 'G')).toBe(-5);
    expect(() => keyShiftSemitones('H', 'C')).toThrow();
  });

  it('移調後のキー名はスケールに合う綴り(メジャーは Db、マイナーは C#)', () => {
    expect(transposeKeyName('C major', 1)).toBe('Db');
    expect(transposeKeyName('C naturalMinor', 1)).toBe('C#');
    expect(transposeKeyName('C', 2 ** 53 - 1)).toBe('G');
    expect(() => transposeKeyName('C', 2 ** 53)).toThrow(RangeError);
    expect(() => transposeKeyName('C', 0.5)).toThrow(RangeError);
  });
});

describe('keySignatureUsesFlats', () => {
  it('メジャーとマイナーの全キーで調号の向きを返す', () => {
    const flatsMajor = ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
    const sharpsMajor = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
    for (const k of flatsMajor) expect(keySignatureUsesFlats(`${k} major`)).toBe(true);
    for (const k of sharpsMajor) expect(keySignatureUsesFlats(`${k} major`)).toBe(false);
    const flatsMinor = ['D', 'G', 'C', 'F', 'Bb', 'Eb', 'Ab'];
    const sharpsMinor = ['A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
    for (const k of flatsMinor) expect(keySignatureUsesFlats(`${k} minor`)).toBe(true);
    for (const k of sharpsMinor) expect(keySignatureUsesFlats(`${k} minor`)).toBe(false);
  });

  it('スケール名(naturalMinor など)もモードとして読む', () => {
    expect(keySignatureUsesFlats('D naturalMinor')).toBe(true);
    expect(keySignatureUsesFlats('D harmonicMinor')).toBe(true);
    expect(keySignatureUsesFlats('D majorPentatonic')).toBe(false);
  });
});

describe('transposeChordSymbol ファズ(seed 固定)', () => {
  const ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B', 'C♯', 'B♭', 'E♭'];
  const SUFFIXES = ['', 'm', 'm7', '7', 'maj7', 'dim', 'aug', 'm7b5', 'dim7', 'sus2', 'sus4', '6', 'm6', 'add9', '9', 'maj9', 'm9', 'mMaj7'];
  const KEY_ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B', 'F♯', 'B♭', 'E♭', 'C♯'];
  const HUGE = [2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 40 + 5, -(2 ** 33) - 1, 1e15 + 7];
  const MODES = ['major', 'minor'];

  it('+n して -n すると、元のキーの表記規則で書いた同じコードに戻り、ルートとベースは n 半音動く', () => {
    const rand = createPrng(16016);
    for (let i = 0; i < 3000; i += 1) {
      const symbol =
        ROOTS[randomInt(rand, 0, ROOTS.length - 1)]! +
        SUFFIXES[randomInt(rand, 0, SUFFIXES.length - 1)]! +
        (rand() < 0.3 ? `/${ROOTS[randomInt(rand, 0, ROOTS.length - 1)]!}` : '');
      const keyBefore = `${KEY_ROOTS[randomInt(rand, 0, KEY_ROOTS.length - 1)]!} ${MODES[randomInt(rand, 0, 1)]!}`;
      const keyAfter = `${KEY_ROOTS[randomInt(rand, 0, KEY_ROOTS.length - 1)]!} ${MODES[randomInt(rand, 0, 1)]!}`;
      const n = rand() < 0.1 ? HUGE[randomInt(rand, 0, HUGE.length - 1)]! : randomInt(rand, -12, 12);
      const moved = transposeChordSymbol(symbol, n, keyAfter);
      const before = parseChord(symbol);
      const after = parseChord(moved);
      const shift = ((n % 12) + 12) % 12;
      expect(after.rootPc).toBe((before.rootPc + shift) % 12);
      expect(after.bassPc).toBe((before.bassPc + shift) % 12);
      expect(after.quality).toBe(before.quality);
      // 表記はキーの調号の向きだけを使う。
      const accidentals = [...moved.matchAll(/(?:^|\/)[A-G]([#b]?)/g)].map((m) => m[1]);
      for (const acc of accidentals) {
        if (acc === '') continue;
        expect(acc).toBe(keySignatureUsesFlats(keyAfter) ? 'b' : '#');
        expect(keySignatureUsesFlats(keyAfter)).toBe(keySignatureUsesFlats(keyAfter.replace('♯', '#').replace('♭', 'b')));
      }
      expect(transposeChordSymbol(moved, -n, keyBefore)).toBe(transposeChordSymbol(symbol, 0, keyBefore));
    }
  });

  it('移調量が NaN・小数・Infinity なら必ず拒否する', () => {
    const rand = createPrng(7);
    for (let i = 0; i < 200; i += 1) {
      const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, randomInt(rand, -12, 12) + 0.5, 2 ** 53, -(2 ** 60)][randomInt(rand, 0, 5)]!;
      expect(() => transposeChordSymbol('Am7', bad, 'C major')).toThrow(RangeError);
    }
  });
});
