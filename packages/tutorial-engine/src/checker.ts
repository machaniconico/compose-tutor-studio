/**
 * Tutorial Engine — DSL Checker + 音楽的判定チェッカー
 *
 * Pure, deterministic functions that evaluate CheckConditions and Lessons
 * against accumulated EditEvents. No timers, no randomness, no I/O.
 *
 * 後半は docs/03 §4.2 の音楽的判定（ベース強拍ルート / メロディ着地 /
 * スケール内率 / ドラムパターン種別）。Project とコードトラックを読み、
 * theory-engine の parseChord / スケール関数で小節ごとに判定する。
 * スケール外音を一律に誤りと断定せず、比率（minRatio）ベースで判定する。
 */

import type { ChordEvent, Project } from '@cts/project-model';
import { isInScale, parseChord, pitchClassOf } from '@cts/theory-engine';
import type { CheckCondition, EditEvent, Lesson, LessonStep } from './dsl.js';
// NOTE: goals.ts とは相互import（goals → checker: 音楽的判定の委譲 /
// checker → goals: 従来predicateの委譲）。両モジュールとも関数宣言のみで
// トップレベル実行が無いため、ESM の循環importとして安全。
import { evaluateProjectPredicate } from './goals.js';
import type { DrumPatternType, ProjectPredicate } from './types.js';

// ─── Runtime State ────────────────────────────────────────────────────────────

/** Accumulated history of user edit actions for a single lesson session. */
export type LessonRuntimeState = {
  events: EditEvent[];
};

// ─── applyEvent ───────────────────────────────────────────────────────────────

/**
 * Returns a new state with `event` appended — original state is not mutated.
 */
export function applyEvent(
  state: LessonRuntimeState,
  event: EditEvent,
): LessonRuntimeState {
  return { events: [...state.events, event] };
}

// ─── checkCondition ───────────────────────────────────────────────────────────

/**
 * Evaluates a single CheckCondition against the accumulated event history.
 * Always deterministic — depends only on `cond` and `state`.
 */
export function checkCondition(
  cond: CheckCondition,
  state: LessonRuntimeState,
): boolean {
  switch (cond.kind) {
    case 'hasEvent': {
      return state.events.some((e) => e.type === cond.eventType);
    }

    case 'eventCount': {
      const count = state.events.filter((e) => e.type === cond.eventType).length;
      return count >= cond.min;
    }

    case 'progressionEquals': {
      // Find the last 'progression.set' event and compare its symbols.
      const last = [...state.events]
        .reverse()
        .find((e): e is Extract<EditEvent, { type: 'progression.set' }> =>
          e.type === 'progression.set',
        );
      if (!last) return false;
      if (last.symbols.length !== cond.symbols.length) return false;
      return cond.symbols.every((s, i) => last.symbols[i] === s);
    }

    case 'chordCountAtLeast': {
      const count = state.events.filter((e) => e.type === 'chord.added').length;
      return count >= cond.min;
    }

    case 'noteCountAtLeast': {
      const count = state.events.filter((e) => e.type === 'note.added').length;
      return count >= cond.min;
    }

    case 'exported': {
      return state.events.some(
        (e): e is Extract<EditEvent, { type: 'exported' }> => {
          if (e.type !== 'exported') return false;
          if (cond.format === undefined) return true;
          return e.format === cond.format;
        },
      );
    }
  }
}

// ─── evaluateLesson ───────────────────────────────────────────────────────────

/**
 * Walks all steps in order and returns lesson progress.
 *
 * - `completedStepIds` — ids of every step whose condition is satisfied.
 * - `currentStep` — 0-based index of the first unsatisfied step; equals
 *   `lesson.steps.length` when all steps are done.
 * - `isComplete` — true when every step is satisfied.
 * - `feedback` — the instruction (or hint) of the current active step, or
 *   the successMessage of the last step when all done.
 */
