// US-018 グルーヴ: スウィング(soundingEvents の中で掛かる写像)、強さ付きクオンタイズ、ヒューマナイズ。
import { describe, expect, it } from 'vitest';
import { applyHiHatChoke, applySwing, humanize, quantize, resampleDrumSteps, swingBeat } from '../src/groove';
import { quantizeClipNotes } from '../src/mutations';
import { soundingEvents } from '../src/sounding';
import { beatTick, PPQ } from '../src/time';
import type { DrumEvent, DrumLane, NoteEvent, Project } from '../src/types';
import { drumClip, makeProject, makeTrack, midiClip, mulberry32 } from './acceptance/helpers';
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
        // US-019 のチョークはオープンハットに durationBeats を足すだけなので、それを除いて比べる
        // (チョークの有無で他が変わらないことは下の「チョーク」の describe で確かめる)。
        const unchoked = events.map((event) => {
          if (event.kind !== 'drum' || event.durationBeats === undefined) return event;
          expect(event.lane).toBe('openHat');
          const { durationBeats: _choke, ...rest } = event;
          return rest;
        });
        expect(`${events.length}:${fnv1a(JSON.stringify([unchoked, problems]))}`, `${seed}/${swing}`).toBe(GOLDEN[`${seed}/${swing}`]);
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

// ---- US-019 ハイハットのチョーク ----

type Hit = { lane: DrumLane; startBeat: number; durationBeats?: number };
const hit = (lane: DrumLane, startBeat: number, durationBeats?: number): Hit =>
  durationBeats === undefined ? { lane, startBeat } : { lane, startBeat, durationBeats };

describe('applyHiHatChoke', () => {
  it('beat 0 のオープンハット(長さ 1)は beat 0.5 のクローズドハットで長さ 0.5 になる', () => {
    const out = applyHiHatChoke([hit('openHat', 0, 1), hit('closedHat', 0.5)]);
    expect(out[0]!.durationBeats).toBe(0.5);
    expect(out[1]).toEqual(hit('closedHat', 0.5));
  });

  it('クローズドハットが無ければ何も変えない(同じ要素を返す)', () => {
    const hits = [hit('openHat', 0, 1), hit('kick', 0.5), hit('snare', 1)];
    const out = applyHiHatChoke(hits);
    expect(out).toEqual(hits);
    out.forEach((h, i) => expect(h).toBe(hits[i]));
  });

  it('止めるのはクローズドハットだけ(キック・スネア・クラップ・パーカッション・次のオープンハットでは止まらない。ペダルのレーンは無い)', () => {
    for (const lane of ['kick', 'snare', 'clap', 'perc', 'openHat'] as const) {
      expect(applyHiHatChoke([hit('openHat', 0, 1), hit(lane, 0.25)])[0]!.durationBeats, lane).toBe(1);
    }
  });

  it('同じ tick と前のクローズドハットでは止まらず、後ろで最も近いクローズドハットで止まる。並び順は保つ', () => {
    const out = applyHiHatChoke([hit('closedHat', 2), hit('closedHat', 1), hit('openHat', 0.5, 4), hit('closedHat', 0.5), hit('closedHat', 0.25)]);
    expect(out.map((h) => [h.lane, h.startBeat])).toEqual([['closedHat', 2], ['closedHat', 1], ['openHat', 0.5], ['closedHat', 0.5], ['closedHat', 0.25]]);
    expect(out[2]!.durationBeats).toBe(0.5);
  });

  it('元の長さの方が短ければそのまま。長さの無いオープンハットはクローズドハットまでの長さになる', () => {
    expect(applyHiHatChoke([hit('openHat', 0, 0.25), hit('closedHat', 0.5)])[0]!.durationBeats).toBe(0.25);
    expect(applyHiHatChoke([hit('openHat', 0), hit('closedHat', 0.75)])[0]!.durationBeats).toBe(0.75);
    expect(applyHiHatChoke([hit('openHat', 0)])[0]!.durationBeats).toBeUndefined();
  });

  it('端数の位置でも止まる tick はクローズドハットの tick とちょうど同じ(事後条件)', () => {
    const r = mulberry32(19);
    for (let trial = 0; trial < 2000; trial++) {
      const open = Math.floor(r() * 4000) / [3, 7, 12, 480, 960][trial % 5]!;
      const closed = open + 1 / PPQ + r() * 3;
      const out = applyHiHatChoke([hit('openHat', open), hit('closedHat', closed)]);
      const dur = out[0]!.durationBeats!;
      expect(dur).toBeGreaterThan(0);
      if (beatTick(closed) > beatTick(open)) expect(beatTick(open + dur), `${open}/${closed}`).toBe(beatTick(closed));
    }
  });
});

