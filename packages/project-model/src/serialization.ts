import { resolveLinkSource } from './clipExpand';
import { migrateProject } from './migrate';
import { maxSongBars, MIN_LOOP_PERIOD_BEATS } from './sounding';
import { beatTick } from './time';
import type { Clip, Project, Track } from './types';

export { MIGRATIONS, migrateProject, type Migration } from './migrate';

const UTF8_BOM = '\uFEFF';

/** Serialize a project to a pretty-printed JSON string. */
export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

/**
 * Deserialize a project from a JSON string, applying migrations as needed.
 * Throws if the JSON is invalid or the schema version is unsupported.
 */
export function deserializeProject(json: string): Project {
  const parsed: unknown = JSON.parse(stripLeadingBom(json));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid project JSON: expected an object');
  }
  const migrated = migrateProject(parsed as Record<string, unknown>);
  return normalizeClipDomain(migrated as unknown as Project);
}

function stripLeadingBom(json: string): string {
  return json.startsWith(UTF8_BOM) ? json.slice(UTF8_BOM.length) : json;
}

/** Repair clip settings and preserve all stored material at its original beat. */
function normalizeClipDomain(project: Project): Project {
  // Structural errors are reported by the caller's normal validation.
  if (!Array.isArray(project.tracks) || project.tracks.some((track) => !Array.isArray(track?.clips))) return project;
  const clips = project.tracks.flatMap((track) => track.clips);
  if (clips.some((clip) => !clip || typeof clip !== 'object')) return project;
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const ids = new Set([
    project.id,
    ...project.tracks.map((track) => track.id),
    ...clips.flatMap((clip) => [
      clip.id, ...(clip.notes ?? []).map((note) => note.id), ...(clip.drumEvents ?? []).map((hit) => hit.id),
    ]),
    ...(project.chordTrack ?? []).map((chord) => chord.id),
    ...(project.sections ?? []).map((section) => section.id),
  ]);

  function normalizeClip(clip: Clip): Clip {
    let next = clip;
    if (clip.aliasOf !== undefined) {
      const source = resolveLinkSource(clip, byId);
      const ownsContent = Boolean(clip.notes?.length || clip.drumEvents?.length || clip.audioAssetId !== undefined);
      if (ownsContent || typeof source === 'string' || source.type !== clip.type) {
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

  function fitTrack(raw: Track): Track[] {
    const track = typeof raw.name === 'string' ? raw : { ...raw, name: '名前のないトラック' };
    const normalized = track.clips.map(normalizeClip);
    const sorted = [...normalized].sort((a, b) => a.startBeat - b.startBeat);
    const base: Clip[] = [];
    const layers: Array<{ id: string; endTick: number; clips: Clip[] }> = [];
    let baseEnd = 0;
    for (const clip of sorted) {
      const start = beatTick(clip.startBeat);
      const end = beatTick(clip.startBeat + clip.lengthBeats);
      if (start >= baseEnd || end <= start) {
        base.push(clip);
        baseEnd = Math.max(baseEnd, end);
        continue;
      }
      let layer = layers.find((candidate) => candidate.endTick <= start);
      if (!layer) {
        let suffix = layers.length + 1;
        while (ids.has(`${track.id}-overlap-${suffix}`)) suffix++;
        const id = `${track.id}-overlap-${suffix}`;
        ids.add(id);
        layer = { id, endTick: 0, clips: [] };
        layers.push(layer);
      }
      layer.clips.push({ ...clip, trackId: layer.id });
      layer.endTick = end;
    }
    // Keep the original clip order on the original track.
    const keep = new Set(base);
    return [
      { ...track, clips: normalized.filter((clip) => keep.has(clip)) },
      ...layers.map(({ id, clips }) => ({ ...track, id, clips })),
    ];
  }

  return {
    ...project,
    lengthBars: Math.min(project.lengthBars, maxSongBars(project)),
    tracks: project.tracks.flatMap(fitTrack),
  };
}
