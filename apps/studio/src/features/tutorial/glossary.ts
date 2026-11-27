/**
 * glossary — 用語集データと検索の純粋関数。
 * 各語は初心者向けの説明を 1 つ持つ。
 */

export interface GlossaryEntry {
  id: string;
  /** 表示名(日本語) */
  label: string;
  /** ひらがなの読み(検索用) */
  reading: string;
  /** 英字の呼び名・別名(検索用) */
  aliases: string[];
  description: string;
}

function e(
  id: string,
  label: string,
  reading: string,
  aliases: string[],
  description: string,
): GlossaryEntry {
  return { id, label, reading, aliases, description };
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  e('beat', '拍', 'はく', ['beat'],
    '曲の中で「いち、に、さん、し」と数える一定の刻みです。'),
  e('bar', '小節', 'しょうせつ', ['bar', 'measure'],
    '拍をいくつかまとめた区切りです。4拍で1小節の曲が多いです。'),
  e('bpm', 'BPM', 'びーぴーえむ', ['bpm', 'tempo', 'テンポ'],
    '曲の速さです。数字が大きいほど速くなります。曲の途中で速さを変えたいときは、テンポマップを使います。'),
  e('time-signature', '拍子', 'ひょうし', ['time signature', 'meter'],
    '1小節に何拍あるかを表す決まりです。'),
  e('key', 'キー', 'きー', ['key', '調'],
    '曲の中心になる音と、よく使う音のグループです。'),
  e('scale', 'スケール', 'すけーる', ['scale', '音階'],
    '音を高さの順に並べた、曲に合う音のグループです。'),
  e('chord', 'コード', 'こーど', ['chord', '和音'],
    '2つ以上の音を同時に鳴らした響きです。'),
  e('chord-progression', 'コード進行', 'こーどしんこう', ['chord progression', 'progression'],
    'コードを順番に並べたものです。曲の流れを作ります。'),
  e('diatonic', 'ダイアトニック', 'だいあとにっく', ['diatonic'],
    'キーの音だけで作れるコードのことです。まず安心して使えます。'),
  e('tonic', 'トニック', 'とにっく', ['tonic', 'T'],
    '曲の中心で、いちばん落ち着くコードです。'),
  e('subdominant', 'サブドミナント', 'さぶどみなんと', ['subdominant', 'SD'],
    '少し動きを出して、次へ進みたくなるコードです。'),
  e('dominant', 'ドミナント', 'どみなんと', ['dominant', 'D'],
    '「ホームに戻りたい」と感じさせる、緊張が強いコードです。'),
  e('degree', '度数', 'どすう', ['degree', 'scale degree'],
    'スケールの中で何番目の音かを表す数字です。'),
  e('passing-tone', '経過音', 'けいかおん', ['passing tone'],
    'コードの音と音をなめらかにつなぐ、通り道の音です。'),
  e('approach-tone', 'アプローチ音', 'あぷろーちおん', ['approach tone'],
    '目標の音のすぐ隣から入ることで、狙った音を引き立てる音です。'),
  e('tension', 'テンション', 'てんしょん', ['tension', 'extension'],
    'コードに足す、おしゃれな響きの音です。'),
  e('blue-note', 'ブルーノート', 'ぶるーのーと', ['blue note'],
    'ブルースらしい切ない響きを出す、少し低めの音です。'),
  e('borrowed-chord', '借用和音', 'しゃくようわおん', ['borrowed chord', 'modal interchange'],
    '同じ主音の別のキーからコードを借りて、雰囲気を変える方法です。'),
  e('secondary-dominant', 'セカンダリドミナント', 'せかんだりーどみなんと', ['secondary dominant'],
    '次のコードへ強く進みたくさせる、特別なコードです。'),
  e('voice-leading', 'ボイスリーディング', 'ぼいすりーでぃんぐ', ['voice leading'],
    'コードを切り替えるとき、音をなるべく近くに動かす考え方です。'),
  e('melody', 'メロディ', 'めろでぃ', ['melody', '旋律'],
    '歌えるような、曲の主役になる音の流れです。'),
  e('rhythm', 'リズム', 'りずむ', ['rhythm'],
    '音の長さと並べ方で作る、曲のノリです。'),
  e('velocity', 'ベロシティ', 'べろしてぃ', ['velocity', '強さ'],
    '音の強さです。大きいほどはっきり鳴ります。0〜127の数字で表します。'),
  e('loop', 'ループ', 'るーぷ', ['loop'],
    '同じ部分をくり返して再生することです。'),
  e('clip', 'クリップ', 'くりっぷ', ['clip', 'リージョン'],
    'トラックの上に置く、音のかたまりです。移動やコピーができます。'),
  e('track', 'トラック', 'とらっく', ['track', 'パート'],
    '楽器ひとつ分の演奏や録音の入れ物です。音量やパンをトラックごとに調整できます。'),
  e('section', 'セクション', 'せくしょん', ['section', 'パート', '構成'],
    'イントロ、Aメロ、サビなど、曲の大きな区切りです。アレンジャーで並べます。'),
  e('arrangement', 'アレンジ', 'あれんじ', ['arrangement', 'arrange'],
    '楽器の組み合わせや音の厚みを考えて、曲を仕上げる作業です。'),
  e('mixing', 'ミックス', 'みっくす', ['mix', 'mixing', 'ミキシング'],
    '各トラックの音量などを整えて、聞きやすくまとめる作業です。'),
  e('volume', '音量', 'おんりょう', ['volume', 'gain', 'フェーダー'],
    '音の大きさです。ミキサーのフェーダーで調整します。'),
  e('pan', 'パン', 'ぱん', ['pan', '定位'],
    '音を左右どちらに寄せるかの設定です。'),
  e('eq', 'EQ', 'いーきゅー', ['eq', 'equalizer', 'イコライザー'],
    '低音・中音・高音を、それぞれ強めたり弱めたりして音色を整える機能です。'),
  e('compressor', 'コンプレッサー', 'こんぷれっさー', ['compressor', 'コンプ'],
    '大きい音を自動で少しおさえて、音量の差をそろえる機能です。'),
  e('reverb', 'リバーブ', 'りばーぶ', ['reverb', '残響'],
    '広い部屋で鳴っているような響きを足す効果です。'),
  e('delay', 'ディレイ', 'でぃれい', ['delay', 'やまびこ'],
    'やまびこのように、音を少し遅れて繰り返す効果です。'),
  e('filter', 'フィルター', 'ふぃるたー', ['filter'],
    '高い音をやわらかくして、音色を丸くする機能です。「明るさ」のつまみで調整します。'),
  e('automation', 'オートメーション', 'おーとめーしょん', ['automation'],
    '時間にそって、音量などの設定を自動で動かす機能です。Read のときは描いた動きを再生し、Bypass のときは動きを止めて今の値のまま鳴らします(描いた点は消えません)。'),
  e('midi', 'MIDI', 'みでぃ', ['midi'],
    '音そのものでなく、「どの音を、いつ、どれだけ強く」という演奏の情報です。'),
  e('export', '書き出し', 'かきだし', ['export', 'bounce', 'レンダリング'],
    '作った曲をMIDIやWAVのファイルとして保存して、他の場所で聴けるようにすることです。'),
  e('wav', 'WAV', 'うぁぶ', ['wav', 'wave', 'オーディオ'],
    '音を実際に鳴らせる形で保存した、劣化の少ないファイルです。'),
  e('dynamics', 'ダイナミクス', 'だいなみくす', ['dynamics'],
    '曲の中の音の大きい小さいの変化です。'),
  e('send', 'センド', 'せんど', ['send', '送り'],
    'トラックの音の一部を、バスへ分けて送る仕組みです。送る量で、バスにかける効果の深さを変えられます。'),
  e('bus', 'バス', 'ばす', ['bus', 'リターン', 'return'],
    'いくつかのトラックの音を集めて、まとめて処理する通り道です。リバーブなどの効果をひとつ置いて、複数のトラックで共有できます。'),
  e('pre-post-fader', 'フェーダー前・後', 'ふぇーだーまえ・ご', ['pre fader', 'post fader', 'プリ', 'ポスト'],
    'センドで音を取り出す位置です。フェーダー前は音量を下げても送り量が変わらず、フェーダー後は音量に合わせて送り量も変わります。'),
  e('tempo-map', 'テンポマップ', 'てんぽまっぷ', ['tempo map', 'テンポ変化'],
    '曲の途中でテンポや拍子を変えるための、位置と値の一覧です。'),
];

