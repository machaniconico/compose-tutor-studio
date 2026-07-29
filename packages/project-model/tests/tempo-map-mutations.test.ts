import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  addTempoMapEvent,
  addTimeSignatureMapEvent,
  createEmptyProject,
  encodeProjectJson,
  MAX_TEMPO_MAP_EVENTS,
  removeTempoMapEvent,
  removeTimeSignatureMapEvent,
  updateTempoMapEvent,
  updateTimeSignatureMapEvent,
  type Project,
  type TempoMapMutationErrorCode,
  type TempoMapMutationResult,
} from '../src/index';

const clock = () => new Date('2026-07-28T00:00:00.000Z');

function expectSuccess(result: TempoMapMutationResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function expectFailure(
  result: TempoMapMutationResult,
  code: TempoMapMutationErrorCode,
  source: Project,
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected tempo-map mutation failure');
  expect(result.error.code).toBe(code);
  expect(result.changed).toBe(false);
  expect(result.project).toBe(source);
  return result;
}

function base(): Project {
  return createEmptyProject({ clock, lengthBars: 4 });
}

describe('tempo-map mutations', () => {
  it('adds a tempo event immutably with a stable injected id', () => {
    const project = base();
    const before = structuredClone(project);

    const result = expectSuccess(addTempoMapEvent(
      project,
      { beat: 8, bpm: 90 },
      { eventId: 'tempo-slow' },
    ));

    expect(result).toMatchObject({
      changed: true,
      map: 'tempo',
      eventId: 'tempo-slow',
    });
    expect(result.project).not.toBe(project);
    expect(result.project.tempoMap).toEqual([
      project.tempoMap[0],
      { id: 'tempo-slow', beat: 8, bpm: 90 },
    ]);
    expect(project).toEqual(before);
  });

  it('keeps added tempo events strictly ordered without replacing prior arrays', () => {
    const project = base();
    const late = expectSuccess(addTempoMapEvent(
      project,
      { beat: 12, bpm: 140 },
      { eventId: 'tempo-late' },
    ));
    const early = expectSuccess(addTempoMapEvent(
      late.project,
      { beat: 4, bpm: 80 },
      { eventId: 'tempo-early' },
    ));

    expect(early.project.tempoMap.map((event) => event.id)).toEqual([
      project.tempoMap[0]?.id,
      'tempo-early',
      'tempo-late',
    ]);
    expect(early.project.tempoMap.map((event) => event.beat)).toEqual([0, 4, 12]);
    expect(late.project.tempoMap.map((event) => event.beat)).toEqual([0, 12]);
  });

  it('updates the tempo anchor atomically with the bpm mirror and preserves no-op identity', () => {
    const project = base();
    const anchorId = project.tempoMap[0]?.id;
    if (anchorId === undefined) throw new Error('invalid fixture');
    const before = structuredClone(project);

    const low = expectSuccess(updateTempoMapEvent(project, anchorId, { bpm: 20 }));
    expect(low.project).not.toBe(project);
    expect(low.project.bpm).toBe(20);
    expect(low.project.tempoMap[0]).toMatchObject({ id: anchorId, beat: 0, bpm: 20 });
    expect(low.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(project).toEqual(before);

    const high = expectSuccess(updateTempoMapEvent(low.project, anchorId, { bpm: 300 }));
    expect(high.project.bpm).toBe(300);
    expect(high.project.tempoMap[0]?.bpm).toBe(300);

    const emptyPatch = expectSuccess(updateTempoMapEvent(high.project, anchorId, {}));
    const exactPatch = expectSuccess(updateTempoMapEvent(
      high.project,
      anchorId,
      { beat: 0, bpm: 300 },
    ));
    expect(emptyPatch).toMatchObject({ changed: false, map: 'tempo', eventId: anchorId });
    expect(emptyPatch.project).toBe(high.project);
    expect(exactPatch.changed).toBe(false);
    expect(exactPatch.project).toBe(high.project);
  });

  it('moves and removes non-anchor tempo events while preserving stable ids', () => {
    const project = base();
    const first = expectSuccess(addTempoMapEvent(
      project,
      { beat: 4, bpm: 90 },
      { eventId: 'tempo-a' },
    ));
    const second = expectSuccess(addTempoMapEvent(
      first.project,
      { beat: 12, bpm: 150 },
      { eventId: 'tempo-b' },
    ));
    const beforeMove = structuredClone(second.project);

    const moved = expectSuccess(updateTempoMapEvent(
      second.project,
      'tempo-b',
      { beat: 8, bpm: 160 },
    ));
    expect(moved.eventId).toBe('tempo-b');
    expect(moved.project.tempoMap.map((event) => [event.id, event.beat, event.bpm])).toEqual([
      [project.tempoMap[0]?.id, 0, 120],
      ['tempo-a', 4, 90],
      ['tempo-b', 8, 160],
    ]);
    expect(second.project).toEqual(beforeMove);

    const removed = expectSuccess(removeTempoMapEvent(moved.project, 'tempo-a'));
    expect(removed).toMatchObject({ changed: true, map: 'tempo', eventId: 'tempo-a' });
    expect(removed.project.tempoMap.map((event) => event.id)).toEqual([
      project.tempoMap[0]?.id,
      'tempo-b',
    ]);
    expect(moved.project.tempoMap).toHaveLength(3);
  });

  it('edits a codec-valid terminal tempo event without opening the project end to new moves', () => {
    const project = base();
    const terminal: Project = {
      ...project,
      tempoMap: [
        ...project.tempoMap,
        { id: 'tempo-terminal', beat: project.lengthBeats, bpm: 90 },
      ],
    };
    expect(encodeProjectJson(terminal).ok).toBe(true);

    const noOp = expectSuccess(updateTempoMapEvent(
      terminal,
      'tempo-terminal',
      {},
    ));
    expect(noOp.changed).toBe(false);
    expect(noOp.project).toBe(terminal);

    const updated = expectSuccess(updateTempoMapEvent(
      terminal,
      'tempo-terminal',
      { bpm: 100 },
    ));
    expect(updated.project.tempoMap.at(-1)).toEqual({
      id: 'tempo-terminal',
      beat: terminal.lengthBeats,
      bpm: 100,
    });

    const movedInside = expectSuccess(updateTempoMapEvent(
      updated.project,
      'tempo-terminal',
      { beat: 12 },
    ));
    expect(movedInside.project.tempoMap.at(-1)?.beat).toBe(12);
    expectFailure(
      updateTempoMapEvent(
        movedInside.project,
        'tempo-terminal',
        { beat: movedInside.project.lengthBeats },
      ),
      'invalid-beat',
      movedInside.project,
    );

    const removed = expectSuccess(removeTempoMapEvent(
      terminal,
      'tempo-terminal',
    ));
    expect(removed.project.tempoMap).toEqual(project.tempoMap);
  });

  it('protects the tempo anchor and returns typed lookup failures', () => {
    const project = base();
    const anchorId = project.tempoMap[0]?.id;
    if (anchorId === undefined) throw new Error('invalid fixture');

    expectFailure(
      updateTempoMapEvent(project, anchorId, { beat: 4 }),
      'anchor-protected',
      project,
    );
    expectFailure(removeTempoMapEvent(project, anchorId), 'anchor-protected', project);
    expectFailure(updateTempoMapEvent(project, 'missing', {}), 'event-not-found', project);
    expectFailure(removeTempoMapEvent(project, 'missing'), 'event-not-found', project);
  });

  it.each([
    ['negative beat', { beat: -1, bpm: 120 }, 'invalid-beat'],
    ['project-end beat', { beat: 16, bpm: 120 }, 'invalid-beat'],
    ['non-finite beat', { beat: Number.NaN, bpm: 120 }, 'invalid-beat'],
    ['low bpm', { beat: 4, bpm: 19.99 }, 'invalid-bpm'],
    ['high bpm', { beat: 4, bpm: 300.01 }, 'invalid-bpm'],
    ['non-finite bpm', { beat: 4, bpm: Number.POSITIVE_INFINITY }, 'invalid-bpm'],
  ] as const)('rejects tempo %s atomically', (_name, input, code) => {
    const project = base();
    const before = structuredClone(project);

    expectFailure(addTempoMapEvent(project, input), code, project);
    expect(project).toEqual(before);
  });

  it('rejects tempo add and move collisions atomically', () => {
    const project = base();
    expectFailure(
      addTempoMapEvent(project, { beat: 0, bpm: 80 }),
      'event-beat-conflict',
      project,
    );
    const first = expectSuccess(addTempoMapEvent(
      project,
      { beat: 4, bpm: 90 },
      { eventId: 'tempo-a' },
    ));
    const second = expectSuccess(addTempoMapEvent(
      first.project,
      { beat: 8, bpm: 100 },
      { eventId: 'tempo-b' },
    ));
    const before = structuredClone(second.project);

    expectFailure(
      addTempoMapEvent(second.project, { beat: 8, bpm: 110 }),
      'event-beat-conflict',
      second.project,
    );
    expectFailure(
      updateTempoMapEvent(second.project, 'tempo-b', { beat: 4 }),
      'event-beat-conflict',
      second.project,
    );
    expect(second.project).toEqual(before);
  });

  it('enforces the tempo-map limit before allocating another id', () => {
    const project = base();
    const step = project.lengthBeats / MAX_TEMPO_MAP_EVENTS;
    const tempoMap = Array.from({ length: MAX_TEMPO_MAP_EVENTS }, (_, index) => ({
      id: `tempo-capacity-${index}`,
      beat: index * step,
      bpm: 120,
    }));
    const full: Project = { ...project, bpm: 120, tempoMap };
    let idCalls = 0;

    expectFailure(
      addTempoMapEvent(
        full,
        { beat: project.lengthBeats - step / 2, bpm: 100 },
        { idFactory: () => {
          idCalls += 1;
          return 'must-not-be-allocated';
        } },
      ),
      'map-limit',
      full,
    );
    expect(idCalls).toBe(0);
    expect(full.tempoMap).toBe(tempoMap);
  });

  it('rejects globally duplicate, malformed, and throwing event ids', () => {
    const project = base();
    const existingTrackId = project.tracks[0]?.id;
    if (existingTrackId === undefined) throw new Error('invalid fixture');
    const before = structuredClone(project);
    const kinds: string[] = [];

    expectFailure(
      addTempoMapEvent(
        project,
        { beat: 4, bpm: 90 },
        { eventId: existingTrackId },
      ),
      'duplicate-id',
      project,
    );
    expectFailure(
      addTempoMapEvent(project, { beat: 4, bpm: 90 }, { idFactory: () => '' }),
      'id-factory-failed',
      project,
    );
    expectFailure(
      addTempoMapEvent(project, { beat: 4, bpm: 90 }, {
        idFactory: () => {
          throw new Error('boom');
        },
      }),
      'id-factory-failed',
      project,
    );
    const added = expectSuccess(addTempoMapEvent(project, { beat: 4, bpm: 90 }, {
      idFactory: (kind) => {
        kinds.push(kind);
        return 'tempo-factory-id';
      },
    }));
    expect(added.eventId).toBe('tempo-factory-id');
    expect(kinds).toEqual(['tempo']);
    expect(project).toEqual(before);
  });
});

describe('time-signature-map mutations', () => {
  it('adds a signature only at a valid bar boundary and recomputes lengthBars', () => {
    const project = base();
    const before = structuredClone(project);
    const kinds: string[] = [];

    const result = expectSuccess(addTimeSignatureMapEvent(
      project,
      { beat: 4, numerator: 3, denominator: 4 },
      {
        idFactory: (kind) => {
          kinds.push(kind);
          return 'signature-three-four';
        },
      },
    ));

    expect(result).toMatchObject({
      changed: true,
      map: 'time-signature',
      eventId: 'signature-three-four',
    });
    expect(result.project.timeSignatureMap).toEqual([
      project.timeSignatureMap[0],
      {
        id: 'signature-three-four',
        beat: 4,
        numerator: 3,
        denominator: 4,
      },
    ]);
    expect(result.project.timeSignature).toEqual([4, 4]);
    expect(result.project.lengthBeats).toBe(16);
    expect(result.project.lengthBars).toBe(5);
    expect(result.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(kinds).toEqual(['time-signature']);
    expect(project).toEqual(before);
  });

  it.each([
    [1, 4, 16],
    [32, 8, 1],
    [2, 2, 4],
    [4, 4, 4],
    [8, 8, 4],
    [16, 16, 4],
  ] as const)(
    'accepts anchor signature %s/%s and computes %s bars',
    (numerator, denominator, lengthBars) => {
      const project = base();
      const anchorId = project.timeSignatureMap[0]?.id;
      if (anchorId === undefined) throw new Error('invalid fixture');

      const result = expectSuccess(updateTimeSignatureMapEvent(
        project,
        anchorId,
        { numerator, denominator },
      ));

      expect(result.project.timeSignature).toEqual([numerator, denominator]);
      expect(result.project.timeSignatureMap[0]).toMatchObject({
        id: anchorId,
        beat: 0,
        numerator,
        denominator,
      });
      expect(result.project.lengthBars).toBe(lengthBars);
      expect(result.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    },
  );

  it('moves and removes signature events with stable ids and recomputed bar counts', () => {
    const project = base();
    const first = expectSuccess(addTimeSignatureMapEvent(
      project,
      { beat: 4, numerator: 2, denominator: 4 },
      { eventId: 'signature-a' },
    ));
    const second = expectSuccess(addTimeSignatureMapEvent(
      first.project,
      { beat: 12, numerator: 4, denominator: 4 },
      { eventId: 'signature-b' },
    ));
    const beforeMove = structuredClone(second.project);

    const moved = expectSuccess(updateTimeSignatureMapEvent(
      second.project,
      'signature-b',
      { beat: 8 },
    ));
    expect(moved.eventId).toBe('signature-b');
    expect(moved.project.timeSignatureMap.map((event) => [event.id, event.beat])).toEqual([
      [project.timeSignatureMap[0]?.id, 0],
      ['signature-a', 4],
      ['signature-b', 8],
    ]);
    expect(moved.project.lengthBars).toBe(5);
    expect(second.project).toEqual(beforeMove);

    const removed = expectSuccess(removeTimeSignatureMapEvent(
      moved.project,
      'signature-b',
    ));
    expect(removed.project.timeSignatureMap.map((event) => event.id)).toEqual([
      project.timeSignatureMap[0]?.id,
      'signature-a',
    ]);
    expect(removed.project.lengthBars).toBe(7);
    expect(moved.project.timeSignatureMap).toHaveLength(3);
  });

  it('keeps every signature mutation usable when a codec-valid terminal event exists', () => {
    const project = base();
    const terminal: Project = {
      ...project,
      timeSignatureMap: [
        ...project.timeSignatureMap,
        {
          id: 'signature-terminal',
          beat: project.lengthBeats,
          numerator: 2,
          denominator: 4,
        },
      ],
    };
    expect(encodeProjectJson(terminal).ok).toBe(true);

    const noOp = expectSuccess(updateTimeSignatureMapEvent(
      terminal,
      'signature-terminal',
      {},
    ));
    expect(noOp.changed).toBe(false);
    expect(noOp.project).toBe(terminal);

    const updatedTerminal = expectSuccess(updateTimeSignatureMapEvent(
      terminal,
      'signature-terminal',
      { numerator: 4 },
    ));
    expect(updatedTerminal.project.lengthBars).toBe(4);
    expect(updatedTerminal.project.timeSignatureMap.at(-1)).toEqual({
      id: 'signature-terminal',
      beat: terminal.lengthBeats,
      numerator: 4,
      denominator: 4,
    });

    const signatureAnchorId = terminal.timeSignatureMap[0]?.id;
    if (signatureAnchorId === undefined) throw new Error('invalid fixture');
    const updatedAnchor = expectSuccess(updateTimeSignatureMapEvent(
      terminal,
      signatureAnchorId,
      { numerator: 2 },
    ));
    expect(updatedAnchor.project.timeSignature).toEqual([2, 4]);
    expect(updatedAnchor.project.lengthBars).toBe(8);
    expect(updatedAnchor.project.timeSignatureMap.at(-1)?.id).toBe(
      'signature-terminal',
    );

    const addedMiddle = expectSuccess(addTimeSignatureMapEvent(
      terminal,
      { beat: 4, numerator: 3, denominator: 4 },
      { eventId: 'signature-middle-with-terminal' },
    ));
    expect(addedMiddle.project.lengthBars).toBe(5);
    expect(addedMiddle.project.timeSignatureMap.at(-1)?.id).toBe(
      'signature-terminal',
    );

    const updatedMiddle = expectSuccess(updateTimeSignatureMapEvent(
      addedMiddle.project,
      'signature-middle-with-terminal',
      { numerator: 4 },
    ));
    expect(updatedMiddle.project.lengthBars).toBe(4);

    const removedMiddle = expectSuccess(removeTimeSignatureMapEvent(
      updatedMiddle.project,
      'signature-middle-with-terminal',
    ));
    expect(removedMiddle.project.lengthBars).toBe(4);
    expect(removedMiddle.project.timeSignatureMap).toEqual(
      terminal.timeSignatureMap,
    );

    const movedInside = expectSuccess(updateTimeSignatureMapEvent(
      terminal,
      'signature-terminal',
      { beat: 12 },
    ));
    expect(movedInside.project.lengthBars).toBe(5);
    expectFailure(
      updateTimeSignatureMapEvent(
        movedInside.project,
        'signature-terminal',
        { beat: movedInside.project.lengthBeats },
      ),
      'invalid-beat',
      movedInside.project,
    );

    const removedTerminal = expectSuccess(removeTimeSignatureMapEvent(
      terminal,
      'signature-terminal',
    ));
    expect(removedTerminal.project.lengthBars).toBe(4);
    expect(removedTerminal.project.timeSignatureMap).toEqual(
      project.timeSignatureMap,
    );
  });

  it('preserves exact Project identity for signature semantic no-ops', () => {
    const project = base();
    const anchorId = project.timeSignatureMap[0]?.id;
    if (anchorId === undefined) throw new Error('invalid fixture');

    const emptyPatch = expectSuccess(updateTimeSignatureMapEvent(project, anchorId, {}));
    const exactPatch = expectSuccess(updateTimeSignatureMapEvent(
      project,
      anchorId,
      { beat: 0, numerator: 4, denominator: 4 },
    ));

    expect(emptyPatch).toMatchObject({
      changed: false,
      map: 'time-signature',
      eventId: anchorId,
    });
    expect(emptyPatch.project).toBe(project);
    expect(exactPatch.changed).toBe(false);
    expect(exactPatch.project).toBe(project);
  });

  it('protects the signature anchor and returns typed lookup failures', () => {
    const project = base();
    const anchorId = project.timeSignatureMap[0]?.id;
    if (anchorId === undefined) throw new Error('invalid fixture');

    expectFailure(
      updateTimeSignatureMapEvent(project, anchorId, { beat: 4 }),
      'anchor-protected',
      project,
    );
    expectFailure(
      removeTimeSignatureMapEvent(project, anchorId),
      'anchor-protected',
      project,
    );
    expectFailure(
      updateTimeSignatureMapEvent(project, 'missing', {}),
      'event-not-found',
      project,
    );
    expectFailure(
      removeTimeSignatureMapEvent(project, 'missing'),
      'event-not-found',
      project,
    );
  });

  it.each([
    ['negative beat', { beat: -1, numerator: 4, denominator: 4 }, 'invalid-beat'],
    ['project-end beat', { beat: 16, numerator: 4, denominator: 4 }, 'invalid-beat'],
    ['non-finite beat', { beat: Number.NaN, numerator: 4, denominator: 4 }, 'invalid-beat'],
    ['zero numerator', { beat: 4, numerator: 0, denominator: 4 }, 'invalid-time-signature'],
    ['large numerator', { beat: 4, numerator: 33, denominator: 4 }, 'invalid-time-signature'],
    ['fractional numerator', { beat: 4, numerator: 2.5, denominator: 4 }, 'invalid-time-signature'],
    ['unsupported denominator', { beat: 4, numerator: 4, denominator: 3 }, 'invalid-time-signature'],
  ] as const)('rejects signature %s atomically', (_name, input, code) => {
    const project = base();
    const before = structuredClone(project);

    expectFailure(addTimeSignatureMapEvent(project, input), code, project);
    expect(project).toEqual(before);
  });

  it('rejects a non-boundary insertion and a signature that misaligns project end', () => {
    const project = base();

    expectFailure(
      addTimeSignatureMapEvent(
        project,
        { beat: 2, numerator: 3, denominator: 4 },
      ),
      'invalid-bar-boundary',
      project,
    );
    expectFailure(
      addTimeSignatureMapEvent(
        project,
        { beat: 4, numerator: 5, denominator: 4 },
      ),
      'invalid-bar-boundary',
      project,
    );
  });

  it('rejects edits or deletes that make a later signature cease to be a bar boundary', () => {
    const project = base();
    const first = expectSuccess(addTimeSignatureMapEvent(
      project,
      { beat: 4, numerator: 3, denominator: 4 },
      { eventId: 'signature-middle' },
    ));
    const second = expectSuccess(addTimeSignatureMapEvent(
      first.project,
      { beat: 10, numerator: 2, denominator: 4 },
      { eventId: 'signature-late' },
    ));
    const before = structuredClone(second.project);

    expectFailure(
      updateTimeSignatureMapEvent(
        second.project,
        'signature-middle',
        { numerator: 4 },
      ),
      'invalid-bar-boundary',
      second.project,
    );
    expectFailure(
      removeTimeSignatureMapEvent(second.project, 'signature-middle'),
      'invalid-bar-boundary',
      second.project,
    );
    expect(second.project).toEqual(before);
  });

  it('rejects signature add and move collisions atomically', () => {
    const project = base();
    expectFailure(
      addTimeSignatureMapEvent(
        project,
        { beat: 0, numerator: 3, denominator: 4 },
      ),
      'event-beat-conflict',
      project,
    );
    const first = expectSuccess(addTimeSignatureMapEvent(
      project,
      { beat: 4, numerator: 4, denominator: 4 },
      { eventId: 'signature-a' },
    ));
    const second = expectSuccess(addTimeSignatureMapEvent(
      first.project,
      { beat: 8, numerator: 4, denominator: 4 },
      { eventId: 'signature-b' },
    ));

    expectFailure(
      addTimeSignatureMapEvent(
        second.project,
        { beat: 8, numerator: 4, denominator: 4 },
      ),
      'event-beat-conflict',
      second.project,
    );
    expectFailure(
      updateTimeSignatureMapEvent(second.project, 'signature-b', { beat: 4 }),
      'event-beat-conflict',
      second.project,
    );
  });

  it('checks signature ids against every Project entity', () => {
    const project = base();
    const existingTempoId = project.tempoMap[0]?.id;
    if (existingTempoId === undefined) throw new Error('invalid fixture');

    expectFailure(
      addTimeSignatureMapEvent(
        project,
        { beat: 4, numerator: 3, denominator: 4 },
        { eventId: existingTempoId },
      ),
      'duplicate-id',
      project,
    );
  });
});

describe('tempo-map codec boundary', () => {
  it('fails closed for invalid or hostile sources and returns their exact reference', () => {
    const project = base();
    const invalid: Project = { ...project, bpm: 99 };
    const throwing = Object.defineProperty(
      { ...project },
      'tempoMap',
      { get: () => { throw new Error('hostile getter'); } },
    ) as Project;

    expectFailure(
      addTempoMapEvent(invalid, { beat: 4, bpm: 90 }),
      'project-not-adoptable',
      invalid,
    );
    expect(() => addTempoMapEvent(throwing, { beat: 4, bpm: 90 })).not.toThrow();
    expectFailure(
      addTempoMapEvent(throwing, { beat: 4, bpm: 90 }),
      'project-not-adoptable',
      throwing,
    );
  });

  it('codec-rejects a volatile invalid tempo candidate atomically', () => {
    const project = base();
    let reads = 0;
    const input = {
      beat: 4,
      get bpm() {
        reads += 1;
        return reads === 1 ? 90 : 301;
      },
    };
    const before = structuredClone(project);

    const result = expectFailure(
      addTempoMapEvent(project, input, { eventId: 'volatile-tempo' }),
      'invalid-map',
      project,
    );

    expect(result.error.issues?.some((issue) => issue.path === 'tempoMap[1].bpm')).toBe(true);
    expect(project).toEqual(before);
  });

  it('codec-rejects a signature candidate that invalidates dependent sections', () => {
    const project = base();
    const source: Project = {
      ...project,
      sections: [{
        id: 'section-tail',
        name: 'Tail',
        type: 'outro',
        startBar: 3,
        lengthBars: 1,
      }],
    };
    const anchorId = source.timeSignatureMap[0]?.id;
    if (anchorId === undefined) throw new Error('invalid fixture');
    const before = structuredClone(source);

    const result = expectFailure(
      updateTimeSignatureMapEvent(
        source,
        anchorId,
        { numerator: 8, denominator: 4 },
      ),
      'invalid-map',
      source,
    );

    expect(result.error.issues?.some((issue) => issue.path.startsWith('sections[0]'))).toBe(true);
    expect(source).toEqual(before);
  });
});
