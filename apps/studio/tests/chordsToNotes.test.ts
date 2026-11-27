import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChordEvent, Clip, Project, Track } from '@cts/project-model';
import { createDefaultProject, createInstrumentTrack, deserializeProject, PPQ, serializeProject, soundingEvents, validateProject } from '@cts/project-model';
import * as theory from '@cts/theory-engine';
import { buildScheduleEvents, type NoteScheduleEvent } from '../src/audio/events';
import { renderScheduleEvents } from '../src/audio/wav';
import { getBridgeSnapshot } from '../src/state/tutorialBridge';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
});

beforeEach(() => {
  installLocalStorage();
});

function chord(id: string, symbol: string, startBeat: number, durationBeats: number): ChordEvent {
  return { id, symbol, startBeat, durationBeats, root: symbol[0] ?? 'C', quality: 'major', notes: [] };
}

/** 8 bars of 4/4 with C, Am, F, G (2 bars each) and a chords-role Piano track. */
function fourChordProject(clip?: Partial<Clip>): { project: Project; track: Track } {
  const project = createDefaultProject({ title: 'コード', lengthBars: 8 });
  const piano = project.tracks.find((t) => t.name === 'Piano') as Track;
  piano.role = 'chords';
  if (clip) Object.assign(piano.clips[0] as Clip, clip);
  project.chordTrack = [
    chord('c1', 'C', 0, 8),
    chord('c2', 'Am', 8, 8),
    chord('c3', 'F', 16, 8),
    chord('c4', 'G', 24, 8),
  ];
  return { project, track: piano };
}

/** Absolute beat -> sorted pitches of the target track's notes, as live playback and WAV schedule them. */
function soundingChords(project: Project, trackId: string): { live: Record<number, number[]>; wav: Record<number, number[]> } {
  const group = (events: { beat: number; payload: unknown }[]) => {
    const out: Record<number, number[]> = {};
    for (const e of events) {
      const p = e.payload as NoteScheduleEvent;
      if (p.kind !== 'note' || p.trackId !== trackId) continue;
      (out[e.beat] ??= []).push(p.pitch);
    }
    for (const k of Object.keys(out)) out[Number(k)]?.sort((a, b) => a - b);
    return out;
  };
  return { live: group(buildScheduleEvents(project)), wav: group(renderScheduleEvents(project)) };
}

function trackById(id: string): Track {
  return useStore.getState().project.tracks.find((t) => t.id === id) as Track;
}

