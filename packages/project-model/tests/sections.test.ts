import { describe, expect, it } from 'vitest';
import {
  deleteSection,
  duplicateSection,
  moveSection,
  PPQ,
  removeClip,
  SECTION_EDIT_FAILURE_MESSAGES,
  soundingEvents,
  validateProject,
} from '../src/index';
import type { ChordEvent, Clip, Project, Section, SectionEditResult } from '../src/index';
import { drumClip, generateProject, hasOverlap, makeProject, makeTrack, midiClip, mulberry32, SEEDS } from './acceptance/helpers';

const clock = () => new Date('2026-11-27T00:00:00.000Z');
const tick = (beat: number) => Math.round(beat * PPQ);
const clipsOf = (p: Project): Clip[] => p.tracks.flatMap((t) => t.clips);
const clipById = (p: Project, id: string) => clipsOf(p).find((c) => c.id === id);
const noteCount = (p: Project) => clipsOf(p).reduce((n, c) => n + (c.notes?.length ?? 0) + (c.drumEvents?.length ?? 0), 0);
const events = (p: Project) => soundingEvents(p, { includeMuted: true }).events;
/** Sounding events whose onset tick is in [from, to). */
const eventsIn = (p: Project, from: number, to: number) =>
  events(p).filter((e) => tick(e.startBeat) >= from && tick(e.startBeat) < to);

