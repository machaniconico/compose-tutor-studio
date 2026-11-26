// US-018 グルーヴ: スウィング(soundingEvents の中で掛かる写像)、強さ付きクオンタイズ、ヒューマナイズ。
import { describe, expect, it } from 'vitest';
import { applySwing, humanize, quantize, swingBeat } from '../src/groove';
import { quantizeClipNotes } from '../src/mutations';
import { soundingEvents } from '../src/sounding';
import { beatTick } from '../src/time';
import type { NoteEvent } from '../src/types';
import { makeProject, makeTrack, midiClip, mulberry32 } from './acceptance/helpers';
import { FUZZ_SEEDS, FUZZ_SWINGS, fnv1a, grooveFuzzProject } from './grooveFuzz';

/** US-018 以前の clipExpand のスウィング(passPlacement の式を写したもの)。 */
function legacySwing(start: number, swing: number): number {
  const step = Math.round(start * 4);
  const delay = swing > 0 && step % 2 === 1 && beatTick(start) === beatTick(step / 4) ? swing / 400 : 0;
  return start + delay;
}

const note = (id: string, startBeat: number, durationBeats = 0.25, pitch = 60, velocity = 100): NoteEvent =>
  ({ id, pitch, startBeat, durationBeats, velocity });

describe('applySwing', () => {
  it('swing=0 では何も変わらない(deepEqual)', () => {
    const events = [note('a', 0), note('b', 0.25), note('c', 0.3), note('d', 0.75), note('e', 1 / 3)];
    const copy = structuredClone(events);
    expect(applySwing(events, 0)).toEqual(copy);
    expect(applySwing(events, 0, 0.25)).toEqual(copy);
    expect(events).toEqual(copy);
  });

  it('swing=50・グリッド 0.25 で 0.25 は 0.375、0 と 0.5 は動かない', () => {
    const out = applySwing([note('a', 0), note('b', 0.25), note('c', 0.5)], 50, 0.25);
    expect(out.map((e) => e.startBeat)).toEqual([0, 0.375, 0.5]);
    expect(swingBeat(0.25, 50, 0.25)).toBe(0.375);
    expect(swingBeat(0.75, 50)).toBe(0.875);
    expect(swingBeat(1.25, 50)).toBe(1.375);
  });

  it('入力の順番がそのまま出力の順番になり、1/16 グリッド上の音の前後は入れ替わらない', () => {
    const r = mulberry32(18);
    for (const swing of FUZZ_SWINGS) {
      const grid = Array.from({ length: 64 }, (_, i) => i / 4);
      const swung = grid.map((beat) => swingBeat(beat, swing));
      for (let i = 1; i < swung.length; i++) expect(swung[i]!).toBeGreaterThan(swung[i - 1]!);
      const events = Array.from({ length: 40 }, (_, i) => note(`n${i}`, Math.floor(r() * 64) / 4));
      const out = applySwing(events, swing);
      expect(out.map((e) => e.id)).toEqual(events.map((e) => e.id));
      const order = (list: readonly NoteEvent[]) =>
        list.map((e, i) => [e.startBeat, i] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(([, i]) => i);
      expect(order(out)).toEqual(order(events));
    }
  });

  it('既存の clipExpand の式と同じ値を返す(端数の拍・3 連符・tick 外の拍を含むファズ)', () => {
    const r = mulberry32(1018);
    for (let i = 0; i < 5000; i++) {
      const beat = [Math.floor(r() * 256) / 4, Math.floor(r() * 384) / 6, Math.floor(r() * 30720) / 480, r() * 64][i % 4]!;
      for (const swing of [...FUZZ_SWINGS, 12.5, 33.3]) {
        expect(Object.is(swingBeat(beat, swing), legacySwing(beat, swing))).toBe(true);
      }
    }
  });
});

// US-018 の変更前(HEAD e2c5242)の soundingEvents から取った指紋。スウィングを groove.ts に
// 寄せた後も、全フィールド(開始拍の浮動小数点値まで)が同じであることを示す。
const GOLDEN: Record<string, string> = {
  '1801/0': '34:35a6eb94', '1801/30': '34:8d8feaaf', '1801/50': '34:2db82256', '1801/60': '34:4ede65d7',
  '1808/0': '23:66fe7a76', '1808/30': '23:7e8665e0', '1808/50': '23:e1d8eb80', '1808/60': '23:464488b2',
  '1815/0': '35:24c3b19f', '1815/30': '35:525ff601', '1815/50': '35:6002bd97', '1815/60': '35:9ab45667',
  '1822/0': '28:b49473c0', '1822/30': '28:778a1bbb', '1822/50': '28:105ed410', '1822/60': '28:6b722a59',
  '1829/0': '30:196ab1de', '1829/30': '30:75350ceb', '1829/50': '30:1afac03c', '1829/60': '30:179c88f7',
  '1836/0': '25:19258f87', '1836/30': '25:9f11ce4a', '1836/50': '25:4bfdfab3', '1836/60': '25:0a96ba18',
  '1843/0': '33:97f657c2', '1843/30': '33:97f657c2', '1843/50': '33:97f657c2', '1843/60': '33:97f657c2',
  '1850/0': '25:9293dbc6', '1850/30': '25:617108f5', '1850/50': '25:d02fa5f8', '1850/60': '25:3948d1db',
  '1857/0': '20:c5c310fd', '1857/30': '20:e78e4244', '1857/50': '20:821a1389', '1857/60': '20:bc723244',
  '1864/0': '36:897b35e6', '1864/30': '36:268fc2c7', '1864/50': '36:241a2eaa', '1864/60': '36:9d173a71',
  '1871/0': '17:3c24b572', '1871/30': '17:3c24b572', '1871/50': '17:3c24b572', '1871/60': '17:3c24b572',
  '1878/0': '14:5cdde623', '1878/30': '14:5cdde623', '1878/50': '14:5cdde623', '1878/60': '14:5cdde623',
  '1885/0': '38:1e0bd559', '1885/30': '38:ab5220c0', '1885/50': '38:355da76b', '1885/60': '38:e7c4a896',
  '1892/0': '24:f633e70b', '1892/30': '24:e33cc650', '1892/50': '24:543f0da9', '1892/60': '24:4bc2abdc',
  '1899/0': '46:77d3b1ab', '1899/30': '46:77d3b1ab', '1899/50': '46:77d3b1ab', '1899/60': '46:77d3b1ab',
  '1906/0': '31:6a2414b0', '1906/30': '31:6a2414b0', '1906/50': '31:6a2414b0', '1906/60': '31:6a2414b0',
  '1913/0': '42:6156c3d4', '1913/30': '41:43ce84a8', '1913/50': '41:43ce84a8', '1913/60': '41:43ce84a8',
  '1920/0': '74:9de85171', '1920/30': '74:9de85171', '1920/50': '74:9de85171', '1920/60': '74:9de85171',
  '1927/0': '27:11448c4f', '1927/30': '27:ba17daf6', '1927/50': '27:653dabe1', '1927/60': '27:be0511b2',
  '1934/0': '24:b078de58', '1934/30': '24:b078de58', '1934/50': '24:b078de58', '1934/60': '24:b078de58',
  '1941/0': '54:73a27d18', '1941/30': '54:b4a0d7ff', '1941/50': '54:bc5b7e52', '1941/60': '54:23098581',
  '1948/0': '11:2c0bb956', '1948/30': '11:2c0bb956', '1948/50': '11:2c0bb956', '1948/60': '11:2c0bb956',
  '1955/0': '42:d8fd6965', '1955/30': '42:d8fd6965', '1955/50': '42:d8fd6965', '1955/60': '42:d8fd6965',
  '1962/0': '10:f2a5aa78', '1962/30': '10:b3c55231', '1962/50': '10:a97cdd62', '1962/60': '10:cd2c309d',
};

describe('soundingEvents はスウィングの移設前後で同じ(シード固定ファズ)', () => {
  it('ループ・リンク・端数の拍・3/4・6/8・swing 0/30/50/60 で指紋が一致する', () => {
    for (const seed of FUZZ_SEEDS) {
      for (const swing of FUZZ_SWINGS) {
        const { events, problems } = soundingEvents(grooveFuzzProject(seed, swing), { includeMuted: true });
        expect(`${events.length}:${fnv1a(JSON.stringify([events, problems]))}`, `${seed}/${swing}`).toBe(GOLDEN[`${seed}/${swing}`]);
      }
    }
  });

  it('ファズの曲は 3/4・6/8・ループ・リンクを含み、swing=0 の曲は undefined の曲と同じ音を鳴らす', () => {
    const projects = FUZZ_SEEDS.map((seed) => grooveFuzzProject(seed, 0));
    expect(new Set(projects.map((p) => p.timeSignature.join('/')))).toEqual(new Set(['4/4', '3/4', '6/8']));
    const clips = projects.flatMap((p) => p.tracks.flatMap((t) => t.clips));
    expect(clips.some((c) => c.loop)).toBe(true);
    expect(clips.some((c) => c.aliasOf !== undefined)).toBe(true);
    for (const project of projects) {
      expect(soundingEvents({ ...project, swing: 0 })).toEqual(soundingEvents(project));
    }
  });

  it('ファズの各音はスウィング前の位置に swingBeat を掛けた位置で鳴る', () => {
    for (const seed of FUZZ_SEEDS) {
      for (const swing of FUZZ_SWINGS) {
        for (const event of soundingEvents(grooveFuzzProject(seed, swing), { includeMuted: true }).events) {
          expect(event.startBeat).toBe(swingBeat(event.unswungStartBeat, swing));
        }
      }
    }
  });
});

describe('quantize(強さ付き)', () => {
  const notes = [note('a', 0.1, 0.3), note('b', 0.9, 0.6), note('c', 1.37, 1.1), note('d', 2.5, 0.2)];

  it('strength 100 は既存のクオンタイズ(quantizeClipNotes)と同じ結果', () => {
    const project = makeProject([makeTrack('t', 'instrument', [{ ...midiClip('c', 't', 0, 8, []), notes }])]);
    for (const snap of [1, 0.5, 0.25, 1 / 3]) {
      const existing = quantizeClipNotes(project, 'c', notes.map((n) => n.id), snap).tracks[0]!.clips[0]!.notes!;
      expect(quantize(notes, snap, { strength: 100 })).toEqual(existing);
      expect(quantize(notes, snap)).toEqual(existing);
    }
  });

  it('strength 50 は元の位置とグリッドの中点', () => {
    const out = quantize(notes, 1, { strength: 50 });
    [0.05, 0.95, 1.185, 2.75].forEach((mid, i) => expect(out[i]!.startBeat).toBeCloseTo(mid, 12));
    expect(out.map((n) => n.durationBeats)).toEqual(notes.map((n) => n.durationBeats));
  });

  it('strength 0 は変えず、target で長さだけ・両方も揃えられる', () => {
    expect(quantize(notes, 0.5, { strength: 0 })).toEqual(notes);
    const length = quantize(notes, 0.5, { target: 'length' });
    expect(length.map((n) => [n.startBeat, n.durationBeats])).toEqual([[0.1, 0.5], [0.9, 0.5], [1.37, 1], [2.5, 0.5]]);
    const both = quantize(notes, 0.5, { target: 'both', strength: 50 });
    [[0.05, 0.4], [0.95, 0.55], [1.435, 1.05], [2.5, 0.35]].forEach(([start, length], i) => {
      expect(both[i]!.startBeat).toBeCloseTo(start!, 12);
      expect(both[i]!.durationBeats).toBeCloseTo(length!, 12);
    });
  });

  it('不正な入力では何も変えない', () => {
    for (const strength of [-1, 101, Number.NaN, Infinity]) expect(quantize(notes, 1, { strength })).toEqual(notes);
    for (const snap of [0, -1, Number.NaN, Infinity]) expect(quantize(notes, snap)).toEqual(notes);
  });
});

describe('humanize', () => {
  const notes = Array.from({ length: 32 }, (_, i) => note(`n${i}`, i * 0.25 + (i % 3) * 0.01, 0.2, 40 + i, [1, 64, 127, 100][i % 4]!));

  it('同じ seed なら同じ結果、別の seed なら別の結果', () => {
    const opts = { timingBeats: 0.05, velocity: 10, seed: 42 };
    expect(humanize(notes, opts)).toEqual(humanize(notes, opts));
    expect(humanize(notes, { ...opts, seed: 43 })).not.toEqual(humanize(notes, opts));
  });

  it('ピッチと長さを変えず、指定した幅を超えない(シード固定ファズ)', () => {
    const r = mulberry32(77);
    for (let trial = 0; trial < 200; trial++) {
      const timingBeats = [0, 0.01, 0.05, 1 / 3, 2][trial % 5]!;
      const velocity = [0, 1, 7.5, 20, 200][trial % 5]!;
      const seed = Math.floor(r() * 2 ** 31);
      const out = humanize(notes, { timingBeats, velocity, seed });
      out.forEach((n, i) => {
        const before = notes[i]!;
        expect(n.id).toBe(before.id);
        expect(n.pitch).toBe(before.pitch);
        expect(n.durationBeats).toBe(before.durationBeats);
        expect(Math.abs(n.startBeat - before.startBeat)).toBeLessThanOrEqual(timingBeats);
        expect(n.startBeat).toBeGreaterThanOrEqual(0);
        expect(Math.abs(n.velocity - before.velocity)).toBeLessThanOrEqual(velocity);
        expect(Number.isInteger(n.velocity) && n.velocity >= 1 && n.velocity <= 127).toBe(true);
      });
    }
  });

  it('幅 0 なら変えず、不正な入力でも変えない', () => {
    expect(humanize(notes, { timingBeats: 0, velocity: 0, seed: 1 })).toEqual(notes);
    for (const bad of [
      { timingBeats: -0.1, velocity: 5, seed: 1 },
      { timingBeats: Number.NaN, velocity: 5, seed: 1 },
      { timingBeats: 0.1, velocity: Infinity, seed: 1 },
      { timingBeats: 0.1, velocity: 5, seed: 1.5 },
      { timingBeats: 0.1, velocity: 5, seed: 2 ** 53 },
    ]) {
      expect(humanize(notes, bad)).toEqual(notes);
    }
  });
});
