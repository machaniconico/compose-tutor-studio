import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_RECORDING_EPSILON,
  AUTOMATION_TOUCH_RETURN_SECONDS,
  AUTOMATION_WRITE_TARGET_TYPES,
  beginAutomationPass,
  cancelAutomationPass,
  createEmptyProject,
  MAX_AUTOMATION_POINTS_PER_LANE,
  normalizeAutomationSamples,
  punchOutAutomationPass,
  rebaseAutomationPass,
  reduceAutomationSamples,
  releaseAutomationPass,
  sampleAutomationPass,
  touchAutomationPass,
  type AutomationLane,
  type AutomationPass,
  type AutomationPassFinalizationResult,
  type AutomationPassRebaseResult,
  type AutomationPassTransitionResult,
  type AutomationRecordingErrorCode,
  type AutomationRecordingSample,
  type AutomationTarget,
  type Project,
} from '../src/index';

const clock = () => new Date('2026-07-30T00:00:00.000Z');

function fixture(): Readonly<{
  project: Project;
  trackId: string;
}> {
  const project = createEmptyProject({ clock, lengthBars: 4 });
  const track = project.tracks.find((candidate) => candidate.type !== 'master');
  if (track === undefined) throw new Error('invalid fixture');
  return { project, trackId: track.id };
}

function passSuccess(result: AutomationPassTransitionResult): AutomationPass {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.pass;
}

