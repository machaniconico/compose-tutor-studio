// Pure runtime automation-pass capture and atomic Project finalization.
// UI gesture ownership, transport clocks, CAS/history, and persistence stay outside.

import {
  encodeProjectJson,
  MAX_PROJECT_STRING_LENGTH,
  type ProjectCodecIssue,
} from './project-codec';
import {
  beatToSecondsAt,
  compileMusicalTime,
  secondsToBeatAt,
} from './time';
import type {
  AutomationInterpolation,
  AutomationLane,
  AutomationPoint,
  AutomationTarget,
  Project,
  Track,
} from './types';
import {
  MAX_AUTOMATION_LANES,
  MAX_AUTOMATION_POINTS_PER_LANE,
} from './validation';
import {
  automationTargetTypesForTrack,
  isSupportedAutomationTarget,
} from './automation-targets';

export type AutomationWriteMode = 'read' | 'touch' | 'latch' | 'write';
export type AutomationRecordingTargetType = AutomationTarget['type'];
export type AutomationRecordingIdFactory = (kind: 'lane' | 'point') => string;

/** Stable ordering for the two target kinds; per-Track support can be narrower. */
export const AUTOMATION_WRITE_TARGET_TYPES = Object.freeze([
  'track-volume',
  'track-pan',
] as const);

/** Maximum reconstruction error in each target's persisted scalar units. */
export const AUTOMATION_RECORDING_EPSILON = Object.freeze({
  'track-volume': 0.001,
  'track-pan': 0.0005,
} satisfies Readonly<Record<AutomationRecordingTargetType, number>>);

export const AUTOMATION_TOUCH_RETURN_SECONDS = 0.100;

export type AutomationRecordingSample = Readonly<{
  beat: number;
  value: number;
}>;

export type AutomationRecordingErrorCode =
  | 'project-not-adoptable'
  | 'stale-project'
  | 'invalid-pass'
  | 'invalid-mode'
  | 'invalid-track'
  | 'master-protected'
  | 'duplicate-track'
  | 'invalid-target'
  | 'invalid-beat'
  | 'invalid-value'
  | 'not-touching'
  | 'already-touching'
  | 'lane-limit'
  | 'point-limit'
  | 'invalid-id'
  | 'duplicate-id'
  | 'id-factory-failed'
  | 'invalid-automation'
  | 'unexpected';

export type AutomationRecordingError = Readonly<{
  code: AutomationRecordingErrorCode;
  message: string;
  issues?: readonly ProjectCodecIssue[];
}>;

export type AutomationRecordingFailure = Readonly<{
  ok: false;
  error: AutomationRecordingError;
}>;

export type AutomationTrackWriteMode = Readonly<{
  trackId: string;
  mode: AutomationWriteMode;
}>;

export type BeginAutomationPassInput = Readonly<{
  startBeat: number;
  trackId?: string;
  mode?: AutomationWriteMode;
  tracks?: readonly AutomationTrackWriteMode[];
}>;

export type AutomationPassTargetInput = Readonly<{
  target: AutomationTarget;
  beat: number;
  value: number;
}>;

export type AutomationPassReleaseInput = Readonly<{
  target: AutomationTarget;
  beat: number;
}>;

type CapturedRegion = Readonly<{
  startBeat: number;
  endBeat: number | null;
  sampleStartIndex: number;
  sampleEndIndex: number | null;
  returnKind: 'linear' | 'hold';
}>;

type TargetCapture = Readonly<{
  target: AutomationTarget;
  mode: Exclude<AutomationWriteMode, 'read'>;
  touching: boolean;
  samples: readonly AutomationRecordingSample[];
  /** Release beats that must persist as hold boundaries before a later retouch. */
  holdBeats: readonly number[];
  regions: readonly CapturedRegion[];
  lastEventBeat: number;
}>;

const AUTOMATION_PASS_BRAND: unique symbol = Symbol('automation-recording-pass');

/**
 * An immutable runtime value that owns the exact Project reference and its
 * canonical begin-time fingerprint. The Project itself is never mutated.
 */
export type AutomationPass = Readonly<{
  [AUTOMATION_PASS_BRAND]: true;
  /** Exact reference the application must still own when adopting the pass. */
  sourceProject: Project;
  /** Deep-frozen canonical begin-time value used for all curve/scalar decisions. */
  frozenProject: Readonly<Project>;
  sourceFingerprint: string;
  startBeat: number;
  tracks: readonly AutomationTrackWriteMode[];
  captures: readonly TargetCapture[];
}>;

export type AutomationPassTransitionSuccess = Readonly<{
  ok: true;
  pass: AutomationPass;
}>;

export type AutomationPassTransitionResult =
  | AutomationPassTransitionSuccess
  | AutomationRecordingFailure;

export type RebaseAutomationPassInput = Readonly<{
  /** Exact Project reference currently owned by the application. */
  expectedProject: Project;
  /** Already-committed Read scalar edit that the active pass should adopt. */
  nextProject: Project;
}>;

export type AutomationPassRebaseSuccess = Readonly<{
  ok: true;
  pass: AutomationPass;
  changedTargets: readonly AutomationTarget[];
}>;

export type AutomationPassRebaseResult =
  | AutomationPassRebaseSuccess
  | AutomationRecordingFailure;

export type AutomationRecordedRange = Readonly<{
  target: AutomationTarget;
  startBeat: number;
  endBeat: number;
}>;

export type AutomationPassFinalizationSuccess = Readonly<{
  ok: true;
  project: Project;
  changed: boolean;
  recordedRanges: readonly AutomationRecordedRange[];
}>;

export type AutomationPassFinalizationResult =
  | AutomationPassFinalizationSuccess
  | AutomationRecordingFailure;

export type PunchOutAutomationPassInput = Readonly<{
  project: Project;
  punchOutBeat: number;
  idFactory?: AutomationRecordingIdFactory;
}>;

export type AutomationSampleReductionSuccess = Readonly<{
  ok: true;
  samples: readonly AutomationRecordingSample[];
}>;

export type AutomationSampleReductionResult =
  | AutomationSampleReductionSuccess
  | AutomationRecordingFailure;

