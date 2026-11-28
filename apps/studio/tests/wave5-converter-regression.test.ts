import { mkdirSync, writeFileSync } from 'node:fs';
import { convertWave5Project, decodeProject, validateProject } from '@cts/project-model';
import { expect, it } from 'vitest';
import { automationValueAt } from '../src/audio/automation';
import { clipOf, convertOk, goldenOf, inputOf, laneOf, mainEventsOf, PPQ, reportItems, type Json } from './acceptance/p70-helpers';

const midiClip = (id: string, startBeat = 0, lengthBeats = 1) => ({
  id, trackId: 't-a', type: 'midi', startBeat, lengthBeats, loop: false,
});
const note = (startBeat: number, durationBeats: number) => ({
  id: 'note', pitch: 60, velocity: 100, startBeat, durationBeats,
});

const hostileInputs: [string, (input: Json, track: Json) => void][] = [
  ['60,000 buses and 60,000 tracks with sends', (input, track) => {
    const empty = { name: '', clips: [], volume: 1, pan: 0, mute: false, solo: false, effects: [] };
    const buses = Array.from({ length: 60_000 }, (_, i) => ({ ...empty, id: `b${i}`, type: 'bus' }));
    const senders = Array.from({ length: 60_000 }, (_, i) => ({
      ...empty, id: `i${i}`, type: 'instrument', sends: { b0: 0.5 },
    }));
    input.tracks = [track, ...buses, ...senders];
  }],
  ['160,000 overlapping clips', (_, track) => {
    track.clips = Array.from({ length: 160_000 }, (_, i) => midiClip(`c${i}`));
  }],
  ['129 overlapping clips with automation', (_, track) => {
    track.clips = Array.from({ length: 129 }, (_, i) => midiClip(`c${i}`));
    track.automation = { volume: { points: [{ beat: 0, value: 1 }, { beat: 3, value: 0.5 }] } };
  }],
  ['surviving notes over the event budget', (input, track) => {
    input.lengthBars = 12;
    track.clips = Array.from({ length: 21 }, (_, i) => ({
      ...midiClip(`c${i}`, i * 2, 2),
      notes: Array.from({ length: 1_000 }, (_, n) => ({ ...note(n / 500, 0.002), id: `n${i}-${n}` })),
    }));
  }],
];

it.each(hostileInputs)('refuses %s within two seconds', (_, build) => {
  const input = inputOf('swing-loop-cut');
  build(input, input.tracks[0]);
  const serialized = JSON.stringify(input);
  expect(Buffer.byteLength(serialized)).toBeLessThan(16 * 1024 * 1024);
  const started = performance.now();
  const result = convertWave5Project(JSON.parse(serialized));
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(result).toMatchObject({ ok: false, code: 'over-limit' });
}, 75_000);

it('counts surviving notes and reports 6,000 notes outside their clips', () => {
  const input = inputOf('swing-loop-cut');
  input.lengthBars = 50;
  input.swing = 0;
  input.tracks[0].clips = [{
    ...midiClip('dense', 0, 200),
    notes: Array.from({ length: 21_000 }, (_, i) => ({
      ...note(i < 15_000 ? i / 75 : 200 + i / 75, 2 / 480), id: `n${i}`,
    })),
  }];
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(clipOf(result.project, 'dense').notes).toHaveLength(15_000);
  expect(reportItems(result, 'hidden-events-dropped')).toMatchObject([{ detail: { count: 6_000 } }]);
});

it('counts surviving clips and tracks and reports clips outside the song', () => {
  const input = inputOf('swing-loop-cut');
  input.tracks[0].clips = Array.from({ length: 1_030 }, (_, i) =>
    midiClip(`c${i}`, i < 1_020 ? i / 480 : 32, 1 / 480));
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.tracks).toHaveLength(2);
  expect(result.project.tracks[0]?.clips).toHaveLength(1_020);
  expect(reportItems(result, 'song-end-trimmed')).toMatchObject([{ detail: { clips: 10 } }]);
});

it('counts drum hits after merging duplicates from unrolled passes', () => {
  const input = inputOf('drum-same-step-hits');
  const clip = input.tracks[0].clips[0];
  Object.assign(clip, {
    lengthBeats: 25, loop: true, contentLengthBeats: 0.25,
    drumEvents: Array.from({ length: 256 }, (_, i) => ({
      id: `d${i}`, lane: 'kick', stepIndex: 0, velocity: 100,
    })),
  });
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(clipOf(result.project, clip.id).drumEvents).toHaveLength(100);
  expect(reportItems(result, 'drum-hits-merged')).toMatchObject([{ detail: { count: 25_500 } }]);
});

