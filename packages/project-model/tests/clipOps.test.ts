import { describe, it, expect } from 'vitest';
import {
  addClip,
  createEmptyProject,
  duplicateClip,
  expandClip,
  moveClip,
  removeClip,
  resizeClip,
  resolveEditTarget,
  splitClip,
  validateProject,
} from '../src/index';
import type { Clip, NoteEvent, Project, Track } from '../src/index';

const t0 = () => new Date('2026-06-11T00:00:00.000Z');
const t1 = () => new Date('2026-06-11T01:00:00.000Z');

function note(id: string, startBeat: number, durationBeats: number, pitch = 60): NoteEvent {
  return { id, pitch, startBeat, durationBeats, velocity: 100 };
}

function melody(project: Project): Track {
  const track = project.tracks.find((t) => t.name === 'Melody');
  if (!track) throw new Error('no Melody track');
  return track;
}

function drums(project: Project): Track {
  const track = project.tracks.find((t) => t.type === 'drum');
  if (!track) throw new Error('no drum track');
  return track;
}

function clipById(project: Project, id: string): Clip {
  const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
  if (!clip) throw new Error(`no clip ${id}`);
  return clip;
}

/** A project whose Melody track holds exactly the given clips. */
function withMelodyClips(clips: Omit<Clip, 'trackId'>[]): Project {
  const project = createEmptyProject({ clock: t0 });
  const trackId = melody(project).id;
  return {
    ...project,
    tracks: project.tracks.map((t) =>
      t.id === trackId ? { ...t, clips: clips.map((c) => ({ ...c, trackId })) } : t,
    ),
  };
}

function midi(id: string, startBeat: number, lengthBeats: number, notes: NoteEvent[] = []): Omit<Clip, 'trackId'> {
  return { id, type: 'midi', startBeat, lengthBeats, loop: false, notes };
}

const totalLength = (notes: readonly NoteEvent[]) => notes.reduce((sum, n) => sum + n.durationBeats, 0);

/** [absolute start, duration, pitch] of every note the Melody track sounds, in time order. */
function soundedNotes(project: Project): [number, number, number][] {
  const clips = melody(project).clips;
  return clips
    .flatMap((c) => expandClip(c, clips).notes)
    .map((n): [number, number, number] => [n.startBeat, n.durationBeats, n.pitch])
    .sort((x, y) => x[0] - y[0] || x[2] - y[2]);
}

/** Total sounded note length on the Melody track. */
function totalSounded(project: Project): number {
  return soundedNotes(project).reduce((sum, n) => sum + n[1], 0);
}

/** A sounded note crossing `beat` becomes the two pieces a split there makes. */
function splitAt(beat: number) {
  return ([start, duration, pitch]: [number, number, number]): [number, number, number][] =>
    start < beat && start + duration > beat
      ? [[start, beat - start, pitch], [beat, start + duration - beat, pitch]]
      : [[start, duration, pitch]];
}

/** Absolute beats of every drum hit a track sounds, in time order. */
function soundedHits(project: Project, trackId: string): number[] {
  const all = project.tracks.flatMap((t) => t.clips);
  const track = project.tracks.find((t) => t.id === trackId)!;
  return track.clips
    .flatMap((c) => expandClip(c, all, 4, track.type).drumHits)
    .map((h) => h.beat)
    .sort((x, y) => x - y);
}

