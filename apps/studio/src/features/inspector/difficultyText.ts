/**
 * difficultyText — 難易度に応じた理論用語・説明文を返す純粋関数群。
 *
 * - beginner: 専門用語を平易な日本語に言い換え
 * - standard: 標準的な音楽用語
 * - advanced: テンション/借用/セカンダリドミナントの詳細を追加
 */

export type Difficulty = 'beginner' | 'standard' | 'advanced';

/**
 * 和声機能ラベルを難易度に合わせて返す。
 * @param fn - HarmonicFunction の値 ('T' | 'SD' | 'D' | 'Other')
 */
export function harmonicFunctionLabel(fn: string, difficulty: Difficulty): string {
  if (difficulty === 'beginner') {
    switch (fn) {
      case 'T':
        return 'トニック（安らぐ和音）';
      case 'SD':
        return 'サブドミナント（動き出す和音）';
      case 'D':
        return 'ドミナント（もどりたくなる和音）';
      default:
        return 'その他';
    }
  }
  if (difficulty === 'advanced') {
    switch (fn) {
      case 'T':
        return 'トニック (Tonic) — 安定。I / VIm / IIIm が該当';
      case 'SD':
        return 'サブドミナント (SubDominant) — 展開。IVm / IIm7 を含む借用も';
      case 'D':
        return 'ドミナント (Dominant) — 緊張→解決。V7・VIIm7♭5、セカンダリドミナント応用可';
      default:
        return 'Other (調性外・モーダル)';
    }
  }
  // standard
  switch (fn) {
    case 'T':
      return 'トニック（安定）';
    case 'SD':
      return 'サブドミナント（展開）';
    case 'D':
      return 'ドミナント（緊張）';
    default:
      return 'その他';
  }
}

/**
 * コードのスケール度数表記を難易度に合わせて装飾する。
 * @param degree - ローマ数字度数文字列 (例 "V7")
 */
export function degreeLabel(degree: string, difficulty: Difficulty): string {
  if (degree === '—' || degree === '') return degree;

  if (difficulty === 'beginner') {
    // ローマ数字を順番を表す日本語に置き換えて親しみやすくする
    // 長い文字列から先に置換する必要がある（VII → VI → V → IV → III → II → I の順）
    const readable = degree
      .replace('VII', '7番目')
      .replace('VI', '6番目')
      .replace('IV', '4番目')
      .replace('III', '3番目')
      .replace('II', '2番目')
      .replace('V', '5番目')
      .replace('I', '1番目');
    return readable;
  }
  // standard / advanced はそのまま
  return degree;
}

/**
 * テンション音リストの説明文を難易度に合わせて返す。
 * @param tensions - テンション音ラベルの配列 (例 ["9th", "13th"])
 */
export function tensionLabel(tensions: string[], difficulty: Difficulty): string {
  if (tensions.length === 0) {
    if (difficulty === 'beginner') return 'なし（シンプルな形）';
    return 'なし（基本形）';
  }

  const joined = tensions.join('・');
  if (difficulty === 'beginner') {
    return `${joined}（使うと色が増す音）`;
  }
  if (difficulty === 'advanced') {
    return `${joined} — アボイドノートに注意して使用`;
  }
  return joined;
}

/**
 * theory-engine の analyzeChord が生成する explanation テキストに含まれる
 * 上級用語を beginner 向けの平易な表現に置き換えるテーブル。
 * 長い語句を先に処理することで部分マッチの取りこぼしを防ぐ。
 */
const BEGINNER_TERM_TABLE: Array<[string, string]> = [
  // セカンダリドミナント関連
  ['セカンダリドミナント', '次のコードへ強く向かう橋わたしのコード'],
  ['仮のトニックと見なす', 'を一時的なゴールと見なす'],
  // 借用和音・モーダルインターチェンジ関連
  ['借用和音(モーダルインターチェンジ)', 'となりのキーから借りてきた響き'],
  ['モーダルインターチェンジ', '同じ主音の別スケールから借りた響き'],
  ['借用和音', 'となりのキーから借りてきた響き'],
  ['同主調などから色を借りており', '同じ主音の別スケールから色を借りており'],
  // ダイアトニック関連
  ['ダイアトニックには無い', 'このキーの基本コードにはない'],
  ['ダイアトニック', 'このキーの基本の音だけでできた'],
  // 機能説明
  ['サブドミナント (中間)', '動き出す和音'],
  ['ドミナント (緊張)', 'もどりたくなる和音'],
  ['トニック (安定)', '安らぐ和音'],
  // その他の上級用語
  ['推進力', 'ドラマティックな流れ'],
];

