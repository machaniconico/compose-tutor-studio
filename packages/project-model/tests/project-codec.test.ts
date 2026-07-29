import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_PROJECT_JSON_BYTES,
  CURRENT_SCHEMA_VERSION,
  ScheduleEventLimitError,
  assertScheduleEventBudget,
  MAX_PROJECT_COLLECTION_ITEMS,
  createEmptyProject,
  decodeProject,
  decodeProjectJson,
  duplicateClip,
  encodeProjectJson,
  findClip,
  resolveClipContent,
  type Project,
} from '../src/index';

const clock = () => new Date('2026-07-10T00:00:00.000Z');

function projectRecord(): Record<string, unknown> {
  return structuredClone(createEmptyProject({ clock })) as unknown as Record<string, unknown>;
}

function legacyProjectRecord(project: Project, schemaVersion: 1 | 2): Record<string, unknown> {
  const legacy = structuredClone(project) as unknown as Record<string, unknown>;
  legacy.schemaVersion = schemaVersion;
  delete legacy.lengthBeats;
  delete legacy.tempoMap;
  delete legacy.timeSignatureMap;
  delete legacy.audioAssets;
  delete legacy.audioTakeFolders;
  delete legacy.automationLanes;
  delete legacy.audioRouting;
  for (const track of legacy.tracks as Array<Record<string, unknown>>) {
    delete track.role;
    for (const clip of track.clips as Array<Record<string, unknown>>) {
      delete clip.sourceStartFrame;
      delete clip.sourceFrameCount;
      delete clip.fadeInFrames;
      delete clip.fadeOutFrames;
      delete clip.gainDb;
    }
  }
  return legacy;
}

