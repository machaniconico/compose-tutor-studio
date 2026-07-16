// ローカル完結のヒューリスティック作曲コーチ。
//
// 現在のプロジェクト(コード進行 / メロディ / 構成)を theory-engine の純粋解析
// (analyzeChord / suggestNextChords / analyzeMelody)だけで読み取り、初心者向けの
// 説明付き改善提案を日本語で返す。外部ネットワーク呼び出しは一切しない
// (CLAUDE.md「AI Coach must be optional and mockable / keep data local」に準拠)。
//
// 純粋・決定的: 同じ Project からは常に同じ提案リストが得られる。UI はこの結果を
// 表示するだけで、副作用はここには無い。

import {
  buildClipIndex,
  findLearningTrack,
  resolveClipContent,
  type ClipIndex,
  type LearningTrackName,
  type Project,
  type Track,
} from '@cts/project-model';
import {
  analyzeMelody,
  suggestNextChords,
  type ChordSuggestion,
  type MelodyNoteInput,
} from '@cts/theory-engine';

/** 提案の重要度。good=良い点の肯定, tip=やってみると良い提案, warn=気になる点。 */
export type CoachSeverity = 'good' | 'tip' | 'warn';

/** 提案のカテゴリ。 */
export type CoachCategory = 'progression' | 'melody' | 'arrangement' | 'mix';

/** コーチからの1提案。すべて初心者向け日本語。 */
export type CoachSuggestion = {
  id: string;
  category: CoachCategory;
  severity: CoachSeverity;
  /** 一行の見出し。 */
  title: string;
  /** なぜ・どうすると良いかの説明。 */
  detail: string;
};

const CATEGORY_LABEL: Record<CoachCategory, string> = {
  progression: 'コード進行',
  melody: 'メロディ',
  arrangement: '構成・アレンジ',
  mix: 'ミックス',
};

/** カテゴリの日本語ラベルを返す(UI 見出し用)。 */
export function coachCategoryLabel(category: CoachCategory): string {
  return CATEGORY_LABEL[category];
}

/** 拍子から1小節の拍数(4分音符換算)を求める。4/4→4, 3/4→3, 6/8→3。 */
function beatsPerBar(project: Project): number {
  const [num, den] = project.timeSignature;
  if (!num || !den) return 4;
  return (num * 4) / den;
}

/** コード進行を startBeat 昇順のシンボル列にする。 */
function progressionSymbols(project: Project): string[] {
  return [...project.chordTrack]
    .sort((a, b) => a.startBeat - b.startBeat)
    .map((c) => c.symbol);
}

/** schema v2の学習roleを共有のtrim・case-fold規則で探す。 */
function trackByName(project: Project, name: LearningTrackName): Track | undefined {
  return findLearningTrack(project, name);
}

/** トラックが持つノートの総数。 */
function noteCountOf(
  project: Project,
  track: Track | undefined,
  clipIndex: ClipIndex,
): number {
  if (!track) return 0;
  if (track.type === 'drum') {
    return track.clips.reduce(
      (sum, clip) =>
        sum + (resolveClipContent(project, clip, clipIndex)?.drumEvents?.length ?? 0),
      0,
    );
  }
  return track.clips.reduce(
    (sum, clip) =>
      sum + (resolveClipContent(project, clip, clipIndex)?.notes?.length ?? 0),
    0,
  );
}

/**
 * Resolve every MIDI clip instance and convert its clip-local note positions
 * into absolute project beats. Linked clips therefore contribute once at each
 * timeline placement while retaining their source-owned note payload.
 */
export function melodyNotesOnProjectTimeline(
  project: Project,
  track: Track | undefined,
  clipIndex: ClipIndex = buildClipIndex(project),
): MelodyNoteInput[] {
  if (!track) return [];
  return track.clips.flatMap((clip) => {
    const effectiveClip = resolveClipContent(project, clip, clipIndex);
    if (!effectiveClip?.notes) return [];
    return effectiveClip.notes.map((note) => ({
      pitch: note.pitch,
      startBeat: effectiveClip.startBeat + note.startBeat,
      durationBeats: note.durationBeats,
    }));
  });
}

