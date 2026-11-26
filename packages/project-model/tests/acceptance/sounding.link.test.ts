import { describe, expect, it } from 'vitest';
import { soundingEvents } from '../../src/sounding';
import type { Clip, Project } from '../../src/index';
import { SEEDS, generateProject, makeProject, makeTrack, midiClip, tickOf } from './helpers';

type Ev = ReturnType<typeof soundingEvents>['events'][number];
const shape = (e: Ev): string => `${e.kind}|${e.trackId}|${tickOf(e.startBeat)}|${e.kind === 'note' ? `${e.pitch}|${tickOf(e.startBeat + e.durationBeats)}` : e.lane}|${e.velocity}`;

/** The same project with every link replaced by a clip that owns a copy of the linked content. */
function inlineLinks(p: Project): Project {
  const all = p.tracks.flatMap((t) => t.clips);
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c): Clip => {
        if (c.aliasOf === undefined) return c;
        const src = all.find((x) => x.id === c.aliasOf) as Clip;
        const { aliasOf: _drop, ...rest } = c;
        return {
          ...rest,
          ...(src.notes ? { notes: src.notes.map((n) => ({ ...n, id: `${c.id}-${n.id}` })) } : {}),
          ...(src.drumEvents ? { drumEvents: src.drumEvents.map((d) => ({ ...d, id: `${c.id}-${d.id}` })) } : {}),
          ...(src.stepsPerBar !== undefined ? { stepsPerBar: src.stepsPerBar } : {}),
        };
      }),
    })),
  };
}

describe('sounding.link', () => {
  it('sounding.link: リンクの発音はコピーの発音と一致する', () => {
    let withLinks = 0;
    for (const seed of SEEDS) {
      const project = generateProject(seed);
      if (!project.tracks.some((t) => t.clips.some((c) => c.aliasOf !== undefined))) continue;
      withLinks += 1;
      const linked = soundingEvents(project);
      const copied = soundingEvents(inlineLinks(project));
      expect(linked.events.map(shape).sort()).toEqual(copied.events.map(shape).sort());
      expect(linked.problems).toEqual([]);
    }
    expect(withLinks).toBeGreaterThan(100);
  });

  it('sounding.link: リンクの SoundingEvent は共有元を sourceClipId で指す', () => {
    const project = makeProject([
      makeTrack('t', 'instrument', [
        midiClip('src', 't', 0, 2, [[0, 1, 60]]),
        { id: 'lnk', trackId: 't', type: 'midi', startBeat: 4, lengthBeats: 2, loop: false, aliasOf: 'src' },
      ]),
    ]);
    const mine = soundingEvents(project).events.filter((e) => e.clipId === 'lnk');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.sourceClipId).toBe('src');
    expect(mine[0]?.sourceIndex).toBe(0);
  });
});
