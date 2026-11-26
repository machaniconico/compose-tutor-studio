/**
 * High-level MIDI export: converts a Project to Standard MIDI File (format 1)
 * bytes. See docs/02_feature_specification.md section 10 (Export).
 */

import type { Project, NoteEvent, DrumLane, Track, SoundingEvent } from '@cts/project-model';
import { projectLengthBeats, soundingEvents } from '@cts/project-model';
import {
  PPQ,
  writeVarLen,
  buildHeaderChunk,
  buildTrackChunk,
  concatChunks,
  joinChunks,
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

/** Maximum value of the SMF header's 16-bit track count. */
const MAX_SMF_TRACKS = 0xffff;

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
 * Note-on/off pair at the export resolution. The off lands at least one tick
 * after the on, since a coarser `ppq` can round a short note to zero length.
 */
function noteMessages(
  channel: number,
  pitch: number,
  velocity: number,
  startBeat: number,
  durationBeats: number,
  ppq: number,
  endLimitTick = Infinity,
): [MidiMessage, MidiMessage] | [] {
  const startTick = Math.round(startBeat * ppq);
  // At a coarser ppq a note just before the song end can round onto it (D3): drop it,
  // and never let the off pass the song end.
  if (startTick >= endLimitTick) return [];
  const endTick = Math.min(endLimitTick, Math.max(startTick + 1, Math.round((startBeat + durationBeats) * ppq)));
  return [
    { tick: startTick, bytes: [0x90 | channel, pitch, velocity] },
    { tick: endTick, bytes: [0x80 | channel, pitch, 0] },
  ];
}

/** Build one MTrk for an instrument/drum track, including CC7/CC10 at start. */
function buildInstrumentTrack(
  track: Track,
  events: readonly SoundingEvent[],
  channel: number,
  ppq: number,
  endLimitTick: number,
): Uint8Array {
  const msgs: MidiMessage[] = [
    { tick: 0, bytes: trackNameMeta(track.name) },
    { tick: 0, bytes: [0xb0 | channel, 7, volumeToCc(track.volume)] },
    { tick: 0, bytes: [0xb0 | channel, 10, panToCc(track.pan)] },
  ];
  for (const event of events) {
    const pitch = event.kind === 'note' ? event.pitch : DRUM_NOTE[event.lane];
    const duration = event.kind === 'note' ? event.durationBeats : DRUM_HIT_DURATION_BEATS;
    msgs.push(...noteMessages(channel, pitch, event.velocity, event.startBeat, duration, ppq, endLimitTick));
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
 *     at the track start. If the full layout exceeds the SMF track limit,
 *     only instrument/drum tracks with sounding events are written.
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

  const playableTracks = project.tracks.filter(
    (track) => track.type === 'instrument' || track.type === 'drum',
  );
  const omitSilentTracks = playableTracks.length + 1 > MAX_SMF_TRACKS;
  let nextChannel = 0;
  const allocChannel = (): number => {
    if (nextChannel > 15) nextChannel = 0; // wrap: MIDI has only channels 0-15
    if (nextChannel === DRUM_CHANNEL) nextChannel++; // skip channel 9
    return nextChannel++;
  };

  const byTrack = new Map<string, SoundingEvent[]>();
  for (const event of soundingEvents(project).events) {
    const events = byTrack.get(event.trackId);
    if (events) events.push(event);
    else byTrack.set(event.trackId, [event]);
  }
  const endLimitTick = Math.round(projectLengthBeats(project) * ppq);
  const trackChunks = [tempoTrack];
  for (const track of playableTracks) {
    const channel = track.type === 'drum' ? DRUM_CHANNEL : allocChannel();
    const events = byTrack.get(track.id);
    if (omitSilentTracks && events === undefined) continue;
    trackChunks.push(buildInstrumentTrack(track, events ?? [], channel, ppq, endLimitTick));
  }

  if (trackChunks.length > MAX_SMF_TRACKS) {
    throw new RangeError(`MIDI files hold at most ${MAX_SMF_TRACKS} tracks (this song needs ${trackChunks.length})`);
  }
  const header = buildHeaderChunk(1, trackChunks.length, ppq);
  return joinChunks([header, ...trackChunks]);
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
    const vel = clamp(Math.round(note.velocity), 0, 127);
    msgs.push(...noteMessages(channel, note.pitch, vel, note.startBeat, note.durationBeats, ppq));
  }

  const track = buildTrackChunk(msgs);
  const header = buildHeaderChunk(0, 1, ppq);
  return concatChunks(header, track);
}
