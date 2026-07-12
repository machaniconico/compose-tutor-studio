// Central Zustand store for Compose Tutor Studio.
//
// Holds the project, transport, editor UI state, panel state, and an
// undo/redo history of project snapshots. Project mutations always bump
// `updatedAt`, push history, and schedule a debounced localStorage save.

import { create } from 'zustand';
import {
  ProjectSaveCoordinator,
  type LoadedProject,
  type RepositoryOperation,
  type ProjectRepository,
  type ProjectSummary,
  type RepositoryResult,
  type RetryPolicy,
} from '@cts/project-persistence';
import {
  beatsPerBar as beatsPerBarForTimeSignature,
  clipContentOwnerId,
  createEmptyProject,
  decodeProject,
  encodeProjectJson,
  findClip as findProjectClip,
  resolveClipContent,
  type ChordEvent,
  type DrumEvent,
  type DrumLane,
  type MusicalKey,
  type NoteEvent,
  type Project,
  type ScaleName,
  type Track,
} from '@cts/project-model';
import { getScalePitchClasses } from '@cts/theory-engine';
import { createDefaultProject } from './defaultProject';
import { nowIso, uid } from './ids';
import { publishAppEvent } from './appEvents';
import { type SaveFailureCode, toSaveFailure } from './persistence';
import { selectedProjectRepository } from '../platform/runtime';
import { studioRuntime } from '../platform/runtime';
import {
  clearRendererStorageAndBrowsingData,
  createSecureEraseId,
  nativeLocalDataEraseGateway,
  type NativeLocalDataEraseGateway,
} from '../platform/nativeLocalDataErase';
import {
  nativeAppLifecycleGateway,
  type NativeCloseAuthorization,
} from '../platform/nativeAppLifecycle';
import { fenceRendererStorageWrites } from '../platform/rendererStorageFence';
import { nativeLifecycleGate } from '../platform/nativeLifecycleGate';
import { settleNativeCloseHandoff } from '../platform/nativeCloseHandoff';

export type EditorView = 'pianoRoll' | 'drums' | 'arranger';

export type TransportPhase = 'stopped' | 'starting' | 'playing';

export type AudioIssue = 'start-failed' | 'event-limit-exceeded' | 'interrupted' | null;

export type TransportState = {
  /** Confirmed lifecycle state. `starting` is intent, `playing` means audio started. */
  phase: TransportPhase;
  /** Backward-compatible convenience flag; true only while audio is confirmed playing. */
  isPlaying: boolean;
  /** Monotonic generation used to reject stale async audio callbacks. */
  playbackRequestId: number;
  /** Persistent, beginner-facing audio problem until retry or explicit dismissal. */
  audioIssue: AudioIssue;
  positionBeat: number;
  loopEnabled: boolean;
  loopStartBeat: number;
  loopEndBeat: number;
  metronome: boolean;
};

export type EditorState = {
  activeView: EditorView;
  selectedTrackId: string | null;
  selectedClipId: string | null;
  selectedChordId: string | null;
  selectedNoteIds: string[];
  scaleSnap: boolean;
  chordToneHighlight: boolean;
  zoomX: number;
};

const HISTORY_CAP = 100;
const SAVE_DEBOUNCE_MS = 2000;
const SAVE_MAX_WAIT_MS = 30_000;

/** null is proven empty; undefined deliberately requests head repair. */
function expectedHeadForLoaded(loaded: LoadedProject | null): string | null | undefined {
  if (loaded === null) return null;
  return loaded.headVersion === null ? undefined : loaded.headVersion;
}

export type ProjectSaveState = {
  phase: 'idle' | 'pending' | 'saved' | 'error';
  projectId: string;
  /** Distinguishes re-opening/replacing the same project id. */
  activationId: string;
  /** Monotonically increases for each in-memory project edit. */
  revision: number;
  /** The latest revision confirmed written to persistent storage. */
  persistedRevision: number;
  /** Latest revision acknowledged by canonical storage or native crash draft. */
  protectedRevision: number;
  crashProtectionAvailable: boolean;
  protectionFailed: boolean;
  /** Actual completion time of the latest successful save. */
  lastSavedAt: string | null;
  failure: SaveFailureCode | null;
  retry: RetryPolicy | null;
};

export type PersistenceNotice = Readonly<{
  kind: 'recovered' | 'warning';
  message: string;
}>;

export type LocalDataEraseState = Readonly<{
  phase:
    | 'idle'
    | 'quiescing'
    | 'native-pending'
    | 'renderer-clearing'
    /** App data is gone and the final native window-close request is in flight. */
    | 'erase-close-pending'
    /** Native accepted window destruction; no retry is safe in this process. */
    | 'erase-close-accepted'
    /** Final close was dispatched, but its response is unknown; retry is unsafe. */
    | 'erase-close-unknown'
    | 'failed'
    /** Normal close was dispatched, but its final native response is unknown. */
    | 'close-handoff';
  eraseId: string | null;
  message: string | null;
}>;

export type LocalDataEraseStoreDependencies = Readonly<{
  gateway: NativeLocalDataEraseGateway;
  clearRendererData: () => Promise<void>;
  finishClose: (
    authorization: NativeCloseAuthorization,
  ) => Promise<boolean> | boolean;
  closeHandoffTimeoutMs?: number;
  createEraseId?: () => string | null;
  fenceWrites?: () => void;
  /** Synchronous mutual exclusion with the native normal-close pipeline. */
  tryClaimErase?: () => boolean;
}>;

export type StudioStoreOptions = Readonly<{
  /** null explicitly disables the desktop-only erasure command. */
  localDataErase?: LocalDataEraseStoreDependencies | null;
}>;

