/**
 * High-level MIDI export: converts a Project to Standard MIDI File (format 1)
 * bytes. See docs/02_feature_specification.md section 10 (Export).
 */

import type { Project, NoteEvent, DrumLane, Track, Clip } from '@cts/project-model';
import {
  PPQ,
  writeVarLen,
  buildHeaderChunk,
  buildTrackChunk,
  concatChunks,
} from './smf.js';
import type { MidiMessage } from './smf.js';

/** GM percussion note numbers for each DrumLane (channel 9). */
const DRUM_NOTE: Record<DrumLane, number> = {
  kick: 36,
  snare: 38,
  closedHat: 42,
  openHat: 46,
  clap: 39,
  perc: 37,
};

/** Fixed sounding duration for a drum hit, in beats. */
const DRUM_HIT_DURATION_BEATS = 0.25; // 1/4 beat

/** GM percussion channel (0-indexed). */
const DRUM_CHANNEL = 9;

// --- Meta event builders ---

/** Track name meta event (FF 03). */
function trackNameMeta(name: string): number[] {
  const encoded = asciiBytes(name);
  return [0xff, 0x03, ...writeVarLen(encoded.length), ...encoded];
}

/** Marker meta event (FF 06) — used for chord symbols on the tempo track. */
function markerMeta(text: string): number[] {
  const encoded = asciiBytes(text);
  return [0xff, 0x06, ...writeVarLen(encoded.length), ...encoded];
}

/** Tempo meta event (FF 51 03) from BPM. */
function tempoMeta(bpm: number): number[] {
  const usPerBeat = Math.round(60_000_000 / bpm);
  return [
    0xff, 0x51, 0x03,
    (usPerBeat >>> 16) & 0xff,
    (usPerBeat >>> 8) & 0xff,
    usPerBeat & 0xff,
  ];
}

/** Time signature meta event (FF 58 04). */
function timeSigMeta(num: number, denom: number): number[] {
  const denomLog2 = Math.round(Math.log2(denom));
  return [0xff, 0x58, 0x04, num, denomLog2, 24, 8];
}

/** Encode an ASCII string to byte values (non-ASCII chars are masked to a byte). */
function asciiBytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    bytes.push(text.charCodeAt(i) & 0xff);
  }
  return bytes;
}

/** Clamp a number into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Map track volume (0..2) to a CC7 value (0..127). */
export function volumeToCc(volume: number): number {
  return Math.round(clamp(volume / 2, 0, 1) * 127);
}

/** Map track pan (-1..1) to a CC10 value (0..127, 64 = center). */
export function panToCc(pan: number): number {
  return Math.round((clamp(pan, -1, 1) + 1) / 2 * 127);
}

// --- Note / clip conversion ---

/**
 * Convert a single clip's notes into absolute-tick MIDI messages.
 * Honors `clip.loop`: when true, the clip's notes are unrolled across the clip
 * length (`clip.lengthBeats`) using the note pattern's natural length.
 */
function clipNotesToMessages(clip: Clip, channel: number, ppq: number): MidiMessage[] {
  const notes = clip.notes ?? [];
  if (notes.length === 0) return [];

  const msgs: MidiMessage[] = [];
  const emit = (note: NoteEvent, offsetBeats: number): void => {
    const startBeat = clip.startBeat + offsetBeats + note.startBeat;
    const endBeat = startBeat + note.durationBeats;
    const startTick = Math.round(startBeat * ppq);
    const endTick = Math.round(endBeat * ppq);
    const vel = clamp(Math.round(note.velocity), 0, 127);
    msgs.push({ tick: startTick, bytes: [0x90 | channel, note.pitch, vel] });
    msgs.push({ tick: endTick, bytes: [0x80 | channel, note.pitch, 0] });
  };

  if (clip.loop) {
    // Determine the pattern length, then unroll across clip.lengthBeats.
    const patternLength = notePatternLength(notes);
    if (patternLength <= 0) {
      for (const note of notes) emit(note, 0);
      return msgs;
    }
    for (let offset = 0; offset < clip.lengthBeats; offset += patternLength) {
      for (const note of notes) {
        if (offset + note.startBeat >= clip.lengthBeats) continue;
        emit(note, offset);
      }
    }
  } else {
    for (const note of notes) emit(note, 0);
  }
  return msgs;
}

/** Natural pattern length of a set of notes (max start+duration), in beats. */
function notePatternLength(notes: NoteEvent[]): number {
  let end = 0;
  for (const note of notes) {
    end = Math.max(end, note.startBeat + note.durationBeats);
  }
  return end;
}

