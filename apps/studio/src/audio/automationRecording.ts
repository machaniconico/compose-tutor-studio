import {
  beginAutomationPass,
  cancelAutomationPass,
  punchOutAutomationPass,
  rebaseAutomationPass,
  releaseAutomationPass,
  sampleAutomationPass,
  touchAutomationPass,
  type AutomationPass,
  type AutomationRecordingErrorCode,
  type AutomationTarget,
  type AutomationWriteMode,
  type Project,
} from '@cts/project-model';

export type AutomationRecordingOwnership = Readonly<{
  projectId: string;
  activationId: string;
  playbackRequestId: number;
}>;

export type AutomationRecordingBoundary =
  | 'stop'
  | 'natural-end'
  | 'seek'
  | 'cycle-right-locator'
  | 'mode-change'
  | 'read-change'
  | 'bypass-change'
  | 'undo'
  | 'redo'
  | 'project-activation'
  | 'native-close'
  | 'pagehide';

export type AutomationRecordingStatusCode =
  | AutomationRecordingErrorCode
  | 'audio-recording-conflict'
  | 'stale-activation'
  | 'stale-playback'
  | 'commit-rejected'
  | 'clock-unavailable'
  | 'no-active-pass';

export type AutomationRecordingStatus = Readonly<{
  code: AutomationRecordingStatusCode;
  message: string;
}> | null;

export type AutomationRecordingRuntimeState = Readonly<{
  trackModes: Readonly<Record<string, AutomationWriteMode>>;
  armedTrackIds: readonly string[];
  writingTrackIds: readonly string[];
  touchingTargetKeys: readonly string[];
  passActive: boolean;
  ownership: AutomationRecordingOwnership | null;
  status: AutomationRecordingStatus;
}>;

export type AutomationRecordingGraphBridge = Readonly<{
  beginOverride: (target: AutomationTarget, value: number) => void;
  updateOverride: (target: AutomationTarget, value: number) => void;
  releaseTouchOverride: (target: AutomationTarget, resumeBeat: number) => void;
  resumeOverride: (target: AutomationTarget, resumeBeat: number) => void;
}>;

export type AttachAutomationPlaybackInput = Readonly<{
  project: Project;
  activationId: string;
  playbackRequestId: number;
  currentBeat: () => number;
  graph: AutomationRecordingGraphBridge;
  audioRecordingActive: boolean;
}>;

export type AutomationRecordingCommit = (
  expectedProject: Project,
  nextProject: Project,
) => boolean;

export type AutomationRecordingResult =
  | Readonly<{ ok: true; changed: boolean }>
  | Readonly<{
      ok: false;
      code: AutomationRecordingStatusCode;
      message: string;
    }>;

export type AutomationReadScalarRebasePreparation = Readonly<{
  expectedPass: AutomationPass;
  nextPass: AutomationPass;
}>;

export type AutomationReadScalarRebasePreparationResult =
  | Readonly<{
      ok: true;
      preparation: AutomationReadScalarRebasePreparation | null;
      changedTargets: readonly AutomationTarget[];
    }>
  | Readonly<{
      ok: false;
      code: AutomationRecordingStatusCode;
      message: string;
    }>;

const NO_STATUS: AutomationRecordingStatus = null;

function targetKey(target: AutomationTarget): string {
  return `${target.trackId}:${target.type}`;
}

function sameOwnership(
  left: AutomationRecordingOwnership,
  right: AutomationRecordingOwnership,
): boolean {
  return left.projectId === right.projectId
    && left.activationId === right.activationId
    && left.playbackRequestId === right.playbackRequestId;
}

function failure(
  code: AutomationRecordingStatusCode,
  message: string,
): Extract<AutomationRecordingResult, { ok: false }> {
  return { ok: false, code, message };
}

