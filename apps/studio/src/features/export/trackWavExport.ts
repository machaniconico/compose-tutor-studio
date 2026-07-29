import type { Project, Track } from '@cts/project-model';
import { safeFileStem } from './download';

export type SelectedTrackWavAvailability = Readonly<{
  track: Track | null;
  enabled: boolean;
  reason: string | null;
}>;

export function selectedTrackWavAvailability(
  project: Project,
  trackId: string | null,
): SelectedTrackWavAvailability {
  const track = trackId === null
    ? null
    : project.tracks.find((candidate) => candidate.id === trackId) ?? null;
  if (!track) {
    return { track: null, enabled: false, reason: '楽器、ドラム、またはオーディオトラックを選択してください。' };
  }
  if (track.type === 'master') {
    return { track, enabled: false, reason: 'Masterは選択トラックWAVの対象外です。' };
  }
  if (track.type === 'bus') {
    return { track, enabled: false, reason: 'Busは選択トラックWAVの対象外です。' };
  }
  return { track, enabled: true, reason: null };
}

export function selectedTrackWavFileName(projectName: string, trackName: string): string {
  return `${safeFileStem(projectName)} - ${safeFileStem(trackName)}.wav`;
}
