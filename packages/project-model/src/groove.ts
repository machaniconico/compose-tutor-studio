// グルーヴ(US-018): スウィング、強さ付きクオンタイズ、ヒューマナイズの純粋関数。
// スウィングは保存データを変えず、再生時に soundingEvents(clipExpand の passPlacement)が
// swingBeat で掛ける。ライブ・WAV・MIDI は soundingEvents を写すだけなので 3 経路で同じになる。
import { beatTick } from './time';

/** スウィングが掛かるグリッド(1/16 音符 = 0.25 拍)。 */
export const SWING_GRID_BEATS = 0.25;
export const MAX_SWING_PERCENT = 60;

/**
 * スウィング後の拍。グリッドの奇数 index(1 始まりで偶数番目のステップ)にちょうど
 * 乗っている拍(tick で比較)だけを、ステップ長 × swing% / 100 だけ遅らせる。
 * 0% と、グリッドに乗っていない拍は変えない。
 */
export function swingBeat(beat: number, swingPercent = 0, gridBeats = SWING_GRID_BEATS): number {
  const step = Math.round(beat / gridBeats);
  const delay = swingPercent > 0 && step % 2 === 1 && beatTick(beat) === beatTick(step * gridBeats)
    ? (gridBeats * swingPercent) / 100
    : 0;
  return beat + delay;
}

/** 各イベントの startBeat に swingBeat を掛ける。配列の順番は変えず、動かない要素はそのまま返す。 */
export function applySwing<T extends { startBeat: number }>(
  events: readonly T[],
  swingPercent = 0,
  gridBeats = SWING_GRID_BEATS,
): T[] {
  return events.map((event) => {
    const startBeat = swingBeat(event.startBeat, swingPercent, gridBeats);
    return startBeat === event.startBeat ? event : { ...event, startBeat };
  });
}

export type QuantizeTarget = 'start' | 'length' | 'both';

function validStrength(strength: number): boolean {
  return Number.isFinite(strength) && strength >= 0 && strength <= 100;
}

/** `value` を `grid` へ strength% だけ近づける。100 はちょうど grid、0 は元のまま。 */
export function towardGrid(value: number, grid: number, strength: number): number {
  if (strength >= 100) return grid;
  if (strength <= 0) return value;
  return value + (grid - value) * (strength / 100);
}

/**
 * 強さ付きクオンタイズ。開始はいちばん近い `snap` の線(0 未満にしない)、長さは
 * いちばん近い `snap` の倍数(`snap` 未満にしない)へ strength%(0〜100)だけ寄せる。
 * strength 100・target 'start' は既存のクオンタイズ(quantizeClipNotes)と同じ位置になる。
 * クリップの範囲(D2)はここでは見ない。不正な入力では何も変えない。
 */
export function quantize<T extends { startBeat: number; durationBeats: number }>(
  notes: readonly T[],
  snap: number,
  options: { strength?: number; target?: QuantizeTarget } = {},
): T[] {
  const { strength = 100, target = 'start' } = options;
  if (!Number.isFinite(snap) || !(snap > 0) || !validStrength(strength)) return [...notes];
  return notes.map((note) => {
    const startBeat = target === 'length'
      ? note.startBeat
      : towardGrid(note.startBeat, Math.max(0, Math.round(note.startBeat / snap) * snap), strength);
    const durationBeats = target === 'start'
      ? note.durationBeats
      : towardGrid(note.durationBeats, Math.max(snap, Math.round(note.durationBeats / snap) * snap), strength);
    return startBeat === note.startBeat && durationBeats === note.durationBeats ? note : { ...note, startBeat, durationBeats };
  });
}

/** seed 付きの擬似乱数(mulberry32、0 以上 1 未満)。Math.random は使わない。 */
export function groovePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type HumanizeOptions = { timingBeats: number; velocity: number; seed: number };

export function validHumanizeOptions({ timingBeats, velocity, seed }: HumanizeOptions): boolean {
  return Number.isFinite(timingBeats) && timingBeats >= 0 &&
    Number.isFinite(velocity) && velocity >= 0 && Number.isSafeInteger(seed);
}

/**
 * ヒューマナイズ。各音の開始を ±timingBeats(0 未満にはしない)、強さを ±velocity の
 * 整数(1〜127)の範囲でばらつかせる。音の高さと長さは変えない。同じ seed と並びなら
 * 同じ結果になる(1 音につき乱数を 2 つ、配列の順に引く)。不正な入力では何も変えない。
 */
export function humanize<T extends { startBeat: number; velocity: number }>(
  notes: readonly T[],
  options: HumanizeOptions,
): T[] {
  if (!validHumanizeOptions(options)) return [...notes];
  const { timingBeats, velocity } = options;
  const rng = groovePrng(options.seed);
  const maxVelocityStep = Math.floor(velocity);
  return notes.map((note) => {
    const timing = (rng() * 2 - 1) * timingBeats;
    const velocityStep = Math.max(-maxVelocityStep, Math.min(maxVelocityStep, Math.round((rng() * 2 - 1) * velocity)));
    const moved = Math.max(0, note.startBeat + timing);
    // 足し算の丸めで幅をわずかに超える時は動かさない。
    const startBeat = Math.abs(moved - note.startBeat) <= timingBeats ? moved : note.startBeat;
    const nextVelocity = Math.max(1, Math.min(127, note.velocity + velocityStep));
    return startBeat === note.startBeat && nextVelocity === note.velocity
      ? note
      : { ...note, startBeat, velocity: nextVelocity };
  });
}
