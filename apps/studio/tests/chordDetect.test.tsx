// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let ChordLane: typeof import('../src/features/chordTrack/ChordLane')['ChordLane'];
let actions: typeof import('../src/state/chordDetectActions');
let buildScheduleEvents: typeof import('../src/audio/events')['buildScheduleEvents'];

function installSerialLocks(): void {
  let tail: Promise<unknown> = Promise.resolve();
  const locks = {
    request<T>(_name: string, _options: unknown, callback: () => Promise<T> | T): Promise<T> {
      const run = tail.then(() => callback());
      tail = run.catch(() => undefined);
      return run;
    },
  };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

beforeAll(async () => {
  installSerialLocks();
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ ChordLane } = await import('../src/features/chordTrack/ChordLane'));
  actions = await import('../src/state/chordDetectActions');
  ({ buildScheduleEvents } = await import('../src/audio/events'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
  expect(await useStore.getState().createNewProject('コード検出')).toBe(true);
});

afterEach(async () => {
  cleanup();
  await useStore.getState().flushPendingSave();
});

/** Melody クリップの音を差し替え、ピアノロールに出す。 */
function setNotes(pitches: number[][]): string {
  const state = useStore.getState();
  const clip = state.project.tracks.find((track) => track.name === 'Melody')!.clips[0]!;
  act(() => {
    state.applyProjectChange((project) => ({
      ...project,
      chordTrack: [],
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((item) => item.id !== clip.id ? item : {
          ...item,
          notes: pitches.flatMap((bar, barIndex) => bar.map((pitch, i) => ({
            id: `n-${barIndex}-${i}`,
            pitch,
            startBeat: barIndex * 4,
            durationBeats: 4,
            velocity: 90,
          }))),
        }),
      })),
    }));
    state.selectClip(clip.id);
    state.setActiveView('pianoRoll');
  });
  return clip.id;
}

const currentClip = () => {
  const state = useStore.getState();
  return state.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'midi' && c.notes?.some((n) => n.id === 'n-0-0')) ?? null;
};

describe('suggestChordsForRange', () => {
  it('ranks at most 3 candidates with beginner reasons, by pitch class (octave-free)', () => {
    setNotes([[48, 64, 79]]); // C3 E4 G5
    const { project } = useStore.getState();
    const result = actions.suggestChordsForRange(project, currentClip(), [], { startBar: 0, endBar: 1 });
    expect(result.suggestions.length).toBeLessThanOrEqual(3);
    expect(result.suggestions[0]!.symbol).toBe('C');
    expect(result.suggestions[0]!.reason).toContain('C・E・G が入っているので C(ドミソ)');
  });

  it('presents inversions and slash chords as possibilities', () => {
    setNotes([[52, 60, 67]]); // E3 C4 G4 -> C/E
    const { project } = useStore.getState();
    const result = actions.suggestChordsForRange(project, currentClip(), [], { startBar: 0, endBar: 1 });
    const inversion = result.suggestions.find((s) => s.symbol === 'C/E');
    expect(inversion?.reason).toContain('第1転回形');
    expect(inversion?.reason).toContain('かもしれません');
  });

  it('says kindly when no chord is recognisable, and for a single pitch class', () => {
    setNotes([[60, 61, 62, 63, 64, 65]]);
    const { project } = useStore.getState();
    const clip = currentClip();
    const many = actions.suggestChordsForRange(project, clip, [], { startBar: 0, endBar: 1 });
    expect(many.suggestions).toHaveLength(0);
    expect(many.emptyMessage).toContain('はっきりしたコードになっていません(経過音かもしれません)');
    const one = actions.suggestChordsForRange(project, clip, ['n-0-0'], { startBar: 0, endBar: 1 });
    expect(one.emptyMessage).toContain('コードは決められません');
    const none = actions.suggestChordsForRange(project, clip, [], { startBar: 3, endBar: 4 });
    expect(none.emptyMessage).toContain('音がありません');
  });

  it('uses only the selected notes when some are selected', () => {
    setNotes([[60, 64, 67, 70]]);
    const { project } = useStore.getState();
    const result = actions.suggestChordsForRange(project, currentClip(), ['n-0-0', 'n-0-1', 'n-0-2'], { startBar: 0, endBar: 1 });
    expect(result.suggestions[0]!.symbol).toBe('C');
    expect(result.suggestions[0]!.reason).not.toContain('ほかに');
  });
});

/** 全クリップの音を消し、指定のトラック名へ clip 群を置く。 */
function arrange(
  clipsByTrack: Record<string, Array<Record<string, unknown>>>,
  patch: Record<string, unknown> = {},
): void {
  act(() => {
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      ...patch,
      chordTrack: [],
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: clipsByTrack[track.name]
          ? clipsByTrack[track.name]!.map((c, i) => ({
            type: 'midi', trackId: track.id, loop: false, ...c, id: (c.id as string | undefined) ?? `${track.name}-c${i}`,
          }))
          : track.clips.map((clip) => (clip.type === 'midi' ? { ...clip, notes: [] } : { ...clip, drumEvents: [] })),
      })) as never,
    }));
  });
}
const triad = (pitches: number[], startBeat: number, durationBeats: number, prefix = 'x') =>
  pitches.map((pitch, i) => ({ id: `${prefix}${i}`, pitch, startBeat, durationBeats, velocity: 90 }));

