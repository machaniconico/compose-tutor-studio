// Bundled sample song for the start screen's "サンプルプロジェクトを聴く" entry.
//
// The whole song is defined in code (no external assets): 8 bars of C-major
// pop at 120 BPM with the classic C - G - Am - F progression, a root-note
// bass, a simple stepwise melody, and an eight-beat drum pattern. Melody and
// bass put chord tones on the strong beats so every note can be explained by
// the inspector.

import type {
  ChordEvent,
  Clip,
  DrumEvent,
  DrumLane,
  NoteEvent,
  Project,
  Track,
} from '@cts/project-model';
import { PITCH_CLASS } from './music';
import { nowIso, uid } from './ids';

const BEATS_PER_BAR = 4;
const BARS = 8;
const LENGTH_BEATS = BARS * BEATS_PER_BAR;
const STEPS_PER_BAR = 16;

export const SAMPLE_PROJECT_TITLE = 'サンプル曲：はじめてのポップス';

// ---------------------------------------------------------------------------
// Chord track: C - G - Am - F, one chord per bar, repeated twice.
// ---------------------------------------------------------------------------

const PROGRESSION: ReadonlyArray<{
  symbol: string;
  root: string;
  quality: string;
  notes: number[];
  degree: string;
  function: ChordEvent['function'];
}> = [
  {
    symbol: 'C',
    root: 'C',
    quality: 'major',
    notes: [PITCH_CLASS.C, PITCH_CLASS.E, PITCH_CLASS.G],
    degree: 'I',
    function: 'T',
  },
  {
    symbol: 'G',
    root: 'G',
    quality: 'major',
    notes: [PITCH_CLASS.G, PITCH_CLASS.B, PITCH_CLASS.D],
    degree: 'V',
    function: 'D',
  },
  {
    symbol: 'Am',
    root: 'A',
    quality: 'minor',
    notes: [PITCH_CLASS.A, PITCH_CLASS.C, PITCH_CLASS.E],
    degree: 'vi',
    function: 'T',
  },
  {
    symbol: 'F',
    root: 'F',
    quality: 'major',
    notes: [PITCH_CLASS.F, PITCH_CLASS.A, PITCH_CLASS.C],
    degree: 'IV',
    function: 'SD',
  },
];

function buildChordTrack(): ChordEvent[] {
  const chords: ChordEvent[] = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    const def = PROGRESSION[bar % PROGRESSION.length];
    if (!def) break;
    chords.push({
      id: uid('chord'),
      startBeat: bar * BEATS_PER_BAR,
      durationBeats: BEATS_PER_BAR,
      symbol: def.symbol,
      root: def.root,
      quality: def.quality,
      notes: [...def.notes],
      degree: def.degree,
      function: def.function,
    });
  }
  return chords;
}

// ---------------------------------------------------------------------------
// Note data. `[pitch, startBeatInBar, durationBeats]` per bar keeps the song
// readable; pitches are octave-specific MIDI notes (C4 = 60).
// ---------------------------------------------------------------------------

type BarNotes = ReadonlyArray<readonly [pitch: number, start: number, duration: number]>;

/**
 * Chord-pad part: block triads (one per bar) around C4 with smooth voice
 * leading. Voicings: C(E-G-C) / G(D-G-B) / Am(C-E-A) / F(C-F-A).
 */
const PAD_BARS: ReadonlyArray<BarNotes> = [
  [
    [64, 0, 4],
    [67, 0, 4],
    [72, 0, 4],
  ],
  [
    [62, 0, 4],
    [67, 0, 4],
    [71, 0, 4],
  ],
  [
    [60, 0, 4],
    [64, 0, 4],
    [69, 0, 4],
  ],
  [
    [60, 0, 4],
    [65, 0, 4],
    [69, 0, 4],
  ],
];

/** Bass part: chord roots in octave 2, two half notes per bar. */
const BASS_ROOTS = [36, 43, 45, 41]; // C2 G2 A2 F2

/**
 * Melody: two 4-bar phrases. Strong beats land on chord tones; the few
 * in-between notes are diatonic passing tones, so the line stays singable.
 */
const MELODY_BARS: ReadonlyArray<BarNotes> = [
  // Phrase 1 (bars 1-4): rises, then settles onto F.
  [
    [60, 0, 1],
    [64, 1, 1],
    [67, 2, 2],
  ], // C: C4 E4 G4
  [
    [67, 0, 1],
    [62, 1, 1],
    [59, 2, 2],
  ], // G: G4 D4 B3
  [
    [57, 0, 1],
    [60, 1, 1],
    [64, 2, 2],
  ], // Am: A3 C4 E4
  [
    [65, 0, 1],
    [69, 1, 1],
    [65, 2, 2],
  ], // F: F4 A4 F4
  // Phrase 2 (bars 5-8): reaches the high C, then walks home to C4.
  [
    [64, 0, 1],
    [67, 1, 1],
    [72, 2, 2],
  ], // C: E4 G4 C5
  [
    [71, 0, 1],
    [67, 1, 1],
    [62, 2, 2],
  ], // G: B4 G4 D4
  [
    [64, 0, 1],
    [62, 1, 1],
    [60, 2, 2],
  ], // Am: E4 D4(経過音) C4
  [
    [65, 0, 1],
    [62, 1, 1],
    [60, 2, 2],
  ], // F: F4 D4(経過音) C4
];

