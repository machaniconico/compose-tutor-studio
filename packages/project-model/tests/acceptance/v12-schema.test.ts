// P23 acceptance tests (schema v12). Written BEFORE the implementation; implementers must not edit.
//
// API contract under test (packages/project-model):
// - CURRENT_SCHEMA_VERSION === 12.
// - `AutomationTarget['type']` gains `'track-filter-cutoff'`. No new Project field, no new lane field.
// - The stored point value of a cutoff lane is an OCTAVE OFFSET (log2 of the frequency ratio):
//   finite, within [-log2(10), +log2(10)] inclusive. 0 means "no change". Interpolation is main's
//   existing `hold` / `linear` over that offset (so linear-in-offset is the log-frequency curve).
// - Supported tracks: `type === 'instrument'` ONLY. Drum, bus, audio and master tracks reject it.
//   * `automationTargetTypesForTrack(project, id)` includes 'track-filter-cutoff' for an instrument
//     track (alongside 'track-volume' and 'track-pan') and never for drum / bus / audio / master.
//   * `isSupportedAutomationTarget(project, { type: 'track-filter-cutoff', trackId })` agrees.
//   * `validateProject` reports an unsupported cutoff target at path
//     `automationLanes[i].target.trackId`.
// - `validateProject` reports an out-of-range / non-finite / non-number cutoff value at path
//   `automationLanes[i].points[j].value`. A second lane with the same (type, trackId) is reported at
//   `automationLanes[i].target` (one cutoff lane per track). A cutoff lane and a volume or pan lane on
//   the same track may coexist.
// - `addAutomationPoint` (mutation API) accepts the new target type on an instrument track with the
//   same ±log2(10) value rule (failure code `invalid-value`), reuses the single lane, and fails with
//   `invalid-target` for an unsupported track type.
// - `removeTrack` (lives in project-model) drops the removed track's cutoff lane like its other lanes.
// - migrateProject v11 -> v12 changes ONLY `schemaVersion` (input not mutated, no new keys).
// - decodeProject (strict codec) decodes against the file's own schema version: a v11 file whose
//   lane target type is 'track-filter-cutoff' is rejected with an issue at path
//   `automationLanes[0].target.type`; the same record as v12 decodes. v12 encode -> decode round-trips.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  addAutomationPoint,
  addTrack,
  automationTargetTypesForTrack,
  createEmptyProject,
  createTrack,
  decodeProject,
  encodeProjectJson,
  isSupportedAutomationTarget,
  migrateProject,
  removeTrack,
  validateProject,
  type AutomationLane,
  type Project,
  type Track,
} from '../../src';

const clock = () => new Date('2026-01-01T00:00:00.000Z');
const FIXTURES = join(import.meta.dirname, '..', 'golden', 'fixtures');
const MAX_OCTAVES = Math.log2(10);
const CUTOFF = 'track-filter-cutoff' as const;

function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Record<string, unknown>;
}

