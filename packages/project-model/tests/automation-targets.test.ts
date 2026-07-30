import { describe, expect, it } from 'vitest';
import {
  automationTargetTypesForTrack,
  createEmptyProject,
  effectiveMasterTrackId,
  isSupportedAutomationTarget,
  type AutomationTarget,
} from '../src/index';

const clock = () => new Date('2026-07-30T00:00:00.000Z');

describe('automation target support', () => {
  it('uses the first Master as the only volume-capable Master', () => {
    const project = createEmptyProject({ clock });
    const effectiveMaster = project.tracks.find((track) => track.type === 'master')!;
    const regularTrack = project.tracks.find((track) => track.type !== 'master')!;
    const compatibilityMaster = {
      ...structuredClone(effectiveMaster),
      id: 'target-compatibility-master',
    };
    project.tracks.push(compatibilityMaster);

    expect(effectiveMasterTrackId(project)).toBe(effectiveMaster.id);
    expect(automationTargetTypesForTrack(project, regularTrack.id)).toEqual([
      'track-volume',
      'track-pan',
    ]);
    expect(automationTargetTypesForTrack(project, effectiveMaster.id)).toEqual([
      'track-volume',
    ]);
    expect(automationTargetTypesForTrack(project, compatibilityMaster.id)).toEqual([]);
    expect(automationTargetTypesForTrack(project, 'missing')).toEqual([]);
    expect(isSupportedAutomationTarget(project, {
      type: 'track-volume',
      trackId: effectiveMaster.id,
    })).toBe(true);
    expect(isSupportedAutomationTarget(project, {
      type: 'track-pan',
      trackId: effectiveMaster.id,
    })).toBe(false);
    expect(isSupportedAutomationTarget(
      project,
      { type: 'track-gain', trackId: regularTrack.id } as unknown as AutomationTarget,
    )).toBe(false);
  });

  it('returns null when a compatibility project has no Master', () => {
    const project = createEmptyProject({ clock });
    project.tracks = project.tracks.filter((track) => track.type !== 'master');

    expect(effectiveMasterTrackId(project)).toBeNull();
  });
});
