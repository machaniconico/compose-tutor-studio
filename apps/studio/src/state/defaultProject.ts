// First-launch preview fixture for the studio.
//
// This intentionally contains a playable C-G-Am-F backing so the unsaved
// canvas is useful before a user chooses a workflow. User-requested blank
// projects use the canonical @cts/project-model `createEmptyProject` factory;
// composition templates use `instantiateTemplate`.

import type {
  ChordEvent,
  Clip,
  Project,
  Track,
} from '@cts/project-model';
import { CURRENT_SCHEMA_VERSION } from '@cts/project-model';
import { PITCH_CLASS } from './music';
import { nowIso, uid } from './ids';

const BEATS_PER_BAR = 4;
const DEFAULT_BARS = 8;
const DEFAULT_LENGTH_BEATS = DEFAULT_BARS * BEATS_PER_BAR;

/**
 * One-bar diatonic triad definitions for the C major preset progression.
 * `notes` are pitch classes (0-11), matching the canonical data model where
 * ChordEvent.notes is a number[] of pitch classes for the skeleton.
 */
const PRESET_PROGRESSION: ReadonlyArray<{
  symbol: string;
  root: string;
  quality: string;
  notes: number[];
  degree: string;
  function: ChordEvent['function'];
}> = [
  // C major: C E G
  {
    symbol: 'C',
    root: 'C',
    quality: 'major',
    notes: [PITCH_CLASS.C, PITCH_CLASS.E, PITCH_CLASS.G],
    degree: 'I',
    function: 'T',
  },
  // G major: G B D
  {
    symbol: 'G',
    root: 'G',
    quality: 'major',
    notes: [PITCH_CLASS.G, PITCH_CLASS.B, PITCH_CLASS.D],
    degree: 'V',
    function: 'D',
  },
  // A minor: A C E
  {
    symbol: 'Am',
    root: 'A',
    quality: 'minor',
    notes: [PITCH_CLASS.A, PITCH_CLASS.C, PITCH_CLASS.E],
    degree: 'vi',
    function: 'T',
  },
  // F major: F A C
  {
    symbol: 'F',
    root: 'F',
    quality: 'major',
    notes: [PITCH_CLASS.F, PITCH_CLASS.A, PITCH_CLASS.C],
    degree: 'IV',
    function: 'SD',
  },
];

/** Build the preset chord progression as ChordEvents spanning the project. */
function buildChordTrack(lengthBeats: number): ChordEvent[] {
  const chords: ChordEvent[] = [];
  let startBeat = 0;
  let index = 0;
  while (startBeat < lengthBeats) {
    const def = PRESET_PROGRESSION[index % PRESET_PROGRESSION.length];
    if (!def) break;
    chords.push({
      id: uid('chord'),
      startBeat,
      durationBeats: BEATS_PER_BAR,
      symbol: def.symbol,
      root: def.root,
      quality: def.quality,
      notes: [...def.notes],
      degree: def.degree,
      function: def.function,
    });
    startBeat += BEATS_PER_BAR;
    index += 1;
  }
  return chords;
}

/** Create one full-length empty MIDI clip for an instrument track. */
function emptyMidiClip(trackId: string, lengthBeats: number): Clip {
  return {
    id: uid('clip'),
    trackId,
    type: 'midi',
    startBeat: 0,
    lengthBeats,
    loop: false,
    notes: [],
  };
}

/** Create one full-length drum clip with a 16-step-per-bar grid. */
function emptyDrumClip(trackId: string, lengthBeats: number): Clip {
  return {
    id: uid('clip'),
    trackId,
    type: 'drum',
    startBeat: 0,
    lengthBeats,
    loop: false,
    drumEvents: [],
    stepsPerBar: 16,
  };
}

/** Build an instrument track with a single empty MIDI clip. */
function instrumentTrack(
  name: string,
  preset: string,
  color: string,
  lengthBeats: number,
  role: Track['role'] = 'general',
): Track {
  const id = uid('track');
  return {
    id,
    name,
    type: 'instrument',
    role,
    color,
    clips: [emptyMidiClip(id, lengthBeats)],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'synth', preset },
    effects: [],
  };
}

/** Build the drum track with a single empty drum clip. */
function drumTrack(lengthBeats: number): Track {
  const id = uid('track');
  return {
    id,
    name: 'Drums',
    type: 'drum',
    role: 'general',
    color: '#d98a4b',
    clips: [emptyDrumClip(id, lengthBeats)],
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'drumkit', preset: 'basic' },
    effects: [],
  };
}

/** Build the master track. */
function masterTrack(): Track {
  return {
    id: uid('track'),
    name: 'Master',
    type: 'master',
    role: 'general',
    color: '#7c83ff',
    clips: [],
    volume: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
}

/**
 * Create a default project: 120 BPM, C major, 4/4, 8 bars.
 * Tracks: Chords / Bass / Melody instrument tracks (each with one empty MIDI
 * clip), a Drums drum track (one drum clip, stepsPerBar 16), and a master
 * track. Includes the preset C - G - Am - F chord progression.
 */
export function createDefaultProject(title = '最初の1曲'): Project {
  const lengthBeats = DEFAULT_LENGTH_BEATS;
  const now = nowIso();
  const tracks = [
    instrumentTrack('Chords', 'warmPad', '#5bb0a8', lengthBeats, 'learning.chords'),
    instrumentTrack('Bass', 'subBass', '#c75b86', lengthBeats, 'learning.bass'),
    instrumentTrack('Melody', 'leadSine', '#6f9bd8', lengthBeats, 'learning.melody'),
    drumTrack(lengthBeats),
    masterTrack(),
  ];
  return {
    id: uid('project'),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title,
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: DEFAULT_BARS,
    lengthBeats,
    tempoMap: [{ id: uid('tempo'), beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: uid('signature'),
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    audioTakeFolders: [],
    automationLanes: [],
    audioRouting: {
      outputs: tracks
        .filter((track) => track.type !== 'master')
        .map((track) => ({
          sourceTrackId: track.id,
          destination: { type: 'master' as const },
        })),
      sends: [],
    },
    tracks,
    chordTrack: buildChordTrack(lengthBeats),
    sections: [
      {
        id: uid('section'),
        name: 'メイン',
        type: 'verse',
        startBar: 0,
        lengthBars: DEFAULT_BARS,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export { BEATS_PER_BAR, DEFAULT_BARS, DEFAULT_LENGTH_BEATS };
