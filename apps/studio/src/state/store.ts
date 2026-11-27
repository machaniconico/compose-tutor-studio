// Central Zustand store for Compose Tutor Studio.
//
// Holds the project, transport, editor UI state, panel state, and an
// undo/redo history of project snapshots. Project mutations always bump
// `updatedAt`, push history, and schedule a debounced localStorage save.
// Inside a transaction (one drag, one slider gesture, one text edit) mutations
// only update the current value; the commit adds a single undo step.

import { create } from 'zustand';
import type {
  ChordEvent,
  Clip,
  DrumEvent,
  DrumLane,
  MusicalKey,
  NoteEvent,
  Project,
  ScaleName,
  Track,
  TrackRole,
} from '@cts/project-model';
import {
  addReverbReturn as addProjectReverbReturn,
  addTrack as addProjectTrack,
  beatsPerBar as beatsPerBarOf,
  contentBeyondBars,
  duplicateTrack as duplicateProjectTrack,
  findProjectSoundingLimitProblem,
  MAX_RETURN_TRACKS,
  moveTrack as moveProjectTrack,
  removeTrack as removeProjectTrack,
  renameTrack as renameProjectTrack,
  setLengthBars as setProjectLengthBars,
  setLoopRange as setProjectLoopRange,
  setTimeSignature as setProjectTimeSignature,
  setTrackColor as setProjectTrackColor,
  setTrackSend as setProjectTrackSend,
} from '@cts/project-model';
import { getScalePitchClasses } from '@cts/theory-engine';
import { createDefaultProject } from './defaultProject';
import { nowIso, uid } from './ids';
import { publishAppEvent, type ProjectEditEvent } from './appEvents';
import { pushToast } from './tutorialBridge';
import { DEFAULT_KEYBOARD_OCTAVE } from '../features/input/keyboardMap';
import type { NoteColorMode } from '../features/pianoRoll/noteColor';
import {
  deleteProject as deleteStoredProject,
  listSavedProjects,
  loadMostRecentProject,
  loadProject as loadStoredProject,
  saveProject,
  type ProjectSummary,
} from './persistence';

export type EditorView = 'pianoRoll' | 'drums' | 'arranger' | 'arrange';

export type Difficulty = 'beginner' | 'standard' | 'advanced';

/** Right-hand panel tabs (lifted from InspectorPanel so other features can switch tabs). */
export type RightPanelTab = 'inspector' | 'assistant' | 'tutorial';

export type TransportState = {
  isPlaying: boolean;
  positionBeat: number;
  /** Loop on/off. The looped beats live in `project.loopRange` (see `activeLoopRange`). */
  loopEnabled: boolean;
  metronome: boolean;
};

export type EditorState = {
  activeView: EditorView;
  selectedTrackId: string | null;
  selectedClipId: string | null;
  selectedChordId: string | null;
  selectedNoteIds: string[];
  scaleSnap: boolean;
  liveInputEnabled: boolean;
  liveInputOctave: number;
  liveInputScaleLock: boolean;
  gridSnap: number;
  chordToneHighlight: boolean;
  /** ピアノロールで他トラックのゴーストノートを隠すトラック ID(UI 状態。保存しない)。 */
  ghostHiddenTrackIds: string[];
  /** ピアノロールのノート色分け(UI 状態。保存しない)。 */
  noteColorMode: NoteColorMode;
  /** ピアノロールでノートを置いたときに短く試聴する(既定オン)。 */
  previewOnPlace: boolean;
  zoomX: number;
  /** 難易度モード。beginner=平易表示, standard=標準, advanced=詳細表示。 */
  difficulty: Difficulty;
};

export type SaveState = {
  status: 'idle' | 'saving' | 'saved' | 'error';
  lastSavedAt: string | null;
  errorMessage: string | null;
};

const HISTORY_CAP = 100;
const SAVE_DEBOUNCE_MS = 2000;
const SAVE_FAILURE_MESSAGE =
  '保存に失敗しました。ブラウザの保存容量が不足している可能性があります。不要なプロジェクトを削除してからもう一度保存してください。';

type NotePatch = Partial<Omit<NoteEvent, 'id'>>;
export type NoteEditOptions = { extendClip?: boolean };

/** A copied note; `startBeat` counts from the first copied note (0). */
export type ClipboardNote = Omit<NoteEvent, 'id'>;