/** Convert a drum clip's events into absolute-tick MIDI messages on channel 9. */
function clipDrumsToMessages(clip: Clip, ppq: number, beatsPerBar: number): MidiMessage[] {
  const events = clip.drumEvents ?? [];
  if (events.length === 0) return [];

  const clipStepsPerBar = clip.stepsPerBar ?? 16;
  const stepsPerBar = clipStepsPerBar > 0 ? clipStepsPerBar : 16;
  // A bar is divided into stepsPerBar steps and follows the project meter.
  const beatsPerStep = beatsPerBar / stepsPerBar;

  const msgs: MidiMessage[] = [];
  for (const evt of events) {
    const pitch = DRUM_NOTE[evt.lane];
    const startBeat = clip.startBeat + evt.stepIndex * beatsPerStep;
    const startTick = Math.round(startBeat * ppq);
    const endTick = Math.round((startBeat + DRUM_HIT_DURATION_BEATS) * ppq);
    const vel = clamp(Math.round(evt.velocity), 0, 127);
    msgs.push({ tick: startTick, bytes: [0x90 | DRUM_CHANNEL, pitch, vel] });
    msgs.push({ tick: endTick, bytes: [0x80 | DRUM_CHANNEL, pitch, 0] });
  }
  return msgs;
}

/** Build one MTrk for an instrument/drum track, including CC7/CC10 at start. */
function buildInstrumentTrack(track: Track, channel: number, ppq: number, beatsPerBar: number): Uint8Array {
  const msgs: MidiMessage[] = [
    { tick: 0, bytes: trackNameMeta(track.name) },
    { tick: 0, bytes: [0xb0 | channel, 7, volumeToCc(track.volume)] },
    { tick: 0, bytes: [0xb0 | channel, 10, panToCc(track.pan)] },
  ];

  for (const clip of track.clips) {
    if (clip.type === 'drum') {
      msgs.push(...clipDrumsToMessages(clip, ppq, beatsPerBar));
    } else {
      msgs.push(...clipNotesToMessages(clip, channel, ppq));
    }
  }
  return buildTrackChunk(msgs);
}

// --- Top-level export ---

/**
 * Export a Project to a Format-1 Standard MIDI File (Uint8Array).
 *
 * Track layout:
 *   - Track 0 (tempo track): track name, tempo, time signature, and chord
 *     symbols as marker meta events (FF 06) at each chord's startBeat.
 *   - One track per instrument/drum track, with CC7 (volume) and CC10 (pan)
 *     at the track start.
 *
 * Channels are assigned sequentially to non-drum tracks, skipping channel 9
 * (reserved for GM percussion). Drum tracks always use channel 9.
 */
export function projectToMidi(project: Project, options?: { ppq?: number }): Uint8Array {
  const ppq = options?.ppq ?? PPQ;
  const beatsPerBar = project.timeSignature[0] > 0 ? project.timeSignature[0] : 4;

  // --- Track 0: tempo / meta / chord markers ---
  const metaMessages: MidiMessage[] = [
    { tick: 0, bytes: trackNameMeta(project.title) },
    { tick: 0, bytes: tempoMeta(project.bpm) },
    { tick: 0, bytes: timeSigMeta(project.timeSignature[0], project.timeSignature[1]) },
  ];
  for (const chord of project.chordTrack) {
    metaMessages.push({ tick: Math.round(chord.startBeat * ppq), bytes: markerMeta(chord.symbol) });
  }
  const tempoTrack = buildTrackChunk(metaMessages);

  // --- One track per instrument/drum track ---
  const trackChunks: Uint8Array[] = [];
  let nextChannel = 0;
  const allocChannel = (): number => {
    if (nextChannel === DRUM_CHANNEL) nextChannel++; // skip channel 9
    return nextChannel++;
  };

  for (const track of project.tracks) {
    if (track.type !== 'instrument' && track.type !== 'drum') continue;
    const channel = track.type === 'drum' ? DRUM_CHANNEL : allocChannel();
    trackChunks.push(buildInstrumentTrack(track, channel, ppq, beatsPerBar));
  }

  const allTracks = [tempoTrack, ...trackChunks];
  const header = buildHeaderChunk(1, allTracks.length, ppq);
  return concatChunks(header, ...allTracks);
}

/**
 * @deprecated Use {@link projectToMidi}. Retained for backward compatibility.
 */
export const exportProjectToMidi = projectToMidi;

/**
 * Convenience export: a list of NoteEvents → single-track Format-0 MIDI.
 * Useful for quick previews of a single instrument part.
 */
export function exportNotesToMidi(
  notes: NoteEvent[],
  bpm: number,
  options?: { ppq?: number; channel?: number },
): Uint8Array {
  const ppq = options?.ppq ?? PPQ;
  const channel = options?.channel ?? 0;

  const msgs: MidiMessage[] = [{ tick: 0, bytes: tempoMeta(bpm) }];
  for (const note of notes) {
    const startTick = Math.round(note.startBeat * ppq);
    const endTick = Math.round((note.startBeat + note.durationBeats) * ppq);
    const vel = clamp(Math.round(note.velocity), 0, 127);
    msgs.push({ tick: startTick, bytes: [0x90 | channel, note.pitch, vel] });
    msgs.push({ tick: endTick, bytes: [0x80 | channel, note.pitch, 0] });
  }

  const track = buildTrackChunk(msgs);
  const header = buildHeaderChunk(0, 1, ppq);
  return concatChunks(header, track);
}
