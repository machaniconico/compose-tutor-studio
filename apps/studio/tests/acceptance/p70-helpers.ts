// P70 acceptance helpers (shared by the p70-*.test.ts(x) files). Implementers must not edit.
//
// Fixtures live in ./fixtures/p70 (see its README.md): wave5 v3 inputs plus, for each, the event list that
// wave5's REAL soundingEvents (commit d85f796) plays. Nothing here calls the converter except `convertOk`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertWave5Project,
  resolveDrumOccurrence,
  type Project,
  type Wave5ConvertResult,
} from '@cts/project-model';
import { expect } from 'vitest';
import { automationBaseValue, automationValueAt } from '../../src/audio/automation';
import { buildScheduleEvents } from '../../src/audio/events';

export const PPQ = 480;
// A string path (not `new URL`): the jsdom environment replaces the URL class.
export const FIXTURE_DIR = `${dirname(fileURLToPath(import.meta.url))}/fixtures/p70/`;

export type Json = Record<string, any>;

export function inputOf(name: string): Json {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}inputs/${name}.json`, 'utf8')) as Json;
}

export type GoldenEvent = {
  trackId: string;
  clipId: string;
  kind: 'note' | 'drum';
  pitch?: number;
  lane?: string;
  velocity: number;
  startTick: number;
  endTick?: number;
  chokeEndTick?: number;
};

export function goldenOf(name: string): { eventCount: number; problems: string[]; events: GoldenEvent[] } {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}expected/${name}.events.json`, 'utf8'));
}

export type LaneGolden = { trackId: string; target: 'track-volume' | 'track-pan' | 'track-filter-cutoff'; samples: number[] };

/** wave5's evaluateAutomation sampled every 1/8 beat in main's units (see fixtures/p70/README.md), or null when the fixture has no played lane. */
export function lanesGoldenOf(name: string): { stepBeats: number; lanes: LaneGolden[] } | null {
  try {
    return JSON.parse(readFileSync(`${FIXTURE_DIR}expected/${name}.lanes.json`, 'utf8'));
  } catch {
    return null;
  }
}

export function allInputNames(): string[] {
  return readdirSync(`${FIXTURE_DIR}inputs`).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

/** Fixtures the converter must REFUSE (see the over-limit test). */
export const REFUSED_FIXTURES = ['over-limit-steps', 'over-limit-events', 'over-limit-density'] as const;

export function convertibleNames(): string[] {
  return allInputNames().filter((n) => !(REFUSED_FIXTURES as readonly string[]).includes(n));
}

/** Convert a fixture and demand success. */
export function convertOk(name: string): Extract<Wave5ConvertResult, { ok: true }> {
  const result = convertWave5Project(inputOf(name));
  if (!result.ok) throw new Error(`${name}: expected ok, got ${result.code}: ${result.reason}`);
  return result;
}

export function trackOf(project: Project, id: string) {
  const track = project.tracks.find((t) => t.id === id);
  if (!track) throw new Error(`no track ${id}`);
  return track;
}

export function clipOf(project: Project, clipId: string) {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  throw new Error(`no clip ${clipId}`);
}

export function laneOf(project: Project, type: string, trackId: string) {
  const lanes = project.automationLanes.filter((l) => l.target.type === type && l.target.trackId === trackId);
  if (lanes.length !== 1) throw new Error(`expected exactly one ${type} lane on ${trackId}, got ${lanes.length}`);
  return lanes[0]!;
}

/** Notes of a clip as comparable [startBeat, durationBeats, pitch, velocity] rows, sorted. */
export function noteRows(clip: { notes?: ReadonlyArray<{ startBeat: number; durationBeats: number; pitch: number; velocity: number }> }) {
  return (clip.notes ?? [])
    .map((n) => [n.startBeat, n.durationBeats, n.pitch, n.velocity] as const)
    .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
}

/** Drum events of a clip as [stepIndex, lane] rows, sorted. */
export function drumRows(clip: { drumEvents?: ReadonlyArray<{ stepIndex: number; lane: string }> }) {
  return (clip.drumEvents ?? [])
    .map((d) => [d.stepIndex, d.lane] as const)
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
}

export function reportItems(result: { report: ReadonlyArray<{ code: string; severity: string; trackId?: string; clipId?: string; effectId?: string; detail?: Record<string, unknown> }> }, code: string) {
  return result.report.filter((item) => item.code === code);
}

type MainEvent = GoldenEvent;

/**
 * What main plays for a (converted) project: buildScheduleEvents, drums through resolveDrumOccurrence as
 * the live scheduler does (same path as the P20 three-path test). The chord track is cleared first: wave5's
 * soundingEvents never played chordTrack, while main realizes it onto an empty Chords track (the
 * `chord-track-audible` report item covers that difference).
 */
export function mainEventsOf(project: Project): MainEvent[] {
  const bare = { ...project, chordTrack: [] } as Project;
  const out: MainEvent[] = [];
  for (const scheduled of buildScheduleEvents(bare)) {
    const resolved = resolveDrumOccurrence(scheduled as never, scheduled.beat) as { beat: number; payload: Json } | null;
    if (!resolved) continue;
    const p = resolved.payload;
    const startTick = Math.round(resolved.beat * PPQ);
    if (p.kind === 'note') {
      out.push({
        trackId: p.trackId, clipId: '', kind: 'note', pitch: p.pitch, velocity: p.velocity, startTick,
        endTick: Math.round((resolved.beat + p.durationBeats) * PPQ),
      });
    } else if (p.kind === 'drum') {
      out.push({
        trackId: p.trackId, clipId: p.clipId ?? '', kind: 'drum', lane: p.lane, velocity: p.velocity, startTick,
        ...(typeof p.chokedAtBeat === 'number' ? { chokeEndTick: Math.round(p.chokedAtBeat * PPQ) } : {}),
      });
    }
  }
  return out;
}

const groupKey = (e: MainEvent) => `${e.trackId}|${e.kind}|${e.kind === 'note' ? e.pitch : e.lane}`;

/**
 * The parity rule (the P20 three-path rule applied to wave5 vs main): events are grouped by
 * track / kind / pitch-or-lane, ordered by tick inside a group, and compared pairwise.
 * Every start tick (and note end tick, and open-hat choke tick) must be within 1 tick; velocity and counts exact.
 */
export function expectEventParity(label: string, golden: readonly GoldenEvent[], actual: readonly MainEvent[]): void {
  const group = (events: readonly MainEvent[]) => {
    const map = new Map<string, MainEvent[]>();
    for (const e of events) {
      const list = map.get(groupKey(e)) ?? [];
      list.push(e);
      map.set(groupKey(e), list);
    }
    for (const list of map.values()) list.sort((a, b) => a.startTick - b.startTick || a.velocity - b.velocity);
    return map;
  };
  expect(actual.length, `${label}: event count`).toBe(golden.length);
  const g = group(golden);
  const a = group(actual);
  expect([...a.keys()].sort(), `${label}: event groups`).toEqual([...g.keys()].sort());
  for (const [key, expectedList] of g) {
    const actualList = a.get(key)!;
    expect(actualList.length, `${label}: ${key} count`).toBe(expectedList.length);
    expectedList.forEach((want, i) => {
      const got = actualList[i]!;
      expect(Math.abs(got.startTick - want.startTick), `${label}: ${key}[${i}] start ${got.startTick} vs ${want.startTick}`).toBeLessThanOrEqual(1);
      expect(got.velocity, `${label}: ${key}[${i}] velocity`).toBe(want.velocity);
      if (want.kind === 'note') {
        expect(Math.abs(got.endTick! - want.endTick!), `${label}: ${key}[${i}] end ${got.endTick} vs ${want.endTick}`).toBeLessThanOrEqual(1);
      } else if (want.chokeEndTick !== undefined) {
        expect(got.chokeEndTick, `${label}: ${key}[${i}] choke`).toBeDefined();
        expect(Math.abs(got.chokeEndTick! - want.chokeEndTick), `${label}: ${key}[${i}] choke ${got.chokeEndTick} vs ${want.chokeEndTick}`).toBeLessThanOrEqual(1);
      } else {
        expect(got.chokeEndTick, `${label}: ${key}[${i}] must not be choked`).toBeUndefined();
      }
    });
  }
}

/** Convert a fixture and check the main schedule of the result against wave5's golden events. */
export function expectFixtureParity(name: string): void {
  const result = convertOk(name);
  expectEventParity(name, goldenOf(name).events, mainEventsOf(result.project));
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Every key name that appears anywhere in a JSON-like value. */
export function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, into));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

