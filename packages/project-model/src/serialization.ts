// Project (de)serialization with a forward-migration scaffold.
//
// Projects carry a `schemaVersion`. On load, any project with an older version
// is run through the registered migration functions in sequence until it
// reaches CURRENT_SCHEMA_VERSION.

import { resolveLinkSource } from './clipExpand';
import { MAX_SONG_BARS, MIN_LOOP_PERIOD_BEATS } from './sounding';
import { CURRENT_SCHEMA_VERSION } from './factories';
import { beatTick, beatsPerBar, PPQ } from './time';
import type { Clip, Project, Track, TrackRole } from './types';

const UTF8_BOM = '\uFEFF';
const DEFAULT_STEPS_PER_BAR = 16;
const DEFAULT_DRUM_BEATS_PER_BAR = 4;
const MIN_LEGACY_EVENT_ROOM_BEATS = 1 / PPQ;

/** Track-name words that imply a role, matched as whole words in any case. */
const ROLE_NAME_PATTERNS: Array<[RegExp, TrackRole]> = [
  [/(?<![a-z])chords?(?![a-z])/i, 'chords'],
  [/(?<![a-z])bass(?![a-z])/i, 'bass'],
  [/(?<![a-z])(?:melody|lead)(?![a-z])/i, 'melody'],
];

/**
 * A migration upgrades a raw project object from `from` to `to`.
 * Migrations operate on loosely-typed records because older shapes may differ
 * from the current Project type.
 */
export type Migration = {
  from: number;
  to: number;
  migrate: (project: Record<string, unknown>) => Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The file's time signature, or 4/4 when it is missing or malformed. */
function timeSignatureOf(raw: unknown): [number, number] {
  if (!Array.isArray(raw) || raw.length !== 2) return [DEFAULT_DRUM_BEATS_PER_BAR, 4];
  const [num, den] = raw as unknown[];
  if (typeof num !== 'number' || typeof den !== 'number' || num <= 0 || den <= 0) {
    return [DEFAULT_DRUM_BEATS_PER_BAR, 4];
  }
  return [num, den];
}

/**
 * v1 counted a bar as `numerator` quarter-note beats (6/8 = 6 beats); v2 uses
 * `beatsPerBar` (6/8 = 3). Scaling bars by this factor keeps the old beat
 * positions, which is what the file was heard as. 1 for every `x/4` meter.
 */
function legacyBarScale(den: number): number {
  return den / 4;
}

/**
 * Regrid a v1 drum clip so every hit keeps the beat it was heard at: step `i`
 * sat at `i * numerator / stepsPerBar` beats, so a quarter-note bar needs
 * `stepsPerBar * 4 / den` steps. When that is not whole, the grid is made
 * `den` times finer instead and the step numbers scaled up, still exactly.
 */
function regridLegacyDrumClip(clip: Record<string, unknown>, den: number): Record<string, unknown> {
  if (den === 4 || !Array.isArray(clip.drumEvents)) return clip;
  const stepsPerBar =
    typeof clip.stepsPerBar === 'number' && clip.stepsPerBar > 0
      ? clip.stepsPerBar
      : DEFAULT_STEPS_PER_BAR;
  const exactSteps = (stepsPerBar * 4) / den;
  if (Number.isInteger(exactSteps)) return { ...clip, stepsPerBar: exactSteps };
  const drumEvents = clip.drumEvents.map((event: unknown) =>
    isRecord(event) && typeof event.stepIndex === 'number'
      ? { ...event, stepIndex: event.stepIndex * den }
      : event,
  );
  return { ...clip, stepsPerBar: stepsPerBar * 4, drumEvents };
}

/** Bars counted the v1 way, re-expressed in v2 bars (rounded up, at least 1). */
function legacyBarsToV2(bars: unknown, scale: number): unknown {
  return typeof bars === 'number' ? Math.max(1, Math.ceil(bars * scale - 1e-9)) : bars;
}

/** Sections keep their beat span: bar numbers are scaled, snapped to whole bars. */
function regridLegacySection(section: Record<string, unknown>, scale: number): Record<string, unknown> {
  if (typeof section.startBar !== 'number' || typeof section.lengthBars !== 'number') return section;
  const startBar = Math.round(section.startBar * scale);
  const endBar = Math.round((section.startBar + section.lengthBars) * scale);
  return { ...section, startBar, lengthBars: Math.max(1, endBar - startBar) };
}

/** Clip length needed to preserve every legacy note. */
function clipNoteEnd(clip: Record<string, unknown>): number {
  return records(clip.notes).reduce((end, note) => {
    const noteEnd = Number(note.startBeat) + Math.max(Number(note.durationBeats), MIN_LEGACY_EVENT_ROOM_BEATS);
    return Number.isFinite(noteEnd) ? Math.max(end, noteEnd) : end;
  }, 0);
}

/** Keep the full content of a clip that used to play beyond its saved length. */
function fitLegacyClipLength(clip: Record<string, unknown>, beatsPerBar: number): Record<string, unknown> {
  if (typeof clip.lengthBeats !== 'number') return clip;
  const stepsPerBar =
    typeof clip.stepsPerBar === 'number' && clip.stepsPerBar > 0
      ? clip.stepsPerBar
      : DEFAULT_STEPS_PER_BAR;
  const lengthBeats = records(clip.drumEvents).reduce((end, drum) => {
    const stepLength = beatsPerBar / stepsPerBar;
    const stepEnd = Number(drum.stepIndex) * stepLength + Math.max(stepLength, MIN_LEGACY_EVENT_ROOM_BEATS);
    return Number.isFinite(stepEnd) ? Math.max(end, stepEnd) : end;
  }, Math.max(clip.lengthBeats, clipNoteEnd(clip)));
  return { ...clip, lengthBeats };
}

/** Prioritize legacy live/WAV timing, and retain settings that playback used to ignore. */
function preserveLegacyClipPlayback(raw: Record<string, unknown>, bpb: number): Record<string, unknown> {
  const { aliasOf, contentLengthBeats, ...clip } = raw;
  if (clip.loop === true || aliasOf !== undefined || contentLengthBeats !== undefined) {
    clip.legacyClipSettings = {
      loop: clip.loop === true,
      ...(aliasOf !== undefined ? { aliasOf } : {}),
      ...(contentLengthBeats !== undefined ? { contentLengthBeats } : {}),
    };
    clip.loop = false;
  }
  return fitLegacyClipLength(clip, bpb);
}

function inferTrackRole(track: Record<string, unknown>): TrackRole | undefined {
  if (track.type === 'drum') return 'drums';
  if (track.type === 'master' || typeof track.name !== 'string') return undefined;
  const name = track.name;
  return ROLE_NAME_PATTERNS.find(([pattern]) => pattern.test(name))?.[1];
}

/**
 * v1 -> v2. Before v2 playback ignored `lengthBeats` and sounded every note, and
 * the master gain was always 1 whatever `volume` said. Both are written into the
 * file here so that later readers of those fields keep the old sound. v1 also
 * counted a bar as `numerator` beats, so for meters other than `x/4` the song
 * length, the sections and the drum grids are re-expressed in quarter-note bars
 * (see `legacyBarScale`) so that nothing moves or is cut off.
 */
function migrateV1ToV2(project: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(project.tracks)) return { ...project };
  const [num, den] = timeSignatureOf(project.timeSignature);
  const bpb = beatsPerBar([num, den]);
  const scale = legacyBarScale(den);

  const tracks = project.tracks.map((track: unknown) => {
    if (!isRecord(track)) return track;
    const role = inferTrackRole(track);
    const clips = Array.isArray(track.clips)
      ? track.clips.map((raw: unknown) => {
          if (!isRecord(raw)) return raw;
          return preserveLegacyClipPlayback(regridLegacyDrumClip(raw, den), bpb);
        })
      : track.clips;
    return {
      ...track,
      clips,
      ...(role !== undefined ? { role } : {}),
      ...(track.type === 'master' ? { volume: 1 } : {}),
    };
  });

  if (scale === 1) return { ...project, tracks };
  const sections = Array.isArray(project.sections)
    ? project.sections.map((section: unknown) =>
        isRecord(section) ? regridLegacySection(section, scale) : section,
      )
    : project.sections;
  return { ...project, tracks, sections, lengthBars: legacyBarsToV2(project.lengthBars, scale) };
}

