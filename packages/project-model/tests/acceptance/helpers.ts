// Shared helpers for the US-007a / US-007b acceptance tests.
//
// CONTRACT (implementers must follow; see report):
//   import { PPQ, MIN_LOOP_PERIOD_BEATS, MAX_SONG_BARS, MAX_SOUNDING_EVENTS,
//            soundingEvents, songEndBeat, storedEventAt } from 'src/sounding'
//   SoundingEvent = { kind: 'note' | 'drum'; trackId; clipId; sourceClipId; sourceIndex; repeat;
//                     startBeat (absolute); durationBeats (note); pitch (note); lane (drum); velocity }
//   sourceIndex indexes source.notes (kind 'note') or source.drumEvents (kind 'drum').
import { PPQ } from '../../src/sounding';
import { MIN_LOOP_PERIOD_BEATS } from '../../src/sounding';
import type { Clip, DrumLane, Project, Track } from '../../src/index';

export { PPQ, MIN_LOOP_PERIOD_BEATS };

/** Small seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;
const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

const LANES: DrumLane[] = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'];

/** Beat value that is a whole number of 1/8 beats (always a whole tick for PPQ multiple of 8). */
const eighths = (n: number): number => n / 8;

export type GenOptions = { allowOverrunSongEnd?: boolean };

/**
 * A project inside the validation domain: loop period >= MIN_LOOP_PERIOD_BEATS, links depth 1 with
 * no own content and the same kind as their source, no overlaps on a track, bounded song length.
 * Clips may extend past the song end and notes may cross it (to exercise D3).
 */