function notesFromBars(bars: ReadonlyArray<BarNotes>, velocity: number): NoteEvent[] {
  const notes: NoteEvent[] = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    const defs = bars[bar % bars.length] ?? [];
    for (const [pitch, start, duration] of defs) {
      notes.push({
        id: uid('note'),
        pitch,
        startBeat: bar * BEATS_PER_BAR + start,
        durationBeats: duration,
        velocity,
      });
    }
  }
  return notes;
}

function bassNotes(): NoteEvent[] {
  const notes: NoteEvent[] = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    const pitch = BASS_ROOTS[bar % BASS_ROOTS.length] ?? 36;
    for (const start of [0, 2]) {
      notes.push({
        id: uid('note'),
        pitch,
        startBeat: bar * BEATS_PER_BAR + start,
        durationBeats: 2,
        velocity: 96,
      });
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Drums: standard eight-beat, one bar repeated across the song.
// ---------------------------------------------------------------------------

const DRUM_BAR: ReadonlyArray<{ lane: DrumLane; step: number; velocity: number }> = [
  { lane: 'kick', step: 0, velocity: 110 },
  { lane: 'kick', step: 8, velocity: 105 },
  { lane: 'snare', step: 4, velocity: 108 },
  { lane: 'snare', step: 12, velocity: 108 },
  { lane: 'closedHat', step: 0, velocity: 88 },
  { lane: 'closedHat', step: 2, velocity: 80 },
  { lane: 'closedHat', step: 4, velocity: 88 },
  { lane: 'closedHat', step: 6, velocity: 80 },
  { lane: 'closedHat', step: 8, velocity: 88 },
  { lane: 'closedHat', step: 10, velocity: 80 },
  { lane: 'closedHat', step: 12, velocity: 88 },
  { lane: 'closedHat', step: 14, velocity: 80 },
];

function drumEvents(): DrumEvent[] {
  const events: DrumEvent[] = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    for (const hit of DRUM_BAR) {
      events.push({
        id: uid('drum'),
        lane: hit.lane,
        stepIndex: bar * STEPS_PER_BAR + hit.step,
        velocity: hit.velocity,
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Track / clip assembly.
// ---------------------------------------------------------------------------

function midiClip(trackId: string, notes: NoteEvent[]): Clip {
  return {
    id: uid('clip'),
    trackId,
    type: 'midi',
    startBeat: 0,
    lengthBeats: LENGTH_BEATS,
    loop: false,
    notes,
  };
}

function instrumentTrack(
  name: string,
  preset: string,
  color: string,
  notes: NoteEvent[],
  volume: number,
): Track {
  const id = uid('track');
  return {
    id,
    name,
    type: 'instrument',
    color,
    clips: [midiClip(id, notes)],
    volume,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'synth', preset },
    effects: [],
  };
}

function drumTrack(): Track {
  const id = uid('track');
  return {
    id,
    name: 'Drums',
    type: 'drum',
    color: '#d98a4b',
    clips: [
      {
        id: uid('clip'),
        trackId: id,
        type: 'drum',
        startBeat: 0,
        lengthBeats: LENGTH_BEATS,
        loop: false,
        drumEvents: drumEvents(),
        stepsPerBar: STEPS_PER_BAR,
      },
    ],
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'drumkit', preset: 'basic' },
    effects: [],
  };
}

function masterTrack(): Track {
  return {
    id: uid('track'),
    name: 'Master',
    type: 'master',
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
 * Build the 8-bar sample song (120 BPM, C major, 4/4).
 * Every call returns a fresh Project with new ids, ready to audition.
 */
export function createSampleProject(): Project {
  const now = nowIso();
  return {
    id: uid('project'),
    schemaVersion: 1,
    title: SAMPLE_PROJECT_TITLE,
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: BARS,
    tracks: [
      instrumentTrack('Chords', 'warmPad', '#5bb0a8', notesFromBars(PAD_BARS, 72), 0.7),
      instrumentTrack('Bass', 'subBass', '#c75b86', bassNotes(), 0.8),
      instrumentTrack('Melody', 'leadSine', '#6f9bd8', notesFromBars(MELODY_BARS, 100), 0.85),
      drumTrack(),
      masterTrack(),
    ],
    chordTrack: buildChordTrack(),
    sections: [
      {
        id: uid('section'),
        name: 'メイン',
        type: 'verse',
        startBar: 0,
        lengthBars: BARS,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