it('uses the default drum grid when the stored step count is negative', () => {
  const input = inputOf('drum-same-step-hits');
  const drum = input.tracks.find((track: Json) => track.type === 'drum');
  drum.clips[0].stepsPerBar = -16;
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(clipOf(result.project, drum.clips[0].id).stepsPerBar).toBe(16);
  expect(mainEventsOf(result.project)).toEqual(mainEventsOf(convertOk('drum-same-step-hits').project));
});

it.each([
  ['drum-same-step-hits', 6, 3],
  ['loop-drum-snap-collision', 7, 2],
] as const)('accounts for audible hits lost in %s', (name, originalCount, removed) => {
  const result = convertOk(name);
  expect(goldenOf(name).eventCount).toBe(originalCount);
  expect(mainEventsOf(result.project)).toHaveLength(originalCount - removed);
  expect(reportItems(result, 'drum-hits-merged')).toEqual([
    expect.objectContaining({ severity: 'dropped', detail: { count: removed } }),
  ]);
});

it('materializes a link from the original note edges when its source was trimmed', () => {
  const input = inputOf('swing-loop-cut');
  input.swing = 0;
  input.tracks[0].clips = [
    { ...midiClip('source'), notes: [note(0.9995, 0.1)] },
    { ...midiClip('link', 2.0011), aliasOf: 'source' },
  ];

  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // Wave5's d85f796 alias-phase probe plays the note only at the link's position.
  expect(clipOf(result.project, 'link').notes).toHaveLength(1);
  expect(clipOf(result.project, 'source').notes ?? []).toHaveLength(0);
  expect(mainEventsOf(result.project)).toMatchObject([{ startTick: 1440, endTick: 1441 }]);
});

it('keeps a valid one-tick note and reports a note rounded down to zero ticks', () => {
  const input = inputOf('swing-loop-cut');
  input.swing = 0;
  input.tracks[0].clips = [{
    ...midiClip('clip', 0, 1.0011),
    notes: [note(1.001, 1), { ...note(0.3, 0.0001), id: 'zero' }],
  }];
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(mainEventsOf(result.project)).toMatchObject([{ startTick: 480, endTick: 481 }]);
  expect(reportItems(result, 'hidden-events-dropped')).toMatchObject([{ detail: { count: 1 } }]);
});

const convertedDir = new URL('../test-results/p70-sub-tick/', import.meta.url);

it.each([
  { loop: false, clipEnd: 32, events: [[31, 32]] },
  { loop: true, clipEnd: 64, events: [[31, 32], [63, 64]] },
])('keeps the last tick at an overshooting note boundary (loop=$loop)', ({ loop, clipEnd, events }) => {
  const input = inputOf('swing-loop-cut');
  input.swing = 0;
  const startBeat = 31 / PPQ;
  const endBeat = 32 / PPQ;
  input.tracks[0].clips = [{
    ...midiClip('clip', 0, clipEnd / PPQ), loop,
    ...(loop ? { contentLengthBeats: endBeat } : {}),
    notes: [note(startBeat, endBeat - startBeat)],
  }];
  expect(startBeat + 1 / PPQ).toBeGreaterThan(endBeat);

  const result = convertWave5Project(input);
  if (!result.ok) throw new Error(result.reason);
  const clip = clipOf(result.project, 'clip');
  expect(clip.notes?.[0]?.startBeat).toBe(startBeat);
  expect(startBeat + clip.notes![0]!.durationBeats).toBeLessThanOrEqual(endBeat);
  expect(mainEventsOf(result.project).map(({ startTick, endTick }) => [startTick, endTick])).toEqual(events);
  expect(reportItems(result, 'hidden-events-dropped')).toEqual([]);
  if (!loop) {
    mkdirSync(convertedDir, { recursive: true });
    writeFileSync(new URL('last-tick.json', convertedDir), JSON.stringify(result.project));
  }
});

