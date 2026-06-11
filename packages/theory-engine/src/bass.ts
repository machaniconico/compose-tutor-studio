/**
 * ベースライン生成
 *
 * モード:
 *   - rootOnly:     各コードのルートを拍頭に置く
 *   - rootFifth:    1拍目ルート / 後半5度 (小節内)
 *   - walkingSimple: ルート -> コードトーン -> 次コードルートへ向かう経過音
 *   - octavePulse:  ルートとオクターブ上を交互に刻む
 *
 * 出力は理由付きノート (なぜその音を置いたかを日本語で説明)。
 * Walking モードは次コードのルートへ順次/半音で接近する。
 */

import type { BassMode, ChordEventInput, GeneratedNote, ScaleName } from './types';
import { parseChord } from './chords';
import { getScalePitchClasses } from './scales';
import { pitchClassToSharpName } from './pitch';

/** ベースの基準オクターブ下限 (MIDI 36 = C2)。 */
const BASS_FLOOR = 36;

/** ベースのデフォルトベロシティ。 */
const DEFAULT_VELOCITY = 96;
const WEAK_VELOCITY = 80;

export type BassOptions = {
  mode: BassMode;
  key: string;
  scale: ScaleName;
  beatsPerBar: number;
};

/**
 * ピッチクラスをベース音域 (MIDI 36-47, C2-B2) に正規化して配置する。
 */
function rootInBassRange(pc: number): number {
  const normalized = (((pc % 12) + 12) % 12);
  return BASS_FLOOR + normalized;
}

/**
 * ピッチクラスを、参照ピッチに最も近い同ピッチクラス音へ配置する。
 */
function nearestPitch(pc: number, near: number): number {
  const base = rootInBassRange(pc); // 36-47 の代表音
  let candidate = base;
  while (candidate - near > 6) candidate -= 12;
  while (near - candidate > 6) candidate += 12;
  return candidate;
}

/** rootOnly: 各コード開始にルートを置く。 */
function generateRootOnly(chords: ChordEventInput[], key: string): GeneratedNote[] {
  const notes: GeneratedNote[] = [];
  for (const ev of chords) {
    const parsed = parseChord(ev.symbol, key);
    notes.push({
      pitch: rootInBassRange(parsed.rootPc),
      startBeat: ev.startBeat,
      durationBeats: ev.durationBeats,
      velocity: DEFAULT_VELOCITY,
      reason: `${parsed.root}はコード${ev.symbol}のルート音なので安定します。`,
    });
  }
  return notes;
}

/** rootFifth: 各コードの前半にルート、後半に5度。 */
function generateRootFifth(chords: ChordEventInput[], key: string): GeneratedNote[] {
  const notes: GeneratedNote[] = [];
  for (const ev of chords) {
    const parsed = parseChord(ev.symbol, key);
    const rootPitch = rootInBassRange(parsed.rootPc);
    const half = ev.durationBeats / 2;
    notes.push({
      pitch: rootPitch,
      startBeat: ev.startBeat,
      durationBeats: half,
      velocity: DEFAULT_VELOCITY,
      reason: `${parsed.root}はルート音で、拍頭の重心を作ります。`,
    });
    const fifthPc = (parsed.rootPc + 7) % 12;
    notes.push({
      pitch: nearestPitch(fifthPc, rootPitch),
      startBeat: ev.startBeat + half,
      durationBeats: ev.durationBeats - half,
      velocity: WEAK_VELOCITY,
      reason: `${pitchClassToSharpName(fifthPc)}は5度で、ルートと相性が良く厚みを足します。`,
    });
  }
  return notes;
}

/** octavePulse: ルートとオクターブ上を拍ごとに交互に刻む。 */
function generateOctavePulse(chords: ChordEventInput[], key: string): GeneratedNote[] {
  const notes: GeneratedNote[] = [];
  for (const ev of chords) {
    const parsed = parseChord(ev.symbol, key);
    const rootPitch = rootInBassRange(parsed.rootPc);
    const steps = Math.max(1, Math.round(ev.durationBeats));
    const stepLen = ev.durationBeats / steps;
    for (let i = 0; i < steps; i += 1) {
      const isOctave = i % 2 === 1;
      notes.push({
        pitch: isOctave ? rootPitch + 12 : rootPitch,
        startBeat: ev.startBeat + i * stepLen,
        durationBeats: stepLen,
        velocity: isOctave ? WEAK_VELOCITY : DEFAULT_VELOCITY,
        reason: isOctave
          ? `${parsed.root}のオクターブ上で、躍動感のある反復を作ります。`
          : `${parsed.root}のルートで拍の重心を刻みます。`,
      });
    }
  }
  return notes;
}

