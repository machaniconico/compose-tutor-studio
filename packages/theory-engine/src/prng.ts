/**
 * 決定論的擬似乱数生成 (PRNG)
 *
 * Math.random を使わず、seed から再現可能な乱数列を生成する。
 * mulberry32 アルゴリズムを採用 (高速・十分な分布)。
 */

/** 0以上1未満の乱数を返す関数。 */
export type RandomFn = () => number;

/**
 * mulberry32 PRNG を生成する。
 * 同じ seed なら必ず同じ列を返す (決定論的)。
 */
export function mulberry32(seed: number): RandomFn {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** seed から PRNG を作る薄いエイリアス。 */
export function createPrng(seed: number): RandomFn {
  return mulberry32(seed);
}

/**
 * rng を使って [min, max] (両端含む) の整数を返す。
 */
export function randomInt(rng: RandomFn, min: number, max: number): number {
  if (max < min) {
    throw new Error(`randomInt: max(${max}) < min(${min})`);
  }
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * rng を使って配列から1要素を選ぶ。空配列は例外。
 */
export function pick<T>(rng: RandomFn, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('pick: 空配列からは選べません');
  }
  const idx = Math.floor(rng() * items.length);
  const value = items[idx];
  if (value === undefined) {
    const fallback = items[items.length - 1];
    if (fallback === undefined) {
      throw new Error('pick: 要素を取得できませんでした');
    }
    return fallback;
  }
  return value;
}