describe('bar-range mode follows what sounds (buildScheduleEvents)', () => {
  it('1: a bass in another audible clip makes C/E the first candidate', () => {
    arrange({
      Melody: [{ startBeat: 0, lengthBeats: 4, notes: triad([60, 64, 67], 0, 4, 'm') }],
      Bass: [{ startBeat: 0, lengthBeats: 4, notes: triad([52], 0, 4, 'b') }],
    });
    const { project } = useStore.getState();
    const result = actions.suggestChordsForRange(project, null, [], { startBar: 0, endBar: 1 });
    expect(result.suggestions[0]!.symbol).toBe('C/E');
  });

  it('2: loop repeats are heard in later bars', () => {
    arrange({ Melody: [{ startBeat: 4, lengthBeats: 8, loop: true, notes: triad([60, 64, 67], 0, 1, 'l') }] });
    const { project } = useStore.getState();
    const result = actions.suggestChordsForRange(project, null, [], { startBar: 2, endBar: 3 });
    expect(result.suggestions[0]?.symbol).toBe('C');
  });

  it('3: a linked copy is heard at its own position', () => {
    arrange({
      Melody: [
        { id: 'orig', startBeat: 0, lengthBeats: 4, notes: triad([60, 64, 67], 0, 2, 'o') },
        { id: 'copy', startBeat: 4, lengthBeats: 4, aliasOf: 'orig' },
      ],
    });
    const { project } = useStore.getState();
    const copy = project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'copy')!;
    const result = actions.suggestChordsForRange(project, copy, [], { startBar: 1, endBar: 2 });
    expect(result.suggestions[0]?.symbol).toBe('C');
  });

  it('4: a swung note that sounds past the bar edge counts in the next bar', () => {
    arrange(
      { Melody: [{ startBeat: 0, lengthBeats: 8, notes: triad([60, 64, 67], 3.75, 0.25, 's') }] },
      { swing: 60 },
    );
    const { project } = useStore.getState();
    const events = buildScheduleEvents(project).filter((e) => (e.payload as { kind: string }).kind === 'note');
    const first = events[0]!;
    expect(first.beat + (first.payload as { durationBeats: number }).durationBeats).toBeGreaterThan(4);
    const result = actions.suggestChordsForRange(project, null, [], { startBar: 1, endBar: 2 });
    expect(result.suggestions[0]?.symbol).toBe('C');
  });
});

describe('adding a slash candidate keeps playback equal to its label', () => {
  it('5: the chord model has no bass, so a slash candidate is added as the plain chord and says so', () => {
    arrange({ Melody: [{ startBeat: 0, lengthBeats: 4, notes: triad([50, 60, 64, 67], 0, 4, 'd') }] });
    const { project } = useStore.getState();
    const result = actions.suggestChordsForRange(project, null, [], { startBar: 0, endBar: 1 });
    const slash = result.suggestions.find((s) => s.symbol.includes('/'));
    expect(slash).toBeTruthy();
    const added = actions.addDetectedChord(slash!.symbol, { startBar: 0, endBar: 1 });
    expect(added.ok).toBe(true);
    const chord = useStore.getState().project.chordTrack[0]!;
    expect(chord.symbol).not.toContain('/');
    expect(added.ok && added.message).toContain("低音(D)はコードトラックでは鳴らせないので、C として追加します");
    // ラベルと再生が同じ: コードの構成音に D(2)は無く、C の三和音そのもの。
    expect([...chord.notes].sort((x, y) => x - y)).toEqual([0, 4, 7]);
    expect(chord.symbol).toBe('C');
  });
});