function finalSuccess(result: AutomationPassFinalizationResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function rebaseSuccess(result: AutomationPassRebaseResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function expectFailure(
  result:
    | AutomationPassTransitionResult
    | AutomationPassFinalizationResult
    | AutomationPassRebaseResult,
  code: AutomationRecordingErrorCode,
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected automation recording failure');
  expect(result.error.code).toBe(code);
  return result;
}

function idFactory() {
  let next = 0;
  return (kind: 'lane' | 'point') => `${kind}-recorded-${++next}`;
}

function target(
  trackId: string,
  type: AutomationTarget['type'] = 'track-volume',
): AutomationTarget {
  return { type, trackId };
}

function laneFor(
  project: Project,
  trackId: string,
  type: AutomationTarget['type'],
): AutomationLane {
  const lane = project.automationLanes.find((candidate) =>
    candidate.target.trackId === trackId && candidate.target.type === type);
  if (lane === undefined) throw new Error(`missing ${type} lane`);
  return lane;
}

function valueAt(lane: AutomationLane, baseValue: number, beat: number): number {
  let previousIndex = -1;
  for (let index = 0; index < lane.points.length; index += 1) {
    if (lane.points[index]!.beat > beat) break;
    previousIndex = index;
  }
  if (previousIndex < 0) return baseValue;
  const previous = lane.points[previousIndex]!;
  const next = lane.points[previousIndex + 1];
  if (previous.interpolation !== 'linear' || next === undefined) return previous.value;
  const progress = (beat - previous.beat) / (next.beat - previous.beat);
  return previous.value + (next.value - previous.value) * progress;
}

describe('automation recording pass lifecycle', () => {
  it('owns a frozen immutable pass and makes Read/no-touch/cancel semantic no-ops', () => {
    const { project, trackId } = fixture();
    const source = structuredClone(project);

    for (const mode of ['read', 'touch', 'latch'] as const) {
      const pass = passSuccess(beginAutomationPass(project, {
        trackId,
        mode,
        startBeat: 1,
      }));
      expect(Object.isFrozen(pass)).toBe(true);
      expect(Object.isFrozen(pass.tracks)).toBe(true);
      expect(Object.isFrozen(pass.frozenProject)).toBe(true);
      expect(Object.isFrozen(pass.frozenProject.tracks[0])).toBe(true);
      expect(pass.sourceProject).toBe(project);

      const punched = finalSuccess(punchOutAutomationPass(pass, {
        project,
        punchOutBeat: 3,
      }));
      expect(punched.changed).toBe(false);
      expect(punched.project).toBe(project);
    }

    const touched = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'touch',
      startBeat: 1,
    }));
    const afterTouch = passSuccess(touchAutomationPass(touched, {
      target: target(trackId),
      beat: 1.5,
      value: 1.2,
    }));
    const cancelled = finalSuccess(cancelAutomationPass(afterTouch));
    expect(cancelled.changed).toBe(false);
    expect(cancelled.project).toBe(project);
    expect(project).toEqual(source);
  });

  it('returns explicit failures for invalid transitions and stale Project ownership', () => {
    const { project, trackId } = fixture();
    const pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'touch',
      startBeat: 1,
    }));

    expectFailure(sampleAutomationPass(pass, {
      target: target(trackId),
      beat: 1.25,
      value: 1,
    }), 'not-touching');
    expectFailure(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 1.25,
      value: 3,
    }), 'invalid-value');
    expectFailure(punchOutAutomationPass(pass, {
      project: structuredClone(project),
      punchOutBeat: 2,
    }), 'stale-project');
    const effectiveMaster = project.tracks.find((track) => track.type === 'master')!;
    const compatibilityMaster = {
      ...structuredClone(effectiveMaster),
      id: 'recording-compatibility-master',
    };
    const compatibilityProject = {
      ...project,
      tracks: [...project.tracks, compatibilityMaster],
    };
    expectFailure(beginAutomationPass(compatibilityProject, {
      trackId: compatibilityMaster.id,
      mode: 'write',
      startBeat: 0,
    }), 'master-protected');

    const touched = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 1.5,
      value: 1,
    }));
    expectFailure(punchOutAutomationPass(touched, {
      project,
      punchOutBeat: 1.25,
      idFactory: idFactory(),
    }), 'invalid-beat');
  });

  it('turns invalid cancel pass values into typed failures without throwing', () => {
    for (const invalid of [null, undefined, {}, { sourceProject: null }]) {
      expectFailure(
        cancelAutomationPass(invalid as unknown as AutomationPass),
        'invalid-pass',
      );
    }
  });

  it('validates capture beats only against the frozen pass snapshot', () => {
    const { project, trackId } = fixture();
    const originalLengthBeats = project.lengthBeats;
    let pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'touch',
      startBeat: 0,
    }));

    project.lengthBeats = 0.5;
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 1,
      value: 0.75,
    }));
    pass = passSuccess(sampleAutomationPass(pass, {
      target: target(trackId),
      beat: 1.25,
      value: 1.25,
    }));
    pass = passSuccess(releaseAutomationPass(pass, {
      target: target(trackId),
      beat: 1.5,
    }));
    expectFailure(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 2,
      idFactory: idFactory(),
    }), 'project-not-adoptable');

    project.lengthBeats = originalLengthBeats;
    const result = finalSuccess(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 2,
      idFactory: idFactory(),
    }));
    expect(laneFor(result.project, trackId, 'track-volume').points)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ beat: 1, value: 0.75 }),
        expect.objectContaining({ beat: 1.25, value: 1.25 }),
      ]));
  });

  it('normalizes same-beat samples with latest call order winning', () => {
    const { project, trackId } = fixture();
    let pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'touch',
      startBeat: 0,
    }));
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 1,
      value: 0.5,
    }));
    pass = passSuccess(sampleAutomationPass(pass, {
      target: target(trackId),
      beat: 1,
      value: 1.25,
    }));
    pass = passSuccess(releaseAutomationPass(pass, {
      target: target(trackId),
      beat: 1,
    }));

    const result = finalSuccess(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 3,
      idFactory: idFactory(),
    }));
    expect(laneFor(result.project, trackId, 'track-volume').points[0]).toMatchObject({
      beat: 1,
      value: 1.25,
    });
  });
});