export type StoreState = {
  project: Project;
  transport: TransportState;
  editor: EditorState;
  tutorialPanelOpen: boolean;
  /** Free-form inspector content state (e.g. selected chord summary). */
  inspector: { content: string | null };
  saveState: ProjectSaveState;
  persistenceReady: boolean;
  /** True while a project-level load/create/import/delete transition owns persistence. */
  projectOperationBusy: boolean;
  localDataErase: LocalDataEraseState;
  persistenceNotice: PersistenceNotice | null;
  savedProjects: readonly ProjectSummary[];

  // history
  past: Project[];
  future: Project[];

  /** Generic escape hatch: apply an immutable project change (bumps updatedAt, pushes history, saves). */
  applyProjectChange: (fn: (p: Project) => Project) => boolean;

  // project metadata actions
  setBpm: (bpm: number) => void;
  setKey: (key: MusicalKey) => void;
  setScale: (scale: ScaleName) => void;
  setTitle: (title: string) => void;

  // chord actions
  addChord: (symbol: string, startBeat: number, durationBeats: number) => void;
  updateChord: (id: string, patch: Partial<Omit<ChordEvent, 'id'>>) => void;
  removeChord: (id: string) => void;

  // note actions
  addNote: (clipId: string, note: Omit<NoteEvent, 'id'> & { id?: string }) => void;
  updateNote: (clipId: string, noteId: string, patch: Partial<Omit<NoteEvent, 'id'>>) => void;
  removeNote: (clipId: string, noteId: string) => void;

  // drum actions
  /** Returns true only when the requested step change was adopted by the project. */
  toggleDrumStep: (clipId: string, lane: DrumLane, stepIndex: number) => boolean;

  // mixer actions
  setTrackVolume: (trackId: string, volume: number) => void;
  setTrackPan: (trackId: string, pan: number) => void;
  toggleMute: (trackId: string) => void;
  toggleSolo: (trackId: string) => void;

  // selection (UI-only, no history)
  selectTrack: (trackId: string | null) => void;
  selectClip: (clipId: string | null) => void;
  selectChord: (chordId: string | null) => void;
  selectNotes: (noteIds: string[]) => void;

  // editor toggles (UI-only)
  setActiveView: (view: EditorView) => void;
  toggleScaleSnap: () => void;
  toggleChordToneHighlight: () => void;
  setZoomX: (zoomX: number) => void;
  toggleTutorialPanel: () => void;
  setInspectorContent: (content: string | null) => void;

  // transport
  //
  // The store owns play/stop *intent* and position semantics only; the audio
  // engine subscribes to these via `initAudioBridge()` (src/audio/playback.ts)
  // so the store never imports audio code.
  play: () => void;
  /** Confirm an audio start only when it still belongs to the active request. */
  confirmPlaybackStarted: (requestId: number) => void;
  /** Reject a failed audio start only when it still belongs to the active request. */
  failPlaybackStart: (
    requestId: number,
    issue?: Exclude<AudioIssue, null | 'interrupted'>,
  ) => void;
  /** Stop a confirmed/current request after the browser interrupts its audio context. */
  interruptPlayback: (requestId: number) => void;
  /** Rewind after the scheduler reaches the natural end of the active request. */
  finishPlayback: (requestId: number) => void;
  clearAudioIssue: () => void;
  /**
   * Stop playback.
   *  - while starting or playing: cancel/pause, keeping the current position
   *    (so a re-press of play resumes from where it stopped);
   *  - while already stopped (or with `reset` true): rewind to beat 0.
   */
  stop: (reset?: boolean) => void;
  setPosition: (beat: number) => void;
  toggleLoop: () => void;
  toggleMetronome: () => void;

  // history actions
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // persistence
  initializePersistence: () => Promise<void>;
  saveToLocalStorage: () => Promise<boolean>;
  /** Flush queued work through the async repository. */
  flushPendingSave: () => Promise<boolean>;
  /** Page lifecycle escape hatch; never claims success for async-only storage. */
  flushPendingSaveSynchronously: () => boolean;
  /** Synchronously blocks project mutations while native close owns durability. */
  tryBeginNativeClose: () => boolean;
  /** Releases a reversible native-close mutation fence after close was blocked. */
  cancelNativeClose: () => void;
  refreshSavedProjects: () => Promise<boolean>;
  listSavedProjects: () => readonly ProjectSummary[];
  createNewProject: (title?: string) => Promise<boolean>;
  deleteProject: (id: string) => Promise<boolean>;
  /** Load a saved project by id into the store (resets history + selection). */
  loadProjectById: (id: string) => Promise<boolean>;
  /** Open a retained recovery/intent branch as a fresh project copy. */
  recoverProjectBranch: (projectId: string, branchId: string) => Promise<boolean>;
  /** Replace the whole project (e.g. template instantiation / file import). */
  replaceProject: (project: Project) => Promise<boolean>;
  clearPersistenceNotice: () => void;
  /** Permanently seals this renderer and removes every native/local datum. */
  eraseAllLocalData: () => Promise<boolean>;
  /** Fail closed after the final normal-close IPC may have destroyed the window. */
  markNativeCloseHandoffUnknown: () => void;
};

// ---------------------------------------------------------------------------
// State builders.
// ---------------------------------------------------------------------------
function makeTransport(playbackRequestId = 0): TransportState {
  return {
    phase: 'stopped',
    isPlaying: false,
    playbackRequestId,
    audioIssue: null,
    positionBeat: 0,
    loopEnabled: false,
    loopStartBeat: 0,
    loopEndBeat: 0,
    metronome: false,
  };
}

function transportProjectLengthBeats(project: Project): number {
  const length =
    project.lengthBars * beatsPerBarForTimeSignature(project.timeSignature);
  return Number.isFinite(length) && length > 0 ? length : 0;
}

function safeTransportPosition(positionBeat: number, projectLength: number): number {
  if (!Number.isFinite(positionBeat) || projectLength <= 0) return 0;
  return Math.min(projectLength, Math.max(0, positionBeat));
}

function safeLoopBounds(
  startBeat: number,
  endBeat: number,
  projectLength: number,
): { startBeat: number; endBeat: number } {
  if (projectLength <= 0) return { startBeat: 0, endBeat: 0 };
  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat)) {
    return { startBeat: 0, endBeat: projectLength };
  }

  const safeStart = Math.min(projectLength, Math.max(0, startBeat));
  const safeEnd = Math.min(projectLength, Math.max(0, endBeat));
  return safeEnd > safeStart
    ? { startBeat: safeStart, endBeat: safeEnd }
    : { startBeat: 0, endBeat: projectLength };
}

function makeEditor(project: Project): EditorState {
  const firstTrack = project.tracks[0];
  const firstClip = firstTrack?.clips[0];
  return {
    activeView: 'pianoRoll',
    selectedTrackId: firstTrack ? firstTrack.id : null,
    selectedClipId: firstClip ? firstClip.id : null,
    selectedChordId: null,
    selectedNoteIds: [],
    scaleSnap: false,
    chordToneHighlight: true,
    zoomX: 1,
  };
}

/** Drop UI selections that no longer exist in a restored or edited project. */
function reconcileEditorSelection(
  editor: EditorState,
  project: Project,
): EditorState {
  const located = editor.selectedClipId
    ? findProjectClip(project, editor.selectedClipId)
    : undefined;
  const effective = located
    ? resolveClipContent(project, located.clip)
    : null;
  const noteIds = new Set(effective?.notes?.map((note) => note.id) ?? []);
  const selectedTrackId = project.tracks.some(
    (track) => track.id === editor.selectedTrackId,
  )
    ? editor.selectedTrackId
    : (located?.track.id ?? null);
  const selectedChordId = project.chordTrack.some(
    (chord) => chord.id === editor.selectedChordId,
  )
    ? editor.selectedChordId
    : null;

  return {
    ...editor,
    selectedTrackId,
    selectedClipId: located?.clip.id ?? null,
    selectedChordId,
    selectedNoteIds: located
      ? editor.selectedNoteIds.filter((id) => noteIds.has(id))
      : [],
  };
}

/** Map over tracks immutably. */
function mapTracks(project: Project, fn: (t: Track) => Track): Project {
  return { ...project, tracks: project.tracks.map(fn) };
}

/** Find the track that owns a clip (read-only). */
function trackOfClip(project: Project, clipId: string): Track | undefined {
  return project.tracks.find((t) => t.clips.some((c) => c.id === clipId));
}

/** Whether a MIDI pitch belongs to the project's key/scale. */
function pitchInScale(project: Project, pitch: number): boolean {
  try {
    const pcs = getScalePitchClasses(project.key, project.scale);
    const pc = ((pitch % 12) + 12) % 12;
    return pcs.includes(pc);
  } catch {
    return false;
  }
}

function makeSaveState(
  project: Project,
  activationId: string,
  persisted: boolean,
  crashProtectionAvailable: boolean,
): ProjectSaveState {
  return {
    phase: persisted ? 'saved' : 'idle',
    projectId: project.id,
    activationId,
    revision: 0,
    persistedRevision: persisted ? 0 : -1,
    protectedRevision: persisted ? 0 : -1,
    crashProtectionAvailable,
    protectionFailed: false,
    // The stored project predates explicit save metadata. Its updatedAt is the
    // best truthful timestamp available until the next successful save.
    lastSavedAt: persisted ? project.updatedAt : null,
    failure: null,
    retry: null,
  };
}

