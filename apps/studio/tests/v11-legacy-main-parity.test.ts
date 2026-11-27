// P20 regression: legacy mode (swing 0, hiHatChoke false) must be byte-identical to main (v10).
//
// A fixed-seed generator builds main-shaped v10 projects (off-grid notes, sub-tick clip ends,
// loops, odd meters, drum grooves, chords). Each one is decoded (migrated to v11 with swing 0
// and choke off) and the live schedule, an indexed loop query, the WAV schedule and plan, and
// the MIDI bytes are hashed. The expected digests were captured by running this same file
// against origin/main (schema v10) with CTS_CAPTURE_MAIN_PARITY=<fixture path>.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => '00000000-0000-4000-8000-000000000000',
    configurable: true,
  });
});

import { projectToMidi } from '@cts/midi-io';
import { decodeProjectJson } from '@cts/project-model';
import { createEmptyProject } from '../../../packages/project-model/src/factories';
import { _resetIdCounter } from '../../../packages/project-model/src/ids';
import { buildScheduleEvents } from '../src/audio/events';
import { createScheduleEventIndex, nextIndexedEventsInWindow } from '../src/audio/scheduler';
import { buildWavScheduleEvents, planWavRender } from '../src/audio/wav';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'v10-legacy-main-parity.json');
const SEED = 0x5032_3031;
const COUNT = 200;
const LANES = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'] as const;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = Record<string, unknown>;

/** One main-shaped v10 project document; the same bytes on main and on P20. */
function corpusProject(index: number): string {
  const rnd = prng(SEED + index * 7919);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(values: readonly T[]): T => values[int(values.length)]!;
  const timeSignature = pick([[4, 4], [3, 4], [6, 8], [3, 16], [7, 8], [5, 4]] as const);
  _resetIdCounter();
  const project = createEmptyProject({
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    timeSignature: [timeSignature[0], timeSignature[1]],
    lengthBars: 1 + int(6),
    bpm: 60 + int(170),
  }) as unknown as Json;
  const songBeats = project.lengthBeats as number;
  const barBeats = (timeSignature[0] * 4) / timeSignature[1];
  let id = 0;
  const nextId = (prefix: string) => `${prefix}-${index}-${(id += 1)}`;
  const position = (limit: number) => {
    const raw = pick([
      () => int(Math.max(1, Math.floor(limit * 4))) / 4, // 16ths, half of them odd
      () => int(Math.max(1, Math.floor(limit * 3))) / 3, // triplets
      () => int(Math.max(1, Math.floor(limit * 960))) / 960, // sub-16th grid
      () => Math.round(rnd() * limit * 1000) / 1000, // decimal positions (5.833 style)
      () => Math.max(0, limit - pick([1 / 960, 1 / 6000, 0.0003, 0.0833])), // near the end
    ])();
    // Leave room for the 1/960-beat minimum duration.
    return Math.min(Math.max(0, raw), Math.max(0, limit - 2 / 960));
  };

  const tracks = project.tracks as Json[];
  for (const track of tracks) {
    const clips = track.clips as Json[];
    if (track.type === 'instrument') {
      const template = clips[0]!;
      const clipCount = track.name === 'Chords' && rnd() < 0.5 ? 1 : 1 + int(3);
      track.clips = Array.from({ length: clipCount }, () => {
        const startBeat = position(songBeats - 0.25);
        const lengthBeats = Math.max(
          1 / 480,
          Math.min(
            songBeats - startBeat,
            pick([1, 0.75, 10 / 3, 13 / 3, 5.8333 - startBeat, rnd() * songBeats]),
          ),
        );
        const noteCount = track.name === 'Chords' && rnd() < 0.6 ? 0 : int(9);
        return {
          ...template,
          id: nextId('clip'),
          startBeat,
          lengthBeats,
          loop: rnd() < 0.4,
          notes: Array.from({ length: noteCount }, (_, n) => {
            const startBeat = position(lengthBeats);
            const durationBeats = pick([0.25, 0.333, 0.5, 1 / 960, 0.05, Math.round(rnd() * 2000) / 1000 + 0.001]);
            return {
              id: nextId('note'),
              pitch: 20 + n * 9 + int(8),
              startBeat,
              // A note must end within its clip.
              durationBeats: Math.min(durationBeats, lengthBeats - startBeat),
              velocity: 1 + int(127),
            };
          }),
        };
      });
    } else if (track.type === 'drum') {
      const template = clips[0]!;
      track.clips = Array.from({ length: 1 + int(2) }, () => {
        const stepsPerBar = pick([16, 16, 12, 8, 3, 80]);
        const startBeat = position(songBeats - 0.25);
        const lengthBeats = Math.max(1 / 480, Math.min(songBeats - startBeat, pick([8, 16 / 3, 4, rnd() * songBeats])));
        const groove = rnd() < 0.5
          ? {
              drumGroove: {
                swing: pick([0, 0.25, 0.5, 1, rnd()]),
                probability: pick([1, 0.5, rnd()]),
                humanizeVelocity: int(30),
                seed: 1 + int(1000),
              },
            }
          : {};
        return {
          ...template,
          id: nextId('drum-clip'),
          startBeat,
          lengthBeats,
          loop: rnd() < 0.3,
          stepsPerBar,
          ...groove,
          drumEvents: Array.from({ length: int(16) }, () => ({
            id: nextId('hit'),
            lane: pick(LANES),
            // A drum step must fall within its clip.
            stepIndex: int(Math.max(1, Math.floor((lengthBeats - 1e-6) / (barBeats / stepsPerBar)))),
            velocity: 1 + int(127),
            ...(rnd() < 0.3 ? { probability: pick([0, 0.5, 1, rnd()]) } : {}),
          })),
        };
      });
    }
  }

  const chordTrack: Json[] = [];
  for (let beat = position(Math.min(2, songBeats)); beat < songBeats && rnd() < 0.7;) {
    const durationBeats = Math.min(songBeats - beat, pick([1, 2, 0.75, 1 / 960, 4]));
    if (durationBeats < 2 / 960) break;
    const root = pick(['C', 'G', 'A', 'F'] as const);
    chordTrack.push({
      id: nextId('chord'),
      startBeat: beat,
      durationBeats,
      symbol: root,
      root,
      quality: 'major',
      notes: { C: [0, 4, 7], G: [7, 11, 2], A: [9, 1, 4], F: [5, 9, 0] }[root],
    });
    beat += durationBeats + pick([0, 0, 0.25, 1 / 3]);
  }
  project.chordTrack = chordTrack;

  // v10 document: main has no v11 keys; P20's factory adds them, so drop them here.
  delete project.swing;
  delete project.hiHatChoke;
  project.schemaVersion = 10;
  return JSON.stringify(project);
}

