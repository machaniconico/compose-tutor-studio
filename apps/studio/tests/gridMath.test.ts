import { describe, expect, it } from 'vitest';
import {
  snapBeat,
  floorToGrid,
  quantizeStart,
  quantizeNotes,
  xToBeat,
  beatToX,
  yToPitch,
  pitchToY,
  clampPitch,
  snapPitchToPitchClasses,
  rectsOverlap,
  normalizeRect,
  PIANO_HIGH_MIDI,
  PIANO_LOW_MIDI,
  FULL_PIANO_RANGE,
  midiToRow,
  rowToMidi,
  initialPitchWindow,
  pitchSpan,
  windowScrollTop,
  visibleRowRange,
  notesInRows,
  addGridSteps,
  GRID_SNAP_OPTIONS,
  GRID_SNAP_LABELS,
  ghostNotesFromEvents,
  visibleGhostNotes,
  soundingStartByNoteId,
  chordTickFinder,
  MAX_RENDERED_GHOSTS,
} from '../src/features/pianoRoll/gridMath';
import { soundingEvents } from '@cts/project-model';
import { createPrng } from '@cts/theory-engine';
import { chordFinder } from '../src/features/pianoRoll/useScaleInfo';
import { makeProject, makeTrack, midiClip, drumClip } from '../../../packages/project-model/tests/acceptance/helpers';

describe('notesInRows', () => {
  it('collects 150,000 notes in one visible row in order', () => {
    const notes = Array.from({ length: 150_000 }, (_, index) => ({
      id: `note-${index}`,
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 100,
    }));
    const otherNote = { ...notes[0]!, id: 'other', pitch: 59 };
    const notesByRow = new Map([[48, notes], [49, [otherNote]], [50, [otherNote]]]);
    const visible = notesInRows(notesByRow, 47, 49);

    expect(visible).toHaveLength(notes.length + 1);
    expect(visible.every((note, index) => note === (notes[index] ?? otherNote))).toBe(true);
  });
});

describe('snapBeat / quantizeStart', () => {
  it('snaps to the nearest grid line', () => {
    expect(snapBeat(0.6, 1)).toBe(1);
    expect(snapBeat(0.4, 1)).toBe(0);
    expect(snapBeat(1.3, 0.5)).toBe(1.5);
    expect(quantizeStart(2.2, 1)).toBe(2);
  });

  it('never returns negatives', () => {
    expect(snapBeat(-1, 1)).toBe(0);
  });

  it('passes through when snap is non-positive', () => {
    expect(snapBeat(3.7, 0)).toBe(3.7);
  });
});