type StoreState = {
  project: Project;
  /** Changes when a project is opened or created, even if its ID is reused. */
  projectOpenVersion: number;
  transport: TransportState;
  editor: EditorState;
  save: SaveState;
  tutorialPanelOpen: boolean;
  /**
   * Whether the launch start screen is visible. Starts true on every app
   * launch; closed by any of the start-screen entry actions.
   */
  startScreenOpen: boolean;
  /** Which tab the right-hand panel shows (inspector / assistant / tutorial). */
  rightPanelTab: RightPanelTab;
  /** Free-form inspector content state (e.g. selected chord summary). */
  inspector: { content: string | null };
  /** Notes copied in the piano roll (in memory only; never the OS clipboard or the saved file). */
  noteClipboard: ClipboardNote[];
  setNoteClipboard: (notes: ClipboardNote[]) => void;

  // history
  past: Project[];
  future: Project[];
  /** Project as it was when the open transaction began; null when none is open. */
  transactionBase: Project | null;

  /** Generic escape hatch: apply an immutable project change (bumps updatedAt, pushes history, saves). */
  applyProjectChange: (fn: (p: Project) => Project, event?: ProjectEditEvent) => boolean;

  // project metadata actions
  setBpm: (bpm: number) => void;
  setKey: (key: MusicalKey) => void;
  setScale: (scale: ScaleName) => void;
  setTitle: (title: string) => void;
  /**
   * Change the time signature, keeping every beat position (one undo step).
   * When the coarser drum grid would merge two hits into one and `confirmed`
   * is false, nothing changes and `confirm` holds a Japanese question instead.
   * Once applied, `confirm` is null and `warnings` lists beginner-facing notes
   * about content that had to be snapped or merged.
   */
  setTimeSignature: (
    timeSignature: [number, number],
    confirmed?: boolean,
  ) => { confirm: string | null; warnings: string[] };
  /**
   * Change the song length in bars (one undo step). When shortening would
   * delete notes, chords or drum hits past the new end, or cut notes or chords
   * that run past it, and `confirmed` is false, nothing changes and a Japanese
   * warning is returned instead. Returns null once the change is applied.
   */
  setLengthBars: (lengthBars: number, confirmed?: boolean) => string | null;

  // chord actions
  addChord: (symbol: string, startBeat: number, durationBeats: number) => void;
  updateChord: (id: string, patch: Partial<Omit<ChordEvent, 'id'>>) => void;
  removeChord: (id: string) => void;

  // note actions
  addNote: (
    clipId: string,
    note: Omit<NoteEvent, 'id'> & { id?: string },
    options?: NoteEditOptions,
  ) => boolean;
  updateNote: (clipId: string, noteId: string, patch: NotePatch, options?: NoteEditOptions) => void;
  updateNotes: (clipId: string, patches: ReadonlyMap<string, NotePatch>, options?: NoteEditOptions) => void;
  removeNote: (clipId: string, noteId: string) => void;

  // drum actions
  toggleDrumStep: (clipId: string, lane: DrumLane, stepIndex: number) => void;

  // mixer actions
  setTrackVolume: (trackId: string, volume: number) => void;
  setTrackPan: (trackId: string, pan: number) => void;
  toggleMute: (trackId: string) => void;
  toggleSolo: (trackId: string) => void;

  // track management (each one undo step; a change that changes nothing adds none)
  /** Add an instrument or drum track before the master, select it and return its id. */
  addTrack: (type: 'instrument' | 'drum') => string;
  addReverbReturn: () => void;
  setTrackSend: (trackId: string, returnId: string, level: number) => void;
  /** Remove a track (not the master). A removed selection moves to the neighbouring track. */
  removeTrack: (trackId: string) => void;
  /** Copy a track (not the master) right after itself and select the copy. */
  duplicateTrack: (trackId: string) => void;
  renameTrack: (trackId: string, name: string) => void;
  /** Move a track to `toIndex` among the non-master tracks. */
  moveTrack: (trackId: string, toIndex: number) => void;
  setTrackColor: (trackId: string, color: string) => void;
  /** Set the track's role, or clear it with null. */
  setTrackRole: (trackId: string, role: TrackRole | null) => void;

  // selection (UI-only, no history)
  selectTrack: (trackId: string | null) => void;
  selectClip: (clipId: string | null) => void;
  selectChord: (chordId: string | null) => void;
  selectNotes: (noteIds: string[]) => void;

  // editor toggles (UI-only)
  setActiveView: (view: EditorView) => void;
  toggleScaleSnap: () => void;
  toggleLiveInput: () => void;
  setLiveInputOctave: (octave: number) => void;
  toggleLiveInputScaleLock: () => void;
  setGridSnap: (gridSnap: number) => void;
  toggleChordToneHighlight: () => void;
  toggleGhostTrack: (trackId: string) => void;
  setNoteColorMode: (mode: NoteColorMode) => void;
  togglePreviewOnPlace: () => void;
  setZoomX: (zoomX: number) => void;
  toggleTutorialPanel: () => void;
  setInspectorContent: (content: string | null) => void;
  setDifficulty: (difficulty: Difficulty) => void;
  /** Show / hide the launch start screen (UI-only, no history). */
  setStartScreenOpen: (open: boolean) => void;
  /** Switch the right-hand panel tab (UI-only, no history). */
  setRightPanelTab: (tab: RightPanelTab) => void;

  // transport
  //
  // The store owns play/stop *intent* and position semantics only; the audio
  // engine subscribes to these via `initAudioBridge()` (src/audio/playback.ts)
  // so the store never imports audio code.
  play: () => void;
  /**
   * Stop playback.
   *  - while playing: pause, keeping the current position (so a re-press of
   *    play resumes from where it stopped);
   *  - while already stopped (or with `reset` true): rewind to beat 0.
   */
  stop: (reset?: boolean) => void;
  setPosition: (beat: number) => void;
  /**
   * Turn loop on/off. Turning it on without a loop range first sets the bar
   * holding the playhead as the range (one undo step).
   */
  toggleLoop: () => void;
  toggleMetronome: () => void;
  /** Set the looped beat range, or clear it with null (one undo step). */
  setLoopRange: (range: { startBeat: number; endBeat: number } | null) => void;
  /** Set the looped beat range (one undo step, none when unchanged) and turn loop on. */
  loopRangeOn: (range: { startBeat: number; endBeat: number }) => void;

  // history actions
  /**
   * Start grouping project changes into one undo step. `owner` names the
   * operation: a different owner commits the open transaction and starts its
   * own. Without an owner this joins any open transaction.
   */
  beginTransaction: (owner?: unknown) => void;
  /**
   * Close the transaction, adding one undo step if the project really changed.
   * With an `owner`, this only closes a transaction that owner opened.
   */
  commitTransaction: (owner?: unknown) => void;
  /** Close the transaction and restore the project; `owner` as in commit. */
  cancelTransaction: (owner?: unknown) => void;
  /** True while a transaction opened by `owner` is still open. */
  ownsTransaction: (owner: unknown) => boolean;
  /** Abandons any open transaction first, so undo always lands on a whole step. */
  undo: () => void;
  /** Abandons any open transaction first, like `undo`. */
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // persistence
  saveToLocalStorage: () => boolean;
  flushPendingSave: () => boolean;
  listSavedProjects: () => ProjectSummary[];
  createNewProject: (title?: string) => void;
  deleteProject: (id: string) => boolean;
  /** Load a saved project by id into the store (resets history + selection). */
  loadProjectById: (id: string) => boolean;
  /** Replace the whole project (e.g. template instantiation / file import). */
  replaceProject: (project: Project) => void;
  /**
   * Load a project for listening only (e.g. the bundled sample song).
   * Unlike `replaceProject`, nothing is written to storage until the user
   * actually edits, so auditioning the sample never clutters saved projects.
   */
  loadProjectForPreview: (project: Project) => void;
};