function digest(compute: () => unknown): string {
  let value: unknown;
  try {
    value = compute();
  } catch (error) {
    value = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

type Digests = Readonly<Record<'decode' | 'schedule' | 'live' | 'wav' | 'plan' | 'midi', string>>;

function corpusDigests(json: string): Digests {
  const decoded = decodeProjectJson(json);
  if (!decoded.ok) {
    const failure = digest(() => decoded.error.code);
    return { decode: failure, schedule: '', live: '', wav: '', plan: '', midi: '' };
  }
  const project = decoded.project;
  return {
    decode: 'ok',
    schedule: digest(() => buildScheduleEvents(project)),
    live: digest(() => {
      const events = buildScheduleEvents(project);
      const loopEnd = Math.min(project.lengthBeats, 2 + 1 / 3);
      const index = createScheduleEventIndex(events, { startBeat: 1 / 4, endBeat: loopEnd });
      return [
        nextIndexedEventsInWindow(index, 0, 1.5, project.bpm, 0, 0),
        nextIndexedEventsInWindow(index, 1.5, 6.25, project.bpm, 0, 0),
        nextIndexedEventsInWindow(createScheduleEventIndex(events), 0, project.lengthBeats + 1, project.bpm, 0, 0),
      ];
    }),
    wav: digest(() => buildWavScheduleEvents(project)),
    plan: digest(() => {
      const plan = planWavRender(project);
      return [plan.totalSeconds, plan.tailSeconds, plan.frames];
    }),
    midi: digest(() => Buffer.from(projectToMidi(project, { includeProgramAndKey: false })).toString('hex')),
  };
}

describe('v11 legacy mode matches main (v10) byte for byte', () => {
  it('legacyMode_seededCorpus_matchesCapturedMainOutput', () => {
    const actual = Array.from({ length: COUNT }, (_, index) => corpusDigests(corpusProject(index)));
    const capture = process.env.CTS_CAPTURE_MAIN_PARITY;
    if (capture) {
      writeFileSync(capture, `${JSON.stringify({ seed: SEED, count: COUNT, digests: actual }, null, 1)}\n`);
      return;
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { digests: Digests[] };
    // The corpus must exercise real output, not only decode failures.
    expect(expected.digests.filter((d) => d.decode === 'ok').length).toBeGreaterThan(COUNT * 0.8);
    const mismatches = actual.flatMap((digests, index) =>
      (Object.keys(digests) as Array<keyof Digests>)
        .filter((key) => digests[key] !== expected.digests[index]![key])
        .map((key) => `seed ${index}: ${key}`),
    );
    expect(mismatches).toEqual([]);
  });

  it('legacyMode_closeToClipEndNote_keepsMainBeatRule', () => {
    // probeP20 corpus4/seed-117: a bass note at 5.833 inside a clip ending at 5.8333. Both round to
    // tick 2800, so the tick rule would drop it; main's beat rule (5.833 < 5.8333) keeps it.
    _resetIdCounter();
    const project = createEmptyProject({ clock: () => new Date('2026-01-01T00:00:00.000Z'), lengthBars: 2 });
    Object.assign(project, { swing: 0, hiHatChoke: false });
    const bass = project.tracks.find((track) => track.name === 'Bass')!;
    bass.clips[0]!.startBeat = 2.5;
    bass.clips[0]!.lengthBeats = 5.8333 - 2.5;
    bass.clips[0]!.notes = [{ id: 'late', pitch: 40, startBeat: 5.833 - 2.5, durationBeats: 0.25, velocity: 90 }];
    const notes = buildScheduleEvents(project).filter(
      (event) => (event.payload as { kind: string; trackId: string }).trackId === bass.id,
    );
    expect(notes).toHaveLength(1);
    expect(buildWavScheduleEvents(project).filter(
      (event) => (event.payload as { trackId: string }).trackId === bass.id,
    )).toHaveLength(1);
  });
});