describe('addClip', () => {
  it('allocates unique IDs for incoming notes and hits across the project and the new clip', () => {
    const project = withMelodyClips([midi('a', 0, 4, [note('note-60-2', 2, 1)])]);
    const copiedNote = note('note-60-2', 0, 1);
    const hit = { id: 'free-note', lane: 'kick' as const, stepIndex: 0, velocity: 100 };
    const incoming = {
      ...midi('new', 4, 4, [copiedNote, note('free-note', 1, 1)]),
      drumEvents: [hit],
    };
    const next = addClip(project, melody(project).id, incoming);
    expect(validateProject(next).errors).toEqual([]);
    const added = clipById(next, 'new');
    expect(added.notes?.[0]).toEqual({ ...copiedNote, id: expect.any(String) });
    expect(added.notes?.[0]?.id).not.toBe('note-60-2');
    expect(added.notes?.[1]?.id).toBe('free-note');
    expect(added.drumEvents?.[0]).toEqual({ ...hit, id: expect.any(String) });
    expect(added.drumEvents?.[0]?.id).not.toBe('free-note');
  });

  it('allocates a unique id when the requested clip id already exists', () => {
    const project = withMelodyClips([midi('a', 0, 4)]);
    const next = addClip(project, melody(project).id, midi('a', 4, 4));
    expect(melody(next).clips.map((c) => c.id)).toEqual(['a', expect.not.stringMatching(/^a$/)]);
    expect(validateProject(next).ok).toBe(true);
  });

  it('appends a clip to the track and stamps updatedAt', () => {
    const project = withMelodyClips([]);
    const next = addClip(project, melody(project).id, { type: 'midi', startBeat: 8, lengthBeats: 4, loop: false, id: 'new' }, t1);
    expect(melody(next).clips).toEqual([
      { id: 'new', trackId: melody(project).id, type: 'midi', startBeat: 8, lengthBeats: 4, loop: false },
    ]);
    expect(next.updatedAt).toBe('2026-06-11T01:00:00.000Z');
    expect(melody(project).clips).toEqual([]);
  });
});

