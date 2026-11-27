/**
 * コードのボイシング (和音を具体的な MIDI ノート番号の並びにする)。
 *
 * - voiceChord: コードシンボルを 1 つのボイシングにする。
 *   close = 最低音から 1 オクターブ内に積む (密集配分)。
 *   open  = close の下から 2 番目・4 番目…の音を 1 オクターブ上げる (開離配分)。
 * - voiceLead: 前のコードからの総移動量 (半音の絶対値の和) が最小になるボイシングを選ぶ。
 *   同点は「最高音が低い方」→「配列の辞書順」で決める。
 *
 * 分数コード (例 C/E) はベース音 (ピッチクラス) を必ず最低音にする。
 * 戻り値は常に昇順の MIDI ノート番号 (0〜127)。
 */

import { parseBoundedChord } from './chords';

export type VoicingStyle = 'close' | 'open';

export type VoicingOptions = {
  /** 'close' (密集) か 'open' (開離)。既定 'close'。 */
  style?: VoicingStyle;
  /** 最低音の基準 MIDI ノート番号。最低音はこれ以上で最も近い音になる。既定 60 (C4)。 */
  register?: number;
};

const DEFAULT_REGISTER = 60;
const MAX_VOICES = 128;

/**
 * 最低音から順に並べたピッチクラス。最低音 (分数コードはベース、それ以外はルート) から
 * 上へ近い順に並べるので、close に積むと 1 オクターブ内に収まる (例 Cadd9 → C D E G)。
 * 構成音外のベース (例 C/D) は先頭に置き、その上に構成音を近い順に積む。
 * コード名の読み取りはコード入力欄と同じ parseChord を使う (Cadd9・C♯maj9 なども読める)。
 */
function orderedPitchClasses(symbol: string): number[] {
  const parsed = parseBoundedChord(symbol);
  // The main parser reports the slash bass separately from the chord tones.
  const chordPcs = parsed.pitchClasses;
  const bassPc = parsed.bassPc;
  const above = (pc: number) => (pc - bassPc + 12) % 12;
  const sorted = [...chordPcs].sort((a, b) => above(a) - above(b));
  return chordPcs.includes(bassPc) ? sorted : [bassPc, ...sorted];
}

function isSlashChord(symbol: string): boolean {
  return symbol.includes('/');
}

/** 最低音 `lowest` から、ピッチクラス列を毎回すぐ上の音として積む。 */
function stack(order: readonly number[], lowest: number): number[] {
  const out: number[] = [lowest];
  for (let i = 1; i < order.length; i += 1) {
    const prev = out[i - 1] as number;
    const pc = order[i] as number;
    out.push(prev + ((pc - (prev % 12) + 12) % 12 || 12));
  }
  return out;
}

/** 下から 2 番目・4 番目…を 1 オクターブ上げる。最低音 (分数コードのベース) は動かさない。 */
function spread(close: readonly number[]): number[] {
  return close.map((m, i) => (i % 2 === 1 ? m + 12 : m)).sort((a, b) => a - b);
}

/** オクターブ単位でずらして MIDI 0〜127 に収める。 */
function fitRange(notes: number[]): number[] {
  let out = notes;
  while (Math.max(...out) > 127) out = out.map((m) => m - 12);
  while (Math.min(...out) < 0) out = out.map((m) => m + 12);
  return out;
}

/** `register` 以上で最も近い、ピッチクラス `pc` の MIDI ノート番号。 */
function atOrAbove(pc: number, register: number): number {
  return register + ((pc - (((register % 12) + 12) % 12) + 12) % 12);
}

function shape(order: readonly number[], lowest: number, style: VoicingStyle): number[] {
  const close = stack(order, lowest);
  return style === 'open' ? spread(close) : close;
}

/** コードシンボルを 1 つのボイシング (昇順の MIDI ノート番号) にする。不明なシンボルは例外。 */
export function voiceChord(symbol: string, opts: VoicingOptions | null = {}): number[] {
  opts ??= {};
  const style = opts.style ?? 'close';
  const requested = opts.register ?? DEFAULT_REGISTER;
  const register = Number.isFinite(requested)
    ? Math.max(0, Math.min(127, Math.round(requested)))
    : DEFAULT_REGISTER;
  const order = orderedPitchClasses(symbol);
  return fitRange(shape(order, atOrAbove(order[0] as number, register), style));
}

/**
 * 2 つのボイシングの総移動量 (半音)。音の数が同じなら低い順に組にして差の絶対値を足す。
 * 数が違う時は、新しい各音について前のボイシングで最も近い音までの距離を足す。
 */
export function voicingCost(prev: readonly number[], next: readonly number[]): number {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length > MAX_VOICES || next.length > MAX_VOICES) {
    throw new RangeError('ボイシングは128音以内で指定してください。');
  }
  if (!prev.every(Number.isFinite) || !next.every(Number.isFinite)) {
    throw new RangeError('ボイシングの音は数値で指定してください。');
  }
  if (prev.length === 0) return 0;
  const a = [...prev].sort((x, y) => x - y);
  const b = [...next].sort((x, y) => x - y);
  if (a.length === b.length) return b.reduce((sum, m, i) => sum + Math.abs(m - (a[i] as number)), 0);
  return b.reduce((sum, m) => sum + Math.min(...a.map((p) => Math.abs(m - p))), 0);
}

/**
 * `prev` から見た 2 候補の優劣。負なら a が良い、正なら b が良い、0 は同じ並び。
 * 規則: 総移動量が小さい → 最高音が低い → 配列の辞書順 (低い順に比べて先に小さい方)。
 */
export function compareVoicings(prev: readonly number[], a: readonly number[], b: readonly number[]): number {
  const cost = voicingCost(prev, a) - voicingCost(prev, b);
  if (cost !== 0) return cost;
  const top = (a[a.length - 1] ?? -1) - (b[b.length - 1] ?? -1);
  if (top !== 0) return top;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * 前のボイシング `prev` からの総移動量が最小のボイシングを返す。
 * `prev` が空なら voiceChord と同じ。候補は close の各転回形 (open 指定ならその開離形) を
 * MIDI 0〜127 に収まるすべてのオクターブに置いたもの (開離形は広がるので探索範囲を狭めない)。
 * 分数コードはベース音が最低音の形だけを候補にする。
 */
export function voiceLead(prev: readonly number[], symbol: string, opts: VoicingOptions | null = {}): number[] {
  opts ??= {};
  if (!Array.isArray(prev) || prev.length > MAX_VOICES) throw new RangeError('ボイシングは128音以内で指定してください。');
  if (!prev.every(Number.isFinite)) throw new RangeError('ボイシングの音は数値で指定してください。');
  if (prev.length === 0) return voiceChord(symbol, opts);
  const style = opts.style ?? 'close';
  const order = orderedPitchClasses(symbol);
  const rotations = isSlashChord(symbol)
    ? [order]
    : order.map((_, i) => [...order.slice(i), ...order.slice(0, i)]);
  let best: number[] | null = null;
  for (const rotation of rotations) {
    for (let lowest = atOrAbove(rotation[0] as number, 0); lowest <= 127; lowest += 12) {
      const cand = shape(rotation, lowest, style);
      if ((cand[cand.length - 1] as number) > 127) continue;
      if (best === null || compareVoicings(prev, cand, best) < 0) best = cand;
    }
  }
  return best ?? voiceChord(symbol, { style, register: Math.min(...prev) });
}