function ok(result: SectionEditResult): Project {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.reason}`);
  expect(validateProject(result.project).errors).toEqual([]);
  expect(hasOverlap(result.project)).toBe(false);
  return result.project;
}

function section(id: string, startBar: number, lengthBars: number, type: Section['type'] = 'verse'): Section {
  return { id, name: id, type, startBar, lengthBars };
}

function chord(id: string, startBeat: number, durationBeats: number): ChordEvent {
  return { id, symbol: 'C', root: 'C', quality: 'maj', notes: [60, 64, 67], startBeat, durationBeats };
}

/**
 * 4/4, 6 bars, three 2-bar sections (beats 0-8, 8-16, 16-24). An instrument
 * track with one clip per section, a drum track with a clip in the middle
 * section, and one chord per section.
 */
function threeSections(over: Partial<Project> = {}): Project {
  return makeProject(
    [
      makeTrack('inst', 'instrument', [
        midiClip('a', 'inst', 0, 8, [[0, 1, 60], [4, 2, 62]]),
        midiClip('b', 'inst', 8, 8, [[0, 1, 64], [2, 1, 65], [6, 2, 67]]),
        midiClip('c', 'inst', 16, 8, [[1, 1, 69]]),
      ]),
      makeTrack('drums', 'drum', [drumClip('d', 'drums', 8, 8, [[0, 'kick'], [4, 'snare'], [16, 'kick']])]),
    ],
    {
      lengthBars: 6,
      sections: [section('s1', 0, 2, 'intro'), section('s2', 2, 2, 'chorus'), section('s3', 4, 2, 'outro')],
      chordTrack: [chord('ch1', 0, 8), chord('ch2', 8, 8), chord('ch3', 16, 8)],
      ...over,
    },
  );
}

// --- Sounding invariant: outside the edited range the audio only moves. ---

type Ev = ReturnType<typeof events>[number];

/** Per track / pitch / velocity, the union of note intervals clipped to [from, to), moved by `shift` ticks. */
function noteUnion(evs: readonly Ev[], from: number, to: number, shift: number): string[] {
  const byKey = new Map<string, Array<[number, number]>>();
  for (const e of evs) {
    if (e.kind !== 'note') continue;
    const s = Math.max(tick(e.startBeat), from);
    const end = Math.min(tick(e.startBeat + e.durationBeats), to);
    if (end <= s) continue;
    const key = `${e.trackId}|${e.pitch}|${e.velocity}`;
    byKey.set(key, [...(byKey.get(key) ?? []), [s + shift, end + shift]]);
  }
  const out: string[] = [];
  for (const [key, spans] of byKey) {
    spans.sort((x, y) => x[0] - y[0]);
    let [cs, ce] = spans[0]!;
    for (const [s, e] of spans.slice(1)) {
      if (s <= ce) ce = Math.max(ce, e);
      else {
        out.push(`${key}|${cs}-${ce}`);
        [cs, ce] = [s, e];
      }
    }
    out.push(`${key}|${cs}-${ce}`);
  }
  return out.sort();
}

/** Drum hits and note onsets after `from` (a split may start a note piece exactly at `from`). */
function onsets(evs: readonly Ev[], from: number, to: number, shift: number): string[] {
  return evs
    .filter((e) => {
      const t = tick(e.startBeat);
      return t < to && (t > from || (t === from && e.kind === 'drum'));
    })
    .map((e) =>
      e.kind === 'drum'
        ? `d|${e.trackId}|${tick(e.startBeat) + shift}|${e.lane}|${e.velocity}`
        : `n|${e.trackId}|${tick(e.startBeat) + shift}|${e.pitch}|${e.velocity}|${Math.min(tick(e.startBeat + e.durationBeats), to) + shift}`,
    )
    .sort();
}

/** Whatever sounds in [from, to) before sounds in [from + shift, to + shift) after, and nothing else there. */
function expectMoved(before: Project, after: Project, from: number, to: number, shift: number): void {
  const b = events(before);
  const a = events(after);
  expect(noteUnion(a, from + shift, to + shift, 0)).toEqual(noteUnion(b, from, to, shift));
  expect(onsets(a, from + shift, to + shift, 0)).toEqual(onsets(b, from, to, shift));
}

describe('duplicateSection', () => {
  it('grows lengthBars by the range, doubles the notes in it and moves later clips back by its length', () => {
    const project = threeSections();
    const after = ok(duplicateSection(project, 's2', clock));
    expect(after.lengthBars).toBe(8);
    expect(eventsIn(after, tick(8), tick(24))).toHaveLength(2 * eventsIn(project, tick(8), tick(16)).length);
    expect(eventsIn(project, tick(8), tick(16)).length).toBeGreaterThan(0);
    expect(clipById(after, 'c')?.startBeat).toBe(24);
    expect(after.chordTrack.map((c) => c.startBeat).sort((x, y) => x - y)).toEqual([0, 8, 16, 24]);
    const sections = [...after.sections].sort((x, y) => x.startBar - y.startBar);
    expect(sections.map((s) => [s.type, s.startBar, s.lengthBars])).toEqual([
      ['intro', 0, 2], ['chorus', 2, 2], ['chorus', 4, 2], ['outro', 6, 2],
    ]);
    expect(new Set(sections.map((s) => s.id)).size).toBe(4);
    expectMoved(project, after, 0, tick(16), 0);
    expectMoved(project, after, tick(8), tick(16), tick(8));
    expectMoved(project, after, tick(16), Infinity, tick(8));
    expect(after.updatedAt).toBe('2026-11-27T00:00:00.000Z');
  });

  it('copies get new ids and drum clips are duplicated like any other clip', () => {
    const project = threeSections();
    const after = ok(duplicateSection(project, 's2', clock));
    const drums = after.tracks.find((t) => t.id === 'drums')!.clips;
    expect(drums.map((c) => c.startBeat).sort((x, y) => x - y)).toEqual([8, 16]);
    const ids = clipsOf(after).flatMap((c) => [c.id, ...(c.notes ?? []).map((n) => n.id), ...(c.drumEvents ?? []).map((d) => d.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses a duplicate past the longest song and returns the project with a reason', () => {
    const project = threeSections({ lengthBars: 64, sections: [section('s1', 0, 2), section('big', 2, 62)] });
    const result = duplicateSection(project, 'big', clock);
    expect(result.ok).toBe(false);
    expect(result.project).toBe(project);
    if (!result.ok) {
      expect(result.code).toBe('songTooLong');
      expect(result.reason).toMatch(/64 小節/);
    }
  });

  it('duplicates a section that is the whole song, and a 1-bar section at the song end', () => {
    const one = threeSections({ sections: [section('all', 0, 6)] });
    const doubled = ok(duplicateSection(one, 'all', clock));
    expect(doubled.lengthBars).toBe(12);
    expect(events(doubled)).toHaveLength(2 * events(one).length);

    const last = threeSections({ sections: [section('s1', 0, 5), section('end', 5, 1)] });
    const after = ok(duplicateSection(last, 'end', clock));
    expect(after.lengthBars).toBe(7);
    expectMoved(last, after, 0, tick(24), 0);
    expectMoved(last, after, tick(20), tick(24), tick(4));
  });
});

describe('moveSection', () => {
  it('keeps the total number of notes and chords', () => {
    const project = threeSections();
    const after = ok(moveSection(project, 's2', -1, clock));
    expect(noteCount(after)).toBe(noteCount(project));
    expect(after.chordTrack).toHaveLength(project.chordTrack.length);
    expect(events(after)).toHaveLength(events(project).length);
    expect(after.lengthBars).toBe(project.lengthBars);
    expect(clipById(after, 'b')?.startBeat).toBe(0);
    expect(clipById(after, 'a')?.startBeat).toBe(8);
    expect(clipById(after, 'c')?.startBeat).toBe(16);
    expectMoved(project, after, 0, tick(8), tick(8));
    expectMoved(project, after, tick(8), tick(16), -tick(8));
    expectMoved(project, after, tick(16), Infinity, 0);
    const later = ok(moveSection(after, 's2', 1, clock));
    expect(later.tracks).toEqual(project.tracks);
  });

  it('swaps sections of different lengths around a gap in 3/4 and leaves the gap between them', () => {
    // 3/4: 3 beats per bar. A = bars 0-1 (beats 0-3), gap bars 1-2, B = bars 2-4 (beats 6-12).
    const project = makeProject(
      [makeTrack('inst', 'instrument', [
        midiClip('a', 'inst', 0, 3, [[0, 1, 60]]),
        midiClip('g', 'inst', 3, 3, [[0, 1, 62]]),
        midiClip('b', 'inst', 6, 6, [[0, 1, 64], [5, 1, 65]]),
      ])],
      { timeSignature: [3, 4], lengthBars: 4, sections: [section('A', 0, 1), section('B', 2, 2)], chordTrack: [chord('x', 6, 6)] },
    );
    const after = ok(moveSection(project, 'A', 1, clock));
    expect(clipById(after, 'b')?.startBeat).toBe(0);
    expect(clipById(after, 'g')?.startBeat).toBe(6);
    expect(clipById(after, 'a')?.startBeat).toBe(9);
    expect(after.sections.find((s) => s.id === 'B')).toMatchObject({ startBar: 0, lengthBars: 2 });
    expect(after.sections.find((s) => s.id === 'A')).toMatchObject({ startBar: 3, lengthBars: 1 });
    expect(after.chordTrack).toEqual([{ ...chord('x', 0, 6) }]);
    expectMoved(project, after, 0, tick(3), tick(9));
    expectMoved(project, after, tick(3), tick(6), tick(3));
    expectMoved(project, after, tick(6), tick(12), -tick(6));
  });

  it('refuses without a neighbour, and for a song with a single section', () => {
    const project = threeSections();
    for (const [id, dir] of [['s1', -1], ['s3', 1]] as const) {
      const result = moveSection(project, id, dir, clock);
      expect(result.ok).toBe(false);
      expect(result.project).toBe(project);
      if (!result.ok) expect(result.code).toBe('noNeighbor');
    }
    const single = threeSections({ sections: [section('only', 0, 6)] });
    expect(moveSection(single, 'only', 1, clock).ok).toBe(false);
  });

  it('moves muted tracks with their section', () => {
    const project = threeSections();
    const muted = { ...project, tracks: project.tracks.map((t) => ({ ...t, mute: t.id === 'drums' })) };
    const after = ok(moveSection(muted, 's2', 1, clock));
    expect(after.tracks.find((t) => t.id === 'drums')!.clips[0]!.startBeat).toBe(16);
    expect(after.tracks.find((t) => t.id === 'drums')!.mute).toBe(true);
    expectMoved(muted, after, tick(8), tick(16), tick(8));
  });
});

describe('deleteSection', () => {
  it('removes the content in the range and closes the gap', () => {
    const project = threeSections();
    const after = ok(deleteSection(project, 's2', clock));
    expect(after.lengthBars).toBe(4);
    expect(clipById(after, 'b')).toBeUndefined();
    expect(clipById(after, 'd')).toBeUndefined();
    expect(clipById(after, 'c')?.startBeat).toBe(8);
    expect(after.chordTrack.map((c) => [c.id, c.startBeat])).toEqual([['ch1', 0], ['ch3', 8]]);
    expect(after.sections.map((s) => [s.id, s.startBar])).toEqual([['s1', 0], ['s3', 2]]);
    expectMoved(project, after, 0, tick(8), 0);
    expectMoved(project, after, tick(16), Infinity, -tick(8));
  });

  it('deleting the only section keeps one empty bar; deleting the first section in 3/4 shifts the rest', () => {
    const single = threeSections({ sections: [section('only', 0, 6)] });
    const empty = ok(deleteSection(single, 'only', clock));
    expect(empty.lengthBars).toBe(1);
    expect(events(empty)).toEqual([]);
    expect(empty.sections).toEqual([]);

    const waltz = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('a', 'inst', 0, 3, [[0, 1, 60]]), midiClip('b', 'inst', 3, 6, [[1, 1, 64]])])],
      { timeSignature: [3, 4], lengthBars: 3, sections: [section('first', 0, 1), section('rest', 1, 2)] },
    );
    const after = ok(deleteSection(waltz, 'first', clock));
    expect(after.lengthBars).toBe(2);
    expect(clipById(after, 'b')?.startBeat).toBe(0);
    expectMoved(waltz, after, tick(3), Infinity, -tick(3));
  });

  it('a link to a deleted clip keeps sounding the same', () => {
    const project = threeSections();
    const linked = {
      ...project,
      tracks: project.tracks.map((t) =>
        t.id === 'inst'
          ? { ...t, clips: t.clips.map((c) => (c.id === 'c' ? { ...c, aliasOf: 'b', notes: undefined } as Clip : c)) }
          : t,
      ),
    };
    delete (linked.tracks[0]!.clips[2] as Partial<Clip>).notes;
    expect(validateProject(linked).errors).toEqual([]);
    const after = ok(deleteSection(linked, 's2', clock));
    expectMoved(linked, after, tick(16), Infinity, -tick(8));
  });
});

describe('content that crosses a section edge', () => {
  it('clips and chords that cross the range are split at its edges', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('x', 'inst', 4, 16, [[0, 1, 60], [3, 2, 62], [10, 4, 64]])])],
      {
        lengthBars: 6,
        sections: [section('s1', 0, 2), section('s2', 2, 2), section('s3', 4, 2)],
        chordTrack: [chord('c1', 6, 4), chord('c2', 14, 4)],
      },
    );
    for (const op of ['duplicate', 'move', 'delete'] as const) {
      const result =
        op === 'duplicate' ? duplicateSection(project, 's2', clock)
          : op === 'move' ? moveSection(project, 's2', 1, clock)
            : deleteSection(project, 's2', clock);
      const after = ok(result);
      const bpb = 4;
      const edges = after.sections.flatMap((s) => [s.startBar * bpb, (s.startBar + s.lengthBars) * bpb]);
      for (const c of clipsOf(after)) {
        for (const e of edges) expect(c.startBeat < e && c.startBeat + c.lengthBeats > e).toBe(false);
      }
      for (const c of after.chordTrack) {
        for (const e of edges) expect(c.startBeat < e && c.startBeat + c.durationBeats > e).toBe(false);
      }
      if (op === 'duplicate') {
        // Before 8, the chord 6-10 keeps its first part; 8-10 is copied to 16-18.
        expect(after.chordTrack.map((c) => [c.startBeat, c.durationBeats]).sort((x, y) => x[0]! - y[0]!)).toEqual([
          [6, 2], [8, 2], [14, 2], [16, 2], [22, 2], [24, 2],
        ]);
        expectMoved(project, after, 0, tick(8), 0);
        expectMoved(project, after, tick(8), tick(16), 0);
        expectMoved(project, after, tick(8), tick(16), tick(8));
        expectMoved(project, after, tick(16), Infinity, tick(8));
      }
    }
  });

  it('refuses when a looping or linked clip crosses a section edge, with a beginner-friendly reason', () => {
    const base = threeSections();
    const loop: Project = {
      ...base,
      tracks: base.tracks.map((t) =>
        t.id === 'inst' ? { ...t, clips: [midiClip('l', 'inst', 4, 8, [[0, 1, 60]], { loop: true, contentLengthBeats: 2 })] } : t,
      ),
    };
    const link: Project = {
      ...base,
      tracks: base.tracks.map((t) => {
        if (t.id !== 'inst') return t;
        const linkClip: Clip = { id: 'k', trackId: 'inst', type: 'midi', startBeat: 12, lengthBeats: 8, loop: false, aliasOf: 'a' };
        return { ...t, clips: [t.clips[0]!, linkClip] };
      }),
    };
    for (const [project, code] of [[loop, 'loopingClip'], [link, 'linkedClip']] as const) {
      expect(validateProject(project).errors).toEqual([]);
      for (const result of [
        duplicateSection(project, 's2', clock),
        moveSection(project, 's2', 1, clock),
        deleteSection(project, 's2', clock),
      ]) {
        expect(result.ok).toBe(false);
        expect(result.project).toBe(project);
        if (!result.ok) {
          expect(result.code).toBe(code);
          expect(result.reason).toMatch(/セクションの境目/);
        }
      }
    }
  });

  it('refuses when a drum clip cannot be cut exactly on the section edge', () => {
    const base = threeSections();
    // Starts off the step grid, so the nearest step edge misses beat 8.
    const project: Project = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === 'drums' ? { ...t, clips: [drumClip('d', 'drums', 6.1, 4, [[0, 'kick']])] } : t)),
    };
    const result = duplicateSection(project, 's2', clock);
    expect(result.ok).toBe(false);
    expect(result.project).toBe(project);
    if (!result.ok) expect(result.code).toBe('cannotSplitClip');
  });

  it('leaves the project alone when a track it touches holds a clip outside the clip-operation domain', () => {
    const base = threeSections();
    const project: Project = {
      ...base,
      tracks: [...base.tracks, makeTrack('x', 'instrument', [midiClip('tiny', 'x', 30, 1 / 128, [])])],
    };
    // Duplicate and delete move every later clip, so they involve track x.
    for (const result of [duplicateSection(project, 's2', clock), deleteSection(project, 's2', clock)]) {
      expect(result.ok).toBe(false);
      expect(result.project).toBe(project);
      if (!result.ok) expect(result.code).toBe('outsideClipDomain');
    }
    // Swapping s2 and s3 (beats 8-24) leaves the clip at beat 30 where it is.
    expect(ok(moveSection(project, 's2', 1, clock)).tracks.find((t) => t.id === 'x')).toEqual(project.tracks[2]);
  });

  it('refuses a missing section', () => {
    const project = threeSections();
    const result = deleteSection(project, 'nope', clock);
    expect(result.ok).toBe(false);
    expect(result.project).toBe(project);
  });
});

// --- Regressions from the US-013 review (4/4 songs that pass validateProject). ---

describe('review regressions', () => {
  const bars = (n: number) => Array.from({ length: n }, (_, i) => section(`b${i + 1}`, i, 1));

  it('1: deleting an audio clip keeps its asset on the clip that linked to it', () => {
    const audio: Clip = { id: 'au', trackId: 'aud', type: 'audio', startBeat: 0, lengthBeats: 4, loop: false, audioAssetId: 'asset-1' };
    const link: Clip = { id: 'al', trackId: 'aud', type: 'audio', startBeat: 4, lengthBeats: 4, loop: false, aliasOf: 'au' };
    const track = { ...makeTrack('aud', 'instrument', [audio, link]), type: 'audio' as const };
    delete (track as { instrument?: unknown }).instrument;
    const project = makeProject([track], { lengthBars: 4, sections: bars(4) });
    expect(validateProject(project).errors).toEqual([]);
    expect(clipById(removeClip(project, 'au', clock), 'al')).toMatchObject({ audioAssetId: 'asset-1' });
    const after = ok(deleteSection(project, 'b1', clock));
    const kept = clipById(after, 'al');
    expect(kept).toMatchObject({ startBeat: 0, audioAssetId: 'asset-1' });
    expect(kept?.aliasOf).toBeUndefined();
  });

  it('2: swapping bars around a link source keeps the number of stored notes', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [
        midiClip('src', 'inst', 0, 8, [[5, 1, 60]]),
        { id: 'lnk', trackId: 'inst', type: 'midi', startBeat: 8, lengthBeats: 8, loop: false, aliasOf: 'src' },
      ])],
      { lengthBars: 4, sections: bars(4) },
    );
    expect(validateProject(project).errors).toEqual([]);
    const result = moveSection(project, 'b1', 1, clock);
    expect(noteCount(result.project)).toBe(noteCount(project));
    if (result.ok) ok(result);
    else expect(result.code).toBe('linkedClip');
  });

  it('3: a loop range 4-4.0001 moves both ends by the same tick rule', () => {
    const project = makeProject([], { lengthBars: 4, sections: bars(4), loopRange: { startBeat: 4, endBeat: 4.0001 } });
    expect(validateProject(project).errors).toEqual([]);
    const after = ok(duplicateSection(project, 'b1', clock));
    expect(after.loopRange).toEqual({ startBeat: 8, endBeat: 8.0001 });
  });

  it('4: a chord or clip starting half a tick before the deleted bar end never moves before 0', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('x', 'inst', 3.9999, 1, [[0, 0.5, 60]])])],
      { lengthBars: 4, sections: bars(4), chordTrack: [chord('c', 3.9999, 1)] },
    );
    expect(validateProject(project).errors).toEqual([]);
    const after = ok(deleteSection(project, 'b1', clock));
    expect(after.chordTrack[0]!.startBeat).toBeGreaterThanOrEqual(0);
    expect(clipById(after, 'x')!.startBeat).toBeGreaterThanOrEqual(0);
    expect(tick(after.chordTrack[0]!.startBeat)).toBe(0);
    expect(tick(after.chordTrack[0]!.startBeat + after.chordTrack[0]!.durationBeats)).toBe(tick(3.9999 + 1) - tick(4));
    expectMoved(project, after, tick(4), Infinity, -tick(4));
  });

  it('6: a clip half a tick before the deleted bar end keeps its notes on their ticks', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('x', 'inst', 3.9992, 2, [[0.5015, 0.25, 60], [0, 0.5, 62]])])],
      { lengthBars: 4, sections: bars(4) },
    );
    expect(validateProject(project).errors).toEqual([]);
    expect(events(project).map((e) => tick(e.startBeat)).sort((a, b) => a - b)).toEqual([1920, 2160]);
    const after = ok(deleteSection(project, 'b1', clock));
    expect(events(after).map((e) => tick(e.startBeat)).sort((a, b) => a - b)).toEqual([0, 240]);
    expectMoved(project, after, tick(4), Infinity, -tick(4));
  });

  it('6b: a link that would start before 0 is refused instead of shifting its shared notes', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [
        midiClip('src', 'inst', 8, 4, [[0.5015, 0.25, 60]]),
        { id: 'lnk', trackId: 'inst', type: 'midi', startBeat: 3.9992, lengthBeats: 2, loop: false, aliasOf: 'src' },
      ])],
      { lengthBars: 4, sections: bars(4) },
    );
    expect(validateProject(project).errors).toEqual([]);
    const result = deleteSection(project, 'b1', clock);
    expect(result.ok).toBe(false);
    expect(result.project).toBe(project);
    if (!result.ok) expect(result.code).toBe('clipBeforeSongStart');
  });

  it('6c: a looping clip that would start before 0 is refused, since stopping it at 0 shifts its loop', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('lp', 'inst', 3.9992, 2, [[0, 0.25, 60]], { loop: true, contentLengthBeats: 0.5015 })])],
      { lengthBars: 4, sections: bars(4) },
    );
    expect(validateProject(project).errors).toEqual([]);
    const result = deleteSection(project, 'b1', clock);
    expect(result.ok).toBe(false);
    expect(result.project).toBe(project);
    if (!result.ok) expect(result.code).toBe('clipBeforeSongStart');
  });

  it('6d: refuses a one-tick onset shift caused by rounding a note between ticks', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('x', 'inst', 4, 2, [[5 / 960, 0.25, 60]])])],
      { lengthBars: 4, sections: bars(4) },
    );
    expect(validateProject(project).errors).toEqual([]);
    expect(events(project).map((e) => tick(e.startBeat))).toEqual([1922]);
    const result = deleteSection(project, 'b1', clock);
    expect(result).toMatchObject({ ok: false, code: 'soundChanged' });
    expect(result.project).toBe(project);
  });

  it('refuses a one-tick shift at the note end even when the onset moves exactly', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('x', 'inst', 4, 2, [[0, 5 / 960, 60]])])],
      { lengthBars: 4, sections: bars(4) },
    );
    expect(validateProject(project).errors).toEqual([]);
    const result = deleteSection(project, 'b1', clock);
    expect(result).toMatchObject({ ok: false, code: 'soundChanged' });
    expect(result.project).toBe(project);
  });

  it('8: an edit that would silence a note between ticks is refused', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('x', 'inst', 4, 0.128125, [[61 / 480, 1 / 480, 60]])])],
      { lengthBars: 2, sections: bars(2) },
    );
    expect(validateProject(project).errors).toEqual([]);
    expect(events(project).map((e) => tick(e.startBeat))).toEqual([1981]);
    const result = deleteSection(project, 'b1', clock);
    expect(result.ok).toBe(false);
    expect(result.project).toBe(project);
    if (!result.ok) {
      expect(result.code).toBe('soundChanged');
      expect(result.reason).toMatch(/細かい位置の音/);
    }
  });

  it('9: a note lost by the edge split itself is caught', () => {
    const project = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('x', 'inst', 4 / 480, 4.046875, [[1942 / 480, 1 / 480, 60]])])],
      { lengthBars: 3, sections: bars(3) },
    );
    expect(validateProject(project).errors).toEqual([]);
    expect(events(project).map((e) => tick(e.startBeat))).toEqual([1946]);
    const result = deleteSection(project, 'b1', clock);
    if (result.ok) {
      expect(events(result.project).map((e) => tick(e.startBeat))).toEqual([26]);
    } else {
      expect(result.project).toBe(project);
      expect(result.code).toBe('soundChanged');
    }
  });

  it('refuses a split that loses the last note in a run under a sustained note of the same pitch', () => {
    const notes: Array<[number, number, number]> = [
      [0, 5, 60],
      ...Array.from({ length: 26 }, (_, i): [number, number, number] => [(1917 + i) / PPQ, 1 / PPQ, 60]),
    ];
    const project = makeProject(
      [makeTrack('inst', 'instrument', [midiClip('x', 'inst', 4 / PPQ, 4.046875, notes)])],
      { lengthBars: 3, sections: bars(3) },
    );
    expect(validateProject(project).errors).toEqual([]);
    expect(events(project).map((e) => tick(e.startBeat))).toContain(1946);
    const result = deleteSection(project, 'b1', clock);
    expect(result).toMatchObject({ ok: false, code: 'soundChanged' });
    expect(result.project).toBe(project);
  });

  it('7: a loop range that rounds to one tick moves by the bar and is kept', () => {
    const project = makeProject([], { lengthBars: 4, sections: bars(4), loopRange: { startBeat: 8, endBeat: 8.0001 } });
    expect(validateProject(project).errors).toEqual([]);
    const after = ok(deleteSection(project, 'b1', clock));
    expect(after.loopRange?.startBeat).toBe(4);
    expect(after.loopRange?.endBeat).toBeCloseTo(4.0001, 10);
  });

  it('5: an edit whose splits pass the sounding budget is refused', () => {
    const notes = Array.from({ length: 50_000 }, (_, i) => ({ id: `big-${i}`, pitch: 60, startBeat: 1, durationBeats: 10, velocity: 100 }));
    const project = makeProject(
      [makeTrack('inst', 'instrument', [{ ...midiClip('big', 'inst', 0, 12, []), notes }])],
      { lengthBars: 3, sections: bars(3) },
    );
    expect(validateProject(project).errors).toEqual([]);
    for (const result of [moveSection(project, 'b1', 1, clock), deleteSection(project, 'b2', clock)]) {
      expect(result.ok).toBe(false);
      expect(result.project).toBe(project);
      if (!result.ok) {
        expect(result.code).toBe('invalidResult');
        expect(result.reason).toMatch(/曲の決まり/);
      }
    }
  });
});

// --- Property: random projects inside the validation domain. ---

const TYPES: Section['type'][] = ['intro', 'verse', 'preChorus', 'chorus', 'bridge', 'outro'];

/** `fractional` also puts content between ticks; otherwise every position is a whole tick. */
function randomSong(seed: number, fractional = false): Project {
  const base = generateProject(seed, { allowOverrunSongEnd: seed % 2 === 0 });
  const r = mulberry32(seed * 7919 + 13);
  const bpb = base.timeSignature[0] * (4 / base.timeSignature[1]);
  const sections: Section[] = [];
  for (let bar = 0, i = 0; bar < base.lengthBars; i++) {
    const length = Math.min(1 + Math.floor(r() * 3), base.lengthBars - bar);
    if (r() < 0.85 || sections.length === 0) sections.push(section(`s${i}`, bar, length, TYPES[i % TYPES.length]));
    bar += length;
  }
  const chordTrack: ChordEvent[] = [];
  for (let beat = Math.floor(r() * 4) / 2, i = 0; beat < base.lengthBars * bpb; i++) {
    const length = (1 + Math.floor(r() * 12)) / 2;
    if (r() < 0.8) chordTrack.push(chord(`ch${i}`, beat, length));
    beat += length;
  }
  // Content within one tick of a section edge, also between ticks: chords, notes, clips and the loop range.
  const edges = sections.flatMap((s) => [s.startBar * bpb, (s.startBar + s.lengthBars) * bpb]);
  const OFFSETS = fractional ? [-1, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 1] : [-1, 0, 1];
  const offset = () => OFFSETS[Math.floor(r() * OFFSETS.length)]! / PPQ;
  const nearEdge = () => Math.max(0, edges[Math.floor(r() * edges.length)]! + offset());
  for (let i = 0; i < 2; i++) chordTrack.push(chord(`edge-ch${i}`, nearEdge(), 0.5 + Math.floor(r() * 4)));
  const tracks = base.tracks.map((t) => ({ ...t, mute: r() < 0.25 }));
  for (const clip of tracks.flatMap((t) => t.clips)) {
    if (!clip.notes || r() < 0.5) continue;
    const local = nearEdge() - clip.startBeat;
    if (local >= 0 && local < clip.lengthBeats) {
      clip.notes = [...clip.notes, { id: `${clip.id}-edge`, pitch: 72, startBeat: local, durationBeats: 0.5, velocity: 90 }];
    }
  }
  // An audio track: clips holding an asset, and sometimes a link to the first one.
  if (r() < 0.5) {
    const clips: Clip[] = [];
    for (let beat = Math.floor(r() * 8) / 2, i = 0; beat < base.lengthBars * bpb && i < 3; i++) {
      const length = (1 + Math.floor(r() * 16)) / 2;
      clips.push({ id: `au${i}`, trackId: 'aud', type: 'audio', startBeat: beat, lengthBeats: length, loop: false, audioAssetId: `asset-${i}` });
      beat += length + Math.floor(r() * 4) / 2;
    }
    if (clips.length > 1 && r() < 0.6) {
      const last = clips.pop()!;
      clips.push({ ...last, audioAssetId: undefined, aliasOf: 'au0' });
      delete clips[clips.length - 1]!.audioAssetId;
    }
    const audio = { ...makeTrack('aud', 'instrument', clips), type: 'audio' as const };
    delete (audio as { instrument?: unknown }).instrument;
    tracks.push(audio);
  }
  const song: Project = { ...base, sections, chordTrack, tracks };
  // Nudge some clip starts and notes by up to a tick (fractions of one when `fractional`).
  const nudged: Project = {
    ...song,
    tracks: song.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (r() < 0.4) return c;
        // Half of them move onto an edge (if it is free on the track), off by a fraction of a tick.
        const edge = edges[Math.floor(r() * edges.length)]! + offset();
        const free = edge >= 0 && t.clips.every((o) => o === c || tick(o.startBeat + o.lengthBeats) <= tick(edge) || tick(o.startBeat) >= tick(edge + c.lengthBeats));
        const startBeat = r() < 0.5 && free ? edge : Math.max(0, c.startBeat + offset());
        const notes = c.notes?.map((n) => (r() < 0.5 ? n : { ...n, startBeat: Math.max(0, n.startBeat + offset()) }));
        return { ...c, startBeat, ...(notes ? { notes } : {}) };
      }),
    })),
  };
  if (validateProject(nudged).errors.length === 0) Object.assign(song, nudged);
  if (r() < 0.5) {
    const a = nearEdge();
    const b = nearEdge();
    if (tick(a) !== tick(b)) song.loopRange = { startBeat: Math.min(a, b), endBeat: Math.max(a, b) };
  }
  return song;
}

/**
 * A random song's sections, chords and loop range over one clip spanning the
 * whole song with close to the input budget of notes (no loops or links, so the
 * edits get past the edge checks).
 */
function denseSong(seed: number): Project {
  const song = randomSong(seed);
  const r = mulberry32(seed + 1);
  const bpb = song.timeSignature[0] * (4 / song.timeSignature[1]);
  const notes = Array.from({ length: 49_000 }, (_, i) => ({
    id: `dense-${i}`,
    pitch: 40 + (i % 40),
    startBeat: Math.floor(r() * song.lengthBars * bpb * 8) / 8,
    durationBeats: 0.125 + Math.floor(r() * 8) / 8,
    velocity: 80,
  }));
  return { ...song, tracks: [makeTrack('dense', 'instrument', [{ ...midiClip('dense-clip', 'dense', 0, song.lengthBars * bpb, []), notes }])] };
}

const WHOLE_TICK_CASES: Array<[number, Project]> = [
  ...SEEDS.slice(0, 200).map((seed) => [seed, randomSong(seed)] as [number, Project]),
  ...SEEDS.slice(200, 203).map((seed) => [seed, denseSong(seed)] as [number, Project]),
];
const FRACTIONAL_CASES: Array<[number, Project]> = SEEDS.slice(0, 200).map((seed) => [seed, randomSong(seed, true)]);

type Regions = Array<[number, number, number]>;

/** Project the original sounds into the edited regions, retaining each individual note fragment. */
function expectExactSounds(before: Project, after: Project, regions: Regions): void {
  const key = (e: Ev, start: number, end: number) =>
    JSON.stringify([e.trackId, e.kind, e.kind === 'note' ? e.pitch : e.lane, e.velocity, start, end]);
  const expected = events(before).flatMap((e) => {
    const onset = tick(e.startBeat);
    return regions.flatMap(([from, to, shift]) => {
      if (e.kind === 'drum') {
        return from <= onset && onset < to ? [key(e, onset + shift, onset + shift)] : [];
      }
      const start = Math.max(onset, from);
      const end = Math.min(tick(e.startBeat + e.durationBeats), to);
      return start < end ? [key(e, start + shift, end + shift)] : [];
    });
  });
  const actual = events(after).map((e) => {
    const start = tick(e.startBeat);
    return key(e, start, e.kind === 'note' ? tick(e.startBeat + e.durationBeats) : start);
  });
  expect(actual.sort()).toEqual(expected.sort());
}

function runProperty(cases: Array<[number, Project]>, expectMovedBy: (before: Project, after: Project, regions: Regions) => void) {
  {
    const applied = { duplicate: 0, move: 0, delete: 0 };
    let refused = 0;
    for (const [seed, project] of cases) {
      expect(validateProject(project).errors).toEqual([]);
      const bpb = project.timeSignature[0] * (4 / project.timeSignature[1]);
      const ordered = [...project.sections].sort((x, y) => x.startBar - y.startBar);
      const r = mulberry32(seed);
      const index = Math.floor(r() * ordered.length);
      const target = ordered[index]!;
      const start = tick(target.startBar * bpb);
      const end = tick((target.startBar + target.lengthBars) * bpb);
      const length = end - start;

      const check = (result: SectionEditResult, op: keyof typeof applied, regions: Regions) => {
        if (!result.ok) {
          expect(result.project).toBe(project);
          expect(result.reason).toContain(SECTION_EDIT_FAILURE_MESSAGES[result.code]);
          expect(result.reason.length).toBeGreaterThan(0);
          refused += 1;
          return;
        }
        const after = ok(result);
        expectMovedBy(project, after, regions);
        // Every audio clip keeps an asset or a link to one.
        for (const c of clipsOf(after)) if (c.type === 'audio') expect(c.audioAssetId ?? c.aliasOf).toBeDefined();
        applied[op] += 1;
      };

      check(duplicateSection(project, target.id, clock), 'duplicate', [
        [0, start, 0],
        [start, end, 0],
        [start, end, length],
        [end, Infinity, length],
      ]);

      const deleted = deleteSection(project, target.id, clock);
      const keptBars = Math.max(1, project.lengthBars - target.lengthBars);
      const shift = tick((keptBars - project.lengthBars) * bpb);
      check(deleted, 'delete', [
        [0, start, 0],
        [end, Infinity, shift],
      ]);
      if (deleted.ok) expect(eventsIn(deleted.project, start, end + shift)).toEqual([]);

      const direction = r() < 0.5 ? -1 : 1;
      const neighbor = ordered[index + direction];
      const result = moveSection(project, target.id, direction, clock);
      if (!neighbor) {
        expect(result.ok).toBe(false);
        continue;
      }
      const [first, second] = direction < 0 ? [neighbor, target] : [target, neighbor];
      const a0 = tick(first.startBar * bpb);
      const a1 = tick((first.startBar + first.lengthBars) * bpb);
      const b0 = tick(second.startBar * bpb);
      const b1 = tick((second.startBar + second.lengthBars) * bpb);
      check(result, 'move', [
        [0, a0, 0],
        [a0, a1, b1 - a1],
        [a1, b0, b1 - b0 - (a1 - a0)],
        [b0, b1, a0 - b0],
        [b1, Infinity, 0],
      ]);
    }
    expect(applied.duplicate).toBeGreaterThan(60);
    expect(applied.delete).toBeGreaterThan(60);
    expect(applied.move).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(0);
  }
}

describe('section operations on random projects', () => {
  it('with whole-tick positions: results pass validateProject, never overlap, and outside the range every onset moves exactly by the shift', { timeout: 120_000 }, () => {
    runProperty(WHOLE_TICK_CASES, (before, after, regions) => {
      for (const [from, to, shift] of regions) expectMoved(before, after, from, to, shift);
    });
  });

  it('with positions between ticks: preserves exact sounding intervals or returns the original project with a reason', { timeout: 120_000 }, () => {
    runProperty(FRACTIONAL_CASES, expectExactSounds);
  });
});