// ---------------------------------------------------------------------------
// Debounced save (module-level so it survives re-renders).
// ---------------------------------------------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: (() => boolean) | null = null;

function scheduleSave(saveNow: () => boolean): void {
  if (saveTimer) clearTimeout(saveTimer);
  pendingSave = saveNow;
  saveTimer = setTimeout(() => {
    const run = pendingSave;
    saveTimer = null;
    pendingSave = null;
    run?.();
  }, SAVE_DEBOUNCE_MS);
}

function clearScheduledSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingSave = null;
}

function flushScheduledSave(): boolean {
  if (!pendingSave) return true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const run = pendingSave;
  pendingSave = null;
  return run();
}

// ---------------------------------------------------------------------------
// State builders.
// ---------------------------------------------------------------------------
function makeTransport(): TransportState {
  return {
    isPlaying: false,
    positionBeat: 0,
    loopEnabled: false,
    metronome: false,
  };
}

const DIFFICULTY_STORAGE_KEY = 'cts.editor.difficulty';

function loadDifficulty(): Difficulty {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(DIFFICULTY_STORAGE_KEY);
      if (raw === 'beginner' || raw === 'standard' || raw === 'advanced') return raw;
    }
  } catch {
    // ignore
  }
  return 'beginner';
}

function saveDifficulty(difficulty: Difficulty): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DIFFICULTY_STORAGE_KEY, difficulty);
    }
  } catch {
    // ignore
  }
}

/**
 * Extend a non-looping clip to fit its notes in the same undo step by default.
 * Editors with a fixed range keep the existing length.
 */
export function fitClipToNotes(clip: Clip, { extendClip = true }: NoteEditOptions = {}): Clip {
  if (!extendClip || clip.loop) return clip;
  const end = (clip.notes ?? []).reduce((max, n) => Math.max(max, n.startBeat + n.durationBeats), 0);
  return end > clip.lengthBeats ? { ...clip, lengthBeats: end } : clip;
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
    scaleSnap: true,
    liveInputEnabled: false,
    liveInputOctave: DEFAULT_KEYBOARD_OCTAVE,
    liveInputScaleLock: false,
    gridSnap: 1,
    chordToneHighlight: true,
    ghostHiddenTrackIds: [],
    noteColorMode: 'plain',
    previewOnPlace: true,
    zoomX: 1,
    difficulty: loadDifficulty(),
  };
}

function makeIdleSave(): SaveState {
  return { status: 'idle', lastSavedAt: null, errorMessage: null };
}

function makeSavedState(savedAt: string): SaveState {
  return { status: 'saved', lastSavedAt: savedAt, errorMessage: null };
}

/** Whether two projects differ only in their `updatedAt` stamp. */
function sameProjectContent(a: Project, b: Project): boolean {
  return JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' });
}

/** Load the most recent saved project, or build a fresh default. */
function initialProject(): Project {
  return loadMostRecentProject() ?? createDefaultProject();
}

/** Map over tracks immutably. */
function mapTracks(project: Project, fn: (t: Track) => Track): Project {
  return { ...project, tracks: project.tracks.map(fn) };
}

/** Find the track that owns a clip (read-only). */
function trackOfClip(project: Project, clipId: string): Track | undefined {
  return project.tracks.find((t) => t.clips.some((c) => c.id === clipId));
}