/** トニック(主和音)のルート音名を素朴に取り出す(キー文字列の先頭)。 */
function tonicRootName(key: string): string {
  const m = /^([A-Ga-g][#b]?)/.exec(key);
  return m ? (m[1] as string) : key;
}

/**
 * 現在のプロジェクトを解析し、初心者向けの説明付き改善提案を返す。
 * 純粋関数。theory-engine の呼び出しは未知のコード等で例外になりうるため
 * すべて防御的に握りつぶし、提案が作れない部分は静かにスキップする。
 */
export function analyzeProjectForCoaching(project: Project): CoachSuggestion[] {
  const clipIndex = buildClipIndex(project);
  const out: CoachSuggestion[] = [];
  out.push(...coachProgression(project));
  out.push(...coachMelody(project, clipIndex));
  out.push(...coachArrangement(project, clipIndex));
  return out;
}

/** コード進行に関する提案。 */
function coachProgression(project: Project): CoachSuggestion[] {
  const out: CoachSuggestion[] = [];
  const symbols = progressionSymbols(project);

  if (symbols.length === 0) {
    out.push({
      id: 'prog-empty',
      category: 'progression',
      severity: 'tip',
      title: 'まずはコード進行から置いてみましょう',
      detail:
        'コードトラックがまだ空です。テンプレート(例: I–V–vi–IV)を1つ置くと、曲の骨組みができて次の作業が進めやすくなります。',
    });
    return out;
  }

  // 進行が短い。
  if (symbols.length <= 2) {
    out.push({
      id: 'prog-short',
      category: 'progression',
      severity: 'tip',
      title: 'コードを増やすと展開が生まれます',
      detail: `いまはコードが${symbols.length}個です。4つ程度に増やすと、起承転結のある進行になり曲が動き出します。`,
    });
  }

  // 終止(最後がトニックか)。
  const tonic = tonicRootName(project.key);
  const last = symbols[symbols.length - 1] ?? '';
  const lastRoot = /^([A-Ga-g][#b]?)/.exec(last)?.[1];
  if (symbols.length >= 3 && lastRoot && lastRoot !== tonic) {
    out.push({
      id: 'prog-cadence',
      category: 'progression',
      severity: 'tip',
      title: '終わりを主和音に戻すと落ち着きます',
      detail: `進行が主和音(${tonic})以外で終わっています。フレーズの最後を${tonic}に戻すと「解決した」印象になり、まとまりが出ます。あえて浮遊感を残したいときはこのままでもOKです。`,
    });
  } else if (symbols.length >= 3 && lastRoot === tonic) {
    out.push({
      id: 'prog-cadence-good',
      category: 'progression',
      severity: 'good',
      title: '主和音で終わっていて安定しています',
      detail: `フレーズが主和音(${tonic})で終わっているので、聴き終わりがしっかり落ち着きます。良い終止です。`,
    });
  }

  // 借用和音 / セカンダリドミナントで色を足す提案。
  try {
    const suggestions = suggestNextChords({
      key: project.key,
      scale: project.scale,
      currentProgression: symbols,
    });
    const color = pickColorSuggestion(suggestions);
    if (color) {
      const kindLabel = color.tag === 'secondaryDominant' ? 'セカンダリドミナント' : '借用和音';
      out.push({
        id: 'prog-color',
        category: 'progression',
        severity: 'tip',
        title: `${kindLabel}「${color.symbol}」で山場を作れます`,
        detail:
          `${color.reason}` +
          (color.origin ? `(${color.origin})` : '') +
          ' サビ前やフレーズの折り返しに差し込むと、ダイアトニックだけの進行に色と高揚感が加わります。',
      });
    }
  } catch {
    // 候補が作れないキー/スケールでは色付け提案をスキップ。
  }

  return out;
}

/** ダイアトニック以外(借用 / セカンダリ)の候補を1つ選ぶ。無ければ null。 */
function pickColorSuggestion(suggestions: ChordSuggestion[]): ChordSuggestion | null {
  const secondary = suggestions.find((s) => s.tag === 'secondaryDominant');
  if (secondary) return secondary;
  const borrowed = suggestions.find((s) => s.tag === 'borrowed');
  if (borrowed) return borrowed;
  return null;
}

/** メロディに関する提案。 */
function coachMelody(project: Project, clipIndex: ClipIndex): CoachSuggestion[] {
  const out: CoachSuggestion[] = [];
  const melodyTrack = trackByName(project, 'Melody');
  const notes = melodyNotesOnProjectTimeline(project, melodyTrack, clipIndex);

  if (notes.length === 0) {
    out.push({
      id: 'melody-empty',
      category: 'melody',
      severity: 'tip',
      title: 'メロディを乗せると曲になります',
      detail:
        'メロディトラックがまだ空です。コードトーン(コードの構成音)を中心に音を置くと、コードと自然に馴染むメロディになります。まずは主音や3度・5度から。',
    });
    return out;
  }

  // メロディ添削(analyzeMelody)。未知/解析不能は静かにスキップ。
  try {
    const analysis = analyzeMelody({
      key: project.key,
      scale: project.scale,
      chords: progressionChordInputs(project),
      notes,
      beatsPerBar: beatsPerBar(project),
    });

    const scorePct = Math.round(analysis.score * 100);
    const warnings = analysis.findings.filter((f) => f.severity === 'warn');

    if (scorePct >= 80 && warnings.length === 0) {
      out.push({
        id: 'melody-good',
        category: 'melody',
        severity: 'good',
        title: `メロディがコードとよく合っています(${scorePct}%)`,
        detail:
          'スケール内の音とコードトーンが中心で、コード進行と自然に馴染んでいます。この調子でフレーズを展開しましょう。',
      });
    } else if (warnings.length > 0) {
      const first = warnings[0];
      out.push({
        id: 'melody-warn',
        category: 'melody',
        severity: 'warn',
        title: `気になる音があります(適合度 ${scorePct}%)`,
        detail:
          `${first?.message ?? 'スケール外の音が目立ちます。'} ` +
          'スケール外の音は「経過音(短く隣へ通り過ぎる)」として使うと自然です。拍の頭に長く置くと外れて聞こえやすいので、コードトーンに置き換えるか短くしてみましょう。',
      });
    } else {
      out.push({
        id: 'melody-ok',
        category: 'melody',
        severity: 'tip',
        title: `メロディの適合度は ${scorePct}% です`,
        detail:
          '大きな問題はありません。より馴染ませたい場合は、各コードの頭の音をコードトーン(ルート・3度・5度)に合わせると安定感が増します。',
      });
    }
  } catch {
    // 解析不能なら静かにスキップ。
  }

  return out;
}

/** analyzeMelody / suggestNextChords が受け取るコード入力へ変換。 */
function progressionChordInputs(
  project: Project,
): { symbol: string; startBeat: number; durationBeats: number }[] {
  return [...project.chordTrack]
    .sort((a, b) => a.startBeat - b.startBeat)
    .map((c) => ({ symbol: c.symbol, startBeat: c.startBeat, durationBeats: c.durationBeats }));
}

/** 構成・アレンジに関する提案。 */
function coachArrangement(project: Project, clipIndex: ClipIndex): CoachSuggestion[] {
  const out: CoachSuggestion[] = [];

  // ドラム: type==='drum' のトラックにヒットがあるか。
  const drumTrack = project.tracks.find((t) => t.type === 'drum');
  if (drumTrack && noteCountOf(project, drumTrack, clipIndex) === 0) {
    out.push({
      id: 'arr-drums',
      category: 'arrangement',
      severity: 'tip',
      title: 'ドラムを入れるとノリが出ます',
      detail:
        'ドラムトラックがまだ空です。キックを1・3拍、スネアを2・4拍に置く基本パターンだけでも、曲に一気に推進力が生まれます。',
    });
  }

  // ベース: 'Bass' トラックが空。
  const bassTrack = trackByName(project, 'Bass');
  if (bassTrack && noteCountOf(project, bassTrack, clipIndex) === 0) {
    out.push({
      id: 'arr-bass',
      category: 'arrangement',
      severity: 'tip',
      title: 'ベースが土台を作ります',
      detail:
        'ベーストラックが空です。各コードのルート音を置くだけでも低音の土台ができ、コードとドラムがまとまって聞こえます。ベース生成アシスタントも使えます。',
    });
  }

  // セクション構成。
  if (project.sections.length <= 1) {
    out.push({
      id: 'arr-sections',
      category: 'arrangement',
      severity: 'tip',
      title: 'セクションで曲の流れを設計しましょう',
      detail:
        'いまはセクションがほとんど分かれていません。Intro→A→サビ のようにラベルを分けると、盛り上がりの設計がしやすく、聴き手にも展開が伝わります。',
    });
  }

  return out;
}
