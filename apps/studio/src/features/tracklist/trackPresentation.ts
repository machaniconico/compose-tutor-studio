import type { Track, TrackType } from '@cts/project-model';
import { listSynthPresets } from '../../audio/synth';

export { isLearningTrack, isLearningTrackName } from '@cts/project-model';

export { canonicalSynthPresetName } from '../../audio/synth';

export const TRACK_TYPE_LABEL: Readonly<Record<TrackType, string>> = {
  instrument: '楽器',
  drum: 'ドラム',
  audio: 'オーディオ',
  bus: 'バス',
  master: 'マスター',
};

export const TRACK_TYPE_BADGE: Readonly<Record<TrackType, string>> = {
  instrument: '鍵',
  drum: '打',
  audio: '音',
  bus: '束',
  master: '主',
};

const PRESET_JA: Readonly<Record<string, Readonly<{ label: string; description: string }>>> = {
  softPad: {
    label: 'やわらかいパッド',
    description: 'コードや穏やかな伴奏に向く、ゆっくり広がる音です。',
  },
  brightPluck: {
    label: '明るいプラック',
    description: '短く輪郭があり、メロディやアルペジオに向く音です。',
  },
  warmBass: {
    label: 'あたたかいベース',
    description: '低音を丸く支える、落ち着いたベース音です。',
  },
  brightLead: {
    label: '明るいリード',
    description: '主旋律を前に出しやすい、はっきりした音です。',
  },
};

export type StudioSynthPreset = Readonly<{
  name: string;
  label: string;
  description: string;
}>;

/** Canonical, user-facing synth choices. Playback aliases stay internal. */
export const STUDIO_SYNTH_PRESETS: readonly StudioSynthPreset[] = listSynthPresets().map(
  ({ name, label, description }) => ({
    name,
    label: PRESET_JA[name]?.label ?? label,
    description: PRESET_JA[name]?.description ?? description,
  }),
);

export function trackSelectionControlId(trackId: string): string {
  return `track-selection:${trackId}`;
}

export const TRACK_ADD_CONTROL_ID = 'track-add-control';

function normalizedAccessibleTrackName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ') || '名前なし';
}

/** Keep duplicate visible names while giving assistive controls a unique owner name. */
export function accessibleTrackName(tracks: readonly Track[], track: Track): string {
  const baseName = normalizedAccessibleTrackName(track.name);
  const matches = tracks.filter(
    (candidate) => normalizedAccessibleTrackName(candidate.name) === baseName,
  );
  if (matches.length <= 1) return baseName;
  const ordinal = matches.findIndex((candidate) => candidate.id === track.id) + 1;
  return `${baseName}（同名 ${ordinal}/${matches.length}）`;
}

/** Move keyboard focus after a React commit that adds or replaces a track row. */
export function focusTrackSelectionControl(trackId: string): void {
  if (typeof document === 'undefined' || typeof setTimeout === 'undefined') return;
  setTimeout(() => {
    const control = document.getElementById(trackSelectionControlId(trackId));
    if (!control) return;
    control.focus();
    control.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, 0);
}

/** Restore keyboard focus when a valid legacy project has no remaining tracks. */
export function focusTrackAddControl(): void {
  if (typeof document === 'undefined' || typeof setTimeout === 'undefined') return;
  setTimeout(() => document.getElementById(TRACK_ADD_CONTROL_ID)?.focus(), 0);
}
