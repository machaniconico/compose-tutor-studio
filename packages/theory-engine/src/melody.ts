/**
 * メロディ解析とヘルパー
 *
 * - analyzeMelody: docs/06 section 6 の melody analysis 形状で返す
 *     チェック項目:
 *       * 強拍のコードトーン着地
 *       * スケール外音の分類 (passing / approach / tension。誤りとは断定しない)
 *       * 跳躍の多さ (歌いやすさ)
 *       * 反復と変化のバランス
 *       * 解決されない緊張音
 * - chordToneTargets: コードの構成ピッチクラス
 * - generateScaleMelody: seed指定の決定論的スケール内メロディ生成
 * - repeatMotif: モチーフをコード列上に反復/移調
 */

import type {
  ChordEventInput,
  GeneratedNote,
  MelodyAnalysis,
  MelodyFinding,
  MelodyNoteInput,
  ScaleName,
} from './types';
import { parseChord } from './chords';
import { getScalePitchClasses } from './scales';
import { pitchClassOf, pitchClassToSharpName } from './pitch';
import { createPrng, pick, type RandomFn } from './prng';

/** 強拍判定: 小節内の拍位置が 0 (1拍目) または半分 (例 4/4の3拍目)。 */
function isStrongBeat(startBeat: number, beatsPerBar: number): boolean {
  const posInBar = ((startBeat % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const eps = 1e-6;
  if (Math.abs(posInBar) < eps) return true;
  if (Math.abs(posInBar - beatsPerBar / 2) < eps) return true;
  return false;
}

/** ある拍位置に鳴っているコードを返す。 */
function chordAtBeat(chords: ChordEventInput[], beat: number): ChordEventInput | undefined {
  return chords.find(
    (c) => beat >= c.startBeat - 1e-6 && beat < c.startBeat + c.durationBeats - 1e-6,
  );
}

/**
 * コードの構成音ピッチクラスを返す (chordToneTargets)。
 */
export function chordToneTargets(symbol: string, key?: string): number[] {
  const parsed = parseChord(symbol, key);
  return [...parsed.pitchClasses];
}

export type AnalyzeMelodyInput = {
  key: string;
  scale: ScaleName;
  chords: ChordEventInput[];
  notes: MelodyNoteInput[];
  /** 1小節の拍数。省略時は 4。 */
  beatsPerBar?: number;
};

/** 単一ノートの非コードトーン分類。 */
type NonChordToneClass = 'passing_tone' | 'approach_tone' | 'tension';

/**
 * 非コードトーンを分類する。
 * - 前後がコードトーンで、間を順次 (1-2半音) で繋ぐ -> passing_tone
 * - 直後の音へ半音/全音で接近する -> approach_tone
 * - それ以外 -> tension
 */
function classifyNonChordTone(
  prevPc: number | undefined,
  pc: number,
  nextPc: number | undefined,
): NonChordToneClass {
  if (prevPc !== undefined && nextPc !== undefined) {
    const d1 = Math.min((((pc - prevPc) % 12) + 12) % 12, (((prevPc - pc) % 12) + 12) % 12);
    const d2 = Math.min((((nextPc - pc) % 12) + 12) % 12, (((pc - nextPc) % 12) + 12) % 12);
    if (d1 <= 2 && d2 <= 2 && d1 > 0 && d2 > 0) {
      return 'passing_tone';
    }
  }
  if (nextPc !== undefined) {
    const d2 = Math.min((((nextPc - pc) % 12) + 12) % 12, (((pc - nextPc) % 12) + 12) % 12);
    if (d2 === 1 || d2 === 2) {
      return 'approach_tone';
    }
  }
  return 'tension';
}

/**
 * メロディを解析する。docs/06 section 6 melody analysis の形状で返す。
 */
export function analyzeMelody(input: AnalyzeMelodyInput): MelodyAnalysis {
  const { key, scale, chords, notes } = input;
  const beatsPerBar = input.beatsPerBar ?? 4;
  const scalePcs = getScalePitchClasses(key, scale);

  const findings: MelodyFinding[] = [];
  if (notes.length === 0) {
    return {
      score: 0,
      findings: [
        { type: 'variation', severity: 'info', message: 'ノートがありません。メロディを入力してください。' },
      ],
    };
  }

  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);

  let strongBeatTotal = 0;
  let strongBeatChordTone = 0;
  let leapCount = 0;
  const intervals: number[] = [];
  const pcs = sorted.map((n) => pitchClassOf(n.pitch));

  for (let i = 0; i < sorted.length; i += 1) {
    const note = sorted[i];
    if (note === undefined) continue;
    const pc = pcs[i] ?? pitchClassOf(note.pitch);
    const chord = chordAtBeat(chords, note.startBeat);
    const chordTones = chord ? chordToneTargets(chord.symbol, key) : [];
    const isChordTone = chordTones.includes(pc);
    const inScale = scalePcs.includes(pc);
    const strong = isStrongBeat(note.startBeat, beatsPerBar);

    if (strong) {
      strongBeatTotal += 1;
      if (isChordTone) {
        strongBeatChordTone += 1;
        const interval = chord ? chordIntervalLabel(chord.symbol, pc, key) : 'コードトーン';
        findings.push({
          type: 'chord_tone',
          severity: 'info',
          message: `${beatLabel(note.startBeat, beatsPerBar)}の${pitchClassToSharpName(pc)}は${chord?.symbol ?? ''}の${interval}で安定します。`,
        });
      } else if (chord) {
        findings.push({
          type: 'tension',
          severity: 'warn',
          message: `${beatLabel(note.startBeat, beatsPerBar)}の${pitchClassToSharpName(pc)}は${chord.symbol}のコードトーンではありません。強拍はコードトーンに着地すると安定します。`,
        });
      }
    }

    // 非コードトーンの分類
    if (!isChordTone) {
      const prevPc = i > 0 ? pcs[i - 1] : undefined;
      const nextPc = i < pcs.length - 1 ? pcs[i + 1] : undefined;
      const cls = classifyNonChordTone(prevPc, pc, nextPc);
      if (cls === 'passing_tone') {
        findings.push({
          type: 'passing_tone',
          severity: 'info',
          message: `${pitchClassToSharpName(pc)}は前後の音をつなぐ経過音(パッシングトーン)です。スムーズな動きになります。`,
        });
      } else if (cls === 'approach_tone') {
        findings.push({
          type: 'approach_tone',
          severity: 'info',
          message: `${pitchClassToSharpName(pc)}は次の音へ向かうアプローチノートです。次の着地を引き立てます。`,
        });
      } else if (!inScale) {
        findings.push({
          type: 'tension',
          severity: 'info',
          message: `${pitchClassToSharpName(pc)}はスケール外のテンションです。緊張感の演出に使えます。次でスケール内へ解決すると効果的です。`,
        });
      }
    }

    // 跳躍 (前の音との音程)
    if (i > 0) {
      const prev = sorted[i - 1];
      if (prev !== undefined) {
        const leap = Math.abs(note.pitch - prev.pitch);
        intervals.push(leap);
        if (leap > 7) {
          leapCount += 1;
        }
      }
    }
  }

  // 跳躍が多い -> 歌いやすさ
  if (intervals.length > 0 && leapCount / intervals.length > 0.4) {
    findings.push({
      type: 'leap',
      severity: 'warn',
      message: '大きな跳躍が多めです。順次進行(隣り合う音)を増やすと歌いやすくなります。',
    });
  } else if (intervals.length > 0) {
    findings.push({
      type: 'leap',
      severity: 'info',
      message: '跳躍と順次進行のバランスが取れていて歌いやすいメロディです。',
    });
  }

  // 反復/変化のバランス
  const uniqueDurations = new Set(sorted.map((n) => round2(n.durationBeats)));
  const uniquePitches = new Set(pcs);
  if (uniquePitches.size === 1 && sorted.length > 2) {
    findings.push({
      type: 'variation',
      severity: 'warn',
      message: '同じ音が続いています。少し音程を動かすと表情が出ます。',
    });
  } else if (uniqueDurations.size === 1 && sorted.length > 3) {
    findings.push({
      type: 'repetition',
      severity: 'info',
      message: 'リズムが統一されていて覚えやすいモチーフになっています。',
    });
  } else {
    findings.push({
      type: 'variation',
      severity: 'info',
      message: '反復と変化のバランスが取れています。',
    });
  }

  // 解決されないテンション: 最後の音がスケール外のまま終わる
  const lastNote = sorted[sorted.length - 1];
  let unresolved = false;
  if (lastNote !== undefined) {
    const lastPc = pitchClassOf(lastNote.pitch);
    if (!scalePcs.includes(lastPc)) {
      unresolved = true;
      findings.push({
        type: 'unresolved_tension',
        severity: 'warn',
        message:
          '最後の音がスケール外のテンションのままです。スケール内の音(特にトニック)へ解決すると締まります。',
      });
    }
  }

  // スコア算出
  const chordToneRatio = strongBeatTotal > 0 ? strongBeatChordTone / strongBeatTotal : 0.5;
  const leapRatio = intervals.length > 0 ? leapCount / intervals.length : 0;
  const unresolvedPenalty = unresolved ? 0.1 : 0;
  let score = 0.5 + chordToneRatio * 0.4 - leapRatio * 0.15 - unresolvedPenalty;
  score = Math.max(0, Math.min(1, round2(score)));

  return { score, findings };
}

/** コード内でのピッチクラスの度数ラベルを返す。 */
function chordIntervalLabel(symbol: string, pc: number, key?: string): string {
  const parsed = parseChord(symbol, key);
  const interval = (((pc - parsed.rootPc) % 12) + 12) % 12;
  switch (interval) {
    case 0:
      return 'ルート';
    case 3:
      return '短3度';
    case 4:
      return '3度';
    case 7:
      return '5度';
    case 10:
      return '短7度';
    case 11:
      return '長7度';
    case 9:
      return '6度';
    case 2:
      return '9度';
    default:
      return 'コードトーン';
  }
}

/** 拍位置の人間向けラベル ("1拍目" など)。 */
function beatLabel(startBeat: number, beatsPerBar: number): string {
  const posInBar = ((startBeat % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const beatNumber = Math.floor(posInBar) + 1;
  return `${beatNumber}拍目`;
}

/** 小数2桁丸め。 */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export type GenerateScaleMelodyInput = {
  key: string;
  scale: ScaleName;
  chords: ChordEventInput[];
  /** 生成するノート数 (拍数ベース)。省略時はコード総尺の拍数。 */
  noteCount?: number;
  /** PRNGのシード (必須: Math.randomは使わない)。 */
  seed: number;
  /** 中心オクターブのC (MIDI)。省略時 60 (C4)。 */
  centerC?: number;
  beatsPerBar?: number;
};

/**
 * スケール内のメロディを決定論的に生成する。
 * 強拍ではコードトーンへ寄せ、それ以外はスケール内音から選ぶ。
 */
export function generateScaleMelody(input: GenerateScaleMelodyInput): GeneratedNote[] {
  const { key, scale, chords, seed } = input;
  const centerC = input.centerC ?? 60;
  const beatsPerBar = input.beatsPerBar ?? 4;
  const rng: RandomFn = createPrng(seed);
  const scalePcs = getScalePitchClasses(key, scale);

  const totalBeats =
    chords.length > 0 ? Math.max(...chords.map((c) => c.startBeat + c.durationBeats)) : 0;
  const count = input.noteCount ?? Math.max(1, Math.round(totalBeats));

  const notes: GeneratedNote[] = [];
  let prevPitch = centerC;

  for (let i = 0; i < count; i += 1) {
    const startBeat = i; // 1拍ずつ
    const chord = chordAtBeat(chords, startBeat);
    const strong = isStrongBeat(startBeat, beatsPerBar);

    let pc: number;
    let reason: string;
    if (strong && chord) {
      const tones = chordToneTargets(chord.symbol, key);
      pc = pick(rng, tones);
      reason = `強拍なので${chord.symbol}のコードトーン${pitchClassToSharpName(pc)}を置き、安定させます。`;
    } else {
      pc = pick(rng, scalePcs);
      reason = `スケール内の${pitchClassToSharpName(pc)}で滑らかに動きます。`;
    }

    const pitch = nearestScalePitch(pc, prevPitch);
    prevPitch = pitch;
    notes.push({
      pitch,
      startBeat,
      durationBeats: 1,
      velocity: strong ? 96 : 84,
      reason,
    });
  }
  return notes;
}

/** ピッチクラスを参照ピッチに最も近い実ピッチへ。 */
function nearestScalePitch(pc: number, near: number): number {
  const normalized = (((pc % 12) + 12) % 12);
  const base = near - (((near % 12) + 12) % 12) + normalized;
  let candidate = base;
  while (candidate - near > 6) candidate -= 12;
  while (near - candidate > 6) candidate += 12;
  return candidate;
}

export type Motif = {
  /** 相対的な音程列 (起点からの半音オフセット)。 */
  intervals: number[];
  /** 各音の長さ (拍)。intervals と同数。 */
  durations: number[];
};

export type RepeatMotifInput = {
  motif: Motif;
  chords: ChordEventInput[];
  key: string;
  /** モチーフ移調の基準ピッチ (MIDI)。各コードのルートをこの近辺へ寄せる。省略時60。 */
  baseC?: number;
  velocity?: number;
};

/**
 * モチーフをコード列上に反復/移調する。
 * 各コードでモチーフを、そのコードのルート (近いオクターブ) を起点に配置する。
 */
export function repeatMotif(input: RepeatMotifInput): GeneratedNote[] {
  const { motif, chords, key } = input;
  const baseC = input.baseC ?? 60;
  const velocity = input.velocity ?? 90;
  if (motif.intervals.length !== motif.durations.length) {
    throw new Error('motif.intervals と motif.durations の長さが一致しません');
  }

  const notes: GeneratedNote[] = [];
  for (const ev of chords) {
    const parsed = parseChord(ev.symbol, key);
    const rootPitch = nearestScalePitch(parsed.rootPc, baseC);
    let beatCursor = ev.startBeat;
    for (let i = 0; i < motif.intervals.length; i += 1) {
      const interval = motif.intervals[i] ?? 0;
      const dur = motif.durations[i] ?? 1;
      if (beatCursor >= ev.startBeat + ev.durationBeats - 1e-6) break;
      notes.push({
        pitch: rootPitch + interval,
        startBeat: beatCursor,
        durationBeats: dur,
        velocity,
        reason: `モチーフを${ev.symbol}のルート${parsed.root}に合わせて移調し、統一感を出します。`,
      });
      beatCursor += dur;
    }
  }
  return notes;
}