type ClosedRegion = Readonly<{
  startBeat: number;
  endBeat: number;
  returnKind: 'linear' | 'hold';
  samples: readonly AutomationRecordingSample[];
}>;

type ReplacementGroup = Readonly<{
  startBeat: number;
  endBeat: number;
  returnKind: 'linear' | 'hold';
  samples: readonly AutomationRecordingSample[];
}>;

type PlannedLane = Readonly<{
  capture: TargetCapture;
  currentLane: AutomationLane | null;
  groups: readonly ReplacementGroup[];
  retainedPoints: readonly AutomationPoint[];
  pointPlans: readonly PointPlan[];
}>;

type PointPlan =
  | Readonly<{ kind: 'retained'; point: AutomationPoint }>
  | Readonly<{
      kind: 'new';
      beat: number;
      value: number;
      interpolation: AutomationInterpolation;
    }>;

function failure(
  code: AutomationRecordingErrorCode,
  message: string,
  issues?: readonly ProjectCodecIssue[],
): AutomationRecordingFailure {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      message,
      ...(issues === undefined ? {} : { issues: Object.freeze([...issues]) }),
    }),
  });
}

function freezeTarget(target: AutomationTarget): AutomationTarget {
  return Object.freeze({ type: target.type, trackId: target.trackId });
}

function freezeSample(sample: AutomationRecordingSample): AutomationRecordingSample {
  return Object.freeze({ beat: sample.beat, value: sample.value });
}

function freezeCapture(capture: TargetCapture): TargetCapture {
  return Object.freeze({
    ...capture,
    target: freezeTarget(capture.target),
    samples: Object.freeze([...capture.samples]),
    holdBeats: Object.freeze([...capture.holdBeats]),
    regions: Object.freeze(capture.regions.map((region) => Object.freeze({ ...region }))),
  });
}

function createPass(
  sourceProject: Project,
  frozenProject: Readonly<Project>,
  sourceFingerprint: string,
  startBeat: number,
  tracks: readonly AutomationTrackWriteMode[],
  captures: readonly TargetCapture[],
): AutomationPass {
  return Object.freeze({
    [AUTOMATION_PASS_BRAND]: true as const,
    sourceProject,
    frozenProject,
    sourceFingerprint,
    startBeat,
    tracks: Object.freeze(tracks.map((track) => Object.freeze({ ...track }))),
    captures: Object.freeze(captures.map(freezeCapture)),
  });
}

