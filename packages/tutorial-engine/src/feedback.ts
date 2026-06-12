// Feedback generator — explains ProjectPredicate results in beginner-friendly Japanese.
// Pure functions only; no side effects.

import type { Project, ScaleName } from '@cts/project-model';
import {
  analyzeBassRootOnDownbeat,
  analyzeDrumPattern,
  analyzeMelodyChordToneOnStrongBeat,
  analyzeNotesWithinScale,
} from './checker.js';
import { evaluateProjectPredicate } from './goals.js';
import type { DrumPatternType, ProjectPredicate } from './types.js';

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * Three-level grade for a predicate check result:
 *   success    — fully satisfied
 *   close      — partial progress (e.g. some chords placed, some lanes active,
 *                BPM within ±20% of target range, etc.)
 *   needs_work — no meaningful progress yet (zero chords, no drum steps, BPM
 *                far outside range, track missing, etc.)
 */
export type PredicateGrade = 'success' | 'close' | 'needs_work';

export interface PredicateFeedback {
  /** Whether the predicate is fully satisfied at this moment. */
  satisfied: boolean;
  /** Three-stage grade: success / close / needs_work. */
  grade: PredicateGrade;
  /**
   * Japanese: what happened.
   * success  → 称賛文
   * close    → 「惜しい」状況の説明
   * needs_work → 「なぜ未達か」の説明
   * Always a complete sentence.
   */
  reason: string;
  /**
   * Japanese: concrete next action.
   * Empty string when satisfied (no action needed).
   */
  nextAction: string;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Explain whether a ProjectPredicate is satisfied for the given project.
 * Returns beginner-friendly Japanese text for the grade, reason and next action.
 */
export function explainPredicate(
  predicate: ProjectPredicate,
  project: Project,
): PredicateFeedback {
  // exportCompleted cannot be evaluated from Project state alone.
  // We treat it as needs_work until an export event is observed.
  if (predicate.type === 'exportCompleted') {
    return explainExportCompleted(predicate.format);
  }

  const satisfied = evaluateProjectPredicate(predicate, project);

  switch (predicate.type) {
    case 'chordCountAtLeast':
      return explainChordCountAtLeast(predicate.value, project.chordTrack.length, satisfied);

    case 'progressionEquals':
      return explainProgressionEquals(predicate.symbols, project, satisfied);

    case 'drumLaneActive':
      return explainDrumLaneActive(predicate.lane, predicate.minSteps, project, satisfied);

    case 'drumPatternHas':
      return explainDrumPatternHas(predicate.lanes, project, satisfied);

    case 'noteCountAtLeast':
      return explainNoteCountAtLeast(predicate.trackName, predicate.value, project, satisfied);

    case 'hasSection':
      return explainHasSection(predicate.sectionType, satisfied);

    case 'bpmInRange':
      return explainBpmInRange(predicate.min, predicate.max, project.bpm, satisfied);

    case 'trackVolumeInRange':
      return explainTrackVolumeInRange(
        predicate.trackName,
        predicate.min,
        predicate.max,
        project,
        satisfied,
      );

    case 'hasBassRootOnDownbeat':
      return explainBassRootOnDownbeat(predicate.trackName, predicate.minRatio, project, satisfied);

    case 'hasMelodyChordToneOnStrongBeat':
      return explainMelodyChordToneOnStrongBeat(
        predicate.trackName,
        predicate.minRatio,
        project,
        satisfied,
      );

    case 'hasNotesWithinScale':
      return explainNotesWithinScale(predicate.trackName, predicate.minRatio, project, satisfied);

    case 'hasDrumPattern':
      return explainDrumPattern(predicate.patternType, project, satisfied);
  }
}

// ─── Per-predicate helpers ────────────────────────────────────────────────────

function explainChordCountAtLeast(
  required: number,
  current: number,
  satisfied: boolean,
): PredicateFeedback {
  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `コードが ${current} 個配置されました。よくできました！`,
      nextAction: '',
    };
  }
  // close: at least 1 chord placed but below required
  // needs_work: no chords at all
  const grade: PredicateGrade = current > 0 ? 'close' : 'needs_work';
  const remaining = required - current;
  return {
    satisfied: false,
    grade,
    reason: `コードが ${current} 個しかありません。あと ${remaining} 個必要です。`,
    nextAction: `コードトラックにコードをあと ${remaining} 個追加してください。`,
  };
}