/**
 * walkingSimple: 1コードを複数拍に割り、ルート -> コードトーン -> 次コードルートへ
 * 順次/半音で接近する経過音を置く。
 */
function generateWalking(
  chords: ChordEventInput[],
  key: string,
  scale: ScaleName,
): GeneratedNote[] {
  const notes: GeneratedNote[] = [];
  const scalePcs = getScalePitchClasses(key, scale);

  for (let ci = 0; ci < chords.length; ci += 1) {
    const ev = chords[ci];
    if (ev === undefined) continue;
    const parsed = parseChord(ev.symbol, key);
    const rootPitch = rootInBassRange(parsed.rootPc);
    const steps = Math.max(1, Math.round(ev.durationBeats));
    const stepLen = ev.durationBeats / steps;

    const nextEv = chords[ci + 1];
    const nextParsed = nextEv ? parseChord(nextEv.symbol, key) : parsed;
    const nextRootPitch = rootInBassRange(nextParsed.rootPc);

    const chordTonePitches = parsed.pitchClasses
      .map((pc) => nearestPitch(pc, rootPitch))
      .filter((p) => p !== rootPitch);

    for (let i = 0; i < steps; i += 1) {
      const startBeat = ev.startBeat + i * stepLen;
      const isFirst = i === 0;
      const isLast = i === steps - 1;

      if (isFirst) {
        notes.push({
          pitch: rootPitch,
          startBeat,
          durationBeats: stepLen,
          velocity: DEFAULT_VELOCITY,
          reason: `${parsed.root}はコード${ev.symbol}のルートで、ウォーキングの起点として安定します。`,
        });
        continue;
      }

      if (isLast && nextEv) {
        // 次コードルートへ半音で接近する経過音 (リーディングトーン)
        const approach = chooseApproach(nextRootPitch, scalePcs);
        const isHalf = Math.abs(approach - nextRootPitch) === 1;
        const direction = approach < nextRootPitch ? '上行' : '下行';
        notes.push({
          pitch: approach,
          startBeat,
          durationBeats: stepLen,
          velocity: WEAK_VELOCITY,
          reason: isHalf
            ? `半音${direction}で次のコード${nextEv.symbol}のルートへ強く進む経過音です。`
            : `${direction}で次のコード${nextEv.symbol}へ滑らかにつなぐ経過音です。`,
        });
        continue;
      }

      const tone =
        chordTonePitches.length > 0
          ? chordTonePitches[(i - 1) % chordTonePitches.length] ?? rootPitch
          : rootPitch;
      notes.push({
        pitch: tone,
        startBeat,
        durationBeats: stepLen,
        velocity: WEAK_VELOCITY,
        reason: `${pitchClassToSharpName((((tone % 12) + 12) % 12))}はコードトーンで、響きを保ちながら動きます。`,
      });
    }
  }
  return notes;
}

/**
 * 次コードルートへ半音で接近する音を選ぶ (半音下からの上行)。
 * scalePcs は将来の全音アプローチ判定用に受け取るが、基本はリーディングトーンを優先する。
 */
function chooseApproach(nextRoot: number, _scalePcs: number[]): number {
  void _scalePcs;
  return nextRoot - 1;
}

/**
 * ベースラインを生成する。
 */
export function generateBassLine(
  chords: ChordEventInput[],
  options: BassOptions,
): GeneratedNote[] {
  const { mode, key, scale } = options;
  switch (mode) {
    case 'rootOnly':
      return generateRootOnly(chords, key);
    case 'rootFifth':
      return generateRootFifth(chords, key);
    case 'octavePulse':
      return generateOctavePulse(chords, key);
    case 'walkingSimple':
      return generateWalking(chords, key, scale);
    default:
      throw new Error(`未対応のベースモードです: ${String(mode)}`);
  }
}