describe('3 連符グリッド(US-015)', () => {
  it('1/3 拍と 1/6 拍のスナップを選べ、ラベルが付いている', () => {
    expect(GRID_SNAP_OPTIONS).toContain(1 / 3);
    expect(GRID_SNAP_OPTIONS).toContain(1 / 6);
    expect(GRID_SNAP_LABELS[1 / 3]).toMatch(/3連/);
    expect(GRID_SNAP_LABELS[1 / 6]).toMatch(/3連/);
    expect([...GRID_SNAP_OPTIONS]).toEqual([...GRID_SNAP_OPTIONS].sort((a, b) => a - b));
  });

  it('snap 1/3 で 0.3333 を 99 回足した値(32.9967)が round(beat*3)/3 で正確に 33 拍に戻る', () => {
    let beat = 0;
    for (let i = 0; i < 99; i += 1) beat += 0.3333;
    expect(beat).toBeCloseTo(32.9967, 10);
    expect(beat).not.toBe(33);
    expect(Math.round(beat * 3) / 3).toBe(33);
    expect(snapBeat(beat, 1 / 3)).toBe(33);
    expect(quantizeStart(beat, 1 / 3)).toBe(33);
  });

  it('1/3・1/6 のグリッドに沿った移動は誤差を積み残さない(3 歩で 1 拍、6 歩で 1 拍ちょうど)', () => {
    let third = 0;
    for (let i = 0; i < 99; i += 1) third = addGridSteps(third, 1 / 3, 1);
    expect(third).toBe(33);
    let sixth = 0;
    for (let i = 0; i < 6; i += 1) sixth = addGridSteps(sixth, 1 / 6, 1);
    expect(sixth).toBe(1);
    for (let i = 0; i < 6; i += 1) sixth = addGridSteps(sixth, 1 / 6, -1);
    expect(sixth).toBe(0);
    expect(addGridSteps(2 / 3, 1 / 3, 1)).toBe(1);
    expect(addGridSteps(1, 1 / 3, -3)).toBe(0);
  });

  it('グリッドから外れた音は外れたまま動く(1/1200 拍の端数を丸めない)', () => {
    expect(addGridSteps(1 / 1200, 1 / 3, 1)).toBe(1 / 1200 + 1 / 3);
    expect(addGridSteps(1 + 1 / 1200, 0.25, -1)).toBe(1 + 1 / 1200 - 0.25);
  });

  it('1/6 拍のスナップは最も近い 1/6 拍の線に寄せる(16 分 3 連)', () => {
    expect(snapBeat(0.17, 1 / 6)).toBe(1 / 6);
    expect(snapBeat(0.9, 1 / 6)).toBe(5 / 6);
    expect(snapBeat(3.3333, 1 / 3)).toBe(10 / 3);
    // 2 拍(半小節)など 1 拍より大きいスナップは従来どおり。
    expect(snapBeat(2.9, 2)).toBe(2);
    expect(snapBeat(3.1, 2)).toBe(4);
  });
});

describe('quantizeNotes', () => {
  it('quantizes note starts without changing other fields', () => {
    const notes = [
      { id: 'n1', startBeat: 0.49, pitch: 60, durationBeats: 0.5, velocity: 80 },
      { id: 'n2', startBeat: 1.26, pitch: 64, durationBeats: 1, velocity: 96 },
    ];

    expect(quantizeNotes(notes, 0.5)).toEqual([
      { id: 'n1', startBeat: 0.5, pitch: 60, durationBeats: 0.5, velocity: 80 },
      { id: 'n2', startBeat: 1.5, pitch: 64, durationBeats: 1, velocity: 96 },
    ]);
  });

  it('does not mutate the input notes', () => {
    const notes = [{ id: 'n1', startBeat: 0.74, pitch: 60 }];

    quantizeNotes(notes, 0.5);

    expect(notes).toEqual([{ id: 'n1', startBeat: 0.74, pitch: 60 }]);
  });
});

describe('floorToGrid', () => {
  it('floors to the grid line at or before', () => {
    expect(floorToGrid(1.9, 1)).toBe(1);
    expect(floorToGrid(1.4, 0.5)).toBe(1);
    expect(floorToGrid(0.9, 0.25)).toBe(0.75);
  });
});

describe('pixel <-> beat conversion round-trips', () => {
  it('xToBeat and beatToX are inverse', () => {
    expect(beatToX(4, 28)).toBe(112);
    expect(xToBeat(112, 28)).toBe(4);
  });

  it('xToBeat guards divide-by-zero', () => {
    expect(xToBeat(50, 0)).toBe(0);
  });
});

describe('pitch <-> y conversion', () => {
  it('top row is the highest pitch', () => {
    expect(yToPitch(0, 14)).toBe(PIANO_HIGH_MIDI);
    expect(pitchToY(PIANO_HIGH_MIDI, 14)).toBe(0);
  });

  it('descends one pitch per row', () => {
    expect(yToPitch(14, 14)).toBe(PIANO_HIGH_MIDI - 1);
    expect(pitchToY(PIANO_HIGH_MIDI - 2, 14)).toBe(28);
  });
});

describe('clampPitch', () => {
  it('clamps into the editable range', () => {
    expect(clampPitch(200)).toBe(PIANO_HIGH_MIDI);
    expect(clampPitch(0)).toBe(PIANO_LOW_MIDI);
    expect(clampPitch(60)).toBe(60);
  });
});

