// P42 acceptance helpers (shared by the p42-*.test.ts files). Implementers must not edit.
// All expected values in the tests are hand-computed ticks (PPQ 480); nothing here converts time
// with the code under test. `TICKS_PER_SECOND_120` documents the arithmetic used: at 120 bpm a
// beat is 0.5 s = 480 ticks, so 1 s = 960 ticks.
import {
  createEmptyProject,
  type Clip,
  type NoteEvent,
  type Project,
} from '@cts/project-model';
import {
  feedMidiRecordingEvent,
  startMidiRecording,
  stopMidiRecording,
  type MidiRecordingEvent,
  type MidiRecordingOptions,
  type MidiRecordingSession,
  type MidiRecordingStopped,
} from '../../src/state/midiRecording';

export const clock = () => new Date('2026-01-01T00:00:00.000Z');
export const PPQ = 480; // independent literal on purpose

export type NoteSpec = { pitch: number; startBeat: number; durationBeats: number };

export type ProjectSpec = {
  /** Clip placement inside the song, in beats. Default 0 / 16. */
  clipStartBeat?: number;
  clipLengthBeats?: number;
  notes?: NoteSpec[];
  tempoMap?: Array<{ id: string; beat: number; bpm: number }>;
};

/** A 120 bpm 4/4 project whose only non-empty MIDI clip is the Melody clip. */
export function makeProject(spec: ProjectSpec = {}): Project {
  const project = createEmptyProject({ clock, lengthBars: 8 }); // 32 beats
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.type === 'midi') clip.notes = [];
      if (clip.type === 'drum') clip.drumEvents = [];
    }
  }
  const melody = project.tracks.find((track) => track.name === 'Melody');
  const clip = melody?.clips[0];
  if (!melody || !clip || clip.type !== 'midi') throw new Error('Melody MIDI clip missing');
  clip.startBeat = spec.clipStartBeat ?? 0;
  clip.lengthBeats = spec.clipLengthBeats ?? 16;
  clip.notes = (spec.notes ?? []).map((note, index) => ({ id: `e${index}`, velocity: 90, ...note }));
  if (spec.tempoMap) project.tempoMap = spec.tempoMap;
  return project;
}

export function melodyClip(project: Project): Clip {
  const clip = project.tracks.find((track) => track.name === 'Melody')?.clips[0];
  if (!clip || clip.type !== 'midi') throw new Error('Melody MIDI clip missing');
  return clip;
}

export function options(project: Project, overrides: Partial<MidiRecordingOptions> = {}): MidiRecordingOptions {
  return {
    clipId: melodyClip(project).id,
    mode: 'overdub',
    countInBars: 0,
    autoQuantize: null,
    loop: null,
    startBeat: 0,
    ...overrides,
  };
}

export const on = (pitch: number, timeSec: number, velocity = 100): MidiRecordingEvent =>
  ({ type: 'on', pitch, velocity, timeSec });
export const off = (pitch: number, timeSec: number): MidiRecordingEvent =>
  ({ type: 'off', pitch, velocity: 0, timeSec });

export type Tick = { pitch: number; startTick: number; durTick: number };

/** Clip-relative tick view of a clip's notes, sorted by (start, pitch). */
export function ticksOf(clip: Clip): Tick[] {
  return (clip.notes ?? [])
    .map((note: NoteEvent) => ({
      pitch: note.pitch,
      startTick: Math.round(note.startBeat * PPQ),
      durTick: Math.round((note.startBeat + note.durationBeats) * PPQ) - Math.round(note.startBeat * PPQ),
    }))
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
}

/** Run one whole take through the pure module; fails the test run loudly on a refusal. */
export function runTake(
  project: Project,
  opts: MidiRecordingOptions,
  events: MidiRecordingEvent[],
  stopSec: number,
): MidiRecordingStopped {
  const started = startMidiRecording(project, opts);
  if (!started.ok) throw new Error(`start refused: ${started.code}`);
  let session: MidiRecordingSession = started.session;
  for (const event of events) session = feedMidiRecordingEvent(session, event);
  const stopped = stopMidiRecording(project, session, { timeSec: stopSec });
  if (!stopped.ok) throw new Error(`stop refused: ${stopped.code}`);
  return stopped;
}
