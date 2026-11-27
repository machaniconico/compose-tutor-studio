import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PPQ,
  createEmptyProject,
  MAX_RUNTIME_SCHEDULE_EVENTS,
  clipContentOwnerId,
  realizeChordTrack,
  resolveClipContent,
  visitMidiClipNoteOccurrences,
  type Clip,
  type NoteEvent,
  type Project,
  type ScaleName,
  type Track,
} from '@cts/project-model';
import { projectToMidiResult } from '@cts/midi-io';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { installLocalStorage } from './localStorageStub';
import {
  copyNotesFromProject,
  cutNotesInProject,
  fitNotesToScaleInProject,
  moveByScaleDegrees,
  pasteNotesIntoProject,
  transposeNotesInProject,
  type NoteEditOutcome,
} from '../src/state/noteEditActions';
import type { NoteClipboard } from '../src/state/noteClipboard';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/noteEditActions');
let clipboardModule: typeof import('../src/state/noteClipboard');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/noteEditActions');
  clipboardModule = await import('../src/state/noteClipboard');
});

type NoteSpec = [pitch: number, startBeat: number, durationBeats?: number];

function notesOf(specs: readonly NoteSpec[], prefix = 'n'): NoteEvent[] {
  return specs.map(([pitch, startBeat, durationBeats = 1], i) => ({
    id: `${prefix}${i}`,
    pitch,
    startBeat,
    durationBeats,
    velocity: 90,
  }));
}

/** Melody clip `mel` (8 beats at beat 0), bass clip `bass` (8 beats at beat 8), a drum clip. */
function song(
  melody: readonly NoteSpec[] = [[60, 0], [64, 1], [67, 2]],
  over: { key?: Project['key']; scale?: ScaleName; loop?: boolean; bass?: readonly NoteSpec[] } = {},
): Project {
  const base = createEmptyProject({ key: over.key ?? 'C', scale: over.scale ?? 'major' });
  const tracks = base.tracks.map((track): Track => {
    if (track.type === 'instrument' && track.role === 'learning.melody') {
      const clip: Clip = {
        id: 'mel', trackId: track.id, type: 'midi', startBeat: 0, lengthBeats: 8, loop: over.loop ?? false,
        notes: notesOf(melody),
      };
      return { ...track, clips: [clip] };
    }
    if (track.type === 'instrument' && track.role === 'learning.bass') {
      const clip: Clip = {
        id: 'bass', trackId: track.id, type: 'midi', startBeat: 8, lengthBeats: 8, loop: false,
        notes: notesOf(over.bass ?? [[36, 0, 2]], 'b'),
      };
      return { ...track, clips: [clip] };
    }
    if (track.type === 'drum') {
      const clip: Clip = {
        id: 'dr', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 8, loop: false,
        stepsPerBar: 16, drumEvents: [{ id: 'd0', lane: 'kick', stepIndex: 0, velocity: 100 }],
      };
      return { ...track, clips: [clip] };
    }
    return track;
  });
  return { ...base, tracks, chordTrack: [] };
}

function clipNotes(project: Project, clipId: string): NoteEvent[] {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip.notes ?? [];
  }
  throw new Error(`missing clip ${clipId}`);
}

function ok(outcome: NoteEditOutcome): Extract<NoteEditOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome;
}

function pitches(project: Project, clipId: string): number[] {
  return clipNotes(project, clipId).map((note) => note.pitch);
}

let ids = 0;
const nextId = () => `p${(ids += 1)}`;

describe('copy', () => {
  it('stores notes relative to the earliest onset in whole ticks, with no IDs', () => {
    const project = song([[60, 1.5], [64, 1], [67, 3, 0.5]]);
    const copied = copyNotesFromProject(project, 'mel', ['n0', 'n1', 'n2']);
    if (!copied.ok) throw new Error(copied.reason);
    expect(copied.clipboard).toEqual({
      originTicks: PPQ,
      notes: [
        { pitch: 64, offsetTicks: 0, durationTicks: PPQ, velocity: 90 },
        { pitch: 60, offsetTicks: PPQ / 2, durationTicks: PPQ, velocity: 90 },
        { pitch: 67, offsetTicks: 2 * PPQ, durationTicks: PPQ / 2, velocity: 90 },
      ],
    });
    expect(JSON.stringify(copied.clipboard)).not.toMatch(/"id"|mel|n0/);
  });

  it('refuses notes off the 1/480-beat grid and missing or empty selections', () => {
    expect(copyNotesFromProject(song([[60, 0.3001]]), 'mel', ['n0']).ok).toBe(false);
    expect(copyNotesFromProject(song([[60, 0, 1 / 7]]), 'mel', ['n0']).ok).toBe(false);
    // A triplet eighth (1/3 beat = 160 ticks) is on the grid.
    expect(copyNotesFromProject(song([[60, 0, 1 / 3]]), 'mel', ['n0']).ok).toBe(true);
    expect(copyNotesFromProject(song(), 'mel', []).ok).toBe(false);
    expect(copyNotesFromProject(song(), 'mel', ['nope']).ok).toBe(false);
    expect(copyNotesFromProject(song(), 'nope', ['n0']).ok).toBe(false);
    expect(copyNotesFromProject(song(), 'dr', ['d0']).ok).toBe(false);
  });

  it('tolerates hostile values without throwing', () => {
    const hostile = { toString: null } as unknown as string;
    expect(() => copyNotesFromProject(song(), hostile, [hostile])).not.toThrow();
    expect(copyNotesFromProject(song(), 'mel', [hostile]).ok).toBe(false);
    expect(transposeNotesInProject(song(), 'mel', ['n0'], { semitones: hostile as unknown as number }).ok).toBe(false);
    expect(transposeNotesInProject(song(), 'mel', ['n0'], null as never).ok).toBe(false);
  });
});

