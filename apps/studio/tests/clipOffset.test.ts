// @vitest-environment jsdom
// Clip-relative beats: note startBeat counts from its clip's startBeat, so every
// lookup into the (absolute) chord track adds the clip start first.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChordEvent, Clip, Project, Track } from '@cts/project-model';
import { expandClip, resizeClip } from '@cts/project-model';
import { pitchClassOf } from '@cts/theory-engine';
import { installLocalStorage } from './localStorageStub';
import { pxPerBeat } from '../src/features/timeline';
import { clampNoteToClip } from '../src/features/pianoRoll/gridMath';
import { subscribeAppEvents } from '../src/state/appEvents';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');
let inspection: typeof import('../src/features/inspector/useInspection');
let scaleInfo: typeof import('../src/features/pianoRoll/useScaleInfo');
let coach: typeof import('../src/coach/mockCoach');
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];
let AssistantPanel: typeof import('../src/features/assistant/AssistantPanel')['AssistantPanel'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
  inspection = await import('../src/features/inspector/useInspection');
  scaleInfo = await import('../src/features/pianoRoll/useScaleInfo');
  coach = await import('../src/coach/mockCoach');
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
  ({ AssistantPanel } = await import('../src/features/assistant/AssistantPanel'));
});

beforeEach(() => {
  installLocalStorage();
  act(() => useStore.getState().createNewProject('テスト'));
});

afterEach(() => cleanup());

function chord(id: string, symbol: string, startBeat: number, durationBeats: number): ChordEvent {
  return { id, symbol, startBeat, durationBeats, root: symbol[0] ?? 'C', quality: '', notes: [] };
}

/** C for the first 4 bars, then F, G and Am (one bar each). */
const CHORDS = [chord('c1', 'C', 0, 16), chord('c2', 'F', 16, 4), chord('c3', 'G', 20, 4), chord('c4', 'Am', 24, 8)];

function trackNamed(project: Project, name: string): Track {
  const track = project.tracks.find((t) => t.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track;
}

/** Load the store's project with CHORDS and the named track's first clip moved to beat 16, 8 beats long. */
function withClipAt16(trackName: string, patch: Partial<Clip> = {}): Clip {
  const project = useStore.getState().project;
  const track = trackNamed(project, trackName);
  const clip: Clip = { ...track.clips[0]!, startBeat: 16, lengthBeats: 8, loop: false, notes: [], ...patch };
  act(() =>
    useStore.getState().replaceProject({
      ...project,
      chordTrack: CHORDS,
      tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clips: [clip] } : t)),
    }),
  );
  return clip;
}

function liveClip(clipId: string): Clip {
  const clip = useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  if (!clip) throw new Error(`no clip ${clipId}`);
  return clip;
}

describe('Theory Inspector note analysis', () => {
  it('looks up the chord at the absolute beat clip.startBeat + note.startBeat', () => {
    const note = { id: 'n', pitch: 69, startBeat: 0, durationBeats: 1, velocity: 100 };
    const chordAtBeat = scaleInfo.chordFinder(CHORDS);
    const inClipAt16 = inspection.buildNoteInspection(note, 16, 'C', 'major', chordAtBeat);
    expect(inClipAt16.currentChordSymbol).toBe('F');
    const inClipAt24 = inspection.buildNoteInspection(note, 24, 'C', 'major', chordAtBeat);
    expect(inClipAt24.currentChordSymbol).toBe('Am');
    expect(inClipAt24.degreeInChord).not.toBeNull(); // A is the root of Am
    expect(inspection.buildNoteInspection(note, 0, 'C', 'major', chordAtBeat).currentChordSymbol).toBe('C');
  });
});