function explainProgressionEquals(
  symbols: string[],
  project: Project,
  satisfied: boolean,
): PredicateFeedback {
  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `コード進行「${symbols.join(' → ')}」が正しく入力されました。すばらしい！`,
      nextAction: '',
    };
  }
  const current = project.chordTrack
    .slice()
    .sort((a, b) => a.startBeat - b.startBeat)
    .map((c) => c.symbol);
  const currentStr = current.length > 0 ? current.join(' → ') : '（なし）';

  // close: same length and at least half the symbols match in order
  // needs_work: empty or fewer than half match
  let matchCount = 0;
  if (current.length === symbols.length) {
    for (let i = 0; i < symbols.length; i++) {
      if (current[i] === symbols[i]) matchCount++;
    }
  }
  const grade: PredicateGrade =
    current.length > 0 && matchCount >= Math.ceil(symbols.length / 2) ? 'close' : 'needs_work';

  return {
    satisfied: false,
    grade,
    reason: `現在のコード進行は「${currentStr}」です。目標の「${symbols.join(' → ')}」と一致していません。`,
    nextAction: `コードトラックのコードを「${symbols.join(' → ')}」の順番に並べ直してください。`,
  };
}

/** Count unique active step indices for a given lane across all drum clips. */
function countDrumLaneSteps(lane: string, project: Project): number {
  for (const track of project.tracks) {
    if (track.type !== 'drum') continue;
    for (const clip of track.clips) {
      if (!clip.drumEvents) continue;
      const count = new Set(
        clip.drumEvents.filter((e) => e.lane === lane).map((e) => e.stepIndex),
      ).size;
      if (count > 0) return count;
    }
  }
  return 0;
}

function explainDrumLaneActive(
  lane: string,
  minSteps: number,
  project: Project,
  satisfied: boolean,
): PredicateFeedback {
  const laneLabel = drumLaneLabel(lane);
  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `${laneLabel}に ${minSteps} ステップ以上のパターンが入力されました。いいリズムです！`,
      nextAction: '',
    };
  }
  const currentSteps = countDrumLaneSteps(lane, project);
  // close: at least 1 step placed but below required
  // needs_work: zero steps
  const grade: PredicateGrade = currentSteps > 0 ? 'close' : 'needs_work';
  return {
    satisfied: false,
    grade,
    reason: `${laneLabel}のステップが ${currentSteps} 個しかありません。あと ${minSteps - currentSteps} 個必要です。`,
    nextAction: `ドラムグリッドで${laneLabel}の格子をクリックして、${minSteps} 個以上のステップをオンにしてください。`,
  };
}

function explainDrumPatternHas(
  lanes: Array<{ lane: string; minSteps: number }>,
  project: Project,
  satisfied: boolean,
): PredicateFeedback {
  if (satisfied) {
    const parts = lanes.map((r) => `${drumLaneLabel(r.lane)}×${r.minSteps}`);
    return {
      satisfied: true,
      grade: 'success',
      reason: `ドラムパターン（${parts.join('、')}）が完成しました。ノリのあるビートですね！`,
      nextAction: '',
    };
  }

  // Count how many lane requirements are met
  let metCount = 0;
  let firstUnmet: { lane: string; minSteps: number; current: number } | null = null;

  for (const req of lanes) {
    const current = countDrumLaneSteps(req.lane, project);
    if (current >= req.minSteps) {
      metCount++;
    } else if (firstUnmet === null) {
      firstUnmet = { lane: req.lane, minSteps: req.minSteps, current };
    }
  }

  // close: at least one lane requirement met but not all
  // needs_work: no lane requirements met at all
  const grade: PredicateGrade = metCount > 0 ? 'close' : 'needs_work';

  if (firstUnmet) {
    const laneLabel = drumLaneLabel(firstUnmet.lane);
    const remaining = firstUnmet.minSteps - firstUnmet.current;
    return {
      satisfied: false,
      grade,
      reason: `${laneLabel}のステップが ${firstUnmet.current} 個しかありません。あと ${remaining} 個必要です。`,
      nextAction: `ドラムグリッドで${laneLabel}の格子を ${firstUnmet.minSteps} 個以上オンにしてください。`,
    };
  }
  return {
    satisfied: false,
    grade,
    reason: 'ドラムパターンがまだ完成していません。',
    nextAction: 'ドラムグリッドで必要なすべてのレーンにステップを入力してください。',
  };
}

