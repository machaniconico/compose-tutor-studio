// 書き出し前チェックリスト (docs/02 §8.2)。
// Project データを静的に評価する純粋関数だけを置く。リアルタイム解析
// (メーター連動のクリッピング検出など) は US-303 側の担当で、ここでは扱わない。

import type { Clip, EffectConfig, Project, Track } from '@cts/project-model';
import { beatsPerBar, expandClip } from '@cts/project-model';

export type ExportChecklistLevel = 'ok' | 'warning';

export type ExportChecklistItemId =
  | 'reverb'
  | 'volume'
  | 'mutedTracks'
  | 'sections'
  | 'emptyTracks'
  | 'clipLinks';

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
  'clipLinks',
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
    checkClipLinks(project),
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
    (track) => track.mute && trackHasContent(track, project),
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
    (track) => !trackHasContent(track, project),
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

/**
 * 再生や書き出しと同じ expandClip で各クリップを展開し、鳴らせない理由
 * (リンク切れ・リンクの循環など)をまとめて 1 件の warning にする。
 */
function checkClipLinks(project: Project): ExportChecklistItem {
  const title = 'クリップのリンクとループ';
  const allClips = project.tracks.flatMap((track) => track.clips);
  // Every track, buses and master too: a clip there that cannot sound is
  // reported, not hidden behind "all clips OK".
  const problems = project.tracks.flatMap((track) =>
    track.clips.flatMap((clip) =>
      expandClip(clip, allClips, beatsPerBar(project.timeSignature), track.type).problems.map(
        (problem) => `${joinTrackNames([track])}: ${problem}`,
      ),
    ),
  );

  if (problems.length === 0) {
    return {
      id: 'clipLinks',
      level: 'ok',
      title,
      advice: 'すべてのクリップが正しく鳴らせる状態です。',
    };
  }

  return {
    id: 'clipLinks',
    level: 'warning',
    title,
    advice:
      `${problems.join(' ')}` +
      '書き出したファイルでも、再生と同じようにその部分は鳴りません。' +
      'リンクやループの設定を見直しましょう。',
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

function trackHasContent(track: Track, project: Project): boolean {
  const allClips = project.tracks.flatMap((candidate) => candidate.clips);
  const bpb = beatsPerBar(project.timeSignature);
  return track.clips.some((clip) => clipHasContent(clip, track.type, allClips, bpb));
}

/**
 * 再生と同じ expandClip で、実際に鳴る音があるかを見る。クリップの長さより
 * 後ろにしかノートが無いクリップは鳴らないので「空」と数える。リンク切れ・
 * 循環は「クリップのリンクとループ」で警告するので、ここでは二重に数えない。
 */
function clipHasContent(
  clip: Clip,
  trackType: Track['type'],
  allClips: readonly Clip[],
  bpb: number,
): boolean {
  if (clip.type === 'audio' && typeof clip.audioAssetId === 'string') return true;
  const { notes, drumHits, problems } = expandClip(clip, allClips, bpb, trackType);
  return notes.length > 0 || drumHits.length > 0 || problems.length > 0;
}

function joinTrackNames(tracks: readonly Track[]): string {
  return tracks.map((track) => `「${displayTrackName(track)}」`).join('、');
}

function displayTrackName(track: Track): string {
  if (track.type === 'master') return 'マスター';
  const name = track.name.trim();
  return name.length > 0 ? name : '名前のないトラック';
}