describe('canonical project codec', () => {
  it('returns a detached, validated project for current-schema input', () => {
    const input = createEmptyProject({ clock });
    const result = decodeProject(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project).toEqual(input);
    expect(result.project).not.toBe(input);
    expect(result.project.tracks[0]).not.toBe(input.tracks[0]);
    expect(result).toMatchObject({
      sourceSchemaVersion: CURRENT_SCHEMA_VERSION,
      migrated: false,
    });
  });

  it('produces deterministic JSON and round-trips through the same decoder', () => {
    const project = createEmptyProject({ clock });
    const first = encodeProjectJson(project);
    const second = encodeProjectJson(project);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const decoded = decodeProjectJson(first.json);
    expect(decoded.ok && decoded.project).toEqual(project);
    expect(first.bytes).toBe(new TextEncoder().encode(first.json).byteLength);
  });

  it('round-trips a valid schema-v2 linked clip without duplicating its payload', () => {
    const project = createEmptyProject({ lengthBars: 8, clock });
    const track = project.tracks.find((candidate) => candidate.type === 'instrument');
    const source = track?.clips[0];
    if (!source) throw new Error('instrument fixture is missing');
    source.lengthBeats = 4;
    source.notes = [
      {
        id: 'codec-source-note',
        pitch: 60,
        startBeat: 0,
        durationBeats: 1,
        velocity: 100,
      },
    ];

    const linked = duplicateClip(
      project,
      source.id,
      { id: 'codec-linked-clip', startBeat: 4, linked: true },
      clock,
    );
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;

    const encoded = encodeProjectJson(linked.project);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeProjectJson(encoded.json);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.project).toEqual(linked.project);
    const alias = findClip(decoded.project, linked.clipId)?.clip;
    expect(alias).toMatchObject({
      id: 'codec-linked-clip',
      aliasOf: source.id,
      startBeat: 4,
      lengthBeats: 4,
    });
    expect(alias).not.toHaveProperty('notes');
    expect(alias && resolveClipContent(decoded.project, alias)?.notes).toEqual(
      source.notes,
    );
  });

  it('migrates a v1 project above the runtime budget with chord metadata', () => {
    const legacy = createEmptyProject({
      lengthBars: 1,
      clock,
    });
    legacy.schemaVersion = 1;
    const melody = legacy.tracks.find((track) => track.name === 'Melody');
    if (!melody) throw new Error('Melody fixture is missing');
    melody.clips = Array.from({ length: 6 }, (_, clipIndex) => ({
      id: `legacy-large-clip-${clipIndex}`,
      trackId: melody.id,
      type: 'midi' as const,
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: Array.from({ length: 17_000 }, (_, noteIndex) => ({
        id: `legacy-large-note-${clipIndex}-${noteIndex}`,
        pitch: 60,
        startBeat: 0,
        durationBeats: 1,
        velocity: 90,
      })),
    }));
    legacy.chordTrack = Array.from({ length: 4_096 }, (_, index) => ({
      id: `legacy-empty-chord-${index}`,
      startBeat: 0,
      durationBeats: 1,
      symbol: 'C',
      root: 'C',
      quality: 'major',
      notes: [],
    }));

    const decoded = decodeProject(legacyProjectRecord(legacy, 1));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded).toMatchObject({ sourceSchemaVersion: 1, migrated: true });
    expect(decoded.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(decoded.project.tracks.find((track) => track.name === 'Melody')?.clips)
      .toHaveLength(6);
    expect(() => assertScheduleEventBudget(decoded.project)).toThrowError(
      expect.objectContaining({ reason: 'total' }) as ScheduleEventLimitError,
    );
  });

  it('round-trips linked drum events and groove with payload owned only by the source', () => {
    const project = createEmptyProject({ lengthBars: 8, clock });
    const source = project.tracks.find((track) => track.type === 'drum')?.clips[0];
    if (!source) throw new Error('drum fixture is missing');
    source.lengthBeats = 4;
    source.stepsPerBar = 16;
    source.drumEvents = [
      {
        id: 'codec-source-hit',
        lane: 'kick',
        stepIndex: 0,
        velocity: 100,
        probability: 0.75,
      },
    ];
    source.drumGroove = {
      swing: 0.2,
      probability: 0.9,
      humanizeVelocity: 4,
      seed: 42,
    };

    const linked = duplicateClip(
      project,
      source.id,
      { id: 'codec-linked-drums', startBeat: 4, linked: true },
      clock,
    );
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    const encoded = encodeProjectJson(linked.project);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeProjectJson(encoded.json);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.project).toEqual(linked.project);
    const alias = findClip(decoded.project, linked.clipId)?.clip;
    expect(alias).toMatchObject({
      id: 'codec-linked-drums',
      aliasOf: source.id,
      type: 'drum',
      startBeat: 4,
    });
    expect(alias).not.toHaveProperty('drumEvents');
    expect(alias).not.toHaveProperty('stepsPerBar');
    expect(alias).not.toHaveProperty('drumGroove');
    const resolved = alias && resolveClipContent(decoded.project, alias);
    expect(resolved?.drumEvents).toEqual(source.drumEvents);
    expect(resolved?.drumGroove).toEqual(source.drumGroove);
  });

  it.each([null, [], 'project', 42])('rejects a non-object root without throwing: %j', (input) => {
    expect(decodeProject(input)).toMatchObject({ ok: false, error: { code: 'invalid-root' } });
  });

  it('classifies invalid JSON and accepts a single UTF-8 BOM', () => {
    expect(decodeProjectJson('{broken')).toMatchObject({
      ok: false,
      error: { code: 'invalid-json' },
    });
    const encoded = encodeProjectJson(createEmptyProject({ clock }));
    if (!encoded.ok) throw new Error('fixture encoding failed');
    expect(decodeProjectJson(`\uFEFF${encoded.json}`).ok).toBe(true);
  });

  it('enforces the configured byte limit before parsing', () => {
    const result = decodeProjectJson(' '.repeat(33), { maxBytes: 32 });
    expect(result).toMatchObject({ ok: false, error: { code: 'too-large' } });
    expect(DEFAULT_MAX_PROJECT_JSON_BYTES).toBeGreaterThan(1_000_000);
  });

  it('enforces the configured byte limit after encoding', () => {
    const result = encodeProjectJson(createEmptyProject({ clock }), { maxBytes: 32 });
    expect(result).toMatchObject({ ok: false, error: { code: 'too-large' } });
  });

  it('rejects an array that straddles the total nested-item budget without truncating it', () => {
    const project = createEmptyProject({ clock });
    const tags = Array.from({ length: MAX_PROJECT_COLLECTION_ITEMS }, () => 'tag');
    const chord = {
      id: 'chord-a',
      startBeat: 0,
      durationBeats: 4,
      symbol: 'C',
      root: 'C' as const,
      quality: 'major' as const,
      notes: [0, 4, 7],
      tags,
    };
    const result = decodeProject({
      ...project,
      chordTrack: [chord, { ...chord, id: 'chord-b', startBeat: 4, tags: [...tags] }],
      sections: [],
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-project' } });
    if (result.ok) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'chordTrack[1].tags', code: 'out-of-range' }),
      ]),
    );
  });

  it.each([
    undefined,
    null,
    '1',
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects an invalid schemaVersion: %s', (schemaVersion) => {
    const input = projectRecord();
    if (schemaVersion === undefined) delete input.schemaVersion;
    else input.schemaVersion = schemaVersion;

    expect(decodeProject(input)).toMatchObject({
      ok: false,
      error: { code: 'invalid-schema-version' },
    });
  });

  it('distinguishes a future schema from corrupt current data', () => {
    const input = projectRecord();
    input.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    expect(decodeProject(input)).toMatchObject({
      ok: false,
      error: { code: 'future-schema-version' },
    });
  });

  it('rejects unknown keys at the exact nested path', () => {
    const input = projectRecord();
    const tracks = input.tracks as Array<Record<string, unknown>>;
    tracks[0] = { ...tracks[0], surprise: true };
    const result = decodeProject(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-project');
    expect(result.error.issues).toContainEqual({
      path: 'tracks[0].surprise',
      code: 'unknown-key',
      message: 'unknown property',
    });
  });

  it('allows open numeric parameter maps but rejects non-finite values', () => {
    const input = projectRecord();
    const tracks = input.tracks as Array<Record<string, unknown>>;
    const instrument = tracks[0]?.instrument as Record<string, unknown>;
    instrument.params = { cutoff: 12_000, resonance: 0.7 };
    expect(decodeProject(input).ok).toBe(true);

    (instrument.params as Record<string, unknown>).cutoff = Number.POSITIVE_INFINITY;
    const invalid = decodeProject(input);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracks[0].instrument.params.cutoff', code: 'not-finite' }),
      ]),
    );
  });

  it('counts numeric parameter entries toward the total nested-item budget', () => {
    const project = createEmptyProject({ clock });
    const params = Object.fromEntries(
      Array.from({ length: 2_048 }, (_, index) => [`parameter-${index}`, index]),
    );
    for (let trackIndex = 0; trackIndex < 2; trackIndex += 1) {
      project.tracks[trackIndex]!.effects = Array.from({ length: 50 }, (_, effectIndex) => ({
        id: `budget-effect-${trackIndex}-${effectIndex}`,
        type: 'filter' as const,
        enabled: true,
        params,
      }));
    }

    const result = decodeProject(project);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringContaining('.params'),
        code: 'out-of-range',
        message: expect.stringContaining('project exceeds 200000 nested items'),
      }),
    ]));
  });

  it('preserves __proto__ as inert parameter data without changing prototypes', () => {
    const input = projectRecord();
    const tracks = input.tracks as Array<Record<string, unknown>>;
    const instrument = tracks[0]?.instrument as Record<string, unknown>;
    instrument.params = JSON.parse('{"__proto__":7,"cutoff":12000}') as Record<string, unknown>;

    const result = decodeProject(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const params = result.project.tracks[0]?.instrument?.params;
    expect(Object.prototype.hasOwnProperty.call(params, '__proto__')).toBe(true);
    expect(params?.['__proto__']).toBe(7);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('rejects missing and malformed nested collections without throwing', () => {
    const missing = projectRecord();
    delete missing.tracks;
    expect(() => decodeProject(missing)).not.toThrow();
    expect(decodeProject(missing)).toMatchObject({ ok: false, error: { code: 'invalid-project' } });

    const malformed = projectRecord();
    malformed.tracks = [null];
    const result = decodeProject(malformed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'tracks[0]', code: 'invalid-type' })]),
    );
  });

  it.each([
    '2026-02-30T00:00:00.000Z',
    '2026-07-10',
    '2026-07-10T00:00:00',
    '0',
  ])('rejects a non-canonical timestamp: %s', (timestamp) => {
    const input = projectRecord();
    input.updatedAt = timestamp;
    const result = decodeProject(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'updatedAt', code: 'invalid-timestamp' }),
      ]),
    );
  });

  it('applies domain validation after structural decoding', () => {
    const input = projectRecord();
    input.bpm = 301;
    const result = decodeProject(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'bpm', code: 'out-of-range' })]),
    );
  });

  it('rejects non-positive or fractional stepsPerBar', () => {
    const input = projectRecord();
    const tracks = input.tracks as Array<Record<string, unknown>>;
    const drumTrack = tracks.find((track) => track.type === 'drum');
    const clips = drumTrack?.clips as Array<Record<string, unknown>>;
    if (!clips?.[0]) throw new Error('drum fixture missing');
    clips[0].stepsPerBar = 0.5;

    const result = decodeProject(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('stepsPerBar'), code: 'not-integer' }),
      ]),
    );
  });

  it('round-trips persisted drum groove and per-step probability', () => {
    const project = createEmptyProject({ clock });
    const drumClip = project.tracks.find((track) => track.type === 'drum')?.clips[0];
    if (!drumClip) throw new Error('drum fixture missing');
    drumClip.drumGroove = {
      swing: 0.35,
      probability: 0.8,
      humanizeVelocity: 12,
      seed: 42,
    };
    drumClip.drumEvents = [
      { id: 'drum-probability', lane: 'kick', stepIndex: 0, velocity: 100, probability: 0.6 },
    ];

    const encoded = encodeProjectJson(project);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeProjectJson(encoded.json);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const restored = decoded.project.tracks.find((track) => track.type === 'drum')?.clips[0];
    expect(restored?.drumGroove).toEqual(drumClip.drumGroove);
    expect(restored?.drumEvents?.[0]?.probability).toBe(0.6);
  });

  it('rejects CSS-capable track colors before they can trigger a network fetch', () => {
    const project = createEmptyProject({ clock });
    project.tracks[0]!.color = 'url(http://attacker.invalid/opened)';

    expect(encodeProjectJson(project)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-project',
        issues: expect.arrayContaining([expect.objectContaining({ path: 'tracks[0].color' })]),
      },
    });
  });

  it('rejects tiny payloads whose nested timing would expand an unbounded UI grid', () => {
    const project = createEmptyProject({ clock });
    const drumClip = project.tracks.find((track) => track.type === 'drum')?.clips[0];
    if (!drumClip) throw new Error('drum fixture missing');
    drumClip.lengthBeats = 1e308;

    expect(encodeProjectJson(project)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-project',
        issues: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining('lengthBeats') }),
        ]),
      },
    });
  });

  it('never invokes an untrusted toJSON hook during encode', () => {
    const toJSON = vi.fn(() => ({ schemaVersion: 1 }));
    const input = { ...createEmptyProject({ clock }), toJSON };
    const result = encodeProjectJson(input);

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-project' } });
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('rejects __proto__ as an own JSON property without polluting prototypes', () => {
    const encoded = encodeProjectJson(createEmptyProject({ clock }));
    if (!encoded.ok) throw new Error('fixture encoding failed');
    const raw = encoded.json.replace('{', '{"__proto__":{"polluted":true},');
    const result = decodeProjectJson(raw);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-project' } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