it('preserves every note span ending within 1920 ticks', () => {
  const input = inputOf('swing-loop-cut');
  input.swing = 0;
  const bits = new DataView(new ArrayBuffer(8));
  // Batch by clip end and keep each batch within the schedule density limit.
  const batchSize = 256;
  for (let endTick = 1; endTick <= 1920; endTick++) {
    const endBeat = endTick / PPQ;
    for (let firstTick = 0; firstTick < endTick; firstTick += batchSize) {
      const count = Math.min(batchSize, endTick - firstTick);
      input.tracks[0].clips = [{
        ...midiClip('clip', 0, endBeat),
        notes: Array.from({ length: count }, (_, index) => {
          const startTick = firstTick + index;
          return { ...note(startTick / PPQ, endBeat - startTick / PPQ), id: `n${startTick}` };
        }),
      }];
      const result = convertWave5Project(input);
      const batch = `clip ending at tick ${endTick}, starts from tick ${firstTick}`;
      if (!result.ok) throw new Error(`${batch}: ${result.reason}`);
      expect(validateProject(result.project).valid, batch).toBe(true);
      const notes = clipOf(result.project, 'clip').notes ?? [];
      expect(notes, batch).toHaveLength(count);
      for (const [index, { startBeat, durationBeats }] of notes.entries()) {
        const startTick = firstTick + index;
        const canonicalDuration = (endTick - startTick) / PPQ;
        if (startBeat !== startTick / PPQ || Math.round(durationBeats * PPQ) !== endTick - startTick) {
          throw new Error(`Changed tick span ${startTick}–${endTick}`);
        }
        if (durationBeats !== canonicalDuration) {
          bits.setFloat64(0, durationBeats);
          bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
          if (durationBeats > canonicalDuration || startBeat + bits.getFloat64(0) <= endBeat) {
            throw new Error(`Unnecessary duration adjustment for ticks ${startTick}–${endTick}`);
          }
        }
      }
    }
  }
}, 75_000);

it('preserves the rounded tick span for the native note-boundary regression', () => {
  const input = inputOf('swing-loop-cut');
  input.swing = 0;
  input.tracks[0].clips = [{ ...midiClip('clip', 0, 0.019), notes: [note(0.006, 0.012)] }];
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  mkdirSync(convertedDir, { recursive: true });
  writeFileSync(new URL('note-boundary.json', convertedDir), JSON.stringify(result.project));
  const clip = clipOf(result.project, 'clip');
  const convertedNote = clip.notes![0]!;
  expect(clip.lengthBeats).toBe(9 / 480);
  expect(convertedNote.startBeat).toBe(3 / 480);
  expect(Math.round(convertedNote.durationBeats * PPQ)).toBe(6);
  expect(convertedNote.startBeat + convertedNote.durationBeats).toBeLessThanOrEqual(clip.lengthBeats);
});

it('writes 300 seeded sub-tick conversions for native validation', () => {
  let seed = 0x705eed;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  mkdirSync(convertedDir, { recursive: true });
  for (let round = 0; round < 300; round++) {
    const input = inputOf('swing-loop-cut');
    input.swing = Math.floor(random() * 61);
    const start = random() * 3;
    const length = (0.25 + random() * 500) / 480;
    const local = Math.max(0, length - random() * 2 / 480);
    input.tracks[0].clips = [{
      ...midiClip('clip', start, length),
      loop: round % 2 === 0,
      contentLengthBeats: Math.max(1 / 64, length * random()),
      notes: [note(local, (0.25 + random() * 2) / 480), { ...note(random() * length, 1 / 480), id: 'one' }],
    }];
    const result = convertWave5Project(input);
    expect(result.ok, `round ${round}`).toBe(true);
    if (!result.ok) continue;
    const json = JSON.stringify(result.project);
    writeFileSync(new URL(`round-${round}.json`, convertedDir), json);
    expect(decodeProject(JSON.parse(json)).ok, `round ${round}`).toBe(true);
  }
});

it('counts original automation points beyond the song and preserves its ramp', () => {
  const input = inputOf('lane-volume');
  input.lengthBars = 1;
  const track = input.tracks[0];
  track.volume = 1;
  track.automation = { volume: { points: [{ beat: 0, value: 1 }, { beat: 8, value: 0 }] } };
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.automationLanes[0]?.points).toMatchObject([{ beat: 0, value: 1 }, { beat: 4, value: 0.5 }]);
  expect(reportItems(result, 'automation-point-dropped')).toMatchObject([
    { severity: 'info', detail: { parameter: 'volume', count: 1 } },
  ]);
});

it('stores automation on canonical ticks and keeps the last value on a shared tick', () => {
  const input = inputOf('lane-volume');
  input.tracks[0].volume = 1;
  input.tracks[0].automation = { volume: { points: [
    { beat: 0, value: 1 }, { beat: 0.006, value: 0.6 }, { beat: 0.007, value: 0.7 },
  ] } };
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.automationLanes[0]?.points).toMatchObject([
    { beat: 0, value: 1 }, { beat: 3 / 480, value: 0.7 },
  ]);
});

type PanPoint = { beat: number; value: number };