describe('automation recording pass rebasing', () => {
  function mixedModePass() {
    const { project, trackId: writeTrackId } = fixture();
    const readTrack = project.tracks.find((candidate) =>
      candidate.type !== 'master' && candidate.id !== writeTrackId);
    if (readTrack === undefined) throw new Error('missing Read Track fixture');
    const writeTrack = project.tracks.find((candidate) => candidate.id === writeTrackId)!;
    writeTrack.volume = 1.4;
    writeTrack.pan = -0.35;
    const pass = passSuccess(beginAutomationPass(project, {
      startBeat: 2,
      tracks: [
        { trackId: writeTrackId, mode: 'write' },
        { trackId: readTrack.id, mode: 'read' },
      ],
    }));
    return {
      project,
      pass,
      writeTrackId,
      readTrackId: readTrack.id,
    };
  }

  it('rebases Read scalars while preserving the exact frozen Write baseline', () => {
    const { project, pass, writeTrackId, readTrackId } = mixedModePass();
    const nextProject = structuredClone(project);
    const readTrack = nextProject.tracks.find((candidate) => candidate.id === readTrackId)!;
    readTrack.volume = 1.25;
    readTrack.pan = 0.4;
    nextProject.updatedAt = '2026-07-30T00:00:01.000Z';

    const rebased = rebaseSuccess(rebaseAutomationPass(pass, {
      expectedProject: project,
      nextProject,
    }));

    expect(rebased.changedTargets).toEqual([
      target(readTrackId, 'track-volume'),
      target(readTrackId, 'track-pan'),
    ]);
    expect(Object.isFrozen(rebased.changedTargets)).toBe(true);
    expect(rebased.changedTargets.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(rebased.pass)).toBe(true);
    expect(rebased.pass.sourceProject).toBe(nextProject);
    expect(rebased.pass.sourceFingerprint).not.toBe(pass.sourceFingerprint);
    expect(pass.sourceProject).toBe(project);
    expect(rebased.pass.frozenProject).toBe(pass.frozenProject);
    expect(rebased.pass.captures).toBe(pass.captures);
    expect(rebased.pass.tracks).toBe(pass.tracks);
    expect(rebased.pass.startBeat).toBe(pass.startBeat);

    const punched = finalSuccess(punchOutAutomationPass(rebased.pass, {
      project: nextProject,
      punchOutBeat: 6,
      idFactory: idFactory(),
    }));
    expect(laneFor(punched.project, writeTrackId, 'track-volume').points)
      .toContainEqual(expect.objectContaining({ beat: 2, value: 1.4 }));
    expect(laneFor(punched.project, writeTrackId, 'track-pan').points)
      .toContainEqual(expect.objectContaining({ beat: 2, value: -0.35 }));
  });

  it('rebases only the effective Master Read volume scalar', () => {
    const project = createEmptyProject({ clock, lengthBars: 4 });
    const master = project.tracks.find((track) => track.type === 'master')!;
    const pass = passSuccess(beginAutomationPass(project, {
      trackId: master.id,
      mode: 'read',
      startBeat: 1,
    }));
    const nextProject = structuredClone(project);
    nextProject.tracks.find((track) => track.id === master.id)!.volume = 0.75;
    nextProject.updatedAt = '2026-07-30T00:00:01.000Z';

    const rebased = rebaseSuccess(rebaseAutomationPass(pass, {
      expectedProject: project,
      nextProject,
    }));
    expect(rebased.changedTargets).toEqual([target(master.id, 'track-volume')]);

    const panProject = structuredClone(nextProject);
    panProject.tracks.find((track) => track.id === master.id)!.pan = 0.25;
    panProject.updatedAt = '2026-07-30T00:00:02.000Z';
    expectFailure(rebaseAutomationPass(rebased.pass, {
      expectedProject: nextProject,
      nextProject: panProject,
    }), 'invalid-pass');
  });

  it('supports chained rebases and rejects every superseded source reference', () => {
    const { project, pass, readTrackId } = mixedModePass();
    const firstProject = structuredClone(project);
    firstProject.tracks.find((track) => track.id === readTrackId)!.volume = 1.2;
    firstProject.updatedAt = '2026-07-30T00:00:01.000Z';
    const first = rebaseSuccess(rebaseAutomationPass(pass, {
      expectedProject: project,
      nextProject: firstProject,
    }));

    expectFailure(rebaseAutomationPass(first.pass, {
      expectedProject: project,
      nextProject: structuredClone(firstProject),
    }), 'stale-project');

    const secondProject = structuredClone(firstProject);
    secondProject.tracks.find((track) => track.id === readTrackId)!.pan = -0.5;
    secondProject.updatedAt = '2026-07-30T00:00:02.000Z';
    const second = rebaseSuccess(rebaseAutomationPass(first.pass, {
      expectedProject: firstProject,
      nextProject: secondProject,
    }));

    expect(second.changedTargets).toEqual([target(readTrackId, 'track-pan')]);
    expectFailure(cancelAutomationPass(second.pass, project), 'stale-project');
    expectFailure(cancelAutomationPass(second.pass, firstProject), 'stale-project');
    const cancelled = finalSuccess(cancelAutomationPass(second.pass));
    expect(cancelled.project).toBe(secondProject);
  });

  it.each([
    {
      name: 'an unrelated root field',
      mutate: (project: Project) => {
        project.title = 'unrelated';
      },
    },
    {
      name: 'a Write Track scalar',
      mutate: (project: Project, writeTrackId: string) => {
        project.tracks.find((track) => track.id === writeTrackId)!.volume = 0.5;
      },
    },
    {
      name: 'a Master scalar',
      mutate: (project: Project) => {
        project.tracks.find((track) => track.type === 'master')!.pan = 0.25;
      },
    },
  ])('rejects a Read scalar change mixed with $name', ({ mutate }) => {
    const { project, pass, writeTrackId, readTrackId } = mixedModePass();
    const nextProject = structuredClone(project);
    nextProject.tracks.find((track) => track.id === readTrackId)!.volume = 1.2;
    nextProject.updatedAt = '2026-07-30T00:00:01.000Z';
    mutate(nextProject, writeTrackId);

    expectFailure(rebaseAutomationPass(pass, {
      expectedProject: project,
      nextProject,
    }), 'invalid-pass');
  });

  it('rejects a source mutated in place before the compare-and-swap', () => {
    const { project, pass, readTrackId } = mixedModePass();
    project.tracks.find((track) => track.id === readTrackId)!.volume = 1.2;
    const nextProject = structuredClone(project);
    nextProject.tracks.find((track) => track.id === readTrackId)!.pan = 0.25;

    expectFailure(rebaseAutomationPass(pass, {
      expectedProject: project,
      nextProject,
    }), 'stale-project');
  });

  it('requires a real Read scalar change, a codec-valid next Project, and the same id', () => {
    const { project, pass, readTrackId } = mixedModePass();
    const timestampOnly = structuredClone(project);
    timestampOnly.updatedAt = '2026-07-30T00:00:01.000Z';
    expectFailure(rebaseAutomationPass(pass, {
      expectedProject: project,
      nextProject: timestampOnly,
    }), 'invalid-pass');

    const otherId = structuredClone(project);
    otherId.id = 'other-project';
    otherId.tracks.find((track) => track.id === readTrackId)!.volume = 1.2;
    expectFailure(rebaseAutomationPass(pass, {
      expectedProject: project,
      nextProject: otherId,
    }), 'invalid-pass');

    const invalid = structuredClone(project);
    invalid.tracks.find((track) => track.id === readTrackId)!.volume = 3;
    expectFailure(rebaseAutomationPass(pass, {
      expectedProject: project,
      nextProject: invalid,
    }), 'project-not-adoptable');
  });
});

