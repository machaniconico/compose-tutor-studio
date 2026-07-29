import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MAX_AUDIO_ROUTING_EDGES,
  MAX_AUDIO_SENDS_PER_SOURCE,
  compileAudioRouting,
  createEmptyProject,
  decodeProject,
  encodeProjectJson,
  validateAudioRouting,
  validateProject,
  type AudioSend,
  type Project,
  type Track,
} from '../src/index';

const clock = () => new Date('2026-07-17T00:00:00.000Z');

function busTrack(id: string): Track {
  return {
    id,
    name: id,
    type: 'bus',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
}

function addBus(project: Project, id: string): Track {
  const bus = busTrack(id);
  const masterIndex = project.tracks.findIndex((track) => track.type === 'master');
  project.tracks.splice(masterIndex < 0 ? project.tracks.length : masterIndex, 0, bus);
  project.audioRouting.outputs.push({
    sourceTrackId: id,
    destination: { type: 'master' },
  });
  return bus;
}

function schemaV3Record(project: Project): Record<string, unknown> {
  const legacy = structuredClone(project) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 3;
  delete legacy.audioRouting;
  delete legacy.audioTakeFolders;
  return legacy;
}

describe('schema-v4 audio routing', () => {
  it('migrates every schema-v3 non-Master track to the logical Master without mutation', () => {
    const current = createEmptyProject({ clock });
    addBus(current, 'legacy-bus');
    const legacy = schemaV3Record(current);
    const untouched = structuredClone(legacy);

    const decoded = decodeProject(legacy);

    expect(legacy).toEqual(untouched);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded).toMatchObject({ sourceSchemaVersion: 3, migrated: true });
    expect(decoded.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(decoded.project.audioTakeFolders).toEqual([]);
    expect(decoded.project.audioRouting).toEqual({
      outputs: decoded.project.tracks
        .filter((track) => track.type !== 'master')
        .map((track) => ({
          sourceTrackId: track.id,
          destination: { type: 'master' },
        })),
      sends: [],
    });
  });

  it('strictly rejects v4 fields smuggled into v3 and unknown nested routing fields', () => {
    const project = createEmptyProject({ clock });
    const legacy = schemaV3Record(project);
    legacy.audioRouting = { outputs: [], sends: [] };
    const smuggled = decodeProject(legacy);
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) {
      expect(smuggled.error.issues).toContainEqual(expect.objectContaining({
        path: 'audioRouting',
        code: 'unknown-key',
      }));
    }

    const nested = structuredClone(project) as unknown as Record<string, unknown>;
    const routing = nested.audioRouting as { outputs: Array<Record<string, unknown>> };
    (routing.outputs[0]!.destination as Record<string, unknown>).trackId = 'not-allowed';
    const rejected = decodeProject(nested);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.issues).toContainEqual(expect.objectContaining({
        path: 'audioRouting.outputs[0].destination.trackId',
        code: 'unknown-key',
      }));
    }
  });

  it('round-trips and compiles a stable source-before-Bus structural plan', () => {
    const project = createEmptyProject({ clock });
    const source = project.tracks[0]!;
    const secondSource = project.tracks[1]!;
    addBus(project, 'bus-a');
    addBus(project, 'bus-b');
    project.audioRouting.outputs.find((output) => output.sourceTrackId === source.id)!.destination = {
      type: 'bus',
      trackId: 'bus-a',
    };
    project.audioRouting.outputs.find((output) => output.sourceTrackId === 'bus-a')!.destination = {
      type: 'bus',
      trackId: 'bus-b',
    };
    project.audioRouting.sends.push({
      id: 'send-to-b',
      sourceTrackId: secondSource.id,
      targetBusId: 'bus-b',
      position: 'post-fader',
      gain: 0.75,
      enabled: true,
    });
    const untouched = structuredClone(project);

    const compiled = compileAudioRouting(project);

    expect(project).toEqual(untouched);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(Object.isFrozen(compiled.plan)).toBe(true);
    expect(compiled.plan.topologicalTrackIds.indexOf(source.id))
      .toBeLessThan(compiled.plan.topologicalTrackIds.indexOf('bus-a'));
    expect(compiled.plan.topologicalTrackIds.indexOf('bus-a'))
      .toBeLessThan(compiled.plan.topologicalTrackIds.indexOf('bus-b'));
    expect(compiled.plan.sendsBySource[secondSource.id]).toEqual([
      expect.objectContaining({ id: 'send-to-b', gain: 0.75 }),
    ]);

    const encoded = encodeProjectJson(project);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeProject(JSON.parse(encoded.json) as unknown);
    expect(decoded.ok && decoded.project).toEqual(project);
    if (decoded.ok) {
      expect(decoded.project.audioRouting).not.toBe(project.audioRouting);
      expect(decoded.project.audioRouting.outputs[0]).not.toBe(project.audioRouting.outputs[0]);
    }
  });

  it('rejects dangling, self, duplicate, and main-output-equivalent routes', () => {
    const dangling = createEmptyProject({ clock });
    dangling.audioRouting.outputs[0]!.destination = { type: 'bus', trackId: 'missing' };
    dangling.audioRouting.sends.push({
      id: 'dangling-send',
      sourceTrackId: dangling.tracks[1]!.id,
      targetBusId: 'missing-send-bus',
      position: 'post-fader',
      gain: 1,
      enabled: true,
    });
    expect(validateAudioRouting(dangling).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'audioRouting.outputs[0].destination.trackId' }),
      expect.objectContaining({ path: 'audioRouting.sends[0].targetBusId' }),
    ]));

    const exactOutput = createEmptyProject({ clock });
    exactOutput.audioRouting.outputs.pop();
    exactOutput.audioRouting.outputs.push({ ...exactOutput.audioRouting.outputs[0]! });
    expect(validateAudioRouting(exactOutput).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('requires exactly one output') }),
      expect.objectContaining({ message: expect.stringContaining('exactly one output route') }),
    ]));

    const project = createEmptyProject({ clock });
    const source = project.tracks[0]!;
    addBus(project, 'bus-a');
    project.audioRouting.outputs.find((output) => output.sourceTrackId === 'bus-a')!.destination = {
      type: 'bus',
      trackId: 'bus-a',
    };
    project.audioRouting.outputs.find((output) => output.sourceTrackId === source.id)!.destination = {
      type: 'bus',
      trackId: 'bus-a',
    };
    project.audioRouting.sends.push(
      {
        id: 'same-as-output',
        sourceTrackId: source.id,
        targetBusId: 'bus-a',
        position: 'pre-fader',
        gain: 1,
        enabled: true,
      },
      {
        id: 'duplicate-target',
        sourceTrackId: source.id,
        targetBusId: 'bus-a',
        position: 'post-fader',
        gain: 1,
        enabled: true,
      },
      {
        id: 'self-send',
        sourceTrackId: 'bus-a',
        targetBusId: 'bus-a',
        position: 'post-fader',
        gain: 1,
        enabled: true,
      },
    );
    const errors = validateAudioRouting(project).errors;
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('cannot output to itself') }),
      expect.objectContaining({ message: expect.stringContaining('same Bus as the main output') }),
      expect.objectContaining({ message: expect.stringContaining('duplicate sends') }),
      expect.objectContaining({ message: expect.stringContaining('cannot send to itself') }),
    ]));
  });

  it('rejects a mixed output/send cycle even when the send is disabled at zero gain', () => {
    const project = createEmptyProject({ clock });
    addBus(project, 'bus-a');
    addBus(project, 'bus-b');
    project.audioRouting.outputs.find((output) => output.sourceTrackId === 'bus-a')!.destination = {
      type: 'bus',
      trackId: 'bus-b',
    };
    project.audioRouting.sends.push({
      id: 'disabled-cycle',
      sourceTrackId: 'bus-b',
      targetBusId: 'bus-a',
      position: 'pre-fader',
      gain: 0,
      enabled: false,
    });

    const result = compileAudioRouting(project);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        path: 'audioRouting',
        message: expect.stringContaining('acyclic'),
      }));
    }
  });

  it('compares source and target ids as tuples even when ids contain NUL', () => {
    const project = createEmptyProject({ clock });
    const first = project.tracks[0]!;
    const second = project.tracks[1]!;
    const firstOriginalId = first.id;
    const secondOriginalId = second.id;
    first.id = 'source\u0000bus';
    second.id = 'source';
    project.audioRouting.outputs.find(
      (output) => output.sourceTrackId === firstOriginalId,
    )!.sourceTrackId = first.id;
    project.audioRouting.outputs.find(
      (output) => output.sourceTrackId === secondOriginalId,
    )!.sourceTrackId = second.id;
    addBus(project, 'target');
    addBus(project, 'bus\u0000target');
    project.audioRouting.sends.push(
      {
        id: 'nul-send-a',
        sourceTrackId: first.id,
        targetBusId: 'target',
        position: 'post-fader',
        gain: 1,
        enabled: true,
      },
      {
        id: 'nul-send-b',
        sourceTrackId: second.id,
        targetBusId: 'bus\u0000target',
        position: 'post-fader',
        gain: 1,
        enabled: true,
      },
    );

    expect(validateAudioRouting(project)).toMatchObject({ ok: true, errors: [] });
    expect(compileAudioRouting(project).ok).toBe(true);
  });

  it('enforces send, total-edge, gain, and global-id limits', () => {
    const project = createEmptyProject({ clock });
    const source = project.tracks[0]!;
    for (let index = 0; index <= MAX_AUDIO_SENDS_PER_SOURCE; index += 1) {
      addBus(project, `limit-bus-${index}`);
      project.audioRouting.sends.push({
        id: `limit-send-${index}`,
        sourceTrackId: source.id,
        targetBusId: `limit-bus-${index}`,
        position: 'post-fader',
        gain: index === 0 ? 2.01 : 1,
        enabled: true,
      });
    }
    expect(validateAudioRouting(project).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'audioRouting.sends[0].gain' }),
      expect.objectContaining({ message: expect.stringContaining(`${MAX_AUDIO_SENDS_PER_SOURCE} sends`) }),
    ]));

    const repeated: AudioSend = {
      id: 'edge-limit-send',
      sourceTrackId: source.id,
      targetBusId: 'limit-bus-0',
      position: 'pre-fader',
      gain: 1,
      enabled: true,
    };
    project.audioRouting.sends = Array.from(
      { length: MAX_AUDIO_ROUTING_EDGES + 1 },
      (_, index) => ({ ...repeated, id: `edge-limit-${index}` }),
    );
    expect(validateAudioRouting(project).errors).toContainEqual(expect.objectContaining({
      path: 'audioRouting',
      message: expect.stringContaining(`${MAX_AUDIO_ROUTING_EDGES}`),
    }));

    const duplicateId = createEmptyProject({ clock });
    addBus(duplicateId, 'id-bus');
    duplicateId.audioRouting.sends.push({
      ...repeated,
      id: duplicateId.id,
      targetBusId: 'id-bus',
    });
    expect(validateProject(duplicateId).errors).toContainEqual(expect.objectContaining({
      path: 'audioRouting.sends[0].id',
      message: expect.stringContaining('duplicate id'),
    }));
  });
});