describe('snapPitchToPitchClasses', () => {
  const cMajor = new Set([0, 2, 4, 5, 7, 9, 11]); // C D E F G A B

  it('keeps an in-scale pitch unchanged', () => {
    expect(snapPitchToPitchClasses(60, cMajor)).toBe(60); // C4
    expect(snapPitchToPitchClasses(64, cMajor)).toBe(64); // E4
  });

  it('snaps an out-of-scale pitch to the nearest in-scale pitch', () => {
    // 61 = C#4 -> nearest in-scale is C4 (60) or D4 (62); search prefers +1 first => 62
    const snapped = snapPitchToPitchClasses(61, cMajor);
    expect([60, 62]).toContain(snapped);
    expect(cMajor.has(((snapped % 12) + 12) % 12)).toBe(true);
  });

  it('returns the pitch when the set is empty', () => {
    expect(snapPitchToPitchClasses(61, new Set())).toBe(61);
  });

  it('snaps inward at the top of the keyboard (B major at MIDI 108 gives 107, not 109)', () => {
    const bMajor = new Set([11, 1, 3, 4, 6, 8, 10]);
    expect(snapPitchToPitchClasses(108, bMajor)).toBe(109);
    expect(snapPitchToPitchClasses(108, bMajor, 21, 108)).toBe(107);
  });
});

describe('rect helpers (marquee)', () => {
  it('detects overlap', () => {
    expect(
      rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }),
    ).toBe(true);
    expect(
      rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }),
    ).toBe(false);
  });

  it('normalizes a backwards drag rectangle', () => {
    expect(normalizeRect(30, 40, 10, 20)).toEqual({ x: 10, y: 20, w: 20, h: 20 });
  });
});

describe('row <-> MIDI over the full piano range (21..108)', () => {
  it('uses the full 88-key range by default', () => {
    expect(PIANO_LOW_MIDI).toBe(21);
    expect(PIANO_HIGH_MIDI).toBe(108);
    expect(FULL_PIANO_RANGE).toEqual({ low: 21, high: 108 });
  });

  it('round-trips MIDI 21 and 108', () => {
    for (const midi of [21, 60, 108]) {
      const row = midiToRow(midi);
      expect(row).not.toBeNull();
      expect(rowToMidi(row as number)).toBe(midi);
    }
    expect(midiToRow(108)).toBe(0);
    expect(midiToRow(21)).toBe(87);
  });

  it('returns null outside the range', () => {
    expect(midiToRow(20)).toBeNull();
    expect(midiToRow(109)).toBeNull();
    expect(rowToMidi(-1)).toBeNull();
    expect(rowToMidi(88)).toBeNull();
    expect(rowToMidi(1.5)).toBeNull();
  });

  it('honours a custom range', () => {
    const range = { low: 48, high: 72 };
    expect(midiToRow(72, range)).toBe(0);
    expect(rowToMidi(24, range)).toBe(48);
    expect(midiToRow(47, range)).toBeNull();
    expect(rowToMidi(25, range)).toBeNull();
  });
});

describe('initialPitchWindow', () => {
  it('shows C3..C5 when the clip has no notes', () => {
    expect(initialPitchWindow([])).toEqual({ low: 48, high: 72 });
  });

  it('pads the note range by one octave on each side', () => {
    expect(initialPitchWindow([60, 67, 64])).toEqual({ low: 48, high: 79 });
  });

  it('clamps the padded range into the piano range', () => {
    expect(initialPitchWindow([24, 105])).toEqual({ low: 21, high: 108 });
  });

  it('handles a dense clip (200,000 notes) without overflowing the call stack', () => {
    const pitches = Array<number>(200_000).fill(60);
    pitches[123_456] = 30;
    expect(() => initialPitchWindow(pitches)).not.toThrow();
    expect(initialPitchWindow(pitches)).toEqual({ low: 21, high: 72 });
    expect(pitchSpan(pitches)).toEqual({ low: 30, high: 60 });
  });
});