const noOpenHat = (p: Project): Project => ({
  ...p,
  tracks: p.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => (c.drumEvents
      ? { ...c, drumEvents: c.drumEvents.map((d) => (d.lane === 'openHat' ? { ...d, lane: 'closedHat' as const } : d)) }
      : c)),
  })),
});

/** チョーク導入前(US-018 の HEAD 5968139)の soundingEvents で、オープンハットをクローズドに替えた曲の指紋。 */
const GOLDEN_NO_OPEN_HAT: Record<string, string> = {
  '1801/0': '34:a7097c3c', '1801/30': '34:0cc24d13', '1801/50': '34:17849c3a', '1801/60': '34:2addac73',
  '1808/0': '23:be3d1042', '1808/30': '23:9955232c', '1808/50': '23:d65ab094', '1808/60': '23:1e0f14a6',
  '1815/0': '35:39eb74a3', '1815/30': '35:70a62311', '1815/50': '35:d6590a9b', '1815/60': '35:2be48aab',
  '1822/0': '28:3f02be30', '1822/30': '28:72da4f03', '1822/50': '28:11130cb8', '1822/60': '28:8fed7c19',
  '1829/0': '30:4667b0b2', '1829/30': '30:a11760b3', '1829/50': '30:02efff3c', '1829/60': '30:42bfb0cf',
  '1836/0': '25:121d091f', '1836/30': '25:7c9ccd76', '1836/50': '25:82cde3d3', '1836/60': '25:1d4bf2fc',
  '1843/0': '33:6f55ddd6', '1843/30': '33:6f55ddd6', '1843/50': '33:6f55ddd6', '1843/60': '33:6f55ddd6',
  '1850/0': '25:edefc956', '1850/30': '25:5c7d6be1', '1850/50': '25:f68824f4', '1850/60': '25:07c0fcf7',
  '1857/0': '20:c5c310fd', '1857/30': '20:e78e4244', '1857/50': '20:821a1389', '1857/60': '20:bc723244',
  '1864/0': '36:897b35e6', '1864/30': '36:268fc2c7', '1864/50': '36:241a2eaa', '1864/60': '36:9d173a71',
  '1871/0': '17:3c24b572', '1871/30': '17:3c24b572', '1871/50': '17:3c24b572', '1871/60': '17:3c24b572',
  '1878/0': '14:5cdde623', '1878/30': '14:5cdde623', '1878/50': '14:5cdde623', '1878/60': '14:5cdde623',
  '1885/0': '38:a96aa511', '1885/30': '38:c9e4c4c0', '1885/50': '38:f91d0abb', '1885/60': '38:645b4d8e',
  '1892/0': '24:9b03cd3b', '1892/30': '24:8c604ac4', '1892/50': '24:be968599', '1892/60': '24:102e0100',
  '1899/0': '46:5bcef9cf', '1899/30': '46:5bcef9cf', '1899/50': '46:5bcef9cf', '1899/60': '46:5bcef9cf',
  '1906/0': '31:eaa59808', '1906/30': '31:eaa59808', '1906/50': '31:eaa59808', '1906/60': '31:eaa59808',
  '1913/0': '42:6156c3d4', '1913/30': '41:43ce84a8', '1913/50': '41:43ce84a8', '1913/60': '41:43ce84a8',
  '1920/0': '74:9fb5c571', '1920/30': '74:9fb5c571', '1920/50': '74:9fb5c571', '1920/60': '74:9fb5c571',
  '1927/0': '27:f6e0f547', '1927/30': '27:bd91fc4e', '1927/50': '27:00c2756d', '1927/60': '27:3cd60352',
  '1934/0': '24:c8e0a074', '1934/30': '24:c8e0a074', '1934/50': '24:c8e0a074', '1934/60': '24:c8e0a074',
  '1941/0': '54:cb491980', '1941/30': '54:6b353b4f', '1941/50': '54:824c7c8a', '1941/60': '54:92d299d1',
  '1948/0': '11:0053ef1a', '1948/30': '11:0053ef1a', '1948/50': '11:0053ef1a', '1948/60': '11:0053ef1a',
  '1955/0': '42:6759f6a9', '1955/30': '42:6759f6a9', '1955/50': '42:6759f6a9', '1955/60': '42:6759f6a9',
  '1962/0': '10:3ee00d80', '1962/30': '10:4c6a0169', '1962/50': '10:7b2d7ffa', '1962/60': '10:e76b0df5',
};

