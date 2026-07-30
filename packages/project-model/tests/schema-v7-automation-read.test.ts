import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  addTrack,
  createEmptyProject,
  decodeProject,
  duplicateTrack,
  migrateProject,
  removeTrack,
  setGlobalAutomationReadEnabled,
  setTrackAutomationReadEnabled,
  validateProject,
  type Project,
} from '../src/index';

const clock = () => new Date('2026-07-30T00:00:00.000Z');

function issue(input: unknown, path: string, code?: string): void {
  const decoded = decodeProject(input);
  expect(decoded.ok).toBe(false);
  if (decoded.ok) return;
  expect(decoded.error.issues).toContainEqual(expect.objectContaining({
    path,
    ...(code === undefined ? {} : { code }),
  }));
}

describe('schema-v7 Automation Read state', () => {
  it('migrates v6 by adding only enabled/empty Read state and preserves the v1 chain', () => {
    const current = createEmptyProject({ clock });
    const v6 = structuredClone(current) as unknown as Record<string, unknown>;
    v6.schemaVersion = 6;
    delete v6.automationReadState;
    const before = structuredClone(v6);

    expect(CURRENT_SCHEMA_VERSION).toBe(10);
    expect(migrateProject(v6)).toEqual({
      ...v6,
      schemaVersion: 10,
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    });
    expect(v6).toEqual(before);

    const v1 = structuredClone(current) as unknown as Record<string, unknown>;
    v1.schemaVersion = 1;
    for (const key of [
      'lengthBeats',
      'tempoMap',
      'timeSignatureMap',
      'audioAssets',
      'audioTakeFolders',
      'automationLanes',
      'automationReadState',
      'audioRouting',
    ]) delete v1[key];
    for (const track of v1.tracks as Array<Record<string, unknown>>) {
      delete track.role;
    }
    const decoded = decodeProject(v1);
    expect(decoded.ok && decoded.project.automationReadState).toEqual({
      globalEnabled: true,
      disabledTrackIds: [],
    });
  });

  it('rejects smuggling and every malformed current Read state', () => {
    const current = createEmptyProject({ clock });
    const track = current.tracks.find((candidate) => candidate.type !== 'master')!;
    const master = current.tracks.find((candidate) => candidate.type === 'master')!;
    const compatibilityMaster = {
      ...structuredClone(master),
      id: 'schema-v7-compatibility-master',
      name: 'Compatibility Master',
    };
    current.tracks.push(compatibilityMaster);

    const smuggled = structuredClone(current) as unknown as Record<string, unknown>;
    smuggled.schemaVersion = 6;
    issue(smuggled, 'automationReadState', 'unknown-key');

    const missing = structuredClone(current) as unknown as Record<string, unknown>;
    delete missing.automationReadState;
    issue(missing, 'automationReadState', 'required');
    for (const invalid of [null, false, []]) {
      const candidate = structuredClone(current) as unknown as Record<string, unknown>;
      candidate.automationReadState = invalid;
      issue(candidate, 'automationReadState', 'invalid-type');
    }
    for (const invalid of [null, 'true', 1]) {
      const candidate = structuredClone(current);
      (candidate.automationReadState as { globalEnabled: unknown }).globalEnabled = invalid;
      issue(candidate, 'automationReadState.globalEnabled', 'invalid-type');
    }
    for (const invalid of [null, false, {}]) {
      const candidate = structuredClone(current) as unknown as {
        automationReadState: { disabledTrackIds: unknown };
      };
      candidate.automationReadState.disabledTrackIds = invalid;
      issue(candidate, 'automationReadState.disabledTrackIds', 'invalid-type');
    }
    const wrongItem = structuredClone(current) as unknown as {
      automationReadState: { disabledTrackIds: unknown[] };
    };
    wrongItem.automationReadState.disabledTrackIds = [track.id, 1];
    issue(wrongItem, 'automationReadState.disabledTrackIds[1]', 'invalid-type');
    const duplicate = structuredClone(current);
    duplicate.automationReadState.disabledTrackIds = [track.id, track.id];
    issue(duplicate, 'automationReadState.disabledTrackIds[1]');
    const masterState = structuredClone(current);
    masterState.automationReadState.disabledTrackIds = [compatibilityMaster.id];
    issue(masterState, 'automationReadState.disabledTrackIds[0]');
    const missingTrack = structuredClone(current);
    missingTrack.automationReadState.disabledTrackIds = ['missing'];
    issue(missingTrack, 'automationReadState.disabledTrackIds[0]');
    const unknown = structuredClone(current) as unknown as {
      automationReadState: Record<string, unknown>;
    };
    unknown.automationReadState.mode = 'read';
    issue(unknown, 'automationReadState.mode', 'unknown-key');
  });

  it('rejects v7 Master smuggling at both migration boundaries', () => {
    const current = createEmptyProject({ clock });
    const master = current.tracks.find((track) => track.type === 'master')!;
    const masterLane = structuredClone(current) as unknown as Record<string, unknown>;
    masterLane.schemaVersion = 7;
    masterLane.automationLanes = [{
      id: 'legacy-master-lane',
      bypassed: false,
      target: { type: 'track-volume', trackId: master.id },
      points: [{
        id: 'legacy-master-point',
        beat: 0,
        value: 1,
        interpolation: 'linear',
      }],
    }];
    expect(() => migrateProject(masterLane)).toThrow(/Master track/);
    issue(masterLane, 'automationLanes[0].target.trackId', 'invalid-reference');

    const masterRead = structuredClone(current) as unknown as Record<string, unknown>;
    masterRead.schemaVersion = 7;
    masterRead.automationReadState = {
      globalEnabled: true,
      disabledTrackIds: [master.id],
    };
    expect(() => migrateProject(masterRead)).toThrow(/Master track/);
    issue(masterRead, 'automationReadState.disabledTrackIds[0]', 'invalid-reference');

    const missingRead = structuredClone(current) as unknown as Record<string, unknown>;
    missingRead.schemaVersion = 7;
    delete missingRead.automationReadState;
    issue(missingRead, 'automationReadState', 'required');
  });

  it('makes the public validator enforce the exact v7 Read-state shape', () => {
    const current = createEmptyProject({ clock });
    for (const [candidate, path] of [
      [{ ...current, automationReadState: undefined }, 'automationReadState'],
      [{
        ...current,
        automationReadState: { globalEnabled: 'true', disabledTrackIds: [] },
      }, 'automationReadState.globalEnabled'],
      [{
        ...current,
        automationReadState: { globalEnabled: true, disabledTrackIds: null },
      }, 'automationReadState.disabledTrackIds'],
      [{
        ...current,
        automationReadState: {
          globalEnabled: true,
          disabledTrackIds: [],
          mode: 'read',
        },
      }, 'automationReadState.mode'],
    ] as const) {
      expect(() => validateProject(candidate as unknown as Project)).not.toThrow();
      expect(validateProject(candidate as unknown as Project)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expect.objectContaining({ path })]),
      });
    }
  });

  it('provides immutable no-op-stable gates and reconciles Track lifecycle', () => {
    const initial = createEmptyProject({ clock });
    const first = initial.tracks.find((candidate) => candidate.type !== 'master')!;
    const master = initial.tracks.find((candidate) => candidate.type === 'master')!;
    const disabled = setTrackAutomationReadEnabled(initial, first.id, false);
    expect(disabled.ok && disabled.changed).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.project.automationReadState.disabledTrackIds).toEqual([first.id]);
    expect(disabled.project.automationLanes).toBe(initial.automationLanes);

    const masterDisabled = setTrackAutomationReadEnabled(disabled.project, master.id, false);
    expect(masterDisabled.ok).toBe(true);
    if (!masterDisabled.ok) return;
    expect(masterDisabled.project.automationReadState.disabledTrackIds).toEqual([
      first.id,
      master.id,
    ]);

    const noOp = setTrackAutomationReadEnabled(masterDisabled.project, first.id, false);
    expect(noOp.ok && noOp.project).toBe(masterDisabled.project);
    const global = setGlobalAutomationReadEnabled(masterDisabled.project, false);
    expect(global.ok && global.changed).toBe(true);
    if (!global.ok) return;
    expect(global.project.automationReadState.disabledTrackIds).toEqual([first.id, master.id]);

    const added = addTrack(global.project, 'bus', {
      name: 'Read lifecycle',
      idFactory: () => 'read-lifecycle-track',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const busId = added.trackId;
    const busDisabled = setTrackAutomationReadEnabled(added.project, busId, false);
    expect(busDisabled.ok).toBe(true);
    if (!busDisabled.ok) return;
    const duplicated = duplicateTrack(busDisabled.project, busId, {
      idFactory: (kind) => `read-copy-${kind}`,
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect(duplicated.project.automationReadState.disabledTrackIds).not.toContain(
      duplicated.trackId,
    );
    expect(duplicated.project.automationReadState.disabledTrackIds).toContain(master.id);
    const removed = removeTrack(duplicated.project, busId);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.project.automationReadState.disabledTrackIds).not.toContain(busId);
    expect(removed.project.automationReadState.disabledTrackIds).toContain(master.id);
  });
});