describe('generation into a clip that starts at beat 16', () => {
  it('generateBassIntoClip uses only the chords inside the clip and writes clip-relative notes', () => {
    const clip = withClipAt16('Bass');
    actions.generateBassIntoClip(clip.id, 'rootOnly');
    const notes = liveClip(clip.id).notes ?? [];
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.startBeat).toBeGreaterThanOrEqual(0);
      expect(n.startBeat).toBeLessThan(8);
    }
    // F at clip beats 0-3, G at 4-7 (absolute 16-23); nothing from C or Am.
    expect(notes.filter((n) => n.startBeat < 4).map((n) => pitchClassOf(n.pitch))).toContain(5);
    expect(notes.filter((n) => n.startBeat >= 4).map((n) => pitchClassOf(n.pitch))).toContain(7);
    expect(new Set(notes.map((n) => pitchClassOf(n.pitch)))).toEqual(new Set([5, 7]));
    expect(liveClip(clip.id).lengthBeats).toBe(8);
  });

  it('generateMelodyIntoClip writes clip-relative notes inside the clip', () => {
    const clip = withClipAt16('Melody');
    actions.generateMelodyIntoClip(clip.id, 1);
    const notes = liveClip(clip.id).notes ?? [];
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.startBeat).toBeGreaterThanOrEqual(0);
      expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(8 + 1e-9);
    }
    expect(liveClip(clip.id).lengthBeats).toBe(8);
  });

  it('emphasizes the song’s strong beats while using clip-relative chords and notes', () => {
    const clip = withClipAt16('Melody', { startBeat: 17 });
    act(() => useStore.getState().applyProjectChange((p) => ({
      ...p, chordTrack: [chord('g', 'G', 20, 1)],
    })));
    const generated = actions.generateMelodyIntoClip(clip.id, 1);
    expect(generated.map((n) => [n.startBeat, n.velocity])).toEqual([[0, 84], [1, 96], [2, 84], [3, 96]]);
    expect([7, 11, 2]).toContain(pitchClassOf(generated[3]!.pitch));
    expect(generated[3]?.reason).toContain('Gのコードトーン');
    expect(liveClip(clip.id).notes?.map((n) => n.startBeat)).toEqual([0, 1, 2, 3]);
  });

  it('chordsToNotes voices only the chords inside the clip, at clip-relative beats', () => {
    const clip = withClipAt16('Chords');
    const trackId = clip.trackId;
    expect(actions.chordsToNotes(trackId, { style: 'close', voiceLeading: false }, () => true)).toBe(true);
    const notes = liveClip(clip.id).notes ?? [];
    expect([...new Set(notes.map((n) => n.startBeat))].sort((a, b) => a - b)).toEqual([0, 4]);
    expect(notes.every((n) => n.durationBeats === 4)).toBe(true);
    // F major (F A C) then G major (G B D).
    expect(new Set(notes.filter((n) => n.startBeat === 0).map((n) => pitchClassOf(n.pitch)))).toEqual(new Set([5, 9, 0]));
    expect(new Set(notes.filter((n) => n.startBeat === 4).map((n) => pitchClassOf(n.pitch)))).toEqual(new Set([7, 11, 2]));
  });

  it('generating into a link writes to the link source, from the chords at the link position', () => {
    const source = withClipAt16('Bass', {
      startBeat: 0,
      notes: [{ id: 'original', pitch: 36, startBeat: 1, durationBeats: 1, velocity: 90 }],
    });
    const linkClip: Clip = { ...source, id: 'bass-link', startBeat: 16, aliasOf: source.id, notes: undefined };
    const project = useStore.getState().project;
    act(() =>
      useStore.getState().replaceProject({
        ...project,
        tracks: project.tracks.map((t) => (t.id === source.trackId ? { ...t, clips: [source, linkClip] } : t)),
      }),
    );
    expect(actions.generateBassIntoClip('bass-link', 'rootOnly').length).toBeGreaterThan(0);
    expect(liveClip('bass-link').notes).toBeUndefined();
    const owned = liveClip(source.id).notes ?? [];
    // F then G: the chords at beats 16-23, not the C at the source's own position.
    expect(new Set(owned.map((n) => pitchClassOf(n.pitch)))).toEqual(new Set([5, 7]));
    const all = useStore.getState().project.tracks.flatMap((t) => t.clips);
    const sounded = expandClip(liveClip('bass-link'), all).notes;
    expect(sounded.length).toBe(owned.length);
    expect(pitchClassOf(sounded.find((n) => n.startBeat === 16)!.pitch)).toBe(5);

    expect(useStore.getState().past).toHaveLength(1);
    act(() => useStore.getState().undo());
    expect(liveClip(source.id)).toEqual(source);
    expect(liveClip('bass-link')).toEqual(linkClip);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('preserves a loop when bass generation would put its only note in a later repeat', () => {
    const clip = withClipAt16('Bass', {
      loop: true,
      contentLengthBeats: 4,
      notes: [{ id: 'original', pitch: 36, startBeat: 0, durationBeats: 1, velocity: 90 }],
    });
    const project = useStore.getState().project;
    act(() => useStore.getState().replaceProject({ ...project, chordTrack: [chord('later', 'F', 20, 4)] }));
    const before = useStore.getState().project;
    const events: unknown[] = [];
    const unsubscribe = subscribeAppEvents((e) => events.push(e));
    try {
      expect(actions.generateBassIntoClip(clip.id, 'rootOnly')).toEqual([]);
    } finally {
      unsubscribe();
    }
    expect(useStore.getState().project).toBe(before);
    expect(events).toEqual([]);

    render(createElement(AssistantPanel));
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(screen.getByRole('status').textContent).toContain('繰り返し');
    expect(liveClip(clip.id)).toEqual(clip);
  });

  it('reports the event cap to the user without displaying or emitting rejected notes', () => {
    const source = withClipAt16('Bass', {
      startBeat: 0,
      notes: [{ id: 'original', pitch: 36, startBeat: 0, durationBeats: 1 / 480, velocity: 90 }],
    });
    const link: Clip = {
      ...source, id: 'cap-link', aliasOf: source.id, startBeat: 8, lengthBeats: 248,
      loop: true, contentLengthBeats: 1 / 64, notes: undefined,
    };
    const project = useStore.getState().project;
    act(() => useStore.getState().replaceProject({
      ...project,
      lengthBars: 64,
      chordTrack: Array.from({ length: 7 }, (_, i) => chord(`tiny-${i}`, 'F', i / 480, 1 / 480)),
      tracks: project.tracks.map((t) => t.id === source.trackId ? { ...t, clips: [source, link] } : t),
    }));
    const before = useStore.getState().project;
    const events: unknown[] = [];
    const unsubscribe = subscribeAppEvents((e) => events.push(e));
    try {
      render(createElement(AssistantPanel));
      fireEvent.click(screen.getByRole('button', { name: '生成' }));
      expect(events).toEqual([]);
      expect(screen.getByRole('status').textContent).toContain('上限');
      expect(document.querySelector('.assistant__reasons')).toBeNull();
      expect(actions.generateBassIntoClip(source.id, 'rootOnly')).toEqual([]);
    } finally {
      unsubscribe();
    }
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('offers link repair guidance when the generation target has a broken link', () => {
    withClipAt16('Melody', { aliasOf: 'missing' });
    render(createElement(AssistantPanel));
    fireEvent.click(screen.getByRole('button', { name: 'スケールメロディを生成' }));
    expect(screen.getByRole('status').textContent).toContain('リンク元');
  });

  it('a clip with no chords inside keeps its notes, and nothing is announced', () => {
    const existing = [{ id: 'b1', pitch: 40, startBeat: 0, durationBeats: 1, velocity: 90 }];
    const clip = withClipAt16('Bass', { notes: existing });
    const project = useStore.getState().project;
    act(() => useStore.getState().replaceProject({ ...project, chordTrack: [chord('c1', 'C', 0, 8)] }));
    const before = useStore.getState().project;
    const events: unknown[] = [];
    const unsubscribe = subscribeAppEvents((e) => events.push(e));
    try {
      expect(actions.generateBassIntoClip(clip.id, 'rootOnly')).toEqual([]);
      expect(actions.generateMelodyIntoClip(clip.id, 1)).toEqual([]);
    } finally {
      unsubscribe();
    }
    expect(useStore.getState().project).toBe(before);
    expect(liveClip(clip.id).notes).toEqual(existing);
    expect(events).toEqual([]);
  });

  it('a melody for a 3.5-beat clip is cut at 3.5 beats and the clip keeps its length', () => {
    const clip = withClipAt16('Melody', { lengthBeats: 3.5 });
    for (const seed of [1, 2, 3]) {
      const generated = actions.generateMelodyIntoClip(clip.id, seed);
      expect(generated.length).toBeGreaterThan(0);
      expect(liveClip(clip.id).lengthBeats).toBe(3.5);
      for (const n of liveClip(clip.id).notes ?? []) {
        expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(3.5 + 1e-9);
      }
    }
  });

  it('clipChordInputs returns the chords inside the clip shifted to clip-relative beats', () => {
    const clip = withClipAt16('Bass');
    expect(actions.clipChordInputs(useStore.getState().project, clip)).toEqual([
      { symbol: 'F', startBeat: 0, durationBeats: 4 },
      { symbol: 'G', startBeat: 4, durationBeats: 4 },
    ]);
  });
});

describe('boundary clips never crash the clip-relative paths', () => {
  const cases: Array<[string, Partial<Clip>]> = [
    ['fractional start', { startBeat: 16.37, lengthBeats: 7.25 }],
    ['crossing the song end', { startBeat: 30, lengthBeats: 20 }],
    ['loop period that does not divide the length', { loop: true, contentLengthBeats: 3, lengthBeats: 8 }],
    ['circular link', { aliasOf: 'self-loop' }],
    ['dangling link', { aliasOf: 'missing' }],
  ];
  for (const [name, patch] of cases) {
    it(`${name}: generation and the piano roll do not throw`, () => {
      const clip = withClipAt16('Melody', { ...patch, ...(patch.aliasOf === 'self-loop' ? { aliasOf: undefined } : {}) });
      if (patch.aliasOf === 'self-loop') {
        act(() => useStore.getState().applyProjectChange((p) => ({
          ...p,
          tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, aliasOf: c.id } : c)) })),
        })));
      }
      expect(() => actions.generateMelodyIntoClip(clip.id, 1)).not.toThrow();
      expect(() => actions.generateBassIntoClip(clip.id, 'rootOnly')).not.toThrow();
      act(() => {
        useStore.getState().selectTrack(clip.trackId);
        useStore.getState().selectClip(clip.id);
      });
      expect(() => render(createElement(PianoRoll))).not.toThrow();
    });
  }

  it('a muted track still generates and renders', () => {
    const clip = withClipAt16('Bass');
    act(() => useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === clip.trackId ? { ...t, mute: true } : t)),
    })));
    expect(() => actions.generateBassIntoClip(clip.id, 'rootOnly')).not.toThrow();
    expect((liveClip(clip.id).notes ?? []).length).toBeGreaterThan(0);
  });
});