/**
 * explanation テキストを難易度に合わせて整形する。
 * - beginner: 上級用語を平易な言い換えに置換
 * - standard / advanced: そのまま返す
 */
export function simplifyExplanation(text: string, difficulty: Difficulty): string {
  if (!text) return text;
  if (difficulty !== 'beginner') return text;

  let result = text;
  for (const [term, replacement] of BEGINNER_TERM_TABLE) {
    result = result.split(term).join(replacement);
  }
  return result;
}

/**
 * コードの説明文に、advanced モード向けの追加情報を付加する。
 * @param base - useInspection などが生成した基本説明文
 * @param fn   - HarmonicFunction
 * @param degree - ローマ数字度数
 */
export function advancedChordNote(fn: string, degree: string): string {
  const hints: string[] = [];

  if (fn === 'D') {
    hints.push(
      'このドミナントコードはトニックへ強く進みます。V7→I の解決感を意識しましょう。',
    );
    hints.push(
      'セカンダリドミナント（例: V7/II, V7/IV）として他のコードへ向けても使えます。',
    );
  } else if (fn === 'SD') {
    hints.push(
      '短調の IVm や♭VII を借用した借用和音（モーダルインターチェンジ）も試してみましょう。',
    );
    hints.push('IIm7→V7→I のツーファイブワン進行で使えます。');
  } else if (fn === 'T') {
    hints.push(
      'トニックは曲の始まりと終わりを安定させます。VIm（平行短調のトニック代理。Iと構成音が2音共通で、やわらかい響き）で代用して変化をつけることもできます。',
    );
  }

  const romanNum = degree.replace(/[^IVXivx]/g, '');
  if (romanNum && ['II', 'VI', 'III'].includes(romanNum.toUpperCase())) {
    hints.push(
      `${degree} はセカンダリドミナントの解決先になることがあります。前後の流れを聴いてみましょう。`,
    );
  }

  return hints.join('\n');
}

/**
 * ノートのスケール度数説明を難易度に合わせて返す。
 */
export function noteRelationLabel(relation: string, difficulty: Difficulty): string {
  if (difficulty === 'beginner') {
    switch (relation) {
      case 'chordTone':
        return 'コードにぴったり合う音';
      case 'scaleTone':
        return 'スケールの中にある音（メロディに使いやすい）';
      case 'tension':
        return '色をつける音（ちょっと個性的）';
      case 'nonScale':
        return 'スケール外の音（経過音として使うと面白い）';
      default:
        return relation;
    }
  }
  if (difficulty === 'advanced') {
    switch (relation) {
      case 'chordTone':
        return 'コードトーン（安定音）';
      case 'scaleTone':
        return 'スケール音（経過音・アプローチ音向き）';
      case 'tension':
        return 'テンション音（9th/11th/13th 等、色付け）';
      case 'nonScale':
        return 'ノンスケール音（クロマチック経過音・アプローチノート）';
      default:
        return relation;
    }
  }
  // standard
  switch (relation) {
    case 'chordTone':
      return 'コードトーン（安定音）';
    case 'scaleTone':
      return 'スケール音（経過音向き）';
    case 'tension':
      return 'テンション（色付け音）';
    case 'nonScale':
      return 'スケール外（経過音・アプローチ音）';
    default:
      return relation;
  }
}

/**
 * スケール在否の簡易説明を難易度に合わせて返す。
 */
export function scalePresenceLabel(inScale: boolean, difficulty: Difficulty): string {
  if (inScale) {
    if (difficulty === 'beginner') return '内（キーに合っている音）';
    return '内（自然な音）';
  }
  if (difficulty === 'beginner') return '外（少し個性的な音）';
  if (difficulty === 'advanced') return '外（クロマチック・ノンダイアトニック）';
  return '外（色付けの音）';
}