describe('Touch, Latch, and Write replacement semantics', () => {
  it('restores the exact old curve 100 ms after Touch across a tempo change', () => {
    const { project, trackId } = fixture();
    const oldStart = {
      id: 'old-start',
      beat: 0,
      value: 0.5,
      interpolation: 'linear' as const,
    };
    const oldEnd = {
      id: 'old-end',
      beat: 8,
      value: 1.5,
      interpolation: 'hold' as const,
    };
    project.tempoMap = [
      { ...project.tempoMap[0]!, beat: 0, bpm: 120 },
      { id: 'tempo-slow', beat: 4, bpm: 60 },
    ];
    project.automationLanes = [{
      id: 'volume-lane',
      bypassed: true,
      target: target(trackId),
      points: [oldStart, oldEnd],
    }];
    let pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'touch',
      startBeat: 3,
    }));
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 3.8,
      value: 1.8,
    }));
    pass = passSuccess(releaseAutomationPass(pass, {
      target: target(trackId),
      beat: 3.9,
    }));

    const result = finalSuccess(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 6,
      idFactory: idFactory(),
    }));
    const lane = laneFor(result.project, trackId, 'track-volume');
    const returnBeat = 4.05;
    const returnPoint = lane.points.find((point) =>
      Math.abs(point.beat - returnBeat) < Number.EPSILON);
    expect(AUTOMATION_TOUCH_RETURN_SECONDS).toBe(0.1);
    expect(returnPoint?.value).toBeCloseTo(
      oldStart.value + (oldEnd.value - oldStart.value) * returnBeat / oldEnd.beat,
      12,
    );
    expect(lane.bypassed).toBe(true);
    expect(lane.points[0]).toBe(oldStart);
    expect(lane.points.at(-1)).toBe(oldEnd);
    expect(valueAt(lane, 1, 4.5)).toBeCloseTo(
      oldStart.value + (oldEnd.value - oldStart.value) * 4.5 / oldEnd.beat,
      12,
    );
  });

  it('Latch replaces first contact through the half-open punch-out and restores there', () => {
    const { project, trackId } = fixture();
    const before = { id: 'before', beat: 0, value: 0.75, interpolation: 'linear' as const };
    const boundary = { id: 'boundary', beat: 5, value: 1.25, interpolation: 'hold' as const };
    const after = { id: 'after', beat: 7, value: 1, interpolation: 'hold' as const };
    project.automationLanes = [{
      id: 'volume-lane',
      bypassed: false,
      target: target(trackId),
      points: [before, boundary, after],
    }];
    let pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'latch',
      startBeat: 1,
    }));
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 2,
      value: 1.5,
    }));
    pass = passSuccess(sampleAutomationPass(pass, {
      target: target(trackId),
      beat: 3,
      value: 1.7,
    }));
    pass = passSuccess(releaseAutomationPass(pass, {
      target: target(trackId),
      beat: 3.25,
    }));
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 4,
      value: 0.4,
    }));
    pass = passSuccess(releaseAutomationPass(pass, {
      target: target(trackId),
      beat: 4.2,
    }));

    const result = finalSuccess(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 5,
      idFactory: idFactory(),
    }));
    const points = laneFor(result.project, trackId, 'track-volume').points;
    expect(points[0]).toBe(before);
    expect(points.find((point) => point.beat === 5)).toBe(boundary);
    expect(points.at(-1)).toBe(after);
    const latestRecorded = points.find((point) => point.beat === 3.25);
    expect(latestRecorded).toMatchObject({ value: 1.7, interpolation: 'hold' });
    expect(valueAt(laneFor(result.project, trackId, 'track-volume'), 1, 3.9)).toBe(1.7);
  });

  it('Write explicitly records frozen volume and pan scalars without touch', () => {
    const { project, trackId } = fixture();
    const track = project.tracks.find((candidate) => candidate.id === trackId)!;
    track.volume = 1.4;
    track.pan = -0.35;
    project.automationLanes = [{
      id: 'pan-lane',
      bypassed: true,
      target: target(trackId, 'track-pan'),
      points: [
        { id: 'pan-before', beat: 0, value: 0, interpolation: 'linear' },
        { id: 'pan-after', beat: 8, value: 0.5, interpolation: 'hold' },
      ],
    }];
    const pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'write',
      startBeat: 2,
    }));
    track.volume = 0.1;
    track.pan = 0.8;
    // Restore the exact source fingerprint to isolate the frozen scalar assertion.
    track.volume = 1.4;
    track.pan = -0.35;

    const result = finalSuccess(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 6,
      idFactory: idFactory(),
    }));
    expect(AUTOMATION_WRITE_TARGET_TYPES).toEqual(['track-volume', 'track-pan']);
    const volume = laneFor(result.project, trackId, 'track-volume');
    const pan = laneFor(result.project, trackId, 'track-pan');
    expect(volume.points.find((point) => point.beat === 2)).toMatchObject({
      value: 1.4,
      interpolation: 'hold',
    });
    expect(pan.points.find((point) => point.beat === 2)).toMatchObject({
      value: -0.35,
      interpolation: 'hold',
    });
    expect(pan.bypassed).toBe(true);
    expect(volume.points.find((point) => point.beat === 6)?.value).toBe(1.4);
    expect(pan.points.find((point) => point.beat === 6)?.value).toBeCloseTo(0.375, 12);
  });

  it('records effective-Master Write as volume only', () => {
    const project = createEmptyProject({ clock, lengthBars: 4 });
    const master = project.tracks.find((track) => track.type === 'master')!;
    master.volume = 0.8;
    master.pan = 0.2;
    const pass = passSuccess(beginAutomationPass(project, {
      trackId: master.id,
      mode: 'write',
      startBeat: 2,
    }));

    expect(pass.captures.map((capture) => capture.target)).toEqual([
      target(master.id, 'track-volume'),
    ]);
    expectFailure(touchAutomationPass(pass, {
      target: target(master.id, 'track-pan'),
      beat: 3,
      value: 0.1,
    }), 'invalid-target');

    const result = finalSuccess(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 6,
      idFactory: idFactory(),
    }));
    expect(laneFor(result.project, master.id, 'track-volume').points)
      .toContainEqual(expect.objectContaining({ beat: 2, value: 0.8 }));
    expect(result.project.automationLanes.some((lane) =>
      lane.target.trackId === master.id && lane.target.type === 'track-pan')).toBe(false);
  });

  it('Write holds the frozen scalar until first contact without predicting its value backward', () => {
    const { project, trackId } = fixture();
    const track = project.tracks.find((candidate) => candidate.id === trackId)!;
    track.volume = 0.8;
    let pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'write',
      startBeat: 1,
    }));
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 3,
      value: 1.6,
    }));
    pass = passSuccess(releaseAutomationPass(pass, {
      target: target(trackId),
      beat: 3.5,
    }));

    const result = finalSuccess(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 5,
      idFactory: idFactory(),
    }));
    const volume = laneFor(result.project, trackId, 'track-volume');
    expect(volume.points.find((point) => point.beat === 1)).toMatchObject({
      value: 0.8,
      interpolation: 'hold',
    });
    expect(valueAt(volume, track.volume, 2.999)).toBe(0.8);
    expect(valueAt(volume, track.volume, 3)).toBe(1.6);
  });

  it('preserves the old linear curve at every representative beat before a half-open start', () => {
    const { project, trackId } = fixture();
    const oldStart = {
      id: 'linear-old-start',
      beat: 0,
      value: 0,
      interpolation: 'linear' as const,
    };
    const oldEnd = {
      id: 'linear-old-end',
      beat: 8,
      value: 1,
      interpolation: 'hold' as const,
    };
    const oldLane: AutomationLane = {
      id: 'linear-old-lane',
      bypassed: false,
      target: target(trackId),
      points: [oldStart, oldEnd],
    };
    project.automationLanes = [oldLane];
    let pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'latch',
      startBeat: 1,
    }));
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 4,
      value: 2,
    }));

    const result = finalSuccess(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 6,
      idFactory: idFactory(),
    }));
    const recorded = laneFor(result.project, trackId, 'track-volume');
    for (const beat of [0, 0.5, 2, 3.5, 3.999999]) {
      expect(valueAt(recorded, 1, beat)).toBeCloseTo(valueAt(oldLane, 1, beat), 12);
    }
    expect(recorded.points[0]).toBe(oldStart);
    expect(recorded.points.at(-1)).toBe(oldEnd);
    expect(valueAt(recorded, 1, 4)).toBe(2);
    expect(result.recordedRanges).toEqual([{
      target: target(trackId),
      startBeat: 4,
      endBeat: 6,
    }]);
  });

  it.each(['latch', 'write'] as const)(
    '%s lets a same-beat retouch replace the release hold marker',
    (mode) => {
      const { project, trackId } = fixture();
      let pass = passSuccess(beginAutomationPass(project, {
        trackId,
        mode,
        startBeat: 1,
      }));
      pass = passSuccess(touchAutomationPass(pass, {
        target: target(trackId),
        beat: 2,
        value: 1,
      }));
      pass = passSuccess(releaseAutomationPass(pass, {
        target: target(trackId),
        beat: 3,
      }));
      pass = passSuccess(touchAutomationPass(pass, {
        target: target(trackId),
        beat: 3,
        value: 1.5,
      }));
      pass = passSuccess(sampleAutomationPass(pass, {
        target: target(trackId),
        beat: 4,
        value: 2,
      }));
      pass = passSuccess(releaseAutomationPass(pass, {
        target: target(trackId),
        beat: 4,
      }));

      const result = finalSuccess(punchOutAutomationPass(pass, {
        project,
        punchOutBeat: 5,
        idFactory: idFactory(),
      }));
      const recorded = laneFor(result.project, trackId, 'track-volume');
      const pointBeforeRetouch = recorded.points.filter((point) => point.beat <= 3).at(-1);
      expect(pointBeforeRetouch?.interpolation).toBe('linear');
      expect(valueAt(recorded, 1, 3)).toBeCloseTo(1.5, 12);
      expect(valueAt(recorded, 1, 3.5)).toBeCloseTo(1.75, 12);
    },
  );

  it('keeps Volume and Pan independent for Touch and Latch', () => {
    for (const mode of ['touch', 'latch'] as const) {
      const { project, trackId } = fixture();
      const panPoints = [
        { id: `pan-before-${mode}`, beat: 0, value: -0.5, interpolation: 'linear' as const },
        { id: `pan-after-${mode}`, beat: 8, value: 0.5, interpolation: 'hold' as const },
      ];
      const panLane: AutomationLane = {
        id: `pan-lane-${mode}`,
        bypassed: mode === 'touch',
        target: target(trackId, 'track-pan'),
        points: panPoints,
      };
      project.automationLanes = [panLane];
      let pass = passSuccess(beginAutomationPass(project, {
        trackId,
        mode,
        startBeat: 1,
      }));
      pass = passSuccess(touchAutomationPass(pass, {
        target: target(trackId),
        beat: 2,
        value: 1.25,
      }));
      pass = passSuccess(releaseAutomationPass(pass, {
        target: target(trackId),
        beat: 2.25,
      }));

      const result = finalSuccess(punchOutAutomationPass(pass, {
        project,
        punchOutBeat: 4,
        idFactory: idFactory(),
      }));
      expect(laneFor(result.project, trackId, 'track-pan')).toBe(panLane);
      expect(laneFor(result.project, trackId, 'track-pan').points).toBe(panPoints);
    }
  });

  it('retains exact outside point objects/IDs and allocates new IDs deterministically', () => {
    const { project, trackId } = fixture();
    const before = { id: 'old-before', beat: 0, value: 1, interpolation: 'hold' as const };
    const replaced = { id: 'old-inside', beat: 2, value: 0.5, interpolation: 'hold' as const };
    const after = { id: 'old-after', beat: 8, value: 1, interpolation: 'hold' as const };
    project.automationLanes = [{
      id: 'old-lane',
      bypassed: false,
      target: target(trackId),
      points: [before, replaced, after],
    }];
    let pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'touch',
      startBeat: 1,
    }));
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 1.5,
      value: 1.5,
    }));
    pass = passSuccess(releaseAutomationPass(pass, {
      target: target(trackId),
      beat: 2.5,
    }));
    const ids: string[] = [];
    let serial = 0;
    const result = finalSuccess(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 4,
      idFactory: (kind) => {
        const id = `${kind}-stable-${++serial}`;
        ids.push(id);
        return id;
      },
    }));
    const points = laneFor(result.project, trackId, 'track-volume').points;
    expect(points[0]).toBe(before);
    expect(points.at(-1)).toBe(after);
    expect(points.some((point) => point === replaced)).toBe(false);
    expect(ids).toEqual(['point-stable-1', 'point-stable-2', 'point-stable-3']);
  });

  it('requires an explicit deterministic id factory before adopting a changed pass', () => {
    const { project, trackId } = fixture();
    let pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'latch',
      startBeat: 1,
    }));
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 2,
      value: 1.25,
    }));

    const first = expectFailure(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 3,
    }), 'id-factory-failed');
    const second = expectFailure(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 3,
    }), 'id-factory-failed');
    expect(second).toEqual(first);
    expect(project.automationLanes).toEqual([]);
  });
});