describe('pitchSpan', () => {
  it('is null for no notes and the min..max otherwise', () => {
    expect(pitchSpan([])).toBeNull();
    expect(pitchSpan([64, 60, 67])).toEqual({ low: 60, high: 67 });
  });
});

describe('visibleRowRange (simple virtualization)', () => {
  it('returns the rows inside the viewport plus overscan', () => {
    // rows 10..14 are visible at 16px rows; overscan 2 -> 8..16
    expect(visibleRowRange(160, 80, 16, 88, 2)).toEqual({ first: 8, last: 16 });
  });

  it('clamps to the row count', () => {
    expect(visibleRowRange(0, 64, 16, 88, 4)).toEqual({ first: 0, last: 7 });
    expect(visibleRowRange(87 * 16, 160, 16, 88, 4)).toEqual({ first: 83, last: 87 });
  });

  it('is empty-safe', () => {
    expect(visibleRowRange(0, 100, 0, 88)).toEqual({ first: 0, last: 87 });
    expect(visibleRowRange(0, 100, 16, 0)).toEqual({ first: 0, last: -1 });
  });
});

describe('windowScrollTop', () => {
  // 88 rows (MIDI 108 at the top), 16px each.
  const ROWS = 88;
  const H = 16;
  const midiAt = (y: number) => 108 - Math.floor(y / H);

  it('keeps the clip notes in view when the viewport is shorter than the window', () => {
    // Notes 60..72 -> window 48..84; a 12-row viewport (1280x900 case).
    const top = windowScrollTop({ low: 48, high: 84 }, 12 * H, H, ROWS);
    const topMidi = midiAt(top);
    const bottomMidi = midiAt(top + 12 * H - 1);
    expect(topMidi).toBeLessThanOrEqual(72);
    expect(bottomMidi).toBeGreaterThanOrEqual(60);
    // Centred on the middle of the notes (66).
    expect(Math.abs((topMidi + bottomMidi) / 2 - 66)).toBeLessThanOrEqual(1);
  });

  it('shows the whole window when the viewport is taller than it', () => {
    const top = windowScrollTop({ low: 48, high: 72 }, 40 * H, H, ROWS);
    expect(midiAt(top)).toBeGreaterThanOrEqual(72);
    expect(midiAt(top + 40 * H - 1)).toBeLessThanOrEqual(48);
  });

  it('clamps to the scrollable range at both ends', () => {
    expect(windowScrollTop({ low: 96, high: 108 }, 30 * H, H, ROWS)).toBe(0);
    expect(windowScrollTop({ low: 21, high: 33 }, 30 * H, H, ROWS)).toBe((ROWS - 30) * H);
    expect(windowScrollTop({ low: 21, high: 108 }, 200 * H, H, ROWS)).toBe(0);
  });

  // 1280x800 case: 72px viewport minus the 22px sticky ruler = 50px for rows.
  const ROW_VIEW = 50;
  const rowsInView = (top: number) => {
    const midis: number[] = [];
    for (let row = Math.floor(top / H); row * H < top + ROW_VIEW; row += 1) {
      if ((row + 1) * H <= top + ROW_VIEW && row * H >= top) midis.push(108 - row);
    }
    return midis;
  };

  it.each([108, 21])('keeps a lone MIDI %i note fully in view when the padded window cannot fit', (pitch) => {
    const notes = pitchSpan([pitch])!;
    const top = windowScrollTop(initialPitchWindow([pitch]), ROW_VIEW, H, ROWS, 108, notes);
    expect(rowsInView(top)).toContain(pitch);
  });

  it('shows the top of the notes when even the notes do not fit', () => {
    const top = windowScrollTop(initialPitchWindow([60, 84]), ROW_VIEW, H, ROWS, 108, { low: 60, high: 84 });
    expect(rowsInView(top)[0]).toBe(84);
  });

  it('still centres the padded window when it fits', () => {
    const win = { low: 48, high: 72 };
    expect(windowScrollTop(win, 40 * H, H, ROWS, 108, { low: 60, high: 60 })).toBe(
      windowScrollTop(win, 40 * H, H, ROWS),
    );
  });
});