function emitTrackAdded(track: Track): void {
  publishAppEvent({
    type: 'track.added',
    payload: { trackId: track.id, trackName: track.name, trackType: track.type },
  });
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

const startingProject = initialProject();

let stopRecording: (() => void) | undefined;

/** The audio bridge provides a synchronous stop and commit for project switches. */
export function setRecordingStop(stop: (() => void) | undefined): void {
  stopRecording = stop;
}

export function finishRecordingForProjectChange(): boolean {
  if (!stopRecording) return false;
  stopRecording();
  return true;
}

function refuseRecordingEdit(): boolean {
  if (!stopRecording) return false;
  pushToast('録音中は曲を編集できません。録音を止めてから操作してください。', 'info');
  return true;
}

/** Whether a role suits a track type: 'drums' only on drum tracks, the other roles only on instrument tracks. */
export function roleFitsTrackType(role: TrackRole, type: Track['type']): boolean {
  return role === 'drums' ? type === 'drum' : type === 'instrument';
}

export const useStore = create<StoreState>((set, get) => {
  const markSaving = (): void => {
    const { lastSavedAt } = get().save;
    set({ save: { status: 'saving', lastSavedAt, errorMessage: null } });
  };

  const persistProject = (project: Project): boolean => {
    markSaving();
    const saved = saveProject(project);
    if (saved) {
      set({ save: makeSavedState(nowIso()) });
      return true;
    }
    const { lastSavedAt } = get().save;
    set({
      save: {
        status: 'error',
        lastSavedAt,
        errorMessage: SAVE_FAILURE_MESSAGE,
      },
    });
    return false;
  };

  const persistCurrentProject = (): boolean => persistProject(get().project);

  const transactionEvents = new Map<string, (after: Project) => void>();

  const prepareProjectSwitch = (): void => {
    if (finishRecordingForProjectChange()) flushScheduledSave();
  };

  /** Apply an immutable project change: bump updatedAt, push history, save. */
  const commitProject = (next: Project, event?: ProjectEditEvent): boolean => {
    if (refuseRecordingEdit()) return false;
    const current = get().project;
    if (next.tracks !== current.tracks || next.timeSignature !== current.timeSignature || next.lengthBars !== current.lengthBars) {
      if (next.tracks.some((track) => track.type === 'bus' && track.clips.length > 0)) {
        pushToast('リターンにはクリップやノートを置けません。', 'error');
        return false;
      }
      const problem = findProjectSoundingLimitProblem(next);
      if (problem) {
        pushToast(problem, 'error');
        return false;
      }
    }
    const stamped: Project = { ...next, updatedAt: nowIso() };
    const inTransaction = get().transactionBase !== null;
    const historyUpdate = inTransaction
      ? {}
      : { past: [...get().past, current].slice(-HISTORY_CAP), future: [] };
    set({
      project: stamped,
      ...historyUpdate,
      save: { status: 'saving', lastSavedAt: get().save.lastSavedAt, errorMessage: null },
    });
    scheduleSave(persistCurrentProject);
    if (event) {
      const publish = (after: Project) => {
        const activity = event.describe(after);
        if (activity) publishAppEvent(activity);
      };
      if (!inTransaction) publish(stamped);
      else if (!transactionEvents.has(event.key)) transactionEvents.set(event.key, publish);
    }
    return true;
  };

  /** Select a track and its first clip (UI only, no history). */
  const selectTrackAndFirstClip = (trackId: string | null): void => {
    const track = get().project.tracks.find((t) => t.id === trackId);
    set((s) => ({
      editor: {
        ...s.editor,
        selectedTrackId: trackId,
        selectedClipId: track?.clips[0]?.id ?? null,
        selectedNoteIds: [],
      },
    }));
  };

  /** After Undo/Redo: a selected track that no longer exists gives way to the first track. */
  const dropRemovedTrackSelection = (): void => {
    const { project, editor } = get();
    if (editor.selectedTrackId === null || project.tracks.some((t) => t.id === editor.selectedTrackId)) return;
    const fallback = project.tracks.find((t) => t.type !== 'master') ?? project.tracks[0];
    selectTrackAndFirstClip(fallback ? fallback.id : null);
  };

  let transactionOwner: unknown;
  const mayClose = (owner: unknown): boolean => owner === undefined || owner === transactionOwner;

  /** Put the project back as it was when the open transaction began, and close it. */
  const restoreTransactionBase = (): void => {
    const { transactionBase, project } = get();
    if (!transactionBase) return;
    transactionEvents.clear();
    if (project === transactionBase) {
      set({ transactionBase: null });
      return;
    }
    set({
      project: transactionBase,
      transactionBase: null,
      save: { status: 'saving', lastSavedAt: get().save.lastSavedAt, errorMessage: null },
    });
    scheduleSave(persistCurrentProject);
  };

  return {
    project: startingProject,
    projectOpenVersion: 0,
    transport: makeTransport(),
    editor: makeEditor(startingProject),
    save: makeIdleSave(),
    tutorialPanelOpen: false,
    startScreenOpen: true,
    rightPanelTab: 'inspector',
    inspector: { content: null },
    noteClipboard: [],
    setNoteClipboard: (notes) => set({ noteClipboard: notes }),
    past: [],
    future: [],
    transactionBase: null,

    applyProjectChange: (fn, event) => !refuseRecordingEdit() && commitProject(fn(get().project), event),

    // --- project metadata ---
    setBpm: (bpm) => commitProject({ ...get().project, bpm }),
    setKey: (key) => commitProject({ ...get().project, key }),
    setScale: (scale) => commitProject({ ...get().project, scale }),
    setTitle: (title) => commitProject({ ...get().project, title }),
    setTimeSignature: (timeSignature, confirmed = false) => {
      if (refuseRecordingEdit()) return { confirm: null, warnings: [] };
      const { project, warnings, droppedHits } = setProjectTimeSignature(get().project, timeSignature);
      if (droppedHits > 0 && !confirmed) {
        return {
          confirm: `拍子を ${timeSignature[0]}/${timeSignature[1]} にすると、ドラムの ${droppedHits} 個の音が別の音と重なるか、曲やクリップの終わり、ループの区切りにかかります。音が削除されたり、鳴らなくなる場所が出たりします。変更してもよいですか？(「元に戻す」で戻せます)`,
          warnings: [],
        };
      }
      const committed = commitProject(project);
      return { confirm: null, warnings: committed ? warnings : [] };
    },
    setLengthBars: (lengthBars, confirmed = false) => {
      if (refuseRecordingEdit()) return null;
      const project = get().project;
      if (!Number.isInteger(lengthBars) || lengthBars < 1 || lengthBars === project.lengthBars) {
        return null;
      }
      if (!confirmed) {
        const beyond = contentBeyondBars(project, lengthBars);
        const count = (label: string, n: number): string | null => (n > 0 ? `${label} ${n} 個` : null);
        const isPart = (part: string | null): part is string => part !== null;
        const removed = [
          count('ノート', beyond.notes),
          count('コード', beyond.chords),
          count('ドラム', beyond.drumHits),
          count('セクション', beyond.sections),
        ].filter(isPart);
        const cut = [count('ノート', beyond.truncatedNotes), count('コード', beyond.truncatedChords)].filter(isPart);
        const linked = beyond.linkedLosses;
        const linkedRemoved = linked ? [count('ノート', linked.notes), count('ドラム', linked.drumHits)].filter(isPart) : [];
        const linkedCut = linked ? count('ノート', linked.truncatedNotes) : null;
        const sentences = [
          removed.length > 0 ? `${lengthBars} 小節より後ろにある ${removed.join('・')} が削除されます。` : null,
          cut.length > 0 ? `${lengthBars} 小節の終わりをまたぐ ${cut.join('・')} は終わりで切られます。` : null,
          linkedRemoved.length > 0 ? `残る小節でも、リンク先を切り詰めると ${linkedRemoved.join('・')} が鳴らなくなります。` : null,
          linkedCut ? `残る小節でも、リンク先を切り詰めると ${linkedCut} が短く鳴ります。` : null,
        ].filter(isPart);
        if (sentences.length > 0) {
          return `${sentences.join('')}短くしてもよいですか？(「元に戻す」で戻せます)`;
        }
      }
      commitProject(setProjectLengthBars(project, lengthBars));
      return null;
    },

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
    addNote: (clipId, note, options) => {
      const project = get().project;
      const track = trackOfClip(project, clipId);
      if (!track || track.type === 'bus') return false;
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
            c.id === clipId ? fitClipToNotes({ ...c, notes: [...(c.notes ?? []), newNote] }, options) : c,
          ),
        })),
      );
      if (!committed) return false;
      publishAppEvent({
        type: 'note.added',
        payload: {
          pitch: newNote.pitch,
          startBeat: newNote.startBeat,
          durationBeats: newNote.durationBeats,
          trackId: track.id,
          trackName: track.name,
          inScale: pitchInScale(project, newNote.pitch),
        },
      });
      return true;
    },
    updateNote: (clipId, noteId, patch, options) =>
      get().updateNotes(clipId, new Map([[noteId, patch]]), options),
    updateNotes: (clipId, patches, options) => {
      const project = get().project;
      const track = trackOfClip(project, clipId);
      const clip = track?.clips.find((c) => c.id === clipId);
      if (!track || !clip?.notes) return;
      const notes = clip.notes.map((note) => {
        const patch = patches.get(note.id);
        if (!patch) return note;
        const next = { ...note, ...patch };
        return next.pitch === note.pitch && next.startBeat === note.startBeat &&
          next.durationBeats === note.durationBeats && next.velocity === note.velocity ? note : next;
      });
      if (notes.every((note, index) => note === clip.notes?.[index])) return;
      const updated = fitClipToNotes({ ...clip, notes }, options);
      commitProject(mapTracks(project, (t) => t === track
        ? { ...t, clips: t.clips.map((c) => c === clip ? updated : c) }
        : t), {
        key: `note.moved:${clipId}`,
        describe: (after) => {
          const original = new Map(clip.notes?.map((note) => [note.id, note]));
          const finalNotes = trackOfClip(after, clipId)?.clips.find((c) => c.id === clipId)?.notes;
          const moved = finalNotes?.find((note) => {
            const prior = original.get(note.id);
            return prior && (note.pitch !== prior.pitch || note.startBeat !== prior.startBeat);
          });
          if (!moved) return;
          return {
            type: 'note.moved',
            payload: { pitch: moved.pitch, startBeat: moved.startBeat, trackId: track.id, trackName: track.name },
          };
        },
      });
    },
    removeNote: (clipId, noteId) => {
      const project = get().project;
      commitProject(
        mapTracks(project, (t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, notes: (c.notes ?? []).filter((n) => n.id !== noteId) } : c,
          ),
        })),
      );
    },

    // --- drums ---
    toggleDrumStep: (clipId, lane, stepIndex) => {
      const project = get().project;
      const track = trackOfClip(project, clipId);
      const prevEvents = track?.clips.find((c) => c.id === clipId)?.drumEvents ?? [];
      const wasActive = prevEvents.some((e) => e.lane === lane && e.stepIndex === stepIndex);
      const committed = commitProject(
        mapTracks(project, (t) => ({
          ...t,
          clips: t.clips.map((c) => {
            if (c.id !== clipId) return c;
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
      if (!committed) return;
      publishAppEvent({
        type: 'drum.stepToggled',
        payload: { lane, stepIndex, active: !wasActive, trackId: track?.id ?? '' },
      });
    },

    // --- mixer ---
    setTrackVolume: (trackId, volume) => {
      const project = get().project;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track || track.volume === volume) return;
      commitProject(mapTracks(project, (t) => t === track ? { ...t, volume } : t), {
        key: `track.volumeChanged:${trackId}`,
        describe: (after) => {
          const final = after.tracks.find((t) => t.id === trackId);
          if (!final || final.volume === track.volume) return;
          return { type: 'track.volumeChanged', payload: { trackId, trackName: final.name, volume: final.volume } };
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

    // --- track management ---
    addTrack: (type) => {
      get().commitTransaction();
      const project = get().project;
      const next = addProjectTrack(project, { type, id: uid('track') });
      if (!commitProject(next)) return '';
      const added = next.tracks.find((track, index) => track !== project.tracks[index])!;
      selectTrackAndFirstClip(added.id);
      emitTrackAdded(added);
      return added.id;
    },
    addReverbReturn: () => {
      const project = get().project;
      const next = addProjectReverbReturn(project);
      if (next === project) {
        pushToast(`共有の響き（リターン）は ${MAX_RETURN_TRACKS} つまで追加できます。`, 'error');
        return;
      }
      get().commitTransaction();
      if (!commitProject(next)) return;
      const added = next.tracks.find((track, index) => track !== project.tracks[index])!;
      selectTrackAndFirstClip(added.id);
      emitTrackAdded(added);
    },
    setTrackSend: (trackId, returnId, level) => {
      const project = get().project;
      const next = setProjectTrackSend(project, trackId, returnId, level);
      if (next !== project) commitProject(next);
    },
    removeTrack: (trackId) => {
      const project = get().project;
      const next = removeProjectTrack(project, trackId);
      if (next === project) return;
      if (project.tracks.some((track) => track.id === trackId && track.type === 'bus')) {
        get().commitTransaction();
      }
      if (!commitProject(next)) return;
      const { selectedTrackId, selectedClipId } = get().editor;
      if (selectedTrackId !== trackId) {
        if (selectedClipId !== null && !next.tracks.some((t) => t.clips.some((c) => c.id === selectedClipId))) {
          set((s) => ({ editor: { ...s.editor, selectedClipId: null, selectedNoteIds: [] } }));
        }
        return;
      }
      // Select the track that now sits where the removed one was, else the one before it.
      const index = project.tracks.findIndex((t) => t.id === trackId);
      const after = project.tracks.slice(index + 1).find((t) => t.type !== 'master');
      const before = project.tracks.slice(0, index).reverse().find((t) => t.type !== 'master');
      const neighbour = after ?? before ?? next.tracks.find((t) => t.type === 'master');
      selectTrackAndFirstClip(neighbour ? neighbour.id : null);
    },
    duplicateTrack: (trackId) => {
      get().commitTransaction();
      const project = get().project;
      const next = duplicateProjectTrack(project, trackId, undefined, uid('track'));
      if (next === project || !commitProject(next)) return;
      const copy = next.tracks[next.tracks.findIndex((t) => t.id === trackId) + 1];
      if (copy) {
        selectTrackAndFirstClip(copy.id);
        emitTrackAdded(copy);
      }
    },
    renameTrack: (trackId, name) => {
      const project = get().project;
      const next = renameProjectTrack(project, trackId, name);
      if (next !== project) commitProject(next);
    },
    moveTrack: (trackId, toIndex) => {
      const project = get().project;
      const next = moveProjectTrack(project, trackId, toIndex);
      if (next !== project) commitProject(next);
    },
    setTrackColor: (trackId, color) => {
      const project = get().project;
      const next = setProjectTrackColor(project, trackId, color);
      if (next !== project) commitProject(next);
    },
    setTrackRole: (trackId, role) => {
      const project = get().project;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track || (track.role ?? null) === role || (role !== null && !roleFitsTrackType(role, track.type))) return;
      commitProject(
        mapTracks(project, (t) => {
          if (t.id !== trackId) return t;
          if (role !== null) return { ...t, role };
          const { role: _cleared, ...rest } = t;
          return rest;
        }),
      );
    },

    // --- selection (UI only) ---
    selectTrack: (trackId) => set((s) => ({ editor: { ...s.editor, selectedTrackId: trackId } })),
    selectClip: (clipId) => set((s) => ({ editor: { ...s.editor, selectedClipId: clipId } })),
    selectChord: (chordId) => set((s) => ({ editor: { ...s.editor, selectedChordId: chordId } })),
    selectNotes: (noteIds) => set((s) => ({ editor: { ...s.editor, selectedNoteIds: noteIds } })),

    // --- editor toggles (UI only) ---
    setActiveView: (view) => set((s) => ({ editor: { ...s.editor, activeView: view } })),
    toggleLiveInput: () =>
      set((s) => ({ editor: { ...s.editor, liveInputEnabled: !s.editor.liveInputEnabled } })),
    setLiveInputOctave: (octave) =>
      set((s) => ({ editor: { ...s.editor, liveInputOctave: octave } })),
    setGridSnap: (gridSnap) => set((s) => ({ editor: { ...s.editor, gridSnap } })),
    toggleLiveInputScaleLock: () =>
      set((s) => ({ editor: { ...s.editor, liveInputScaleLock: !s.editor.liveInputScaleLock } })),
    toggleScaleSnap: () => {
      const next = !get().editor.scaleSnap;
      set((s) => ({ editor: { ...s.editor, scaleSnap: next } }));
      if (next) {
        const project = get().project;
        publishAppEvent({
          type: 'scale_snap.enabled',
          payload: { key: project.key, scale: project.scale },
        });
      }
    },
    toggleGhostTrack: (trackId) =>
      set((s) => {
        const hidden = s.editor.ghostHiddenTrackIds;
        const next = hidden.includes(trackId) ? hidden.filter((id) => id !== trackId) : [...hidden, trackId];
        return { editor: { ...s.editor, ghostHiddenTrackIds: next } };
      }),
    setNoteColorMode: (mode) => set((s) => ({ editor: { ...s.editor, noteColorMode: mode } })),
    toggleChordToneHighlight: () =>
      set((s) => ({ editor: { ...s.editor, chordToneHighlight: !s.editor.chordToneHighlight } })),
    togglePreviewOnPlace: () =>
      set((s) => ({ editor: { ...s.editor, previewOnPlace: !s.editor.previewOnPlace } })),
    setZoomX: (zoomX) => set((s) => ({ editor: { ...s.editor, zoomX } })),
    toggleTutorialPanel: () => set((s) => ({ tutorialPanelOpen: !s.tutorialPanelOpen })),
    setInspectorContent: (content) => set({ inspector: { content } }),
    setDifficulty: (difficulty) => {
      saveDifficulty(difficulty);
      set((s) => ({ editor: { ...s.editor, difficulty } }));
    },
    setStartScreenOpen: (open) => set({ startScreenOpen: open }),
    setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

    // --- transport ---
    play: () => {
      set((s) => ({ transport: { ...s.transport, isPlaying: true } }));
      publishAppEvent({
        type: 'transport.played',
        payload: { positionBeats: get().transport.positionBeat },
      });
    },
    stop: (reset) =>
      set((s) => {
        // Playing -> pause (keep position) unless an explicit reset is asked.
        // Already stopped -> rewind to 0.
        const shouldReset = reset === true || !s.transport.isPlaying;
        return {
          transport: {
            ...s.transport,
            isPlaying: false,
            positionBeat: shouldReset ? 0 : s.transport.positionBeat,
          },
        };
      }),
    setPosition: (beat) => set((s) => ({ transport: { ...s.transport, positionBeat: beat } })),
    toggleLoop: () => {
      const { project, transport } = get();
      const loopEnabled = !transport.loopEnabled;
      if (loopEnabled && !project.loopRange) {
        if (refuseRecordingEdit()) return;
        const bpb = beatsPerBarOf(project.timeSignature);
        const lastBar = Math.max(0, project.lengthBars - 1);
        const bar = Math.min(lastBar, Math.max(0, Math.floor(transport.positionBeat / bpb + 1e-9)));
        get().setLoopRange({ startBeat: bar * bpb, endBeat: (bar + 1) * bpb });
      }
      set((s) => ({ transport: { ...s.transport, loopEnabled } }));
    },
    toggleMetronome: () =>
      set((s) => ({ transport: { ...s.transport, metronome: !s.transport.metronome } })),
    setLoopRange: (range) => {
      if (refuseRecordingEdit()) return;
      // A loop range change is its own undo step, apart from an open (tap tempo) transaction.
      get().commitTransaction();
      const project = get().project;
      if (range === null ? !project.loopRange :
        project.loopRange?.startBeat === range.startBeat && project.loopRange.endBeat === range.endBeat) return;
      if (commitProject(setProjectLoopRange(project, range))) {
        publishAppEvent({ type: 'loop.set', payload: { range: range && { ...range } } });
      }
    },
    loopRangeOn: (range) => {
      const current = get().project.loopRange;
      if (current?.startBeat !== range.startBeat || current.endBeat !== range.endBeat) {
        if (refuseRecordingEdit()) return;
        get().setLoopRange(range);
      }
      set((s) => ({ transport: { ...s.transport, loopEnabled: true } }));
    },

    // --- history ---
    beginTransaction: (owner) => {
      if (stopRecording) return;
      if (get().transactionBase) {
        if (mayClose(owner)) return;
        get().commitTransaction();
      }
      transactionOwner = owner;
      transactionEvents.clear();
      set({ transactionBase: get().project });
    },
    commitTransaction: (owner) => {
      const { transactionBase, project, past } = get();
      if (!transactionBase || !mayClose(owner)) return;
      if (sameProjectContent(transactionBase, project)) {
        restoreTransactionBase();
        return;
      }
      const events = [...transactionEvents.values()];
      transactionEvents.clear();
      set({
        past: [...past, transactionBase].slice(-HISTORY_CAP),
        future: [],
        transactionBase: null,
      });
      for (const publish of events) publish(project);
    },
    cancelTransaction: (owner) => {
      if (mayClose(owner)) restoreTransactionBase();
    },
    ownsTransaction: (owner) => get().transactionBase !== null && owner === transactionOwner,
    undo: () => {
      if (refuseRecordingEdit()) return;
      restoreTransactionBase();
      const { past, project, future } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        project: previous,
        past: past.slice(0, -1),
        future: [project, ...future].slice(0, HISTORY_CAP),
        save: { status: 'saving', lastSavedAt: get().save.lastSavedAt, errorMessage: null },
      });
      scheduleSave(persistCurrentProject);
      dropRemovedTrackSelection();
    },
    redo: () => {
      if (refuseRecordingEdit()) return;
      restoreTransactionBase();
      const { past, project, future } = get();
      const next = future[0];
      if (!next) return;
      set({
        project: next,
        past: [...past, project].slice(-HISTORY_CAP),
        future: future.slice(1),
        save: { status: 'saving', lastSavedAt: get().save.lastSavedAt, errorMessage: null },
      });
      scheduleSave(persistCurrentProject);
      dropRemovedTrackSelection();
    },
    canUndo: () => get().past.length > 0 || get().transactionBase !== null,
    canRedo: () => get().future.length > 0,

    // --- persistence ---
    saveToLocalStorage: () => {
      clearScheduledSave();
      return persistCurrentProject();
    },
    flushPendingSave: () => flushScheduledSave(),
    listSavedProjects: () => listSavedProjects(),
    createNewProject: (title) => {
      prepareProjectSwitch();
      clearScheduledSave();
      transactionEvents.clear();
      const project = createDefaultProject(title);
      set({
        project,
        projectOpenVersion: get().projectOpenVersion + 1,
        editor: makeEditor(project),
        transport: makeTransport(),
        save: makeIdleSave(),
        past: [],
        future: [],
        transactionBase: null,
      });
      persistProject(project);
      publishAppEvent({
        type: 'project.created',
        payload: { key: project.key, bpm: project.bpm },
      });
    },
    loadProjectById: (id) => {
      prepareProjectSwitch();
      const loaded = loadStoredProject(id);
      if (!loaded) return false;
      clearScheduledSave();
      transactionEvents.clear();
      set({
        project: loaded,
        projectOpenVersion: get().projectOpenVersion + 1,
        editor: makeEditor(loaded),
        transport: makeTransport(),
        save: makeSavedState(loaded.updatedAt),
        past: [],
        future: [],
        transactionBase: null,
      });
      return true;
    },
    replaceProject: (project) => {
      prepareProjectSwitch();
      clearScheduledSave();
      transactionEvents.clear();
      set({
        project,
        projectOpenVersion: get().projectOpenVersion + 1,
        editor: makeEditor(project),
        transport: makeTransport(),
        save: makeIdleSave(),
        past: [],
        future: [],
        transactionBase: null,
      });
      persistProject(project);
      publishAppEvent({
        type: 'project.created',
        payload: { key: project.key, bpm: project.bpm },
      });
    },
    loadProjectForPreview: (project) => {
      prepareProjectSwitch();
      clearScheduledSave();
      transactionEvents.clear();
      set({
        project,
        projectOpenVersion: get().projectOpenVersion + 1,
        editor: makeEditor(project),
        transport: makeTransport(),
        save: makeIdleSave(),
        past: [],
        future: [],
        transactionBase: null,
      });
    },
    deleteProject: (id) => {
      const deletingCurrent = get().project.id === id;
      if (deletingCurrent && refuseRecordingEdit()) return false;
      if (!deleteStoredProject(id)) return false;
      // If the active project was deleted, switch to the most recent saved one
      // or a fresh default so the UI always has a project to render.
      if (deletingCurrent) {
        clearScheduledSave();
        transactionEvents.clear();
        const savedFallback = loadMostRecentProject();
        const fallback = savedFallback ?? createDefaultProject();
        set({
          project: fallback,
          projectOpenVersion: get().projectOpenVersion + 1,
          editor: makeEditor(fallback),
          transport: makeTransport(),
          save: savedFallback ? makeSavedState(savedFallback.updatedAt) : makeIdleSave(),
          past: [],
          future: [],
          transactionBase: null,
        });
      }
      return true;
    },
  };
});

/** Keys that move a focused range slider. */
const SLIDER_STEP_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** Stops watching the pointer drag in progress; null when there is none. */
let stopDragWatch: (() => void) | null = null;
/** Owner of the last drag closed before its pointer was released. */
let abandonedDragOwner: unknown = null;

/** The beat range playback repeats: `project.loopRange` while loop is on, else null. */
export function activeLoopRange(
  state: Pick<StoreState, 'project' | 'transport'>,
): { startBeat: number; endBeat: number } | null {
  return state.transport.loopEnabled ? (state.project.loopRange ?? null) : null;
}

/**
 * Closes the open transaction of `owner` when that pointer is released, even if
 * the element that captured it is gone or the component has unmounted. The
 * release is watched on window, and only while the drag's own transaction is
 * open, so a release after a cancel or Undo is ignored.
 */
export function watchDragEnd(owner: unknown, pointerId: number): void {
  stopDragWatch?.();
  const { commitTransaction, cancelTransaction } = useStore.getState();
  const finishWith =
    (end: (owner: unknown) => void) =>
    (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId) return;
      stop();
      end(owner);
    };
  const onUp = finishWith(commitTransaction);
  const onCancel = finishWith(cancelTransaction);
  const stop = (): void => {
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    unsubscribe();
    stopDragWatch = null;
  };
  const unsubscribe = useStore.subscribe((state) => {
    if (state.ownsTransaction(owner)) return;
    stop();
    abandonedDragOwner = owner;
  });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  stopDragWatch = stop;
}

/**
 * Spread onto `<input type="range">`: pointerdown..pointerup, or one key press
 * up to its keyup, is one undo step. A drag ended early by a cancel or Undo stays
 * over: its remaining changes are reverted until the next press or key.
 */
export const sliderUndoProps = {
  onChangeCapture: (event: {
    currentTarget: EventTarget;
    nativeEvent: { type: string };
  }): void => {
    const owner = event.currentTarget;
    const { beginTransaction, cancelTransaction } = useStore.getState();
    beginTransaction(owner);
    if (owner !== abandonedDragOwner) return;
    // React runs a target's onChange even if its capture handler stops
    // propagation, so the change is undone once it has bubbled past the handler.
    window.addEventListener(event.nativeEvent.type, () => cancelTransaction(owner), { once: true });
  },
  onPointerDown: (event: { currentTarget: EventTarget; pointerId: number }): void => {
    abandonedDragOwner = null;
    useStore.getState().beginTransaction(event.currentTarget);
    watchDragEnd(event.currentTarget, event.pointerId);
  },
  onKeyDown: (event: { key: string }): void => {
    if (SLIDER_STEP_KEYS.has(event.key)) abandonedDragOwner = null;
  },
  onKeyUp: (event: { key: string; currentTarget: EventTarget }): void => {
    if (SLIDER_STEP_KEYS.has(event.key) && !stopDragWatch) {
      useStore.getState().commitTransaction(event.currentTarget);
    }
  },
  // Tabbing away with a key held never delivers the keyup here. A window blur
  // also blurs the slider, but that one must cancel (see TransportBar).
  onBlur: (event: { currentTarget: EventTarget }): void => {
    if (document.hasFocus() && !stopDragWatch) {
      useStore.getState().commitTransaction(event.currentTarget);
    }
  },
};

/** Spread onto a text or number input: edits up to blur or Enter are one undo step. */
export const textUndoProps = {
  onChangeCapture: (event: { currentTarget: EventTarget }): void =>
    useStore.getState().beginTransaction(event.currentTarget),
  onBlur: (event: { currentTarget: EventTarget }): void =>
    useStore.getState().commitTransaction(event.currentTarget),
  onKeyDown: (event: {
    key: string;
    keyCode: number;
    currentTarget: EventTarget;
    nativeEvent: { isComposing: boolean };
  }): void => {
    // Enter while composing Japanese confirms the conversion, not the edit.
    // WebKit reports that Enter with keyCode 229 and isComposing false.
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    useStore.getState().commitTransaction(event.currentTarget);
  },
};