function explainNoteCountAtLeast(
  trackName: string,
  required: number,
  project: Project,
  satisfied: boolean,
): PredicateFeedback {
  const current = (() => {
    for (const track of project.tracks) {
      if (track.name !== trackName) continue;
      return track.clips.reduce((sum, clip) => sum + (clip.notes?.length ?? 0), 0);
    }
    return 0;
  })();

  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `「${trackName}」トラックに ${current} 個のノートが入力されました。メロディになってきましたね！`,
      nextAction: '',
    };
  }
  // close: some notes exist but below required
  // needs_work: zero notes
  const grade: PredicateGrade = current > 0 ? 'close' : 'needs_work';
  const remaining = required - current;
  return {
    satisfied: false,
    grade,
    reason: `「${trackName}」トラックのノートが ${current} 個しかありません。あと ${remaining} 個必要です。`,
    nextAction: `ピアノロールを開いて「${trackName}」トラックにノートをあと ${remaining} 個以上追加してください。`,
  };
}

function explainHasSection(sectionType: string, satisfied: boolean): PredicateFeedback {
  const label = sectionLabel(sectionType);
  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `${label}セクションが追加されました。曲の構成が整ってきました！`,
      nextAction: '',
    };
  }
  // hasSection is binary — either the section exists or it doesn't.
  // There's no partial state, so unsatisfied is always needs_work.
  return {
    satisfied: false,
    grade: 'needs_work',
    reason: `${label}セクションがまだありません。`,
    nextAction: `アレンジャーで「${label}」セクションを追加してください。`,
  };
}

function explainBpmInRange(
  min: number,
  max: number,
  current: number,
  satisfied: boolean,
): PredicateFeedback {
  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `テンポが ${current} BPM で、目標の範囲内（${min}〜${max} BPM）に入っています。`,
      nextAction: '',
    };
  }

  // close: BPM is within ±20% of the range boundary it overshot
  // e.g. range 100-140, current=90 → lower boundary 100, 90 >= 100*0.8=80 → close
  const rangeSpan = max - min;
  const tolerance = Math.max(rangeSpan * 0.2, 10);
  const isClose = current >= min - tolerance && current <= max + tolerance;
  const grade: PredicateGrade = isClose ? 'close' : 'needs_work';

  const direction = current < min ? '遅すぎます' : '速すぎます';
  const target = current < min ? `${min} BPM 以上` : `${max} BPM 以下`;
  return {
    satisfied: false,
    grade,
    reason: `現在のテンポは ${current} BPM で${direction}。目標は ${min}〜${max} BPM です。`,
    nextAction: `トランスポートバーのテンポを ${target} に調整してください。`,
  };
}

