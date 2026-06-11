// Central Zustand store for Compose Tutor Studio.
//
// Holds the project, transport, editor UI state, panel state, and an
// undo/redo history of project snapshots. Project mutations always bump
// `updatedAt`, push history, and schedule a debounced localStorage save.

import { create } from 'zustand';
import type {
  ChordEvent,
  DrumEvent,
  DrumLane,
  MusicalKey,
  NoteEvent,
  Project,
  ScaleName,
  Track,
} from '@cts/project-model';
import { createDefaultProject } from './defaultProject';
import { nowIso, uid } from './ids';
import {
  deleteProject as deleteStoredProject,
  listSavedProjects,
  loadMostRecentProject,
  saveProject,
  type ProjectSummary,
} from './persistence';

export type EditorView = 'pianoRoll' | 'drums' | 'arranger';

export type TransportState = {
  isPlaying: boolean;
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

type StoreState = {
  project: Project;
  transport: TransportState;
  editor: EditorState;
  tutorialPanelOpen: boolean;
  /** Free-form inspector content state (e.g. selected chord summary). */
  inspector: { content: string | null };

  // history
  past: Project[];
  future: Project[];

  /** Generic escape hatch: apply an immutable project change (bumps updatedAt, pushes history, saves). */
  applyProjectChange: (fn: (p: Project) => Project) => void;

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
  toggleDrumStep: (clipId: string, lane: DrumLane, stepIndex: number) => void;

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

  // transport (UI-only)
  play: () => void;
  stop: () => void;
  setPosition: (beat: number) => void;
  toggleLoop: () => void;
  toggleMetronome: () => void;

  // history actions
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // persistence
  saveToLocalStorage: () => void;
  listSavedProjects: () => ProjectSummary[];
  createNewProject: (title?: string) => void;
  deleteProject: (id: string) => void;
};

// ---------------------------------------------------------------------------
// Debounced save (module-level so it survives re-renders).
// ---------------------------------------------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(getProject: () => Project): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveProject(getProject());
    saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// State builders.
// ---------------------------------------------------------------------------
function makeTransport(): TransportState {
  return {
    isPlaying: false,
    positionBeat: 0,
    loopEnabled: false,
    loopStartBeat: 0,
    loopEndBeat: 0,
    metronome: false,
  };
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
    chordToneHighlight: true,
    zoomX: 1,
  };
}

/** Load the most recent saved project, or build a fresh default. */
function initialProject(): Project {
  return loadMostRecentProject() ?? createDefaultProject();
}

/** Map over tracks immutably. */
function mapTracks(project: Project, fn: (t: Track) => Track): Project {
  return { ...project, tracks: project.tracks.map(fn) };
}

const startingProject = initialProject();

export const useStore = create<StoreState>((set, get) => {
  /** Apply an immutable project change: bump updatedAt, push history, save. */
  const commitProject = (next: Project): void => {
    const current = get().project;
    const stamped: Project = { ...next, updatedAt: nowIso() };
    const past = [...get().past, current].slice(-HISTORY_CAP);
    set({ project: stamped, past, future: [] });
    scheduleSave(() => get().project);
  };

  return {
    project: startingProject,
    transport: makeTransport(),
    editor: makeEditor(startingProject),
    tutorialPanelOpen: false,
    inspector: { content: null },
    past: [],
    future: [],

    applyProjectChange: (fn) => commitProject(fn(get().project)),

    // --- project metadata ---
    setBpm: (bpm) => commitProject({ ...get().project, bpm }),
    setKey: (key) => commitProject({ ...get().project, key }),
    setScale: (scale) => commitProject({ ...get().project, scale }),
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
      const newNote: NoteEvent = {
        id: note.id ?? uid('note'),
        pitch: note.pitch,
        startBeat: note.startBeat,
        durationBeats: note.durationBeats,
        velocity: note.velocity,
      };
      commitProject(
        mapTracks(project, (t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, notes: [...(c.notes ?? []), newNote] } : c,
          ),
        })),
      );
    },
    updateNote: (clipId, noteId, patch) => {
      const project = get().project;
      commitProject(
        mapTracks(project, (t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId
              ? { ...c, notes: (c.notes ?? []).map((n) => (n.id === noteId ? { ...n, ...patch } : n)) }
              : c,
          ),
        })),
      );
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
      commitProject(
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
    },

    // --- mixer ---
    setTrackVolume: (trackId, volume) => {
      const project = get().project;
      commitProject(mapTracks(project, (t) => (t.id === trackId ? { ...t, volume } : t)));
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
    toggleScaleSnap: () => set((s) => ({ editor: { ...s.editor, scaleSnap: !s.editor.scaleSnap } })),
    toggleChordToneHighlight: () =>
      set((s) => ({ editor: { ...s.editor, chordToneHighlight: !s.editor.chordToneHighlight } })),
    setZoomX: (zoomX) => set((s) => ({ editor: { ...s.editor, zoomX } })),
    toggleTutorialPanel: () => set((s) => ({ tutorialPanelOpen: !s.tutorialPanelOpen })),
    setInspectorContent: (content) => set({ inspector: { content } }),

    // --- transport (UI only) ---
    play: () => set((s) => ({ transport: { ...s.transport, isPlaying: true } })),
    stop: () => set((s) => ({ transport: { ...s.transport, isPlaying: false, positionBeat: 0 } })),
    setPosition: (beat) => set((s) => ({ transport: { ...s.transport, positionBeat: beat } })),
    toggleLoop: () => set((s) => ({ transport: { ...s.transport, loopEnabled: !s.transport.loopEnabled } })),
    toggleMetronome: () =>
      set((s) => ({ transport: { ...s.transport, metronome: !s.transport.metronome } })),

    // --- history ---
    undo: () => {
      const { past, project, future } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        project: previous,
        past: past.slice(0, -1),
        future: [project, ...future].slice(0, HISTORY_CAP),
      });
      scheduleSave(() => get().project);
    },
    redo: () => {
      const { past, project, future } = get();
      const next = future[0];
      if (!next) return;
      set({
        project: next,
        past: [...past, project].slice(-HISTORY_CAP),
        future: future.slice(1),
      });
      scheduleSave(() => get().project);
    },
    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    // --- persistence ---
    saveToLocalStorage: () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      saveProject(get().project);
    },
    listSavedProjects: () => listSavedProjects(),
    createNewProject: (title) => {
      const project = createDefaultProject(title);
      set({
        project,
        editor: makeEditor(project),
        transport: makeTransport(),
        past: [],
        future: [],
      });
      saveProject(project);
    },
    deleteProject: (id) => {
      deleteStoredProject(id);
      // If the active project was deleted, switch to the most recent saved one
      // or a fresh default so the UI always has a project to render.
      if (get().project.id === id) {
        const fallback = loadMostRecentProject() ?? createDefaultProject();
        set({
          project: fallback,
          editor: makeEditor(fallback),
          transport: makeTransport(),
          past: [],
          future: [],
        });
      }
    },
  };
});