function transition(pass: AutomationPass): AutomationPassTransitionSuccess {
  return Object.freeze({ ok: true, pass });
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectPass(value: unknown): AutomationRecordingFailure | null {
  if (!isRecord(value) || value[AUTOMATION_PASS_BRAND] !== true) {
    return failure('invalid-pass', 'Automation recording requires an active pass.');
  }
  return null;
}

function sourceCodecFailure(project: Project): AutomationRecordingFailure | null {
  try {
    const encoded = encodeProjectJson(project);
    if (encoded.ok) return null;
    const first = encoded.error.issues[0];
    return failure(
      'project-not-adoptable',
      `Project codec rejected the automation recording source.${first ? ` ${first.path}: ${first.message}` : ''}`,
      encoded.error.issues,
    );
  } catch {
    return failure(
      'project-not-adoptable',
      'Project codec could not safely inspect the automation recording source.',
    );
  }
}

function projectFingerprint(project: Project): string | AutomationRecordingFailure {
  try {
    const encoded = encodeProjectJson(project);
    if (encoded.ok) return encoded.json;
    const first = encoded.error.issues[0];
    return failure(
      'project-not-adoptable',
      `Project codec rejected the automation recording source.${first ? ` ${first.path}: ${first.message}` : ''}`,
      encoded.error.issues,
    );
  } catch {
    return failure(
      'project-not-adoptable',
      'Project codec could not safely inspect the automation recording source.',
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validBeat(
  project: Readonly<Pick<Project, 'lengthBeats'>>,
  beat: unknown,
): beat is number {
  return typeof beat === 'number'
    && Number.isFinite(beat)
    && beat >= 0
    && beat <= project.lengthBeats;
}

function valueRange(type: AutomationRecordingTargetType): readonly [number, number] {
  return type === 'track-volume' ? [0, 2] : [-1, 1];
}

function validValue(type: AutomationRecordingTargetType, value: unknown): value is number {
  const [minimum, maximum] = valueRange(type);
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function locateTrack(project: Project, trackId: unknown): Track | AutomationRecordingFailure {
  if (typeof trackId !== 'string' || trackId.length === 0) {
    return failure('invalid-track', 'Automation recording requires a non-empty Track id.');
  }
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) {
    return failure('invalid-track', `Track not found: ${trackId}`);
  }
  if (automationTargetTypesForTrack(project, track.id).length === 0) {
    return failure(
      'master-protected',
      'Automation recording cannot target this Master.',
    );
  }
  return track;
}

function normalizeTrackModes(
  project: Project,
  input: BeginAutomationPassInput,
): readonly AutomationTrackWriteMode[] | AutomationRecordingFailure {
  const requested = input.tracks
    ?? (input.trackId === undefined && input.mode === undefined
      ? []
      : [{ trackId: input.trackId as string, mode: input.mode as AutomationWriteMode }]);
  if (!Array.isArray(requested) || requested.length === 0) {
    return failure('invalid-track', 'Automation recording requires at least one Track mode.');
  }
  const seen = new Set<string>();
  const normalized: AutomationTrackWriteMode[] = [];
  for (const item of requested) {
    if (!isRecord(item)) {
      return failure('invalid-track', 'Each automation Track mode must be an object.');
    }
    const track = locateTrack(project, item.trackId);
    if ('ok' in track) return track;
    if (
      item.mode !== 'read'
      && item.mode !== 'touch'
      && item.mode !== 'latch'
      && item.mode !== 'write'
    ) {
      return failure('invalid-mode', `Unsupported automation mode: ${String(item.mode)}`);
    }
    if (seen.has(track.id)) {
      return failure('duplicate-track', `Automation Track mode is duplicated: ${track.id}`);
    }
    seen.add(track.id);
    normalized.push({ trackId: track.id, mode: item.mode });
  }
  return project.tracks
    .filter((track) => seen.has(track.id))
    .map((track) => normalized.find((item) => item.trackId === track.id)!);
}

function scalarValue(track: Track, type: AutomationRecordingTargetType): number {
  return type === 'track-volume' ? track.volume : track.pan;
}

function initialWriteCaptures(
  project: Project,
  tracks: readonly AutomationTrackWriteMode[],
  startBeat: number,
): readonly TargetCapture[] {
  const captures: TargetCapture[] = [];
  for (const trackMode of tracks) {
    if (trackMode.mode !== 'write') continue;
    const track = project.tracks.find((candidate) => candidate.id === trackMode.trackId)!;
    for (const type of automationTargetTypesForTrack(project, track.id)) {
      captures.push({
        target: { type, trackId: track.id },
        mode: 'write',
        touching: false,
        samples: [freezeSample({ beat: startBeat, value: scalarValue(track, type) })],
        // Write owns the range from pass start. Hold the frozen scalar until
        // the first contact instead of interpolating that future value backward.
        holdBeats: Object.freeze([startBeat]),
        regions: [{
          startBeat,
          endBeat: null,
          sampleStartIndex: 0,
          sampleEndIndex: null,
          returnKind: 'hold',
        }],
        lastEventBeat: startBeat,
      });
    }
  }
  return captures;
}

/** Begin one immutable pass from an exact, codec-valid Project snapshot. */
export function beginAutomationPass(
  project: Project,
  input: BeginAutomationPassInput,
): AutomationPassTransitionResult {
  try {
    if (!isRecord(input)) {
      return failure('invalid-pass', 'Automation pass input must be an object.');
    }
    const codecFailure = sourceCodecFailure(project);
    if (codecFailure) return codecFailure;
    if (!validBeat(project, input.startBeat)) {
      return failure(
        'invalid-beat',
        `Automation pass start must be between 0 and ${project.lengthBeats}.`,
      );
    }
    const tracks = normalizeTrackModes(project, input);
    if ('ok' in tracks) return tracks;
    const fingerprint = projectFingerprint(project);
    if (typeof fingerprint !== 'string') return fingerprint;
    const frozenProject = deepFreeze(JSON.parse(fingerprint) as Project);
    return transition(createPass(
      project,
      frozenProject,
      fingerprint,
      input.startBeat,
      tracks,
      initialWriteCaptures(frozenProject, tracks, input.startBeat),
    ));
  } catch {
    return failure('unexpected', 'The automation pass could not be started safely.');
  }
}

/**
 * Advance an active pass after a compare-and-swap commit that changed only
 * supported scalars on Tracks whose begin-time mode is Read.
 *
 * The frozen recording baseline deliberately remains the begin-time snapshot:
 * Write captures and curve restoration must never observe an intervening Read
 * edit. The source reference and fingerprint advance together so every older
 * Project generation is immediately stale.
 */
export function rebaseAutomationPass(
  pass: AutomationPass,
  input: RebaseAutomationPassInput,
): AutomationPassRebaseResult {
  try {
    const passFailure = inspectPass(pass);
    if (passFailure) return passFailure;
    if (!isRecord(input)) {
      return failure('invalid-pass', 'Automation pass rebase input must be an object.');
    }
    if (input.expectedProject !== pass.sourceProject) {
      return failure(
        'stale-project',
        'Automation pass no longer owns the expected Project.',
      );
    }
    const expectedFingerprint = projectFingerprint(input.expectedProject);
    if (typeof expectedFingerprint !== 'string') return expectedFingerprint;
    if (expectedFingerprint !== pass.sourceFingerprint) {
      return failure(
        'stale-project',
        'Automation pass source changed before the rebase compare-and-swap.',
      );
    }
    const nextFingerprint = projectFingerprint(input.nextProject);
    if (typeof nextFingerprint !== 'string') return nextFingerprint;

    const expectedCanonical = JSON.parse(expectedFingerprint) as Project;
    const nextCanonical = JSON.parse(nextFingerprint) as Project;
    if (nextCanonical.id !== expectedCanonical.id) {
      return failure(
        'invalid-pass',
        'Automation pass rebase cannot change the Project id.',
      );
    }

    // Construct the only candidate shape that is legal: the exact old
    // canonical Project with root updatedAt and begin-time Read scalars copied
    // from the next generation. Full fingerprint equality below rejects every
    // other mutation, including Track reorder/removal and unsupported Master changes.
    expectedCanonical.updatedAt = nextCanonical.updatedAt;
    const changedTargets: AutomationTarget[] = [];
    for (const trackMode of pass.tracks) {
      if (trackMode.mode !== 'read') continue;
      const expectedTrack = expectedCanonical.tracks.find(
        (track) => track.id === trackMode.trackId,
      );
      const nextTrack = nextCanonical.tracks.find(
        (track) => track.id === trackMode.trackId,
      );
      if (expectedTrack === undefined || nextTrack === undefined) {
        return failure(
          'invalid-pass',
          'Automation pass rebase requires every Read Track to remain unchanged.',
        );
      }
      const targetTypes = automationTargetTypesForTrack(
        expectedCanonical,
        trackMode.trackId,
      );
      const nextTargetTypes = automationTargetTypesForTrack(
        nextCanonical,
        trackMode.trackId,
      );
      if (
        targetTypes.length === 0
        || targetTypes.length !== nextTargetTypes.length
        || targetTypes.some((type, index) => type !== nextTargetTypes[index])
      ) {
        return failure(
          'invalid-pass',
          'Automation pass rebase requires every Read Track to remain unchanged.',
        );
      }
      for (const type of targetTypes) {
        if (scalarValue(expectedTrack, type) !== scalarValue(nextTrack, type)) {
          changedTargets.push(freezeTarget({
            type,
            trackId: trackMode.trackId,
          }));
        }
        if (type === 'track-volume') expectedTrack.volume = nextTrack.volume;
        else expectedTrack.pan = nextTrack.pan;
      }
    }
    if (changedTargets.length === 0) {
      return failure(
        'invalid-pass',
        'Automation pass rebase requires at least one Read scalar change.',
      );
    }
    if (JSON.stringify(expectedCanonical) !== nextFingerprint) {
      return failure(
        'invalid-pass',
        'Automation pass rebase contained an unrelated or non-Read mutation.',
      );
    }

    const rebasedPass: AutomationPass = Object.freeze({
      [AUTOMATION_PASS_BRAND]: true as const,
      sourceProject: input.nextProject,
      frozenProject: pass.frozenProject,
      sourceFingerprint: nextFingerprint,
      startBeat: pass.startBeat,
      tracks: pass.tracks,
      captures: pass.captures,
    });
    return Object.freeze({
      ok: true,
      pass: rebasedPass,
      changedTargets: Object.freeze(changedTargets),
    });
  } catch {
    return failure('unexpected', 'The automation pass could not be rebased safely.');
  }
}

function inspectTargetInput(
  pass: AutomationPass,
  input: AutomationPassTargetInput,
): Readonly<{
  target: AutomationTarget;
  mode: Exclude<AutomationWriteMode, 'read'>;
}> | AutomationRecordingFailure {
  if (!isRecord(input) || !isRecord(input.target)) {
    return failure('invalid-target', 'Automation sample target must be an object.');
  }
  const { type, trackId } = input.target;
  if (
    (type !== 'track-volume' && type !== 'track-pan')
    || typeof trackId !== 'string'
  ) {
    return failure('invalid-target', 'Only Track volume and pan can be recorded.');
  }
  if (!isSupportedAutomationTarget(pass.frozenProject, { type, trackId })) {
    return failure(
      'invalid-target',
      'This automation target is not supported for the selected Track.',
    );
  }
  const trackMode = pass.tracks.find((track) => track.trackId === trackId);
  if (trackMode === undefined) {
    return failure('invalid-target', `Track is not owned by this automation pass: ${trackId}`);
  }
  if (trackMode.mode === 'read') {
    return failure('invalid-mode', 'Read mode does not accept automation gestures.');
  }
  if (!validBeat(pass.frozenProject, input.beat) || input.beat < pass.startBeat) {
    return failure(
      'invalid-beat',
      'Automation samples must be ordered at or after the pass start.',
    );
  }
  if (!validValue(type, input.value)) {
    const [minimum, maximum] = valueRange(type);
    return failure(
      'invalid-value',
      `${type} samples must be between ${minimum} and ${maximum}.`,
    );
  }
  return {
    target: { type, trackId },
    mode: trackMode.mode,
  };
}

function sameTarget(left: AutomationTarget, right: AutomationTarget): boolean {
  return left.type === right.type && left.trackId === right.trackId;
}

function replaceCapture(
  pass: AutomationPass,
  nextCapture: TargetCapture,
): AutomationPass {
  const exists = pass.captures.some((capture) => sameTarget(capture.target, nextCapture.target));
  const captures = exists
    ? pass.captures.map((capture) =>
      sameTarget(capture.target, nextCapture.target) ? nextCapture : capture)
    : [...pass.captures, nextCapture];
  return createPass(
    pass.sourceProject,
    pass.frozenProject,
    pass.sourceFingerprint,
    pass.startBeat,
    pass.tracks,
    captures,
  );
}

function appendSample(
  samples: readonly AutomationRecordingSample[],
  sample: AutomationRecordingSample,
): readonly AutomationRecordingSample[] {
  return Object.freeze([...samples, freezeSample(sample)]);
}

/** Begin contact and capture its first value for Touch/Latch/Write. */
export function touchAutomationPass(
  pass: AutomationPass,
  input: AutomationPassTargetInput,
): AutomationPassTransitionResult {
  try {
    const passFailure = inspectPass(pass);
    if (passFailure) return passFailure;
    const inspected = inspectTargetInput(pass, input);
    if ('ok' in inspected) return inspected;
    const existing = pass.captures.find((capture) => sameTarget(capture.target, inspected.target));
    if (existing?.touching) {
      return failure('already-touching', 'The automation target is already being touched.');
    }
    if (existing !== undefined && input.beat < existing.lastEventBeat) {
      return failure('invalid-beat', 'Automation gesture beats must be non-decreasing.');
    }

    const samples = appendSample(existing?.samples ?? [], {
      beat: input.beat,
      value: input.value,
    });
    let regions = existing?.regions ?? [];
    if (inspected.mode === 'touch') {
      regions = Object.freeze([...regions, Object.freeze({
        startBeat: input.beat,
        endBeat: null,
        sampleStartIndex: samples.length - 1,
        sampleEndIndex: null,
        returnKind: 'linear' as const,
      })]);
    } else if (inspected.mode === 'latch' && regions.length === 0) {
      regions = Object.freeze([Object.freeze({
        startBeat: input.beat,
        endBeat: null,
        sampleStartIndex: samples.length - 1,
        sampleEndIndex: null,
        returnKind: 'hold' as const,
      })]);
    }
    const next: TargetCapture = {
      target: inspected.target,
      mode: inspected.mode,
      touching: true,
      samples,
      // A new touch at the exact release beat wins over the older release
      // marker. Later touches retain the marker so the gap stays held.
      holdBeats: Object.freeze(
        (existing?.holdBeats ?? []).filter((beat) => beat !== input.beat),
      ),
      regions,
      lastEventBeat: input.beat,
    };
    return transition(replaceCapture(pass, next));
  } catch {
    return failure('unexpected', 'The automation touch could not be captured safely.');
  }
}

/** Append one raw, clock-independent sample while a target is touched. */
export function sampleAutomationPass(
  pass: AutomationPass,
  input: AutomationPassTargetInput,
): AutomationPassTransitionResult {
  try {
    const passFailure = inspectPass(pass);
    if (passFailure) return passFailure;
    const inspected = inspectTargetInput(pass, input);
    if ('ok' in inspected) return inspected;
    const existing = pass.captures.find((capture) => sameTarget(capture.target, inspected.target));
    if (existing === undefined || !existing.touching) {
      return failure('not-touching', 'Automation samples require an active touch.');
    }
    if (input.beat < existing.lastEventBeat) {
      return failure('invalid-beat', 'Automation sample beats must be non-decreasing.');
    }
    return transition(replaceCapture(pass, {
      ...existing,
      samples: appendSample(existing.samples, {
        beat: input.beat,
        value: input.value,
      }),
      lastEventBeat: input.beat,
    }));
  } catch {
    return failure('unexpected', 'The automation sample could not be captured safely.');
  }
}

function curveValueAt(
  project: Project,
  target: AutomationTarget,
  beat: number,
): number {
  const track = project.tracks.find((candidate) => candidate.id === target.trackId)!;
  const baseValue = scalarValue(track, target.type);
  const lane = project.automationLanes.find((candidate) => sameTarget(candidate.target, target));
  if (lane === undefined || lane.points.length === 0) return baseValue;
  let previousIndex = -1;
  for (let index = 0; index < lane.points.length; index += 1) {
    if (lane.points[index]!.beat > beat) break;
    previousIndex = index;
  }
  if (previousIndex < 0) return baseValue;
  const previous = lane.points[previousIndex]!;
  const next = lane.points[previousIndex + 1];
  if (
    previous.interpolation !== 'linear'
    || next === undefined
    || !(next.beat > previous.beat)
  ) {
    return previous.value;
  }
  const progress = Math.max(0, Math.min(1, (beat - previous.beat) / (next.beat - previous.beat)));
  return previous.value + (next.value - previous.value) * progress;
}

function touchReturnBeat(project: Project, releaseBeat: number): number {
  const index = compileMusicalTime(project);
  return secondsToBeatAt(
    index,
    beatToSecondsAt(index, releaseBeat) + AUTOMATION_TOUCH_RETURN_SECONDS,
  );
}

/** End contact. Touch closes after a map-aware 100 ms return; Latch/Write keep writing. */
export function releaseAutomationPass(
  pass: AutomationPass,
  input: AutomationPassReleaseInput,
): AutomationPassTransitionResult {
  try {
    const passFailure = inspectPass(pass);
    if (passFailure) return passFailure;
    if (
      !isRecord(input)
      || !isRecord(input.target)
      || (input.target.type !== 'track-volume' && input.target.type !== 'track-pan')
      || typeof input.target.trackId !== 'string'
    ) {
      return failure('invalid-target', 'Automation release target must be Track volume or pan.');
    }
    if (!validBeat(pass.frozenProject, input.beat) || input.beat < pass.startBeat) {
      return failure('invalid-beat', 'Automation release beat is outside the pass.');
    }
    const existing = pass.captures.find((capture) => sameTarget(capture.target, input.target));
    if (existing === undefined || !existing.touching) {
      return failure('not-touching', 'Automation release requires an active touch.');
    }
    if (input.beat < existing.lastEventBeat) {
      return failure('invalid-beat', 'Automation release must not precede its latest sample.');
    }
    let samples = existing.samples;
    const latest = samples[samples.length - 1]!;
    if (latest.beat < input.beat) {
      samples = appendSample(samples, { beat: input.beat, value: latest.value });
    }
    let regions = existing.regions;
    if (existing.mode === 'touch') {
      const returnBeat = touchReturnBeat(pass.frozenProject as Project, input.beat);
      if (!validBeat(pass.frozenProject, returnBeat)) {
        return failure(
          'invalid-beat',
          'The 100 ms Touch return endpoint falls outside the project timeline.',
        );
      }
      const openIndex = regions.findIndex((region) => region.endBeat === null);
      if (openIndex < 0) {
        return failure('invalid-pass', 'The Touch pass has no open recorded region.');
      }
      regions = Object.freeze(regions.map((region, index) => Object.freeze(
        index === openIndex
          ? {
            ...region,
            endBeat: returnBeat,
            sampleEndIndex: samples.length,
            returnKind: 'linear' as const,
          }
          : region,
      )));
    }
    return transition(replaceCapture(pass, {
      ...existing,
      touching: false,
      samples,
      holdBeats: existing.mode === 'touch'
        ? existing.holdBeats
        : Object.freeze([...existing.holdBeats, input.beat]),
      regions,
      lastEventBeat: input.beat,
    }));
  } catch {
    return failure('unexpected', 'The automation release could not be captured safely.');
  }
}

/** Same-beat samples collapse deterministically with latest call order winning. */
export function normalizeAutomationSamples(
  type: AutomationRecordingTargetType,
  samples: readonly AutomationRecordingSample[],
): AutomationSampleReductionResult {
  try {
    if (type !== 'track-volume' && type !== 'track-pan') {
      return failure('invalid-target', 'Only Track volume and pan samples can be normalized.');
    }
    if (!Array.isArray(samples) || samples.length === 0) {
      return failure('invalid-pass', 'At least one automation sample is required.');
    }
    const indexed = samples.map((sample, index) => ({ sample, index }));
    for (const { sample } of indexed) {
      if (!isRecord(sample) || !Number.isFinite(sample.beat)) {
        return failure('invalid-beat', 'Automation sample beats must be finite.');
      }
      if (!validValue(type, sample.value)) {
        return failure('invalid-value', `Automation sample value is invalid for ${type}.`);
      }
    }
    indexed.sort((left, right) =>
      left.sample.beat - right.sample.beat || left.index - right.index);
    const normalized: AutomationRecordingSample[] = [];
    for (const { sample } of indexed) {
      const latest = normalized[normalized.length - 1];
      const frozen = freezeSample(sample);
      if (latest?.beat === frozen.beat) normalized[normalized.length - 1] = frozen;
      else normalized.push(frozen);
    }
    return Object.freeze({ ok: true, samples: Object.freeze(normalized) });
  } catch {
    return failure('unexpected', 'Automation samples could not be normalized safely.');
  }
}

function lineValue(
  start: AutomationRecordingSample,
  end: AutomationRecordingSample,
  beat: number,
): number {
  if (end.beat === start.beat) return end.value;
  const progress = (beat - start.beat) / (end.beat - start.beat);
  return start.value + (end.value - start.value) * progress;
}

/**
 * Deterministic Ramer-Douglas-Peucker reduction using target scalar error.
 * Endpoints are fixed; earliest equal-error candidates win.
 */
export function reduceAutomationSamples(
  type: AutomationRecordingTargetType,
  samples: readonly AutomationRecordingSample[],
): AutomationSampleReductionResult {
  const normalized = normalizeAutomationSamples(type, samples);
  if (!normalized.ok || normalized.samples.length <= 2) return normalized;
  const points = normalized.samples;
  const keep = new Set<number>([0, points.length - 1]);
  const pending: Array<readonly [number, number]> = [[0, points.length - 1]];
  const epsilon = AUTOMATION_RECORDING_EPSILON[type];
  while (pending.length > 0) {
    const [startIndex, endIndex] = pending.pop()!;
    const start = points[startIndex]!;
    const end = points[endIndex]!;
    let selected = -1;
    let maximumError = epsilon;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const sample = points[index]!;
      const error = Math.abs(sample.value - lineValue(start, end, sample.beat));
      if (error > maximumError) {
        maximumError = error;
        selected = index;
      }
    }
    if (selected < 0) continue;
    keep.add(selected);
    pending.push([selected, endIndex], [startIndex, selected]);
  }
  return Object.freeze({
    ok: true,
    samples: Object.freeze(
      points.filter((_sample, index) => keep.has(index)),
    ),
  });
}

function reduceWithRequiredBeats(
  type: AutomationRecordingTargetType,
  samples: readonly AutomationRecordingSample[],
  requiredBeats: ReadonlySet<number>,
): AutomationSampleReductionResult {
  const normalized = normalizeAutomationSamples(type, samples);
  if (!normalized.ok || normalized.samples.length <= 2 || requiredBeats.size === 0) {
    return normalized.ok ? reduceAutomationSamples(type, normalized.samples) : normalized;
  }
  const splitIndexes = normalized.samples
    .map((sample, index) => requiredBeats.has(sample.beat) ? index : -1)
    .filter((index) => index > 0 && index < normalized.samples.length - 1);
  if (splitIndexes.length === 0) {
    return reduceAutomationSamples(type, normalized.samples);
  }
  const reduced: AutomationRecordingSample[] = [];
  let startIndex = 0;
  for (const endIndex of [...splitIndexes, normalized.samples.length - 1]) {
    const segment = reduceAutomationSamples(
      type,
      normalized.samples.slice(startIndex, endIndex + 1),
    );
    if (!segment.ok) return segment;
    reduced.push(...segment.samples.slice(reduced.length === 0 ? 0 : 1));
    startIndex = endIndex;
  }
  return Object.freeze({ ok: true, samples: Object.freeze(reduced) });
}

function closeCaptureRegions(
  capture: TargetCapture,
  punchOutBeat: number,
): readonly ClosedRegion[] {
  const closed: ClosedRegion[] = [];
  for (const region of capture.regions) {
    if (region.startBeat >= punchOutBeat) continue;
    const endBeat = Math.min(region.endBeat ?? punchOutBeat, punchOutBeat);
    if (!(endBeat > region.startBeat)) continue;
    const endIndex = region.sampleEndIndex ?? capture.samples.length;
    closed.push({
      startBeat: region.startBeat,
      endBeat,
      returnKind: region.endBeat !== null && region.endBeat <= punchOutBeat
        ? region.returnKind
        : 'hold',
      samples: capture.samples.slice(region.sampleStartIndex, endIndex)
        .filter((sample) => sample.beat >= region.startBeat && sample.beat < endBeat),
    });
  }
  return closed;
}

function mergeRegions(regions: readonly ClosedRegion[]): readonly ReplacementGroup[] {
  const groups: Array<{
    startBeat: number;
    endBeat: number;
    returnKind: 'linear' | 'hold';
    samples: AutomationRecordingSample[];
  }> = [];
  for (const region of [...regions].sort((left, right) =>
    left.startBeat - right.startBeat || left.endBeat - right.endBeat)) {
    const previous = groups[groups.length - 1];
    if (previous === undefined || region.startBeat > previous.endBeat) {
      groups.push({ ...region, samples: [...region.samples] });
      continue;
    }
    previous.samples.push(...region.samples);
    if (region.endBeat >= previous.endBeat) {
      previous.endBeat = region.endBeat;
      previous.returnKind = region.returnKind;
    }
  }
  return groups.map((group) => Object.freeze({
    ...group,
    samples: Object.freeze(group.samples),
  }));
}

function oldInterpolationAt(
  lane: AutomationLane | null,
  beat: number,
): AutomationInterpolation {
  if (lane === null) return 'hold';
  let previous: AutomationPoint | undefined;
  for (const point of lane.points) {
    if (point.beat > beat) break;
    previous = point;
  }
  return previous?.interpolation ?? 'hold';
}

function pointInsideGroups(
  point: AutomationPoint,
  groups: readonly ReplacementGroup[],
): boolean {
  return groups.some((group) => point.beat >= group.startBeat && point.beat < group.endBeat);
}

function exactPoint(
  points: readonly AutomationPoint[],
  beat: number,
): AutomationPoint | undefined {
  return points.find((point) => point.beat === beat);
}

function pointPlanBeat(plan: PointPlan): number {
  return plan.kind === 'retained' ? plan.point.beat : plan.beat;
}

/** Return the immediately preceding non-negative IEEE-754 beat. */
function previousRepresentableBeat(beat: number): number | null {
  if (!Number.isFinite(beat) || beat <= 0) return null;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, beat, false);
  view.setBigUint64(0, view.getBigUint64(0, false) - 1n, false);
  const previous = view.getFloat64(0, false);
  return previous >= 0 && previous < beat ? previous : null;
}

function previousSourcePoint(
  lane: AutomationLane | null,
  beat: number,
): AutomationPoint | undefined {
  if (lane === null) return undefined;
  let previous: AutomationPoint | undefined;
  for (const point of lane.points) {
    if (point.beat >= beat) break;
    previous = point;
  }
  return previous;
}

function planLane(
  project: Project,
  frozenProject: Project,
  capture: TargetCapture,
  punchOutBeat: number,
): PlannedLane | AutomationRecordingFailure | null {
  const groups = mergeRegions(closeCaptureRegions(capture, punchOutBeat));
  if (groups.length === 0) return null;
  const currentLane = project.automationLanes.find((lane) =>
    sameTarget(lane.target, capture.target)) ?? null;
  const frozenLane = frozenProject.automationLanes.find((lane) =>
    sameTarget(lane.target, capture.target)) ?? null;
  const currentPoints = currentLane?.points ?? [];
  const retainedPoints = currentPoints.filter((point) => !pointInsideGroups(point, groups));
  const plans: PointPlan[] = retainedPoints.map((point) => ({ kind: 'retained', point }));

  for (const group of groups) {
    // A new value at group.startBeat must not pull an earlier retained linear
    // point toward it. Insert an exact left-limit guard at the immediately
    // preceding representable beat. This preserves every representable beat
    // outside the half-open replacement while allowing a discontinuity at the
    // recorded start without duplicate-beat points.
    const sourcePrevious = previousSourcePoint(frozenLane, group.startBeat);
    const guardBeat = sourcePrevious?.interpolation === 'linear'
      ? previousRepresentableBeat(group.startBeat)
      : null;
    if (
      guardBeat !== null
      && guardBeat > sourcePrevious!.beat
      && !plans.some((plan) => pointPlanBeat(plan) === guardBeat)
    ) {
      plans.push({
        kind: 'new',
        beat: guardBeat,
        value: curveValueAt(frozenProject, capture.target, guardBeat),
        interpolation: 'hold',
      });
    }

    const normalized = normalizeAutomationSamples(capture.target.type, group.samples);
    if (!normalized.ok) return normalized;
    const startValue = normalized.samples[0]?.value;
    if (startValue === undefined) {
      return failure('invalid-pass', 'A recorded region has no captured samples.');
    }
    const samples = normalized.samples[0]!.beat === group.startBeat
      ? normalized.samples
      : Object.freeze([
        freezeSample({ beat: group.startBeat, value: startValue }),
        ...normalized.samples,
      ]);
    const holdBeats = new Set(capture.holdBeats.filter((beat) =>
      beat >= group.startBeat && beat < group.endBeat));
    const reduced = reduceWithRequiredBeats(capture.target.type, samples, holdBeats);
    if (!reduced.ok) return reduced;
    const lastReducedIndex = reduced.samples.length - 1;
    for (let index = 0; index < reduced.samples.length; index += 1) {
      const sample = reduced.samples[index]!;
      plans.push({
        kind: 'new',
        beat: sample.beat,
        value: sample.value,
        interpolation: holdBeats.has(sample.beat)
          ? 'hold'
          : index === lastReducedIndex ? group.returnKind : 'linear',
      });
    }
    if (exactPoint(retainedPoints, group.endBeat) === undefined) {
      plans.push({
        kind: 'new',
        beat: group.endBeat,
        value: curveValueAt(frozenProject, capture.target, group.endBeat),
        interpolation: oldInterpolationAt(frozenLane, group.endBeat),
      });
    }
  }

  plans.sort((left, right) => {
    const leftBeat = left.kind === 'retained' ? left.point.beat : left.beat;
    const rightBeat = right.kind === 'retained' ? right.point.beat : right.beat;
    return leftBeat - rightBeat;
  });
  for (let index = 1; index < plans.length; index += 1) {
    const previous = plans[index - 1]!;
    const current = plans[index]!;
    const previousBeat = previous.kind === 'retained' ? previous.point.beat : previous.beat;
    const currentBeat = current.kind === 'retained' ? current.point.beat : current.beat;
    if (previousBeat === currentBeat) {
      return failure('invalid-pass', `Automation replacement collided at beat ${currentBeat}.`);
    }
  }
  if (plans.length > MAX_AUTOMATION_POINTS_PER_LANE) {
    return failure(
      'point-limit',
      `An automation lane can contain at most ${MAX_AUTOMATION_POINTS_PER_LANE} points.`,
    );
  }
  return {
    capture,
    currentLane,
    groups,
    retainedPoints,
    pointPlans: plans,
  };
}

function collectProjectIds(project: Project): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.id === 'string') ids.add(value.id);
    for (const child of Object.values(value)) visit(child);
  };
  visit(project);
  return ids;
}

