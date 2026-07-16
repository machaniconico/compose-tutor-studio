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
  /** Per-hit playback chance, from 0 (never) to 1 (always). */
  probability?: number;
};

export type DrumGrooveSettings = {
  swing: number;
  probability: number;
  humanizeVelocity: number;
  seed: number;
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
  drumGroove?: DrumGrooveSettings;
  audioAssetId?: string;
  sourceStartFrame?: number;
  sourceFrameCount?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  gainDb?: number;
};

/** Schema-v3's required payload for an audio clip. */
export type AudioClip = Clip & {
  type: 'audio';
  audioAssetId: string;
  sourceStartFrame: number;
  sourceFrameCount: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  gainDb: number;
};

export type TrackType = 'instrument' | 'drum' | 'audio' | 'bus' | 'master';

export type TrackRole =
  | 'general'
  | 'learning.chords'
  | 'learning.bass'
  | 'learning.melody';

export type Track = {
  id: string;
  name: string;
  type: TrackType;
  role: TrackRole;
  color?: string;
  clips: Clip[];
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  instrument?: InstrumentConfig;
  effects: EffectConfig[];
};

export type TempoMapEvent = {
  id: string;
  beat: number;
  bpm: number;
};

export type TimeSignatureMapEvent = {
  id: string;
  beat: number;
  numerator: number;
  denominator: number;
};

export type ReadyAudioAsset = {
  id: string;
  availability: 'ready';
  checksumSha256: string;
  originalName: string;
  mediaType: 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/aac';
  byteLength: number;
  sampleRate: number;
  channelCount: number;
  frameCount: number;
};

export type UnresolvedAudioAsset = {
  id: string;
  availability: 'unresolved';
  legacyAssetId?: string;
  reason: 'legacy-reference' | 'missing-reference';
};

export type AudioAsset = ReadyAudioAsset | UnresolvedAudioAsset;

export type AutomationInterpolation = 'hold' | 'linear';

export type AutomationPoint = {
  id: string;
  beat: number;
  value: number;
  interpolation: AutomationInterpolation;
};

export type AutomationTarget = {
  type: 'track-volume' | 'track-pan';
  trackId: string;
};

export type AutomationLane = {
  id: string;
  target: AutomationTarget;
  points: AutomationPoint[];
};

/** A track's single main-output destination. Master is a logical sink. */
export type AudioRouteDestination =
  | { type: 'master' }
  | { type: 'bus'; trackId: string };

export type TrackOutputRoute = {
  sourceTrackId: string;
  destination: AudioRouteDestination;
};

export type AudioSendPosition = 'pre-fader' | 'post-fader';

export type AudioSend = {
  id: string;
  sourceTrackId: string;
  targetBusId: string;
  position: AudioSendPosition;
  /** Linear gain. Zero is silence; values above one provide makeup gain. */
  gain: number;
  enabled: boolean;
};

/** Normalized stereo audio-routing graph for every non-Master track. */
export type AudioRouting = {
  outputs: TrackOutputRoute[];
  sends: AudioSend[];
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
  lengthBeats: number;
  tempoMap: TempoMapEvent[];
  timeSignatureMap: TimeSignatureMapEvent[];
  audioAssets: AudioAsset[];
  automationLanes: AutomationLane[];
  audioRouting: AudioRouting;
  tracks: Track[];
  chordTrack: ChordEvent[];
  sections: Section[];
  createdAt: string;
  updatedAt: string;
};
