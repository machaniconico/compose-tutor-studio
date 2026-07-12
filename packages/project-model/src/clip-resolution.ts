import type { Clip, Project, Track } from './types';

export type LocatedClip = Readonly<{
  track: Track;
  clip: Clip;
}>;

export type ClipIndex = ReadonlyMap<string, LocatedClip>;

/** Build one lookup table for consumers that resolve many timeline instances. */
export function buildClipIndex(project: Project): ClipIndex {
  const index = new Map<string, LocatedClip>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!index.has(clip.id)) index.set(clip.id, { track, clip });
    }
  }
  return index;
}

/** Locate a clip and its owning track without trusting clip.trackId. */
export function findClip(project: Project, clipId: string): LocatedClip | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** Resolve the schema-v2 one-hop direct/canonical linked payload owner. */
export function resolveClipSource(
  project: Project,
  instance: Clip,
  index: ClipIndex = buildClipIndex(project),
): Clip | null {
  const sourceId = instance.aliasOf;
  if (sourceId === undefined) return instance;
  const located = index.get(sourceId);
  if (
    !located
    || located.clip.id === instance.id
    || located.track.id !== instance.trackId
    || located.clip.trackId !== instance.trackId
    || located.clip.type !== instance.type
    || located.clip.aliasOf !== undefined
  ) {
    return null;
  }
  return located.clip;
}

/** Return the id mutations must write to when an alias is being edited. */
export function clipContentOwnerId(project: Project, clipId: string): string | null {
  const index = buildClipIndex(project);
  const located = index.get(clipId);
  if (!located) return null;
  return resolveClipSource(project, located.clip, index)?.id ?? null;
}

/** Project instance placement together with source-owned payload. */
export function resolveClipContent(
  project: Project,
  instance: Clip,
  index: ClipIndex = buildClipIndex(project),
): Clip | null {
  const source = resolveClipSource(project, instance, index);
  if (!source) return null;
  if (source.id === instance.id) return instance;

  return {
    ...source,
    id: instance.id,
    trackId: instance.trackId,
    type: instance.type,
    startBeat: instance.startBeat,
    lengthBeats: instance.lengthBeats,
    loop: instance.loop,
    aliasOf: source.id,
  };
}