function allocateId(
  kind: 'lane' | 'point',
  factory: AutomationRecordingIdFactory,
  reserved: Set<string>,
): string | AutomationRecordingFailure {
  let id: unknown;
  try {
    id = factory(kind);
  } catch {
    return failure('id-factory-failed', `The automation ${kind} id factory threw.`);
  }
  if (
    typeof id !== 'string'
    || id.length === 0
    || id.length > MAX_PROJECT_STRING_LENGTH
  ) {
    return failure(
      'invalid-id',
      `An automation ${kind} id must contain 1..${MAX_PROJECT_STRING_LENGTH} characters.`,
    );
  }
  if (reserved.has(id)) {
    return failure('duplicate-id', `The automation id already exists: ${id}`);
  }
  reserved.add(id);
  return id;
}

function adoptPlans(
  project: Project,
  plans: readonly PlannedLane[],
  idFactory: AutomationRecordingIdFactory,
): Project | AutomationRecordingFailure {
  const newLaneCount = plans.filter((plan) => plan.currentLane === null).length;
  if (project.automationLanes.length + newLaneCount > MAX_AUTOMATION_LANES) {
    return failure(
      'lane-limit',
      `A project can contain at most ${MAX_AUTOMATION_LANES} automation lanes.`,
    );
  }
  const reserved = collectProjectIds(project);
  const replacements = new Map<string, AutomationLane>();
  const additions: AutomationLane[] = [];
  for (const plan of plans) {
    let laneId = plan.currentLane?.id;
    if (laneId === undefined) {
      const allocated = allocateId('lane', idFactory, reserved);
      if (typeof allocated !== 'string') return allocated;
      laneId = allocated;
    }
    const points: AutomationPoint[] = [];
    for (const pointPlan of plan.pointPlans) {
      if (pointPlan.kind === 'retained') {
        points.push(pointPlan.point);
        continue;
      }
      const pointId = allocateId('point', idFactory, reserved);
      if (typeof pointId !== 'string') return pointId;
      points.push({
        id: pointId,
        beat: pointPlan.beat,
        value: pointPlan.value,
        interpolation: pointPlan.interpolation,
      });
    }
    const lane: AutomationLane = {
      id: laneId,
      bypassed: plan.currentLane?.bypassed ?? false,
      target: plan.currentLane?.target ?? freezeTarget(plan.capture.target),
      points,
    };
    if (plan.currentLane === null) additions.push(lane);
    else replacements.set(plan.currentLane.id, lane);
  }
  return {
    ...project,
    automationLanes: [
      ...project.automationLanes.map((lane) => replacements.get(lane.id) ?? lane),
      ...additions,
    ],
  };
}