/** かな・全角を揃え、小文字化する(カタカナ→ひらがな、NFKC、空白除去)。 */
export function normalizeSearch(text: string): string {
  const folded = text.normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of folded) {
    const code = ch.charCodeAt(0);
    // カタカナ(ァ-ヶ)をひらがなへ
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : ch;
  }
  return out.replace(/\s+/g, '');
}

/** ひらがな・カタカナ・英字を正規化して部分一致検索する。空クエリは全件。 */
export function searchGlossary(query: string, entries: readonly GlossaryEntry[] = GLOSSARY): GlossaryEntry[] {
  const q = normalizeSearch(query);
  if (q === '') return [...entries];
  return entries.filter((entry) =>
    [entry.label, entry.reading, ...entry.aliases].some((name) => normalizeSearch(name).includes(q)),
  );
}

export function findGlossaryEntry(id: string): GlossaryEntry | undefined {
  return GLOSSARY.find((entry) => entry.id === id);
}

/** 本文を分割した 1 片。文字列は地の文、オブジェクトは用語。 */
export type GlossarySegment = string | { id: string; text: string };

/** 本文では別の意味でも使う語。レッスンのスネアの音「パン」を定位の説明にしないため自動で包まない。 */
const NOT_AUTO_LINKED = new Set(['pan']);