export function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Lane parity: the lanes of the converted project, evaluated with main's own playback evaluator (automationValueAt with the
 * track scalar as base value, as playback does), equal wave5's sampled curve within 1e-6 at every 1/8 beat, and there is no
 * lane that wave5 did not play.
 */
export function expectLaneParity(name: string, project: Project): void {
  const golden = lanesGoldenOf(name);
  const wanted = (golden?.lanes ?? []).map((l) => `${l.trackId}|${l.target}`).sort();
  const got = project.automationLanes.map((l) => `${l.target.trackId}|${l.target.type}`).sort();
  expect(got, `${name}: lanes present`).toEqual(wanted);
  for (const want of golden?.lanes ?? []) {
    const lane = laneOf(project, want.target, want.trackId);
    const track = trackOf(project, want.trackId);
    const base = automationBaseValue(track, lane.target);
    want.samples.forEach((expected, k) => {
      const actual = automationValueAt(lane, base, k * golden!.stepBeats);
      if (Math.abs(actual - expected) > 1e-6) {
        throw new Error(`${name}: ${want.trackId} ${want.target} at beat ${k * golden!.stepBeats}: got ${actual}, wave5 plays ${expected}`);
      }
    });
  }
}

export function allLaneGoldenNames(): string[] {
  return readdirSync(`${FIXTURE_DIR}expected`).filter((f) => f.endsWith('.lanes.json')).map((f) => f.slice(0, -'.lanes.json'.length)).sort();
}

/**
 * wave5 plays every hit; main holds ONE hit per track, lane and step. The expected main events are the golden events with hits on the same
 * track + lane + start tick merged, keeping the highest velocity (rule 23).
 */
export function mergeSameStepDrumHits(events: readonly GoldenEvent[]): GoldenEvent[] {
  const kept = new Map<string, GoldenEvent>();
  const rest: GoldenEvent[] = [];
  for (const e of events) {
    if (e.kind !== 'drum') { rest.push(e); continue; }
    const key = `${e.trackId}|${e.lane}|${e.startTick}`;
    const prior = kept.get(key);
    if (!prior || e.velocity > prior.velocity) kept.set(key, e);
  }
  return [...rest, ...kept.values()];
}
