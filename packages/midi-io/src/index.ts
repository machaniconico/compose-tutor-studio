/**
 * @cts/midi-io — public API barrel.
 */

export {
  PPQ,
  MAX_MIDI_VAR_LEN,
  writeVarLen,
  buildTrackChunk,
  buildHeaderChunk,
  concatChunks,
  midiNoteName,
} from './smf.js';
export type { MidiMessage } from './smf.js';

export {
  projectToMidi,
  projectToMidiResult,
  exportProjectToMidi,
  exportNotesToMidi,
  MidiExportError,
  MAX_MIDI_EXPORT_EVENTS,
  volumeToCc,
  panToCc,
} from './export.js';
export type {
  MidiExportErrorCode,
  MidiExportFailure,
  MidiExportOptions,
  MidiExportResult,
} from './export.js';

export { parseMidiFile, MidiImportError, DEFAULT_MIDI_PARSE_LIMITS } from './import.js';
export type {
  ParsedMidiFile,
  ImportedMidiTrack,
  ImportedMidiNote,
  ImportedMidiTempoEvent,
  ImportedMidiTimeSignature,
  ImportedMidiMarker,
  ImportedMidiKeySignature,
  ImportedMidiInitialChannel,
  MidiImportErrorCode,
  MidiParseLimits,
  MidiParseOptions,
} from './import.js';