describe('splitClip', () => {
  it('refuses a looping drum clip with off-grid repeats', () => {
    const project = createEmptyProject({ clock: t0 });
    const track = drums(project);
    const clip: Clip = {
      id: 'loop', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 4,
      loop: true, contentLengthBeats: 0.3, stepsPerBar: 16,
      drumEvents: [{ id: 'k0', lane: 'kick', stepIndex: 0, velocity: 100 }],
    };
    const base = { ...project, tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clips: [clip] } : t)) };
    expect(validateProject(base).ok).toBe(true);
    expect(soundedHits(base, track.id)[4]).toBeCloseTo(1.2);
    const result = splitClip(base, clip.id, 1);
    expect(result).toMatchObject({ ok: false, reason: 'loopingClip' });
    expect(result.project).toBe(base);
  });

  it('refuses splitting a drum loop after its last hit', () => {
    const project = createEmptyProject({ clock: t0 });
    const track = drums(project);
    const clip: Clip = {
      id: 'loop', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 1.2,
      loop: true, contentLengthBeats: 0.9, stepsPerBar: 16,
      drumEvents: [{ id: 'k0', lane: 'kick', stepIndex: 0, velocity: 100 }],
    };
    const base = { ...project, tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clips: [clip] } : t)) };
    expect(soundedHits(base, track.id)).toEqual([0, 0.9]);
    const result = splitClip(base, clip.id, 1);
    expect(result).toMatchObject({ ok: false, reason: 'loopingClip' });
    expect(result.project).toBe(base);
  });

  it('cuts a note that crosses the boundary into 3+1 and 0+1, keeping the total note length', () => {
    const project = withMelodyClips([midi('a', 0, 8, [note('n1', 3, 2), note('n2', 0, 1), note('n3', 5, 1)])]);
    const next = splitClip(project, 'a', 4, t1).project;
    const [left, right] = melody(next).clips;
    expect(left).toMatchObject({ id: 'a', startBeat: 0, lengthBeats: 4 });
    expect(right).toMatchObject({ startBeat: 4, lengthBeats: 4 });
    expect(left!.notes).toEqual([note('n1', 3, 1), note('n2', 0, 1)]);
    expect(right!.notes!.map((n) => [n.startBeat, n.durationBeats])).toEqual([[0, 1], [1, 1]]);
    expect(right!.notes!.find((n) => n.startBeat === 1)!.id).toBe('n3');
    const all = [...left!.notes!, ...right!.notes!];
    expect(totalLength(all)).toBe(totalLength(clipById(project, 'a').notes!));
    expect(new Set(all.map((n) => n.id)).size).toBe(all.length);
  });

  it('uses the absolute song beat for a clip that does not start at 0', () => {
    const project = withMelodyClips([midi('a', 16, 8, [note('n1', 3, 2)])]);
    const [left, right] = melody(splitClip(project, 'a', 20).project).clips;
    expect(left).toMatchObject({ startBeat: 16, lengthBeats: 4 });
    expect(right).toMatchObject({ startBeat: 20, lengthBeats: 4 });
    expect(right!.notes!.map((n) => [n.startBeat, n.durationBeats])).toEqual([[0, 1]]);
  });

  it('splits a drum clip on a step boundary', () => {
    const project = createEmptyProject({ clock: t0 });
    const track = drums(project);
    const drum: Clip = {
      id: 'd', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 4, loop: false, stepsPerBar: 16,
      drumEvents: [
        { id: 'k0', lane: 'kick', stepIndex: 0, velocity: 100 },
        { id: 'k8', lane: 'kick', stepIndex: 8, velocity: 100 },
        { id: 's9', lane: 'snare', stepIndex: 9, velocity: 90 },
      ],
    };
    const base = { ...project, tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clips: [drum] } : t)) };
    // 2.1 beats lies between step 8 (2.0) and step 9 (2.25): it snaps to step 8.
    const [left, right] = drums(splitClip(base, 'd', 2.1).project).clips;
    expect(left).toMatchObject({ startBeat: 0, lengthBeats: 2 });
    expect(left!.drumEvents!.map((e) => e.id)).toEqual(['k0']);
    expect(right).toMatchObject({ startBeat: 2, lengthBeats: 2, stepsPerBar: 16 });
    expect(right!.drumEvents!.map((e) => [e.id, e.stepIndex])).toEqual([['k8', 0], ['s9', 1]]);
  });

  it('leaves the project unchanged for a boundary at or outside the clip edges', () => {
    const project = withMelodyClips([midi('a', 0, 8, [note('n1', 0, 1)])]);
    expect(splitClip(project, 'a', 0).project).toBe(project);
    expect(splitClip(project, 'a', 8).project).toBe(project);
    expect(splitClip(project, 'a', -2).project).toBe(project);
  });

  it('checks the requested drum cut against the clip end before snapping to a step', () => {
    const project = createEmptyProject({ clock: t0 });
    const track = drums(project);
    const clip: Clip = {
      id: 'd', trackId: track.id, type: 'drum', startBeat: 2, lengthBeats: 4.1, loop: false, stepsPerBar: 16,
      drumEvents: [{ id: 'k0', lane: 'kick', stepIndex: 0, velocity: 100 }],
    };
    const base = { ...project, tracks: project.tracks.map((t) => t.id === track.id ? { ...t, clips: [clip] } : t) };
    expect(splitClip(base, clip.id, clip.startBeat + clip.lengthBeats).project).toBe(base);
    expect(splitClip(base, clip.id, 6.12).project).toBe(base);
  });

  it('a note a rounding error before the cut starts the right part at beat 0, never below it', () => {
    const project = withMelodyClips([midi('a', 0, 4, [note('n1', 2 - 5e-10, 1)])]);
    const [left, right] = melody(splitClip(project, 'a', 2).project).clips;
    expect(left!.notes).toEqual([]);
    expect(right!.notes).toHaveLength(1);
    expect(right!.notes![0]!.startBeat).toBeGreaterThanOrEqual(0);
    expect(right!.notes![0]!.startBeat).toBe(0);
  });

  it('a midi-type clip with drum hits on a drum track splits on the step grid playback uses', () => {
    const project = createEmptyProject({ clock: t0 });
    const track = drums(project);
    const clip: Clip = {
      id: 'm', trackId: track.id, type: 'midi', startBeat: 0, lengthBeats: 4, loop: false,
      drumEvents: [
        { id: 'k0', lane: 'kick', stepIndex: 0, velocity: 100 },
        { id: 'k8', lane: 'kick', stepIndex: 8, velocity: 100 },
      ],
    };
    const base = { ...project, tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clips: [clip] } : t)) };
    const next = splitClip(base, 'm', 2).project;
    expect(drums(next).clips).toHaveLength(2);
    expect(soundedHits(next, track.id)).toEqual(soundedHits(base, track.id));
    expect(soundedHits(next, track.id)).toEqual([0, 2]);
  });

  it('refuses a looping clip with an explicit period', () => {
    const project = withMelodyClips([
      { ...midi('loop', 8, 8, [note('n2', 0, 1), note('n3', 1.5, 1)]), loop: true, contentLengthBeats: 2 },
    ]);
    const result = splitClip(project, 'loop', 12);
    expect(result).toMatchObject({ ok: false, reason: 'loopingClip' });
    expect(result.project).toBe(project);
  });

  it('refuses a looping clip with an implicit period', () => {
    const project = withMelodyClips([{ ...midi('loop', 0, 4, [note('n1', 3, 2)]), loop: true }]);
    const result = splitClip(project, 'loop', 3.5);
    expect(result).toMatchObject({ ok: false, reason: 'loopingClip' });
    expect(result.project).toBe(project);
  });

  it('refuses to split a linked clip', () => {
    const project = withMelodyClips([
      midi('a', 0, 8, [note('n1', 0, 1), note('n2', 4, 2)]),
      { ...midi('link', 16, 8), aliasOf: 'a' },
    ]);
    const result = splitClip(project, 'link', 21);
    expect(result).toMatchObject({ ok: false, reason: 'linkedClip' });
    expect(result.project).toBe(project);
  });

  it('splits a link source without changing what its links play', () => {
    const project = withMelodyClips([
      midi('a', 0, 8, [note('n1', 0, 1), note('n2', 3, 2)]),
      { ...midi('link', 16, 8), aliasOf: 'a' },
    ]);
    const next = splitClip(project, 'a', 4).project;
    const linkSounds = (p: Project) => expandClip(clipById(p, 'link'), melody(p).clips).notes;
    expect(linkSounds(next)).toEqual(linkSounds(project));
    expect(clipById(next, 'a')).toMatchObject({ lengthBeats: 4 });
    expect(soundedNotes(next)).toEqual(soundedNotes(project).flatMap(splitAt(4)));
    expect(totalSounded(next)).toBe(totalSounded(project));
  });
});

