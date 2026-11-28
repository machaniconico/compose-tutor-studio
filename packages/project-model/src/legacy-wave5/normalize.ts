// Wave5 v3 load normalization frozen from d85f796 (serialization.ts,
// clipExpand.ts and sounding.ts). The converter collects diagnostics here
// while leaving the original repair decisions and track ordering intact.
// Wave5's migrateProject returns a v3 input as-is.
import { beatTick } from '../ticks';
import { MAX_PROJECT_TRACKS } from '../validation';
import { OverLimit, type LegacyClip, type LegacyProject, type LegacyTrack } from './input';

const MIN_LOOP_PERIOD_BEATS = 1 / 64;

type LinkProblem = 'missing' | 'cyclic' | 'type-mismatch' | 'owns-content';

type LinkSource = LegacyClip | 'missing' | 'cyclic';

function resolveLinkSource(
  clip: LegacyClip, byId: ReadonlyMap<string, LegacyClip>, resolved: Map<string, LinkSource>,
): LinkSource {
  const visited = new Set<string>();
  let current = clip;
  let source: LinkSource;
  while (true) {
    const cached = resolved.get(current.id);
    if (cached !== undefined) {
      source = cached;
      break;
    }
    if (current.aliasOf === undefined) {
      source = current;
      break;
    }
    if (visited.has(current.aliasOf) || current.aliasOf === current.id) {
      source = 'cyclic';
      break;
    }
    visited.add(current.id);
    const target = byId.get(current.aliasOf);
    if (target === undefined) {
      source = 'missing';
      break;
    }
    current = target;
  }
  for (const id of visited) resolved.set(id, source);
  resolved.set(current.id, source);
  return source;
}

function maxSongBars({ legacyBarLimit }: LegacyProject): number {
  return legacyBarLimit !== undefined && Number.isInteger(legacyBarLimit)
    && legacyBarLimit > 64 && legacyBarLimit <= 256 ? legacyBarLimit : 64;
}

/** Repair clip settings and preserve all stored material at its original beat. */
export function normalizeClipDomain(project: LegacyProject): {
  project: LegacyProject;
  linkProblems: Map<string, LinkProblem>;
  overlapLayers: Map<string, number>;
  extraTracks: Set<string>;
} {
  const lengthBars = Math.min(project.lengthBars, maxSongBars(project));
  const [numerator, denominator] = project.timeSignature;
  const beatsPerBar = numerator * (4 / denominator);
  const songEndTick = beatTick(lengthBars * beatsPerBar);
  // Every original track is retained. Extra tracks only hold surviving clips.
  let trackCount = project.tracks.length;
  if (trackCount > MAX_PROJECT_TRACKS) throw new OverLimit();
  const linkProblems = new Map<string, LinkProblem>();
  const overlapLayers = new Map<string, number>();
  const extraTracks = new Set<string>();
  const clips = project.tracks.flatMap((track) => track.clips);
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  if (byId.size !== clips.length) throw new TypeError('Ambiguous Wave5 clip ID');
  const linkSources = new Map<string, LinkSource>();
  const ids = new Set([
    project.id,
    ...project.tracks.map((track) => track.id),
    ...clips.flatMap((clip) => [
      clip.id, ...(clip.notes ?? []).map((note) => note.id), ...(clip.drumEvents ?? []).map((hit) => hit.id),
    ]),
    ...(project.chordTrack ?? []).map((chord) => chord.id),
    ...(project.sections ?? []).map((section) => section.id),
  ]);

  function normalizeClip(clip: LegacyClip): LegacyClip {
    let next = clip;
    if (clip.aliasOf !== undefined) {
      const source = resolveLinkSource(clip, byId, linkSources);
      const ownsContent = Boolean(clip.notes?.length || clip.drumEvents?.length || clip.audioAssetId !== undefined);
      if (ownsContent || typeof source === 'string' || source.type !== clip.type) {
        linkProblems.set(clip.id, ownsContent ? 'owns-content' : typeof source === 'string' ? source : 'type-mismatch');
        next = { ...clip };
        delete next.aliasOf;
      } else if (source.id !== clip.aliasOf) {
        next = { ...clip, aliasOf: source.id };
      }
    }
    if (next.loop && (next.contentLengthBeats ?? next.lengthBeats) < MIN_LOOP_PERIOD_BEATS) {
      next = { ...next, contentLengthBeats: MIN_LOOP_PERIOD_BEATS };
    }
    return next;
  }

  function fitTrack(raw: LegacyTrack): LegacyTrack[] {
    const track = typeof raw.name === 'string' ? raw : { ...raw, name: '名前のないトラック' };
    const normalized = track.clips.map(normalizeClip);
    const sorted = [...normalized].sort((a, b) => a.startBeat - b.startBeat);
    const base: LegacyClip[] = [];
    const layers: Array<{ id: string; clips: LegacyClip[] }> = [];
    // Find the first free layer while retaining Wave5's layer order.
    const leafCount = 2 ** Math.ceil(Math.log2(MAX_PROJECT_TRACKS));
    const endTicks = new Float64Array(leafCount * 2).fill(-Infinity);
    let suffix = 1;
    let baseEnd = 0;
    for (const clip of sorted) {
      const start = beatTick(clip.startBeat);
      const end = beatTick(clip.startBeat + clip.lengthBeats);
      if (start >= songEndTick || end <= start) {
        // Keep the original payload available for link resolution and reporting.
        base.push(clip);
        continue;
      }
      if (start >= baseEnd) {
        base.push(clip);
        baseEnd = end;
        continue;
      }
      let node = 1;
      while (node < leafCount) {
        node *= 2;
        if (endTicks[node]! > start) node++;
      }
      const index = node - leafCount;
      let layer = layers[index];
      if (!layer) {
        if (++trackCount > MAX_PROJECT_TRACKS) throw new OverLimit();
        while (ids.has(`${track.id}-overlap-${suffix}`)) suffix++;
        const id = `${track.id}-overlap-${suffix}`;
        ids.add(id);
        suffix++;
        layer = { id, clips: [] };
        layers.push(layer);
      }
      layer.clips.push({ ...clip, trackId: layer.id });
      endTicks[node] = end;
      while (node > 1) {
        node = Math.floor(node / 2);
        endTicks[node] = Math.min(endTicks[node * 2]!, endTicks[node * 2 + 1]!);
      }
    }
    if (layers.length > 0) overlapLayers.set(track.id, layers.length);
    for (const layer of layers) extraTracks.add(layer.id);
    // Keep the original clip order on the original track.
    const keep = new Set(base);
    return [
      { ...track, clips: normalized.filter((clip) => keep.has(clip)) },
      ...layers.map(({ id, clips }) => ({ ...track, id, clips })),
    ];
  }

  return {
    project: {
      ...project,
      lengthBars,
      tracks: project.tracks.flatMap(fitTrack),
    },
    linkProblems,
    overlapLayers,
    extraTracks,
  };
}
