// Canonical project data model. See docs/06_data_model.md.

export type PitchClassName =
  | 'C' | 'C#' | 'Db' | 'D' | 'D#' | 'Eb' | 'E' | 'F' | 'F#' | 'Gb'
  | 'G' | 'G#' | 'Ab' | 'A' | 'A#' | 'Bb' | 'B';

export type MusicalKey = PitchClassName;

export type ScaleName =
  | 'major'
  | 'naturalMinor'
  | 'harmonicMinor'
  | 'melodicMinor'
  | 'majorPentatonic'
  | 'minorPentatonic'
  | 'blues';

export type SectionType = 'intro' | 'verse' | 'preChorus' | 'chorus' | 'bridge' | 'outro';

export type Section = {
  id: string;
  name: string;
  type: SectionType;
  startBar: number;
  lengthBars: number;
};

/**
 * Beginner sound macros, each 0..1. Optional: a track without them plays the
 * preset unchanged (no schema version bump).
 */
export type InstrumentMacros = {
  /** High-frequency content (filter cutoff). */
  brightness: number;
  /** How long the sound lingers after note-off. */
  release: number;
  /** Left/right spread. */
  width: number;
  /** How quickly the sound starts. */
  attack: number;
};

export type InstrumentConfig = {
  type: 'synth' | 'drumkit';
  preset: string;
  params?: Record<string, number>;
  macros?: InstrumentMacros;
};

export type EffectType = 'filter' | 'delay' | 'reverb' | 'compressor' | 'eq';

export type EffectConfig = {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number>;
};

export type NoteEvent = {
  id: string;
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
};

export type DrumLane = 'kick' | 'snare' | 'closedHat' | 'openHat' | 'clap' | 'perc';

export type DrumEvent = {
  id: string;
  lane: DrumLane;
  stepIndex: number;
  velocity: number;
};

export type ChordFunction = 'T' | 'SD' | 'D' | 'Other';

export type ChordEvent = {
  id: string;
  startBeat: number;
  durationBeats: number;
  symbol: string;
  root: string;
  quality: string;
  notes: number[];
  degree?: string;
  function?: ChordFunction;
  tags?: string[];
};

export type ClipType = 'midi' | 'drum' | 'audio' | 'automation';

export type Clip = {
  id: string;
  trackId: string;
  type: ClipType;
  startBeat: number;
  lengthBeats: number;
  /** Loop period in beats. Unset means the content repeats every `lengthBeats`. */
  contentLengthBeats?: number;
  loop: boolean;
  aliasOf?: string;
  /** Original settings from files saved before playback supported loops and links. */
  legacyClipSettings?: Pick<Clip, 'loop' | 'aliasOf' | 'contentLengthBeats'>;
  notes?: NoteEvent[];
  drumEvents?: DrumEvent[];
  /** steps per bar for drum clips (default 16) */
  stepsPerBar?: number;
  audioAssetId?: string;
};

export const MAX_RETURN_TRACKS = 2;

export type TrackType = 'instrument' | 'drum' | 'audio' | 'bus' | 'master';

export type TrackRole = 'chords' | 'bass' | 'melody' | 'drums';

export type AutomationPoint = { beat: number; value: number };
export type AutomationLane = { points: AutomationPoint[] };

export type Track = {
  id: string;
  name: string;
  type: TrackType;
  role?: TrackRole;
  color?: string;
  clips: Clip[];
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  instrument?: InstrumentConfig;
  effects: EffectConfig[];
  automation?: { volume?: AutomationLane };
  /** Post-fader send levels (0–1), keyed by return track id. */
  sends?: Record<string, number>;
};

export type Project = {
  id: string;
  schemaVersion: number;
  title: string;
  bpm: number;
  timeSignature: [number, number];
  key: MusicalKey;
  scale: ScaleName;
  lengthBars: number;
  /** Converted v1 song length when it exceeds the standard bar limit. */
  legacyBarLimit?: number;
  /** Beat range repeated during playback. */
  loopRange?: { startBeat: number; endBeat: number };
  /** Swing amount, 0 to 60. Unset means 0. */
  swing?: number;
  tracks: Track[];
  chordTrack: ChordEvent[];
  sections: Section[];
  createdAt: string;
  updatedAt: string;
};