describe('ghostNotesFromEvents (他トラックのノートを表示クリップの相対拍へ)', () => {
  const own = (startBeat: number) => ({ id: 'view', startBeat });
  const ghostsOf = (project: ReturnType<typeof makeProject>, view: { id: string; startBeat: number }, ownTrackId: string, hidden: string[] = []) =>
    ghostNotesFromEvents(soundingEvents(project, { includeMuted: true }).events, {
      viewClip: view,
      ownTrackId,
      hiddenTrackIds: new Set(hidden),
    });

  it('クリップ startBeat 16・相対 2 のノートは、表示クリップ(startBeat 8)の相対 10 拍', () => {
    const project = makeProject([
      makeTrack('a', 'instrument', [midiClip('view', 'a', 8, 8, [])]),
      makeTrack('b', 'instrument', [midiClip('other', 'b', 16, 8, [[2, 1, 64]])]),
    ]);
    const g = ghostsOf(project, own(8), 'a');
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ trackId: 'b', pitch: 64, startBeat: 10, durationBeats: 1 });
  });
  it('startBeat が小数のクリップでも相対拍が合う', () => {
    const project = makeProject([
      makeTrack('a', 'instrument', [midiClip('view', 'a', 0.5, 8, [])]),
      makeTrack('b', 'instrument', [midiClip('other', 'b', 4.25, 4, [[0.5, 1, 60]])]),
    ]);
    expect(ghostsOf(project, { id: 'view', startBeat: 0.5 }, 'a')[0]!.startBeat).toBeCloseTo(4.25, 9);
  });
  it('ループの繰り返し・リンクされたクリップも鳴る位置で出る', () => {
    const project = makeProject([
      makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 8, [])]),
      makeTrack('b', 'instrument', [
        midiClip('loop', 'b', 0, 6, [[0, 1, 60]], { contentLengthBeats: 2, loop: true }),
        midiClip('src', 'b', 8, 2, [[1, 1, 62]]),
        midiClip('link', 'b', 12, 2, [], { aliasOf: 'src' }),
      ]),
    ]);
    const g = ghostsOf(project, own(0), 'a');
    expect(g.filter((n) => n.pitch === 60).map((n) => n.startBeat)).toEqual([0, 2, 4]);
    expect(g.filter((n) => n.pitch === 62).map((n) => n.startBeat).sort((x, y) => x - y)).toEqual([9, 13]);
  });
  it('曲末をまたぐ音は切り詰めた長さで出る', () => {
    const project = makeProject(
      [
        makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 4, [])]),
        makeTrack('b', 'instrument', [midiClip('other', 'b', 0, 4, [[3, 8, 60]])]),
      ],
      { lengthBars: 1 },
    );
    const g = ghostsOf(project, own(0), 'a');
    expect(g).toHaveLength(1);
    expect(g[0]!.startBeat + g[0]!.durationBeats).toBeLessThanOrEqual(4 + 1e-9);
  });
  it('自分のトラック・非表示トラック・ドラムは出ない', () => {
    const project = makeProject([
      makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 4, [[0, 1, 60]]), midiClip('mine2', 'a', 4, 4, [[0, 1, 61]])]),
      makeTrack('b', 'instrument', [midiClip('ob', 'b', 0, 4, [[0, 1, 62]])]),
      makeTrack('d', 'drum', [drumClip('dc', 'd', 0, 4, [[0, 'kick']])]),
    ]);
    expect(ghostsOf(project, own(0), 'a').map((n) => n.pitch)).toEqual([62]);
    expect(ghostsOf(project, own(0), 'a', ['b'])).toEqual([]);
  });
  it('ミュート中のトラックも出す(表示は表示チェックだけで決める)', () => {
    const muted = { ...makeTrack('b', 'instrument', [midiClip('ob', 'b', 0, 4, [[0, 1, 62]])]), mute: true };
    const project = makeProject([makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 4, [])]), muted]);
    expect(ghostsOf(project, own(0), 'a')).toHaveLength(1);
  });
  it('トラックが 1 本・ノート 0 件なら空', () => {
    const one = makeProject([makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 4, [[0, 1, 60]])])]);
    expect(ghostsOf(one, own(0), 'a')).toEqual([]);
    const empty = makeProject([
      makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 4, [])]),
      makeTrack('b', 'instrument', [midiClip('ob', 'b', 0, 4, [])]),
    ]);
    expect(ghostsOf(empty, own(0), 'a')).toEqual([]);
  });
});

