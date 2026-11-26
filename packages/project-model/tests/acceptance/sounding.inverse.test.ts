import { describe, expect, it } from 'vitest';
import { soundingEvents, storedEventAt, PPQ } from '../../src/sounding';
import { validateProject } from '../../src/index';
import type { Clip, Project } from '../../src/index';
import { SEEDS, generateProject, makeProject, makeTrack, midiClip, tickOf } from './helpers';

type Ev = ReturnType<typeof soundingEvents>['events'][number];
const keyOf = (e: Ev): string => `${e.kind}|${e.trackId}|${tickOf(e.startBeat)}|${e.kind === 'note' ? `${e.pitch}|${tickOf(e.startBeat + e.durationBeats)}` : e.lane}|${e.velocity}`;

function removeStored(p: Project, sourceClipId: string, kind: 'note' | 'drum', index: number): Project {
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c): Clip => {
        if (c.id !== sourceClipId) return c;
        if (kind === 'note') return { ...c, notes: (c.notes ?? []).filter((_, i) => i !== index) };
        return { ...c, drumEvents: (c.drumEvents ?? []).filter((_, i) => i !== index) };
      }),
    })),
  };
}

describe('sounding.inverse', () => {
  it('sounding.inverse: storedEventAt が返すイベントを消すと、その位置の発音だけが消える', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const project = generateProject(seed);
      expect(validateProject(project).ok).toBe(true);
      const { events } = soundingEvents(project);
      const clipsById = new Map(project.tracks.flatMap((t) => t.clips).map((c) => [c.id, c]));
      // Only onsets that are alone at their position inside the clip (chords are ambiguous by design).
      const slot = (e: Ev): string => `${e.clipId}|${tickOf(e.startBeat - (clipsById.get(e.clipId) as Clip).startBeat)}`;
      const counts = new Map<string, number>();
      for (const e of events) counts.set(slot(e), (counts.get(slot(e)) ?? 0) + 1);
      const candidates = events.filter((e) => counts.get(slot(e)) === 1).slice(0, 3);
      for (const e of candidates) {
        const clip = clipsById.get(e.clipId) as Clip;
        const local = e.startBeat - clip.startBeat;
        const stored = storedEventAt(project, e.clipId, local);
        expect(stored).toEqual({ sourceClipId: e.sourceClipId, sourceIndex: e.sourceIndex });
        const after = soundingEvents(removeStored(project, e.sourceClipId, e.kind, e.sourceIndex)).events;
        // Everything that came from that stored event (its repeats and links) is gone; nothing else changes.
        const expected = events.filter((x) => !(x.sourceClipId === e.sourceClipId && x.kind === e.kind && x.sourceIndex === e.sourceIndex)).map(keyOf).sort();
        expect(after.map(keyOf).sort()).toEqual(expected);
        expect(after.some((x) => x.clipId === e.clipId && tickOf(x.startBeat) === tickOf(e.startBeat) && x.kind === e.kind && keyOf(x) === keyOf(e))).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('sounding.inverse: 何も鳴らない位置・クリップの終端・存在しないクリップでは null を返す', () => {
    const project = makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 4, 4, [[0, 1, 60], [5, 1, 62]])])]);
    expect(storedEventAt(project, 'a', 2)).toBeNull();
    expect(storedEventAt(project, 'a', 4)).toBeNull(); // the clip end is exclusive
    expect(storedEventAt(project, 'a', 5)).toBeNull(); // stored at 5 but beyond the clip end
    expect(storedEventAt(project, 'nope', 0)).toBeNull();
    expect(storedEventAt(project, 'a', 0)).toEqual({ sourceClipId: 'a', sourceIndex: 0 });
  });

  it('sounding.inverse: ループの 2 周目の位置も同じ保存イベントを指す', () => {
    const project = makeProject([
      makeTrack('t', 'instrument', [midiClip('a', 't', 0, 8, [[0.5, 0.25, 60]], { loop: true, contentLengthBeats: 2 })]),
    ]);
    expect(PPQ).toBeGreaterThan(0);
    expect(storedEventAt(project, 'a', 2.5)).toEqual({ sourceClipId: 'a', sourceIndex: 0 });
    expect(storedEventAt(project, 'a', 6.5)).toEqual({ sourceClipId: 'a', sourceIndex: 0 });
    expect(storedEventAt(project, 'a', 1.5)).toBeNull();
  });

  it('sounding.inverse: リンクの位置は共有元の保存イベントを指す', () => {
    const project = makeProject([
      makeTrack('t', 'instrument', [
        midiClip('src', 't', 0, 2, [[0, 1, 60], [1, 1, 62]]),
        { id: 'lnk', trackId: 't', type: 'midi', startBeat: 4, lengthBeats: 2, loop: false, aliasOf: 'src' },
      ]),
    ]);
    expect(storedEventAt(project, 'lnk', 1)).toEqual({ sourceClipId: 'src', sourceIndex: 1 });
  });
});