export function evaluateLesson(
  lesson: Lesson,
  state: LessonRuntimeState,
): {
  currentStep: number;
  completedStepIds: string[];
  isComplete: boolean;
  feedback: string;
} {
  const completedStepIds: string[] = [];
  let currentStep = 0;

  for (let i = 0; i < lesson.steps.length; i++) {
    const step = lesson.steps[i] as LessonStep;
    if (checkCondition(step.check, state)) {
      completedStepIds.push(step.id);
    } else {
      currentStep = i;
      const feedback = step.hint ?? step.instruction;
      return { currentStep, completedStepIds, isComplete: false, feedback };
    }
  }

  // All steps satisfied.
  currentStep = lesson.steps.length;
  const lastStep = lesson.steps[lesson.steps.length - 1];
  const feedback = lastStep ? lastStep.successMessage : '';
  return { currentStep, completedStepIds, isComplete: true, feedback };
}

// ═══ 音楽的判定チェッカー (docs/03 §4.2) ═══════════════════════════════════════
//
// すべて純粋関数。Project（コードトラック・キー・スケール・拍子）だけを入力に、
// 小節単位の決定的な解析結果を返す。feedback.ts はこの解析結果から
// 小節番号・コード名・着地候補音名入りの日本語フィードバックを組み立てる。

/** コード区間マッチ・ノート着地判定に使う拍位置の許容誤差 */
const BEAT_EPSILON = 1e-3;
/** 比率のちょうど境界（minRatio ぴったり）を浮動小数誤差で落とさないための許容誤差 */
const RATIO_EPSILON = 1e-9;

/** ratio が minRatio 以上か（境界ちょうどは満たす扱い） */
function meetsRatio(ratio: number, minRatio: number): boolean {
  return ratio + RATIO_EPSILON >= minRatio;
}

/** 1小節あたりの拍数（4分音符基準）。例: 4/4→4, 3/4→3, 6/8→3 */
function beatsPerBarOf(project: Project): number {
  const [numerator, denominator] = project.timeSignature;
  return numerator * (4 / denominator);
}

/** トラック名で集めた絶対拍位置つきノート */
type AbsoluteNote = {
  pitch: number;
  /** クリップ開始拍 + ノート開始拍（プロジェクト先頭からの絶対拍） */
  startBeat: number;
};

function collectTrackNotes(project: Project, trackName: string): AbsoluteNote[] {
  const out: AbsoluteNote[] = [];
  for (const track of project.tracks) {
    if (track.name !== trackName) continue;
    for (const clip of track.clips) {
      if (!clip.notes) continue;
      for (const note of clip.notes) {
        out.push({ pitch: note.pitch, startBeat: clip.startBeat + note.startBeat });
      }
    }
  }
  return out;
}

/** 指定拍で鳴っているコードイベントを返す（区間 [start, start+duration)） */
function chordAtBeat(chords: readonly ChordEvent[], beat: number): ChordEvent | undefined {
  return chords.find(
    (c) => beat >= c.startBeat - BEAT_EPSILON && beat < c.startBeat + c.durationBeats - BEAT_EPSILON,
  );
}

/** parseChord を安全に呼ぶ。未対応のコード表記は判定対象外（誤りと断定しない） */
function safeParseChord(symbol: string, key: string): ReturnType<typeof parseChord> | null {
  try {
    return parseChord(symbol, key);
  } catch {
    return null;
  }
}

/** 指定拍ちょうどに開始するノートを返す */
function notesStartingAt(notes: readonly AbsoluteNote[], beat: number): AbsoluteNote[] {
  return notes.filter((n) => Math.abs(n.startBeat - beat) < BEAT_EPSILON);
}

// ─── hasBassRootOnDownbeat ────────────────────────────────────────────────────

export type BassDownbeatAnalysis = {
  /** 判定対象になった小節数（1拍目にコードが鳴っていて、シンボルを解釈できた小節） */
  consideredBars: number;
  /** 1拍目にコードのルート音が置かれていた小節数 */
  rootBars: number;
  /** rootBars / consideredBars（対象0小節なら0） */
  ratio: number;
  /** 最初に未達だった小節の詳細（フィードバック用）。全達成なら null */
  firstIssue: {
    /** 1始まりの小節番号 */
    barNumber: number;
    chordSymbol: string;
    /** キーに合わせた綴りのルート音名（例: 'G'） */
    rootName: string;
    /** 1拍目に何かしらノートが置かれていたか（false なら「音が無い」） */
    hasNoteOnDownbeat: boolean;
  } | null;
};