describe('visibleGhostNotes (表示範囲と上限)', () => {
  const g = (pitch: number, startBeat: number, durationBeats = 1) => ({
    key: `${pitch}-${startBeat}`,
    trackId: 'b',
    absStartBeat: startBeat,
    pitch,
    startBeat,
    durationBeats,
    velocity: 100,
  });
  const view = { lowMidi: 60, highMidi: 72, clipStartBeat: 0, gridLength: 8 };
  it('音域・拍の範囲外は描画しない', () => {
    const inRange = [g(65, -2, 3), g(65, 7.5)];
    const out = visibleGhostNotes([g(59, 0), g(73, 0), g(65, 8), g(65, -2, 1), ...inRange], view);
    expect(out).toEqual(inRange);
  });
  it('個数に上限がある', () => {
    const many = Array.from({ length: MAX_RENDERED_GHOSTS * 3 }, (_, i) => g(65, i / 100, 0.01));
    const out = visibleGhostNotes(many, { ...view, gridLength: 1000 });
    expect(out).toHaveLength(MAX_RENDERED_GHOSTS);
  });
});

describe('表示範囲の判定は絶対 tick で行う(浮動小数の誤差で余分なゴーストを出さない)', () => {
  it('他トラックの音が絶対 0.1 拍から 4 拍、表示クリップが 4.1 拍開始なら、左端に出ない', () => {
    const project = makeProject(
      [
        makeTrack('a', 'instrument', [midiClip('view', 'a', 4.1, 4, [])]),
        makeTrack('b', 'instrument', [midiClip('other', 'b', 0.1, 8, [[0, 4, 60]])]),
      ],
      { lengthBars: 4 },
    );
    const ghosts = ghostNotesFromEvents(soundingEvents(project, { includeMuted: true }).events, {
      viewClip: { startBeat: 4.1 },
      ownTrackId: 'a',
      hiddenTrackIds: new Set(),
    });
    expect(ghosts).toHaveLength(1);
    const out = visibleGhostNotes(ghosts, { lowMidi: 21, highMidi: 108, clipStartBeat: 4.1, gridLength: 16 - 4.1 });
    expect(out).toEqual([]);
  });
  it('終端がクリップ開始と tick で一致するなら出さず、1 tick でも越えれば出す', () => {
    const base = { key: 'k', trackId: 'b', pitch: 60, velocity: 100 };
    const view = { lowMidi: 21, highMidi: 108, clipStartBeat: 4.1, gridLength: 8 };
    expect(visibleGhostNotes([{ ...base, absStartBeat: 0.1, startBeat: 0.1 - 4.1, durationBeats: 4 }], view)).toEqual([]);
    expect(visibleGhostNotes([{ ...base, absStartBeat: 0.1, startBeat: 0.1 - 4.1, durationBeats: 4 + 1 / 480 }], view)).toHaveLength(1);
  });
});