describe('soundingEvents のチョーク', () => {
  const drumTrack = (id: string, clips: ReturnType<typeof drumClip>[]) => makeTrack(id, 'drum', clips);
  const openEvents = (project: Project) =>
    soundingEvents(project).events.filter((e) => e.kind === 'drum' && e.lane === 'openHat');

  it('オープンハットの無い曲は、チョーク導入前と tick 単位で完全に同じ(シード固定ファズ)', () => {
    for (const seed of FUZZ_SEEDS) {
      for (const swing of FUZZ_SWINGS) {
        const { events, problems } = soundingEvents(noOpenHat(grooveFuzzProject(seed, swing)), { includeMuted: true });
        expect(events.some((e) => e.kind === 'drum' && e.durationBeats !== undefined)).toBe(false);
        expect(`${events.length}:${fnv1a(JSON.stringify([events, problems]))}`, `${seed}/${swing}`).toBe(GOLDEN_NO_OPEN_HAT[`${seed}/${swing}`]);
      }
    }
  });

  it('同じトラックのクローズドハットで止まり、クローズドハット側は長さを持たない', () => {
    const project = makeProject([drumTrack('d', [drumClip('a', 'd', 0, 4, [[0, 'openHat'], [2, 'closedHat']])])]);
    const events = soundingEvents(project).events;
    expect(events.find((e) => e.kind === 'drum' && e.lane === 'openHat')).toMatchObject({ startBeat: 0, durationBeats: 0.5 });
    expect(events.find((e) => e.kind === 'drum' && e.lane === 'closedHat')).not.toHaveProperty('durationBeats');
  });

  it('別のトラックのクローズドハットでは止まらない(トラックごとに別のハイハット)', () => {
    const project = makeProject([
      drumTrack('d1', [drumClip('a', 'd1', 0, 4, [[0, 'openHat']])]),
      drumTrack('d2', [drumClip('b', 'd2', 0, 4, [[2, 'closedHat']])]),
    ]);
    expect(openEvents(project)).toHaveLength(1);
    expect(openEvents(project)[0]).not.toHaveProperty('durationBeats');
  });

  it('同じトラックなら別のクリップ・ループの次の周・リンク先のクローズドハットでも止まる', () => {
    const project = makeProject([drumTrack('d', [
      drumClip('a', 'd', 0, 4, [[15, 'openHat']]),
      drumClip('b', 'd', 4, 4, [[1, 'closedHat']]),
      drumClip('l', 'd', 8, 2, [[0, 'closedHat'], [2, 'openHat']], { loop: true, contentLengthBeats: 1 }),
      drumClip('k', 'd', 10, 1, [], { aliasOf: 'b', drumEvents: undefined }),
    ])]);
    const opens = openEvents(project);
    // 3.75 は次のクリップの 4.25、ループ 1 周目の 8.5 は 2 周目の 9、2 周目の 9.5 はリンク先の 10.25 で止まる
    expect(opens.map((e) => [e.startBeat, e.kind === 'drum' ? e.durationBeats : null])).toEqual([[3.75, 0.5], [8.5, 0.5], [9.5, 0.75]]);
  });

  it('スウィングで遅れたクローズドハットの位置で止まる(発音の正の中で掛かる)', () => {
    const project = makeProject([drumTrack('d', [drumClip('a', 'd', 0, 4, [[0, 'openHat'], [1, 'closedHat']])])], { swing: 50 });
    expect(openEvents(project)[0]).toMatchObject({ durationBeats: 0.375 });
  });

  it('ミュートしたトラックの音は止める側にも止められる側にもならない(鳴る音だけで判定)', () => {
    const project = makeProject([
      drumTrack('d', [drumClip('a', 'd', 0, 4, [[0, 'openHat'], [2, 'closedHat']])]),
      { ...drumTrack('m', [drumClip('b', 'm', 0, 4, [[1, 'closedHat']])]), mute: true },
    ]);
    expect(openEvents(project)[0]).toMatchObject({ durationBeats: 0.5 });
  });
});