describe('paste', () => {
  const board = (notes: NoteClipboard['notes'], originTicks = 0): NoteClipboard => ({ originTicks, notes });
  const one = (pitch: number, offsetTicks: number, durationTicks = PPQ) => ({ pitch, offsetTicks, durationTicks, velocity: 80 });

  it('places notes at the anchor with fresh IDs and adds exactly those schedule events', () => {
    const before = song();
    const result = ok(pasteNotesIntoProject(before, 'bass', board([one(40, 0), one(43, PPQ)]), 2 * PPQ, nextId));
    expect(result.noteIds).toHaveLength(2);
    const added = clipNotes(result.project, 'bass').slice(-2);
    expect(added.map((n) => [n.pitch, n.startBeat, n.durationBeats, n.velocity])).toEqual([[40, 2, 1, 80], [43, 3, 1, 80]]);
    const a = buildScheduleEvents(before);
    const b = buildScheduleEvents(result.project);
    expect(b.length).toBe(a.length + 2);
    const newBeats = b
      .map((e) => [e.beat, (e.payload as SchedulePayload & { pitch?: number }).pitch])
      .filter(([, pitch]) => pitch === 40 || pitch === 43);
    expect(newBeats).toEqual([[10, 40], [11, 43]]);
  });

  it('refuses the whole paste past the clip end (nothing partial)', () => {
    const before = song();
    const result = pasteNotesIntoProject(before, 'mel', board([one(72, 0), one(74, 2 * PPQ)]), 6 * PPQ, nextId);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('クリップの終わり');
  });

  it('refuses a paste past the song end', () => {
    const base = song();
    const project: Project = {
      ...base,
      tracks: base.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === 'bass' ? { ...c, startBeat: base.lengthBeats - 4 } : c)),
      })),
    };
    const result = pasteNotesIntoProject(project, 'bass', board([one(40, 0, 2 * PPQ)]), 3 * PPQ, nextId);
    expect(result.ok ? '' : result.reason).toContain('曲の終わり');
  });

  it('refuses a same-pitch overlap but allows touching notes and other pitches', () => {
    const before = song([[60, 0], [64, 1]]);
    expect(pasteNotesIntoProject(before, 'mel', board([one(60, 0)]), PPQ / 2, nextId).ok).toBe(false);
    expect(pasteNotesIntoProject(before, 'mel', board([one(60, 0)]), PPQ, nextId).ok).toBe(true);
    expect(pasteNotesIntoProject(before, 'mel', board([one(62, 0)]), 0, nextId).ok).toBe(true);
    // Two pasted notes of one pitch that overlap each other are refused too.
    expect(pasteNotesIntoProject(before, 'mel', board([one(70, 0, 2 * PPQ), one(70, PPQ)]), 2 * PPQ, nextId).ok).toBe(false);
  });

  it('refuses an empty or malformed clipboard and out-of-range values', () => {
    const before = song();
    expect(pasteNotesIntoProject(before, 'mel', null, 0, nextId).ok).toBe(false);
    expect(pasteNotesIntoProject(before, 'mel', board([]), 0, nextId).ok).toBe(false);
    expect(pasteNotesIntoProject(before, 'mel', board([one(128, 0)]), 4 * PPQ, nextId).ok).toBe(false);
    expect(pasteNotesIntoProject(before, 'mel', board([one(60, 0.5)]), 4 * PPQ, nextId).ok).toBe(false);
    expect(pasteNotesIntoProject(before, 'mel', board([one(60, 0)]), -1, nextId).ok).toBe(false);
    expect(pasteNotesIntoProject(before, 'mel', board([one(60, 0)]), 0.5, nextId).ok).toBe(false);
  });

  it('writes a linked clip to its source and checks every placement', () => {
    const base = song([[60, 0]]);
    const melTrack = base.tracks.find((t) => t.clips.some((c) => c.id === 'mel'))!;
    const link: Clip = { id: 'link', trackId: melTrack.id, type: 'midi', startBeat: 16, lengthBeats: 4, loop: false, aliasOf: 'mel' };
    const project: Project = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === melTrack.id ? { ...t, clips: [...t.clips, link] } : t)),
    };
    const pasted = ok(pasteNotesIntoProject(project, 'link', board([one(62, 0)]), 2 * PPQ, nextId));
    expect(clipNotes(pasted.project, 'mel').map((n) => n.pitch)).toEqual([60, 62]);
    // The link is only 4 beats long, so beat 5 does not fit it even though the source is 8 beats.
    expect(pasteNotesIntoProject(project, 'mel', board([one(62, 0)]), 5 * PPQ, nextId).ok).toBe(false);
  });

  it('refuses by the buildScheduleEvents post-check when other sounds would change', () => {
    // Authored notes on the chord-backing track silence the realized chords, so the
    // schedule would change by more than the pasted note.
    const base: Project = {
      ...song(),
      chordTrack: [{ id: 'c1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7], function: 'T', degree: 'I' }],
    };
    const realized = realizeChordTrack(base);
    if (!realized) throw new Error('chord backing track missing');
    const project: Project = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === realized.track.id
        ? { ...t, clips: [{ id: 'ch', trackId: t.id, type: 'midi', startBeat: 0, lengthBeats: 8, loop: false, notes: [] }] }
        : t)),
    };
    expect(realizeChordTrack(project)).not.toBeNull();
    const result = pasteNotesIntoProject(project, 'ch', board([one(60, 0)]), 4 * PPQ, nextId);
    expect(result.ok ? '' : result.reason).toContain('鳴り方まで変わって');
  });

  it('pastes into a looping clip on every pass when the loop period is unchanged, and refuses otherwise', () => {
    const before = song([[60, 0, 2]], { loop: true });
    const result = ok(pasteNotesIntoProject(before, 'mel', board([one(62, 0)]), PPQ, nextId));
    const beats62 = buildScheduleEvents(result.project)
      .filter((e) => (e.payload as SchedulePayload).kind === 'note' && (e.payload as { pitch: number }).pitch === 62)
      .map((e) => e.beat);
    expect(beats62).toEqual([1, 3, 5, 7]);
    const longer = pasteNotesIntoProject(before, 'mel', board([one(62, 0)]), 2 * PPQ, nextId);
    expect(longer.ok ? '' : longer.reason).toContain('ループの長さが変わる');
  });
});

