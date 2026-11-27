import { describe, expect, it } from 'vitest';
import {
  addPoint, createDefaultProject, createEmptyProject, createTrack, deserializeProject, evaluateAutomation, MAX_AUTOMATION_POINTS, movePoint, removePoint,
  serializeProject, validateProject, type AutomationLane,
} from '../src';

const fade: AutomationLane = { points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] };

describe('volume automation', () => {
  it('holds the end values and interpolates linearly between points', () => {
    expect([-1, 0, 2, 4, 8].map((beat) => evaluateAutomation(fade, beat))).toEqual([0, 0, 0.5, 1, 1]);
    expect(evaluateAutomation(undefined, 0)).toBe(1);
    expect(evaluateAutomation({ points: [] }, 10)).toBe(1);
  });

  it('sorts additions and moves, and removes just the chosen point', () => {
    const added = addPoint(fade, { beat: 2, value: 0.5 });
    expect(added.points.map((point) => point.beat)).toEqual([0, 2, 4]);
    const moved = movePoint(added, 0, { beat: 5, value: 0.25 });
    expect(moved.points.map((point) => point.beat)).toEqual([2, 4, 5]);
    expect(removePoint(moved, 1).points).toEqual([{ beat: 2, value: 0.5 }, { beat: 5, value: 0.25 }]);
    expect(fade.points).toEqual([{ beat: 0, value: 0 }, { beat: 4, value: 1 }]);
  });

  it('uses the last point at each beat as the target on both sides', () => {
    const added = addPoint(fade, { beat: 4, value: 0.5 });
    expect([2, 4, 5].map((beat) => evaluateAutomation(added, beat))).toEqual([0.25, 0.5, 0.5]);
    const moved = movePoint(added, 0, { beat: 4, value: 0.75 });
    expect(evaluateAutomation(moved, -1)).toBe(0.75);
    expect(evaluateAutomation(moved, 4)).toBe(0.75);
  });

  it('preserves old projects and saved lanes without sorting or filling in defaults', () => {
    const project = createDefaultProject();
    const track = project.tracks[0]!;
    const old = deserializeProject(serializeProject(project));
    expect(old).toEqual(project);
    expect(old.tracks[0]).not.toHaveProperty('automation');

    const points = [{ beat: 4, value: 1 }, { beat: 0, value: 0 }];
    track.automation = { volume: { points } };
    const loaded = deserializeProject(serializeProject(project));
    expect(loaded.schemaVersion).toBe(old.schemaVersion);
    expect(loaded.tracks[0]?.automation?.volume?.points).toEqual(points);
    expect(validateProject(loaded).ok).toBe(false);
  });

  it('rejects volume automation on the master track with a Japanese message', () => {
    const project = createDefaultProject();
    const index = project.tracks.findIndex((track) => track.type === 'master');
    const master = project.tracks[index]!;
    master.automation = { volume: fade };
    expect(validateProject(project)).toMatchObject({
      ok: false,
      errors: [{ path: `tracks[${index}].automation.volume`, message: 'マスタートラックには音量の変化を設定できません。' }],
    });
  });
});