function trackNamed(project: Project, name: string): Track {
  const track = project.tracks.find((candidate) => candidate.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track;
}

function cutoffLane(
  trackId: string,
  values: readonly number[] = [0, 1],
  id = 'lane-cutoff',
): AutomationLane {
  return {
    id,
    bypassed: false,
    target: { type: CUTOFF, trackId },
    points: values.map((value, index) => ({
      id: `${id}-p${index}`,
      beat: index,
      value,
      interpolation: 'linear',
    })),
  };
}

/** A project carrying one cutoff lane on the Melody (instrument) track. */
function projectWithCutoff(values: readonly number[] = [0, 1]): Project {
  const project = createEmptyProject({ clock });
  project.automationLanes.push(cutoffLane(trackNamed(project, 'Melody').id, values));
  return project;
}

function errorPaths(project: Project): string[] {
  return validateProject(project).errors.map((error) => error.path);
}

describe('P23 v12 schema', () => {
  it('migrate_v11ToV12_isVersionOnly', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(12);
    // A v11 file is the v12 shape with schemaVersion 11 (v12 adds no field).
    const v11 = structuredClone(createEmptyProject({ clock })) as unknown as Record<string, unknown>;
    v11.schemaVersion = 11;
    const before = structuredClone(v11);
    const migrated = migrateProject(v11);
    expect(v11).toEqual(before); // input is not mutated
    expect(migrated).toEqual({ ...before, schemaVersion: 12 });
    // The full chain from an older fixture still lands on exactly one extra version bump.
    const v10 = fixture('v10-automation-routing.json');
    expect(migrateProject(v10)).toEqual({ ...v10, schemaVersion: 12, swing: 0, hiHatChoke: false });
  });

  it('target_cutoff_supportedOnlyForInstrumentTracks', () => {
    const project = createEmptyProject({ clock });
    const bus = addTrack(project, 'bus');
    if (!bus.ok) throw new Error(bus.error.message);
    const audio = createTrack('Voice', 'audio');
    const withBus = bus.project;
    const candidates: Array<[string, string, boolean]> = [
      ['instrument', trackNamed(withBus, 'Melody').id, true],
      ['instrument (second)', trackNamed(withBus, 'Bass').id, true],
      ['drum', trackNamed(withBus, 'Drums').id, false],
      ['master', trackNamed(withBus, 'Master').id, false],
      ['bus', bus.trackId, false],
      ['audio', audio.id, false],
    ];
    const withAudio: Project = { ...withBus, tracks: [audio, ...withBus.tracks] };
    for (const [label, trackId, supported] of candidates) {
      expect(
        automationTargetTypesForTrack(withAudio, trackId).includes(CUTOFF),
        `${label}: automationTargetTypesForTrack`,
      ).toBe(supported);
      expect(
        isSupportedAutomationTarget(withAudio, { type: CUTOFF, trackId }),
        `${label}: isSupportedAutomationTarget`,
      ).toBe(supported);
    }
    // Instrument tracks keep volume and pan.
    const melodyTypes = automationTargetTypesForTrack(withAudio, trackNamed(withAudio, 'Melody').id);
    expect(melodyTypes).toContain('track-volume');
    expect(melodyTypes).toContain('track-pan');

    // validateProject: a lane on an unsupported track is reported at the target trackId.
    const lanes: Array<[string, string]> = [
      ['drum', trackNamed(withBus, 'Drums').id],
      ['master', trackNamed(withBus, 'Master').id],
      ['bus', bus.trackId],
    ];
    for (const [label, trackId] of lanes) {
      const bad: Project = { ...withBus, automationLanes: [cutoffLane(trackId, [0])] };
      expect(errorPaths(bad), label).toContain('automationLanes[0].target.trackId');
    }
    // Positive control: the same lane on an instrument track validates.
    const good: Project = {
      ...withBus,
      automationLanes: [cutoffLane(trackNamed(withBus, 'Melody').id, [0, 1])],
    };
    expect(validateProject(good).ok).toBe(true);

    // Mutation API agrees: accepted for an instrument, invalid-target for a drum track.
    const fresh = createEmptyProject({ clock });
    const added = addAutomationPoint(fresh, {
      target: { type: CUTOFF, trackId: trackNamed(fresh, 'Melody').id },
      beat: 1,
      value: 0.5,
      interpolation: 'linear',
    });
    expect(added.ok).toBe(true);
    const rejected = addAutomationPoint(withBus, {
      target: { type: CUTOFF, trackId: trackNamed(withBus, 'Drums').id },
      beat: 1,
      value: 0.5,
      interpolation: 'linear',
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('invalid-target');
  });

  it('validate_cutoffValue_isOctaveOffset_withinPlusMinusLog2Of10', () => {
    // Positive controls: inside the range and exactly on both boundaries.
    for (const ok of [0, 1, -1, 0.5, MAX_OCTAVES, -MAX_OCTAVES]) {
      const result = validateProject(projectWithCutoff([ok]));
      expect(result.ok, `value=${ok}`).toBe(true);
    }
    // Just outside the boundaries, non-finite, and non-number values are rejected at the value path.
    const outside = [
      MAX_OCTAVES + 1e-9,
      -MAX_OCTAVES - 1e-9,
      MAX_OCTAVES + 0.01,
      -MAX_OCTAVES - 0.01,
      4,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '1' as unknown as number,
      null as unknown as number,
    ];
    for (const bad of outside) {
      const paths = errorPaths(projectWithCutoff([bad]));
      expect(paths, `value=${String(bad)}`).toContain('automationLanes[0].points[0].value');
    }
    // The mutation API applies the same bound (and the volume range 0..2 does not leak into it).
    const base = createEmptyProject({ clock });
    const trackId = trackNamed(base, 'Melody').id;
    const at = (value: number) => addAutomationPoint(base, {
      target: { type: CUTOFF, trackId }, beat: 1, value, interpolation: 'linear',
    });
    expect(at(MAX_OCTAVES).ok).toBe(true);
    expect(at(-MAX_OCTAVES).ok).toBe(true);
    for (const bad of [MAX_OCTAVES + 1e-9, -MAX_OCTAVES - 1e-9, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = at(bad);
      expect(result.ok, `mutation value=${String(bad)}`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-value');
    }
  });

  it('validate_oneCutoffLanePerTrack', () => {
    const project = createEmptyProject({ clock });
    const melody = trackNamed(project, 'Melody').id;
    const bass = trackNamed(project, 'Bass').id;
    // Positive control: one cutoff lane on each of two tracks, plus a volume lane beside a cutoff lane.
    const fine: Project = {
      ...project,
      automationLanes: [
        cutoffLane(melody, [0, 1], 'a'),
        cutoffLane(bass, [0, 1], 'b'),
        {
          id: 'vol',
          bypassed: false,
          target: { type: 'track-volume', trackId: melody },
          points: [{ id: 'vol-p0', beat: 0, value: 1, interpolation: 'linear' }],
        },
      ],
    };
    expect(validateProject(fine).ok).toBe(true);
    // Two cutoff lanes for the same track are rejected at the second lane's target.
    const dup: Project = {
      ...project,
      automationLanes: [cutoffLane(melody, [0, 1], 'a'), cutoffLane(melody, [0, 0.5], 'b')],
    };
    expect(validateProject(dup).ok).toBe(false);
    expect(errorPaths(dup)).toContain('automationLanes[1].target');
    // The mutation API reuses the one lane instead of creating a second.
    const first = addAutomationPoint(project, {
      target: { type: CUTOFF, trackId: melody }, beat: 0, value: 0, interpolation: 'linear',
    });
    if (!first.ok) throw new Error(first.error.message);
    const second = addAutomationPoint(first.project, {
      target: { type: CUTOFF, trackId: melody }, beat: 2, value: 1, interpolation: 'linear',
    });
    if (!second.ok) throw new Error(second.error.message);
    const cutoffLanes = second.project.automationLanes.filter((lane) => lane.target.type === CUTOFF);
    expect(cutoffLanes).toHaveLength(1);
    expect(cutoffLanes[0]!.points).toHaveLength(2);
  });

  it('removeTrack_removesItsCutoffLane', () => {
    // The default Melody/Bass tracks are protected Learning-role tracks, so add a removable one.
    const base = createEmptyProject({ clock });
    const added = addTrack(base, 'instrument');
    if (!added.ok) throw new Error(added.error.message);
    const project = added.project;
    const removable = added.trackId;
    const bass = trackNamed(project, 'Bass').id;
    project.automationLanes.push(cutoffLane(removable, [0, 1], 'removable-cutoff'));
    project.automationLanes.push(cutoffLane(bass, [0, 1], 'bass-cutoff'));
    expect(validateProject(project).ok).toBe(true);
    const removed = removeTrack(project, removable);
    if (!removed.ok) throw new Error(removed.error.message);
    expect(removed.project.automationLanes.map((lane) => lane.id)).toEqual(['bass-cutoff']);
    expect(validateProject(removed.project).ok).toBe(true);
  });

  it('codec_v11File_withCutoffTarget_isRejected', () => {
    const v12 = projectWithCutoff([0, 1]);
    // Positive control: the same record as v12 decodes.
    const asV12 = decodeProject(structuredClone(v12));
    expect(asV12.ok).toBe(true);
    // As a v11 file it is rejected: the v11 target enum does not contain the cutoff target.
    const v11 = structuredClone(v12) as unknown as Record<string, unknown>;
    v11.schemaVersion = 11;
    const result = decodeProject(v11);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: 'automationLanes[0].target.type' }),
      );
    }
    // Control: a clean v11 file (volume lane only) still decodes and is migrated to v12.
    const clean = structuredClone(createEmptyProject({ clock })) as unknown as Record<string, unknown>;
    clean.schemaVersion = 11;
    const cleanResult = decodeProject(clean);
    expect(cleanResult.ok).toBe(true);
    if (cleanResult.ok) {
      expect(cleanResult.migrated).toBe(true);
      expect(cleanResult.project.schemaVersion).toBe(12);
    }
  });

  it('codec_v12_withCutoffLane_roundTrips', () => {
    const project = projectWithCutoff([0, MAX_OCTAVES, -MAX_OCTAVES, 0.25]);
    expect(project.schemaVersion).toBe(12);
    const encoded = encodeProjectJson(project);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeProject(JSON.parse(encoded.json) as unknown);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.migrated).toBe(false);
    expect(decoded.project).toEqual(project);
  });
});