describe('cut', () => {
  it('copies and removes the notes, removing exactly their schedule events', () => {
    const before = song();
    const result = cutNotesInProject(before, 'mel', ['n1']);
    if (!result.ok) throw new Error(result.reason);
    expect(pitches(result.project, 'mel')).toEqual([60, 67]);
    expect(result.clipboard.notes).toEqual([{ pitch: 64, offsetTicks: 0, durationTicks: PPQ, velocity: 90 }]);
    expect(result.clipboard.originTicks).toBe(PPQ);
    expect(buildScheduleEvents(result.project).length).toBe(buildScheduleEvents(before).length - 1);
  });
});

describe('transpose', () => {
  it('moves only the selected notes by semitones', () => {
    const result = ok(transposeNotesInProject(song(), 'mel', ['n0', 'n2'], { semitones: 1 }));
    expect(pitches(result.project, 'mel')).toEqual([61, 64, 68]);
    expect(pitches(ok(transposeNotesInProject(song(), 'mel', ['n1'], { semitones: -12 })).project, 'mel')).toEqual([60, 52, 67]);
  });

  it('refuses the whole move when one note would leave MIDI 0..127', () => {
    const before = song([[127, 0], [60, 1]]);
    const up = transposeNotesInProject(before, 'mel', ['n0', 'n1'], { semitones: 1 });
    expect(up.ok ? '' : up.reason).toContain('127');
    const down = transposeNotesInProject(song([[0, 0], [60, 1]]), 'mel', ['n0', 'n1'], { degrees: -1 });
    expect(down.ok ? '' : down.reason).toContain('MIDI 0');
  });

  it('refuses bad amounts', () => {
    for (const by of [{ semitones: 0 }, { semitones: 1.5 }, { semitones: 13 }, { semitones: Number.NaN }, { degrees: 8 }, { degrees: 0 }, {}]) {
      expect(transposeNotesInProject(song(), 'mel', ['n0'], by as never).ok).toBe(false);
    }
  });

  it('refuses a move that would make two same-pitch notes overlap', () => {
    const before = song([[60, 0, 2], [62, 1]]);
    const result = transposeNotesInProject(before, 'mel', ['n1'], { semitones: -2 });
    expect(result.ok ? '' : result.reason).toContain('重なって');
  });

  it('moves along the scale; an out-of-scale note counts the nearest scale tone in that direction as one step', () => {
    // C major: E4 → F4, B4 → C5, C#4 → D4 (up) / C4 (down)
    expect(moveByScaleDegrees(64, 1, 'C', 'major')).toBe(65);
    expect(moveByScaleDegrees(71, 1, 'C', 'major')).toBe(72);
    expect(moveByScaleDegrees(61, 1, 'C', 'major')).toBe(62);
    expect(moveByScaleDegrees(61, -1, 'C', 'major')).toBe(60);
    expect(moveByScaleDegrees(61, 2, 'C', 'major')).toBe(64);
    expect(moveByScaleDegrees(60, 7, 'C', 'major')).toBe(72);
    // A natural minor: G4 → A4, A4 down → G4
    expect(moveByScaleDegrees(67, 1, 'A', 'naturalMinor')).toBe(69);
    expect(moveByScaleDegrees(69, -1, 'A', 'naturalMinor')).toBe(67);
    // C minor pentatonic (C Eb F G Bb): D4 up → Eb4, down → C4
    expect(moveByScaleDegrees(62, 1, 'C', 'minorPentatonic')).toBe(63);
    expect(moveByScaleDegrees(62, -1, 'C', 'minorPentatonic')).toBe(60);
    const result = ok(transposeNotesInProject(song([[60, 0], [61, 1], [64, 2]]), 'mel', ['n0', 'n1', 'n2'], { degrees: 1 }));
    expect(pitches(result.project, 'mel')).toEqual([62, 62, 65]);
  });

  it('changes only the pitches of the selected notes in the schedule', () => {
    const before = song([[60, 0], [64, 1], [67, 2]], { bass: [[36, 0, 2]] });
    const result = ok(transposeNotesInProject(before, 'mel', ['n1'], { semitones: 3 }));
    const a = buildScheduleEvents(before);
    const b = buildScheduleEvents(result.project);
    expect(b.length).toBe(a.length);
    const changed = a.flatMap((x, i) => {
      const px = x.payload as SchedulePayload;
      const py = b[i]!.payload as SchedulePayload;
      expect(b[i]!.beat).toBe(x.beat);
      if (px.kind === 'drum' || py.kind === 'drum') {
        expect(py).toEqual(px);
        return [];
      }
      return px.pitch === py.pitch ? [] : [[px.pitch, py.pitch]];
    });
    expect(changed).toEqual([[64, 67]]);
  });
});