describe('MockCoach melody input', () => {
  it('uses the same absolute beats as the chord track', () => {
    withClipAt16('Melody', {
      notes: [
        { id: 'm1', pitch: 65, startBeat: 0, durationBeats: 1, velocity: 90 },
        { id: 'm2', pitch: 67, startBeat: 4, durationBeats: 1, velocity: 90 },
      ],
    });
    const notes = coach.melodyNotesFrom(useStore.getState().project);
    expect(notes.map((n) => n.startBeat)).toEqual([16, 20]);
    // The beats line up with the chords sounding there (F, then G).
    const chordAtBeat = scaleInfo.chordFinder(CHORDS);
    expect(notes.map((n) => chordAtBeat(n.startBeat)?.symbol)).toEqual(['F', 'G']);
  });
});

describe('PianoRoll edit range', () => {
  it('ignores clicks at and beyond the song end and fits the final in-song note', () => {
    const clip = withClipAt16('Melody');
    act(() => useStore.getState().selectClip(clip.id));
    render(createElement(PianoRoll));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const grid = document.querySelector<HTMLElement>('.pr__grid')!;
    const ruler = screen.getByTestId('timeline-ruler');
    const clientY = (108 - 60) * 16 + 1;
    const extend = 'クリップをここまで伸ばす';

    for (const beat of [16, 17]) fireEvent.doubleClick(grid, { clientX: beat * ppb, clientY });
    expect(screen.queryByRole('button', { name: extend })).toBeNull();
    expect(liveClip(clip.id)).toMatchObject({ lengthBeats: 8, notes: [] });
    expect(grid.style.width).toBe(ruler.style.width);
    expect(grid.style.width).toBe(`${16 * ppb}px`);

    fireEvent.doubleClick(grid, { clientX: 15.9 * ppb, clientY });
    fireEvent.click(screen.getByRole('button', { name: extend }));
    expect(liveClip(clip.id).lengthBeats).toBe(16);
    fireEvent.doubleClick(grid, { clientX: 15.9 * ppb, clientY });
    fireEvent.doubleClick(grid, { clientX: 16 * ppb, clientY });
    expect(liveClip(clip.id).notes).toMatchObject([{ startBeat: 15, durationBeats: 1 }]);
    expect(screen.queryByRole('button', { name: extend })).toBeNull();
  });

  it.each([17, 17.5])('aligns the grid bar lines with the ruler at clip start %s', (startBeat) => {
    const clip = withClipAt16('Melody', { startBeat });
    act(() => useStore.getState().selectClip(clip.id));
    render(createElement(PianoRoll));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const left = `${(20 - startBeat) * ppb}px`;
    expect(document.querySelector<HTMLElement>('.timeline-ruler__bar')?.style.left).toBe(left);
    expect(document.querySelector<HTMLElement>('.pr__gridline.is-bar')?.style.left).toBe(left);
  });

  it('opens a clip in a huge-time-signature song without building a grid of every beat', () => {
    const clip = withClipAt16('Melody', { startBeat: 0, lengthBeats: 4 });
    act(() => {
      useStore.getState().replaceProject({ ...useStore.getState().project, timeSignature: [4294967296, 4], lengthBars: 1 });
      useStore.getState().selectClip(clip.id);
    });
    expect(() => render(createElement(PianoRoll))).not.toThrow();
    expect(document.querySelectorAll('[aria-disabled="true"]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.pr__gridline').length).toBeLessThan(5000);
  });

  it('hides a note past a shortened clip end and leaves it alone when adding in range', () => {
    const hiddenNote = { id: 'hidden-note', pitch: 60, startBeat: 6, durationBeats: 1, velocity: 100 };
    const clip = withClipAt16('Melody', { notes: [hiddenNote] });
    act(() => {
      useStore.getState().applyProjectChange((p) => resizeClip(p, clip.id, 4));
      useStore.getState().selectClip(clip.id);
      useStore.getState().selectNotes([hiddenNote.id]);
    });
    render(createElement(PianoRoll));
    expect(document.querySelector('.pr__note')).toBeNull();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(liveClip(clip.id).notes).toEqual([hiddenNote]);

    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const grid = document.querySelector('.pr__grid')!;
    const clientY = (108 - 60) * 16 + 1;
    fireEvent.doubleClick(grid, { clientX: ppb, clientY });
    expect(liveClip(clip.id).notes).toHaveLength(2);
    expect(liveClip(clip.id).notes).toContainEqual(hiddenNote);
    expect(liveClip(clip.id).lengthBeats).toBe(4);

    fireEvent.doubleClick(grid, { clientX: 6 * ppb, clientY });
    fireEvent.click(screen.getByRole('button', { name: 'クリップをここまで伸ばす' }));
    expect(document.querySelectorAll('.pr__note')).toHaveLength(2);
    expect(liveClip(clip.id).notes).toContainEqual(hiddenNote);
  });

  it('marks cells past the clip length as not editable and offers to lengthen the clip', () => {
    const clip = withClipAt16('Melody');
    act(() => useStore.getState().selectClip(clip.id));
    render(createElement(PianoRoll));
    const outside = document.querySelectorAll('.pr__outside[aria-disabled="true"]');
    const songBeats = useStore.getState().project.lengthBars * 4 - clip.startBeat;
    expect(outside.length).toBe(songBeats - 8);
    expect(document.querySelectorAll('.pr__outside[aria-disabled="true"]')[0]!.getAttribute('style')).toContain(
      `left: ${8 * pxPerBeat(useStore.getState().editor.zoomX)}px`,
    );

    // Double-clicking outside the clip places nothing and explains how to extend it.
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    fireEvent.doubleClick(document.querySelector('.pr__grid')!, { clientX: 9.5 * ppb, clientY: (108 - 60) * 16 + 1 });
    expect(liveClip(clip.id).notes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'クリップをここまで伸ばす' }));
    // Extended to the end of the bar that holds the clicked beat (clip beat 9 → bar 3 ends at 12).
    expect(liveClip(clip.id).lengthBeats).toBe(12);
    expect(document.querySelectorAll('.pr__outside[aria-disabled="true"]').length).toBe(songBeats - 12);
  });

  it('offers to extend to the end of the song bar for a clip that starts mid-bar', () => {
    const clip = withClipAt16('Melody', { startBeat: 17 });
    act(() => useStore.getState().selectClip(clip.id));
    render(createElement(PianoRoll));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    // Clip beat 8.1 is song beat 25.1, in the bar that ends at song beat 28.
    fireEvent.doubleClick(document.querySelector('.pr__grid')!, { clientX: 8.1 * ppb, clientY: (108 - 60) * 16 + 1 });
    fireEvent.click(screen.getByRole('button', { name: 'クリップをここまで伸ばす' }));
    expect(liveClip(clip.id).lengthBeats).toBe(11);
  });

  it('Q keeps a note inside the clip: it goes to the last grid line where it fits, the clip keeps its length', () => {
    const clip = withClipAt16('Melody', {
      lengthBeats: 4,
      notes: [{ id: 'edge', pitch: 60, startBeat: 3.75, durationBeats: 0.25, velocity: 100 }],
    });
    act(() => {
      useStore.getState().selectClip(clip.id);
      useStore.getState().selectNotes(['edge']);
    });
    render(createElement(PianoRoll));
    fireEvent.keyDown(window, { key: 'q' });
    expect(liveClip(clip.id).notes![0]).toMatchObject({ startBeat: 3, durationBeats: 0.25 });
    expect(liveClip(clip.id).lengthBeats).toBe(4);
  });

  it('a double-click that snaps onto the clip end places the note inside the clip', () => {
    const clip = withClipAt16('Melody', { lengthBeats: 4 });
    act(() => useStore.getState().selectClip(clip.id));
    render(createElement(PianoRoll));
    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    // 3.9 rounds to the 1-beat grid line at 4, the clip end.
    fireEvent.doubleClick(document.querySelector('.pr__grid')!, { clientX: 3.9 * ppb, clientY: (108 - 60) * 16 + 1 });
    expect(liveClip(clip.id).notes).toHaveLength(1);
    expect(liveClip(clip.id).notes![0]).toMatchObject({ startBeat: 3, durationBeats: 1 });
    expect(liveClip(clip.id).lengthBeats).toBe(4);
  });
});

