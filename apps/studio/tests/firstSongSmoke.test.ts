import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectToMidi } from '@cts/midi-io';
import { validateProject, type Project } from '@cts/project-model';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { encodeWav } from '../src/audio/wav';
import {
  evaluateExportChecklist,
  hasExportChecklistWarnings,
} from '../src/features/export/exportChecklist';
import { projectKey } from '../src/state/persistence';
import { installLocalStorage, type MemoryStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');
let storage: MemoryStorage;

beforeAll(async () => {
  storage = installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
});

beforeEach(() => {
  storage = installLocalStorage();
  useStore.getState().createNewProject('商用スモーク');
});

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} not found`);
  }
  return value;
}

function midiPitchForPitchClass(pc: number): number {
  return 60 + (((pc % 12) + 12) % 12);
}

function addChordPadNotes(project: Project): void {
  const chordsClip = requireValue(
    actions.firstMidiClipOfTrack(project, 'Chords'),
    'Chords clip',
  );

  for (const chord of project.chordTrack) {
    for (const pc of chord.notes) {
      useStore.getState().addNote(chordsClip.id, {
        pitch: midiPitchForPitchClass(pc),
        startBeat: chord.startBeat,
        durationBeats: chord.durationBeats,
        velocity: 72,
      });
    }
  }
}

function notesInTrack(project: Project, trackName: string): number {
  const track = requireValue(actions.findTrackByName(project, trackName), trackName);
  return track.clips.reduce((sum, clip) => sum + (clip.notes?.length ?? 0), 0);
}

describe('first-song commercial smoke', () => {
  it('can create, complete, save, reload, and prepare export artifacts for an 8-bar song', () => {
    addChordPadNotes(useStore.getState().project);

    const bassClip = requireValue(
      actions.firstMidiClipOfTrack(useStore.getState().project, 'Bass'),
      'Bass clip',
    );
    const bass = actions.generateBassIntoClip(bassClip.id, 'rootFifth');
    expect(bass.length).toBeGreaterThan(0);

    const melodyClip = requireValue(
      actions.firstMidiClipOfTrack(useStore.getState().project, 'Melody'),
      'Melody clip',
    );
    const melody = actions.generateMelodyIntoClip(melodyClip.id, 20260620);
    expect(melody.length).toBeGreaterThan(0);

    const drumClip = requireValue(
      useStore.getState().project.tracks.find((track) => track.type === 'drum')?.clips[0],
      'Drums clip',
    );
    actions.applyDrumPattern(drumClip.id, 'eightBeat');

    const completed = useStore.getState().project;
    expect(validateProject(completed).ok).toBe(true);
    expect(completed.lengthBars).toBe(8);
    expect(completed.chordTrack.length).toBe(8);
    expect(notesInTrack(completed, 'Chords')).toBeGreaterThan(0);
    expect(notesInTrack(completed, 'Bass')).toBeGreaterThan(0);
    expect(notesInTrack(completed, 'Melody')).toBeGreaterThan(0);
    expect(
      completed.tracks.find((track) => track.type === 'drum')?.clips[0]?.drumEvents?.length ?? 0,
    ).toBeGreaterThan(0);

    const checklist = evaluateExportChecklist(completed);
    expect(hasExportChecklistWarnings(checklist)).toBe(false);

    const scheduled = buildScheduleEvents(completed);
    const payloads = scheduled.map((event) => event.payload as SchedulePayload);
    expect(payloads.some((payload) => payload.kind === 'note')).toBe(true);
    expect(payloads.some((payload) => payload.kind === 'drum')).toBe(true);
    for (const event of scheduled) {
      expect(event.beat).toBeGreaterThanOrEqual(0);
      expect(event.beat).toBeLessThan(32);
    }

    expect(useStore.getState().flushPendingSave()).toBe(true);
    expect(useStore.getState().save.status).toBe('saved');
    expect(storage.getItem(projectKey(completed.id))).not.toBeNull();

    expect(useStore.getState().loadProjectById(completed.id)).toBe(true);
    const reloaded = useStore.getState().project;
    expect(reloaded.id).toBe(completed.id);
    expect(validateProject(reloaded).ok).toBe(true);
    expect(notesInTrack(reloaded, 'Bass')).toBe(notesInTrack(completed, 'Bass'));
    expect(notesInTrack(reloaded, 'Melody')).toBe(notesInTrack(completed, 'Melody'));

    const midi = projectToMidi(reloaded);
    expect(String.fromCharCode(...midi.slice(0, 4))).toBe('MThd');
    expect(midi.length).toBeGreaterThan(100);

    const wav = encodeWav([
      new Float32Array([0, 0.2, -0.2, 0]),
      new Float32Array([0, -0.2, 0.2, 0]),
    ]);
    expect(String.fromCharCode(...new Uint8Array(wav, 0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...new Uint8Array(wav, 8, 4))).toBe('WAVE');
  });
});
