// US-018 のシード固定ファズ: 端数の拍・ループ・リンク・スウィング 0/30/50/60・拍子 3/4 と 6/8 を含む曲。
// groove.test.ts と midi-io / studio のテストが同じ曲を使う。
import type { Clip, DrumLane, NoteEvent, Project, Track } from '../src/types';
import { beatsPerBar } from '../src/time';
import { decodeSmfMessages, mulberry32 } from './acceptance/helpers';

export const FUZZ_SWINGS = [0, 30, 50, 60] as const;
export const FUZZ_SEEDS = Array.from({ length: 24 }, (_, i) => 1801 + i * 7);

type Rng = () => number;
const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
const LANES: DrumLane[] = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'];

/** A beat on the 1/16 grid, on a triplet grid, on an arbitrary tick, or not on a tick at all. */
function fuzzBeat(r: Rng, max: number): number {
  const kind = int(r, 0, 3);
  if (kind === 0) return Math.floor(r() * max * 4) / 4;
  if (kind === 1) return Math.floor(r() * max * 6) / 6;
  if (kind === 2) return Math.floor(r() * max * 480) / 480;
  return r() * max;
}

export function grooveFuzzProject(seed: number, swing: number): Project {
  const r = mulberry32(seed);
  const timeSignature = pick(r, [[4, 4], [3, 4], [6, 8]] as Array<[number, number]>);
  const bpb = beatsPerBar(timeSignature);
  const lengthBars = int(r, 2, 6);
  const songBeats = lengthBars * bpb;
  const tracks: Track[] = [];
  (['instrument', 'drum', 'instrument'] as const).forEach((type, ti) => {
    const trackId = `t${ti}`;
    const clips: Clip[] = [];
    let cursor = pick(r, [0, 0.5, 1 / 3, 0.25, 0.1]);
    for (let ci = 0; ci < int(r, 1, 3) && cursor < songBeats; ci++) {
      const id = `${trackId}-c${ci}`;
      const lengthBeats = pick(r, [bpb, 2 * bpb, 1.5, 2.75, bpb + 0.3]);
      const loop = r() < 0.4;
      const contentLengthBeats = loop ? pick(r, [1, 1.5, 0.75, bpb, 1.3]) : undefined;
      const clip: Clip = { id, trackId, type: type === 'drum' ? 'drum' : 'midi', startBeat: cursor, lengthBeats, loop };
      if (contentLengthBeats !== undefined) clip.contentLengthBeats = contentLengthBeats;
      if (ci > 0 && r() < 0.35) {
        clip.aliasOf = clips[0]!.id;
      } else if (type === 'drum') {
        clip.stepsPerBar = pick(r, [16, 12, 24, 8]);
        const steps = Math.ceil((clip.stepsPerBar * lengthBeats) / bpb);
        clip.drumEvents = Array.from({ length: int(r, 3, 10) }, (_, i) => ({
          id: `${id}-d${i}`, lane: pick(r, LANES), stepIndex: int(r, 0, steps), velocity: int(r, 1, 127),
        }));
      } else {
        clip.notes = Array.from({ length: int(r, 3, 10) }, (_, i): NoteEvent => ({
          id: `${id}-n${i}`,
          pitch: int(r, 36, 84),
          startBeat: fuzzBeat(r, lengthBeats + 0.5),
          durationBeats: pick(r, [0.25, 0.125, 1 / 3, 1, 0.01, 1 / 1920, 2.5]),
          velocity: int(r, 1, 127),
        }));
      }
      clips.push(clip);
      cursor += lengthBeats + pick(r, [0, 0, 0.5, 1 / 3]);
    }
    tracks.push({
      id: trackId, name: trackId, type, clips, volume: 0.8, pan: 0, mute: false, solo: false, effects: [],
      ...(type === 'instrument' ? { instrument: { type: 'synth' as const, preset: 'warmPad' } } : {}),
    });
  });
  return {
    id: `fuzz-${seed}`, schemaVersion: 3, title: 'fuzz', bpm: 120, timeSignature, key: 'C', scale: 'major',
    lengthBars, tracks, chordTrack: [], sections: [], createdAt: 'now', updatedAt: 'now',
    ...(swing > 0 ? { swing } : {}),
  };
}

/** FNV-1a (32 bit) of a string: a short fingerprint for golden comparisons. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A note-on / note-off edge in ticks of one resolution. Drums carry the key 'drum' and no off. */
export type TickEdge = { tick: number; kind: 'on' | 'off'; key: string };

/** Edges of a live schedule (`pitch` absent for a drum hit), rounded to whole ticks of `ppq`. */
export function scheduleEdges(items: ReadonlyArray<{ beat: number; pitch?: number; durationBeats?: number }>, ppq: number): TickEdge[] {
  return items.flatMap(({ beat, pitch, durationBeats }) => pitch === undefined
    ? [{ tick: Math.round(beat * ppq), kind: 'on' as const, key: 'drum' }]
    : [
        { tick: Math.round(beat * ppq), kind: 'on' as const, key: String(pitch) },
        { tick: Math.round((beat + durationBeats!) * ppq), kind: 'off' as const, key: String(pitch) },
      ]);
}

/** Edges written in a Standard MIDI File, in its own whole ticks (channel 9 is the drum kit). */
export function midiFileEdges(bytes: Uint8Array): TickEdge[] {
  return decodeSmfMessages(bytes).flat().flatMap(({ tick, data }) => {
    const [status = 0, pitch = 0, velocity = 0] = data;
    const type = status & 0xf0;
    if (type !== 0x80 && type !== 0x90) return [];
    const drum = (status & 0x0f) === 9;
    const kind = type === 0x90 && velocity > 0 ? 'on' as const : 'off' as const;
    if (drum && kind === 'off') return [];
    return [{ tick, kind, key: drum ? 'drum' : String(pitch) }];
  });
}

/**
 * Why two edge lists differ by more than one tick (null when every on and off
 * matches within one tick). Edges are paired in tick order per kind and key.
 */
export function edgeMismatch(live: readonly TickEdge[], file: readonly TickEdge[]): string | null {
  const group = (edges: readonly TickEdge[]) => {
    const map = new Map<string, number[]>();
    for (const e of edges) map.set(`${e.kind}:${e.key}`, [...(map.get(`${e.kind}:${e.key}`) ?? []), e.tick]);
    for (const ticks of map.values()) ticks.sort((a, b) => a - b);
    return map;
  };
  const a = group(live);
  const b = group(file);
  if (a.size !== b.size) return `edge groups differ: ${[...a.keys()].sort()} vs ${[...b.keys()].sort()}`;
  for (const [key, ticks] of a) {
    const other = b.get(key);
    if (!other || other.length !== ticks.length) return `${key}: ${ticks.length} vs ${other?.length ?? 0} edges`;
    for (let i = 0; i < ticks.length; i++) {
      if (Math.abs(ticks[i]! - other[i]!) > 1) return `${key}: tick ${ticks[i]} vs ${other[i]}`;
    }
  }
  return null;
}

/** The same edges with every note-off moved `ticks` later (a deliberately broken file for the tests). */
export function shiftOffs(edges: readonly TickEdge[], ticks: number): TickEdge[] {
  return edges.map((e) => (e.kind === 'off' ? { ...e, tick: e.tick + ticks } : e));
}