function stablePlanOrder(project: Project, captures: readonly TargetCapture[]): TargetCapture[] {
  const trackOrder = new Map(project.tracks.map((track, index) => [track.id, index]));
  return [...captures].sort((left, right) =>
    (trackOrder.get(left.target.trackId) ?? Number.MAX_SAFE_INTEGER)
      - (trackOrder.get(right.target.trackId) ?? Number.MAX_SAFE_INTEGER)
    || AUTOMATION_WRITE_TARGET_TYPES.indexOf(left.target.type)
      - AUTOMATION_WRITE_TARGET_TYPES.indexOf(right.target.type));
}

/** Atomically replace every captured half-open region and restore the frozen curve. */
export function punchOutAutomationPass(
  pass: AutomationPass,
  input: PunchOutAutomationPassInput,
): AutomationPassFinalizationResult {
  try {
    const passFailure = inspectPass(pass);
    if (passFailure) return passFailure;
    if (!isRecord(input) || !validBeat(pass.frozenProject, input.punchOutBeat)) {
      return failure('invalid-beat', 'Automation punch-out must be inside the project.');
    }
    if (input.punchOutBeat < pass.startBeat) {
      return failure('invalid-beat', 'Automation punch-out must not precede pass start.');
    }
    if (pass.captures.some((capture) => capture.lastEventBeat > input.punchOutBeat)) {
      return failure(
        'invalid-beat',
        'Automation punch-out must not precede the latest captured event.',
      );
    }
    if (input.project !== pass.sourceProject) {
      return failure('stale-project', 'Automation pass no longer owns the current Project.');
    }
    const fingerprint = projectFingerprint(input.project);
    if (typeof fingerprint !== 'string') return fingerprint;
    if (fingerprint !== pass.sourceFingerprint) {
      return failure('stale-project', 'Automation pass source changed after capture began.');
    }
    if (
      input.idFactory !== undefined
      && typeof input.idFactory !== 'function'
    ) {
      return failure('id-factory-failed', 'Automation id factory must be a function.');
    }

    const plans: PlannedLane[] = [];
    for (const capture of stablePlanOrder(input.project, pass.captures)) {
      const planned = planLane(
        input.project,
        pass.frozenProject as Project,
        capture,
        input.punchOutBeat,
      );
      if (planned === null) continue;
      if ('ok' in planned) return planned;
      plans.push(planned);
    }
    if (plans.length === 0) {
      return Object.freeze({
        ok: true,
        project: input.project,
        changed: false,
        recordedRanges: Object.freeze([]),
      });
    }
    if (typeof input.idFactory !== 'function') {
      return failure(
        'id-factory-failed',
        'A deterministic automation id factory is required for a changed pass.',
      );
    }
    const candidate = adoptPlans(
      input.project,
      plans,
      input.idFactory,
    );
    if ('ok' in candidate) return candidate;
    const encoded = encodeProjectJson(candidate);
    if (!encoded.ok) {
      const first = encoded.error.issues[0];
      return failure(
        'invalid-automation',
        `Automation pass was rejected.${first ? ` ${first.path}: ${first.message}` : ''}`,
        encoded.error.issues,
      );
    }
    return Object.freeze({
      ok: true,
      project: candidate,
      changed: true,
      recordedRanges: Object.freeze(plans.flatMap((plan) =>
        plan.groups.map((group) => Object.freeze({
          target: freezeTarget(plan.capture.target),
          startBeat: group.startBeat,
          endBeat: group.endBeat,
        })))),
    });
  } catch {
    return failure('unexpected', 'The automation pass could not be finalized safely.');
  }
}