describe('fit to scale', () => {
  it('snaps only the selected out-of-scale notes, down on a tie', () => {
    // C major: C#4 → C4 (tie), F#4 → F4 (tie), Eb4 → D4 (tie); unselected Bb stays.
    const before = song([[61, 0], [66, 1], [63, 2], [70, 3], [64, 4]]);
    const result = ok(fitNotesToScaleInProject(before, 'mel', ['n0', 'n1', 'n2', 'n4']));
    expect(pitches(result.project, 'mel')).toEqual([60, 65, 62, 70, 64]);
    expect(result.message).toContain('3個');
  });

  it('snaps to the nearest tone when it is not a tie (C minor pentatonic D → Eb, A → Bb)', () => {
    const result = ok(fitNotesToScaleInProject(song([[62, 0], [69, 1]], { scale: 'minorPentatonic' }), 'mel', ['n0', 'n1']));
    expect(pitches(result.project, 'mel')).toEqual([63, 70]);
  });

  it('changes nothing when every selected note is already in the scale', () => {
    const before = song();
    const result = ok(fitNotesToScaleInProject(before, 'mel', ['n0', 'n1', 'n2']));
    expect(result.changed).toBe(false);
    expect(result.project).toBe(before);
  });

  it('refuses when two notes would land on one pitch and overlap', () => {
    const result = fitNotesToScaleInProject(song([[60, 0], [61, 0]]), 'mel', ['n1']);
    expect(result.ok).toBe(false);
  });
});