function scriptOf(ch: string | undefined): 'kana' | 'kanji' | 'latin' | null {
  if (ch === undefined) return null;
  if (/[\u30a1-\u30fa\u30fc]/.test(ch)) return 'kana';
  if (/\p{Script=Han}/u.test(ch)) return 'kanji';
  if (/[0-9A-Za-z]/.test(ch)) return 'latin';
  return null;
}

/** 別の単語の一部(「キーボード」の「キー」、「グループ」の「ループ」など)ではないか。 */
function standsAlone(text: string, start: number, end: number): boolean {
  return (
    scriptOf(text[start - 1]) !== scriptOf(text[start]) &&
    scriptOf(text[end]) !== scriptOf(text[end - 1])
  );
}

/**
 * 本文から用語集の語を見つけて分割する。長い語を優先し(「コード進行」は「コード」より先)、
 * 同じ語は最初の 1 回だけ用語にする(タブ移動の止まる所を増やしすぎないため)。
 */
export function segmentGlossaryText(
  text: string,
  entries: readonly GlossaryEntry[] = GLOSSARY,
): GlossarySegment[] {
  const byLength = entries
    .filter((entry) => !NOT_AUTO_LINKED.has(entry.id))
    .sort((a, b) => b.label.length - a.label.length);
  const seen = new Set<string>();
  const segments: GlossarySegment[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    const hit = byLength.find(
      (entry) => text.startsWith(entry.label, i) && standsAlone(text, i, i + entry.label.length),
    );
    if (!hit) {
      i += 1;
      continue;
    }
    const end = i + hit.label.length;
    if (!seen.has(hit.id)) {
      seen.add(hit.id);
      if (i > plainStart) segments.push(text.slice(plainStart, i));
      segments.push({ id: hit.id, text: hit.label });
      plainStart = end;
    }
    i = end;
  }
  if (plainStart < text.length) segments.push(text.slice(plainStart));
  return segments;
}
