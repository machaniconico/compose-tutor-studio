/**
 * MockCoach — ネットワーク不要・決定論的なAIコーチ実装
 *
 * theory-engine の既存分析を使い、現在のプロジェクトに対して
 * 2〜4件の初心者向け日本語改善提案を生成する。
 * 外部ネットワーク呼び出し一切なし。
 */

import type { Project } from '@cts/project-model';
import {
  suggestNextChords,
  getDiatonicChords,
  analyzeMelody,
  getScalePitchClasses,
} from '@cts/theory-engine';
import type { CoachAdapter, CoachFocus, CoachSuggestion } from './adapter';

/** コードトラックから現在のコード進行シンボル配列を取得 */
function currentProgression(project: Project): string[] {
  return [...project.chordTrack]
    .sort((a, b) => a.startBeat - b.startBeat)
    .map((c) => c.symbol);
}

/** メロディノートをanalyzeMelody用に整形 */
function melodyNotesFrom(project: Project): { pitch: number; startBeat: number; durationBeats: number }[] {
  for (const track of project.tracks) {
    if (track.name === 'Melody') {
      for (const clip of track.clips) {
        if (clip.notes && clip.notes.length > 0) {
          return clip.notes.map((n) => ({
            pitch: n.pitch,
            startBeat: n.startBeat,
            durationBeats: n.durationBeats,
          }));
        }
      }
    }
  }
  return [];
}

/** コードトラックをanalyzeMelody用に整形 */
function chordInputsFrom(project: Project): { symbol: string; startBeat: number; durationBeats: number }[] {
  return project.chordTrack.map((c) => ({
    symbol: c.symbol,
    startBeat: c.startBeat,
    durationBeats: c.durationBeats,
  }));
}

/** ビート数/小節を取得 */
function beatsPerBar(project: Project): number {
  return project.timeSignature[0] ?? 4;
}

/** 和声提案を生成 */
function harmonyAdvice(project: Project): CoachSuggestion | null {
  const prog = currentProgression(project);
  if (prog.length === 0) {
    return {
      title: 'コード進行を追加しよう',
      reason: 'コードトラックがまだ空です。コードを追加するとメロディやベースと調和した曲になります。',
      action: 'コードトラックに最低2〜4つのコードを配置してみましょう。Cメジャーなら C → Am → F → G が定番です。',
      targetTrack: null,
    };
  }

  try {
    const suggestions = suggestNextChords({
      key: project.key,
      scale: project.scale,
      currentProgression: prog,
    });
    if (suggestions.length > 0) {
      const top = suggestions[0]!;
      return {
        title: `次のコードに「${top.symbol}」を試してみよう`,
        reason: top.reason,
        action: `コードトラックの最後に「${top.symbol}」を追加してください。進行がより自然になります。`,
        targetTrack: null,
      };
    }
  } catch {
    // suggestNextChords が失敗したときはスキップ
  }
  return null;
}

/** ダイアトニック多様性の提案を生成 */
function diatonicVarietyAdvice(project: Project): CoachSuggestion | null {
  const prog = currentProgression(project);
  if (prog.length < 2) return null;

  try {
    const diatonic = getDiatonicChords(project.key, project.scale);
    const usedSymbols = new Set(prog);
    const unused = diatonic.filter((d) => !usedSymbols.has(d.symbol));
    if (unused.length === 0) return null;

    const candidate = unused[0]!;
    return {
      title: `「${candidate.symbol}」(${candidate.degree}度) を試してみよう`,
      reason: `このキーで使えるダイアトニックコードのうち、まだ「${candidate.symbol}」が使われていません。${candidate.function === 'T' ? 'トニック系で安定感' : candidate.function === 'SD' ? 'サブドミナント系で広がり' : 'ドミナント系で緊張感'}が増します。`,
      action: `コードトラックに「${candidate.symbol}」を差し込んで、どんな雰囲気になるか聴いてみましょう。`,
      targetTrack: null,
    };
  } catch {
    return null;
  }
}

/** メロディ提案を生成 */
function melodyAdvice(project: Project): CoachSuggestion | null {
  const notes = melodyNotesFrom(project);
  if (notes.length === 0) {
    return {
      title: 'メロディを作ってみよう',
      reason: 'メロディトラックがまだ空です。メロディがあると曲として完成に近づきます。',
      action: 'アシスタントパネルの「スケールメロディを生成」ボタンで自動生成してから編集すると簡単です。',
      targetTrack: 'Melody',
    };
  }

  try {
    const chords = chordInputsFrom(project);
    const analysis = analyzeMelody({
      key: project.key,
      scale: project.scale,
      chords,
      notes,
      beatsPerBar: beatsPerBar(project),
    });

    if (analysis.score < 0.6) {
      const warnFindings = analysis.findings.filter((f) => f.severity === 'warn');
      if (warnFindings.length > 0) {
        const f = warnFindings[0]!;
        return {
          title: 'メロディをスケールに合わせよう',
          reason: f.message,
          action: 'ピアノロールでスケール外の音符 (赤や黄色でハイライトされているもの) をスケール内の音に移動してみましょう。',
          targetTrack: 'Melody',
        };
      }
    }

    if (analysis.score >= 0.8) {
      return {
        title: 'メロディのリズムを変化させよう',
        reason: 'メロディのピッチはよくできています。同じリズムが続くと単調に聴こえることがあります。',
        action: '音符の長さを変えたり、休符を入れたりして、フレーズにメリハリをつけてみましょう。',
        targetTrack: 'Melody',
      };
    }
  } catch {
    // analyzeMelody が失敗したときはスキップ
  }
  return null;
}