// ---- US-019 ドラムの 12/16 ステップ切替 ----

const drumHits = (steps: number[], lane: DrumLane = 'kick', velocity = 100): DrumEvent[] =>
  steps.map((stepIndex, i) => ({ id: `h${i}`, lane, stepIndex, velocity }));

describe('resampleDrumSteps', () => {
  it('16→12: ステップ 1(1/16)は最も近いステップ 1 へ移り、ずれた個数が返る', () => {
    const r = resampleDrumSteps(drumHits([0, 1, 4, 8]), 16, 12);
    expect(r.events.map((e) => e.stepIndex)).toEqual([0, 1, 3, 6]);
    expect(r.moved).toBe(1);
    expect(r.merged).toBe(0);
  });

  it('12→16: 3 の倍数の位置だけ無損失。ステップ 3 は 4 へ移って個数 0、ステップ 1 は個数 1', () => {
    expect(resampleDrumSteps(drumHits([3]), 12, 16)).toMatchObject({ events: [{ stepIndex: 4 }], moved: 0, merged: 0 });
    expect(resampleDrumSteps(drumHits([1]), 12, 16)).toMatchObject({ events: [{ stepIndex: 1 }], moved: 1, merged: 0 });
    const all = resampleDrumSteps(drumHits(Array.from({ length: 24 }, (_, i) => i)), 12, 16);
    expect(all.moved).toBe(16);
    expect(all.events.filter((e, i) => i % 3 === 0).map((e) => e.stepIndex)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
  });

  it('同じレーン・同じステップに重なる打点は 1 つにまとめ、まとめた個数を返す(拍に合っていた方、次に強い方を残す)', () => {
    // 16 の 2(0.5 拍)と 3(0.75 拍)は 12 の 2 に重なる。どちらもずれるので強い方を残す。
    const events: DrumEvent[] = [
      { id: 'a', lane: 'kick', stepIndex: 2, velocity: 60 },
      { id: 'b', lane: 'kick', stepIndex: 3, velocity: 90 },
      { id: 'c', lane: 'snare', stepIndex: 3, velocity: 90 },
      { id: 'd', lane: 'snare', stepIndex: 4, velocity: 10 },
    ];
    const r = resampleDrumSteps(events, 16, 12);
    expect(r.events.map((e) => [e.id, e.stepIndex])).toEqual([['b', 2], ['c', 2], ['d', 3]]);
    expect(r.merged).toBe(1);
    expect(r.moved).toBe(2);
  });

  it('ずれた個数は絶対 tick の変化と一致する(端数の開始拍・3/4・4/4・往復)', () => {
    const r = mulberry32(1912);
    for (let trial = 0; trial < 400; trial++) {
      const bpb = trial % 2 === 0 ? 4 : 3;
      const clipStartBeat = [0, 1 / 3, 0.1, 2.75, 1 / 7][trial % 5]!;
      const [from, to] = trial % 4 < 2 ? [16, 12] : [12, 16];
      const events = drumHits(Array.from({ length: 1 + Math.floor(r() * 12) }, () => Math.floor(r() * 64)), 'kick')
        .map((e, i) => ({ ...e, id: `e${i}`, lane: (['kick', 'snare', 'closedHat'] as const)[i % 3]!, velocity: 1 + (i * 37) % 127 }));
      const out = resampleDrumSteps(events, from, to, { beatsPerBar: bpb, clipStartBeat });
      const tickOf = (step: number, steps: number) => beatTick(clipStartBeat + step * (bpb / steps));
      const byId = new Map(events.map((e) => [e.id, e]));
      let moved = 0;
      for (const e of out.events) {
        const before = byId.get(e.id)!;
        // 移動先はいちばん近いステップ(同じ近さなら後ろ)
        const exact = (before.stepIndex * to) / from;
        expect(Math.abs(e.stepIndex - exact)).toBeLessThanOrEqual(0.5);
        if (tickOf(e.stepIndex, to) !== tickOf(before.stepIndex, from)) moved++;
      }
      expect(out.moved).toBe(moved);
      expect(out.events.length + out.merged).toBe(events.length);
      expect(new Set(out.events.map((e) => `${e.lane}:${e.stepIndex}`)).size).toBe(out.events.length);
    }
  });

  it('stepsBack を指定した打点は手前のステップへ移す。同じ細かさ・不正な細かさでは何も変えない', () => {
    const events = drumHits([15]);
    expect(resampleDrumSteps(events, 12, 16).events[0]!.stepIndex).toBe(20);
    expect(resampleDrumSteps(drumHits([2]), 16, 12, { stepsBack: () => 1 }).events[0]!.stepIndex).toBe(1);
    for (const [from, to] of [[16, 16], [0, 12], [16, 12.5], [Number.NaN, 12]]) {
      const r = resampleDrumSteps(events, from!, to!);
      expect(r).toEqual({ events, moved: 0, merged: 0, outOfRange: 0 });
    }
  });
});

describe('resampleDrumSteps の範囲(US-019 レビュー)', () => {
  it('stepIndex 1e308 の 16→12 は途中であふれず、有限の整数になる', () => {
    const r = resampleDrumSteps(drumHits([1e308]), 16, 12);
    expect(r.outOfRange).toBe(0);
    expect(Number.isFinite(r.events[0]!.stepIndex)).toBe(true);
    expect(Number.isInteger(r.events[0]!.stepIndex)).toBe(true);
    expect(r.events[0]!.stepIndex).toBe(7.5e307);
  });

  it('移動先が有限の整数にならない打点があれば何も変えず、その数を返す', () => {
    const events = drumHits([4, 1.7e308]);
    const r = resampleDrumSteps(events, 12, 16);
    expect(r).toEqual({ events, moved: 0, merged: 0, outOfRange: 1 });
  });

  it('安全な整数の範囲では約分した比で求めた位置が素朴な式と同じ', () => {
    const r = mulberry32(308);
    for (let trial = 0; trial < 2000; trial++) {
      const step = Math.floor(r() * 2 ** 40);
      const [from, to] = trial % 2 === 0 ? [16, 12] : [12, 16];
      const out = resampleDrumSteps(drumHits([step]), from, to);
      expect(out.events[0]!.stepIndex, `${step} ${from}→${to}`).toBe(Math.floor((2 * step * to + from) / (2 * from)));
    }
  });
});

describe('resampleDrumSteps の整数でない stepsPerBar(US-019 レビュー 2 回目)', () => {
  it('stepsPerBar 12.5 のステップ 1(154 tick)を 16 マスにすると 1(120 tick)へ移り、ずれた個数 1', () => {
    const r = resampleDrumSteps(drumHits([1]), 12.5, 16);
    expect(r).toMatchObject({ events: [{ stepIndex: 1 }], moved: 1, merged: 0, outOfRange: 0 });
  });

  it('シード固定ファズ: 整数でない元の細かさでも、最も近いステップへ移り、ずれた個数は拍位置の tick の変化と一致する', () => {
    const r = mulberry32(125);
    for (let trial = 0; trial < 600; trial++) {
      const from = [12.5, 13.7, 15.999, 7.25, 16.5, 1 / 3, 24.1][trial % 7]!;
      const to = trial % 2 === 0 ? 16 : 12;
      const bpb = trial % 3 === 0 ? 3 : 4;
      const clipStartBeat = [0, 1 / 3, 0.1][trial % 3]!;
      const events = Array.from({ length: 1 + Math.floor(r() * 10) }, (_, i): DrumEvent => ({
        id: `e${i}`, lane: (['kick', 'snare'] as const)[i % 2]!, stepIndex: Math.floor(r() * 80), velocity: 100,
      }));
      const out = resampleDrumSteps(events, from, to, { beatsPerBar: bpb, clipStartBeat });
      expect(out.outOfRange).toBe(0);
      const tickOf = (step: number, steps: number) => beatTick(clipStartBeat + step * (bpb / steps));
      let moved = 0;
      for (const e of out.events) {
        const before = events.find((o) => o.id === e.id)!;
        // 最も近さは、tick に丸めた元の位置から測る(US-019 レビュー 3 回目の規則)。
        const fromTick = beatTick(before.stepIndex * (bpb / from));
        expect(Math.abs(e.stepIndex - (fromTick * to) / beatTick(bpb))).toBeLessThanOrEqual(0.5);
        if (tickOf(e.stepIndex, to) !== tickOf(before.stepIndex, from)) moved++;
      }
      expect(out.moved, `${from}→${to}`).toBe(moved);
      expect(out.events.length + out.merged).toBe(events.length);
    }
  });
});

describe('resampleDrumSteps の同点(US-019 レビュー 3 回目)', () => {
  /** 元の位置の tick(クリップ先頭から)。移動数の比較と同じ丸め。 */
  const sourceTick = (step: number, from: number, bpb: number) => beatTick(step * (bpb / from));
  /** tick から最も近い移動先(同点は後ろ)を BigInt で求める独立な式。 */
  const expectedTarget = (tick: number, to: number, bpb: number) => {
    const bar = BigInt(beatTick(bpb));
    return Number((BigInt(tick) * BigInt(to) * 2n + bar) / (bar * 2n));
  };

  it('stepsPerBar 14.4 のステップ 9(1200 tick)は 1120 と 1280 の中間なので後ろの 1280 tick へ移り、ステップ 8 とはまとめない', () => {
    const r = resampleDrumSteps(drumHits([8, 9]), 14.4, 12, { beatsPerBar: 4 });
    expect(r.events.map((e) => e.stepIndex)).toEqual([7, 8]);
    expect(r.events.map((e) => beatTick(e.stepIndex * (4 / 12)))).toEqual([1120, 1280]);
    expect(r).toMatchObject({ merged: 0, moved: 2 });
  });

  it('シード固定ファズ: 整数でない from で、ちょうど中間の打点は必ず後ろへ移り、まとめられるのは最も近いマスが同じ打点だけ', () => {
    const r = mulberry32(144);
    let midpoints = 0;
    for (const bpb of [4, 3]) {
      for (const from of [14.4, 12.5, 9.6, 19.2, 7.2, 28.8, 13.7, 15.999, 4.8]) {
        for (const to of [12, 16]) {
          const steps = Array.from({ length: 400 }, (_, i) => i);
          for (const step of steps) {
            const tick = sourceTick(step, from, bpb);
            const bar = beatTick(bpb);
            if ((2 * tick * to) % bar === 0 && ((2 * tick * to) / bar) % 2 === 1) {
              midpoints++;
              const out = resampleDrumSteps(drumHits([step]), from, to, { beatsPerBar: bpb });
              expect(out.events[0]!.stepIndex, `${bpb} ${from}→${to} step ${step}`).toBe(((2 * tick * to) / bar + 1) / 2);
            }
          }
          // ランダムな打点の組: 各打点の移動先は独立な式どおり、まとめた数はその重なりの数と一致する。
          for (let trial = 0; trial < 20; trial++) {
            const events = Array.from({ length: 2 + Math.floor(r() * 12) }, (_, i): DrumEvent => ({
              id: `e${i}`, lane: (['kick', 'snare'] as const)[Math.floor(r() * 2)]!, stepIndex: Math.floor(r() * 120), velocity: 100,
            })).filter((e, i, all) => all.findIndex((o) => o.lane === e.lane && o.stepIndex === e.stepIndex) === i);
            const out = resampleDrumSteps(events, from, to, { beatsPerBar: bpb });
            const target = new Map(events.map((e) => [e.id, expectedTarget(sourceTick(e.stepIndex, from, bpb), to, bpb)]));
            for (const e of out.events) expect(e.stepIndex, `${from}→${to}`).toBe(target.get(e.id));
            const groups = new Set(events.map((e) => `${e.lane}:${target.get(e.id)}`));
            expect(out.events.length).toBe(groups.size);
            expect(out.merged).toBe(events.length - groups.size);
          }
        }
      }
    }
    expect(midpoints).toBeGreaterThan(20);
  });

  it('整数の from では結果が約分した整数比の式(従来)と同じ', () => {
    const r = mulberry32(1616);
    for (let trial = 0; trial < 3000; trial++) {
      const from = [16, 12, 24, 8, 7, 5][trial % 6]!;
      const to = trial % 2 === 0 ? 12 : 16;
      if (from === to) continue;
      const step = Math.floor(r() * 2 ** 30);
      const out = resampleDrumSteps(drumHits([step]), from, to, { beatsPerBar: [4, 3, 3.5][trial % 3]! });
      expect(out.events[0]!.stepIndex).toBe(Math.floor((2 * step * to + from) / (2 * from)));
    }
  });
});

describe('resampleDrumSteps の大きなステップ番号(US-019 レビュー 4 回目)', () => {
  /** 独立なオラクル: from = fn / fd(10 進の有理数)、1 拍 = 480 tick、拍数 bpb(整数)。BigInt で厳密に。 */
  const oracle = (step: number, [fn, fd]: [bigint, bigint], to: number, bpb: number, integerFrom: boolean): number | 'out' => {
    const s = BigInt(step);
    const t = BigInt(to);
    let target: bigint;
    if (integerFrom) {
      const f = fn / fd;
      target = (2n * s * t + f) / (2n * f);
    } else {
      const barTicks = BigInt(bpb * 480);
      const tick = (2n * s * barTicks * fd + fn) / (2n * fn); // round(step × barTicks / from)、同点は後ろ
      target = (2n * tick * t + barTicks) / (2n * barTicks);
    }
    const n = Number(target);
    return Number.isFinite(n) && BigInt(n) === target ? n : 'out';
  };

  it('stepsPerBar 14.4 のステップ 1000000000000012 と 1000000000000013 は、12 マスの 833333333333343 と 833333333333344 へ別々に移る', () => {
    const r = resampleDrumSteps(drumHits([1000000000000012, 1000000000000013]), 14.4, 12, { beatsPerBar: 4 });
    expect(r.events.map((e) => e.stepIndex)).toEqual([833333333333343, 833333333333344]);
    expect(r.merged).toBe(0);
    expect(r.outOfRange).toBe(0);
  });

  it('シード固定ファズ: 2^50〜2^53 付近のステップ番号で、整数・非整数の from とも厳密な式と一致し、保存できない移動先なら何も変えない', () => {
    const r = mulberry32(253);
    const froms: Array<[number, [bigint, bigint], boolean]> = [
      [16, [16n, 1n], true], [12, [12n, 1n], true], [7, [7n, 1n], true],
      [14.4, [144n, 10n], false], [12.5, [125n, 10n], false], [13.7, [137n, 10n], false], [15.999, [15999n, 1000n], false],
    ];
    let checked = 0;
    let refused = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const [from, rational, integerFrom] = froms[trial % froms.length]!;
      const to = trial % 2 === 0 ? 12 : 16;
      if (from === to) continue;
      const bpb = trial % 3 === 0 ? 3 : 4;
      const exponent = 50 + Math.floor(r() * 4); // 2^50〜2^53
      const step = Math.floor(2 ** exponent * (1 + r())) + [0, 1, -1][trial % 3]!;
      if (!Number.isInteger(step) || step < 0) continue;
      const expected = oracle(step, rational, to, bpb, integerFrom);
      const out = resampleDrumSteps(drumHits([step]), from, to, { beatsPerBar: bpb });
      if (expected === 'out') {
        refused++;
        expect(out.outOfRange, `${step} ${from}→${to}`).toBe(1);
        expect(out.events[0]!.stepIndex).toBe(step);
      } else {
        checked++;
        expect(out.outOfRange).toBe(0);
        expect(out.events[0]!.stepIndex, `${step} ${from}→${to} (${bpb})`).toBe(expected);
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(50);
  });

  it('1 小節の拍数が不正なら例外を出さず、何も変えずに全打点を範囲外と数える', () => {
    for (const beatsPerBar of [0, -4, Number.NaN, Infinity]) {
      expect(resampleDrumSteps(drumHits([1, 2]), 14.4, 12, { beatsPerBar })).toMatchObject({ moved: 0, merged: 0, outOfRange: 2 });
    }
  });

  it('隣り合う大きなステップ番号の組が、厳密な移動先が同じときだけまとめられる', () => {
    const r = mulberry32(5300);
    for (let trial = 0; trial < 500; trial++) {
      const base = Math.floor(2 ** 49 * (1 + r()));
      const steps = [base, base + 1, base + 2, base + 3];
      const out = resampleDrumSteps(drumHits(steps), 14.4, 12, { beatsPerBar: 4 });
      const targets = steps.map((s) => oracle(s, [144n, 10n], 12, 4, false));
      if (targets.includes('out')) continue;
      expect(out.events.length).toBe(new Set(targets).size);
      expect(out.merged).toBe(steps.length - new Set(targets).size);
    }
  });
});