describe('clampNoteToClip (the piano roll edit range shared by snap, drag, resize and quantize)', () => {
  it('a moved or quantized note keeps its length and stops at the last grid line where it fits', () => {
    expect(clampNoteToClip({ startBeat: 4, durationBeats: 0.25 }, 4, { snap: 1, keep: 'length' })).toEqual({ startBeat: 3, durationBeats: 0.25 });
    expect(clampNoteToClip({ startBeat: 3.6, durationBeats: 1 }, 4, { snap: 0, keep: 'length' })).toEqual({ startBeat: 3, durationBeats: 1 });
    expect(clampNoteToClip({ startBeat: 1, durationBeats: 1 }, 4, { snap: 1, keep: 'length' })).toEqual({ startBeat: 1, durationBeats: 1 });
    expect(clampNoteToClip({ startBeat: 2, durationBeats: 6 }, 4, { snap: 1, keep: 'length' })).toEqual({ startBeat: 0, durationBeats: 4 });
  });

  it('a placed or resized note keeps its start and is cut at the clip end', () => {
    expect(clampNoteToClip({ startBeat: 3, durationBeats: 2 }, 4, { snap: 1, keep: 'start' })).toEqual({ startBeat: 3, durationBeats: 1 });
    expect(clampNoteToClip({ startBeat: 4, durationBeats: 1 }, 4, { snap: 1, keep: 'start' })).toEqual({ startBeat: 3, durationBeats: 1 });
    expect(clampNoteToClip({ startBeat: 3.5, durationBeats: 1 }, 3.5, { snap: 1, keep: 'start' })).toEqual({ startBeat: 3, durationBeats: 0.5 });
    expect(clampNoteToClip({ startBeat: 1, durationBeats: 1 }, 4, { snap: 1, keep: 'start' })).toEqual({ startBeat: 1, durationBeats: 1 });
  });
});