export function generateProject(seed: number, opts: GenOptions = {}): Project {
  const r = mulberry32(seed);
  const ts: [number, number] = pick(r, [[4, 4], [3, 4], [4, 4]] as [number, number][]);
  const bpb = ts[0] * (4 / ts[1]);
  const lengthBars = int(r, 2, 12);
  const songBeats = lengthBars * bpb;
  const tracks: Track[] = [];
  const kinds: Array<'instrument' | 'drum'> = ['instrument', 'drum', 'instrument', 'drum'].slice(0, int(r, 2, 4)) as Array<'instrument' | 'drum'>;
  const sources: Array<{ clip: Clip; kind: 'instrument' | 'drum' }> = [];
  let noteSeq = 0;
  let clipSeq = 0;
  kinds.forEach((kind, ti) => {
    const trackId = `t${ti}`;
    const clips: Clip[] = [];
    let cursor = eighths(int(r, 0, 8));
    const count = int(r, 1, 4);
    for (let ci = 0; ci < count; ci++) {
      const length = eighths(int(r, 4, 64));
      if (cursor >= songBeats + (opts.allowOverrunSongEnd === false ? 0 : bpb)) break;
      if (opts.allowOverrunSongEnd === false && cursor + length > songBeats) break;
      const id = `c${clipSeq++}`;
      const loop = r() < 0.4;
      const period = loop ? Math.max(MIN_LOOP_PERIOD_BEATS, pick(r, [0.25, 0.5, 1, 1.5, 2, 4])) : undefined;
      const base: Clip = {
        id,
        trackId,
        type: kind === 'drum' ? 'drum' : 'midi',
        startBeat: cursor,
        lengthBeats: length,
        loop,
        ...(period !== undefined && r() < 0.8 ? { contentLengthBeats: period } : {}),
      };
      const span = (loop ? (period ?? length) : length) + 1; // some content falls outside on purpose
      const n = int(r, 0, 6);
      if (kind === 'drum') {
        base.stepsPerBar = 16;
        base.drumEvents = Array.from({ length: n }, () => ({
          id: `d${noteSeq++}`,
          lane: pick(r, LANES),
          stepIndex: int(r, 0, Math.max(0, Math.floor((span * 16) / bpb))),
          velocity: int(r, 1, 127),
        }));
      } else {
        base.notes = Array.from({ length: n }, () => ({
          id: `n${noteSeq++}`,
          pitch: int(r, 36, 96),
          startBeat: eighths(int(r, 0, Math.floor(span * 8))),
          durationBeats: eighths(int(r, 1, 24)),
          velocity: int(r, 1, 127),
        }));
      }
      clips.push(base);
      sources.push({ clip: base, kind });
      cursor += length + eighths(int(r, 0, 8)); // never overlaps
    }
    tracks.push({
      id: trackId,
      name: kind === 'drum' ? 'Drums' : `Inst ${ti}`,
      type: kind,
      clips,
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
      ...(kind === 'instrument' ? { instrument: { type: 'synth' as const, preset: 'warmPad' } } : {}),
    });
  });
  // Links: depth 1 (a link never points at a link), no own content, same kind, own loop settings.
  const linkSources = sources.filter((s) => (s.clip.notes?.length ?? 0) + (s.clip.drumEvents?.length ?? 0) > 0);
  for (const track of tracks) {
    if (linkSources.length === 0 || r() < 0.4) continue;
    const candidates = linkSources.filter((s) => s.kind === track.type);
    if (candidates.length === 0) continue;
    const src = pick(r, candidates).clip;
    const last = track.clips[track.clips.length - 1];
    const start = (last ? last.startBeat + last.lengthBeats : 0) + eighths(int(r, 0, 8));
    if (start >= songBeats) continue;
    const loop = r() < 0.4;
    const link: Clip = {
      id: `c${clipSeq++}`,
      trackId: track.id,
      type: src.type,
      startBeat: start,
      lengthBeats: eighths(int(r, 4, 48)),
      loop,
      aliasOf: src.id,
      ...(loop ? { contentLengthBeats: Math.max(MIN_LOOP_PERIOD_BEATS, pick(r, [0.5, 1, 2, 4])) } : {}),
      ...(src.stepsPerBar !== undefined ? { stepsPerBar: src.stepsPerBar } : {}),
    };
    track.clips.push(link);
  }
  return {
    id: `gen-${seed}`,
    schemaVersion: 3,
    title: `generated ${seed}`,
    bpm: int(r, 60, 180),
    timeSignature: ts,
    key: 'C',
    scale: 'major',
    lengthBars,
    tracks,
    chordTrack: [],
    sections: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export const SEEDS = Array.from({ length: 500 }, (_, i) => 1000 + i);

/** Hand-built project: tracks are given by the caller. */
export function makeProject(tracks: Track[], over: Partial<Project> = {}): Project {
  return {
    id: 'hand',
    schemaVersion: 3,
    title: 'hand',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    tracks,
    chordTrack: [],
    sections: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function makeTrack(id: string, type: 'instrument' | 'drum', clips: Clip[]): Track {
  return {
    id,
    name: id,
    type,
    clips,
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    ...(type === 'instrument' ? { instrument: { type: 'synth' as const, preset: 'warmPad' } } : {}),
  };
}

export function midiClip(id: string, trackId: string, startBeat: number, lengthBeats: number, notes: Array<[number, number, number]>, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    trackId,
    type: 'midi',
    startBeat,
    lengthBeats,
    loop: false,
    notes: notes.map(([startBeat, durationBeats, pitch], i) => ({ id: `${id}-n${i}`, pitch, startBeat, durationBeats, velocity: 100 })),
    ...extra,
  };
}

export function drumClip(id: string, trackId: string, startBeat: number, lengthBeats: number, hits: Array<[number, DrumLane]>, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    trackId,
    type: 'drum',
    startBeat,
    lengthBeats,
    loop: false,
    stepsPerBar: 16,
    drumEvents: hits.map(([stepIndex, lane], i) => ({ id: `${id}-d${i}`, lane, stepIndex, velocity: 100 })),
    ...extra,
  };
}

// --- Normalised event keys (the one adapter between event shapes and the tests) ---

export const GM_DRUM_LANE: Record<number, DrumLane> = { 36: 'kick', 38: 'snare', 42: 'closedHat', 46: 'openHat', 39: 'clap', 37: 'perc' };

export const tickOf = (beat: number): number => Math.round(beat * PPQ);
/** A note is at least 1 tick long, as in the MIDI writer. */
export const noteEndTick = (startBeat: number, durationBeats: number): number =>
  Math.max(tickOf(startBeat) + 1, tickOf(startBeat + durationBeats));

export type Onset = { kind: 'note' | 'drum'; trackId: string; tick: number; what: string | number; velocity: number };
export type Offset = { trackId: string; tick: number; pitch: number };

export const onsetKey = (o: Onset): string => `${o.kind}|${o.trackId}|${o.tick}|${o.what}|${o.velocity}`;
export const offsetKey = (o: Offset): string => `${o.trackId}|${o.tick}|${o.pitch}`;
export const sorted = (xs: string[]): string[] => [...xs].sort();

type AnySounding = {
  kind: 'note' | 'drum';
  trackId: string;
  startBeat: number;
  durationBeats?: number;
  pitch?: number;
  lane?: string;
  velocity: number;
};

export function fromSounding(events: readonly AnySounding[]): { ons: string[]; offs: string[] } {
  const ons: string[] = [];
  const offs: string[] = [];
  for (const e of events) {
    if (e.kind === 'note') {
      ons.push(onsetKey({ kind: 'note', trackId: e.trackId, tick: tickOf(e.startBeat), what: e.pitch as number, velocity: e.velocity }));
      offs.push(offsetKey({ trackId: e.trackId, tick: noteEndTick(e.startBeat, e.durationBeats as number), pitch: e.pitch as number }));
    } else {
      ons.push(onsetKey({ kind: 'drum', trackId: e.trackId, tick: tickOf(e.startBeat), what: e.lane as string, velocity: e.velocity }));
    }
  }
  return { ons: sorted(ons), offs: sorted(offs) };
}

/** Live schedule events (events.ts) or WAV events (DueEvent[]): { beat, payload }. */
export function fromScheduled(events: ReadonlyArray<{ beat: number; payload: unknown }>): { ons: string[]; offs: string[] } {
  const flat: AnySounding[] = events.map((e) => {
    const p = e.payload as { kind: 'note' | 'drum'; trackId: string; pitch?: number; lane?: string; durationBeats?: number; velocity: number };
    return { kind: p.kind, trackId: p.trackId, startBeat: e.beat, durationBeats: p.durationBeats, pitch: p.pitch, lane: p.lane, velocity: p.velocity };
  });
  return fromSounding(flat);
}

/** Decode SMF bytes into per-track absolute-tick messages (a test-local reader, not parseMidi). */
export function decodeSmfMessages(bytes: Uint8Array): Array<Array<{ tick: number; data: number[] }>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 14;
  const tracks: Array<Array<{ tick: number; data: number[] }>> = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos + 4);
    let p = pos + 8;
    const end = p + len;
    let tick = 0;
    let running = 0;
    const msgs: Array<{ tick: number; data: number[] }> = [];
    const vlq = (): number => {
      let v = 0;
      for (;;) {
        const b = bytes[p++] as number;
        v = (v << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) return v;
      }
    };
    while (p < end) {
      tick += vlq();
      let status = bytes[p] as number;
      if (status === 0xff) {
        p += 2;
        const metaLen = vlq();
        p += metaLen;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        p += 1;
        const sysLen = vlq();
        p += sysLen;
        continue;
      }
      if (status & 0x80) {
        p++;
        running = status;
      } else status = running;
      const n = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
      msgs.push({ tick, data: [status, ...Array.from(bytes.slice(p, p + n))] });
      p += n;
    }
    tracks.push(msgs);
    pos = end;
  }
  return tracks;
}