describe('drum step grid of copies made from a link', () => {
  /** A drum source with no stepsPerBar (16) and a link at beat 4 whose own stepsPerBar is 8. */
  function drumLinkProject(): { project: Project; trackId: string } {
    const project = createEmptyProject({ clock: t0 });
    const track = drums(project);
    const src: Clip = {
      id: 'src', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 4, loop: false,
      drumEvents: [{ id: 'k4', lane: 'kick', stepIndex: 4, velocity: 100 }],
    };
    const link: Clip = { id: 'l', trackId: track.id, type: 'drum', startBeat: 4, lengthBeats: 4, loop: false, aliasOf: 'src', stepsPerBar: 8 };
    return {
      project: { ...project, tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clips: [src, link] } : t)) },
      trackId: track.id,
    };
  }

  it('the link sounds the kick at beat 5 (the source grid)', () => {
    const { project, trackId } = drumLinkProject();
    expect(soundedHits(project, trackId)).toEqual([1, 5]);
  });

  it('removing the source leaves the link sounding at beat 5', () => {
    const { project, trackId } = drumLinkProject();
    const next = removeClip(project, 'src');
    expect(clipById(next, 'l').stepsPerBar).toBeUndefined();
    expect(soundedHits(next, trackId)).toEqual([5]);
  });

  it('an independent copy of the link sounds the kick 1 beat after its start', () => {
    const { project, trackId } = drumLinkProject();
    const next = duplicateClip(project, 'l', { mode: 'copy' });
    const copy = drums(next).clips[2]!;
    expect(copy.aliasOf).toBeUndefined();
    expect(copy.stepsPerBar).toBeUndefined();
    expect(soundedHits(next, trackId)).toEqual([1, 5, copy.startBeat + 1]);
  });
});