export function automationRecordingStatusMessage(
  code: AutomationRecordingStatusCode,
): string {
  switch (code) {
    case 'audio-recording-conflict':
      return '音声録音が進行中のため、オートメーション記録を開始できません。音声録音を終了してからもう一度お試しください。';
    case 'stale-project':
    case 'stale-activation':
    case 'stale-playback':
      return '別のプロジェクトまたは再生が有効になったため、オートメーション記録は反映していません。現在の内容を確認してください。';
    case 'commit-rejected':
      return '別の編集または保存処理が先に進んだため、オートメーション記録は反映していません。記録内容は再試行できる状態で保持しています。';
    case 'clock-unavailable':
      return '正確な再生位置を確認できないため、オートメーション記録を確定していません。再生を停止してもう一度お試しください。';
    case 'point-limit':
      return 'オートメーションのポイント数上限に達したため、記録は反映していません。「記録を破棄して停止」で終了した後、不要なポイントを減らしてからもう一度お試しください。';
    case 'lane-limit':
      return 'オートメーションのレーン数上限に達したため、記録は反映していません。「記録を破棄して停止」で終了した後、不要なレーンを削除してからもう一度お試しください。';
    case 'invalid-beat':
      return '記録位置を安全に確定できないため、オートメーションは反映していません。再生位置を確認してください。';
    case 'invalid-track':
    case 'invalid-target':
    case 'master-protected':
      return 'このトラックまたはパラメーターにはオートメーションを記録できません。通常トラックの音量またはパンを選んでください。';
    case 'invalid-mode':
      return '現在のオートメーションモードでは記録できません。Touch、Latch、またはWriteを選んでください。';
    case 'not-touching':
    case 'already-touching':
      return 'コントロールの操作状態が一致しないため、このサンプルは記録していません。もう一度操作してください。';
    case 'project-not-adoptable':
    case 'invalid-pass':
    case 'invalid-automation':
      return '現在のプロジェクトを安全に検証できないため、オートメーション記録は反映していません。';
    case 'invalid-value':
      return '音量またはパンの値が範囲外のため、このサンプルは記録していません。';
    case 'duplicate-track':
    case 'invalid-id':
    case 'duplicate-id':
    case 'id-factory-failed':
    case 'unexpected':
      return 'オートメーション記録を安全に確定できませんでした。プロジェクトは変更されていません。';
    case 'no-active-pass':
      return '確定するオートメーション記録はありません。';
  }
}

function frozenScalar(
  project: Project,
  target: AutomationTarget,
): number {
  const track = project.tracks.find((candidate) => candidate.id === target.trackId);
  if (!track) return target.type === 'track-volume' ? 1 : 0;
  return target.type === 'track-volume' ? track.volume : track.pan;
}

export class AutomationRecordingCoordinator {
  private projectId = '';
  private activationId = '';
  private modes = new Map<string, AutomationWriteMode>();
  private pass: AutomationPass | null = null;
  private ownership: AutomationRecordingOwnership | null = null;
  private currentBeat: (() => number) | null = null;
  private graph: AutomationRecordingGraphBridge | null = null;
  private lastBeat = 0;
  private readonly writingTrackIds = new Set<string>();
  private readonly touchingTargetKeys = new Set<string>();
  private readonly overriddenTargets = new Map<string, AutomationTarget>();
  private status: AutomationRecordingStatus = NO_STATUS;

  activate(project: Project, activationId: string): void {
    if (this.pass !== null) {
      this.resumeAllOverrides(this.lastBeat);
    }
    this.projectId = project.id;
    this.activationId = activationId;
    this.modes = new Map(
      project.tracks
        .filter((track) => track.type !== 'master')
        .map((track) => [track.id, 'read' as const]),
    );
    this.clearPass();
    this.status = NO_STATUS;
  }

  snapshot(): AutomationRecordingRuntimeState {
    const trackModes = Object.fromEntries(this.modes);
    return Object.freeze({
      trackModes: Object.freeze(trackModes),
      armedTrackIds: Object.freeze(
        [...this.modes]
          .filter(([, mode]) => mode !== 'read')
          .map(([trackId]) => trackId),
      ),
      writingTrackIds: Object.freeze([...this.writingTrackIds]),
      touchingTargetKeys: Object.freeze([...this.touchingTargetKeys]),
      passActive: this.pass !== null,
      ownership: this.ownership ? Object.freeze({ ...this.ownership }) : null,
      status: this.status,
    });
  }

  modeForTrack(trackId: string): AutomationWriteMode {
    return this.modes.get(trackId) ?? 'read';
  }

  hasActivePass(): boolean {
    return this.pass !== null;
  }