/** リズム提案を生成 */
function rhythmAdvice(project: Project): CoachSuggestion | null {
  // ドラムトラックのステップ数を確認
  for (const track of project.tracks) {
    if (track.type === 'drum') {
      for (const clip of track.clips) {
        const stepCount = (clip.drumEvents ?? []).length;
        if (stepCount === 0) {
          return {
            title: 'ドラムパターンを追加しよう',
            reason: 'ドラムトラックにパターンがありません。リズムがあると楽曲に躍動感が生まれます。',
            action: 'ドラムグリッドでキック・スネア・ハイハットを配置してシンプルな4つ打ちから始めましょう。',
            targetTrack: track.name,
          };
        }
        if (stepCount < 4) {
          return {
            title: 'ドラムパターンをもっと充実させよう',
            reason: 'ドラムのステップ数が少ないため、リズムがシンプルすぎるかもしれません。',
            action: 'スネアを2・4拍目に追加したり、ハイハットを刻んだりしてビートを強化しましょう。',
            targetTrack: track.name,
          };
        }
      }
    }
  }
  return null;
}

/** BPM提案を生成 */
function bpmAdvice(project: Project): CoachSuggestion | null {
  if (project.bpm < 60) {
    return {
      title: 'テンポを少し上げてみよう',
      reason: `現在のテンポ (${project.bpm} BPM) はかなりゆっくりです。60 BPM未満だと演奏が間延びして感じることがあります。`,
      action: 'トランスポートバーのBPMを 80〜120 に上げて聴き比べてみましょう。',
      targetTrack: null,
    };
  }
  if (project.bpm > 200) {
    return {
      title: 'テンポを少し下げてみよう',
      reason: `現在のテンポ (${project.bpm} BPM) はとても速いです。最初は 120〜140 BPM 程度がコントロールしやすいです。`,
      action: 'トランスポートバーのBPMを下げてみましょう。',
      targetTrack: null,
    };
  }
  return null;
}

/** コードが空かどうかを確認するスケール活用提案 */
function scaleUsageAdvice(project: Project): CoachSuggestion | null {
  if (project.chordTrack.length === 0) return null;

  try {
    const pcs = getScalePitchClasses(project.key, project.scale);
    if (pcs.length < 5) return null; // ペンタトニック等では省略
  } catch {
    return null;
  }

  // コード進行が1コードしかない場合
  const prog = currentProgression(project);
  if (prog.length === 1) {
    return {
      title: 'コードをもう1つ追加してみよう',
      reason: '1コードだけだと曲に動きがなく、単調に聴こえます。最低2コードあると曲らしくなります。',
      action: `「${prog[0]}」の次に別のコードを配置しましょう。${project.scale === 'major' ? 'Am や G などが合います。' : 'C や G などが合います。'}`,
      targetTrack: null,
    };
  }
  return null;
}

/**
 * MockCoach — 決定論的AIコーチ
 *
 * theory-engine の分析関数を使い、プロジェクト状態に応じた
 * 初心者向け日本語提案を2〜4件返す。ネットワーク呼び出しなし。
 */
export class MockCoach implements CoachAdapter {
  readonly name = 'mock';

  async suggestImprovements(project: Project, focus: CoachFocus = 'all'): Promise<CoachSuggestion[]> {
    const results: CoachSuggestion[] = [];

    // フォーカスに応じて分析を実行
    const runHarmony = focus === 'all' || focus === 'harmony';
    const runMelody = focus === 'all' || focus === 'melody';
    const runRhythm = focus === 'all' || focus === 'rhythm';
    const runArrangement = focus === 'all' || focus === 'arrangement';

    if (runHarmony) {
      const h1 = harmonyAdvice(project);
      if (h1) results.push(h1);

      const h2 = diatonicVarietyAdvice(project);
      if (h2 && results.length < 4) results.push(h2);

      const h3 = scaleUsageAdvice(project);
      if (h3 && results.length < 4) results.push(h3);
    }

    if (runMelody && results.length < 4) {
      const m = melodyAdvice(project);
      if (m) results.push(m);
    }

    if (runRhythm && results.length < 4) {
      const r = rhythmAdvice(project);
      if (r) results.push(r);
    }

    if (runArrangement && results.length < 4) {
      const b = bpmAdvice(project);
      if (b) results.push(b);
    }

    // 最低2件保証: 汎用フォールバック
    if (results.length < 2) {
      if (results.length < 1) {
        results.push({
          title: 'コード進行を録音してみよう',
          reason: '曲の骨格となるコード進行を作ることが、作曲の第一歩です。',
          action: 'コードトラックに C → Am → F → G などの定番進行を入力してみましょう。',
          targetTrack: null,
        });
      }
      results.push({
        title: '曲を8小節に仕上げよう',
        reason: '8小節は1コーラスの基本的な長さです。まず8小節を完成させることを目標にしましょう。',
        action: `現在 ${project.lengthBars} 小節。コードとメロディとドラムを一通り埋めてから通し再生してみましょう。`,
        targetTrack: null,
      });
    }

    // 最大4件
    return results.slice(0, 4);
  }
}
