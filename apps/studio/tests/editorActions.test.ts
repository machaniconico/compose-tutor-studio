import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';

// The store reads localStorage at module-import time, so install the stub
// BEFORE importing it (and editorActions, which imports the store).
let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
});

beforeEach(() => {
  installLocalStorage();
  useStore.getState().createNewProject('テスト');
});

function bassClipId(): string {
  const project = useStore.getState().project;
  const clip = actions.firstMidiClipOfTrack(project, 'Bass');
  return clip?.id ?? '';
}

function melodyClipId(): string {
  const project = useStore.getState().project;
  const clip = actions.firstMidiClipOfTrack(project, 'Melody');
  return clip?.id ?? '';
}

function chordsClipId(): string {
  const project = useStore.getState().project;
  const clip = actions.firstMidiClipOfTrack(project, 'Chords');
  return clip?.id ?? '';
}

describe('addChordWithAnalysis', () => {
  it('fills full analysis fields (root/quality/notes/degree/function)', () => {
    const before = useStore.getState().project.chordTrack.length;
    actions.addChordWithAnalysis('G', 0, 4); // V in C major
    const track = useStore.getState().project.chordTrack;
    expect(track.length).toBe(before + 1);
    const chord = track[track.length - 1];
    expect(chord?.symbol).toBe('G');
    expect(chord?.root).toBe('G');
    expect(chord?.quality).toBe('major');
    expect(chord?.notes).toEqual([7, 11, 2]); // G B D pitch classes
    expect(chord?.degree).toBe('V');
    expect(chord?.function).toBe('D');
  });

  it('tags a secondary dominant', () => {
    // E7 in C major resolves to Am (vi) -> secondary dominant
    actions.addChordWithAnalysis('E7', 0, 4);
    const track = useStore.getState().project.chordTrack;
    const chord = track[track.length - 1];
    expect(chord?.function).toBe('D');
    expect(chord?.tags ?? []).toContain('secondaryDominant');
  });
});

describe('updateChordSymbol', () => {
  it('re-derives analysis when the symbol changes', () => {
    const id = useStore.getState().project.chordTrack[0]?.id ?? '';
    actions.updateChordSymbol(id, 'Dm'); // ii in C major
    const chord = useStore.getState().project.chordTrack.find((c) => c.id === id);
    expect(chord?.symbol).toBe('Dm');
    expect(chord?.quality).toBe('minor');
    expect(chord?.degree).toBe('ii');
    expect(chord?.function).toBe('SD');
  });
});

describe('appendChordAfterLast', () => {
  it('places the chord right after the final chord', () => {
    const track = useStore.getState().project.chordTrack;
    const last = [...track].sort((a, b) => a.startBeat - b.startBeat).pop();
    const expectedStart = (last?.startBeat ?? 0) + (last?.durationBeats ?? 0);
    actions.appendChordAfterLast('F');
    const updated = useStore.getState().project.chordTrack;
    const appended = updated[updated.length - 1];
    expect(appended?.symbol).toBe('F');
    expect(appended?.startBeat).toBe(expectedStart);
  });
});

describe('applyProgressionTemplate', () => {
  it('replaces the whole chord track with one chord per bar', () => {
    actions.applyProgressionTemplate('I-V-vi-IV');
    const project = useStore.getState().project;
    expect(project.chordTrack.length).toBe(project.lengthBars);
    // I-V-vi-IV in C => C G Am F repeated
    const symbols = project.chordTrack.map((c) => c.symbol);
    expect(symbols.slice(0, 4)).toEqual(['C', 'G', 'Am', 'F']);
    // every chord has full analysis fields
    for (const c of project.chordTrack) {
      expect(c.notes.length).toBeGreaterThan(0);
      expect(c.degree).toBeDefined();
      expect(c.function).toBeDefined();
    }
  });
});

describe('replaceChordTrack', () => {
  it('replaces with the supplied chords', () => {
    const project = useStore.getState().project;
    const replacement = [actions.buildChordEvent(project, 'Am', 0, 4)];
    actions.replaceChordTrack(replacement);
    const track = useStore.getState().project.chordTrack;
    expect(track.length).toBe(1);
    expect(track[0]?.symbol).toBe('Am');
  });
});