describe('store integration (one undo step each)', () => {
  beforeEach(() => {
    clipboardModule.setNoteClipboard(null);
    useStore.setState({
      project: { ...song(), id: useStore.getState().project.id },
      past: [],
      future: [],
      audioRecordingOperationId: null,
      projectOperationBusy: false,
    });
  });

  it('copy does not touch history; paste is one undo step and selects the new notes', () => {
    expect(actions.copySelectedNotes('mel', ['n0', 'n1']).ok).toBe(true);
    expect(useStore.getState().past.length).toBe(0);
    const pasted = actions.pasteClipboardNotes('bass', 'original');
    expect(pasted.ok ? '' : pasted.reason).toBe('');
    expect(useStore.getState().past.length).toBe(1);
    expect(pitches(useStore.getState().project, 'bass')).toEqual([36, 60, 64]);
    expect(useStore.getState().editor.selectedNoteIds).toEqual(pasted.ok ? [...pasted.noteIds] : []);
    useStore.getState().undo();
    expect(pitches(useStore.getState().project, 'bass')).toEqual([36]);
  });

  it('pasting in place onto the copied notes is refused and changes nothing', () => {
    actions.copySelectedNotes('mel', ['n0']);
    const before = useStore.getState().project;
    const result = actions.pasteClipboardNotes('mel', 'original');
    expect(result.ok).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past.length).toBe(0);
  });

  it('auto paste: same-clip copy, move the playhead, paste there', () => {
    actions.copySelectedNotes('mel', ['n0']);
    useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: 5 } }));
    const result = actions.pasteClipboardNotes('mel', 'auto');
    expect(result.ok ? '' : result.reason).toBe('');
    expect(clipNotes(useStore.getState().project, 'mel').map((n) => [n.pitch, n.startBeat])).toEqual([[60, 0], [64, 1], [67, 2], [60, 5]]);
    expect(useStore.getState().past.length).toBe(1);
  });

  it('auto paste falls back to the original position when the playhead is outside the clip', () => {
    actions.copySelectedNotes('mel', ['n1']);
    useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: 11 } }));
    // Inside bass (beats 8..16): lands at the playhead, local beat 3.
    expect(actions.pasteClipboardNotes('bass', 'auto').ok).toBe(true);
    expect(clipNotes(useStore.getState().project, 'bass').at(-1)?.startBeat).toBe(3);
    // Outside bass: original clip-relative position (beat 1).
    useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: 2 } }));
    expect(actions.pasteClipboardNotes('bass', 'auto').ok).toBe(true);
    expect(clipNotes(useStore.getState().project, 'bass').at(-1)?.startBeat).toBe(1);
  });

  it('auto paste decides clip membership on the unrounded playhead at both clip edges', () => {
    const quarterTick = 0.25 / PPQ;
    // A one-beat C4 copied from local beat 2; bass clip spans beats 8..16.
    const run = (positionBeat: number) => {
      useStore.setState({ project: { ...song([[60, 2]], { bass: [] }), id: useStore.getState().project.id }, past: [], future: [] });
      actions.copySelectedNotes('mel', ['n0']);
      useStore.setState((s) => ({ transport: { ...s.transport, positionBeat } }));
      const result = actions.pasteClipboardNotes('bass', 'auto');
      return { result, starts: clipNotes(useStore.getState().project, 'bass').map((n) => n.startBeat) };
    };
    // Just before the start: outside, so the original position (local 2 = beat 10).
    expect(run(8 - quarterTick).starts).toEqual([2]);
    // Exactly at the start: inside, at the playhead.
    expect(run(8).starts).toEqual([0]);
    // Just before the end: inside; rounds onto the end tick, so the note would pass the clip end.
    const nearEnd = run(16 - quarterTick);
    expect(nearEnd.result.ok ? '' : nearEnd.result.reason).toContain('クリップの終わり');
    expect(nearEnd.starts).toEqual([]);
    // Exactly at the end: outside, so the original position.
    expect(run(16).starts).toEqual([2]);
  });

  it('original paste ignores the playhead', () => {
    actions.copySelectedNotes('mel', ['n1']);
    useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: 11 } }));
    expect(actions.pasteClipboardNotes('bass', 'original').ok).toBe(true);
    expect(clipNotes(useStore.getState().project, 'bass').at(-1)?.startBeat).toBe(1);
  });

  it('cut is one undo step and fills the clipboard only when it succeeds', () => {
    useStore.setState({ audioRecordingOperationId: 1 });
    expect(actions.cutSelectedNotes('mel', ['n0']).ok).toBe(false);
    expect(clipboardModule.getNoteClipboard()).toBeNull();
    useStore.setState({ audioRecordingOperationId: null });
    expect(actions.cutSelectedNotes('mel', ['n0']).ok).toBe(true);
    expect(clipboardModule.getNoteClipboard()?.notes).toHaveLength(1);
    expect(useStore.getState().past.length).toBe(1);
    useStore.getState().undo();
    expect(pitches(useStore.getState().project, 'mel')).toEqual([60, 64, 67]);
  });

  it('transpose and fit are one undo step each and refuse while recording', () => {
    expect(actions.transposeSelectedNotes('mel', ['n0'], { semitones: 1 }).ok).toBe(true);
    expect(actions.fitSelectedNotesToScale('mel', ['n0']).ok).toBe(true);
    expect(pitches(useStore.getState().project, 'mel')).toEqual([60, 64, 67]);
    expect(useStore.getState().past.length).toBe(2);
    useStore.getState().undo();
    expect(pitches(useStore.getState().project, 'mel')).toEqual([61, 64, 67]);
    useStore.setState({ audioRecordingOperationId: 1 });
    const before = useStore.getState().project;
    expect(actions.transposeSelectedNotes('mel', ['n1'], { degrees: 1 }).ok).toBe(false);
    expect(actions.pasteClipboardNotes('mel', 'original').ok).toBe(false);
    expect(useStore.getState().project).toBe(before);
    useStore.setState({ audioRecordingOperationId: null });
  });
});

