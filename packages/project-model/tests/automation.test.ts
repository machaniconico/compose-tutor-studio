import { describe, expect, it } from 'vitest';
import {
  addPoint, createDefaultProject, deserializeProject, evaluateAutomation, movePoint, removePoint,
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