function explainTrackVolumeInRange(
  trackName: string,
  min: number,
  max: number,
  project: Project,
  satisfied: boolean,
): PredicateFeedback {
  const track = project.tracks.find((t) => t.name === trackName);
  const current = track ? track.volume : null;

  if (satisfied) {
    const volPct = current !== null ? Math.round(current * 100) : '?';
    return {
      satisfied: true,
      grade: 'success',
      reason: `「${trackName}」のボリュームが目標範囲（${Math.round(min * 100)}〜${Math.round(max * 100)}%）に入っています（現在 ${volPct}%）。`,
      nextAction: '',
    };
  }
  if (current === null) {
    return {
      satisfied: false,
      grade: 'needs_work',
      reason: `「${trackName}」トラックが見つかりません。`,
      nextAction: `トラックリストに「${trackName}」トラックを追加してください。`,
    };
  }

  // close: volume is within ±20% of the range boundary it overshot
  const rangeSpan = max - min;
  const tolerance = Math.max(rangeSpan * 0.2, 0.1);
  const isClose = current >= min - tolerance && current <= max + tolerance;
  const grade: PredicateGrade = isClose ? 'close' : 'needs_work';

  const volPct = Math.round(current * 100);
  const direction = current < min ? '小さすぎます' : '大きすぎます';
  const target =
    current < min
      ? `${Math.round(min * 100)}% 以上`
      : `${Math.round(max * 100)}% 以下`;
  return {
    satisfied: false,
    grade,
    reason: `「${trackName}」のボリュームが ${volPct}% で${direction}。目標は ${Math.round(min * 100)}〜${Math.round(max * 100)}% です。`,
    nextAction: `ミキサーで「${trackName}」のボリュームを ${target} に調整してください。`,
  };
}

function explainExportCompleted(format?: 'midi' | 'wav'): PredicateFeedback {
  if (format === 'midi') {
    return {
      satisfied: false,
      grade: 'needs_work',
      reason: 'まだ MIDI エクスポートが完了していません。',
      nextAction: 'メニューから「MIDI エクスポート」を実行してください。',
    };
  }
  if (format === 'wav') {
    return {
      satisfied: false,
      grade: 'needs_work',
      reason: 'まだ WAV エクスポートが完了していません。',
      nextAction: 'メニューから「WAV エクスポート」を実行してください。',
    };
  }
  return {
    satisfied: false,
    grade: 'needs_work',
    reason: 'まだエクスポートが完了していません。',
    nextAction: 'メニューからエクスポートを実行してください（MIDI または WAV）。',
  };
}

// ─── 音楽的判定のフィードバック (docs/03 §4.2 / §4.3) ──────────────────────────
// 小節番号・コード名・着地候補音名を含む日本語で「結果 → 理由 → 次の一手」を返す。
// スケール外音・非コードトーンは一律に誤りと断定せず、比率と文脈で説明する。

function percent(ratio: number): number {
  return Math.round(ratio * 100);
}

/** 失敗時の close / needs_work 判定: 目標比率の半分以上まで来ていれば「惜しい」 */
function ratioGrade(ratio: number, minRatio: number, hasAnyData: boolean): PredicateGrade {
  if (!hasAnyData) return 'needs_work';
  return ratio >= minRatio / 2 ? 'close' : 'needs_work';
}

function explainBassRootOnDownbeat(
  trackName: string,
  minRatio: number,
  project: Project,
  satisfied: boolean,
): PredicateFeedback {
  const analysis = analyzeBassRootOnDownbeat(project, trackName);

  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `小節のあたま（1拍目）の ${percent(analysis.ratio)}% でコードのルート音が鳴っています。ベースが曲の土台をしっかり支えています！`,
      nextAction: '',
    };
  }

  if (analysis.consideredBars === 0) {
    return {
      satisfied: false,
      grade: 'needs_work',
      reason: 'コードがまだ置かれていないため、ベースのルート音判定ができません。',
      nextAction: `先にコードトラックへコードを置いてから、「${trackName}」トラックの各小節1拍目にルート音を入れてみましょう。`,
    };
  }

  const grade = ratioGrade(analysis.ratio, minRatio, analysis.rootBars > 0);
  const issue = analysis.firstIssue;
  if (issue) {
    const where = `${issue.barNumber}小節目の1拍目`;
    const reason = issue.hasNoteOnDownbeat
      ? `${where}が${issue.chordSymbol}コードのルート音ではありません（ルート音が鳴っている小節は ${percent(analysis.ratio)}%）。`
      : `${where}にベースの音がありません（ルート音が鳴っている小節は ${percent(analysis.ratio)}%）。`;
    return {
      satisfied: false,
      grade,
      reason,
      nextAction: `${issue.barNumber}小節目の1拍目に ${issue.rootName} の音を置いてみましょう。${issue.chordSymbol}コードの土台はルートの ${issue.rootName} です。`,
    };
  }
  // 理論上ここには来ない（不成立なら firstIssue があるはず）が、安全側の文言を返す。
  return {
    satisfied: false,
    grade,
    reason: `ルート音が鳴っている小節がまだ ${percent(analysis.ratio)}% です。`,
    nextAction: `各小節の1拍目に、そのとき鳴っているコードのルート音を置いてみましょう。`,
  };
}