describe('seeded fuzz', () => {
  it('every edit either refuses unchanged or keeps the domain and a sane schedule', () => {
    let seed = 20261128;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const int = (n: number) => Math.floor(rnd() * n);
    const scales: ScaleName[] = ['major', 'naturalMinor', 'harmonicMinor', 'majorPentatonic', 'minorPentatonic', 'blues'];
    const keys = ['C', 'D', 'Eb', 'F#', 'A', 'Bb'] as const;
    let accepted = 0;
    for (let round = 0; round < 300; round += 1) {
      const specs: NoteSpec[] = Array.from({ length: 1 + int(8) }, () => [
        int(128), int(28) / 4, (1 + int(8)) / 4,
      ]);
      const valid = specs.filter(([, start, duration]) => start + duration! <= 8);
      if (valid.length === 0) continue;
      const before = song(valid, { key: keys[int(keys.length)]!, scale: scales[int(scales.length)]!, loop: rnd() < 0.3 });
      const all = clipNotes(before, 'mel');
      const selected = all.filter(() => rnd() < 0.6).map((n) => n.id);
      const op = int(4);
      let outcome: NoteEditOutcome;
      if (op === 0) outcome = transposeNotesInProject(before, 'mel', selected, { semitones: int(25) - 12 });
      else if (op === 1) outcome = transposeNotesInProject(before, 'mel', selected, { degrees: int(15) - 7 });
      else if (op === 2) outcome = fitNotesToScaleInProject(before, 'mel', selected);
      else {
        const copied = copyNotesFromProject(before, 'mel', selected);
        outcome = copied.ok
          ? pasteNotesIntoProject(before, 'bass', copied.clipboard, int(8) * PPQ, nextId)
          : copied;
      }
      if (!outcome.ok || !outcome.changed) {
        if (outcome.ok) expect(outcome.project).toBe(before);
        continue;
      }
      accepted += 1;
      const after = outcome.project;
      for (const clipId of ['mel', 'bass']) {
        const notes = clipNotes(after, clipId);
        for (const note of notes) {
          expect(note.pitch).toBeGreaterThanOrEqual(0);
          expect(note.pitch).toBeLessThanOrEqual(127);
          expect(note.startBeat + note.durationBeats).toBeLessThanOrEqual(8);
        }
      }
      // Unselected melody notes never change.
      const afterById = new Map(clipNotes(after, 'mel').map((n) => [n.id, n]));
      for (const note of all) {
        if (!selected.includes(note.id)) expect(afterById.get(note.id)).toEqual(note);
      }
      const events = buildScheduleEvents(after);
      for (const event of events) {
        const payload = event.payload as SchedulePayload;
        expect(Number.isFinite(event.beat)).toBe(true);
        if (payload.kind === 'note') expect(payload.pitch >= 0 && payload.pitch <= 127).toBe(true);
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });
});

describe('Codex review repros (D1–D3)', () => {
  const one = (pitch: number, offsetTicks: number, durationTicks = PPQ) => ({ pitch, offsetTicks, durationTicks, velocity: 80 });
  const board = (notes: NoteClipboard['notes']): NoteClipboard => ({ originTicks: 0, notes });
  function melodyClips(base: Project, clips: (trackId: string) => Clip[]): Project {
    const melTrack = base.tracks.find((t) => t.clips.some((c) => c.id === 'mel'))!;
    return { ...base, tracks: base.tracks.map((t) => (t.id === melTrack.id ? { ...t, clips: clips(t.id) } : t)) };
  }

  it('1: refuses a linked paste that overlaps a same-pitch note of another clip on the track', () => {
    const project = melodyClips(song(), (trackId) => [
      { id: 'src', trackId, type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, notes: [] },
      { id: 'al', trackId, type: 'midi', startBeat: 8, lengthBeats: 4, loop: false, aliasOf: 'src' },
      { id: 'other', trackId, type: 'midi', startBeat: 9, lengthBeats: 4, loop: false, notes: notesOf([[60, 0, 1]], 'o') },
    ]);
    const result = pasteNotesIntoProject(project, 'al', board([one(60, 0)]), PPQ, nextId);
    expect(result.ok ? '' : result.reason).toContain('同じ高さの音');
  });

  it('2: refuses a cut that changes a looped clip period', () => {
    const project = melodyClips(song(), (trackId) => [
      { id: 'loop', trackId, type: 'midi', startBeat: 0, lengthBeats: 4, loop: true, notes: notesOf([[60, 0, 1], [62, 1, 1]], 'l') },
      { id: 'o2', trackId, type: 'midi', startBeat: 1, lengthBeats: 1, loop: false, notes: notesOf([[60, 0, 1]], 'o') },
    ]);
    const result = cutNotesInProject(project, 'loop', ['l1']);
    expect(result.ok ? '' : result.reason).toBe('ループしているクリップでは、ループの長さが変わる貼り付け・切り取りはできません。');
  });

  it('2b: allows a cut on a looped clip when the period is unchanged', () => {
    const project = melodyClips(song(), (trackId) => [
      { id: 'loop', trackId, type: 'midi', startBeat: 0, lengthBeats: 4, loop: true, notes: notesOf([[60, 0, 2], [64, 0, 1]], 'l') },
    ]);
    expect(cutNotesInProject(project, 'loop', ['l1']).ok).toBe(true);
  });

  it('3: refuses edits on a clip whose start is not a whole tick', () => {
    const t = 1 / PPQ;
    const project = melodyClips(song(), (trackId) => [
      {
        id: 'frac', trackId, type: 'midi', startBeat: 0.25 * t, lengthBeats: 4, loop: false,
        notes: [
          { id: 'f0', pitch: 60, startBeat: 0, durationBeats: 1.375 * t, velocity: 90 },
          { id: 'f1', pitch: 61, startBeat: 1.125 * t, durationBeats: t, velocity: 90 },
        ],
      },
    ]);
    const result = transposeNotesInProject(project, 'frac', ['f1'], { semitones: -1 });
    expect(result.ok ? '' : result.reason).toContain('目盛り');
  });

  it('3b: refuses a transpose whose absolute ticks overlap even when clip-local ticks only touch', () => {
    const t = 1 / PPQ;
    const project = melodyClips(song(), (trackId) => [
      {
        id: 'mel', trackId, type: 'midi', startBeat: 0, lengthBeats: 4, loop: false,
        notes: [
          { id: 'f0', pitch: 60, startBeat: 0, durationBeats: 1.6 * t, velocity: 90 },
          { id: 'f1', pitch: 61, startBeat: 1.4 * t, durationBeats: t, velocity: 90 },
        ],
      },
    ]);
    const result = transposeNotesInProject(project, 'mel', ['f1'], { semitones: -1 });
    expect(result.ok).toBe(false);
  });

  it('4: refuses a looped paste that would silence the chord backing', () => {
    const base: Project = {
      ...song(),
      chordTrack: [{ id: 'c1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7], function: 'T', degree: 'I' }],
    };
    const realized = realizeChordTrack(base)!;
    const project: Project = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === realized.track.id
        ? { ...t, clips: [{ id: 'bk', trackId: t.id, type: 'midi', startBeat: 0, lengthBeats: 4, loop: true, notes: [] }] }
        : t)),
    };
    expect(pasteNotesIntoProject(project, 'bk', board([one(70, 0)]), 0, nextId).ok).toBe(false);
    const nonLoop: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === 'bk' ? { ...c, loop: false } : c)) })),
    };
    const refused = pasteNotesIntoProject(nonLoop, 'bk', board([one(70, 0)]), 0, nextId);
    expect(refused.ok ? '' : refused.reason).toContain('鳴り方まで変わって');
  });

  it('5: an octave move is one call and one undo step', () => {
    useStore.setState({ project: { ...song(), id: useStore.getState().project.id }, past: [], future: [], audioRecordingOperationId: null, projectOperationBusy: false });
    expect(actions.transposeSelectedNotes('mel', ['n0'], { semitones: 12 }).ok).toBe(true);
    expect(pitches(useStore.getState().project, 'mel')[0]).toBe(72);
    expect(useStore.getState().past.length).toBe(1);
  });
});

