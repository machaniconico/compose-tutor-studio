import { beatTick, PPQ } from './ticks';

/** 書き出しの範囲。WAV と MIDI が同じ規則で使う。tick は PPQ 480、半開区間 [startTick, endTick)。 */
export type ExportRange = Readonly<{
  startTick: number;
  endTick: number;
  startBeat: number;
  endBeat: number;
}>;

export type ExportRangeResult =
  | Readonly<{ ok: true; range: ExportRange }>
  | Readonly<{ ok: false; reason: 'unset' | 'empty'; message: string }>;

export const EXPORT_RANGE_UNSET_MESSAGE =
  'ループ範囲がまだ決まっていません。ルーラーをドラッグしてループ範囲を決めると、その部分だけを書き出せます。';
export const EXPORT_RANGE_EMPTY_MESSAGE =
  'ループ範囲に長さがないため書き出せません。ループの終わりを始まりより後ろにしてください。';

/**
 * ループ範囲 [loopStart, loopEnd) を、曲の長さで切り詰めた整数 tick の範囲にする。
 * ループが無効(未設定)、数値が不正、または切り詰め後に 1 tick もない場合は範囲なし。
 */
export function resolveExportRange(
  loop: Readonly<{ enabled: boolean; startBeat: number; endBeat: number }>,
  lengthBeats: number,
): ExportRangeResult {
  if (!loop.enabled) {
    return { ok: false, reason: 'unset', message: EXPORT_RANGE_UNSET_MESSAGE };
  }
  if (
    !Number.isFinite(loop.startBeat)
    || !Number.isFinite(loop.endBeat)
    || !Number.isFinite(lengthBeats)
  ) {
    return { ok: false, reason: 'empty', message: EXPORT_RANGE_EMPTY_MESSAGE };
  }
  const startTick = Math.max(0, beatTick(loop.startBeat));
  const endTick = Math.min(beatTick(lengthBeats), beatTick(loop.endBeat));
  if (endTick <= startTick) {
    return { ok: false, reason: 'empty', message: EXPORT_RANGE_EMPTY_MESSAGE };
  }
  return {
    ok: true,
    range: { startTick, endTick, startBeat: startTick / PPQ, endBeat: endTick / PPQ },
  };
}

/**
 * 書き出しに含める onset か。WAV と MIDI が同じ整数 tick 規則で決める:
 * `round(onsetBeat × 480)` が `[startTick, endTick)` に入る時だけ含める。
 */
export function exportRangeIncludesOnset(
  onsetBeat: number,
  range: Pick<ExportRange, 'startTick' | 'endTick'>,
): boolean {
  const tick = beatTick(onsetBeat);
  return tick >= range.startTick && tick < range.endTick;
}

/** 範囲の終端より前(開始より前も含む)に始まる onset か。開始前から鳴り続ける音(WAV の pre-roll)用。 */
export function exportRangeOnsetBeforeEnd(
  onsetBeat: number,
  range: Pick<ExportRange, 'endTick'>,
): boolean {
  return beatTick(onsetBeat) < range.endTick;
}