function explainMelodyChordToneOnStrongBeat(
  trackName: string,
  minRatio: number,
  project: Project,
  satisfied: boolean,
): PredicateFeedback {
  const analysis = analyzeMelodyChordToneOnStrongBeat(project, trackName);

  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `強拍に着地した音の ${percent(analysis.ratio)}% がコードの音です。メロディがコードに乗って安定して聞こえます！`,
      nextAction: '',
    };
  }

  if (analysis.landings === 0) {
    return {
      satisfied: false,
      grade: 'needs_work',
      reason: `「${trackName}」トラックには、強拍（各小節の1拍目・3拍目）に着地しているノートがまだありません。`,
      nextAction: '各小節の1拍目か3拍目にノートを置いてみましょう。そのとき鳴っているコードの音に合わせると安定します。',
    };
  }

  const grade = ratioGrade(analysis.ratio, minRatio, analysis.chordToneLandings > 0);
  const issue = analysis.firstIssue;
  if (issue) {
    const tones = issue.chordToneNames.join('・');
    const what = issue.outOfScale ? 'スケール外の音' : `${issue.chordSymbol}コードの構成音ではない音`;
    const softener = issue.outOfScale
      ? ''
      : 'スケール内なので経過音としては使えますが、';
    return {
      satisfied: false,
      grade,
      reason: `${issue.barNumber}小節目の強拍が${what}です。${softener}${issue.chordSymbol}コードの上では ${tones} のどれかに着地すると安定して聞こえます。`,
      nextAction: `ピアノロールで${issue.barNumber}小節目の強拍の音を ${tones} のどれかに動かしてみましょう。`,
    };
  }
  return {
    satisfied: false,
    grade,
    reason: `コードの音に着地した強拍はまだ ${percent(analysis.ratio)}% です。`,
    nextAction: '強拍の音を、そのとき鳴っているコードの構成音に合わせてみましょう。',
  };
}

function explainNotesWithinScale(
  trackName: string,
  minRatio: number,
  project: Project,
  satisfied: boolean,
): PredicateFeedback {
  const analysis = analyzeNotesWithinScale(project, trackName);
  const scaleText = `${project.key} ${scaleLabel(project.scale)}`;

  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `「${trackName}」トラックのノートの ${percent(analysis.ratio)}% が ${scaleText} の音です。キーのまとまりが感じられます！`,
      nextAction: '',
    };
  }

  if (analysis.totalNotes === 0) {
    return {
      satisfied: false,
      grade: 'needs_work',
      reason: `「${trackName}」トラックにはまだノートがありません。`,
      nextAction: `ピアノロールを開いて「${trackName}」トラックにノートを入力してみましょう。`,
    };
  }

  const grade = ratioGrade(analysis.ratio, minRatio, analysis.inScaleNotes > 0);
  const barText =
    analysis.firstOutsideBarNumber !== null
      ? `最初のスケール外の音は ${analysis.firstOutsideBarNumber}小節目にあります。`
      : '';
  return {
    satisfied: false,
    grade,
    reason: `${scaleText} 内の音は全体の ${percent(analysis.ratio)}%（目標 ${percent(minRatio)}%）です。${barText}スケール外の音がすべて間違いというわけではなく、経過音やアクセントとして効くこともあります。`,
    nextAction: `まずは${analysis.firstOutsideBarNumber !== null ? `${analysis.firstOutsideBarNumber}小節目の` : ''}スケール外の音を、隣の ${scaleText} の音にずらして響きを聴き比べてみましょう。`,
  };
}