/**
 * 各小節の1拍目（強拍）で、ベーストラックがコードのルート音を弾いている比率を解析する。
 * コードが無い小節・解釈できないコードの小節は分母に入れない。
 */
export function analyzeBassRootOnDownbeat(
  project: Project,
  trackName: string,
): BassDownbeatAnalysis {
  const beatsPerBar = beatsPerBarOf(project);
  const notes = collectTrackNotes(project, trackName);
  let consideredBars = 0;
  let rootBars = 0;
  let firstIssue: BassDownbeatAnalysis['firstIssue'] = null;

  for (let bar = 0; bar < project.lengthBars; bar++) {
    const downbeat = bar * beatsPerBar;
    const chord = chordAtBeat(project.chordTrack, downbeat);
    if (!chord) continue;
    const parsed = safeParseChord(chord.symbol, project.key);
    if (!parsed) continue;

    consideredBars++;
    const landing = notesStartingAt(notes, downbeat);
    const hasRoot = landing.some((n) => pitchClassOf(n.pitch) === parsed.rootPc);
    if (hasRoot) {
      rootBars++;
    } else if (firstIssue === null) {
      firstIssue = {
        barNumber: bar + 1,
        chordSymbol: chord.symbol,
        rootName: parsed.root,
        hasNoteOnDownbeat: landing.length > 0,
      };
    }
  }

  return {
    consideredBars,
    rootBars,
    ratio: consideredBars === 0 ? 0 : rootBars / consideredBars,
    firstIssue,
  };
}

// ─── hasMelodyChordToneOnStrongBeat ──────────────────────────────────────────

export type MelodyLandingAnalysis = {
  /** コード上の強拍に着地（その拍で発音開始）したノートがある強拍の数 */
  landings: number;
  /** 着地音がコードトーンだった強拍の数 */
  chordToneLandings: number;
  /** chordToneLandings / landings（着地0なら0） */
  ratio: number;
  /** 最初にコードトーン以外へ着地した強拍の詳細（フィードバック用）。無ければ null */
  firstIssue: {
    /** 1始まりの小節番号 */
    barNumber: number;
    chordSymbol: string;
    /** 着地候補のコードトーン音名（キーに合わせた綴り。例: ['G','B','D']） */
    chordToneNames: string[];
    /** 着地音がスケール外でもあるか（経過音/テンション等の文言の出し分け用） */
    outOfScale: boolean;
  } | null;
};

/**
 * メロディが強拍（1拍目・3拍目）に着地したとき、その音がコードトーンである比率を解析する。
 * 強拍にノートが無い場合（シンコペーション等）は分母に入れない —
 * 強拍を外すこと自体は誤りではないため。
 */
export function analyzeMelodyChordToneOnStrongBeat(
  project: Project,
  trackName: string,
): MelodyLandingAnalysis {
  const beatsPerBar = beatsPerBarOf(project);
  // 強拍: 小節の1拍目。拍数が4以上の偶数なら中間拍（4/4の3拍目）も強拍。
  const strongOffsets =
    beatsPerBar >= 4 && beatsPerBar % 2 === 0 ? [0, beatsPerBar / 2] : [0];
  const notes = collectTrackNotes(project, trackName);

  let landings = 0;
  let chordToneLandings = 0;
  let firstIssue: MelodyLandingAnalysis['firstIssue'] = null;

  for (let bar = 0; bar < project.lengthBars; bar++) {
    for (const offset of strongOffsets) {
      const beat = bar * beatsPerBar + offset;
      const chord = chordAtBeat(project.chordTrack, beat);
      if (!chord) continue;
      const parsed = safeParseChord(chord.symbol, project.key);
      if (!parsed) continue;

      const landing = notesStartingAt(notes, beat);
      if (landing.length === 0) continue; // 強拍に着地していない＝判定対象外

      landings++;
      const isChordTone = landing.some((n) =>
        parsed.pitchClasses.includes(pitchClassOf(n.pitch)),
      );
      if (isChordTone) {
        chordToneLandings++;
      } else if (firstIssue === null) {
        const outOfScale = landing.every(
          (n) => !isInScale(n.pitch, project.key, project.scale),
        );
        firstIssue = {
          barNumber: bar + 1,
          chordSymbol: chord.symbol,
          chordToneNames: [...parsed.notes],
          outOfScale,
        };
      }
    }
  }

  return {
    landings,
    chordToneLandings,
    ratio: landings === 0 ? 0 : chordToneLandings / landings,
    firstIssue,
  };
}

