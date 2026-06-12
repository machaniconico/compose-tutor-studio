// 書き出し前チェックリスト (docs/02 §8.2)。
// Project データを静的に評価する純粋関数だけを置く。リアルタイム解析
// (メーター連動のクリッピング検出など) は US-303 側の担当で、ここでは扱わない。

import type { Clip, EffectConfig, Project, Track } from '@cts/project-model';

export type ExportChecklistLevel = 'ok' | 'warning';

export type ExportChecklistItemId =
  | 'reverb'
  | 'volume'
  | 'mutedTracks'
  | 'sections'
  | 'emptyTracks';

export type ExportChecklistItem = {
  id: ExportChecklistItemId;
  level: ExportChecklistLevel;
  title: string;
  advice: string;
};

/** チェック項目の固定順序 (UI とテストが同じ並びを共有する)。 */
export const EXPORT_CHECKLIST_ITEM_IDS: readonly ExportChecklistItemId[] = [
  'reverb',
  'volume',
  'mutedTracks',
  'sections',
  'emptyTracks',
];

/** reverb の mix がこの値を超えたら「リバーブ過多」warning にする。 */
export const REVERB_MIX_WARNING_THRESHOLD = 0.6;

/** フェーダー上限 2.0 に対して、この値以上を「最大付近」とみなす。 */
export const VOLUME_NEAR_MAX_THRESHOLD = 1.8;

/** マスター以外で「最大付近」のトラックがこの本数以上なら warning にする。 */
export const LOUD_TRACK_COUNT_FOR_WARNING = 2;

/** audio/effects.ts の reverb 既定 mix と同じ値 (mix 未設定時の解釈を揃える)。 */
const DEFAULT_REVERB_MIX = 0.25;

/** 音を出す(=空/ミュート判定の対象になる)トラック種別。 */
const SOUND_TRACK_TYPES: ReadonlySet<Track['type']> = new Set([
  'instrument',
  'drum',
  'audio',
]);

/**
 * 書き出し前チェックリストを評価する。
 * 常に EXPORT_CHECKLIST_ITEM_IDS の順で全項目を返し、入力は変更しない。
 */
export function evaluateExportChecklist(project: Project): ExportChecklistItem[] {
  return [
    checkReverb(project),
    checkVolumeBalance(project),
    checkMutedTracks(project),
    checkSections(project),
    checkEmptyTracks(project),
  ];
}

/** warning が1つでも含まれるか。 */
export function hasExportChecklistWarnings(
  items: readonly ExportChecklistItem[],
): boolean {
  return items.some((item) => item.level === 'warning');
}

// ---------------------------------------------------------------------------
// 個別チェック
// ---------------------------------------------------------------------------

function checkReverb(project: Project): ExportChecklistItem {
  const title = 'リバーブの深さ';
  const deepTracks = project.tracks.filter((track) =>
    track.effects.some(
      (effect) =>
        effect.type === 'reverb' &&
        effect.enabled &&
        reverbMixOf(effect) > REVERB_MIX_WARNING_THRESHOLD,
    ),
  );

  if (deepTracks.length === 0) {
    return {
      id: 'reverb',
      level: 'ok',
      title,
      advice: 'リバーブはほどよい深さです。',
    };
  }

  return {
    id: 'reverb',
    level: 'warning',
    title: 'リバーブ過多',
    advice:
      `${joinTrackNames(deepTracks)}のリバーブがかなり深めです。` +
      'リバーブが深すぎると音がぼやけます。' +
      'ミキサーでリバーブのミックスを少し下げると、メロディの輪郭がはっきり聞こえます。',
  };
}

function checkVolumeBalance(project: Project): ExportChecklistItem {
  const title = '音量バランス';
  const master = project.tracks.find((track) => track.type === 'master');
  const masterLoud =
    master !== undefined && master.volume >= VOLUME_NEAR_MAX_THRESHOLD;
  const loudTracks = project.tracks.filter(
    (track) =>
      track.type !== 'master' && track.volume >= VOLUME_NEAR_MAX_THRESHOLD,
  );
  const manyLoudTracks = loudTracks.length >= LOUD_TRACK_COUNT_FOR_WARNING;

  if (!masterLoud && !manyLoudTracks) {
    return {
      id: 'volume',
      level: 'ok',
      title,
      advice: '音量は音割れの心配が少ない範囲に収まっています。',
    };
  }

  const subjects: string[] = [];
  if (masterLoud) subjects.push('マスターの音量');
  if (manyLoudTracks) subjects.push(`${loudTracks.length}本のトラックの音量`);

  return {
    id: 'volume',
    level: 'warning',
    title,
    advice:
      `${subjects.join('と')}が上限の近くまで上がっています。` +
      '音量を上げすぎると「クリッピング」という音割れが起きて、書き出したファイルにノイズが入ることがあります。' +
      'マスターは1.0(0dB)あたりを目安にして、曲の迫力は各トラックのバランスで作りましょう。',
  };
}