  /**
   * Prepare, without mutating runtime ownership, an exact Read-scalar rebase.
   * The returned token can be adopted after persistence accepts the Project.
   */
  prepareReadScalarRebase(
    expectedProject: Project,
    nextProject: Project,
  ): AutomationReadScalarRebasePreparationResult {
    if (this.pass === null) {
      return Object.freeze({
        ok: true,
        preparation: null,
        changedTargets: Object.freeze([]),
      });
    }
    const rebased = rebaseAutomationPass(this.pass, {
      expectedProject,
      nextProject,
    });
    if (!rebased.ok) {
      return failure(
        rebased.error.code,
        automationRecordingStatusMessage(rebased.error.code),
      );
    }
    return Object.freeze({
      ok: true,
      preparation: Object.freeze({
        expectedPass: this.pass,
        nextPass: rebased.pass,
      }),
      changedTargets: rebased.changedTargets,
    });
  }

  /**
   * Adopt a synchronously prepared token. No code may yield between prepare
   * and adopt; a mismatch is therefore an invariant violation.
   */
  adoptPreparedReadScalarRebase(
    preparation: AutomationReadScalarRebasePreparation | null,
  ): void {
    if (preparation === null) return;
    if (this.pass !== preparation.expectedPass) {
      throw new Error('Automation Read scalar rebase lost pass ownership.');
    }
    this.pass = preparation.nextPass;
    this.status = NO_STATUS;
  }

  setTrackMode(
    project: Project,
    activationId: string,
    trackId: string,
    mode: AutomationWriteMode,
  ): AutomationRecordingResult {
    if (!this.matchesActivation(project, activationId) && this.pass === null) {
      this.activate(project, activationId);
    }
    if (!this.matchesActivation(project, activationId)) {
      return this.fail('stale-activation');
    }
    if (this.pass !== null) {
      return this.fail('commit-rejected');
    }
    const track = project.tracks.find((candidate) => candidate.id === trackId);
    if (!track || track.type === 'master') {
      return this.fail(track?.type === 'master' ? 'master-protected' : 'invalid-track');
    }
    if (mode !== 'read' && mode !== 'touch' && mode !== 'latch' && mode !== 'write') {
      return this.fail('invalid-mode');
    }
    const changed = this.modeForTrack(trackId) !== mode;
    if (changed) this.modes.set(trackId, mode);
    this.status = NO_STATUS;
    return { ok: true, changed };
  }

  attachPlayback(input: AttachAutomationPlaybackInput): AutomationRecordingResult {
    // Test/dev harnesses may replace a whole Project through Zustand's raw
    // setState. With no owned pass this is equivalent to activation and is safe
    // to reconcile; an active pass still fails closed.
    if (!this.matchesActivation(input.project, input.activationId) && this.pass === null) {
      this.activate(input.project, input.activationId);
    }
    if (!this.matchesActivation(input.project, input.activationId)) {
      return this.fail('stale-activation');
    }
    if (this.pass !== null) {
      return this.fail('commit-rejected');
    }
    const tracks = input.project.tracks
      .filter((track) => track.type !== 'master')
      .map((track) => ({
        trackId: track.id,
        mode: this.modeForTrack(track.id),
      }));
    if (!tracks.some((track) => track.mode !== 'read')) {
      this.status = NO_STATUS;
      return { ok: true, changed: false };
    }
    if (input.audioRecordingActive) {
      return this.fail('audio-recording-conflict');
    }
    const beat = this.readBeat(input.currentBeat, input.project.lengthBeats);
    if (beat === null) return this.fail('clock-unavailable');
    let started: ReturnType<typeof beginAutomationPass>;
    try {
      started = beginAutomationPass(input.project, { startBeat: beat, tracks });
    } catch {
      return this.fail('unexpected');
    }
    if (!started.ok) return this.fail(started.error.code);

    const writeTargets: AutomationTarget[] = [];
    try {
      for (const trackMode of tracks) {
        if (trackMode.mode !== 'write') continue;
        for (const type of ['track-volume', 'track-pan'] as const) {
          const target = Object.freeze({ type, trackId: trackMode.trackId });
          writeTargets.push(target);
          input.graph.beginOverride(
            target,
            frozenScalar(input.project, target),
          );
        }
      }
    } catch {
      this.resumeTargets(input.graph, writeTargets, beat);
      return this.fail('unexpected');
    }

    this.pass = started.pass;
    this.ownership = Object.freeze({
      projectId: input.project.id,
      activationId: input.activationId,
      playbackRequestId: input.playbackRequestId,
    });
    this.currentBeat = input.currentBeat;
    this.graph = input.graph;
    this.lastBeat = beat;
    this.status = NO_STATUS;
    for (const target of writeTargets) {
      this.writingTrackIds.add(target.trackId);
      this.overriddenTargets.set(targetKey(target), target);
    }
    return { ok: true, changed: true };
  }