describe('pan and cutoff automation', () => {
  const keysProject = () => ({ ...createEmptyProject(), tracks: [createTrack('Keys', 'instrument')] });

  it('interpolates pan linearly and cutoff in log space, with the last point winning', () => {
    const pan = { points: [{ beat: 0, value: -1 }, { beat: 4, value: 1 }] };
    const cutoff = { points: [{ beat: 0, value: 0.1 }, { beat: 4, value: 2 }, { beat: 4, value: 10 }] };
    expect([-1, 0, 2, 4, 8].map((beat) => evaluateAutomation(pan, beat, 'pan'))).toEqual([-1, -1, 0, 1, 1]);
    expect([-1, 0, 2, 4, 8].map((beat) => evaluateAutomation(cutoff, beat, 'cutoff'))).toEqual([0.1, 0.1, 1, 10, 10]);
    expect(evaluateAutomation(undefined, 0, 'pan')).toBe(0);
    expect(evaluateAutomation({ points: [] }, 0, 'cutoff')).toBe(1);
  });

  it('enforces parameter bounds and the point cap for adding and moving points', () => {
    const empty = { points: [] };
    const point = { beat: 0, value: -1 };
    const pan = addPoint(empty, point, 'pan');
    expect(pan.points).toEqual([point]);
    expect(movePoint(pan, 0, { beat: 2, value: 1.01 }, 'pan')).toBe(pan);
    expect(addPoint(empty, { beat: 0, value: 0 }, 'cutoff')).toBe(empty);
    const full = { points: Array.from({ length: MAX_AUTOMATION_POINTS }, () => ({ beat: 0, value: 10 })) };
    expect(addPoint(full, { beat: 2, value: 0.1 }, 'cutoff')).toBe(full);
    const moved = movePoint(full, 0, { beat: 2, value: 0.1 }, 'cutoff');
    expect(moved.points).toHaveLength(MAX_AUTOMATION_POINTS);
    expect(moved.points.at(-1)).toEqual({ beat: 2, value: 0.1 });
  });

  it('keeps unsorted pan and duplicate cutoff points as saved, leaving validation to report them', () => {
    const project = keysProject();
    project.tracks[0]!.automation = {
      pan: { points: [{ beat: 2, value: 1 }, { beat: 1, value: -0.5 }] },
      cutoff: { points: [{ beat: 0.123, value: 0.1 }, { beat: 0.123, value: 10 }] },
    };
    const loaded = deserializeProject(serializeProject(project));
    expect(loaded).toEqual(project);
    expect(validateProject(loaded).errors.map(({ path }) => path)).toEqual(['tracks[0].automation.pan.points[1].beat']);
  });

  it.each([
    ['pan', [-1.01, 1.01, NaN, Infinity, null, { toString: null }]],
    ['cutoff', [0, 0.099, 10.01, -Infinity, null, { toString: null }]],
  ] as const)('rejects malformed %s values without coercing them', (parameter, values) => {
    const project = keysProject();
    project.tracks[0]!.automation = {
      [parameter]: { points: values.map((value, beat) => ({ beat, value: value as number })) },
    };
    expect(validateProject(project).errors.map(({ path }) => path)).toEqual(
      values.map((_, i) => `tracks[0].automation.${parameter}.points[${i}].value`),
    );
  });

  it('rejects malformed automation containers, points and oversized lanes', () => {
    const project = keysProject();
    const track = project.tracks[0]!;
    for (const malformed of [null, { toString: null }, { pan: null }, { cutoff: { points: { toString: null } } },
      { cutoff: { points: [null] } }, { pan: { points: Array(MAX_AUTOMATION_POINTS + 1).fill({ beat: 0, value: 0 }) } }]) {
      track.automation = malformed as typeof track.automation;
      expect(validateProject(project).ok).toBe(false);
    }
    Object.defineProperty(track, 'automation', { get() { throw new Error('unreadable'); } });
    expect(validateProject(project).errors).toMatchObject([{ path: 'tracks[0].automation' }]);
  });

  it.each([{ points: [] }, { points: [{ beat: 0, value: 1 }] }])('rejects cutoff lanes on drums', (cutoff) => {
    const project = { ...createEmptyProject(), tracks: [createTrack('Drums', 'drum')] };
    project.tracks[0]!.automation = { volume: fade, pan: { points: [] }, cutoff };
    expect(validateProject(project).errors.filter(({ path }) => path.includes('automation'))).toEqual([
      { path: 'tracks[0].automation.cutoff', message: 'ドラムトラックには明るさの変化を設定できません。' },
    ]);
  });

  it('rejects all three lanes on the master including empty lanes', () => {
    const project = createDefaultProject();
    const index = project.tracks.findIndex((track) => track.type === 'master');
    const empty = { points: [] };
    project.tracks[index]!.automation = { volume: empty, pan: empty, cutoff: empty };
    expect(validateProject(project).errors.map(({ path }) => path)).toEqual(
      ['volume', 'pan', 'cutoff'].map((parameter) => `tracks[${index}].automation.${parameter}`),
    );
  });
});
