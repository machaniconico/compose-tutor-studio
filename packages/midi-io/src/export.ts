/**
 * High-level MIDI export: converts a Project to Standard MIDI File (format 1)
 * bytes. See docs/02_feature_specification.md section 10 (Export).
 */

import type { Project, NoteEvent, DrumLane, Track, Clip } from '@cts/project-model';
import { beatsPerBar, expandClip } from '@cts/project-model';
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

/** Track name meta event (FF 03), UTF-8 so Japanese names such as "楽器 4" survive. */
function trackNameMeta(name: string): number[] {
  const encoded = utf8Bytes(name);
  return [0xff, 0x03, ...writeVarLen(encoded.length), ...encoded];
}

/** Marker meta event (FF 06) — used for chord symbols on the tempo track. */
function markerMeta(text: string): number[] {
  const encoded = utf8Bytes(text);
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

/** Encode text as UTF-8 byte values (ASCII text keeps its single bytes). */
function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
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
 * Append a clip's absolute-tick MIDI messages to `msgs`. The clip goes through
 * `expandClip`, so its length, loop and link rules match live playback and the
 * WAV render: a drum track sounds only drum hits (channel 9), any other track
 * only notes (the track channel), and nothing starting at or after the song
 * end (`songEndBeat`) sounds. Messages are appended one by one; a spread of a
 * long loop overflows the call stack.
 */
function appendClipMessages(
  msgs: MidiMessage[],
  clip: Clip,
  allClips: readonly Clip[],
  channel: number,
  ppq: number,
  bpb: number,
  trackType: Track['type'],
  songEndBeat: number,
): void {
  const { notes, drumHits } = expandClip(clip, allClips, bpb, trackType);

  for (const note of notes) {
    if (note.startBeat >= songEndBeat) continue;
    const startTick = Math.round(note.startBeat * ppq);
    // A note cut at the clip end can be shorter than a tick; keep it 1 tick
    // long so it is still written, as it still sounds live and in the WAV.
    const endTick = Math.max(startTick + 1, Math.round((note.startBeat + note.durationBeats) * ppq));
    const vel = clamp(Math.round(note.velocity), 0, 127);
    msgs.push({ tick: startTick, bytes: [0x90 | channel, note.pitch, vel] });
    msgs.push({ tick: endTick, bytes: [0x80 | channel, note.pitch, 0] });
  }

  for (const hit of drumHits) {
    if (hit.beat >= songEndBeat) continue;
    const pitch = DRUM_NOTE[hit.lane];
    const startTick = Math.round(hit.beat * ppq);
    const endTick = Math.round((hit.beat + DRUM_HIT_DURATION_BEATS) * ppq);
    const vel = clamp(Math.round(hit.velocity), 0, 127);
    msgs.push({ tick: startTick, bytes: [0x90 | DRUM_CHANNEL, pitch, vel] });
    msgs.push({ tick: endTick, bytes: [0x80 | DRUM_CHANNEL, pitch, 0] });
  }
}

/** Build one MTrk for an instrument/drum track, including CC7/CC10 at start. */
function buildInstrumentTrack(
  track: Track,
  allClips: readonly Clip[],
  channel: number,
  ppq: number,
  bpb: number,
  songEndBeat: number,
): Uint8Array {
  const msgs: MidiMessage[] = [
    { tick: 0, bytes: trackNameMeta(track.name) },
    { tick: 0, bytes: [0xb0 | channel, 7, volumeToCc(track.volume)] },
    { tick: 0, bytes: [0xb0 | channel, 10, panToCc(track.pan)] },
  ];

  for (const clip of track.clips) {
    appendClipMessages(msgs, clip, allClips, channel, ppq, bpb, track.type, songEndBeat);
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
 * (reserved for GM percussion), and wrap back to 0 after 15, so any number of
 * tracks keeps every status byte valid. Drum tracks always use channel 9.
 */
export function projectToMidi(project: Project, options?: { ppq?: number }): Uint8Array {
  const ppq = options?.ppq ?? PPQ;

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
    if (nextChannel > 15) nextChannel = 0; // wrap: MIDI has only channels 0-15
    if (nextChannel === DRUM_CHANNEL) nextChannel++; // skip channel 9
    return nextChannel++;
  };

  const bpb = beatsPerBar(project.timeSignature);
  // Same song end as live playback and the WAV render (scheduler projectLengthBeats).
  const songEndBeat = (project.lengthBars > 0 ? project.lengthBars : 0) * (bpb > 0 ? bpb : 4);
  const allClips = project.tracks.flatMap((track) => track.clips);
  for (const track of project.tracks) {
    if (track.type !== 'instrument' && track.type !== 'drum') continue;
    const channel = track.type === 'drum' ? DRUM_CHANNEL : allocChannel();
    trackChunks.push(buildInstrumentTrack(track, allClips, channel, ppq, bpb, songEndBeat));
  }

  const allTracks = [tempoTrack, ...trackChunks];
  // The SMF header stores the track count in 16 bits.
  if (allTracks.length > 0xffff) {
    throw new RangeError(`MIDI files hold at most 65535 tracks (this song needs ${allTracks.length})`);
  }
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