// ─── hasNotesWithinScale ──────────────────────────────────────────────────────

export type ScaleConformanceAnalysis = {
  totalNotes: number;
  inScaleNotes: number;
  /** inScaleNotes / totalNotes（ノート0なら0） */
  ratio: number;
  /** 最初のスケール外ノートがある小節番号（1始まり）。無ければ null */
  firstOutsideBarNumber: number | null;
};

/**
 * トラック内ノートのうち、プロジェクトのキー/スケール内の音である比率を解析する。
 * スケール外音は「誤り」ではなく比率としてだけ扱う（経過音・ブルーノート等もありうる）。
 */
export function analyzeNotesWithinScale(
  project: Project,
  trackName: string,
): ScaleConformanceAnalysis {
  const beatsPerBar = beatsPerBarOf(project);
  const notes = [...collectTrackNotes(project, trackName)].sort(
    (a, b) => a.startBeat - b.startBeat,
  );

  let inScaleNotes = 0;
  let firstOutsideBarNumber: number | null = null;

  for (const note of notes) {
    if (isInScale(note.pitch, project.key, project.scale)) {
      inScaleNotes++;
    } else if (firstOutsideBarNumber === null) {
      firstOutsideBarNumber = Math.floor(note.startBeat / beatsPerBar) + 1;
    }
  }

  return {
    totalNotes: notes.length,
    inScaleNotes,
    ratio: notes.length === 0 ? 0 : inScaleNotes / notes.length,
    firstOutsideBarNumber,
  };
}

// ─── hasDrumPattern ───────────────────────────────────────────────────────────

export type DrumPatternRequirement = {
  lane: string;
  /** 小節内ステップ位置（stepsPerBar 基準） */
  stepIndices: number[];
};

export type DrumPatternAnalysis = {
  satisfied: boolean;
  /**
   * 不足しているレーン×ステップ位置（最も完成に近いクリップ/小節基準）。
   * 満たしていれば空配列。
   */
  missing: DrumPatternRequirement[];
  /** パターンに必要なステップ総数（grade判定用） */
  requiredSteps: number;
  /** 判定に使った1小節のステップ数（クリップ未存在時は16） */
  stepsPerBar: number;
};

/** パターン種別ごとの必要レーン×ステップ位置（stepsPerBar=16 なら 1拍=4ステップ） */
function drumPatternRequirements(
  patternType: DrumPatternType,
  stepsPerBar: number,
): DrumPatternRequirement[] {
  const quarter = stepsPerBar / 4;
  const eighth = stepsPerBar / 8;
  switch (patternType) {
    case 'fourOnFloor':
      // 四つ打ち: キックを毎拍（1・2・3・4拍目）に置く
      return [{ lane: 'kick', stepIndices: [0, quarter, 2 * quarter, 3 * quarter] }];
    case 'eightBeat':
      // 8ビート: クローズハイハット8分刻み + キック1拍目 + スネア2・4拍目
      return [
        { lane: 'closedHat', stepIndices: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * eighth) },
        { lane: 'kick', stepIndices: [0] },
        { lane: 'snare', stepIndices: [quarter, 3 * quarter] },
      ];
    case 'backbeat':
      // バックビート: スネアを2・4拍目に置く
      return [{ lane: 'snare', stepIndices: [quarter, 3 * quarter] }];
  }
}