function explainDrumPattern(
  patternType: DrumPatternType,
  project: Project,
  satisfied: boolean,
): PredicateFeedback {
  const label = drumPatternLabel(patternType);

  if (satisfied) {
    return {
      satisfied: true,
      grade: 'success',
      reason: `${label}のパターンができています。ノリのあるビートですね！`,
      nextAction: '',
    };
  }

  const analysis = analyzeDrumPattern(project, patternType);
  const missingCount = analysis.missing.reduce((sum, req) => sum + req.stepIndices.length, 0);
  // 必要ステップの半分以上が既に置けていれば「惜しい」
  const grade: PredicateGrade =
    analysis.requiredSteps > 0 && missingCount <= analysis.requiredSteps / 2
      ? 'close'
      : 'needs_work';

  const first = analysis.missing[0];
  if (first) {
    const laneText = drumLaneLabel(first.lane);
    const posText = describeStepPositions(first.stepIndices, analysis.stepsPerBar);
    return {
      satisfied: false,
      grade,
      reason: `${label}にはあと少し足りないところがあります。${laneText}が${posText}に入っていません。`,
      nextAction: `ドラムグリッドで${laneText}を${posText}に追加してください。${drumPatternRecipe(patternType)}`,
    };
  }
  return {
    satisfied: false,
    grade,
    reason: `${label}のパターンがまだ完成していません。`,
    nextAction: drumPatternRecipe(patternType),
  };
}

/** ステップ位置を拍数表現にする（4分音符グリッドに乗らない位置はステップ番号で示す） */
function describeStepPositions(stepIndices: number[], stepsPerBar: number): string {
  const quarter = stepsPerBar / 4;
  const parts = stepIndices.map((step) => {
    const beat = step / quarter + 1;
    return Number.isInteger(beat) ? `${beat}拍目` : `ステップ${step + 1}`;
  });
  return parts.join('・');
}

function drumPatternLabel(patternType: DrumPatternType): string {
  const labels: Record<DrumPatternType, string> = {
    fourOnFloor: '四つ打ち',
    eightBeat: '8ビート',
    backbeat: 'バックビート',
  };
  return labels[patternType];
}

function drumPatternRecipe(patternType: DrumPatternType): string {
  const recipes: Record<DrumPatternType, string> = {
    fourOnFloor: '四つ打ちは、キックを1・2・3・4拍目（毎拍）に置くパターンです。',
    eightBeat:
      '8ビートは、クローズハイハットを8分音符で刻み、キックを1拍目、スネアを2・4拍目に置くパターンです。',
    backbeat: 'バックビートは、スネアを2・4拍目に置いてリズムのアクセントを作るパターンです。',
  };
  return recipes[patternType];
}

// ─── Label helpers ────────────────────────────────────────────────────────────

function drumLaneLabel(lane: string): string {
  const labels: Record<string, string> = {
    kick: 'キック',
    snare: 'スネア',
    hihat: 'ハイハット',
    closedHat: 'クローズハイハット',
    openHat: 'オープンハイハット',
    'hihat-open': 'オープンハイハット',
    tom: 'タム',
    crash: 'クラッシュシンバル',
    ride: 'ライドシンバル',
    clap: 'クラップ',
    rim: 'リム',
    perc: 'パーカッション',
  };
  return labels[lane] ?? lane;
}

function scaleLabel(scale: ScaleName): string {
  const labels: Record<ScaleName, string> = {
    major: 'メジャースケール',
    naturalMinor: 'ナチュラルマイナースケール',
    harmonicMinor: 'ハーモニックマイナースケール',
    melodicMinor: 'メロディックマイナースケール',
    majorPentatonic: 'メジャーペンタトニックスケール',
    minorPentatonic: 'マイナーペンタトニックスケール',
    blues: 'ブルーススケール',
  };
  return labels[scale];
}

function sectionLabel(sectionType: string): string {
  const labels: Record<string, string> = {
    verse: 'ヴァース（Aメロ）',
    chorus: 'コーラス（サビ）',
    bridge: 'ブリッジ（Cメロ）',
    intro: 'イントロ',
    outro: 'アウトロ',
    prechorus: 'プレコーラス（Bメロ）',
  };
  return labels[sectionType] ?? sectionType;
}