describe('soundingStartByNoteId (スウィング込みの発音位置)', () => {
  it('保存データの拍ではなく soundingEvents の開始拍を返す', () => {
    const project = makeProject([makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 4, [[0.25, 0.25, 64]])])], { swing: 60 });
    const clip = project.tracks[0]!.clips[0]!;
    const map = soundingStartByNoteId(soundingEvents(project, { includeMuted: true }).events, clip);
    expect(map.get(clip.notes![0]!.id)).toBeGreaterThan(0.25);
  });
});

describe('chordTickFinder (発音 tick とコード区間 tick の整数比較)', () => {
  const chord = (id: string, startBeat: number, durationBeats: number, symbol: string) => ({
    id, startBeat, durationBeats, symbol, root: symbol, quality: 'major', notes: [] as number[],
  });
  it('発音 0.4010414 拍は、0.4010419 拍に始まる F ではなくまだ C の区間(許容誤差を使わない)', () => {
    const project = makeProject([makeTrack('a', 'instrument', [midiClip('view', 'a', 0, 4, [[0.2510414, 0.25, 64]])])], { swing: 60 });
    const clip = project.tracks[0]!.clips[0]!;
    const sounded = soundingStartByNoteId(soundingEvents(project, { includeMuted: true }).events, clip).get(clip.notes![0]!.id)!;
    expect(sounded).toBeGreaterThan(0.4);
    expect(sounded).toBeLessThan(0.4010419);
    const find = chordTickFinder([chord('c', 0, 0.4010419, 'C'), chord('f', 0.4010419, 3, 'F')]);
    expect(find(sounded)?.symbol).toBe('C');
  });
  it('境界の tick ちょうどは次のコード、終端は含まない', () => {
    const find = chordTickFinder([chord('b', 2, 2, 'F'), chord('a', 0, 2, 'C')]);
    expect(find(0)?.symbol).toBe('C');
    expect(find(1.9989)?.symbol).toBe('C');
    expect(find(2)?.symbol).toBe('F');
    expect(find(4)).toBeUndefined();
    expect(find(-0.5)).toBeUndefined();
  });
  it('コードが無ければ undefined', () => {
    expect(chordTickFinder([])(1)).toBeUndefined();
  });
  it('重なり・同じ tick 開始では、格納順でなく元の startBeat が早い方を選ぶ(chordFinder と同じ規則)', () => {
    const f = chord('f', 0.0005, 4, 'F');
    const c = chord('c', 0, 4, 'C');
    expect(chordTickFinder([f, c])(1)?.symbol).toBe('C');
    expect(chordTickFinder([c, f])(1)?.symbol).toBe('C');
  });
  it('プロパティ(seed 固定): 境界から 1 tick 以上離れた位置では chordFinder と一致する', () => {
    const rnd = createPrng(20261127);
    const TICK = 1 / 480;
    let compared = 0;
    for (let round = 0; round < 300; round += 1) {
      const n = 1 + Math.floor(rnd() * 6);
      const track = Array.from({ length: n }, (_, i) => {
        // 端数の拍・同じ開始・重なりを混ぜる。開始が 1 tick 未満だけずれる組も作る。
        const base = Math.floor(rnd() * 8) * 0.5;
        const jitter = rnd() < 0.4 ? Math.floor(rnd() * 3) * 0.0005 : rnd() < 0.5 ? rnd() * 0.37 : 0;
        return chord(`k${i}`, base + jitter, 0.25 + Math.floor(rnd() * 9) * 0.5 + (rnd() < 0.3 ? rnd() * 0.3 : 0), `S${i}`);
      });
      const edges = track.flatMap((c) => [c.startBeat, c.startBeat + c.durationBeats]);
      const finder = chordFinder(track as never);
      const finder2 = chordTickFinder(track);
      for (let k = 0; k < 40; k += 1) {
        const beat = rnd() * 12 - 1;
        if (edges.some((e) => Math.abs(beat - e) < TICK + 1e-9)) continue;
        compared += 1;
        expect(finder2(beat)?.id, `beat=${beat} track=${JSON.stringify(track)}`).toBe(finder(beat)?.id);
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