/** MIDI bytes -> onset/offset keys. Track chunks 1.. map to the project's instrument/drum tracks in order. */
export function fromMidiBytes(bytes: Uint8Array, project: Project): { ons: string[]; offs: string[] } {
  const chunks = decodeSmfMessages(bytes).slice(1);
  const playable = project.tracks.filter((t) => t.type === 'instrument' || t.type === 'drum');
  const ons: string[] = [];
  const offs: string[] = [];
  chunks.forEach((msgs, i) => {
    const trackId = playable[i]?.id ?? '?';
    for (const m of msgs) {
      const [status, key, vel] = m.data as [number, number, number];
      const kind = status & 0xf0;
      const isDrum = (status & 0x0f) === 9;
      if (kind === 0x90 && vel > 0) {
        ons.push(
          isDrum
            ? onsetKey({ kind: 'drum', trackId, tick: m.tick, what: GM_DRUM_LANE[key] ?? `?${key}`, velocity: vel })
            : onsetKey({ kind: 'note', trackId, tick: m.tick, what: key, velocity: vel }),
        );
      } else if ((kind === 0x80 || (kind === 0x90 && vel === 0)) && !isDrum) {
        offs.push(offsetKey({ trackId, tick: m.tick, pitch: key }));
      }
    }
  });
  return { ons: sorted(ons), offs: sorted(offs) };
}

/** Does any track hold two overlapping clips? */
export function hasOverlap(project: Project): boolean {
  return project.tracks.some((t) => {
    const cs = [...t.clips].sort((a, b) => a.startBeat - b.startBeat);
    return cs.some((c, i) => i > 0 && tickOf((cs[i - 1] as Clip).startBeat + (cs[i - 1] as Clip).lengthBeats) > tickOf(c.startBeat));
  });
}
