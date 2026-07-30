// Project/entity factories. All ids come from the makeId helper; timestamps come
// from an injectable clock (defaults to the real system clock).

import type { Clock } from './clock';
import { systemClock, nowIso } from './clock';
import { beatsPerBar } from './time';
import { makeId } from './ids';
import type {
  Clip,
  InstrumentConfig,
  MusicalKey,
  Project,
  ScaleName,
  Track,
  TrackRole,
  TrackType,
} from './types';

export const CURRENT_SCHEMA_VERSION = 8;

export type CreateProjectOptions = {
  title?: string;
  bpm?: number;
  key?: MusicalKey;
  scale?: ScaleName;
  timeSignature?: [number, number];
  lengthBars?: number;
  /** Injectable clock for createdAt/updatedAt. Defaults to the system clock. */
  clock?: Clock;
};

const DEFAULTS = {
  title: 'Untitled',
  bpm: 120,
  key: 'C' as MusicalKey,
  scale: 'major' as ScaleName,
  timeSignature: [4, 4] as [number, number],
  lengthBars: 8,
};

/** Create an empty MIDI/instrument track. */
export function createTrack(
  name: string,
  type: TrackType,
  instrument?: InstrumentConfig,
  color?: string,
  role: TrackRole = 'general',
): Track {
  return {
    id: makeId('track'),
    name,
    type,
    role,
    ...(color !== undefined ? { color } : {}),
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    ...(instrument !== undefined ? { instrument } : {}),
    effects: [],
  };
}

/** Create an empty MIDI clip covering [startBeat, startBeat + lengthBeats). */
export function createMidiClip(trackId: string, startBeat: number, lengthBeats: number): Clip {
  return {
    id: makeId('clip'),
    trackId,
    type: 'midi',
    startBeat,
    lengthBeats,
    loop: false,
    notes: [],
  };
}

/** Create an empty drum clip. */
export function createDrumClip(
  trackId: string,
  startBeat: number,
  lengthBeats: number,
  stepsPerBar = 16,
): Clip {
  return {
    id: makeId('clip'),
    trackId,
    type: 'drum',
    startBeat,
    lengthBeats,
    loop: false,
    stepsPerBar,
    drumEvents: [],
  };
}

/**
 * Create an empty project with sensible default tracks:
 * - "Chords" (chord-backing instrument)
 * - "Bass" (instrument)
 * - "Melody" (instrument)
 * - "Drums" (drum)
 * - "Master" (master bus)
 *
 * Each instrument/drum track receives one default empty clip covering the full
 * project length.
 */
export function createEmptyProject(options: CreateProjectOptions = {}): Project {
  const clock = options.clock ?? systemClock;
  const title = options.title ?? DEFAULTS.title;
  const bpm = options.bpm ?? DEFAULTS.bpm;
  const key = options.key ?? DEFAULTS.key;
  const scale = options.scale ?? DEFAULTS.scale;
  const requestedTimeSignature = options.timeSignature ?? DEFAULTS.timeSignature;
  const timeSignature: [number, number] = [
    requestedTimeSignature[0],
    requestedTimeSignature[1],
  ];
  const lengthBars = options.lengthBars ?? DEFAULTS.lengthBars;
  const lengthBeats = lengthBars * beatsPerBar(timeSignature);
  const timestamp = nowIso(clock);

  const chords = createTrack(
    'Chords',
    'instrument',
    { type: 'synth', preset: 'pad' },
    '#7c9cf0',
    'learning.chords',
  );
  const bass = createTrack(
    'Bass',
    'instrument',
    { type: 'synth', preset: 'bass' },
    '#f0a07c',
    'learning.bass',
  );
  const melody = createTrack(
    'Melody',
    'instrument',
    { type: 'synth', preset: 'lead' },
    '#7cf0a0',
    'learning.melody',
  );
  const drums = createTrack('Drums', 'drum', { type: 'drumkit', preset: 'acoustic' }, '#f07c9c');
  const master = createTrack('Master', 'master');

  chords.clips.push(createMidiClip(chords.id, 0, lengthBeats));
  bass.clips.push(createMidiClip(bass.id, 0, lengthBeats));
  melody.clips.push(createMidiClip(melody.id, 0, lengthBeats));
  drums.clips.push(createDrumClip(drums.id, 0, lengthBeats));

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
    audioTakeFolders: [],
    automationLanes: [],
    automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    audioRouting: {
      outputs: [chords, bass, melody, drums].map((track) => ({
        sourceTrackId: track.id,
        destination: { type: 'master' as const },
      })),
      sends: [],
    },
    tracks: [chords, bass, melody, drums, master],
    chordTrack: [],
    sections: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
