import type { AudioAsset, Track } from '@cts/project-model';
import type { AudioAssetRuntimeIssue } from '../../state/store';

export type AudioAssetPresentationStatus = Readonly<{
  label: string;
  problem: boolean;
}>;

/** Stable plain-language status shared by track rows, inspector and Arranger. */
export function audioAssetPresentationStatus(
  asset: AudioAsset | null,
  issue: AudioAssetRuntimeIssue | null,
): AudioAssetPresentationStatus {
  if (!asset || asset.availability === 'unresolved' || issue === 'missing') {
    return { label: '音声素材が見つかりません', problem: true };
  }
  if (issue === 'changed') return { label: '音声素材が変更または破損しています', problem: true };
  if (issue === 'unavailable') return { label: '音声素材を現在確認できません', problem: true };
  return { label: '音声素材を確認済み', problem: false };
}

export function audioAssetStatusLabel(
  asset: AudioAsset | null,
  issue: AudioAssetRuntimeIssue | null,
): string {
  return audioAssetPresentationStatus(asset, issue).label;
}

export type AudioTrackAssetSummary = Readonly<{
  label: string;
  statusLabel: string;
  problem: boolean;
}>;

const ISSUE_PRIORITY: Readonly<Record<AudioAssetRuntimeIssue, number>> = {
  changed: 3,
  missing: 2,
  unavailable: 1,
};

/** Aggregate every referenced clip; a later damaged asset must never be hidden by a healthy first clip. */
export function audioTrackAssetSummary(
  track: Track,
  assets: readonly AudioAsset[],
  issues: Readonly<Record<string, AudioAssetRuntimeIssue>>,
): AudioTrackAssetSummary {
  const references = track.clips
    .filter((clip) => clip.type === 'audio')
    .map((clip) => {
      const asset = clip.audioAssetId
        ? assets.find((candidate) => candidate.id === clip.audioAssetId) ?? null
        : null;
      const issue: AudioAssetRuntimeIssue | null = !asset || asset.availability === 'unresolved'
        ? 'missing'
        : issues[asset.id] ?? null;
      return { asset, issue };
    });
  if (references.length === 0) {
    return { label: '音声クリップなし', statusLabel: '音声クリップなし', problem: false };
  }
  const problem = references
    .filter((reference): reference is typeof reference & { issue: AudioAssetRuntimeIssue } =>
      reference.issue !== null,
    )
    .sort((left, right) => ISSUE_PRIORITY[right.issue] - ISSUE_PRIORITY[left.issue])[0];
  if (problem) {
    const presentation = audioAssetPresentationStatus(problem.asset, problem.issue);
    const name = problem.asset?.availability === 'ready' ? problem.asset.originalName : null;
    return {
      label: name ? `${name}・${presentation.label}` : presentation.label,
      statusLabel: presentation.label,
      problem: true,
    };
  }
  const names = Array.from(new Set(references.flatMap(({ asset }) =>
    asset?.availability === 'ready' ? [asset.originalName] : [],
  )));
  return {
    label: names.length > 1 ? `${names[0]} ほか${names.length - 1}件` : names[0] ?? '音声素材を確認済み',
    statusLabel: '音声素材を確認済み',
    problem: false,
  };
}