/** Cancel is always a Project no-op, but still rejects stale ownership explicitly. */
export function cancelAutomationPass(
  pass: AutomationPass,
  project?: Project,
): AutomationPassFinalizationResult {
  try {
    const passFailure = inspectPass(pass);
    if (passFailure) return passFailure;
    const ownedProject = project ?? pass.sourceProject;
    if (ownedProject !== pass.sourceProject) {
      return failure('stale-project', 'Automation pass no longer owns the current Project.');
    }
    const fingerprint = projectFingerprint(ownedProject);
    if (typeof fingerprint !== 'string') return fingerprint;
    if (fingerprint !== pass.sourceFingerprint) {
      return failure('stale-project', 'Automation pass source changed after capture began.');
    }
    return Object.freeze({
      ok: true,
      project: ownedProject,
      changed: false,
      recordedRanges: Object.freeze([]),
    });
  } catch {
    return failure('unexpected', 'The automation pass could not be cancelled safely.');
  }
}

// Explicit recording-named aliases keep call sites readable without duplicating behavior.
export const beginAutomationRecordingPass = beginAutomationPass;
export const rebaseAutomationRecordingPass = rebaseAutomationPass;
export const touchAutomationRecordingPass = touchAutomationPass;
export const sampleAutomationRecordingPass = sampleAutomationPass;
export const releaseAutomationRecordingPass = releaseAutomationPass;
export const punchOutAutomationRecordingPass = punchOutAutomationPass;
export const cancelAutomationRecordingPass = cancelAutomationPass;