describe('moveClip', () => {
  it('moves to the requested beat when nothing is there', () => {
    const project = withMelodyClips([midi('a', 0, 4), midi('b', 8, 4)]);
    const next = moveClip(project, 'b', 16, t1);
    expect(clipById(next, 'b').startBeat).toBe(16);
    expect(next.updatedAt).toBe('2026-06-11T01:00:00.000Z');
  });

  it('moves to the nearest position that does not overlap another clip on the track', () => {
    const project = withMelodyClips([midi('a', 0, 8), midi('b', 16, 4)]);
    // Requested 6 would overlap 'a' [0,8); there is no room before it, so the clip goes to 8.
    expect(clipById(moveClip(project, 'b', 6), 'b').startBeat).toBe(8);
    expect(clipById(moveClip(project, 'b', 1), 'b').startBeat).toBe(8);
  });

  it('picks the earlier free spot when it is closer', () => {
    const project = withMelodyClips([midi('a', 8, 8), midi('b', 24, 4)]);
    // 'b' is 4 long. Requested 9: the spot ending at 8 starts at 4 (distance 5), after 'a' is 16 (distance 7).
    expect(clipById(moveClip(project, 'b', 9), 'b').startBeat).toBe(4);
  });

  it('never moves before beat 0', () => {
    const project = withMelodyClips([midi('a', 0, 4)]);
    expect(clipById(moveClip(project, 'a', -3), 'a').startBeat).toBe(0);
  });
});

describe('resizeClip', () => {
  it('changes lengthBeats and keeps the loop period', () => {
    const project = withMelodyClips([
      { ...midi('a', 0, 8), loop: true, contentLengthBeats: 2 },
      { ...midi('b', 12, 4), loop: true },
    ]);
    const next = resizeClip(resizeClip(project, 'a', 12), 'b', 8);
    expect(clipById(next, 'a')).toMatchObject({ lengthBeats: 12, contentLengthBeats: 2 });
    // An unset period meant "the old length": it is written out so the repeat stays the same.
    expect(clipById(next, 'b')).toMatchObject({ lengthBeats: 8, contentLengthBeats: 4 });
  });

  it('ignores a length that is not positive', () => {
    const project = withMelodyClips([midi('a', 0, 8)]);
    expect(resizeClip(project, 'a', 0)).toBe(project);
  });
});

describe('duplicateClip', () => {
  it('copy places an independent copy right after the clip with fresh note ids', () => {
    const project = withMelodyClips([midi('a', 0, 4, [note('n1', 0, 1)])]);
    const next = duplicateClip(project, 'a', { mode: 'copy' }, t1);
    const copy = melody(next).clips[1]!;
    expect(copy).toMatchObject({ startBeat: 4, lengthBeats: 4 });
    expect(copy.id).not.toBe('a');
    expect(copy.aliasOf).toBeUndefined();
    expect(copy.notes).toHaveLength(1);
    expect(copy.notes![0]!.id).not.toBe('n1');
    expect(copy.notes![0]).toMatchObject({ startBeat: 0, durationBeats: 1, pitch: 60 });
  });

  it('link has aliasOf and no notes of its own, and plays the source content', () => {
    const project = withMelodyClips([midi('a', 0, 4, [note('n1', 1, 1)]), midi('b', 4, 4)]);
    const next = duplicateClip(project, 'a', { mode: 'link' });
    const link = melody(next).clips.find((c) => c.id !== 'a' && c.id !== 'b')!;
    expect(link.aliasOf).toBe('a');
    expect(link.notes).toBeUndefined();
    expect(link.drumEvents).toBeUndefined();
    expect(link.startBeat).toBe(8); // right after 'a' is taken by 'b'
    const sounded = expandClip(link, melody(next).clips);
    expect(sounded.notes.map((n) => n.startBeat)).toEqual([9]);
  });

  it('a link of a link points at the clip that owns the content', () => {
    const project = withMelodyClips([midi('a', 0, 4, [note('n1', 0, 1)]), { ...midi('l1', 4, 4), aliasOf: 'a' }]);
    const next = duplicateClip(project, 'l1', { mode: 'link' });
    expect(melody(next).clips[2]!.aliasOf).toBe('a');
  });
});