function countMissingSteps(missing: readonly DrumPatternRequirement[]): number {
  return missing.reduce((sum, req) => sum + req.stepIndices.length, 0);
}

/**
 * ドラムトラックのいずれかのクリップ（のいずれかの小節）が
 * 指定パターン種別を満たすか解析する。
 */
export function analyzeDrumPattern(
  project: Project,
  patternType: DrumPatternType,
): DrumPatternAnalysis {
  let best: { missing: DrumPatternRequirement[]; requiredSteps: number; stepsPerBar: number } | null =
    null;

  for (const track of project.tracks) {
    if (track.type !== 'drum') continue;
    for (const clip of track.clips) {
      if (!clip.drumEvents || clip.drumEvents.length === 0) continue;
      const stepsPerBar = clip.stepsPerBar ?? 16;
      const requirements = drumPatternRequirements(patternType, stepsPerBar);
      const requiredSteps = countMissingSteps(requirements);

      // 小節ごとにアクティブなステップ集合を作る（複数小節クリップ対応）
      const barSteps = new Map<number, Set<string>>();
      for (const ev of clip.drumEvents) {
        const barIndex = Math.floor(ev.stepIndex / stepsPerBar);
        const stepInBar = ev.stepIndex - barIndex * stepsPerBar;
        const set = barSteps.get(barIndex) ?? new Set<string>();
        set.add(`${ev.lane}:${stepInBar}`);
        barSteps.set(barIndex, set);
      }

      for (const steps of barSteps.values()) {
        const missing: DrumPatternRequirement[] = [];
        for (const req of requirements) {
          const lacking = req.stepIndices.filter((s) => !steps.has(`${req.lane}:${s}`));
          if (lacking.length > 0) missing.push({ lane: req.lane, stepIndices: lacking });
        }
        if (missing.length === 0) {
          return { satisfied: true, missing: [], requiredSteps, stepsPerBar };
        }
        if (best === null || countMissingSteps(missing) < countMissingSteps(best.missing)) {
          best = { missing, requiredSteps, stepsPerBar };
        }
      }
    }
  }

  if (best !== null) {
    return { satisfied: false, ...best };
  }
  // ドラムイベントがまだ1つも無い場合: 既定の16ステップ基準で全要件を不足として返す
  const requirements = drumPatternRequirements(patternType, 16);
  return {
    satisfied: false,
    missing: requirements,
    requiredSteps: countMissingSteps(requirements),
    stepsPerBar: 16,
  };
}

// ─── checkProjectPredicate ────────────────────────────────────────────────────

/**
 * ProjectPredicate を Project に対して評価する統合エントリポイント。
 *
 * - 音楽的判定4種（docs/03 §4.2）はこのファイル内の解析関数で評価する。
 *   比率系は「判定対象が1つ以上あり、かつ ratio >= minRatio（境界ちょうど含む）」で成立。
 *   判定対象ゼロ（ノート未入力・コード未配置など）は不成立として扱う。
 * - それ以外の従来predicateは goals.ts の evaluateProjectPredicate に委譲する。
 */
export function checkProjectPredicate(
  predicate: ProjectPredicate,
  project: Project,
): boolean {
  switch (predicate.type) {
    case 'hasBassRootOnDownbeat': {
      const a = analyzeBassRootOnDownbeat(project, predicate.trackName);
      return a.consideredBars > 0 && meetsRatio(a.ratio, predicate.minRatio);
    }
    case 'hasMelodyChordToneOnStrongBeat': {
      const a = analyzeMelodyChordToneOnStrongBeat(project, predicate.trackName);
      return a.landings > 0 && meetsRatio(a.ratio, predicate.minRatio);
    }
    case 'hasNotesWithinScale': {
      const a = analyzeNotesWithinScale(project, predicate.trackName);
      return a.totalNotes > 0 && meetsRatio(a.ratio, predicate.minRatio);
    }
    case 'hasDrumPattern': {
      return analyzeDrumPattern(project, predicate.patternType).satisfied;
    }
    default:
      return evaluateProjectPredicate(predicate, project);
  }
}