describe('deterministic error-bounded reduction', () => {
  function reduce(samples: readonly AutomationRecordingSample[]) {
    const result = reduceAutomationSamples('track-volume', samples);
    if (!result.ok) throw new Error(result.error.message);
    return result.samples;
  }

  it('reduces constant and straight lines to their endpoints', () => {
    expect(reduce([
      { beat: 0, value: 1 },
      { beat: 1, value: 1 },
      { beat: 2, value: 1 },
    ])).toEqual([
      { beat: 0, value: 1 },
      { beat: 2, value: 1 },
    ]);
    expect(reduce([
      { beat: 0, value: 0 },
      { beat: 1, value: 0.5 },
      { beat: 2, value: 1 },
    ])).toEqual([
      { beat: 0, value: 0 },
      { beat: 2, value: 1 },
    ]);
  });

  it('preserves a one-sample spike and is deterministic', () => {
    const samples = [
      { beat: 0, value: 0 },
      { beat: 1, value: 0 },
      { beat: 2, value: 1 },
      { beat: 3, value: 0 },
      { beat: 4, value: 0 },
    ];
    const first = reduce(samples);
    const second = reduce(samples);
    expect(first).toEqual(second);
    expect(first).toContainEqual({ beat: 2, value: 1 });
  });

  it('reconstructs every dropped sample within the target epsilon', () => {
    const samples = Array.from({ length: 101 }, (_unused, index) => ({
      beat: index / 10,
      value: 1 + Math.sin(index / 8) * 0.2,
    }));
    const reduced = reduce(samples);
    for (const sample of samples) {
      const exact = reduced.find((point) => point.beat === sample.beat);
      if (exact !== undefined) continue;
      const rightIndex = reduced.findIndex((point) => point.beat > sample.beat);
      const left = reduced[rightIndex - 1]!;
      const right = reduced[rightIndex]!;
      const progress = (sample.beat - left.beat) / (right.beat - left.beat);
      const reconstructed = left.value + (right.value - left.value) * progress;
      expect(Math.abs(sample.value - reconstructed))
        .toBeLessThanOrEqual(AUTOMATION_RECORDING_EPSILON['track-volume'] + 1e-12);
    }
  });

  it('normalizes unsorted equal beats with latest values', () => {
    const result = normalizeAutomationSamples('track-pan', [
      { beat: 2, value: 0 },
      { beat: 1, value: -0.25 },
      { beat: 2, value: 0.75 },
    ]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.samples).toEqual([
      { beat: 1, value: -0.25 },
      { beat: 2, value: 0.75 },
    ]);
  });
});

