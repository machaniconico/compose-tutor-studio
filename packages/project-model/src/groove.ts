// Pure timing and drum-grid transforms (US-018 and US-019).
import { MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS } from './schedule-budget';
import { beatTick, PPQ } from './ticks';
import type { DrumEvent, DrumLane } from './types';

function assertEventCount(count: number): void {
  if (count > MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS) {
    throw new RangeError(`Groove transforms accept at most ${MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS} events`);
  }
}

/** スウィングが掛かるグリッド(1/16 音符 = 0.25 拍)。 */
export const SWING_GRID_BEATS = 0.25;
export const MAX_SWING_PERCENT = 60;

/**
 * スウィング後の拍。グリッドの奇数 index(1 始まりで偶数番目のステップ)にちょうど
 * 乗っている拍(tick で比較)だけを、ステップ長 × swing% / 100 だけ遅らせる。
 * 0% と、グリッドに乗っていない拍は変えない。
 */
export function swingBeat(beat: number, swingPercent = 0, gridBeats = SWING_GRID_BEATS): number {
  if (!Number.isFinite(beat) || !Number.isFinite(swingPercent) || !Number.isFinite(gridBeats) || gridBeats <= 0) {
    return beat;
  }
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
  assertEventCount(events.length);
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
 * strength 100・target 'start' はもっとも近いグリッド線へ移す。
 * クリップの範囲(D2)はここでは見ない。不正な入力では何も変えない。
 */
export function quantize<T extends { startBeat: number; durationBeats: number }>(
  notes: readonly T[],
  snap: number,
  options: { strength?: number; target?: QuantizeTarget } = {},
): T[] {
  assertEventCount(notes.length);
  const { strength = 100, target = 'start' } = options;
  if (!Number.isFinite(snap) || !(snap > 0) || !validStrength(strength)) return [...notes];
  if (target !== 'start' && target !== 'length' && target !== 'both') return [...notes];
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
  assertEventCount(notes.length);
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

/**
 * ハイハットのチョーク(US-019)。オープンハットの長さを、それより後ろ(tick で比べる。同じ tick は
 * 含まない)で最も近いクローズドハットの発音までに切る。止めるのはクローズドハットだけ
 * (ペダルのレーンは無い)。どの音が同じハイハットかは呼び出し側が決める。
 * 元の長さの方が短ければ変えず、長さの無いオープンハットは
 * クローズドハットまでの長さを持つ。並び順は変えず、変えない要素はそのまま返す。
 * 切った長さの終わりの tick はクローズドハットの tick とちょうど同じになる。
 */
export function applyHiHatChoke<T extends { lane?: DrumLane; startBeat: number; durationBeats?: number }>(
  hits: readonly T[],
): T[] {
  assertEventCount(hits.length);
  const out = [...hits];
  const order = hits
    .map((hit, index) => ({ index, tick: beatTick(hit.startBeat), lane: hit.lane }))
    .filter((entry) => entry.lane === 'openHat' || entry.lane === 'closedHat')
    .sort((a, b) => a.tick - b.tick);
  // 後ろから見て、いま見ている tick より後ろで最も近いクローズドハット。
  let next: T | undefined;
  for (let end = order.length; end > 0;) {
    let start = end - 1;
    while (start > 0 && order[start - 1]!.tick === order[end - 1]!.tick) start--;
    let closedHere: T | undefined;
    for (let i = start; i < end; i++) {
      const { index, lane } = order[i]!;
      const hit = hits[index]!;
      if (lane === 'closedHat') {
        closedHere ??= hit;
        continue;
      }
      if (next === undefined) continue;
      const closedTick = beatTick(next.startBeat);
      let length = next.startBeat - hit.startBeat;
      if (beatTick(hit.startBeat + length) !== closedTick) length = closedTick / PPQ - hit.startBeat;
      if (hit.durationBeats !== undefined && beatTick(hit.startBeat + hit.durationBeats) <= closedTick) continue;
      out[index] = { ...hit, durationBeats: length };
    }
    if (closedHere !== undefined) next = closedHere;
    end = start;
  }
  return out;
}

export type DrumStepResample = { events: DrumEvent[]; moved: number; merged: number; outOfRange: number };

/**
 * A positive finite number as the decimal fraction it prints as (14.4 → 144 / 10),
 * so a saved stepsPerBar like 14.4 is used as exactly 14.4.
 */
function decimalRational(value: number): [bigint, bigint] {
  const [mantissa = '0', exponent = '0'] = String(value).split('e');
  const [whole = '0', fraction = ''] = mantissa.split('.');
  let num = BigInt(whole + fraction);
  let den = 10n ** BigInt(fraction.length);
  const e = Number(exponent);
  if (e > 0) num *= 10n ** BigInt(e);
  else if (e < 0) den *= 10n ** BigInt(-e);
  return [num, den];
}

/** floor(a / b) for b > 0. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/**
 * ドラムのステップ数の切替(US-019)。各打点を新しいグリッドで最も近いステップへ移す
 * (ちょうど中間なら後ろ)。`stepsBack(event, index)` が k ≥ 1 を返す打点は、元の位置以下で
 * 最も近いステップから k - 1 だけ手前へ移す。位置は約分した比で整数として求めるので、
 * 拍子(1 小節の拍数)によらず同じステップになる。計算はすべて BigInt で厳密に行うので、
 * 大きなステップ番号でも途中で丸まらない。12→16 で動かずに済むのは
 * 3 の倍数の位置だけ。元の細かさ `from` は正の有限の数なら整数でなくてよい(保存された
 * stepsPerBar を 10 進の有理数とみなして使う。そのときは元の位置を tick
 * (`round(step × beatsPerBar × PPQ / from)`、同点は後ろ)に厳密に丸めてから、1 小節の tick 数との
 * 整数演算で最も近いステップを求める)。
 * - `moved`: 残った打点のうち、ステップの位置(スウィング前の発音 tick、
 *   `clipStartBeat + step × beatsPerBar / steps`)が変わった個数
 * - `merged`: 同じレーン・同じステップに重なって消した個数(残すのは位置が変わらなかった方、
 *   次に強い方、次に元の位置が早い方、次に保存順で前の方)
 * - `outOfRange`: 移動先が 0 以上で、Number でちょうど表せる整数にならない打点の数
 *   (丸めて保存すると別の打点と重なり得る)。1 つでもあれば何も変えない
 * 残った打点は入力の順のまま。細かさが同じ・不正(`from` が正の有限の数でない、`to` が正の整数でない)なら何も変えない。
 */
export function resampleDrumSteps(
  events: readonly DrumEvent[],
  from: number,
  to: number,
  options: { beatsPerBar?: number; clipStartBeat?: number; stepsBack?: (event: DrumEvent, index: number) => number } = {},
): DrumStepResample {
  assertEventCount(events.length);
  const unchanged = (outOfRange: number): DrumStepResample => ({ events: [...events], moved: 0, merged: 0, outOfRange });
  const valid = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (!(Number.isFinite(from) && from > 0) || !valid(to) || from === to) return unchanged(0);
  const { beatsPerBar = 4, clipStartBeat = 0, stepsBack } = options;
  // 1 小節の拍数が不正なら位置を求められない: どの打点も移せないとして何も変えない。
  if (!(Number.isFinite(beatsPerBar) && beatsPerBar > 0)) return unchanged(events.length);
  const wholeFrom = valid(from);
  const t = BigInt(to);
  const [fromNum, fromDen] = decimalRational(from);
  const [bpbNum, bpbDen] = decimalRational(beatsPerBar);
  // 1 小節の tick 数 = barNum / barDen
  const barNum = bpbNum * BigInt(PPQ);
  const barDen = bpbDen;
  const tickOf = (step: number, steps: number) => beatTick(clipStartBeat + step * (beatsPerBar / steps));
  type Candidate = { order: number; event: DrumEvent; exact: boolean };
  const candidates: Candidate[] = [];
  let outOfRange = 0;
  events.forEach((event, order) => {
    if (!Number.isInteger(event.stepIndex) || event.stepIndex < 0) {
      outOfRange++;
      return;
    }
    const back = stepsBack?.(event, order) ?? 0;
    if (!Number.isFinite(back) || (back > 0 && !Number.isInteger(back))) {
      outOfRange++;
      return;
    }
    const backOffset = back > 0 ? BigInt(back) - 1n : 0n;
    const s = BigInt(event.stepIndex);
    let target: bigint;
    if (wholeFrom) {
      const f = BigInt(from);
      target = back > 0 ? floorDiv(s * t, f) - backOffset : floorDiv(2n * s * t + f, 2n * f);
    } else {
      // 元の位置を tick に丸め、移動先は整数演算で求める(同点は後ろ)。
      // tick = round(s × barNum / barDen ÷ (fromNum / fromDen))
      const tickDen = 2n * barDen * fromNum;
      const tick = floorDiv(2n * s * barNum * fromDen + barDen * fromNum, tickDen);
      // target = round(tick × t ÷ (barNum / barDen))
      target = back > 0
        ? floorDiv(tick * t * barDen, barNum) - backOffset
        : floorDiv(2n * tick * t * barDen + barNum, 2n * barNum);
    }
    const stepIndex = Number(target);
    if (target < 0n || !Number.isFinite(stepIndex) || BigInt(stepIndex) !== target) {
      outOfRange++;
      return;
    }
    candidates.push({
      order,
      event: stepIndex === event.stepIndex ? event : { ...event, stepIndex },
      exact: tickOf(stepIndex, to) === tickOf(event.stepIndex, from),
    });
  });
  if (outOfRange > 0) return unchanged(outOfRange);
  const survivors = new Map<DrumLane, Map<number, Candidate>>();
  let merged = 0;
  for (const candidate of candidates) {
    const lane = survivors.get(candidate.event.lane) ?? new Map<number, Candidate>();
    survivors.set(candidate.event.lane, lane);
    const current = lane.get(candidate.event.stepIndex);
    merged += current === undefined ? 0 : 1;
    if (current === undefined || outranks(candidate, current, events)) lane.set(candidate.event.stepIndex, candidate);
  }
  const kept = [...survivors.values()].flatMap((lane) => [...lane.values()]).sort((a, b) => a.order - b.order);
  return { events: kept.map((c) => c.event), moved: kept.filter((c) => !c.exact).length, merged, outOfRange: 0 };
}

function outranks(
  a: { order: number; event: DrumEvent; exact: boolean },
  b: { order: number; event: DrumEvent; exact: boolean },
  original: readonly DrumEvent[],
): boolean {
  if (a.exact !== b.exact) return a.exact;
  if (a.event.velocity !== b.event.velocity) return a.event.velocity > b.event.velocity;
  const stepA = original[a.order]!.stepIndex;
  const stepB = original[b.order]!.stepIndex;
  if (stepA !== stepB) return stepA < stepB;
  return a.order < b.order;
}