  gestureBegin(
    ownership: AutomationRecordingOwnership,
    target: AutomationTarget,
    value: number,
  ): AutomationRecordingResult {
    const ready = this.requireOwnedPass(ownership);
    if (!ready.ok) return ready;
    const beat = this.readCurrentPassBeat();
    if (beat === null) return this.fail('clock-unavailable');
    const touched = touchAutomationPass(this.pass!, { target, beat, value });
    if (!touched.ok) return this.fail(touched.error.code);
    try {
      this.graph?.beginOverride(target, value);
    } catch {
      if (this.graph) this.resumeTargets(this.graph, [target], beat);
      return this.fail('unexpected');
    }
    this.pass = touched.pass;
    this.lastBeat = beat;
    this.touchingTargetKeys.add(targetKey(target));
    this.writingTrackIds.add(target.trackId);
    this.overriddenTargets.set(targetKey(target), Object.freeze({ ...target }));
    this.status = NO_STATUS;
    return { ok: true, changed: true };
  }

  gestureUpdate(
    ownership: AutomationRecordingOwnership,
    target: AutomationTarget,
    value: number,
  ): AutomationRecordingResult {
    const ready = this.requireOwnedPass(ownership);
    if (!ready.ok) return ready;
    const beat = this.readCurrentPassBeat();
    if (beat === null) return this.fail('clock-unavailable');
    const sampled = sampleAutomationPass(this.pass!, { target, beat, value });
    if (!sampled.ok) return this.fail(sampled.error.code);
    try {
      this.graph?.updateOverride(target, value);
    } catch {
      return this.fail('unexpected');
    }
    this.pass = sampled.pass;
    this.lastBeat = beat;
    this.status = NO_STATUS;
    return { ok: true, changed: true };
  }

  gestureEnd(
    ownership: AutomationRecordingOwnership,
    target: AutomationTarget,
  ): AutomationRecordingResult {
    const ready = this.requireOwnedPass(ownership);
    if (!ready.ok) return ready;
    const beat = this.readCurrentPassBeat();
    if (beat === null) return this.fail('clock-unavailable');
    const released = releaseAutomationPass(this.pass!, { target, beat });
    if (!released.ok) return this.fail(released.error.code);
    const mode = this.modeForTrack(target.trackId);
    if (mode === 'touch') {
      try {
        this.graph?.releaseTouchOverride(target, beat);
      } catch {
        return this.fail('unexpected');
      }
    }
    this.pass = released.pass;
    this.lastBeat = beat;
    this.touchingTargetKeys.delete(targetKey(target));
    if (mode === 'touch') {
      this.overriddenTargets.delete(targetKey(target));
      if (![...this.touchingTargetKeys].some((key) => key.startsWith(`${target.trackId}:`))) {
        this.writingTrackIds.delete(target.trackId);
      }
    }
    this.status = NO_STATUS;
    return { ok: true, changed: true };
  }

  punchOut(
    ownership: AutomationRecordingOwnership,
    project: Project,
    commit: AutomationRecordingCommit,
    explicitBeat?: number,
  ): AutomationRecordingResult {
    const ready = this.requireOwnedPass(ownership);
    if (!ready.ok) return ready;
    if (project !== this.pass!.sourceProject || project.id !== ownership.projectId) {
      return this.fail('stale-project');
    }
    const punchOutBeat = explicitBeat ?? this.readCurrentPassBeat();
    if (punchOutBeat === null) return this.fail('clock-unavailable');
    const boundedBeat = Math.min(project.lengthBeats, Math.max(this.lastBeat, punchOutBeat));
    let finalized: ReturnType<typeof punchOutAutomationPass>;
    try {
      finalized = punchOutAutomationPass(this.pass!, {
        project,
        punchOutBeat: boundedBeat,
        idFactory: (kind) => this.createRecordingId(kind),
      });
    } catch {
      return this.fail('unexpected');
    }
    if (!finalized.ok) return this.fail(finalized.error.code);
    if (finalized.changed) {
      try {
        if (!commit(project, finalized.project)) {
          return this.fail('commit-rejected');
        }
      } catch {
        return this.fail('commit-rejected');
      }
    }
    this.resumeAllOverrides(boundedBeat);
    this.fallBackWriteModesToTouch();
    this.clearPass();
    this.status = NO_STATUS;
    return { ok: true, changed: finalized.changed };
  }