describe('chordsToNotes', () => {
  it('writes notes at each chord position and length; one undo restores the clip', () => {
    const { project, track } = fourChordProject();
    useStore.getState().replaceProject(project);
    const before = structuredClone(useStore.getState().project);
    const confirm = vi.fn(() => true);

    const ok = actions.chordsToNotes(track.id, { style: 'close', voiceLeading: false }, confirm);
    expect(ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    const clip = trackById(track.id).clips[0] as Clip;
    const notes = clip.notes ?? [];
    const expected = [
      { symbol: 'C', start: 0 },
      { symbol: 'Am', start: 8 },
      { symbol: 'F', start: 16 },
      { symbol: 'G', start: 24 },
    ];
    expect(notes).toHaveLength(12);
    for (const { symbol, start } of expected) {
      const at = notes.filter((n) => n.startBeat === start);
      expect(at.map((n) => n.pitch).sort((a, b) => a - b)).toEqual(
        theory.voiceChord(symbol, { style: 'close', register: 60 }),
      );
      for (const n of at) expect(n.durationBeats).toBe(8);
    }

    useStore.getState().undo();
    expect(useStore.getState().project.tracks).toEqual(before.tracks);
  });

  it('voice leading follows the theory-engine voiceLead chain', () => {
    const { project, track } = fourChordProject();
    useStore.getState().replaceProject(project);
    actions.chordsToNotes(track.id, { style: 'close', voiceLeading: true }, () => true);
    const notes = (trackById(track.id).clips[0] as Clip).notes ?? [];
    const at = (start: number) =>
      notes.filter((n) => n.startBeat === start).map((n) => n.pitch).sort((a, b) => a - b);
    expect(at(0)).toEqual([60, 64, 67]);
    expect(at(8)).toEqual([60, 64, 69]);
    expect(at(16)).toEqual([60, 65, 69]);
    expect(at(24)).toEqual([59, 62, 67]);
  });

  it('asks before replacing existing notes and keeps them when declined', () => {
    const { project, track } = fourChordProject({
      notes: [{ id: 'n1', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 100 }],
    });
    useStore.getState().replaceProject(project);
    const confirm = vi.fn(() => false);

    const ok = actions.chordsToNotes(track.id, { style: 'close', voiceLeading: false }, confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain('置き換えます');
    expect(ok).toBe(false);
    expect((trackById(track.id).clips[0] as Clip).notes).toEqual([
      { id: 'n1', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 100 },
    ]);
    expect(useStore.getState().canUndo()).toBe(false);

    confirm.mockReturnValue(true);
    expect(actions.chordsToNotes(track.id, { style: 'close', voiceLeading: false }, confirm)).toBe(true);
    const notes = (trackById(track.id).clips[0] as Clip).notes ?? [];
    expect(notes.some((n) => n.id === 'n1')).toBe(false);
    expect(notes).toHaveLength(12);
  });

  it('a clip starting at beat 16 gets clip-relative notes; chords outside are dropped, overhangs are cut', () => {
    const { project, track } = fourChordProject({ startBeat: 16, lengthBeats: 12 });
    useStore.getState().replaceProject(project);
    actions.chordsToNotes(track.id, { style: 'close', voiceLeading: false }, () => true);
    const notes = (trackById(track.id).clips[0] as Clip).notes ?? [];
    // F (abs 16..24) -> clip beat 0, length 8. G (abs 24..32) is cut at the clip end (28).
    // C and Am lie before the clip and are not used.
    const starts = [...new Set(notes.map((n) => n.startBeat))].sort((a, b) => a - b);
    expect(starts).toEqual([0, 8]);
    const f = notes.filter((n) => n.startBeat === 0);
    expect(f.map((n) => n.pitch).sort((a, b) => a - b)).toEqual(theory.voiceChord('F', { register: 60 }));
    for (const n of f) expect(n.durationBeats).toBe(8);
    for (const n of notes.filter((x) => x.startBeat === 8)) expect(n.durationBeats).toBe(4);
    expect(notes).toHaveLength(6);
  });

  it('creates a clip spanning the whole song when the track has none', () => {
    const { project } = fourChordProject();
    const empty = createInstrumentTrack('Keys');
    project.tracks.push(empty);
    useStore.getState().replaceProject(project);
    actions.chordsToNotes(empty.id, { style: 'open', voiceLeading: false }, () => true);
    const clips = trackById(empty.id).clips;
    expect(clips).toHaveLength(1);
    const clip = clips[0] as Clip;
    expect(clip.type).toBe('midi');
    expect(clip.startBeat).toBe(0);
    expect(clip.lengthBeats).toBe(32);
    expect(clip.trackId).toBe(empty.id);
    expect(clip.notes).toHaveLength(12);
    useStore.getState().undo();
    expect(trackById(empty.id).clips).toHaveLength(0);
  });
});

describe('applyCompingToClip', () => {
  it.each(['clip', 'track'])('refuses a 2-million-beat clip before generation through the %s action', (action) => {
    const lengthBeats = 2e6;
    const { project, track } = fourChordProject({ startBeat: 0, lengthBeats });
    project.chordTrack = [chord('long', 'C', 0, lengthBeats)];
    expect(validateProject(project).valid).toBe(true);
    useStore.getState().replaceProject(project);
    const before = useStore.getState().project;
    const confirm = vi.fn(() => true);
    // Fail immediately on the old path instead of exhausting the test worker's heap.
    const generate = vi.spyOn(theory, 'compingPattern').mockImplementation(() => {
      throw new Error('Oversized clip reached compingPattern');
    });
    try {
      const applied = action === 'clip'
        ? actions.applyCompingToClip(track.clips[0]!.id, 'eighths', confirm)
        : actions.applyCompingToTrack(track.id, 'eighths');
      expect(applied).toBe(false);
      expect(generate).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(getBridgeSnapshot().toasts.at(-1)?.message).toContain('クリップの終わりが上限');
      expect(useStore.getState().project).toBe(before);
      expect(useStore.getState().canUndo()).toBe(false);
    } finally {
      generate.mockRestore();
    }
  });

  it('generates only the part of a chord that sounds before the song ends', () => {
    const { project, track } = fourChordProject({ startBeat: 28, lengthBeats: 12 });
    project.chordTrack = [chord('crosses-end', 'C', 30.25, 2e6), chord('after-end', 'F', 32, 1)];
    useStore.getState().replaceProject(project);

    expect(actions.applyCompingToClip(track.clips[0]!.id, 'eighths')).toBe(true);
    expect(trackById(track.id).clips[0]?.notes?.map(({ startBeat, durationBeats }) => [startBeat, durationBeats])).toEqual(
      [2.25, 2.75, 3.25, 3.75].flatMap((start) => Array.from({ length: 3 }, () => [start, Math.min(0.5, 4 - start)])),
    );
  });

  it('refuses before generation when the combined note count exceeds the limit', () => {
    const { project, track } = fourChordProject({ startBeat: 0, lengthBeats: 19200 });
    project.timeSignature = [300, 4];
    project.lengthBars = 64;
    project.chordTrack = [chord('first', 'C', 0, 9600), chord('second', 'C', 9600, 9600)];
    expect(validateProject(project).valid).toBe(true);
    useStore.getState().replaceProject(project);
    const before = useStore.getState().project;
    const generate = vi.spyOn(theory, 'compingPattern');
    try {
      expect(actions.applyCompingToClip(track.clips[0]!.id, 'eighths')).toBe(false);
      expect(generate).not.toHaveBeenCalled();
      expect(getBridgeSnapshot().toasts.at(-1)?.message).toContain('伴奏の音の数が上限');
      expect(useStore.getState().project).toBe(before);
      expect(useStore.getState().canUndo()).toBe(false);
    } finally {
      generate.mockRestore();
    }
  });

  it('clamps chords at both ends of a clip starting at beat 8 and undoes the edit in one step', () => {
    const { project, track } = fourChordProject({ startBeat: 0, lengthBeats: 4 });
    const target: Clip = { id: 'target', trackId: track.id, type: 'midi', startBeat: 8, lengthBeats: 9.25, loop: false };
    track.clips.push(target);
    track.mute = true;
    project.chordTrack = [
      chord('before', 'G', 0, 4),
      chord('left', 'C', 6, 3),
      chord('inside', 'Am', 10, 1),
      chord('right', 'F', 16, 2),
      chord('after', 'G', 17.25, 1),
    ];
    useStore.getState().replaceProject(project);
    const before = useStore.getState().project;
    const confirm = vi.fn(() => true);

    expect(actions.applyCompingToClip(target.id, 'eighths', confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    const [first, written] = trackById(track.id).clips;
    expect(first).toEqual(track.clips[0]);
    const notes = written?.notes ?? [];
    expect(notes.map((note) => [note.startBeat, note.durationBeats, note.pitch])).toEqual(
      ([
        [0, 0.5, [60, 64, 67]], [0.5, 0.5, [60, 64, 67]],
        [2, 0.5, [60, 64, 69]], [2.5, 0.5, [60, 64, 69]],
        [8, 0.5, [60, 65, 69]], [8.5, 0.5, [60, 65, 69]], [9, 0.25, [60, 65, 69]],
      ] as const).flatMap(([start, length, pitches]) => pitches.map((pitch) => [start, length, pitch])),
    );
    const { events } = soundingEvents(useStore.getState().project, { clipId: target.id, includeMuted: true });
    expect(events.map((event) => event.startBeat)).toEqual(notes.map((note) => note.startBeat + 8));

    expect(useStore.getState().past).toHaveLength(1);
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before);
    expect(useStore.getState().canUndo()).toBe(false);
  });

  it('confirms before replacing local notes, then restores them with Undo', () => {
    const { project, track } = fourChordProject({
      notes: [{ id: 'n1', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 100 }],
    });
    useStore.getState().replaceProject(project);
    const before = useStore.getState().project;
    const confirm = vi.fn((_message: string) => false);
    const clipId = track.clips[0]!.id;
    expect(actions.applyCompingToClip(clipId, 'arpUp', confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('1 個のノートを置き換えます'));
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().canUndo()).toBe(false);

    confirm.mockReturnValue(true);
    expect(actions.applyCompingToClip(clipId, 'arpUp', confirm)).toBe(true);
    expect(trackById(track.id).clips[0]?.notes?.find((note) => note.id === 'n1')).toBeUndefined();
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before);
  });

  it('preserves a one-tick chord after subtracting a fractional clip offset', () => {
    const { project, track } = fourChordProject({ startBeat: 0.1, lengthBeats: 0.3 });
    project.chordTrack = [chord('one-tick', 'C', 0.3, 1 / PPQ)];
    useStore.getState().replaceProject(project);

    expect(actions.applyCompingToClip(track.clips[0]!.id, 'arpUp')).toBe(true);
    expect(trackById(track.id).clips[0]?.notes).toEqual([
      expect.objectContaining({ startBeat: 0.2, durationBeats: 1 / PPQ, pitch: 60 }),
    ]);
  });

  it('detaches a looping linked clip after confirmation without changing its source', () => {
    const { project, track } = fourChordProject({
      startBeat: 16, lengthBeats: 4,
      notes: [{ id: 'source-note', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 100 }],
    });
    const source = track.clips[0]!;
    const target: Clip = {
      id: 'target', trackId: track.id, type: 'midi', startBeat: 8, lengthBeats: 8,
      loop: true, contentLengthBeats: 1, aliasOf: source.id,
    };
    track.clips.push(target);
    useStore.getState().replaceProject(project);
    const before = useStore.getState().project;
    const confirm = vi.fn((_message: string) => true);

    expect(actions.applyCompingToClip(target.id, 'stab', confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/リンク.*リンク元の 1 個のノート.*ループを止めます/));
    const [unchangedSource, written] = trackById(track.id).clips;
    expect(unchangedSource).toEqual(source);
    expect(written?.aliasOf).toBeUndefined();
    expect(written?.loop).toBe(false);
    expect(written?.notes).toHaveLength(24);
    expect(written?.notes?.at(-1)?.startBeat).toBe(7);

    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before);
  });

  it.each([0.1, 0.25])('refuses atomically if swing drops or truncates notes in a %s-beat clip', (lengthBeats) => {
    const { project, track } = fourChordProject({ startBeat: 0.25, lengthBeats });
    project.swing = 60;
    useStore.getState().replaceProject(project);
    const before = useStore.getState().project;

    expect(actions.applyCompingToClip(track.clips[0]!.id, 'whole')).toBe(false);
    expect(getBridgeSnapshot().toasts.at(-1)?.message).toContain('伴奏の音がクリップの範囲に収まらない');
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().canUndo()).toBe(false);
  });
});