function checkMutedTracks(project: Project): ExportChecklistItem {
  const title = 'ミュート中のトラック';
  const mutedWithContent = soundTracks(project).filter(
    (track) => track.mute && trackHasContent(track),
  );

  if (mutedWithContent.length === 0) {
    return {
      id: 'mutedTracks',
      level: 'ok',
      title,
      advice: 'ミュートで音が消えたままになるトラックはありません。',
    };
  }

  return {
    id: 'mutedTracks',
    level: 'warning',
    title,
    advice:
      `${joinTrackNames(mutedWithContent)}がミュートされたままです。` +
      'ミュート中のトラックの音は書き出したファイルに入りません。' +
      '鳴らしたいトラックなら、ミュートを解除してから書き出しましょう。',
  };
}

function checkSections(project: Project): ExportChecklistItem {
  const title = '曲の構成(セクション)';

  if (project.sections.length === 0) {
    return {
      id: 'sections',
      level: 'warning',
      title,
      advice:
        'セクション(イントロやサビなどの区切り)がまだ設定されていません。' +
        '区切りがないと、どこで盛り上がるのかという曲の構成が聴く人に伝わりにくくなります。' +
        'アレンジ画面でセクションを追加してみましょう。',
    };
  }

  const hasUnnamed = project.sections.some(
    (section) => section.name.trim().length === 0,
  );
  if (hasUnnamed) {
    return {
      id: 'sections',
      level: 'warning',
      title,
      advice:
        '名前のないセクションがあります。' +
        '名前がないと、どこがサビなのかが分からず曲の構成を見直しにくくなります。' +
        '「Aメロ」「サビ」のような名前を付けてみましょう。',
    };
  }

  return {
    id: 'sections',
    level: 'ok',
    title,
    advice: 'セクションが設定されていて、曲の構成がわかる状態です。',
  };
}

function checkEmptyTracks(project: Project): ExportChecklistItem {
  const title = '空のトラック';
  const emptyTracks = soundTracks(project).filter(
    (track) => !trackHasContent(track),
  );

  if (emptyTracks.length === 0) {
    return {
      id: 'emptyTracks',
      level: 'ok',
      title,
      advice: 'すべてのトラックに音が入っています。',
    };
  }

  return {
    id: 'emptyTracks',
    level: 'warning',
    title,
    advice:
      `${joinTrackNames(emptyTracks)}にはまだ音が入っていません。` +
      '空のトラックは無音のまま書き出され、プロジェクトのどこに何があるかも分かりにくくなります。' +
      '音を入れるか、使わない場合は削除しましょう。',
  };
}

// ---------------------------------------------------------------------------
// 補助関数
// ---------------------------------------------------------------------------

function reverbMixOf(effect: EffectConfig): number {
  const value = effect.params?.['mix'];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : DEFAULT_REVERB_MIX;
}

function soundTracks(project: Project): Track[] {
  return project.tracks.filter((track) => SOUND_TRACK_TYPES.has(track.type));
}

function trackHasContent(track: Track): boolean {
  return track.clips.some(clipHasContent);
}

function clipHasContent(clip: Clip): boolean {
  if (typeof clip.aliasOf === 'string' && clip.aliasOf.length > 0) return true;
  if ((clip.notes?.length ?? 0) > 0) return true;
  if ((clip.drumEvents?.length ?? 0) > 0) return true;
  return clip.type === 'audio' && typeof clip.audioAssetId === 'string';
}

function joinTrackNames(tracks: readonly Track[]): string {
  return tracks.map((track) => `「${displayTrackName(track)}」`).join('、');
}

function displayTrackName(track: Track): string {
  if (track.type === 'master') return 'マスター';
  const name = track.name.trim();
  return name.length > 0 ? name : '名前のないトラック';
}
