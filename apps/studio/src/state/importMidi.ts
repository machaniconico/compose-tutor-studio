import { parseMidiFile, type ImportedMidiNote, type ParsedMidiFile } from '@cts/midi-io';
import type { Clip, NoteEvent, Project, Track } from '@cts/project-model';
import { uid } from './ids';
import { useStore } from './store';

const IMPORT_TRACK_COLOR = '#8b6dd8';
const IMPORT_TRACK_PRESET = 'brightPluck';
const MIN_CLIP_LENGTH_BEATS = 1;

export type ImportMidiIdFactory = (prefix: string) => string;

export type MidiImportMapping =
  | {
      ok: true;
      track: Track;
      clip: Clip;
      noteCount: number;
      lengthBeats: number;
      sourceTrackCount: number;
    }
  | {
      ok: false;
      message: string;
    };

export type MidiImportResult =
  | {
      ok: true;
      trackId: string;
      clipId: string;
      trackName: string;
      noteCount: number;
    }
  | {
      ok: false;
      message: string;
    };

type NormalizedNote = Omit<NoteEvent, 'id'>;

export type MapParsedMidiOptions = {
  makeId: ImportMidiIdFactory;
  trackName?: string;
  color?: string;
  preset?: string;
};

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeNote(note: ImportedMidiNote): NormalizedNote | null {
  if (!Number.isFinite(note.startBeat) || !Number.isFinite(note.durationBeat)) return null;
  if (note.durationBeat <= 0) return null;
  return {
    pitch: clampInteger(note.pitch, 0, 127),
    startBeat: Math.max(0, note.startBeat),
    durationBeats: note.durationBeat,
    velocity: clampInteger(note.velocity, 1, 127),
  };
}

function compareNotes(a: NormalizedNote, b: NormalizedNote): number {
  return a.startBeat - b.startBeat || a.pitch - b.pitch || b.velocity - a.velocity;
}

function importedLengthBeats(notes: readonly NormalizedNote[]): number {
  const endBeat = notes.reduce(
    (max, note) => Math.max(max, note.startBeat + note.durationBeats),
    0,
  );
  return Math.max(MIN_CLIP_LENGTH_BEATS, endBeat);
}

export function midiTrackName(fileName: string): string {
  const trimmed = fileName.trim();
  const stem = trimmed.replace(/\.(mid|midi)$/i, '').trim();
  return `MIDI: ${stem || '読み込みトラック'}`;
}

export function mapParsedMidiToTrack(
  parsed: ParsedMidiFile,
  options: MapParsedMidiOptions,
): MidiImportMapping {
  const notes = parsed.tracks
    .flatMap((track) => track.notes)
    .map(normalizeNote)
    .filter((note): note is NormalizedNote => note !== null)
    .sort(compareNotes);

  if (notes.length === 0) {
    return {
      ok: false,
      message: 'このMIDIには読み込めるノートがありません。別の.midファイルを選んでください。',
    };
  }

  const trackId = options.makeId('track');
  const clipId = options.makeId('clip');
  const noteEvents: NoteEvent[] = notes.map((note) => ({
    id: options.makeId('note'),
    ...note,
  }));
  const lengthBeats = importedLengthBeats(notes);
  const clip: Clip = {
    id: clipId,
    trackId,
    type: 'midi',
    startBeat: 0,
    lengthBeats,
    loop: false,
    notes: noteEvents,
  };
  const track: Track = {
    id: trackId,
    name: options.trackName ?? 'MIDI: 読み込みトラック',
    type: 'instrument',
    color: options.color ?? IMPORT_TRACK_COLOR,
    clips: [clip],
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'synth', preset: options.preset ?? IMPORT_TRACK_PRESET },
    effects: [],
  };

  return {
    ok: true,
    track,
    clip,
    noteCount: noteEvents.length,
    lengthBeats,
    sourceTrackCount: parsed.tracks.length,
  };
}

function insertBeforeMaster(tracks: readonly Track[], importedTrack: Track): Track[] {
  const masterIndex = tracks.findIndex((track) => track.type === 'master');
  if (masterIndex < 0) return [...tracks, importedTrack];
  return [
    ...tracks.slice(0, masterIndex),
    importedTrack,
    ...tracks.slice(masterIndex),
  ];
}

function beatsPerBar(project: Project): number {
  const [numerator, denominator] = project.timeSignature;
  if (numerator <= 0 || denominator <= 0) return 4;
  return numerator * (4 / denominator);
}

export function appendImportedMidiTrack(project: Project, importedTrack: Track): Project {
  const longestClipEnd = importedTrack.clips.reduce(
    (max, clip) => Math.max(max, clip.startBeat + clip.lengthBeats),
    0,
  );
  const requiredBars = Math.max(1, Math.ceil(longestClipEnd / beatsPerBar(project)));
  return {
    ...project,
    lengthBars: Math.max(project.lengthBars, requiredBars),
    tracks: insertBeforeMaster(project.tracks, importedTrack),
  };
}

export async function importMidiFile(file: File): Promise<MidiImportResult> {
  if (file.size === 0) {
    return { ok: false, message: 'ファイルが空です。.midファイルを選んでください。' };
  }

  let parsed: ParsedMidiFile;
  try {
    parsed = parseMidiFile(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return {
      ok: false,
      message: 'MIDIファイルを読み込めませんでした。壊れているか、対応していない形式かもしれません。',
    };
  }

  const mapped = mapParsedMidiToTrack(parsed, {
    makeId: uid,
    trackName: midiTrackName(file.name),
  });
  if (!mapped.ok) return mapped;

  const store = useStore.getState();
  store.applyProjectChange((project) => appendImportedMidiTrack(project, mapped.track));
  store.selectTrack(mapped.track.id);
  store.selectClip(mapped.clip.id);
  store.selectNotes([]);
  store.setActiveView('pianoRoll');

  return {
    ok: true,
    trackId: mapped.track.id,
    clipId: mapped.clip.id,
    trackName: mapped.track.name,
    noteCount: mapped.noteCount,
  };
}