/** v2 -> v3. Keep playing each clip's own content once, as v2 live playback and WAV did. */
function migrateV2ToV3(project: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(project.tracks)) return { ...project };
  const bpb = beatsPerBar(timeSignatureOf(project.timeSignature));
  const tracks = project.tracks.map((track: unknown) => {
    if (!isRecord(track) || !Array.isArray(track.clips)) return track;
    // v2 synthesized notes on audio and bus tracks too. Keep their preset,
    // routing, mixer and effects on the same track.
    const type = (track.type === 'bus' || track.type === 'audio') &&
      track.clips.some((clip: unknown) => isRecord(clip) && records(clip.notes).length > 0)
      ? 'instrument'
      : track.type;
    const clips = track.clips.map((raw: unknown) => {
      if (!isRecord(raw)) return raw;
      return preserveLegacyClipPlayback(raw, bpb);
    });
    return { ...track, type, clips };
  });
  return { ...project, tracks };
}

/**
 * Registry of migrations keyed by source version. New migrations should be
 * appended here as `{ from: N, to: N + 1, migrate }` when the schema changes.
 * Optional fields can be added without a new version.
 */
export const MIGRATIONS: Migration[] = [
  { from: 1, to: 2, migrate: migrateV1ToV2 },
  { from: 2, to: 3, migrate: migrateV2ToV3 },
];

/** Serialize a project to a pretty-printed JSON string. */
export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

/**
 * Apply registered migrations to a raw project object until it reaches the
 * current schema version. Exported for testing.
 */
export function migrateProject(raw: Record<string, unknown>): Record<string, unknown> {
  let current = raw;
  let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 0;

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Project schemaVersion ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((m) => m.from === version);
    if (!migration) {
      throw new Error(`No migration registered from schemaVersion ${version}`);
    }
    current = migration.migrate(current);
    current.schemaVersion = migration.to;
    version = migration.to;
  }

  return current;
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
    lengthBars: Math.min(project.lengthBars, MAX_SONG_BARS),
    tracks: project.tracks.flatMap(fitTrack),
  };
}