describe('automation recording atomic limits', () => {
  it('rejects a resulting 20,001+ point lane with the entire Project unchanged', () => {
    const { project, trackId } = fixture();
    const points = Array.from(
      { length: MAX_AUTOMATION_POINTS_PER_LANE - 2 },
      (_unused, index) => ({
        id: `capacity-${index}`,
        beat: 2 + index * (project.lengthBeats - 2) / (MAX_AUTOMATION_POINTS_PER_LANE - 2),
        value: 1,
        interpolation: 'hold' as const,
      }),
    );
    const lane: AutomationLane = {
      id: 'capacity-lane',
      bypassed: true,
      target: target(trackId),
      points,
    };
    project.automationLanes = [lane];
    let pass = passSuccess(beginAutomationPass(project, {
      trackId,
      mode: 'touch',
      startBeat: 0,
    }));
    pass = passSuccess(touchAutomationPass(pass, {
      target: target(trackId),
      beat: 0.1,
      value: 1.5,
    }));
    pass = passSuccess(releaseAutomationPass(pass, {
      target: target(trackId),
      beat: 0.10001,
    }));
    let idCalls = 0;

    expectFailure(punchOutAutomationPass(pass, {
      project,
      punchOutBeat: 2,
      idFactory: () => {
        idCalls += 1;
        return `unused-${idCalls}`;
      },
    }), 'point-limit');
    expect(idCalls).toBe(0);
    expect(project.automationLanes[0]).toBe(lane);
    expect(project.automationLanes[0]!.points).toBe(points);
    expect(project.automationLanes[0]!.points).toHaveLength(19_998);
  });

  it('fails closed for invalid source Projects without a partial candidate', () => {
    const { project, trackId } = fixture();
    const invalid = {
      ...project,
      automationLanes: [{
        id: 'invalid-lane',
        bypassed: false,
        target: target(trackId),
        points: [
          { id: 'late', beat: 2, value: 1, interpolation: 'hold' as const },
          { id: 'early', beat: 1, value: 1, interpolation: 'hold' as const },
        ],
      }],
    };
    expectFailure(beginAutomationPass(invalid, {
      trackId,
      mode: 'write',
      startBeat: 0,
    }), 'project-not-adoptable');
    expect(invalid.automationLanes[0]!.points.map((point) => point.id))
      .toEqual(['late', 'early']);
  });
});