export function createStudioStore(
  repository: ProjectRepository = selectedProjectRepository,
  options: StudioStoreOptions = {},
) {
  const startingProject = createDefaultProject();
  const startingActivationId = uid('activation');
  const coordinator = new ProjectSaveCoordinator({ repository });
  const crashProtectionAvailable = coordinator.supportsCrashProtection();
  const localDataEraseDependencies: LocalDataEraseStoreDependencies | null =
    options.localDataErase === undefined
      ? studioRuntime.kind === 'native'
        ? {
            gateway: nativeLocalDataEraseGateway,
            clearRendererData: clearRendererStorageAndBrowsingData,
            finishClose: (authorization) =>
              nativeAppLifecycleGateway.finishClose(authorization),
            createEraseId: createSecureEraseId,
            fenceWrites: fenceRendererStorageWrites,
            tryClaimErase: () => nativeLifecycleGate.tryClaimErase(),
          }
        : null
      : options.localDataErase;
  if (!coordinator.activate({
    projectId: startingProject.id,
    activationId: startingActivationId,
    persistedRevision: -1,
    headVersion: null,
  })) {
    throw new Error('Failed to activate the initial project persistence context');
  }

  return create<StoreState>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let firstDirtyAt: number | null = null;
  let retryAttempt = 0;
  let initializationPromise: Promise<void> | null = null;
  let initializationFailed = false;
  let nativeCloseFenced = false;
  let erasePromise: Promise<boolean> | null = null;
  const pendingDeleteIds = new Map<string, string>();

  const callRepository = async <T>(
    operation: RepositoryOperation,
    call: () => Promise<RepositoryResult<T>>,
    projectId?: string,
  ): Promise<RepositoryResult<T>> => {
    try {
      return await call();
    } catch {
      return {
        ok: false,
        error: {
          operation,
          code: operation === 'remove' ? 'delete-failed' : 'read-failed',
          retry: 'automatic',
          ...(projectId !== undefined ? { projectId } : {}),
        },
      };
    }
  };

  const runProjectOperation = async (
    operation: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (get().projectOperationBusy) return false;
    set({ projectOperationBusy: true });
    try {
      return await operation();
    } catch {
      set({
        persistenceNotice: {
          kind: 'warning',
          message: 'プロジェクトの処理を完了できませんでした。現在の内容は変更せず保持しています。',
        },
      });
      return false;
    } finally {
      set({ projectOperationBusy: false });
    }
  };

  const clearSaveTimers = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    saveTimer = null;
    maxWaitTimer = null;
    retryTimer = null;
  };

  const eraseFailureMessage =
    'ローカルデータの消去を完了できませんでした。編集や終了は再開せず、「消去を再試行」を選んでください。';
  const closeHandoffUnknownMessage =
    'データ消去は開始していません。アプリの終了要求を送信しましたが、応答を確認できませんでした。終了・消去・閉じる操作を繰り返さず、しばらく待っても終了しない場合はOSからアプリを終了してください。';

  const markNativeCloseHandoffUnknown = (): void => {
    const state = get();
    // A normal close cannot legitimately own the lifecycle once irreversible
    // erase has started. Never replace stronger erase evidence defensively.
    if (state.localDataErase.phase !== 'idle') return;
    clearSaveTimers();
    set({
      projectOperationBusy: true,
      transport: {
        ...state.transport,
        phase: 'stopped',
        isPlaying: false,
        playbackRequestId: state.transport.playbackRequestId + 1,
      },
      localDataErase: {
        phase: 'close-handoff',
        eraseId: null,
        message: closeHandoffUnknownMessage,
      },
    });
  };

  const eraseAllLocalDataNow = (): Promise<boolean> => {
    const phaseAtEntry = get().localDataErase.phase;
    if (
      phaseAtEntry === 'close-handoff' ||
      phaseAtEntry === 'erase-close-pending' ||
      phaseAtEntry === 'erase-close-accepted' ||
      phaseAtEntry === 'erase-close-unknown'
    ) {
      return Promise.resolve(false);
    }
    if (erasePromise) return erasePromise;
    const dependencies = localDataEraseDependencies;
    if (!dependencies) return Promise.resolve(false);
    const claimEraseLifecycle = (): boolean => {
      try {
        return dependencies.tryClaimErase?.() ?? true;
      } catch {
        return false;
      }
    };

    const stateAtCall = get();
    // A project switch/delete may be reconciling a durable head. Never race
    // that reversible cancellation path with the coordinator's permanent seal.
    if (stateAtCall.projectOperationBusy && stateAtCall.localDataErase.phase === 'idle') {
      return Promise.resolve(false);
    }

    const eraseId =
      stateAtCall.localDataErase.eraseId ??
      (dependencies.createEraseId ?? createSecureEraseId)();
    if (!eraseId) {
      set({
        localDataErase: {
          phase: 'idle',
          eraseId: null,
          message:
            '安全な消去IDを作成できませんでした。アプリを再起動してから、もう一度お試しください。',
        },
      });
      return Promise.resolve(false);
    }
    if (!claimEraseLifecycle()) {
      set({
        localDataErase: {
          ...stateAtCall.localDataErase,
          message:
            'アプリの終了処理が進行中のため、消去を開始できませんでした。終了が中止された場合は、この画面から再試行してください。',
        },
      });
      return Promise.resolve(false);
    }

    // Everything below is one-way. The busy flag, timers, renderer fence, and
    // coordinator seal all take effect synchronously before native prepare.
    set((state) => ({
      projectOperationBusy: true,
      transport: {
        ...state.transport,
        phase: 'stopped',
        isPlaying: false,
        playbackRequestId: state.transport.playbackRequestId + 1,
      },
      localDataErase: { phase: 'quiescing', eraseId, message: null },
    }));
    clearSaveTimers();
    let fenceFailed = false;
    try {
      (dependencies.fenceWrites ?? fenceRendererStorageWrites)();
    } catch {
      fenceFailed = true;
    }
    const sealed = coordinator.sealAndWait();

    erasePromise = (async () => {
      try {
        await sealed;
        if (fenceFailed) throw new Error('Renderer write fence failed');
        await dependencies.gateway.prepare(eraseId);
        set({
          localDataErase: {
            phase: 'native-pending',
            eraseId,
            message: '端末データを消去しました。画面側のデータを消去しています。',
          },
        });
        set({
          localDataErase: {
            phase: 'renderer-clearing',
            eraseId,
            message: '画面側のローカルデータを消去しています。',
          },
        });
        await dependencies.clearRendererData();
        await dependencies.gateway.complete(eraseId);
        set({
          localDataErase: {
            phase: 'erase-close-pending',
            eraseId,
            message:
              'すべてのローカルデータを消去しました。アプリの終了要求を送信しています。',
          },
        });
      } catch {
        set({
          projectOperationBusy: true,
          localDataErase: { phase: 'failed', eraseId, message: eraseFailureMessage },
        });
        return false;
      }

      const closeOutcome = await settleNativeCloseHandoff(
        () => dependencies.finishClose({ kind: 'erase', eraseId }),
        dependencies.closeHandoffTimeoutMs,
      );
      if (closeOutcome === 'accepted') {
        set({
          localDataErase: {
            phase: 'erase-close-accepted',
            eraseId,
            message:
              '終了要求を受け付けました。アプリを終了しています。',
          },
        });
        return true;
      }
      set({
        localDataErase: {
          phase: 'erase-close-unknown',
          eraseId,
          message:
            'データは消去済みです。アプリの終了要求を送信しましたが、応答を確認できませんでした。終了・消去・閉じる操作を繰り返さず、しばらく待っても終了しない場合はOSからアプリを終了してください。',
        },
      });
      return false;
    })().finally(() => {
      erasePromise = null;
    });
    return erasePromise;
  };

  const refreshSavedProjectsNow = async (surfaceFailure = true): Promise<boolean> => {
    const result = await callRepository('list', () => repository.list());
    if (result.ok) {
      set({ savedProjects: result.value });
      return true;
    }
    if (surfaceFailure) {
      set({
        persistenceNotice: {
          kind: 'warning',
          message: '保存済みプロジェクトの一覧を読み込めませんでした。保存設定を確認してください。',
        },
      });
    }
    return false;
  };

  const scheduleAutomaticRetry = (): void => {
    if (
      retryTimer !== null ||
      !coordinator.isDirty() ||
      get().localDataErase.phase !== 'idle'
    ) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retryAttempt, 5));
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flushPendingSaveNow();
    }, delay);
  };

  const exposeSaveFailure = (error: Parameters<typeof toSaveFailure>[0]): void => {
    const failure = toSaveFailure(error);
    const state = get();
    set({
      saveState: {
        ...state.saveState,
        phase: 'error',
        failure: failure.code,
        retry: failure.retry,
      },
    });
    if (failure.retry === 'automatic') scheduleAutomaticRetry();
  };

  const exposeCoordinatorConflict = (): void => {
    exposeSaveFailure({
      operation: 'save',
      code: 'conflict',
      retry: 'manual',
      projectId: get().project.id,
    });
  };

  const exposeProtectionFailure = (
    error: Parameters<typeof toSaveFailure>[0],
    activationId: string,
  ): void => {
    const state = get();
    if (
      state.saveState.activationId !== activationId ||
      Math.max(state.saveState.protectedRevision, coordinator.protectedRevision()) >=
        state.saveState.revision
    ) {
      return;
    }
    const failure = toSaveFailure(error);
    set({
      saveState: {
        ...state.saveState,
        phase: 'error',
        failure: failure.code,
        retry: failure.retry,
        protectionFailed: true,
      },
    });
    if (failure.retry === 'automatic') scheduleAutomaticRetry();
  };

  const protectPendingSave = async (activationId: string): Promise<void> => {
    const result = await coordinator.protectLatest();
    if (!result.ok) {
      exposeProtectionFailure(result.error, activationId);
      return;
    }
    const state = get();
    if (state.saveState.activationId !== activationId) return;
    const protectedRevision = Math.max(
      state.saveState.protectedRevision,
      coordinator.protectedRevision(),
      result.value?.revision ?? -1,
    );
    const protectionSatisfied = protectedRevision >= state.saveState.revision;
    const preserveCanonicalFailure =
      state.saveState.phase === 'error' && !state.saveState.protectionFailed;
    set({
      saveState: {
        ...state.saveState,
        protectedRevision,
        phase: preserveCanonicalFailure
          ? 'error'
          : state.saveState.persistedRevision >= state.saveState.revision &&
              !coordinator.isDirty()
            ? 'saved'
            : 'pending',
        failure:
          state.saveState.protectionFailed && protectionSatisfied
            ? null
            : state.saveState.failure,
        retry:
          state.saveState.protectionFailed && protectionSatisfied
            ? null
            : state.saveState.retry,
        protectionFailed:
          state.saveState.protectionFailed && !protectionSatisfied,
      },
    });
  };

  /** Persist the queued immutable snapshot and retain the latest on failure. */
  const flushPendingSaveNow = async (): Promise<boolean> => {
    if (get().localDataErase.phase !== 'idle') return false;
    clearSaveTimers();
    firstDirtyAt = null;
    const activationIdAtCall = get().saveState.activationId;
    const result = await coordinator.flush();
    if (!result.ok) {
      if (get().saveState.activationId === activationIdAtCall) {
        exposeSaveFailure(result.error);
      }
      return false;
    }

    retryAttempt = 0;
    const state = get();
    const receipt = result.value.receipt;
    const canonicalFlushCoversCurrentState = (): boolean => {
      const latest = get();
      if (
        latest.localDataErase.phase !== 'idle' ||
        latest.saveState.activationId !== activationIdAtCall ||
        coordinator.isDirty()
      ) {
        return false;
      }
      return (
        latest.saveState.phase === 'idle' ||
        latest.saveState.persistedRevision >= latest.saveState.revision
      );
    };
    if (receipt === null && !coordinator.isDirty() && state.saveState.phase === 'idle') {
      return canonicalFlushCoversCurrentState();
    }
    if (
      receipt === null &&
      !coordinator.isDirty() &&
      result.value.persistedRevision < state.saveState.revision
    ) {
      return false;
    }
    const stillCurrent =
      state.saveState.activationId === activationIdAtCall &&
      (receipt === null || receipt.activationId === state.saveState.activationId);
    if (stillCurrent) {
      const clean =
        result.value.clean &&
        result.value.persistedRevision >= state.saveState.revision &&
        !coordinator.isDirty();
      set({
        saveState: {
          ...state.saveState,
          phase: clean ? 'saved' : 'pending',
          persistedRevision: Math.max(
            state.saveState.persistedRevision,
            result.value.persistedRevision,
          ),
          protectedRevision: Math.max(
            state.saveState.protectedRevision,
            result.value.persistedRevision,
          ),
          lastSavedAt: receipt?.savedAt ?? state.saveState.lastSavedAt,
          failure: null,
          retry: null,
          protectionFailed: false,
        },
      });
    }
    await refreshSavedProjectsNow(false);
    // list() is deliberately outside the coordinator lock. A new edit can be
    // accepted while that IPC is pending, so close/save callers must recheck
    // the latest activation and revision instead of trusting the older flush.
    return canonicalFlushCoversCurrentState();
  };

  /** Queue the exact edited snapshot, with both idle debounce and max wait. */
  const scheduleSave = (snapshot: Project, revision: number): boolean => {
    const state = get();
    if (state.localDataErase.phase !== 'idle') return false;
    if (!coordinator.markDirty({
      project: snapshot,
      activationId: state.saveState.activationId,
      revision,
    })) {
      exposeCoordinatorConflict();
      return false;
    }
    firstDirtyAt ??= Date.now();

    if (saveTimer !== null) clearTimeout(saveTimer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPendingSaveNow();
    }, SAVE_DEBOUNCE_MS);

    if (maxWaitTimer === null) {
      const remaining = Math.max(0, SAVE_MAX_WAIT_MS - (Date.now() - firstDirtyAt));
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null;
        void flushPendingSaveNow();
      }, remaining);
    }

    set((state) => ({
      saveState: {
        ...state.saveState,
        // A visible failure remains until a confirmed successful retry. New
        // edits update the snapshot but must not make the error disappear.
        phase: state.saveState.failure ? 'error' : 'pending',
        projectId: snapshot.id,
        revision,
        protectionFailed: state.saveState.protectionFailed,
      },
    }));
    if (crashProtectionAvailable) {
      void protectPendingSave(state.saveState.activationId);
    }
    return true;
  };

  const prepareProjectSwitch = async (): Promise<boolean> => {
    while (true) {
      const state = get();
      const requiresFlush =
        coordinator.isDirty() ||
        state.saveState.phase === 'pending' ||
        state.saveState.phase === 'error';
      if (!requiresFlush) return true;
      if (!coordinator.markDirty({
        project: state.project,
        activationId: state.saveState.activationId,
        revision: state.saveState.revision,
      })) {
        exposeCoordinatorConflict();
        return false;
      }
      if (!(await flushPendingSaveNow())) return false;
      const latest = get();
      if (latest.saveState.activationId !== state.saveState.activationId) return false;
      if (latest.saveState.revision === state.saveState.revision && !coordinator.isDirty()) return true;
    }
  };

  const activateProject = (project: Project, loaded: LoadedProject | null): boolean => {
    const activationId = uid('activation');
    const persisted = loaded !== null;
    const expectedHeadVersion = expectedHeadForLoaded(loaded);
    if (!coordinator.activate({
      projectId: project.id,
      activationId,
      persistedRevision: persisted ? 0 : -1,
      ...(expectedHeadVersion !== undefined ? { headVersion: expectedHeadVersion } : {}),
    })) {
      exposeCoordinatorConflict();
      return false;
    }
    clearSaveTimers();
    firstDirtyAt = null;
    retryAttempt = 0;
    set({
      project,
      editor: makeEditor(project),
      // Invalidate any audio startup that belongs to the previous project.
      // Never recycle request IDs: a stale async completion must not match a
      // later play attempt after a project switch.
      transport: makeTransport(get().transport.playbackRequestId + 1),
      past: [],
      future: [],
      saveState: makeSaveState(
        project,
        activationId,
        persisted,
        crashProtectionAvailable,
      ),
    });
    return true;
  };

  /** Save a newly activated in-memory project immediately and expose failure. */
  const persistActivatedProject = async (project: Project): Promise<boolean> => {
    const state = get();
    if (!coordinator.markDirty({
      project,
      activationId: state.saveState.activationId,
      revision: state.saveState.revision,
    })) {
      exposeCoordinatorConflict();
      return false;
    }
    firstDirtyAt = Date.now();
    set((current) => ({
      saveState: {
        ...current.saveState,
        phase: 'pending',
      },
    }));
    await flushPendingSaveNow();
    // The activation transition itself succeeded even if durability did not.
    // Callers keep the new/imported project visible and inspect saveState to
    // tell the user it still needs retry or emergency export.
    return true;
  };

  const initializePersistenceNow = async (): Promise<boolean> => {
    if (get().localDataErase.phase !== 'idle') return false;
    const preserveCurrentEdits = initializationFailed && get().saveState.revision > 0;
    const initialized = await callRepository('initialize', () => repository.initialize());
    if (!initialized.ok) {
      initializationFailed = true;
      exposeSaveFailure(initialized.error);
      set({
        persistenceReady: true,
        // SaveControl already exposes the same failure as one assertive alert
        // with retry/export actions. Avoid mounting a competing alert here.
        persistenceNotice: null,
      });
      return false;
    }
    initializationFailed = false;

    const listed = await callRepository('list', () => repository.list());
    if (listed.ok) set({ savedProjects: listed.value });
    if (preserveCurrentEdits) {
      // A user may edit the in-memory project after a failed startup. Retrying
      // repository initialization must not replace those edits with an older
      // saved project; saveToLocalStorage() will persist this active snapshot.
      set({ persistenceReady: true });
      return true;
    }
    const restored = await callRepository('load', () => repository.loadMostRecent());
    if (!restored.ok) {
      set({
        persistenceReady: true,
        persistenceNotice: {
          kind: 'warning',
          message:
            restored.error.code === 'unsupported-version'
              ? '新しいバージョンで作成されたプロジェクトがあります。データは変更せず保持しています。'
              : restored.error.code === 'conflict'
                ? '複数画面で編集された未保存内容が競合しています。どちらも削除せず保持しています。'
              : '保存データの一部を読み込めませんでした。破損したデータは削除せず保持しています。',
        },
      });
      return true;
    }

    if (restored.value) {
      if (!activateProject(restored.value.project, restored.value)) {
        set({
          persistenceReady: true,
          persistenceNotice: {
            kind: 'warning',
            message: '保存データを安全に有効化できませんでした。元データは変更せず保持しています。',
          },
        });
        return true;
      }
      if (restored.value.recovered) {
        const recoveredTitle = restored.value.project.title || '名称未設定';
        set({
          persistenceNotice: {
            kind: 'recovered',
            message: `「${recoveredTitle}」を検証済みの保存世代から復元しました。`,
          },
        });
        // Repair a missing/corrupt/stale head only after the recovered bytes
        // have passed the canonical decoder.
        if (!(await persistActivatedProject(restored.value.project))) {
          set({ persistenceReady: true });
          return true;
        }
      }
    }
    set({ persistenceReady: true });
    await refreshSavedProjectsNow(false);
    return true;
  };

  /** Publish the effective scale-snap setting after its state is committed. */
  const publishScaleSnapStateIfEnabled = (): void => {
    const state = get();
    if (!state.editor.scaleSnap) return;
    publishAppEvent({
      type: 'scale_snap.enabled',
      payload: { key: state.project.key, scale: state.project.scale },
    });
  };

  /** Apply an immutable project change: bump updatedAt, push history, save. */
  const commitProject = (next: Project): boolean => {
    if (get().projectOperationBusy) return false;
    const current = get().project;
    if (next === current) return true;
    const stamped: Project = { ...next, updatedAt: nowIso() };
    const encoded = encodeProjectJson(stamped);
    if (!encoded.ok) {
      // This candidate was never adopted or sent to the repository. Keep the
      // durability state of the current valid project intact; a rejected edit
      // is not a failed save of the project the user still has on screen.
      set({
        persistenceNotice: {
          kind: 'warning',
          message:
            encoded.error.code === 'too-large'
              ? 'この変更を加えるとプロジェクトの保存上限を超えるため、反映しませんでした。現在の内容はそのままです。'
              : encoded.error.code === 'serialization-failed'
                ? 'この変更を安全な保存形式へ変換できないため、反映しませんでした。現在の内容はそのままです。'
                : 'この変更はプロジェクトの範囲外になるため、反映しませんでした。現在の内容はそのままです。',
        },
      });
      return false;
    }
    const past = [...get().past, current].slice(-HISTORY_CAP);
    const revision = get().saveState.revision + 1;
    if (!scheduleSave(stamped, revision)) return false;
    set((state) => ({
      project: stamped,
      past,
      future: [],
      editor: reconcileEditorSelection(state.editor, stamped),
    }));
    if (stamped.key !== current.key || stamped.scale !== current.scale) {
      publishScaleSnapStateIfEnabled();
    }
    return true;
  };

  return {
    project: startingProject,
    transport: makeTransport(),
    editor: makeEditor(startingProject),
    tutorialPanelOpen: false,
    inspector: { content: null },
    saveState: makeSaveState(
      startingProject,
      startingActivationId,
      false,
      crashProtectionAvailable,
    ),
    persistenceReady: false,
    projectOperationBusy: false,
    localDataErase: { phase: 'idle', eraseId: null, message: null },
    persistenceNotice: null,
    savedProjects: [],
    past: [],
    future: [],

    applyProjectChange: (fn) => commitProject(fn(get().project)),

    // --- project metadata ---
    setBpm: (bpm) => {
      const current = get().project;
      const bounded = Number.isFinite(bpm) ? Math.min(300, Math.max(20, bpm)) : current.bpm;
      commitProject({ ...current, bpm: bounded });
    },
    setKey: (key) => {
      if (get().project.key === key) return;
      commitProject({ ...get().project, key });
    },
    setScale: (scale) => {
      if (get().project.scale === scale) return;
      commitProject({ ...get().project, scale });
    },
    setTitle: (title) => commitProject({ ...get().project, title }),

    // --- chords ---
    addChord: (symbol, startBeat, durationBeats) => {
      const isMinor = /m(?!aj)/i.test(symbol);
      const root = symbol.replace(/maj7|m7|dim|aug|m|7/gi, '') || symbol;
      const chord: ChordEvent = {
        id: uid('chord'),
        startBeat,
        durationBeats,
        symbol,
        root,
        quality: isMinor ? 'minor' : 'major',
        notes: [],
      };
      const project = get().project;
      commitProject({ ...project, chordTrack: [...project.chordTrack, chord] });
    },
    updateChord: (id, patch) => {
      const project = get().project;
      commitProject({
        ...project,
        chordTrack: project.chordTrack.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      });
    },
    removeChord: (id) => {
      const project = get().project;
      commitProject({
        ...project,
        chordTrack: project.chordTrack.filter((c) => c.id !== id),
      });
    },

    // --- notes ---
    addNote: (clipId, note) => {
      const project = get().project;
      const track = trackOfClip(project, clipId);
      const ownerId = clipContentOwnerId(project, clipId);
      if (!track || !ownerId) return;
      const newNote: NoteEvent = {
        id: note.id ?? uid('note'),
        pitch: note.pitch,
        startBeat: note.startBeat,
        durationBeats: note.durationBeats,
        velocity: note.velocity,
      };
      const committed = commitProject(
        mapTracks(project, (t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === ownerId ? { ...c, notes: [...(c.notes ?? []), newNote] } : c,
          ),
        })),
      );
      if (!committed) return;
      publishAppEvent({
        type: 'note.added',
        payload: {
          pitch: newNote.pitch,
          startBeat: newNote.startBeat,
          durationBeats: newNote.durationBeats,
          trackId: track?.id ?? '',
          trackName: track?.name ?? '',
          inScale: pitchInScale(project, newNote.pitch),
        },
      });
    },
    updateNote: (clipId, noteId, patch) => {
      const project = get().project;
      const track = trackOfClip(project, clipId);
      const instance = findProjectClip(project, clipId)?.clip;
      const effective = instance ? resolveClipContent(project, instance) : null;
      const ownerId = clipContentOwnerId(project, clipId);
      const current = effective?.notes?.find((note) => note.id === noteId);
      if (!track || !ownerId || !current) return;
      const updated = { ...current, ...patch };
      if (
        updated.pitch === current.pitch &&
        updated.startBeat === current.startBeat &&
        updated.durationBeats === current.durationBeats &&
        updated.velocity === current.velocity
      ) {
        return;
      }
      const committed = commitProject(
        mapTracks(project, (t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === ownerId
              ? { ...c, notes: (c.notes ?? []).map((n) => (n.id === noteId ? updated : n)) }
              : c,
          ),
        })),
      );
      if (
        !committed ||
        (updated.pitch === current.pitch && updated.startBeat === current.startBeat)
      ) {
        return;
      }
      publishAppEvent({
        type: 'note.moved',
        payload: {
          pitch: updated.pitch,
          startBeat: updated.startBeat,
          trackId: track.id,
          trackName: track.name,
        },
      });
    },
    removeNote: (clipId, noteId) => {
      const project = get().project;
      const ownerId = clipContentOwnerId(project, clipId);
      if (!ownerId) return;
      commitProject(
        mapTracks(project, (t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === ownerId
              ? { ...c, notes: (c.notes ?? []).filter((n) => n.id !== noteId) }
              : c,
          ),
        })),
      );
    },

    // --- drums ---
    toggleDrumStep: (clipId, lane, stepIndex) => {
      const project = get().project;
      const track = trackOfClip(project, clipId);
      const instance = findProjectClip(project, clipId)?.clip;
      const effective = instance ? resolveClipContent(project, instance) : null;
      const ownerId = clipContentOwnerId(project, clipId);
      if (!track || !ownerId) return false;
      const prevEvents = effective?.drumEvents ?? [];
      const wasActive = prevEvents.some((e) => e.lane === lane && e.stepIndex === stepIndex);
      const committed = commitProject(
        mapTracks(project, (t) => ({
          ...t,
          clips: t.clips.map((c) => {
            if (c.id !== ownerId) return c;
            const events = c.drumEvents ?? [];
            const existing = events.find((e) => e.lane === lane && e.stepIndex === stepIndex);
            if (existing) {
              return { ...c, drumEvents: events.filter((e) => e !== existing) };
            }
            const newEvent: DrumEvent = {
              id: uid('drum'),
              lane,
              stepIndex,
              velocity: 100,
            };
            return { ...c, drumEvents: [...events, newEvent] };
          }),
        })),
      );
      if (!committed) return false;
      publishAppEvent({
        type: 'drum.stepToggled',
        payload: { lane, stepIndex, active: !wasActive, trackId: track.id },
      });
      return true;
    },

    // --- mixer ---
    setTrackVolume: (trackId, volume) => {
      const project = get().project;
      const track = project.tracks.find((t) => t.id === trackId);
      if (
        !track ||
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > 2 ||
        track.volume === volume
      ) {
        return;
      }
      const committed = commitProject(
        mapTracks(project, (candidate) =>
          candidate.id === trackId ? { ...candidate, volume } : candidate,
        ),
      );
      if (!committed) return;
      const adoptedTrack = get().project.tracks.find((candidate) => candidate.id === trackId);
      if (!adoptedTrack) return;
      publishAppEvent({
        type: 'track.volumeChanged',
        payload: {
          trackId: adoptedTrack.id,
          trackName: adoptedTrack.name,
          volume: adoptedTrack.volume,
        },
      });
    },
    setTrackPan: (trackId, pan) => {
      const project = get().project;
      commitProject(mapTracks(project, (t) => (t.id === trackId ? { ...t, pan } : t)));
    },
    toggleMute: (trackId) => {
      const project = get().project;
      commitProject(mapTracks(project, (t) => (t.id === trackId ? { ...t, mute: !t.mute } : t)));
    },
    toggleSolo: (trackId) => {
      const project = get().project;
      commitProject(mapTracks(project, (t) => (t.id === trackId ? { ...t, solo: !t.solo } : t)));
    },

    // --- selection (UI only) ---
    selectTrack: (trackId) => set((s) => ({ editor: { ...s.editor, selectedTrackId: trackId } })),
    selectClip: (clipId) => set((s) => ({ editor: { ...s.editor, selectedClipId: clipId } })),
    selectChord: (chordId) => set((s) => ({ editor: { ...s.editor, selectedChordId: chordId } })),
    selectNotes: (noteIds) => set((s) => ({ editor: { ...s.editor, selectedNoteIds: noteIds } })),

    // --- editor toggles (UI only) ---
    setActiveView: (view) => set((s) => ({ editor: { ...s.editor, activeView: view } })),
    toggleScaleSnap: () => {
      const enabled = !get().editor.scaleSnap;
      set((state) => ({ editor: { ...state.editor, scaleSnap: enabled } }));
      if (enabled) publishScaleSnapStateIfEnabled();
    },
    toggleChordToneHighlight: () =>
      set((s) => ({ editor: { ...s.editor, chordToneHighlight: !s.editor.chordToneHighlight } })),
    setZoomX: (zoomX) => set((s) => ({ editor: { ...s.editor, zoomX } })),
    toggleTutorialPanel: () => set((s) => ({ tutorialPanelOpen: !s.tutorialPanelOpen })),
    setInspectorContent: (content) => set({ inspector: { content } }),

    // --- transport ---
    play: () => {
      const state = get();
      if (state.projectOperationBusy || state.transport.phase !== 'stopped') return;
      const projectLength = transportProjectLengthBeats(state.project);
      const positionBeat =
        projectLength > 0 &&
        Number.isFinite(state.transport.positionBeat) &&
        state.transport.positionBeat >= 0 &&
        state.transport.positionBeat < projectLength
          ? state.transport.positionBeat
          : 0;
      set({
        transport: {
          ...state.transport,
          phase: 'starting',
          isPlaying: false,
          playbackRequestId: state.transport.playbackRequestId + 1,
          audioIssue: null,
          positionBeat,
        },
      });
    },
    confirmPlaybackStarted: (requestId) => {
      const state = get();
      if (
        state.transport.phase !== 'starting' ||
        state.transport.playbackRequestId !== requestId
      ) {
        return;
      }
      const positionBeats = state.transport.positionBeat;
      set({
        transport: {
          ...state.transport,
          phase: 'playing',
          isPlaying: true,
          audioIssue: null,
        },
      });
      publishAppEvent({
        type: 'transport.played',
        payload: { positionBeats },
      });
    },
    failPlaybackStart: (requestId, issue = 'start-failed') => {
      const state = get();
      if (
        state.transport.phase !== 'starting' ||
        state.transport.playbackRequestId !== requestId
      ) {
        return;
      }
      set({
        transport: {
          ...state.transport,
          phase: 'stopped',
          isPlaying: false,
          playbackRequestId: state.transport.playbackRequestId + 1,
          audioIssue: issue,
        },
      });
    },
    interruptPlayback: (requestId) => {
      const state = get();
      if (
        state.transport.phase === 'stopped' ||
        state.transport.playbackRequestId !== requestId
      ) {
        return;
      }
      set({
        transport: {
          ...state.transport,
          phase: 'stopped',
          isPlaying: false,
          playbackRequestId: state.transport.playbackRequestId + 1,
          audioIssue: 'interrupted',
        },
      });
    },
    finishPlayback: (requestId) => {
      const state = get();
      if (
        state.transport.phase !== 'playing' ||
        state.transport.playbackRequestId !== requestId
      ) {
        return;
      }
      set({
        transport: {
          ...state.transport,
          phase: 'stopped',
          isPlaying: false,
          playbackRequestId: state.transport.playbackRequestId + 1,
          positionBeat: 0,
        },
      });
    },
    clearAudioIssue: () =>
      set((state) => ({
        transport: { ...state.transport, audioIssue: null },
      })),
    stop: (reset) =>
      set((s) => {
        // Starting/playing -> pause (keep position) unless an explicit reset
        // is asked. Already stopped -> rewind to 0.
        const shouldReset = reset === true || s.transport.phase === 'stopped';
        return {
          transport: {
            ...s.transport,
            phase: 'stopped',
            isPlaying: false,
            playbackRequestId: s.transport.playbackRequestId + 1,
            positionBeat: shouldReset ? 0 : s.transport.positionBeat,
          },
        };
      }),
    setPosition: (beat) => set((s) => ({ transport: { ...s.transport, positionBeat: beat } })),
    toggleLoop: () =>
      set((s) => {
        const projectLength = transportProjectLengthBeats(s.project);
        const bounds = safeLoopBounds(
          s.transport.loopStartBeat,
          s.transport.loopEndBeat,
          projectLength,
        );
        const supersedesPlayback = s.transport.phase !== 'stopped';

        return {
          transport: {
            ...s.transport,
            phase: supersedesPlayback ? 'starting' : s.transport.phase,
            isPlaying: supersedesPlayback ? false : s.transport.isPlaying,
            playbackRequestId: supersedesPlayback
              ? s.transport.playbackRequestId + 1
              : s.transport.playbackRequestId,
            audioIssue: supersedesPlayback ? null : s.transport.audioIssue,
            positionBeat: safeTransportPosition(
              s.transport.positionBeat,
              projectLength,
            ),
            loopEnabled: !s.transport.loopEnabled,
            loopStartBeat: bounds.startBeat,
            loopEndBeat: bounds.endBeat,
          },
        };
      }),
    toggleMetronome: () =>
      set((s) => ({ transport: { ...s.transport, metronome: !s.transport.metronome } })),

    // --- history ---
    undo: () => {
      if (get().projectOperationBusy) return;
      const { past, project, future } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      const restored = { ...previous, updatedAt: nowIso() };
      const revision = get().saveState.revision + 1;
      if (!scheduleSave(restored, revision)) return;
      set((state) => ({
        project: restored,
        past: past.slice(0, -1),
        future: [project, ...future].slice(0, HISTORY_CAP),
        editor: reconcileEditorSelection(state.editor, restored),
      }));
      if (restored.key !== project.key || restored.scale !== project.scale) {
        publishScaleSnapStateIfEnabled();
      }
    },
    redo: () => {
      if (get().projectOperationBusy) return;
      const { past, project, future } = get();
      const next = future[0];
      if (!next) return;
      const restored = { ...next, updatedAt: nowIso() };
      const revision = get().saveState.revision + 1;
      if (!scheduleSave(restored, revision)) return;
      set((state) => ({
        project: restored,
        past: [...past, project].slice(-HISTORY_CAP),
        future: future.slice(1),
        editor: reconcileEditorSelection(state.editor, restored),
      }));
      if (restored.key !== project.key || restored.scale !== project.scale) {
        publishScaleSnapStateIfEnabled();
      }
    },
    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    // --- persistence ---
    initializePersistence: () => {
      if (get().localDataErase.phase !== 'idle') return Promise.resolve();
      initializationPromise ??= initializePersistenceNow().then((initialized) => {
        // Keep a successful bootstrap single-flight for the app lifetime, but
        // allow the explicit save retry to rerun a failed native migration.
        if (!initialized) initializationPromise = null;
      });
      return initializationPromise;
    },
    saveToLocalStorage: async () => {
      if (initializationFailed) {
        await get().initializePersistence();
        if (initializationFailed) return false;
      }
      const state = get();
      if (state.projectOperationBusy) return false;
      if (!coordinator.markDirty({
        project: state.project,
        activationId: state.saveState.activationId,
        revision: state.saveState.revision,
      })) {
        exposeCoordinatorConflict();
        return false;
      }
      firstDirtyAt ??= Date.now();
      set({ saveState: { ...state.saveState, phase: 'pending' } });
      return flushPendingSaveNow();
    },
    flushPendingSave: () =>
      get().localDataErase.phase === 'idle'
        ? flushPendingSaveNow()
        : Promise.resolve(false),
    flushPendingSaveSynchronously: () => {
      if (get().localDataErase.phase !== 'idle') return false;
      clearSaveTimers();
      const result = coordinator.flushSynchronously();
      if (!result.ok) {
        exposeSaveFailure(result.error);
        return false;
      }
      const state = get();
      const receipt = result.value.receipt;
      const recoveryReceipt = result.value.recoveryReceipt;
      const recoveryProtected =
        recoveryReceipt !== null &&
        recoveryReceipt.projectId === state.project.id &&
        recoveryReceipt.activationId === state.saveState.activationId &&
        recoveryReceipt.revision >= state.saveState.revision;
      if (
        receipt === null &&
        result.value.recoveryReceipt === null &&
        result.value.persistedRevision < state.saveState.revision
      ) {
        // A no-op sync flush must not erase an existing degraded/error state or
        // claim that an unsaved revision became durable.
        return false;
      }
      if (receipt === null && state.saveState.phase === 'idle') return true;
      if (receipt === null || receipt.activationId === state.saveState.activationId) {
        const preserveFailure = state.saveState.phase === 'error';
        set({
          saveState: {
            ...state.saveState,
            phase: preserveFailure
              ? 'error'
              : result.value.clean && result.value.persistedRevision >= state.saveState.revision
                ? 'saved'
                : 'pending',
            persistedRevision: Math.max(
              state.saveState.persistedRevision,
              result.value.persistedRevision,
            ),
            protectedRevision: Math.max(
              state.saveState.protectedRevision,
              coordinator.protectedRevision(),
              recoveryReceipt?.revision ?? -1,
            ),
            lastSavedAt: receipt?.savedAt ?? state.saveState.lastSavedAt,
            failure: preserveFailure ? state.saveState.failure : null,
            retry: preserveFailure ? state.saveState.retry : null,
            protectionFailed: recoveryProtected ? false : state.saveState.protectionFailed,
          },
        });
      }
      // A verified recovery journal is not a canonical clean save, but it is
      // durable enough for the native close contract and will be promoted on
      // the next bootstrap through normal locked repository I/O.
      return result.value.clean || recoveryProtected;
    },
    tryBeginNativeClose: () => {
      const state = get();
      if (
        nativeCloseFenced ||
        state.projectOperationBusy ||
        state.localDataErase.phase !== 'idle'
      ) {
        return false;
      }
      nativeCloseFenced = true;
      set({ projectOperationBusy: true });
      return true;
    },
    cancelNativeClose: () => {
      if (!nativeCloseFenced) return;
      nativeCloseFenced = false;
      if (get().localDataErase.phase === 'idle') {
        set({ projectOperationBusy: false });
      }
    },
    refreshSavedProjects: () => refreshSavedProjectsNow(),
    listSavedProjects: () => get().savedProjects,
    createNewProject: (title) => runProjectOperation(async () => {
      if (!(await prepareProjectSwitch())) return false;
      // A user-requested new project is genuinely blank. The richer
      // createDefaultProject() fixture remains the unsaved first-launch
      // preview, while templates are activated through replaceProject().
      const project = createEmptyProject({ title: title ?? '新しい曲' });
      if (!activateProject(project, null)) return false;
      if (!(await persistActivatedProject(project))) return false;
      publishAppEvent({
        type: 'project.created',
        payload: { key: project.key, bpm: project.bpm },
      });
      return true;
    }),
    loadProjectById: (id) => runProjectOperation(async () => {
      if (!(await prepareProjectSwitch())) return false;
      // Flush first, then read. This matters when the active project itself is
      // selected: reading before the flush would reactivate its stale version.
      const loaded = await callRepository('load', () => repository.load(id), id);
      if (!loaded.ok || !loaded.value) {
        if (!loaded.ok) {
          set({
            persistenceNotice: {
              kind: 'warning',
              message:
                loaded.error.code === 'unsupported-version'
                  ? 'このプロジェクトは新しいバージョンで作成されているため開けません。'
                  : 'プロジェクトを安全に読み込めませんでした。元データは変更していません。',
            },
          });
        }
        return false;
      }
      if (!activateProject(loaded.value.project, loaded.value)) return false;
      if (loaded.value.recovered) {
        set({
          persistenceNotice: {
            kind: 'recovered',
            message: `「${loaded.value.project.title || '名称未設定'}」を検証済みの保存世代から復元しました。`,
          },
        });
        if (!(await persistActivatedProject(loaded.value.project))) return false;
      }
      return true;
    }),
    recoverProjectBranch: (projectId, branchId) => runProjectOperation(async () => {
      if (!(await prepareProjectSwitch())) return false;
      if (!repository.loadProjectBranch) {
        set({
          persistenceNotice: {
            kind: 'warning',
            message: 'この保存方式では未保存分岐を開けません。元データは変更せず保持しています。',
          },
        });
        return false;
      }
      const loaded = await callRepository(
        'load',
        () => repository.loadProjectBranch!(projectId, branchId),
        projectId,
      );
      if (!loaded.ok || !loaded.value) {
        set({
          persistenceNotice: {
            kind: 'warning',
            message: '未保存分岐を安全に読み込めませんでした。元データは変更していません。',
          },
        });
        return false;
      }
      const timestamp = nowIso();
      const baseTitle = loaded.value.project.title || '復元プロジェクト';
      const copy: Project = {
        ...loaded.value.project,
        id: uid('project'),
        title: `${baseTitle}（復元コピー）`.slice(0, 4_096),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (!activateProject(copy, null)) return false;
      await persistActivatedProject(copy);
      const saveFailed = get().saveState.phase === 'error';
      set({
        persistenceNotice: {
          kind: saveFailed ? 'warning' : 'recovered',
          message: saveFailed
            ? `「${baseTitle}」の未保存分岐を画面上のコピーとして開きましたが、端末にはまだ保存できていません。バックアップを書き出してください。`
            : `「${baseTitle}」の未保存分岐を新しいコピーとして開きました。元データも保持しています。`,
        },
      });
      publishAppEvent({
        type: 'project.created',
        payload: { key: copy.key, bpm: copy.bpm },
      });
      return true;
    }),
    replaceProject: (project) => runProjectOperation(async () => {
      const decoded = decodeProject(project);
      if (!decoded.ok) return false;
      if (!(await prepareProjectSwitch())) return false;
      const stamped = { ...decoded.project, updatedAt: nowIso() };
      const existing = await callRepository('load', () => repository.load(stamped.id), stamped.id);
      if (!existing.ok) {
        set({
          persistenceNotice: {
            kind: 'warning',
            message: '同じIDの保存データを安全に確認できないため、読み込みを中止しました。',
          },
        });
        return false;
      }
      if (!activateProject(stamped, existing.value)) return false;
      if (!(await persistActivatedProject(stamped))) return false;
      publishAppEvent({
        type: 'project.created',
        payload: { key: stamped.key, bpm: stamped.bpm },
      });
      return true;
    }),
    deleteProject: (id) => runProjectOperation(async () => {
      const active = get();
      const deletingActive = active.project.id === id;
      let expectedHeadVersion: string | null | undefined;
      let cancelledSave: Awaited<ReturnType<typeof coordinator.cancelAndWait>> | null = null;
      if (deletingActive) {
        clearSaveTimers();
        cancelledSave = await coordinator.cancelAndWait(id, active.saveState.activationId);
        if (!cancelledSave.ok) {
          exposeSaveFailure(cancelledSave.error);
          return false;
        }
        expectedHeadVersion = cancelledSave.value.headVersion;
      } else {
        const existing = await callRepository('load', () => repository.load(id), id);
        if (existing.ok) {
          expectedHeadVersion = expectedHeadForLoaded(existing.value);
        } else if (existing.error.code === 'read-failed') {
          set({
            persistenceNotice: {
              kind: 'warning',
              message: '削除前に保存データを確認できませんでした。データは変更していません。',
            },
          });
          return false;
        }
      }
      const deleteId = pendingDeleteIds.get(id) ?? uid('delete');
      pendingDeleteIds.set(id, deleteId);
      const removed = await callRepository(
        'remove',
        () => repository.remove({ projectId: id, deleteId, expectedHeadVersion }),
        id,
      );
      const removalMatches =
        removed.ok && removed.value.projectId === id && removed.value.deleteId === deleteId;
      if (!removed.ok || !removalMatches) {
        if (deletingActive) {
          // The deletion did not commit. Reactivate the still-visible project so
          // subsequent edits/saves remain possible.
          const state = get();
          const persistedRevision = cancelledSave?.ok
            ? cancelledSave.value.persistedRevision
            : state.saveState.persistedRevision;
          const reactivated = coordinator.activate({
            projectId: state.project.id,
            activationId: state.saveState.activationId,
            persistedRevision,
            headVersion: expectedHeadVersion,
          });
          if (!reactivated) {
            exposeCoordinatorConflict();
            return false;
          }
          const lastSavedAt = cancelledSave?.ok
            ? (cancelledSave.value.receipt?.savedAt ?? state.saveState.lastSavedAt)
            : state.saveState.lastSavedAt;
          set({
            saveState: {
              ...state.saveState,
              persistedRevision,
              lastSavedAt,
              phase: state.saveState.revision <= persistedRevision ? 'saved' : 'pending',
              failure: null,
              retry: null,
            },
          });
          if (state.saveState.revision > persistedRevision) {
            if (!scheduleSave(state.project, state.saveState.revision)) return false;
          }
        }
        set({
          persistenceNotice: {
            kind: 'warning',
            message: 'プロジェクトを安全に削除できませんでした。データは残しています。',
          },
        });
        return false;
      }
      pendingDeleteIds.delete(id);
      const cleanupIncomplete = removed.ok && !removed.value.cleanupComplete;
      // If the active project was deleted, switch to the most recent saved one
      // or a fresh default so the UI always has a project to render.
      if (deletingActive) {
        const restoredFallback = await callRepository('load', () => repository.loadMostRecent());
        if (restoredFallback.ok && restoredFallback.value) {
          if (!activateProject(restoredFallback.value.project, restoredFallback.value)) return false;
          if (
            restoredFallback.value.recovered &&
            !(await persistActivatedProject(restoredFallback.value.project))
          ) {
            return false;
          }
        } else {
          if (!activateProject(createDefaultProject(), null)) return false;
        }
      }
      await refreshSavedProjectsNow(false);
      if (cleanupIncomplete) {
        set({
          persistenceNotice: {
            kind: 'warning',
            message:
              'プロジェクトは削除しましたが、一部の退避データを消去できませんでした。保存一覧を再確認してください。',
          },
        });
      }
      return true;
    }),
    clearPersistenceNotice: () => set({ persistenceNotice: null }),
    eraseAllLocalData: eraseAllLocalDataNow,
    markNativeCloseHandoffUnknown,
  };
  });
}

export type StudioStore = ReturnType<typeof createStudioStore>;
export const useStore = createStudioStore();

/** Async composition-root bootstrap. React mounts only after this resolves. */
export function initializeStudioStore(): Promise<void> {
  return useStore.getState().initializePersistence();
}
