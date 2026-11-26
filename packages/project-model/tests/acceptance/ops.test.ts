// ops.* acceptance tests (pure project-model operations). Owned by US-011a; written here against
// the planned contract so US-007a's sounding model is exercised through the operations as well.
import { describe, expect, it } from 'vitest';
import { soundingEvents, songEndBeat } from '../../src/sounding';
import { duplicateClip, moveClip, removeClip, resizeClip, splitClip } from '../../src/index';
import type { Clip, Project } from '../../src/index';
import { SEEDS, generateProject, hasOverlap, tickOf } from './helpers';

type Ev = ReturnType<typeof soundingEvents>['events'][number];
const clipsOf = (p: Project): Clip[] => p.tracks.flatMap((t) => t.clips);
const shape = (e: Ev, shift = 0): string =>
  `${e.kind}|${e.trackId}|${tickOf(e.startBeat) + shift}|${e.kind === 'note' ? `${e.pitch}|${tickOf(e.startBeat + e.durationBeats) + shift}` : e.lane}|${e.velocity}`;
const isLinkSource = (p: Project, c: Clip): boolean => clipsOf(p).some((x) => x.aliasOf === c.id);

describe('ops.move', () => {
  it('ops.move: 発音が移動量だけ平行移動する', () => {
    let applied = 0;
    for (const seed of SEEDS.slice(0, 250)) {
      const project = generateProject(seed, { allowOverrunSongEnd: false });
      for (const track of project.tracks) {
        const clip = track.clips[0];
        if (!clip) continue;
        const lastEnd = Math.max(...track.clips.map((c) => c.startBeat + c.lengthBeats));
        const target = lastEnd; // the free spot after the last clip
        if (target === clip.startBeat || target + clip.lengthBeats > songEndBeat(project)) continue;
        const moved = moveClip(project, clip.id, target);
        const now = clipsOf(moved).find((c) => c.id === clip.id) as Clip;
        expect(now.startBeat).toBe(target);
        const delta = tickOf(target) - tickOf(clip.startBeat);
        const before = soundingEvents(project).events;
        const after = soundingEvents(moved).events;
        expect(after.filter((e) => e.clipId === clip.id).map((e) => shape(e)).sort()).toEqual(before.filter((e) => e.clipId === clip.id).map((e) => shape(e, delta)).sort());
        expect(after.filter((e) => e.clipId !== clip.id).map((e) => shape(e)).sort()).toEqual(before.filter((e) => e.clipId !== clip.id).map((e) => shape(e)).sort());
        applied += 1;
      }
    }
    expect(applied).toBeGreaterThan(50);
  });
});

describe('ops.split', () => {
  it('ops.split: 音高ごとの発音区間の和集合が不変、ノート長の合計が不変', () => {
    let applied = 0;
    for (const seed of SEEDS.slice(0, 250)) {
      const project = generateProject(seed, { allowOverrunSongEnd: false });
      for (const clip of clipsOf(project)) {
        if (clip.loop || clip.aliasOf !== undefined || isLinkSource(project, clip) || clip.type !== 'midi' || clip.lengthBeats < 2) continue;
        const at = clip.startBeat + Math.floor(clip.lengthBeats / 2);
        const result = splitClip(project, clip.id, at);
        expect(result.ok).toBe(true);
        const intervals = (p: Project): Map<string, Array<[number, number]>> => {
          const m = new Map<string, Array<[number, number]>>();
          for (const e of soundingEvents(p).events) {
            if (e.kind !== 'note') continue;
            const k = `${e.trackId}|${e.pitch}`;
            m.set(k, [...(m.get(k) ?? []), [tickOf(e.startBeat), tickOf(e.startBeat + e.durationBeats)]]);
          }
          return m;
        };
        const union = (xs: Array<[number, number]>): Array<[number, number]> => {
          const out: Array<[number, number]> = [];
          for (const [s, e] of [...xs].sort((a, b) => a[0] - b[0])) {
            const last = out[out.length - 1];
            if (last && s <= last[1]) last[1] = Math.max(last[1], e);
            else out.push([s, e]);
          }
          return out;
        };
        const a = intervals(project);
        const b = intervals(result.project);
        expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
        for (const [k, xs] of a) {
          expect(union(b.get(k) ?? []), k).toEqual(union(xs));
          const total = (ys: Array<[number, number]>): number => ys.reduce((n, [s, e]) => n + (e - s), 0);
          expect(total(b.get(k) ?? []), k).toBe(total(xs));
        }
        applied += 1;
        break;
      }
    }
    expect(applied).toBeGreaterThan(50);
  });

  it('ops.split: ループ・リンククリップは理由付きで元のプロジェクトを返す', () => {
    let looped = 0;
    let linked = 0;
    for (const seed of SEEDS.slice(0, 250)) {
      const project = generateProject(seed, { allowOverrunSongEnd: false });
      for (const clip of clipsOf(project)) {
        if (clip.lengthBeats < 2 || !(clip.loop || clip.aliasOf !== undefined)) continue;
        const result = splitClip(project, clip.id, clip.startBeat + 1);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.project).toBe(project);
        expect(typeof result.reason).toBe('string');
        expect(String(result.reason).length).toBeGreaterThan(0);
        if (clip.loop) looped += 1;
        if (clip.aliasOf !== undefined) linked += 1;
      }
    }
    expect(looped).toBeGreaterThan(10);
    expect(linked).toBeGreaterThan(10);
  });
});

describe('ops.duplicate / ops.resize', () => {
  it('ops.duplicate / ops.resize: duplicateClip は同一トラックに重なりを作らない', () => {
    for (const seed of SEEDS.slice(0, 250)) {
      const project = generateProject(seed);
      for (const clip of clipsOf(project).slice(0, 4)) {
        for (const mode of ['copy', 'link'] as const) {
          expect(hasOverlap(duplicateClip(project, clip.id, { mode })), `${seed} ${clip.id} ${mode}`).toBe(false);
          expect(hasOverlap(duplicateClip(project, clip.id, { mode, startBeat: clip.startBeat })), `${seed} ${clip.id} ${mode} same start`).toBe(false);
        }
      }
    }
  });

  it('ops.duplicate / ops.resize: resizeClip は同一トラックに重なりを作らない', () => {
    for (const seed of SEEDS.slice(0, 250)) {
      const project = generateProject(seed);
      for (const clip of clipsOf(project).slice(0, 4)) {
        for (const length of [0.5, clip.lengthBeats * 3, clip.lengthBeats + 40]) {
          expect(hasOverlap(resizeClip(project, clip.id, length)), `${seed} ${clip.id} ${length}`).toBe(false);
        }
      }
    }
  });
});

describe('ops.remove', () => {
  it('ops.remove: リンク元を削除しても他クリップの発音が不変', () => {
    let applied = 0;
    for (const seed of SEEDS) {
      const project = generateProject(seed);
      for (const src of clipsOf(project).filter((c) => isLinkSource(project, c))) {
        const before = soundingEvents(project).events.filter((e) => e.clipId !== src.id).map((e) => shape(e)).sort();
        const after = soundingEvents(removeClip(project, src.id)).events.map((e) => shape(e)).sort();
        expect(after).toEqual(before);
        applied += 1;
      }
    }
    expect(applied).toBeGreaterThan(50);
  });
});
