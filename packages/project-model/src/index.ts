export * from './types';
export * from './clock';
export * from './time';
export * from './theory';
export * from './validation';
export * from './factories';
export * from './templates';
export * from './serialization';
export * from './mutations';
export * from './tapTempo';
// New deterministic id helper (counter-based, no Math.random/Date.now)
export * from './ids';
// New factory helpers (createDefaultProject, createInstrumentTrack, createDrumTrack,
// createNoteEvent, createChordEvent). createMidiClip/createDrumClip are already
// exported from ./factories so we select only the non-conflicting symbols.
export {
  createDefaultProject,
  createInstrumentTrack,
  createDrumTrack,
  createNoteEvent,
  createChordEvent,
} from './factory';
export type { CreateDefaultProjectOpts } from './factory';
export { DEFAULT_STEPS_PER_BAR, expandClip, placedNoteTicks, resolveLinkSource } from './clipExpand';
export * from './sounding';
export * from './groove';
export { songEndBeat as projectLengthBeats } from './sounding';
export * from './sections';
export * from './automation';