describe('clip mutations with non-finite beats', () => {
  it.each([
    ['move', (project: Project, beat: number) => moveClip(project, 'a', beat)],
    ['resize', (project: Project, beat: number) => resizeClip(project, 'a', beat)],
    ['copy', (project: Project, beat: number) => duplicateClip(project, 'a', { mode: 'copy', startBeat: beat })],
    ['link', (project: Project, beat: number) => duplicateClip(project, 'a', { mode: 'link', startBeat: beat })],
  ] as const)('%s rejects NaN and infinities', (_operation, mutate) => {
    const project = withMelodyClips([midi('a', 2, 4)]);
    const results = [NaN, Infinity, -Infinity].map((beat) => mutate(project, beat));
    expect(results.map((result) => validateProject(result).valid)).toEqual([true, true, true]);
    expect(results.every((result) => result === project)).toBe(true);
  });
});

describe('removeClip', () => {
  it('keeps a detached link silent when only the link had stored events', () => {
    const project = createEmptyProject({ clock: t0 });
    const track = drums(project);
    const source: Clip = { id: 'src', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 4, loop: false };
    const link: Clip = {
      ...source, id: 'link', startBeat: 4, aliasOf: 'src',
      notes: [note('silent-note', 0, 1)],
      drumEvents: [{ id: 'silent-kick', lane: 'kick', stepIndex: 0, velocity: 100 }],
    };
    const base = { ...project, tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clips: [source, link] } : t)) };
    expect(validateProject(base).ok).toBe(false);
    expect(soundedHits(base, track.id)).toEqual([]);
    const next = removeClip(base, source.id);
    expect(soundedHits(next, track.id)).toEqual([]);
    expect(clipById(next, link.id).notes).toBeUndefined();
    expect(clipById(next, link.id).drumEvents).toBeUndefined();
  });

  it('removes the clip', () => {
    const project = withMelodyClips([midi('a', 0, 4), midi('b', 4, 4)]);
    expect(melody(removeClip(project, 'a', t1)).clips.map((c) => c.id)).toEqual(['b']);
  });

  it('a clip linked to the removed one keeps sounding: it gets its own copy of the content', () => {
    const project = withMelodyClips([midi('a', 0, 4, [note('n1', 1, 1)]), { ...midi('l', 4, 4), aliasOf: 'a' }]);
    const next = removeClip(project, 'a');
    const left = clipById(next, 'l');
    expect(left.aliasOf).toBeUndefined();
    expect(left.notes!.map((n) => [n.startBeat, n.durationBeats])).toEqual([[1, 1]]);
    expect(expandClip(left, melody(next).clips).notes.map((n) => n.startBeat)).toEqual([5]);
  });
});

describe('resolveEditTarget', () => {
  it('returns the link source for a linked clip, and the clip itself otherwise', () => {
    const project = withMelodyClips([
      midi('a', 0, 4, [note('n1', 0, 1)]),
      { ...midi('l1', 4, 4), aliasOf: 'a' },
      { ...midi('l2', 8, 4), aliasOf: 'l1' },
    ]);
    expect(resolveEditTarget(project, 'l2')?.id).toBe('a');
    expect(resolveEditTarget(project, 'l1')?.id).toBe('a');
    expect(resolveEditTarget(project, 'a')?.id).toBe('a');
  });

  it('returns undefined for a missing clip or a broken link', () => {
    const project = withMelodyClips([{ ...midi('l', 0, 4), aliasOf: 'gone' }]);
    expect(resolveEditTarget(project, 'nope')).toBeUndefined();
    expect(resolveEditTarget(project, 'l')).toBeUndefined();
  });
});