describe('quantizeNotes', () => {
  it('snaps selected note starts to the grid', () => {
    const clipId = chordsClipId();
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 1.3, durationBeats: 1, velocity: 100 });
    const noteId = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0]?.id ?? '';
    actions.quantizeNotes(clipId, [noteId], 1);
    const note = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0];
    expect(note?.startBeat).toBe(1);
  });
});

describe('duplicateNotes', () => {
  it('creates offset copies and returns their ids', () => {
    const clipId = chordsClipId();
    useStore.getState().addNote(clipId, { pitch: 62, startBeat: 0, durationBeats: 1, velocity: 90 });
    const srcId = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0]?.id ?? '';
    const newIds = actions.duplicateNotes(clipId, [srcId], 4);
    expect(newIds.length).toBe(1);
    const notes = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes ?? [];
    expect(notes.length).toBe(2);
    const dupe = notes.find((n) => n.id === newIds[0]);
    expect(dupe?.startBeat).toBe(4);
    expect(dupe?.pitch).toBe(62);
  });
});

describe('setNoteVelocity', () => {
  it('clamps velocity into 1..127', () => {
    const clipId = chordsClipId();
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 });
    const id = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0]?.id ?? '';
    actions.setNoteVelocity(clipId, [id], 999);
    const note = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0];
    expect(note?.velocity).toBe(127);
  });
});

describe('generateBassIntoClip', () => {
  it('writes notes into the Bass clip with reasons', () => {
    const clipId = bassClipId();
    const reasons = actions.generateBassIntoClip(clipId, 'rootOnly');
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]?.reason).toBeTruthy();
    const notes = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes ?? [];
    expect(notes.length).toBe(reasons.length);
  });

  it('replaces (not appends) on a second generation', () => {
    const clipId = bassClipId();
    actions.generateBassIntoClip(clipId, 'rootOnly');
    const firstCount = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.length ?? 0;
    actions.generateBassIntoClip(clipId, 'rootOnly');
    const secondCount = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.length ?? 0;
    expect(secondCount).toBe(firstCount);
  });
});

describe('generateMelodyIntoClip', () => {
  it('writes notes into the Melody clip', () => {
    const clipId = melodyClipId();
    const notes = actions.generateMelodyIntoClip(clipId, 1);
    expect(notes.length).toBeGreaterThan(0);
    const written = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes ?? [];
    expect(written.length).toBe(notes.length);
  });

  it('varies deterministically with the seed', () => {
    const clipId = melodyClipId();
    const a = actions.generateMelodyIntoClip(clipId, 1).map((n) => n.pitch);
    const b = actions.generateMelodyIntoClip(clipId, 2).map((n) => n.pitch);
    // same seed reproduces, different seed differs somewhere
    const aAgain = actions.generateMelodyIntoClip(clipId, 1).map((n) => n.pitch);
    expect(aAgain).toEqual(a);
    expect(b).not.toEqual(a);
  });
});

describe('applyDrumPattern', () => {
  it('writes drum events tiled across the clip bars', () => {
    const drumClip = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0];
    const clipId = drumClip?.id ?? '';
    actions.applyDrumPattern(clipId, 'eightBeat');
    const events = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.lane === 'kick')).toBe(true);
    expect(events.some((e) => e.lane === 'snare')).toBe(true);
  });
});

describe('setDrumStepVelocity', () => {
  it('adds, updates, and removes a step', () => {
    const clipId = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0]?.id ?? '';
    actions.setDrumStepVelocity(clipId, 'kick', 0, 100);
    const drumEvents = () => useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [];
    expect(drumEvents().find((e) => e.lane === 'kick' && e.stepIndex === 0)?.velocity).toBe(100);
    actions.setDrumStepVelocity(clipId, 'kick', 0, 40);
    expect(drumEvents().find((e) => e.lane === 'kick' && e.stepIndex === 0)?.velocity).toBe(40);
    actions.setDrumStepVelocity(clipId, 'kick', 0, 0);
    expect(drumEvents().find((e) => e.lane === 'kick' && e.stepIndex === 0)).toBeUndefined();
  });
});