// The pan path of Wave5 d85f796's evaluateAutomation, used by the judge's lanes.mts.
function wave5PanAt(points: readonly PanPoint[], pan: number, beat: number): number {
  const afterBeat = (position: number) => {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (points[mid]!.beat <= position) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const index = afterBeat(beat);
  const left = points[index - 1];
  const nextBeat = points[index]?.beat;
  let value: number;
  if (nextBeat === undefined) {
    value = left!.value;
  } else {
    const right = points[afterBeat(nextBeat) - 1]!;
    value = left
      ? left.value + (right.value - left.value) * ((beat - left.beat) / (right.beat - left.beat))
      : right.value;
  }
  return Math.min(1, Math.max(-1, pan + value));
}

function convertPan(pan: number, points: PanPoint[], fixture: string) {
  const input = inputOf('lane-pan');
  Object.assign(input.tracks[0], { pan, automation: { pan: { points } } });
  const result = convertWave5Project(input);
  if (!result.ok) throw new Error(`${fixture}: ${result.reason}`);
  expect(validateProject(result.project).valid, fixture).toBe(true);
  mkdirSync(convertedDir, { recursive: true });
  writeFileSync(new URL(`${fixture}.json`, convertedDir), JSON.stringify(result.project));
  return result.project;
}

it('keeps a pan saturation crossing at beat 3.26', () => {
  const project = convertPan(0.37, [{ beat: 0, value: -1 }, { beat: 4, value: 1 }], 'pan-crossing');
  const lane = laneOf(project, 'track-pan', 't-up');
  expect(lane.points).toMatchObject([
    { beat: 0, value: -0.63 }, { beat: 3.26, value: 1 }, { beat: 4, value: 1 },
  ]);
  expect(automationValueAt(lane, 0.37, 3.25)).toBeCloseTo(0.995, 12);
});

it('matches Wave5 at every eighth beat for 200 seeded UI pan lanes', () => {
  const end = 32;
  for (let round = 1; round <= 200; round++) {
    // The pan cases from the judge's lanes.mts, including its fader RNG draw.
    let seed = (round * 3 + 1) * 2654435761 >>> 0;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const panValue = () => Math.round((random() * 2 - 1) * 100) / 100;
    const pan = panValue();
    random();
    const count = 2 + Math.floor(random() * 5);
    const grid = [1, 0.5, 0.25, 1 / PPQ, 7 / PPQ][Math.floor(random() * 5)]!;
    const beats = Array.from({ length: count }, () => {
      const snapped = Math.round(random() * end / grid) * grid;
      return Math.round(snapped * PPQ) / PPQ;
    }).sort((a, b) => a - b);
    const points = beats.map((beat) => ({ beat, value: panValue() }));
    const fixture = `pan-round-${round}`;
    const project = convertPan(pan, points, fixture);
    const lane = laneOf(project, 'track-pan', 't-up');
    for (let beat = 0; beat <= end; beat += 1 / 8) {
      const expected = wave5PanAt(points, pan, beat);
      const actual = automationValueAt(lane, pan, beat);
      if (!(Math.abs(actual - expected) <= 1e-6)) {
        throw new Error(`${fixture} at beat ${beat}: main plays ${actual}, Wave5 plays ${expected}`);
      }
    }
  }
});

it('compares effects against their Wave5 physical ranges', () => {
  const input = inputOf('swing-loop-cut');
  input.tracks[0].effects = [
    { id: 'wet', type: 'reverb', enabled: true, params: { mix: 2 } },
    { id: 'cutoff', type: 'filter', enabled: true, params: { cutoffHz: 50 } },
    { id: 'delay', type: 'delay', enabled: true, params: { timeSeconds: 1 } },
  ];
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.tracks[0]?.effects.map(({ params }) => params)).toMatchObject([
    { wet: 1 }, { cutoff: 0 }, { delayTime: expect.any(Number) },
  ]);
  expect(reportItems(result, 'effect-adjusted')).toMatchObject([{ effectId: 'delay', severity: 'changed' }]);
});

it('rounds each loop boundary independently without accumulating timing drift', () => {
  const input = inputOf('swing-loop-cut');
  input.swing = 0;
  input.tracks[0].clips = [{
    ...midiClip('clip'), loop: true, contentLengthBeats: 0, notes: [note(0, 0.01)],
  }];
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // Wave5 normalizes the zero period to 1/64 beat, or 7.5 ticks.
  expect(mainEventsOf(result.project).map(({ startTick }) => startTick)).toEqual(
    Array.from({ length: 64 }, (_, pass) => Math.round(pass * 7.5)),
  );
});

it('uses the rounded absolute loop edge when it precedes the rounded clip end', () => {
  const input = inputOf('swing-loop-cut');
  input.swing = 0;
  input.tracks[0].clips = [{
    ...midiClip('clip', 9.6 / 480, 10.4 / 480),
    loop: true,
    contentLengthBeats: 9.6 / 480,
    notes: [note(0, 1 / 480)],
  }];
  const result = convertWave5Project(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(mainEventsOf(result.project).map(({ startTick, endTick }) => [startTick, endTick])).toEqual([
    [10, 11], [19, 20],
  ]);
});