describe('addDetectedChord', () => {
  it('adds one chord over the bar range in one undo step, clamped to the song length', () => {
    setNotes([[60, 64, 67]]);
    const before = useStore.getState().past.length;
    const lengthBars = useStore.getState().project.lengthBars;
    const result = actions.addDetectedChord('C', { startBar: 0, endBar: 999 });
    expect(result.ok).toBe(true);
    const state = useStore.getState();
    expect(state.past.length).toBe(before + 1);
    const chord = state.project.chordTrack[0]!;
    expect(chord.symbol).toBe('C');
    expect(chord.startBeat).toBe(0);
    expect(chord.durationBeats).toBe(state.project.lengthBeats);
    expect(lengthBars).toBeGreaterThan(0);
    expect(buildScheduleEvents(state.project).length).toBeGreaterThan(0);
    act(() => useStore.getState().undo());
    expect(useStore.getState().project.chordTrack).toHaveLength(0);
  });

  it('refuses while recording, when overlapping a chord, and for bad ranges', () => {
    setNotes([[60, 64, 67]]);
    useStore.setState({ audioRecordingOperationId: 1 });
    const recording = actions.addDetectedChord('C', { startBar: 0, endBar: 1 });
    expect(recording.ok).toBe(false);
    useStore.setState({ audioRecordingOperationId: null });
    expect(actions.addDetectedChord('C', { startBar: 0, endBar: 2 }).ok).toBe(true);
    const overlap = actions.addDetectedChord('F', { startBar: 1, endBar: 3 });
    expect(overlap.ok).toBe(false);
    expect(useStore.getState().project.chordTrack).toHaveLength(1);
    for (const range of [
      { startBar: -1, endBar: 1 }, { startBar: 2, endBar: 2 }, { startBar: 0.5, endBar: 1 },
      { startBar: Number.NaN, endBar: 1 }, { startBar: 0, endBar: Number.POSITIVE_INFINITY },
    ]) {
      expect(actions.addDetectedChord('G', range).ok).toBe(false);
    }
  });

  it('survives hostile symbols and values without throwing', () => {
    setNotes([[60, 64, 67]]);
    const hostile = { toString: null } as unknown as string;
    expect(() => actions.addDetectedChord(hostile, { startBar: 0, endBar: 1 })).not.toThrow();
  });
});

describe('seeded fuzz', () => {
  it('keeps suggestions and additions sane for random notes and ranges', () => {
    let seed = 20261130;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const state = useStore.getState();
    for (let round = 0; round < 60; round++) {
      const count = 1 + Math.floor(rnd() * 5);
      setNotes([Array.from({ length: count }, () => 36 + Math.floor(rnd() * 60)), Array.from({ length: count }, () => 36 + Math.floor(rnd() * 60))]);
      const { project } = useStore.getState();
      const range = { startBar: Math.floor(rnd() * 4) - 1, endBar: Math.floor(rnd() * 6) };
      const result = actions.suggestChordsForRange(project, currentClip(), [], range);
      expect(result.suggestions.length).toBeLessThanOrEqual(3);
      for (const s of result.suggestions) expect(s.reason).not.toMatch(/undefined|NaN/);
      const added = actions.addDetectedChord(result.suggestions[0]?.symbol ?? 'C', range);
      const after = useStore.getState().project;
      for (const chord of after.chordTrack) {
        expect(chord.startBeat).toBeGreaterThanOrEqual(0);
        expect(chord.startBeat + chord.durationBeats).toBeLessThanOrEqual(after.lengthBeats);
        expect(Number.isInteger(Math.round(chord.startBeat * 480))).toBe(true);
      }
      for (let i = 0; i < after.chordTrack.length; i++) {
        for (let j = i + 1; j < after.chordTrack.length; j++) {
          const a = after.chordTrack[i]!;
          const b = after.chordTrack[j]!;
          expect(a.startBeat < b.startBeat + b.durationBeats && b.startBeat < a.startBeat + a.durationBeats).toBe(false);
        }
      }
      expect(() => buildScheduleEvents(after)).not.toThrow();
      if (added.ok) expect(after.chordTrack.length).toBeGreaterThan(0);
    }
    expect(state).toBeTruthy();
  });
});

describe('ChordDetectPopover in the chord lane', () => {
  it('shows candidates for the selected notes and adds one chord in one undo step', () => {
    setNotes([[60, 64, 67]]);
    act(() => useStore.getState().selectNotes(['n-0-0', 'n-0-1', 'n-0-2']));
    render(<ChordLane />);
    fireEvent.click(screen.getByRole('button', { name: 'コードを調べる…' }));
    expect(screen.getByText(/選んだ 3 個の音だけで調べます/)).toBeTruthy();
    expect(screen.getByText(/C・E・G が入っているので C\(ドミソ\)/)).toBeTruthy();
    const before = useStore.getState().past.length;
    fireEvent.click(screen.getByRole('button', { name: 'C をコードトラックに足す' }));
    expect(useStore.getState().project.chordTrack.map((c) => c.symbol)).toEqual(['C']);
    expect(useStore.getState().past.length).toBe(before + 1);
    expect(screen.getByRole('status').textContent).toContain('コードトラックに足しました');
    // 同じ範囲にもう一度は足せない。
    fireEvent.click(screen.getByRole('button', { name: 'C をコードトラックに足す' }));
    expect(screen.getByRole('alert').textContent).toContain('もうコードがあります');
  });

  it('disables adding while recording', () => {
    setNotes([[60, 64, 67]]);
    render(<ChordLane />);
    fireEvent.click(screen.getByRole('button', { name: 'コードを調べる…' }));
    act(() => useStore.setState({ audioRecordingOperationId: 1 }));
    expect((screen.getByRole('button', { name: 'C をコードトラックに足す' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
