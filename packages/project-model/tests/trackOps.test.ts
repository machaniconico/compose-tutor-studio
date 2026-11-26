import { describe, it, expect } from 'vitest';
import {
  _resetIdCounter,
  addChordEvent,
  addSection,
  addTrack,
  createEmptyProject,
  duplicateTrack,
  makeId,
  moveTrack,
  removeTrack,
  renameTrack,
  setTrackColor,
} from '../src/index';
import type { Clip, Project, Track } from '../src/index';

const t0 = () => new Date('2026-06-11T00:00:00.000Z');
const t1 = () => new Date('2026-06-11T01:00:00.000Z');

function base(): Project {
  return createEmptyProject({ clock: t0 });
}

function master(project: Project): Track {
  const track = project.tracks.find((t) => t.type === 'master');
  if (!track) throw new Error('no master track');
  return track;
}

function trackNamed(project: Project, name: string): Track {
  const track = project.tracks.find((t) => t.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track;
}

/** A project whose Melody track holds notes, a linked clip and a drum-free second clip. */
function withMelodyContent(): Project {
  const project = base();
  const melody = trackNamed(project, 'Melody');
  const source: Clip = {
    id: 'clip-src',
    trackId: melody.id,
    type: 'midi',
    startBeat: 0,
    lengthBeats: 4,
    loop: false,
    notes: [
      { id: 'note-a', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
      { id: 'note-b', pitch: 64, startBeat: 1, durationBeats: 1, velocity: 90 },
    ],
  };
  const link: Clip = {
    id: 'clip-link',
    trackId: melody.id,
    type: 'midi',
    startBeat: 4,
    lengthBeats: 4,
    loop: false,
    aliasOf: 'clip-src',
  };
  const drumsTrack = trackNamed(project, 'Drums');
  const outsideLink: Clip = {
    id: 'clip-outside-link',
    trackId: melody.id,
    type: 'midi',
    startBeat: 8,
    lengthBeats: 4,
    loop: false,
    aliasOf: trackNamed(project, 'Bass').clips[0]!.id,
  };
  return {
    ...project,
    tracks: project.tracks.map((t) => {
      if (t.id === melody.id) return { ...t, clips: [source, link, outsideLink] };
      if (t.id === drumsTrack.id) {
        const clip = t.clips[0]!;
        return {
          ...t,
          clips: [{ ...clip, drumEvents: [{ id: 'drum-1', lane: 'kick', stepIndex: 0, velocity: 100 }] }],
        };
      }
      return t;
    }),
  };
}

describe('addTrack', () => {
  it('adds an instrument track before the master with a numbered Japanese name and no role', () => {
    const project = base();
    const next = addTrack(project, { type: 'instrument' }, t1);

    expect(next.tracks).toHaveLength(project.tracks.length + 1);
    const added = next.tracks[next.tracks.length - 2]!;
    expect(added.type).toBe('instrument');
    // Three instrument tracks already exist, so the new one is the fourth.
    expect(added.name).toBe('楽器 4');
    expect(added.role).toBeUndefined();
    expect(next.tracks[next.tracks.length - 1]!.type).toBe('master');
    expect(next.updatedAt).toBe('2026-06-11T01:00:00.000Z');
    expect(project.tracks).toHaveLength(5);
  });

  it('gives the new track one empty clip covering the song', () => {
    const project = base();
    const next = addTrack(project, { type: 'drum', id: 'track-new' }, t1);
    const added = next.tracks.find((t) => t.id === 'track-new')!;
    expect(added.name).toBe('ドラム 2');
    expect(added.clips).toHaveLength(1);
    const clip = added.clips[0]!;
    expect(clip.type).toBe('drum');
    expect(clip.trackId).toBe('track-new');
    expect(clip.startBeat).toBe(0);
    expect(clip.lengthBeats).toBe(project.lengthBars * 4);
    expect(clip.drumEvents).toEqual([]);
  });

  it('uses the given name and role', () => {
    const next = addTrack(base(), { type: 'instrument', name: 'ストリングス', role: 'chords' }, t1);
    const added = next.tracks[next.tracks.length - 2]!;
    expect(added.name).toBe('ストリングス');
    expect(added.role).toBe('chords');
  });

  it('skips a default name that is already taken', () => {
    const once = addTrack(base(), { type: 'drum' }, t1);
    const renamed = renameTrack(once, trackNamed(once, 'ドラム 2').id, 'ドラム 3', t1);
    const twice = addTrack(renamed, { type: 'drum' }, t1);
    expect(twice.tracks.filter((t) => t.type === 'drum').map((t) => t.name)).toEqual([
      'Drums',
      'ドラム 3',
      'ドラム 4',
    ]);
  });
});

describe('removeTrack', () => {
  it('removes the track and its clips', () => {
    const project = withMelodyContent();
    const melody = trackNamed(project, 'Melody');
    const next = removeTrack(project, melody.id, t1);
    expect(next.tracks.map((t) => t.name)).toEqual(['Chords', 'Bass', 'Drums', 'Master']);
    expect(next.updatedAt).toBe('2026-06-11T01:00:00.000Z');
    expect(project.tracks).toHaveLength(5);
  });

  it('leaves the project unchanged for the master or an unknown id', () => {
    const project = base();
    expect(removeTrack(project, master(project).id, t1)).toBe(project);
    expect(removeTrack(project, 'missing', t1)).toBe(project);
  });
});

describe('duplicateTrack', () => {
  it('inserts a copy right after the original with fresh ids everywhere', () => {
    const project = withMelodyContent();
    const melody = trackNamed(project, 'Melody');
    const next = duplicateTrack(project, melody.id, t1);

    const index = next.tracks.findIndex((t) => t.id === melody.id);
    const copy = next.tracks[index + 1]!;
    expect(copy.name).toBe('Melody のコピー');
    expect(copy.id).not.toBe(melody.id);
    expect(next.tracks).toHaveLength(project.tracks.length + 1);

    const originalIds = new Set(
      project.tracks.flatMap((t) => [
        t.id,
        ...t.clips.flatMap((c) => [
          c.id,
          ...(c.notes ?? []).map((n) => n.id),
          ...(c.drumEvents ?? []).map((d) => d.id),
        ]),
      ]),
    );
    const copyIds = [
      copy.id,
      ...copy.clips.flatMap((c) => [c.id, ...(c.notes ?? []).map((n) => n.id)]),
    ];
    expect(copyIds).toHaveLength(1 + 3 + 2);
    for (const id of copyIds) expect(originalIds.has(id)).toBe(false);
    expect(new Set(copyIds).size).toBe(copyIds.length);
    for (const clip of copy.clips) expect(clip.trackId).toBe(copy.id);
    expect(copy.clips[0]!.notes!.map((n) => n.pitch)).toEqual([60, 64]);
  });

  it('points links inside the copy at the copied clips and keeps outside links', () => {
    const project = withMelodyContent();
    const melody = trackNamed(project, 'Melody');
    const next = duplicateTrack(project, melody.id, t1);
    const copy = next.tracks[next.tracks.findIndex((t) => t.id === melody.id) + 1]!;
    const [copiedSource, copiedLink, copiedOutside] = copy.clips;
    expect(copiedLink!.aliasOf).toBe(copiedSource!.id);
    expect(copiedOutside!.aliasOf).toBe(trackNamed(project, 'Bass').clips[0]!.id);
  });

  it('gives drum events fresh ids', () => {
    const project = withMelodyContent();
    const drums = trackNamed(project, 'Drums');
    const next = duplicateTrack(project, drums.id, t1);
    const copy = next.tracks[next.tracks.findIndex((t) => t.id === drums.id) + 1]!;
    const events = copy.clips[0]!.drumEvents!;
    expect(events).toHaveLength(1);
    expect(events[0]!.id).not.toBe('drum-1');
    expect(events[0]!.lane).toBe('kick');
  });

  it('leaves the project unchanged for the master', () => {
    const project = base();
    expect(duplicateTrack(project, master(project).id, t1)).toBe(project);
  });
});

describe('track ids after reopening a saved project', () => {
  /** Every track, clip, note, drum event and effect id, duplicates kept. */
  function allIds(project: Project): string[] {
    return project.tracks.flatMap((t) => [
      t.id,
      ...t.effects.map((e) => e.id),
      ...t.clips.flatMap((c) => [
        c.id,
        ...(c.notes ?? []).map((n) => n.id),
        ...(c.drumEvents ?? []).map((d) => d.id),
      ]),
    ]);
  }

  /** Save, then reopen in a new app session (the id counter starts over). */
  function reopen(project: Project): Project {
    const json = JSON.stringify(project);
    _resetIdCounter();
    return JSON.parse(json) as Project;
  }

  it('duplicate and add after reopening never reuse an id already in the project', () => {
    _resetIdCounter();
    const first = base();
    const saved = duplicateTrack(first, trackNamed(first, 'Chords').id, t1);
    const reopened = reopen(saved);
    const again = duplicateTrack(reopened, trackNamed(reopened, 'Chords').id, t1);
    const added = addTrack(addTrack(again, { type: 'instrument' }, t1), { type: 'drum' }, t1);

    const ids = allIds(added);
    expect(new Set(ids).size).toBe(ids.length);
    expect(added.tracks).toHaveLength(saved.tracks.length + 3);
    // Still unique after another save and reopen.
    const reopenedAgain = reopen(added);
    const ids2 = allIds(reopenedAgain);
    expect(new Set(ids2).size).toBe(ids2.length);
  });

  it('ignores a requested track id that is already taken', () => {
    const project = base();
    const taken = trackNamed(project, 'Bass').id;
    const next = addTrack(project, { type: 'instrument', id: taken }, t1);
    const ids = next.tracks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(['track-project', 'track-chord', 'track-section', 'track-missing'])('reserves the ID %s', (id) => {
    const melody = trackNamed(withMelodyContent(), 'Melody');
    const linkedClip = { ...melody.clips[0]!, aliasOf: 'track-missing' };
    const project = addSection(
      addChordEvent(
        { ...base(), id: 'track-project', tracks: [{ ...melody, clips: [linkedClip] }] },
        { id: 'track-chord', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', notes: [0, 4, 7], quality: 'major' },
        t1,
      ),
      { id: 'track-section', startBar: 0, lengthBars: 4, name: 'Intro', type: 'intro' },
      t1,
    );
    expect(addTrack(project, { type: 'instrument', id }, t1).tracks.map((t) => t.id)).not.toContain(id);
  });

  it.each([
    ['add', (project: Project) => addTrack(project, { type: 'instrument' }, t1)],
    ['duplicate', (project: Project) => duplicateTrack(project, trackNamed(project, 'Bass').id, t1)],
  ] as const)('makes %s deterministic without consuming shared ids', (_operation, mutate) => {
    const project = base();
    _resetIdCounter();
    const first = mutate(project);
    expect(mutate(project)).toEqual(first);
    expect(makeId('test')).toBe('test-1');
  });
});

describe('renameTrack', () => {
  it('renames the track with the trimmed name', () => {
    const project = base();
    const id = trackNamed(project, 'Bass').id;
    const next = renameTrack(project, id, '  ベース  ', t1);
    expect(next.tracks.find((t) => t.id === id)!.name).toBe('ベース');
  });

  it('leaves the project unchanged for an empty or same name', () => {
    const project = base();
    const id = trackNamed(project, 'Bass').id;
    expect(renameTrack(project, id, '   ', t1)).toBe(project);
    expect(renameTrack(project, id, 'Bass', t1)).toBe(project);
  });
});

describe('moveTrack', () => {
  it('moves a track among the movable tracks', () => {
    const project = base();
    const drums = trackNamed(project, 'Drums');
    const next = moveTrack(project, drums.id, 0, t1);
    expect(next.tracks.map((t) => t.name)).toEqual(['Drums', 'Chords', 'Bass', 'Melody', 'Master']);
    const down = moveTrack(next, drums.id, 2, t1);
    expect(down.tracks.map((t) => t.name)).toEqual(['Chords', 'Bass', 'Drums', 'Melody', 'Master']);
  });

  it('keeps the master in place and clamps the index', () => {
    const project = base();
    const chords = trackNamed(project, 'Chords');
    const next = moveTrack(project, chords.id, 99, t1);
    expect(next.tracks.map((t) => t.name)).toEqual(['Bass', 'Melody', 'Drums', 'Chords', 'Master']);
  });

  it('leaves the project unchanged for the master or a move to the same place', () => {
    const project = base();
    expect(moveTrack(project, master(project).id, 0, t1)).toBe(project);
    expect(moveTrack(project, trackNamed(project, 'Bass').id, 1, t1)).toBe(project);
  });
});

describe('setTrackColor', () => {
  it('sets the color of one track', () => {
    const project = base();
    const id = trackNamed(project, 'Melody').id;
    const next = setTrackColor(project, id, '#123456', t1);
    expect(next.tracks.find((t) => t.id === id)!.color).toBe('#123456');
    expect(project.tracks.find((t) => t.id === id)!.color).toBe('#7cf0a0');
    expect(next.updatedAt).toBe('2026-06-11T01:00:00.000Z');
  });
});