  punchOutCurrent(
    project: Project,
    activationId: string,
    commit: AutomationRecordingCommit,
    explicitBeat?: number,
  ): AutomationRecordingResult {
    if (this.pass === null || this.ownership === null) {
      return { ok: true, changed: false };
    }
    if (!this.matchesActivation(project, activationId)) {
      return this.fail('stale-activation');
    }
    return this.punchOut(this.ownership, project, commit, explicitBeat);
  }

  cancelCurrent(project: Project, activationId: string): AutomationRecordingResult {
    if (this.pass === null) return { ok: true, changed: false };
    if (!this.matchesActivation(project, activationId)) {
      return this.fail('stale-activation');
    }
    const cancelled = cancelAutomationPass(this.pass, project);
    if (!cancelled.ok) return this.fail(cancelled.error.code);
    this.resumeAllOverrides(this.lastBeat);
    this.fallBackWriteModesToTouch();
    this.clearPass();
    this.status = NO_STATUS;
    return { ok: true, changed: false };
  }

  detachPlayback(ownership: AutomationRecordingOwnership): void {
    if (!this.ownership || !sameOwnership(this.ownership, ownership)) return;
    this.currentBeat = null;
    this.graph = null;
  }

  private matchesActivation(project: Project, activationId: string): boolean {
    return project.id === this.projectId && activationId === this.activationId;
  }

  private requireOwnedPass(
    ownership: AutomationRecordingOwnership,
  ): AutomationRecordingResult {
    if (this.pass === null || this.ownership === null) {
      return this.fail('no-active-pass');
    }
    if (
      ownership.projectId !== this.projectId
      || ownership.activationId !== this.activationId
    ) {
      return this.fail('stale-activation');
    }
    if (!sameOwnership(this.ownership, ownership)) {
      return this.fail('stale-playback');
    }
    return { ok: true, changed: false };
  }

  private readCurrentPassBeat(): number | null {
    if (this.currentBeat === null || this.pass === null) return this.lastBeat;
    return this.readBeat(this.currentBeat, this.pass.frozenProject.lengthBeats);
  }

  private readBeat(clock: () => number, lengthBeats: number): number | null {
    try {
      const beat = clock();
      if (!Number.isFinite(beat) || beat < 0) return null;
      return Math.min(lengthBeats, beat);
    } catch {
      return null;
    }
  }

  private createRecordingId(kind: 'lane' | 'point'): string {
    const random = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `automation-${kind}-${random}`;
  }

  private resumeAllOverrides(beat: number): void {
    if (!this.graph) return;
    this.resumeTargets(this.graph, this.overriddenTargets.values(), beat);
  }

  private resumeTargets(
    graph: AutomationRecordingGraphBridge,
    targets: Iterable<AutomationTarget>,
    beat: number,
  ): void {
    for (const target of targets) {
      try {
        graph.resumeOverride(target, beat);
      } catch {
        // Runtime graph disposal is best-effort. Project/pass ownership must
        // still settle deterministically at activation and punch-out.
      }
    }
  }

  private fallBackWriteModesToTouch(): void {
    for (const [trackId, mode] of this.modes) {
      if (mode === 'write') this.modes.set(trackId, 'touch');
    }
  }

  private clearPass(): void {
    this.pass = null;
    this.ownership = null;
    this.currentBeat = null;
    this.graph = null;
    this.lastBeat = 0;
    this.writingTrackIds.clear();
    this.touchingTargetKeys.clear();
    this.overriddenTargets.clear();
  }

  private fail(
    code: AutomationRecordingStatusCode,
  ): Extract<AutomationRecordingResult, { ok: false }> {
    const message = automationRecordingStatusMessage(code);
    this.status = Object.freeze({ code, message });
    return failure(code, message);
  }
}