describe('seeded fuzz across aliases, loops and clip starts (D1–D3)', () => {
  function scheduleCounts(project: Project): Map<string, number> {
    const counts = new Map<string, number>();
    for (const event of buildScheduleEvents(project)) {
      const p = event.payload as SchedulePayload;
      const key = p.kind === 'note'
        ? JSON.stringify([event.beat, p.trackId, p.preset, p.pitch, p.durationBeats, p.velocity])
        : JSON.stringify([event.beat, p]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }
  function occurrenceKeys(project: Project, ownerId: string, ids: ReadonlySet<string>): string[] {
    const keys: string[] = [];
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clipContentOwnerId(project, clip.id) !== ownerId) continue;
        const content = resolveClipContent(project, clip);
        if (!content?.notes?.length) continue;
        visitMidiClipNoteOccurrences(content, MAX_RUNTIME_SCHEDULE_EVENTS, (o) => {
          if (ids.has(o.note.id)) {
            keys.push(JSON.stringify([content.startBeat + o.localStartBeat, track.id, track.instrument?.preset ?? 'warmPad', o.note.pitch, o.durationBeats, o.note.velocity]));
          }
        });
      }
    }
    return keys;
  }
  function ownerNotes(project: Project, ownerId: string): Map<string, NoteEvent> {
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === ownerId);
      if (clip) return new Map((clip.notes ?? []).map((n) => [n.id, n]));
    }
    return new Map();
  }

  it('accepted edits export to MIDI and match the exact schedule multiset; refused edits change nothing', () => {
    let seed = 20261129;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const int = (n: number) => Math.floor(rnd() * n);
    let accepted = 0;
    let refused = 0;
    for (let round = 0; round < 400; round += 1) {
      const base = song([], { loop: false });
      const melTrack = base.tracks.find((t) => t.clips.some((c) => c.id === 'mel'))!;
      const clips: Clip[] = [];
      const clipCount = 1 + int(3);
      for (let c = 0; c < clipCount; c += 1) {
        const start = int(6) * 4 + (rnd() < 0.2 ? 0.3 / PPQ : rnd() < 0.3 ? int(4) / 4 : 0);
        const notes: NoteEvent[] = Array.from({ length: int(5) }, (_, i) => ({
          id: `c${c}n${i}`, pitch: 58 + int(8), startBeat: int(12) / 4, durationBeats: (1 + int(4)) / 4, velocity: 90,
        }));
        clips.push({ id: `c${c}`, trackId: melTrack.id, type: 'midi', startBeat: start, lengthBeats: 4, loop: rnd() < 0.35, notes });
      }
      if (rnd() < 0.4) {
        clips.push({ id: 'alias', trackId: melTrack.id, type: 'midi', startBeat: 24 + int(4) * 4, lengthBeats: 2 + int(3), loop: rnd() < 0.3, aliasOf: 'c0' });
      }
      const project: Project = {
        ...base,
        id: useStore.getState().project.id,
        tracks: base.tracks.map((t) => (t.id === melTrack.id ? { ...t, clips } : t)),
      };
      if (!projectToMidiResult(project).ok) continue;
      clipboardModule.setNoteClipboard(null);
      useStore.setState({ project, past: [], future: [], audioRecordingOperationId: null, projectOperationBusy: false });
      const before = useStore.getState().project;
      const targetId = clips[int(clips.length)]!.id;
      const ownerId = clipContentOwnerId(before, targetId)!;
      const ownerBefore = ownerNotes(before, ownerId);
      const selected = [...ownerBefore.keys()].filter(() => rnd() < 0.6);
      const op = int(5);
      let result: ReturnType<typeof actions.copySelectedNotes>;
      if (op === 0) result = actions.transposeSelectedNotes(targetId, selected, { semitones: [1, -1, 12, -12][int(4)]! });
      else if (op === 1) result = actions.transposeSelectedNotes(targetId, selected, { degrees: 1 + int(7) });
      else if (op === 2) result = actions.fitSelectedNotesToScale(targetId, selected);
      else if (op === 3) result = actions.cutSelectedNotes(targetId, selected);
      else {
        const source = clips[int(clips.length)]!;
        const sourceNotes = [...ownerNotes(before, clipContentOwnerId(before, source.id)!).keys()].filter(() => rnd() < 0.6);
        actions.copySelectedNotes(source.id, sourceNotes);
        useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: int(40) / 2 } }));
        result = actions.pasteClipboardNotes(targetId, rnd() < 0.5 ? 'auto' : 'original');
      }
      const after = useStore.getState().project;
      if (!result.ok || !result.changed) {
        refused += 1;
        expect(after).toBe(before);
        expect(useStore.getState().past.length).toBe(0);
        continue;
      }
      accepted += 1;
      expect(useStore.getState().past.length).toBe(1);
      const midi = projectToMidiResult(after);
      expect(midi.ok ? '' : midi.error.code).toBe('');
      const ownerAfter = ownerNotes(after, ownerId);
      const removedIds = new Set([...ownerBefore].filter(([id, n]) => JSON.stringify(ownerAfter.get(id)) !== JSON.stringify(n)).map(([id]) => id));
      const addedIds = new Set([...ownerAfter].filter(([id, n]) => JSON.stringify(ownerBefore.get(id)) !== JSON.stringify(n)).map(([id]) => id));
      const expected = scheduleCounts(before);
      for (const key of occurrenceKeys(before, ownerId, removedIds)) {
        const count = expected.get(key) ?? 0;
        expect(count).toBeGreaterThan(0);
        if (count === 1) expected.delete(key);
        else expected.set(key, count - 1);
      }
      for (const key of occurrenceKeys(after, ownerId, addedIds)) expected.set(key, (expected.get(key) ?? 0) + 1);
      expect(scheduleCounts(after)).toEqual(expected);
    }
    expect(accepted).toBeGreaterThan(60);
    expect(refused).toBeGreaterThan(20);
  });
});
