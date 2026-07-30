import type { Clip, Project } from '@cts/project-model';

/**
 * Build the immutable runtime snapshot used for an original-vs-corrected
 * audition. Only the selected clip bypasses pitch correction; timing, Project
 * state, history, persistence, WAV export, and every other clip stay intact.
 */
export function projectForAudioWarpAudition(
  project: Project,
  bypassClipId: string | null,
): Project {
  if (bypassClipId === null) return project;

  let changed = false;
  const tracks = project.tracks.map((track) => {
    const clips = track.clips.map((clip): Clip => {
      if (
        clip.id !== bypassClipId
        || clip.type !== 'audio'
        || clip.audioWarp === undefined
        || !clip.audioWarp.pitchEnabled
        || clip.audioWarp.pitchRegions.length === 0
      ) {
        return clip;
      }
      changed = true;
      return {
        ...clip,
        audioWarp: {
          ...clip.audioWarp,
          pitchEnabled: false,
        },
      };
    });
    return changed && clips.some((clip, index) => clip !== track.clips[index])
      ? { ...track, clips }
      : track;
  });

  return changed ? { ...project, tracks } : project;
}
