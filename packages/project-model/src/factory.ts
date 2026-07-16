// High-level factory helpers. All timestamps default to a fixed placeholder so
// callers that need deterministic output do not have to inject a clock.
// Persistable ids come from makeId(), which namespaces counters per JS realm.

import { makeId } from './ids';
import {
  CURRENT_SCHEMA_VERSION,
  createMidiClip,
  createDrumClip,
} from './factories';
import type {
  ChordEvent,
  MusicalKey,
  NoteEvent,
  Project,
  ScaleName,
  Track,
} from './types';

const PLACEHOLDER_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export type CreateDefaultProjectOpts = Partial<
  Pick<Project, 'title' | 'bpm' | 'key' | 'scale' | 'timeSignature' | 'lengthBars'>
>;

/** Create an instrument (MIDI) track with sensible defaults. */
export function createInstrumentTrack(name = 'Instrument'): Track {
  return {
    id: makeId('track'),
    name,
    type: 'instrument',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
}

/** Create a drum track with sensible defaults. */
export function createDrumTrack(name = 'Drums'): Track {
  return {
    id: makeId('track'),
    name,
    type: 'drum',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
}

/** Create a NoteEvent. */
export function createNoteEvent(
  pitch: number,
  startBeat: number,
  durationBeats: number,
  velocity: number,
): NoteEvent {
  return {
    id: makeId('note'),
    pitch,
    startBeat,
    durationBeats,
    velocity,
  };
}

/** Create a ChordEvent. */
export function createChordEvent(
  startBeat: number,
  durationBeats: number,
  symbol: string,
  root: string,
  quality: string,
  notes: number[],
): ChordEvent {
  return {
    id: makeId('chord'),
    startBeat,
    durationBeats,
    symbol,
    root,
    quality,
    notes,
  };
}

/**
 * Create a default project with sensible beginner defaults.
 * Timestamps default to a fixed placeholder; pass `createdAt`/`updatedAt` via
 * a cast if you need live timestamps (the Project type does not expose them
 * through CreateDefaultProjectOpts by design).
 */
export function createDefaultProject(opts: CreateDefaultProjectOpts = {}): Project {
  const title = opts.title ?? 'Untitled';
  const bpm = opts.bpm ?? 100;
  const key: MusicalKey = opts.key ?? 'C';
  const scale: ScaleName = opts.scale ?? 'major';
  const requestedTimeSignature = opts.timeSignature ?? [4, 4];
  const timeSignature: [number, number] = [
    requestedTimeSignature[0],
    requestedTimeSignature[1],
  ];
  const lengthBars = opts.lengthBars ?? 8;

  const master: Track = {
    id: makeId('track'),
    name: 'Master',
    type: 'master',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };

  const instrTrack = createInstrumentTrack('Piano');
  const drumTrack = createDrumTrack('Drums');

  // Beats in one bar = numerator * (4 / denominator)
  const lengthBeats = lengthBars * timeSignature[0] * (4 / timeSignature[1]);

  instrTrack.clips.push(createMidiClip(instrTrack.id, 0, lengthBeats));
  drumTrack.clips.push(createDrumClip(drumTrack.id, 0, lengthBeats));

  return {
    id: makeId('project'),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title,
    bpm,
    timeSignature,
    key,
    scale,
    lengthBars,
    lengthBeats,
    tempoMap: [{ id: makeId('tempo'), beat: 0, bpm }],
    timeSignatureMap: [{
      id: makeId('signature'),
      beat: 0,
      numerator: timeSignature[0],
      denominator: timeSignature[1],
    }],
    audioAssets: [],
    automationLanes: [],
    audioRouting: {
      outputs: [instrTrack, drumTrack].map((track) => ({
        sourceTrackId: track.id,
        destination: { type: 'master' as const },
      })),
      sends: [],
    },
    tracks: [master, instrTrack, drumTrack],
    chordTrack: [],
    sections: [],
    createdAt: PLACEHOLDER_TIMESTAMP,
    updatedAt: PLACEHOLDER_TIMESTAMP,
  };
}