describe('chordsToNotes review regressions', () => {
  it('reads chord names the popover accepts (Cadd9, C♯maj9) instead of skipping them', () => {
    const { project, track } = fourChordProject();
    project.chordTrack = [chord('a', 'Cadd9', 0, 4), chord('b', 'C♯maj9', 4, 4)];
    useStore.getState().replaceProject(project);
    expect(actions.chordsToNotes(track.id, { style: 'close', voiceLeading: false }, () => true)).toBe(true);
    const notes = (trackById(track.id).clips[0] as Clip).notes ?? [];
    expect(notes.filter((n) => n.startBeat === 0)).toHaveLength(4);
    expect(notes.filter((n) => n.startBeat === 4)).toHaveLength(5);
  });

  it('a linked clip becomes its own clip: live playback and WAV play the new notes, not the source', () => {
    const { project, track } = fourChordProject();
    const source = track.clips[0] as Clip;
    source.notes = [{ id: 'src', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 100 }];
    source.lengthBeats = 4;
    const linked: Clip = { id: 'link', trackId: track.id, type: 'midi', startBeat: 0, lengthBeats: 32, loop: false, aliasOf: source.id };
    track.clips = [linked, source];
    source.startBeat = 32;
    useStore.getState().replaceProject(project);
    const confirm = vi.fn(() => true);

    expect(actions.chordsToNotes(track.id, { style: 'close', voiceLeading: true }, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('リンク元の 1 個のノート'));
    const written = trackById(track.id).clips.find((c) => c.id === 'link') as Clip;
    expect(written.aliasOf).toBeUndefined();
    const { live, wav } = soundingChords(useStore.getState().project, track.id);
    for (const sounding of [live, wav]) {
      expect(sounding[0]).toEqual([60, 64, 67]);
      expect(sounding[8]).toEqual([60, 64, 69]);
      expect(sounding[16]).toEqual([60, 65, 69]);
      expect(sounding[24]).toEqual([59, 62, 67]);
    }
    useStore.getState().undo();
    expect((trackById(track.id).clips.find((c) => c.id === 'link') as Clip).aliasOf).toBe(source.id);
  });

  it('asks before replacing local notes in a link detached on load', () => {
    const { project, track } = fourChordProject();
    project.chordTrack = [chord('c', 'C', 0, 4)];
    const source = track.clips[0] as Clip;
    source.startBeat = 16;
    source.notes = [];
    const linked: Clip = {
      id: 'link',
      trackId: track.id,
      type: 'midi',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      aliasOf: source.id,
      notes: [{ id: 'local', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    track.clips = [linked, source];
    useStore.getState().replaceProject(deserializeProject(serializeProject(project)));
    const before = useStore.getState().project;
    const confirm = vi.fn((_message: string) => false);
    const opts = { style: 'close', voiceLeading: false } as const;

    const converted = actions.chordsToNotes(track.id, opts, confirm);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('このクリップに保存されている 1 個のノート'));
    expect(converted).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().canUndo()).toBe(false);

    confirm.mockReturnValue(true);
    expect(actions.chordsToNotes(track.id, opts, confirm)).toBe(true);
    expect(trackById(track.id).clips[0]?.aliasOf).toBeUndefined();
    expect(trackById(track.id).clips[0]?.notes?.map((note) => note.pitch)).toEqual([60, 64, 67]);
    expect(trackById(track.id).clips[1]).toEqual(source);
    useStore.getState().undo();
    const { aliasOf: _aliasOf, ...detached } = linked;
    expect(trackById(track.id).clips[0]).toEqual(detached);
  });

  it('leaves existing notes alone when a chord starts at the fractional clip end', () => {
    const { project, track } = fourChordProject({
      startBeat: 0.1,
      lengthBeats: 0.2,
      notes: [{ id: 'n1', pitch: 72, startBeat: 0, durationBeats: 0.1, velocity: 100 }],
    });
    project.chordTrack = [chord('c', 'C', 0.3, 1)];
    useStore.getState().replaceProject(deserializeProject(serializeProject(project)));
    const before = useStore.getState().project;
    const confirm = vi.fn(() => true);

    const converted = actions.chordsToNotes(track.id, { style: 'close', voiceLeading: false }, confirm);
    const sounding = { 0.1: [72] };
    expect(soundingChords(useStore.getState().project, track.id)).toEqual({ live: sounding, wav: sounding });
    expect(converted).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().canUndo()).toBe(false);
  });

  it('a looped clip stops looping in the same undo step, so F at beat 4 sounds', () => {
    const { project, track } = fourChordProject({ startBeat: 0, lengthBeats: 16, loop: true, contentLengthBeats: 4 });
    project.chordTrack = [chord('c', 'C', 0, 4), chord('f', 'F', 4, 4)];
    useStore.getState().replaceProject(project);
    expect(actions.chordsToNotes(track.id, { style: 'close', voiceLeading: false }, () => true)).toBe(true);
    expect((trackById(track.id).clips[0] as Clip).loop).toBe(false);
    const { live, wav } = soundingChords(useStore.getState().project, track.id);
    for (const sounding of [live, wav]) {
      expect(sounding[0]).toEqual([60, 64, 67]);
      expect(sounding[4]).toEqual([65, 69, 72]);
      expect(sounding[8]).toBeUndefined();
    }
    useStore.getState().undo();
    const restored = trackById(track.id).clips[0] as Clip;
    expect(restored.loop).toBe(true);
    expect(restored.notes ?? []).toHaveLength(0);
    expect(useStore.getState().canUndo()).toBe(false);
  });

  it('a chord crossing the clip start keeps only the part inside the clip', () => {
    // Clip 16..32, C at absolute 12..20: C sounds over 16..20, i.e. clip beats 0..4.
    const { project, track } = fourChordProject({ startBeat: 16, lengthBeats: 16 });
    project.chordTrack = [chord('c', 'C', 12, 8), chord('g', 'G', 20, 4)];
    useStore.getState().replaceProject(project);
    actions.chordsToNotes(track.id, { style: 'close', voiceLeading: false }, () => true);
    const notes = (trackById(track.id).clips[0] as Clip).notes ?? [];
    const c = notes.filter((n) => n.startBeat === 0);
    expect(c.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67]);
    for (const n of c) expect(n.durationBeats).toBe(4);
    const { live } = soundingChords(useStore.getState().project, track.id);
    expect(live[16]).toEqual([60, 64, 67]);
    expect(live[20]).toEqual([67, 71, 74]);
  });

  it('when no chord falls inside the clip, existing notes stay and nothing is asked', () => {
    const existingNote = { id: 'n1', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 100 };
    const { project, track } = fourChordProject({ startBeat: 16, lengthBeats: 16, notes: [existingNote] });
    project.chordTrack = [chord('c', 'C', 0, 4)];
    useStore.getState().replaceProject(project);
    const confirm = vi.fn(() => true);
    expect(actions.chordsToNotes(track.id, { style: 'close', voiceLeading: false }, confirm)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect((trackById(track.id).clips[0] as Clip).notes).toEqual([existingNote]);
    expect(useStore.getState().canUndo()).toBe(false);
  });

  it('does not create an empty clip when no chord can be voiced', () => {
    const { project } = fourChordProject();
    project.chordTrack = [chord('x', 'H7', 0, 4)];
    const empty = createInstrumentTrack('Keys');
    project.tracks.push(empty);
    useStore.getState().replaceProject(project);
    expect(actions.chordsToNotes(empty.id, { style: 'close', voiceLeading: false }, () => true)).toBe(false);
    expect(trackById(empty.id).clips).toHaveLength(0);
  });
});

describe('chordNotesTargetTrackId', () => {
  it('prefers the chords-role track, else the selected instrument track', () => {
    const { project, track } = fourChordProject();
    expect(actions.chordNotesTargetTrackId(project, null)).toBe(track.id);
    delete track.role;
    const drums = project.tracks.find((t) => t.type === 'drum') as Track;
    expect(actions.chordNotesTargetTrackId(project, track.id)).toBe(track.id);
    expect(actions.chordNotesTargetTrackId(project, drums.id)).toBeNull();
    expect(actions.chordNotesTargetTrackId(project, null)).toBeNull();
  });

  it('ignores a chords-role track that is not an instrument track (e.g. audio from a saved file)', () => {
    const { project, track } = fourChordProject();
    delete track.role;
    const drums = project.tracks.find((t) => t.type === 'drum') as Track;
    drums.role = 'chords';
    expect(actions.chordNotesTargetTrackId(project, null)).toBeNull();
    expect(actions.chordNotesTargetTrackId(project, track.id)).toBe(track.id);
  });
});
