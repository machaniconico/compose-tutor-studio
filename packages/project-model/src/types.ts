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

export type InstrumentConfig = {
  type: 'synth' | 'drumkit';
  preset: string;
  params?: Record<string, number>;
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
  loop: boolean;
  aliasOf?: string;
  notes?: NoteEvent[];
  drumEvents?: DrumEvent[];
  /** steps per bar for drum clips (default 16) */
  stepsPerBar?: number;
  audioAssetId?: string;
};

export type TrackType = 'instrument' | 'drum' | 'audio' | 'bus' | 'master';

export type Track = {
  id: string;
  name: string;
  type: TrackType;
  color?: string;
  clips: Clip[];
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  instrument?: InstrumentConfig;
  effects: EffectConfig[];
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
  tracks: Track[];
  chordTrack: ChordEvent[];
  sections: Section[];
  createdAt: string;
  updatedAt: string;
};
