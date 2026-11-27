import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ParsedMidi } from '@cts/midi-io';
import { checkProjectPredicate } from '@cts/tutorial-engine';
import type { Clip, DrumEvent, DrumLane, Project, Track } from '@cts/project-model';
import { beatTick, findProjectSoundingLimitProblem, resampleDrumSteps, duplicateClip, expandClip, MAX_CLIP_END_BEATS, moveClip, resizeClip, soundingEvents, swingBeat, validateProject } from '@cts/project-model';
import { mulberry32 } from '../../../packages/project-model/tests/acceptance/helpers';
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

describe('ops.undo: clip operations are one undo step each', () => {
  function melodyClip() {
    const clip = actions.firstMidiClipOfTrack(useStore.getState().project, 'Melody');
    if (!clip) throw new Error('no Melody clip');
    return clip;
  }

  function expectOneUndoStep(run: () => void): void {
    const before = useStore.getState().project;
    const pastLength = useStore.getState().past.length;
    run();
    expect(useStore.getState().project).not.toBe(before);
    expect(useStore.getState().past.length).toBe(pastLength + 1);
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before);
  }

  beforeEach(() => {
    const clip = melodyClip();
    useStore.getState().addNote(clip.id, { pitch: 60, startBeat: 1.3, durationBeats: 1, velocity: 100 });
    useStore.getState().commitTransaction();
  });

  it('add', () => {
    expectOneUndoStep(() => {
      expect(actions.addEmptyClipAt(melodyClip().trackId, 0, 64)).not.toBeNull();
    });
  });

  it('move', () => {
    const clip = melodyClip();
    expectOneUndoStep(() => {
      useStore.getState().applyProjectChange((p) => moveClip(p, clip.id, clip.startBeat + clip.lengthBeats));
    });
  });

  it('resize', () => {
    const clip = melodyClip();
    expectOneUndoStep(() => {
      useStore.getState().applyProjectChange((p) => resizeClip(p, clip.id, clip.lengthBeats / 2));
    });
  });

  it('split', () => {
    const clip = melodyClip();
    expectOneUndoStep(() => {
      expect(actions.splitClipAtBeat(clip.id, clip.startBeat + 1)).toBe(true);
    });
  });

  it('duplicate copy / link', () => {
    for (const mode of ['copy', 'link'] as const) {
      expectOneUndoStep(() => {
        expect(actions.duplicateClipInSong(melodyClip().id, mode, 64)).not.toBeNull();
      });
    }
  });

  it('remove', () => {
    expectOneUndoStep(() => actions.removeClipFromSong(melodyClip().id));
  });

  it('quantize', () => {
    const clip = melodyClip();
    const noteId = clip.notes!.find((n) => n.startBeat === 1.3)!.id;
    expectOneUndoStep(() => actions.quantizeNotes(clip.id, [noteId], 1));
  });

  it('quantize with strength (US-018)', () => {
    const clip = melodyClip();
    const noteId = clip.notes!.find((n) => n.startBeat === 1.3)!.id;
    expectOneUndoStep(() => expect(actions.quantizeNotes(clip.id, [noteId], 1, 50)).toBe(true));
    expect(actions.quantizeNotes(clip.id, [noteId], 1, 50)).toBe(true);
    const moved = actions.findClip(useStore.getState().project, clip.id)!.notes!.find((n) => n.id === noteId)!;
    expect(moved.startBeat).toBeCloseTo(1.15, 12);
  });

  it('humanize (US-018)', () => {
    const clip = melodyClip();
    const ids = clip.notes!.map((n) => n.id);
    expectOneUndoStep(() => expect(actions.humanizeNotes(clip.id, ids, { timingBeats: 0.05, velocity: 10, seed: 7 })).toBe(true));
  });

  it('swing (US-018)', () => {
    expectOneUndoStep(() => expect(actions.setSwing(50)).toBe(true));
  });

  it('a refused split adds no undo step', () => {
    const clip = melodyClip();
    useStore.getState().applyProjectChange((p) => duplicateClip(p, clip.id, { mode: 'link' }));
    const link = useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.aliasOf === clip.id)!;
    const pastLength = useStore.getState().past.length;
    expect(actions.splitClipAtBeat(link.id, link.startBeat + 1)).toBe(false);
    expect(useStore.getState().past.length).toBe(pastLength);
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

describe('role によるトラック解決 (改名後)', () => {
  function renameByRole(role: 'bass' | 'melody', name: string): void {
    useStore.setState((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) => (t.role === role ? { ...t, name } : t)),
      },
    }));
  }

  it('Bass を「ベース」に改名しても generateBassIntoClip の対象クリップが見つかる', () => {
    renameByRole('bass', 'ベース');
    const project = useStore.getState().project;
    expect(actions.findTrackByRole(project, 'bass')?.name).toBe('ベース');
    const clip = actions.firstMidiClipOfTrack(project, 'Bass');
    expect(clip).not.toBeNull();
    const reasons = actions.generateBassIntoClip(clip!.id, 'rootOnly');
    expect(reasons.length).toBeGreaterThan(0);
    const saved = actions.findTrackByRole(useStore.getState().project, 'bass')?.clips[0];
    expect(saved?.id).toBe(clip!.id);
    expect(saved?.notes?.length).toBe(reasons.length);
  });

  it('bass の役割が付いたドラムトラック(古い保存データ)を生成先に選ばない', () => {
    const project = useStore.getState().project;
    useStore.getState().replaceProject({
      ...project,
      tracks: project.tracks.map((t) => {
        if (t.type === 'drum') return { ...t, role: 'bass' as const };
        if (t.role === 'bass') {
          const { role: _cleared, ...rest } = t;
          return { ...rest, name: '低音' };
        }
        return t;
      }),
    });
    expect(actions.firstMidiClipOfTrack(useStore.getState().project, 'Bass')).toBeNull();
  });

  it('Melody を「メロディ」に改名しても generateMelodyIntoClip の対象クリップが見つかる', () => {
    renameByRole('melody', 'メロディ');
    const project = useStore.getState().project;
    const clip = actions.firstMidiClipOfTrack(project, 'Melody');
    expect(clip).not.toBeNull();
    const generated = actions.generateMelodyIntoClip(clip!.id, 1);
    expect(generated.length).toBeGreaterThan(0);
    const saved = actions.findTrackByRole(useStore.getState().project, 'melody')?.clips[0];
    expect(saved?.id).toBe(clip!.id);
    expect(saved?.notes?.length).toBe(generated.length);
  });

  it('role が無いプロジェクトは名前でフォールバックする', () => {
    useStore.setState((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) => ({ ...t, role: undefined })),
      },
    }));
    const project = useStore.getState().project;
    expect(actions.findTrackByRole(project, 'bass')).toBeNull();
    expect(actions.firstMidiClipOfTrack(project, 'Bass')).not.toBeNull();
  });

  it('importMidiTracks は標準名のトラックに role を付けるが、既存の role は奪わない', () => {
    const note = { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90, channel: 0 };
    actions.importMidiTracks({
      format: 1,
      ppq: 480,
      tracks: [
        { index: 0, name: 'Bass', notes: [note] },
        { index: 1, name: 'Piano', notes: [note] },
      ],
      tempos: [],
      timeSignatures: [],
      bpm: 120,
      timeSignature: [4, 4],
    });
    const tracks = useStore.getState().project.tracks;
    expect(tracks.filter((t) => t.role === 'bass')).toHaveLength(1);
    expect(tracks.find((t) => t.name === 'Piano')?.role).toBeUndefined();
  });

  it('importMidiTracks は未使用の role を同じ読み込みの先頭トラックだけに付ける', () => {
    useStore.setState((s) => ({
      project: { ...s.project, tracks: s.project.tracks.filter((t) => t.role !== 'bass') },
    }));
    const note = { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90, channel: 0 };
    actions.importMidiTracks({
      format: 1,
      ppq: 480,
      tracks: [
        { index: 0, name: 'Bass', notes: [note] },
        { index: 1, name: 'bass', notes: [note] },
      ],
      tempos: [],
      timeSignatures: [],
      bpm: 120,
      timeSignature: [4, 4],
    });
    const tracks = useStore.getState().project.tracks;
    expect(tracks.find((t) => t.name === 'Bass')?.role).toBe('bass');
    expect(tracks.find((t) => t.name === 'bass')?.role).toBeUndefined();
  });
});

describe('importMidiTracks: 拍子の取り込み', () => {
  const note = { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90, channel: 0 };
  const parsedWaltz = (notes = [note]): ParsedMidi => ({
    format: 1,
    ppq: 480,
    tracks: [{ index: 0, name: 'Piano', notes }],
    tempos: [],
    timeSignatures: [],
    bpm: 120,
    timeSignature: [3, 4] as [number, number],
  });
  const drumClip = () => useStore.getState().project.tracks.find((t) => t.type === 'drum')?.clips[0];

  beforeEach(() => {
    // 4/4, 8 bars: kick on beats 1 and 3 of bar 1 (steps 0, 8), snare on beat 2 (step 4),
    // and a 4-bar section starting at bar 4 (beat 16).
    const clipId = drumClip()?.id ?? '';
    useStore.getState().toggleDrumStep(clipId, 'kick', 0);
    useStore.getState().toggleDrumStep(clipId, 'kick', 8);
    useStore.getState().toggleDrumStep(clipId, 'snare', 4);
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      sections: [{ id: 'sec-a', name: 'Aメロ', type: 'verse', startBar: 4, lengthBars: 4 }],
    }));
  });

  it('3/4 の MIDI は共通の拍子変更を通る: ドラムは 12 ステップに再グリッド、セクションは拍位置で換算', () => {
    const result = actions.importMidiTracks(parsedWaltz());
    const project = useStore.getState().project;
    expect(project.timeSignature).toEqual([3, 4]);
    // 32 beats of 4/4 -> 11 bars of 3/4.
    expect(project.lengthBars).toBe(11);
    const clip = drumClip();
    expect(clip?.stepsPerBar).toBe(12);
    const steps = (lane: string) =>
      (clip?.drumEvents ?? []).filter((e) => e.lane === lane).map((e) => e.stepIndex).sort((a, b) => a - b);
    // Beat 2 of bar 1 is still step 8 (4 steps per beat); beat 1 (4/4 bar 1 beat 2) is step 4.
    expect(steps('kick')).toEqual([0, 8]);
    expect(steps('snare')).toEqual([4]);
    // The section began at beat 16 and lasted 16 beats: bars 5..10 of 3/4 (16/3 is not whole).
    expect(project.sections[0]).toMatchObject({ name: 'Aメロ', startBar: 5, lengthBars: 6 });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('セクション');
  });

  it('同じ拍子のファイルは何も変換せず警告も出ない', () => {
    const result = actions.importMidiTracks({ ...parsedWaltz(), timeSignature: [4, 4] });
    const project = useStore.getState().project;
    expect(project.timeSignature).toEqual([4, 4]);
    expect(project.lengthBars).toBe(8);
    expect(drumClip()?.stepsPerBar).toBe(16);
    expect(project.sections[0]).toMatchObject({ startBar: 4, lengthBars: 4 });
    expect(result.warnings).toEqual([]);
  });

  it('読み込んだノートが曲より長いときだけ共通の長さ変更で伸ばす', () => {
    // Ends at beat 40 -> 14 bars of 3/4 (the meter change alone would give 11).
    actions.importMidiTracks(parsedWaltz([{ ...note, startBeat: 39, durationBeats: 1 }]));
    const project = useStore.getState().project;
    expect(project.lengthBars).toBe(14);
    // The drum clip ended with the song and keeps doing so.
    expect(drumClip()?.lengthBeats).toBe(42);
  });

  it('ドラムの音が重なって消えるときは、確認するまで何も読み込まない', () => {
    // A 32-step (8 per beat) clip: kicks on steps 1 and 2 (beats 1/8 and 1/4) both round to 3/4 step 1.
    const clipId = drumClip()?.id ?? '';
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === clipId
            ? {
                ...clip,
                stepsPerBar: 32,
                drumEvents: [
                  { id: 'k1', lane: 'kick' as const, stepIndex: 1, velocity: 100 },
                  { id: 'k2', lane: 'kick' as const, stepIndex: 2, velocity: 100 },
                ],
              }
            : clip,
        ),
      })),
    }));
    const before = useStore.getState().project;

    const asked = actions.importMidiTracks(parsedWaltz());
    expect(asked.confirm).toContain('1 個');
    expect(asked.importedTrackCount).toBe(0);
    expect(useStore.getState().project).toBe(before);

    const applied = actions.importMidiTracks(parsedWaltz(), true);
    expect(applied.confirm).toBeNull();
    expect(applied.importedTrackCount).toBe(1);
    expect(useStore.getState().project.timeSignature).toEqual([3, 4]);
    expect(drumClip()?.drumEvents).toHaveLength(1);
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before);
  });

  it('読み込み全体が Undo 1 段で戻る', () => {
    const before = useStore.getState().project;
    actions.importMidiTracks(parsedWaltz());
    expect(useStore.getState().project.timeSignature).toEqual([3, 4]);
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before);
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

describe('generation into a short clip (only the chords inside the clip are used)', () => {
  function shortenClip(clipId: string): void {
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, lengthBeats: 4, loop: false } : c)),
      })),
    }));
  }

  function soundedStarts(clipId: string): number[] {
    const project = useStore.getState().project;
    const all = project.tracks.flatMap((t) => t.clips);
    const clip = all.find((c) => c.id === clipId)!;
    return expandClip(clip, all).notes.map((n) => n.startBeat - clip.startBeat);
  }

  for (const [label, clipIdOf, generate] of [
    ['bass', bassClipId, (id: string) => actions.generateBassIntoClip(id, 'rootOnly')],
    ['melody', melodyClipId, (id: string) => actions.generateMelodyIntoClip(id, 1)],
  ] as const) {
    it(`${label}: a 4-beat clip gets notes only inside its 4 beats, all of them sound, and one undo restores it`, () => {
      const clipId = clipIdOf();
      shortenClip(clipId);
      const before = useStore.getState().project;

      const generated = generate(clipId);

      expect(generated.length).toBeGreaterThan(0);
      expect(generated.every((n) => n.startBeat >= 0 && n.startBeat + n.durationBeats <= 4 + 1e-9)).toBe(true);
      expect(actions.findClip(useStore.getState().project, clipId)?.lengthBeats).toBe(4);
      expect(soundedStarts(clipId)).toEqual(generated.map((n) => n.startBeat));
      useStore.getState().undo();
      expect(useStore.getState().project).toEqual(before);
    });
  }
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

  it('places 8-beat hits on 16th steps in 4/4 (kick 0/8, snare 4/12 per bar)', () => {
    const drumClip = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0];
    actions.applyDrumPattern(drumClip?.id ?? '', 'eightBeat');
    const events = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [];
    const firstBar = (lane: string) =>
      events.filter((e) => e.lane === lane && e.stepIndex < 16).map((e) => e.stepIndex).sort((a, b) => a - b);
    expect(firstBar('kick')).toEqual([0, 8]);
    expect(firstBar('snare')).toEqual([4, 12]);
    expect(firstBar('closedHat')).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
  });

  it('drops hits past the bar in 3/4 and keeps 4 steps per beat', () => {
    useStore.getState().setTimeSignature([3, 4]);
    const drumClip = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0];
    expect(drumClip?.stepsPerBar).toBe(12);
    actions.applyDrumPattern(drumClip?.id ?? '', 'eightBeat');
    const events = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [];
    const firstBar = (lane: string) =>
      events.filter((e) => e.lane === lane && e.stepIndex < 12).map((e) => e.stepIndex).sort((a, b) => a - b);
    // Beat 3 (snare's "4th beat") does not exist in 3/4.
    expect(firstBar('kick')).toEqual([0, 8]);
    expect(firstBar('snare')).toEqual([4]);
    expect(firstBar('closedHat')).toEqual([0, 2, 4, 6, 8, 10]);
    expect(events.every((e) => e.stepIndex % 1 === 0)).toBe(true);
  });

  it('fills a partial last bar only up to the clip end', () => {
    // 33 beats of 4/4: 8 full bars plus one beat of a 9th bar.
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((t) =>
        t.type === 'drum' ? { ...t, clips: t.clips.map((c) => ({ ...c, lengthBeats: 33 })) } : t,
      ),
    }));
    const drumClip = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0];
    actions.applyDrumPattern(drumClip?.id ?? '', 'eightBeat');
    const events = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [];
    const lastBar = (lane: string) =>
      events.filter((e) => e.lane === lane && e.stepIndex >= 128).map((e) => e.stepIndex).sort((a, b) => a - b);
    expect(lastBar('kick')).toEqual([128]);
    expect(lastBar('closedHat')).toEqual([128, 130]);
    expect(lastBar('snare')).toEqual([]);
    // Nothing at or after beat 33 (step 132).
    expect(events.every((e) => e.stepIndex < 132)).toBe(true);
  });

  it('3/4 に 16 ステップのクリップ(旧ファイル)でも、適用したパターンがレッスン判定を満たす', () => {
    // Load a project whose drum grid was never regridded: 3/4 with 16 steps per bar.
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      timeSignature: [3, 4],
      lengthBars: 8,
      tracks: project.tracks.map((t) =>
        t.type === 'drum'
          ? { ...t, clips: t.clips.map((c) => ({ ...c, lengthBeats: 24, stepsPerBar: 16, drumEvents: [] })) }
          : t,
      ),
    }));
    const clipId = useStore.getState().project.tracks.find((t) => t.type === 'drum')?.clips[0]?.id ?? '';

    actions.applyDrumPattern(clipId, 'fourOnFloor');
    let project = useStore.getState().project;
    const events = project.tracks.find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [];
    const firstBarKicks = events
      .filter((e) => e.lane === 'kick' && e.stepIndex < 16)
      .map((e) => e.stepIndex)
      .sort((a, b) => a - b);
    expect(firstBarKicks).toEqual([0, 5, 11]);
    expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'fourOnFloor' }, project)).toBe(true);

    actions.applyDrumPattern(clipId, 'eightBeat');
    project = useStore.getState().project;
    expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'eightBeat' }, project)).toBe(true);
    expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'backbeat' }, project)).toBe(true);
  });

  describe.each([
    { sig: [2, 4] as [number, number], beats: 2, steps: 8 },
    { sig: [3, 4] as [number, number], beats: 3, steps: 12 },
    { sig: [5, 4] as [number, number], beats: 5, steps: 20 },
    { sig: [6, 8] as [number, number], beats: 3, steps: 12 },
  ])('in $sig.0/$sig.1', ({ sig, beats, steps }) => {
    const firstBar = (lane: string) =>
      (useStore.getState().project.tracks.find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [])
        .filter((e) => e.lane === lane && e.stepIndex < steps)
        .map((e) => e.stepIndex)
        .sort((a, b) => a - b);
    const prepare = (): string => {
      useStore.getState().setTimeSignature(sig, true);
      const clip = useStore.getState().project.tracks.find((t) => t.type === 'drum')?.clips[0];
      expect(clip?.stepsPerBar).toBe(steps);
      return clip?.id ?? '';
    };

    it('fourOnFloor puts a kick on every beat of the bar and passes its lesson check', () => {
      actions.applyDrumPattern(prepare(), 'fourOnFloor');
      expect(firstBar('kick')).toEqual(Array.from({ length: beats }, (_, i) => i * 4));
      const project = useStore.getState().project;
      expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'fourOnFloor' }, project)).toBe(true);
    });

    it('eightBeat puts a hi-hat on every 8th of the bar and passes its lesson check', () => {
      actions.applyDrumPattern(prepare(), 'eightBeat');
      expect(firstBar('closedHat')).toEqual(Array.from({ length: beats * 2 }, (_, i) => i * 2));
      const project = useStore.getState().project;
      expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'eightBeat' }, project)).toBe(true);
      expect(checkProjectPredicate({ type: 'hasDrumPattern', patternType: 'backbeat' }, project)).toBe(true);
    });
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

describe('addEmptyClipAt on a full track', () => {
  it('adds nothing and explains why when moveClip finds no free spot', async () => {
    const { getBridgeSnapshot } = await import('../src/state/tutorialBridge');
    const track = useStore.getState().project.tracks.find((t) => t.name === 'Melody')!;
    useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => t.id === track.id
        ? { ...t, clips: [{ id: 'full', trackId: t.id, type: 'midi' as const, startBeat: 0, lengthBeats: MAX_CLIP_END_BEATS, loop: false, notes: [] }] }
        : t),
    }));
    useStore.getState().commitTransaction();
    const before = useStore.getState().project;
    const toastsBefore = getBridgeSnapshot().toasts.length;
    expect(actions.addEmptyClipAt(track.id, 8, 64)).toBeNull();
    expect(useStore.getState().project).toBe(before);
    const toasts = getBridgeSnapshot().toasts;
    expect(toasts).toHaveLength(toastsBefore + 1);
    expect(toasts.at(-1)?.message).toBe(actions.NO_ROOM_FOR_CLIP_MESSAGE);
  });
});

// ---- US-019 ドラムの 12/16 ステップ切替 ----

type OkPlan = Extract<NonNullable<ReturnType<typeof import('../src/state/editorActions')['planDrumStepsChange']>>, { ok: true }>;
/** planDrumStepsChange that must succeed. */
function okPlan(project: Project, clipId: string, to: number): OkPlan {
  const plan = actions.planDrumStepsChange(project, clipId, to);
  expect(plan, 'plan').not.toBeNull();
  expect(plan!.ok ? '' : plan!.reason).toBe('');
  return plan as OkPlan;
}

describe('planDrumStepsChange / setDrumStepsPerBar (US-019)', () => {
  type Hit = [number, DrumLane];
  const drum = (id: string, trackId: string, startBeat: number, lengthBeats: number, hits: Hit[], extra: Partial<Clip> = {}): Clip => ({
    id, trackId, type: 'drum', startBeat, lengthBeats, loop: false, stepsPerBar: 16,
    drumEvents: hits.map(([stepIndex, lane], i) => ({ id: `${id}-d${i}`, lane, stepIndex, velocity: 100 })),
    ...extra,
  });
  const drumTrack = (id: string, clips: Clip[]): Track => ({
    id, name: id, type: 'drum', clips, volume: 0.8, pan: 0, mute: false, solo: false, effects: [],
  });
  const song = (tracks: Track[], over: Partial<Project> = {}): Project => ({
    id: 'p', schemaVersion: 3, title: 't', bpm: 120, timeSignature: [4, 4], key: 'C', scale: 'major',
    lengthBars: 8, tracks, chordTrack: [], sections: [], createdAt: 'now', updatedAt: 'now', ...over,
  });
  const clipOf = (project: Project, id: string) => project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

  it('4/4 の 16→12: ステップ 1 は 12 のステップ 1 へ移り、ずれた個数 1 を返す。拍の打点は動かない', () => {
    const p = song([drumTrack('d', [drum('a', 'd', 0, 4, [[0, 'kick'], [1, 'closedHat'], [4, 'snare']])])]);
    const plan = okPlan(p, 'a', 12)!;
    expect(plan).toMatchObject({ moved: 1, merged: 0 });
    expect(clipOf(plan.project, 'a').stepsPerBar).toBe(12);
    expect(clipOf(plan.project, 'a').drumEvents!.map((e) => e.stepIndex)).toEqual([0, 1, 3]);
  });

  it('3/4 の 12→16: 3 の倍数のステップだけ無損失(ステップ 3 は 4 へ、個数 0)', () => {
    const p = song([drumTrack('d', [drum('a', 'd', 0, 3, [[0, 'kick'], [3, 'kick'], [9, 'kick']], { stepsPerBar: 12 })])], { timeSignature: [3, 4] });
    const plan = okPlan(p, 'a', 16)!;
    expect(plan).toMatchObject({ moved: 0, merged: 0 });
    expect(clipOf(plan.project, 'a').drumEvents!.map((e) => e.stepIndex)).toEqual([0, 4, 12]);
    const odd = okPlan(song([drumTrack('d', [drum('a', 'd', 0, 3, [[1, 'kick']], { stepsPerBar: 12 })])], { timeSignature: [3, 4] }), 'a', 16)!;
    expect(odd.moved).toBe(1);
  });

  it('最も近いステップがクリップの外になる打点は、鳴り続けるよう手前のステップへ移す', () => {
    // 1.3 拍のクリップ: 16 の 5(1.25 拍)は 12 の 4(1.333 拍)では鳴らないので 3(1 拍)へ。
    const p = song([drumTrack('d', [drum('a', 'd', 0, 1.3, [[5, 'kick']])])]);
    const plan = okPlan(p, 'a', 12)!;
    expect(clipOf(plan.project, 'a').drumEvents!.map((e) => e.stepIndex)).toEqual([3]);
    expect(plan.moved).toBe(1);
    expect(soundingEvents(plan.project).events).toHaveLength(1);
  });

  it('同じ細かさ・ドラム以外・見つからないクリップでは null', () => {
    const p = song([drumTrack('d', [drum('a', 'd', 0, 4, [[1, 'kick']])])]);
    expect(actions.planDrumStepsChange(p, 'a', 16)).toBeNull();
    expect(actions.planDrumStepsChange(p, 'nope', 12)).toBeNull();
  });

  it('共有元を切り替えると共有先すべてで同じ細かさで鳴り、Undo 1 段で元に戻る', () => {
    const start = song([drumTrack('d', [
      drum('a', 'd', 0, 4, [[0, 'kick'], [2, 'snare']]),
      { id: 'l', trackId: 'd', type: 'drum', startBeat: 4, lengthBeats: 4, loop: false, aliasOf: 'a' },
    ])]);
    useStore.getState().applyProjectChange(() => start);
    const before = useStore.getState().project;
    const depth = useStore.getState().past.length;
    expect(actions.setDrumStepsPerBar('a', 12)).toMatchObject({ moved: 1, merged: 0 });
    const after = useStore.getState().project;
    expect(useStore.getState().past.length).toBe(depth + 1);
    expect(clipOf(after, 'a').stepsPerBar).toBe(12);
    const linkBeats = soundingEvents(after).events.filter((e) => e.clipId === 'l').map((e) => beatTick(e.startBeat));
    expect(linkBeats).toEqual([beatTick(4), beatTick(4 + 2 / 3)]);
    useStore.getState().undo();
    expect(useStore.getState().project.tracks).toEqual(before.tracks);
  });

  // ---- レビュー差し戻し(Codex FAIL)の回帰 ----

  it('swing 50% で移動先が遅れてクリップの外に出るなら、手前のマスへ回して鳴り続けさせる', () => {
    // 長さ 0.36 拍: 12 の 1(1/3 拍)は鳴る。16 の 1 は 0.25 → スウィングで 0.375 拍になり外に出る。
    const p = song([drumTrack('d', [drum('a', 'd', 0, 0.36, [[1, 'kick']], { stepsPerBar: 12 })])], { swing: 50 });
    expect(soundingEvents(p).events).toHaveLength(1);
    const plan = okPlan(p, 'a', 16);
    expect(soundingEvents(plan.project).events).toHaveLength(1);
    expect(clipOf(plan.project, 'a').drumEvents!.map((e) => e.stepIndex)).toEqual([0]);
    expect(plan.moved).toBe(1);
  });

  it('ID に区切り文字を含んでも打点を取り違えない(z・a のキックと x|a のスネア)', () => {
    const p = song([drumTrack('d', [{
      ...drum('a', 'd', 0, 1.3, []),
      drumEvents: [
        { id: 'z', lane: 'kick', stepIndex: 0, velocity: 100 },
        { id: 'a', lane: 'kick', stepIndex: 1, velocity: 100 },
        { id: 'x|a', lane: 'snare', stepIndex: 5, velocity: 100 },
      ],
    }])]);
    const plan = okPlan(p, 'a', 12);
    expect(clipOf(plan.project, 'a').drumEvents!.map((e) => [e.id, e.lane, e.stepIndex])).toEqual([
      ['z', 'kick', 0], ['a', 'kick', 1], ['x|a', 'snare', 3],
    ]);
    expect(soundingEvents(plan.project).events).toHaveLength(3);
  });

  it('音符を持つドラムクリップのリンクが楽器トラックにあっても落ちない(打点の発音だけを数える)', () => {
    const source: Clip = {
      ...drum('a', 'd', 0, 4, []),
      notes: [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    const link: Clip = { id: 'l', trackId: 'i', type: 'drum', startBeat: 0, lengthBeats: 4, loop: false, aliasOf: 'a' };
    const keys: Track = {
      id: 'i', name: 'i', type: 'instrument', clips: [link], volume: 0.8, pan: 0, mute: false, solo: false, effects: [],
      instrument: { type: 'synth', preset: 'warmPad' },
    };
    const p = song([drumTrack('d', [source]), keys]);
    expect(soundingEvents(p, { sourceClipId: 'a' }).events.some((e) => e.kind === 'note')).toBe(true);
    const plan = okPlan(p, 'a', 12);
    expect(clipOf(plan.project, 'a').stepsPerBar).toBe(12);
    expect(clipOf(plan.project, 'a').notes).toEqual(source.notes);
  });

  /** 他のトラックで発音数が 100,000 ちょうど(1/64 拍の周期で 256 拍 = 16,384 回 × 6 音 + 1,696 回)。 */
  const atSoundingLimit = (spare = 0): Track[] => {
    const loopClip = (id: string, trackId: string, lengthBeats: number, pitches: number[]): Clip => ({
      id, trackId, type: 'midi', startBeat: 0, lengthBeats, loop: true, contentLengthBeats: 1 / 64,
      notes: pitches.map((pitch, i) => ({ id: `${id}-${i}`, pitch, startBeat: 0, durationBeats: 1 / 128, velocity: 100 })),
    });
    const keys = (id: string, clip: Clip): Track => ({
      id, name: id, type: 'instrument', clips: [clip], volume: 0.8, pan: 0, mute: false, solo: false, effects: [],
      instrument: { type: 'synth', preset: 'warmPad' },
    });
    return [keys('f1', loopClip('f1c', 'f1', 256, [60, 61, 62, 63, 64, 65])), keys('f2', loopClip('f2c', 'f2', 26.5 - spare / 64, [66]))];
  };

  it('発音数の上限で拒否する切替は moved を返さず、何も変えず、理由をトーストで出す', async () => {
    const p = song([drumTrack('d', [drum('a', 'd', 0, 0.3, [[1, 'kick']], { stepsPerBar: 12 })]), ...atSoundingLimit()], { lengthBars: 64 });
    expect(soundingEvents(p).events).toHaveLength(100_000);
    const plan = actions.planDrumStepsChange(p, 'a', 16);
    expect(plan).toMatchObject({ ok: false });
    expect(plan && !plan.ok ? plan.reason : '').toContain('100000');
    useStore.getState().applyProjectChange(() => p);
    const before = useStore.getState().project;
    const depth = useStore.getState().past.length;
    const { getBridgeSnapshot } = await import('../src/state/tutorialBridge');
    const toasts = getBridgeSnapshot().toasts.length;
    expect(actions.setDrumStepsPerBar('a', 16)).toBeNull();
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past.length).toBe(depth);
    expect(getBridgeSnapshot().toasts).toHaveLength(toasts + 1);
    expect(getBridgeSnapshot().toasts.at(-1)?.message).toContain('100000');
  });

  it('極端な stepIndex(1.7e308 の 12→16、1e308 の 16→12)は対象範囲外として理由付きで拒否する', () => {
    const huge = song([drumTrack('d', [drum('a', 'd', 0, 4, [[1.7e308, 'kick'], [3, 'snare']], { stepsPerBar: 12 })])]);
    expect(validateProject(huge).errors).toEqual([]);
    refusedOutside(huge, 16);
    refusedOutside(song([drumTrack('d', [drum('a', 'd', 0, 4, [[1e308, 'kick']])])]), 12);
  });

  // ---- レビュー 2 回目の回帰 ----

  it('stepsPerBar 12.5 のクリップを 16 マスにすると、154 tick から 120 tick へ動いた打点を 1 個と数える', () => {
    const p = song([drumTrack('d', [drum('a', 'd', 0, 4, [[1, 'kick']], { stepsPerBar: 12.5 })])]);
    const before = soundingEvents(p).events.map((e) => beatTick(e.startBeat));
    expect(before).toEqual([154]);
    const plan = okPlan(p, 'a', 16);
    expect(plan.moved).toBe(1);
    expect(soundingEvents(plan.project).events.map((e) => beatTick(e.startBeat))).toEqual([120]);
  });

  it('stepsPerBar 14.4 のステップ 9(1200 tick、1120 と 1280 の中間)は後ろへ移り、ステップ 8 とまとめない。3/4 でも曲の拍子で計算する', () => {
    const p = song([drumTrack('d', [drum('a', 'd', 0, 4, [[8, 'kick'], [9, 'kick']], { stepsPerBar: 14.4 })])]);
    const plan = okPlan(p, 'a', 12);
    expect(soundingEvents(plan.project).events.map((e) => beatTick(e.startBeat))).toEqual([1120, 1280]);
    expect(plan).toMatchObject({ merged: 0, moved: 2 });
    const hits: Hit[] = Array.from({ length: 40 }, (_, i) => [i, 'kick']);
    const waltz = song([drumTrack('d', [drum('a', 'd', 0, 9, hits, { stepsPerBar: 14.4 })])], { timeSignature: [3, 4] });
    const expected = resampleDrumSteps(clipOf(waltz, 'a').drumEvents!, 14.4, 16, { beatsPerBar: 3 }).events.map((e) => e.stepIndex);
    expect(clipOf(okPlan(waltz, 'a', 16).project, 'a').drumEvents!.map((e) => e.stepIndex)).toEqual(expected);
  });

  // ---- 対象範囲(レビュー 5 回目、ルートの判断): 細かさ 1〜192、stepIndex 0 以上 2^31 未満の整数 ----

  const refusedOutside = (p: Project, to: number) => {
    const plan = actions.planDrumStepsChange(p, 'a', to);
    expect(plan).toEqual({ ok: false, reason: actions.DRUM_STEPS_FAILURE_MESSAGES.outsideDomain });
  };

  it('stepsPerBar 2^53 で stepIndex 2^48 − 1 と 2^48 の 2 打は、16 マスへの切替を理由付きで拒否する(何も変えない)', () => {
    const p = song([drumTrack('d', [drum('a', 'd', 0, 4, [[2 ** 48 - 1, 'kick'], [2 ** 48, 'kick']], { stepsPerBar: 2 ** 53 })])]);
    expect(validateProject(p).errors).toEqual([]);
    refusedOutside(p, 16);
    expect(actions.DRUM_STEPS_FAILURE_MESSAGES.outsideDomain).toBe('このクリップは細かさの設定が特殊なため、マス数を切り替えられません。');
  });

  it('対象範囲の境界: 細かさ 1 と 192、stepIndex 2^31 − 1 は切り替え、193・0.5・2^31・1000000000000012 は拒否する', () => {
    const clipWith = (stepsPerBar: number, step: number) => song([drumTrack('d', [drum('a', 'd', 0, 4, [[step, 'kick']], { stepsPerBar })])]);
    expect(okPlan(clipWith(1, 0), 'a', 16).moved).toBe(0);
    expect(okPlan(clipWith(192, 2 ** 31 - 1), 'a', 12).ok).toBe(true);
    expect(okPlan(clipWith(16, 2 ** 31 - 1), 'a', 12).ok).toBe(true);
    refusedOutside(clipWith(193, 0), 16);
    refusedOutside(clipWith(0.5, 0), 16);
    refusedOutside(clipWith(16, 2 ** 31), 12);
    refusedOutside(clipWith(14.4, 1000000000000012), 12);
    refusedOutside(clipWith(16, 1), 193);
    refusedOutside(clipWith(16, 1), 12.5);
  });

  it('シード固定ファズ: 対象範囲内では BigInt の式どおりのマスへ移り、範囲外では必ず拒否する', () => {
    const r = mulberry32(31);
    /** from = fn / fd を 10 進の有理数として、tick への丸め(整数でないとき)と最も近いマスを BigInt で求める。 */
    const oracle = (step: number, [fn, fd]: [bigint, bigint], to: number, bpb: number): number => {
      const s = BigInt(step);
      const t = BigInt(to);
      if (fd === 1n) return Number((2n * s * t + fn) / (2n * fn));
      const bar = BigInt(bpb * 480);
      const tick = (2n * s * bar * fd + fn) / (2n * fn);
      return Number((2n * tick * t + bar) / (2n * bar));
    };
    const froms: Array<[number, [bigint, bigint]]> = [
      [16, [16n, 1n]], [12, [12n, 1n]], [1, [1n, 1n]], [192, [192n, 1n]], [7, [7n, 1n]],
      [14.4, [144n, 10n]], [12.5, [125n, 10n]], [191.5, [1915n, 10n]], [1.5, [15n, 10n]],
    ];
    const outsideFroms = [0.5, 193, 2 ** 53, 1e-3, 1e308];
    let inside = 0;
    let outside = 0;
    for (let trial = 0; trial < 400; trial++) {
      const bpb = trial % 2 === 0 ? 4 : 3;
      const to = trial % 3 === 0 ? 12 : 16;
      const fromOutside = trial % 5 === 0;
      const stepOutside = trial % 7 === 0;
      const [from, rational] = fromOutside ? [pick(outsideFroms), null] : froms[trial % froms.length]!;
      if (from === to) continue;
      const lanes: DrumLane[] = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'];
      const hits: Hit[] = lanes.map((lane) => [
        Math.floor(r() < 0.5 ? r() * 64 : r() * 2 ** 31),
        lane,
      ]);
      if (stepOutside) hits[0]![0] = pick([2 ** 31, 2 ** 31 + 1, 2 ** 48, 2 ** 53 - 1, 1e15]);
      const p = song([drumTrack('d', [drum('a', 'd', 0, 1000, hits, { stepsPerBar: from })])], {
        timeSignature: bpb === 4 ? [4, 4] : [3, 4], lengthBars: 250,
      });
      const plan = actions.planDrumStepsChange(p, 'a', to);
      if (fromOutside || stepOutside) {
        outside++;
        expect(plan, `trial ${trial}`).toEqual({ ok: false, reason: actions.DRUM_STEPS_FAILURE_MESSAGES.outsideDomain });
        continue;
      }
      inside++;
      const ok = okPlan(p, 'a', to);
      const steps = clipOf(ok.project, 'a').drumEvents!.map((e) => [e.lane, e.stepIndex]);
      // 鳴る打点(先頭付近)は鳴り続けるよう手前へ回ることがあるので、鳴らない位置の打点だけ式と比べる。
      for (const [step, lane] of hits) {
        const expected = oracle(step, rational!, to, bpb);
        const after = steps.find(([l]) => l === lane)![1] as number;
        if (step * (bpb / from) >= 1000) expect(after, `trial ${trial} ${lane} ${step} ${from}→${to}`).toBe(expected);
        else expect(Math.abs(after - expected)).toBeLessThanOrEqual(to);
      }
    }
    expect(inside).toBeGreaterThan(150);
    expect(outside).toBeGreaterThan(80);

    function pick<T>(items: readonly T[]): T {
      return items[Math.floor(r() * items.length)]!;
    }
  });

  it('同じマスに 80,000 個重なった打点の 12→16(周期 0.3 拍のループ 256 拍)は、展開せずに数秒以内に例外なしで終わる', () => {
    const hits: DrumEvent[] = [
      { id: 'k0', lane: 'kick', stepIndex: 0, velocity: 100 },
      ...Array.from({ length: 80_000 }, (_, i): DrumEvent => ({ id: `k1-${i}`, lane: 'kick', stepIndex: 1, velocity: 100 })),
    ];
    const p = song([drumTrack('d', [{
      ...drum('a', 'd', 0, 256, [], { stepsPerBar: 12, loop: true, contentLengthBeats: 0.3 }),
      drumEvents: hits,
    }])], { lengthBars: 64 });
    expect(findProjectSoundingLimitProblem(p)).toBeUndefined();
    expect(soundingEvents(p).events).toHaveLength(854);
    const started = performance.now();
    const plan = actions.planDrumStepsChange(p, 'a', 16)!;
    expect(performance.now() - started).toBeLessThan(5000);
    // 重複を先にまとめるので、残るのは 2 打点(ステップ 0 と 1)。その発音は上限よりずっと少ない。
    expect(plan).toMatchObject({ ok: true, merged: 79_999, moved: 1 });
    if (plan.ok) {
      expect(clipOf(plan.project, 'a').drumEvents!.map((e) => [e.id, e.stepIndex])).toEqual([['k0', 0], ['k1-0', 1]]);
      expect(findProjectSoundingLimitProblem(plan.project)).toBeUndefined();
    }
  });

  it('まとめた後でも発音数が上限を超える切替は、展開する前に理由付きで拒否する(リンク 120 個 × 7 打点 × 853 周)', () => {
    const lanes: DrumLane[] = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'];
    const source: Clip = {
      ...drum('a', 'd', 0, 256, [], { stepsPerBar: 12, loop: true, contentLengthBeats: 0.3 }),
      drumEvents: [
        { id: 'k0', lane: 'kick', stepIndex: 0, velocity: 100 },
        ...lanes.map((lane, i): DrumEvent => ({ id: `s${i}`, lane, stepIndex: 1, velocity: 100 })),
      ],
    };
    // 切り替え前: 1 打点 × 854 周 × 121 クリップ ≒ 10 万弱。切り替え後: 7 打点ぶんで上限を大きく超える。
    const links = Array.from({ length: 116 }, (_, i): Clip => ({
      id: `l${i}`, trackId: `t${i}`, type: 'drum', startBeat: 0, lengthBeats: 256, loop: true, contentLengthBeats: 0.3, aliasOf: 'a',
    }));
    const p = song([drumTrack('d', [source]), ...links.map((l) => drumTrack(l.trackId, [l]))], { lengthBars: 64 });
    expect(findProjectSoundingLimitProblem(p)).toBeUndefined();
    const started = performance.now();
    const plan = actions.planDrumStepsChange(p, 'a', 16);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(plan).toMatchObject({ ok: false });
    expect(plan && !plan.ok ? plan.reason : '').toContain('100000');
  });

  it('シード固定ファズ: ループ・リンク・3/4 と 4/4・swing 0/50・区切り文字入りの ID・音符入りのドラムクリップ・極端な stepIndex・発音数の上限付近・整数でない stepsPerBar で 16→12→16 の往復を確かめる', () => {
    const r = mulberry32(19019);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
    const lanes: DrumLane[] = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'];
    const idStyles = [(i: number) => `e${i}`, (i: number) => `x|${i}`, (i: number) => `${i}|e`, (i: number) => (i % 2 ? 'a' : 'x|a') + '|'.repeat(i)];
    const seen = { fractional: 0, moves: 0, links: 0, loops: 0, pipes: 0, notes: 0, extreme: 0, limit: 0, rejected: 0 };
    for (let trial = 0; trial < 140; trial++) {
      const timeSignature = pick([[4, 4], [3, 4]] as Array<[number, number]>);
      const bpb = timeSignature[0];
      const swing = pick([0, 50]);
      const nearLimit = trial % 35 === 0;
      const lengthBars = nearLimit ? 64 : int(2, 4);
      const songBeats = lengthBars * bpb;
      const srcLength = pick([bpb, 2 * bpb, 1.3, bpb + 0.3, 2.75, 0.36, 0.3]);
      const srcLoop = r() < 0.4;
      const idOf = pick(idStyles);
      const steps = Array.from({ length: int(1, 14) }, () => int(0, Math.ceil((16 * srcLength) / bpb)));
      const extreme = r() < 0.1;
      if (extreme) steps.push(pick([2 ** 53 - 1, 1e15 + 1, 1e308, 123456789012]));
      const src: Clip = {
        ...drum('s', 'd1', pick([0, 0.5, 1 / 3, 0.25]), srcLength, [],
          srcLoop ? { loop: true, contentLengthBeats: pick([1, 1.5, 0.75, bpb, 1.3]), lengthBeats: srcLength + bpb } : {}),
        drumEvents: steps.map((stepIndex, i) => ({ id: idOf(i), lane: pick(lanes), stepIndex, velocity: 1 + ((i * 41 + trial) % 127) })),
      };
      // 元の細かさは整数でないこともある(stepsPerBar は正の数なら何でも保存できる)。
      const fromSteps = pick([16, 16, 16, 12.5, 13.7, 15.999]);
      src.stepsPerBar = fromSteps;
      seen.fractional += Number(!Number.isInteger(fromSteps));
      // 同じレーン・同じステップの重複と同じ ID は保存データに無い前提なので除く。
      src.drumEvents = src.drumEvents!.filter((e, i, all) =>
        all.findIndex((o) => (o.lane === e.lane && o.stepIndex === e.stepIndex) || o.id === e.id) === i);
      const withNotes = r() < 0.25;
      if (withNotes) src.notes = [{ id: 'n|0', pitch: 60, startBeat: 0, durationBeats: 0.5, velocity: 90 }];
      const srcEnd = src.startBeat + src.lengthBeats;
      const links: Clip[] = Array.from({ length: int(0, 2) }, (_, i) => {
        const loop = r() < 0.4;
        return {
          id: `l|${i}`, trackId: i === 0 ? 'd1' : pick(['d2', 'k']), type: 'drum', aliasOf: 's', loop,
          startBeat: i === 0 ? srcEnd + pick([0, 0.5, 1 / 3]) : pick([0, 0.25, 0.5, 1]),
          lengthBeats: pick([bpb, 1.3, 2.75, 1, 0.36]),
          ...(loop ? { contentLengthBeats: pick([1, 0.75, 1.3]) } : {}),
        } as Clip;
      }).filter((c) => c.startBeat + c.lengthBeats <= songBeats);
      const instrument: Track = {
        id: 'k', name: 'k', type: 'instrument', clips: links.filter((c) => c.trackId === 'k'),
        volume: 0.8, pan: 0, mute: false, solo: false, effects: [], instrument: { type: 'synth', preset: 'warmPad' },
      };
      const build = (spare: number) => song([
        drumTrack('d1', [src, ...links.filter((c) => c.trackId === 'd1')]),
        drumTrack('d2', links.filter((c) => c.trackId === 'd2')),
        instrument,
        ...(nearLimit ? atSoundingLimit(spare) : []),
      ], { timeSignature, lengthBars, ...(swing > 0 ? { swing } : {}) });
      if (srcEnd > songBeats) continue;
      // 上限付近: 曲全体がちょうど上限に収まる最小の余りにする。
      let spare = 0;
      while (nearLimit && findProjectSoundingLimitProblem(build(spare))) spare++;
      const p = build(spare);
      expect(validateProject(p).errors, `trial ${trial}`).toEqual([]);
      seen.links += links.length;
      seen.loops += Number(srcLoop || links.some((c) => c.loop));
      seen.pipes += Number(src.drumEvents.some((e) => e.id.includes('|')));
      seen.notes += Number(withNotes && links.some((c) => c.trackId === 'k'));
      seen.extreme += Number(extreme);
      seen.limit += Number(nearLimit);

      /** Per clip, how often each saved hit (by index) sounds. */
      const counts = (project: Project) => {
        const map = new Map<string, Map<number, number>>();
        for (const e of soundingEvents(project, { sourceClipId: 's', includeMuted: true }).events) {
          if (e.kind !== 'drum') continue;
          const perClip = map.get(e.clipId) ?? new Map<number, number>();
          perClip.set(e.sourceIndex, (perClip.get(e.sourceIndex) ?? 0) + 1);
          map.set(e.clipId, perClip);
        }
        return map;
      };
      const check = (before: Project, to: number): Project | null => {
        const from = clipOf(before, 's').stepsPerBar!;
        const plan = actions.planDrumStepsChange(before, 's', to);
        expect(plan, `trial ${trial} ${from}→${to}`).not.toBeNull();
        if (!plan!.ok) {
          // 拒否してよいのは、あふれる打点か発音数の上限だけ。
          seen.rejected += 1;
          expect(extreme || nearLimit, `trial ${trial}: ${plan!.reason}`).toBe(true);
          return null;
        }
        const old = clipOf(before, 's');
        const next = clipOf(plan!.project, 's');
        expect(next.stepsPerBar).toBe(to);
        expect(next.notes).toEqual(old.notes);
        const oldIndexOf = new Map(old.drumEvents!.map((e, i) => [e, i]));
        // 残った打点の元の添字(同じレーンの中で ID は一意)
        const origin = next.drumEvents!.map((e) => old.drumEvents!.findIndex((o) => o.id === e.id && o.lane === e.lane));
        expect(origin.every((i) => i >= 0)).toBe(true);
        expect(new Set(origin).size).toBe(origin.length);
        // ずれた個数 = 残った打点のうち、共有元での発音 tick(スウィング前)が変わった数
        const moved = next.drumEvents!.filter((e, k) =>
          beatTick(old.startBeat + old.drumEvents![origin[k]!]!.stepIndex * (bpb / from)) !== beatTick(old.startBeat + e.stepIndex * (bpb / to))).length;
        expect(plan!.moved, `trial ${trial} moved`).toBe(moved);
        expect(plan!.merged).toBe(old.drumEvents!.length - next.drumEvents!.length);
        seen.moves += moved;
        for (const e of next.drumEvents!) expect(Number.isInteger(e.stepIndex) && e.stepIndex >= 0).toBe(true);
        // 発音 tick は移動先ステップの tick(各配置・各周)。スウィングはその後に掛かる。
        for (const e of soundingEvents(plan!.project, { sourceClipId: 's', includeMuted: true }).events) {
          if (e.kind !== 'drum') continue;
          const clip = clipOf(plan!.project, e.clipId);
          const period = clip.loop ? clip.contentLengthBeats ?? clip.lengthBeats : 0;
          const local = next.drumEvents![e.sourceIndex]!.stepIndex * (bpb / to);
          const expected = clip.startBeat + ((e.repeat === 0 ? 0 : e.repeat * period) + local);
          expect(beatTick(e.unswungStartBeat), `trial ${trial}`).toBe(beatTick(expected));
          expect(e.startBeat).toBe(swingBeat(e.unswungStartBeat, swing));
        }
        // 残った打点は、どの配置でも鳴る回数が減らない。
        const a = counts(before);
        const b = counts(plan!.project);
        for (const [clipId, perClip] of a) {
          for (const [index, n] of perClip) {
            const k = origin.indexOf(index);
            if (k < 0) continue;
            expect(b.get(clipId)?.get(k) ?? 0, `trial ${trial} ${clipId} #${index}`).toBeGreaterThanOrEqual(n);
          }
        }
        expect(oldIndexOf.size).toBe(old.drumEvents!.length);
        expect(validateProject(plan!.project).errors).toEqual([]);
        return plan!.project;
      };
      const there = check(p, 12);
      if (!there) continue;
      const back = check(there, 16);
      if (!back || fromSteps !== 16) continue;
      // 16 の 4 の倍数(拍と 8 分の位置)は往復で元のステップに戻る(安全な整数の範囲)。
      for (const e of clipOf(back, 's').drumEvents!) {
        const original = src.drumEvents.find((o) => o.id === e.id && o.lane === e.lane)!.stepIndex;
        if (Number.isSafeInteger(original) && original % 4 === 0) expect(e.stepIndex, `trial ${trial}`).toBe(original);
      }
    }
    expect(seen.moves).toBeGreaterThan(100);
    expect(seen.links).toBeGreaterThan(30);
    expect(seen.loops).toBeGreaterThan(30);
    expect(seen.pipes).toBeGreaterThan(30);
    expect(seen.notes).toBeGreaterThanOrEqual(3);
    expect(seen.extreme).toBeGreaterThan(5);
    expect(seen.limit).toBeGreaterThanOrEqual(3);
    expect(seen.fractional).toBeGreaterThan(20);
  });
});

describe('changeInstrumentPreset / changeInstrumentMacros', () => {
  const chordsTrack = () => useStore.getState().project.tracks.find((t) => t.role === 'chords')!;
  const macros = { brightness: 0.9, release: 0.3, width: 0.6, attack: 0.2 };

  it('switches the preset as one undo step', () => {
    const before = useStore.getState().project;
    const pastLength = useStore.getState().past.length;
    expect(actions.changeInstrumentPreset(chordsTrack().id, 'stringsLike')).toBe(true);
    expect(chordsTrack().instrument?.preset).toBe('stringsLike');
    expect(useStore.getState().past.length).toBe(pastLength + 1);
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before);
  });

  it('does nothing for the same preset', () => {
    const pastLength = useStore.getState().past.length;
    expect(actions.changeInstrumentPreset(chordsTrack().id, chordsTrack().instrument!.preset)).toBe(false);
    expect(useStore.getState().past.length).toBe(pastLength);
  });

  it('sets and clears macros, each an undoable step', () => {
    const before = useStore.getState().project;
    expect(actions.changeInstrumentMacros(chordsTrack().id, macros)).toBe(true);
    expect(chordsTrack().instrument?.macros).toEqual(macros);
    expect(validateProject(useStore.getState().project).valid).toBe(true);
    useStore.getState().commitTransaction();
    expect(actions.changeInstrumentMacros(chordsTrack().id, undefined)).toBe(true);
    expect(chordsTrack().instrument).not.toHaveProperty('macros');
    useStore.getState().commitTransaction();
    useStore.getState().undo();
    expect(chordsTrack().instrument?.macros).toEqual(macros);
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before);
  });

  it('groups a slider drag (one open transaction) into a single undo step', () => {
    const before = useStore.getState().project;
    const owner = {};
    useStore.getState().beginTransaction(owner);
    for (const brightness of [0.6, 0.7, 0.8]) actions.changeInstrumentMacros(chordsTrack().id, { ...macros, brightness });
    useStore.getState().commitTransaction(owner);
    expect(chordsTrack().instrument?.macros?.brightness).toBe(0.8);
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before);
  });
});

describe('shared return editing', () => {
  it('removes every send to a deleted return as one undo step', () => {
    const store = useStore.getState();
    store.addReverbReturn();
    store.addReverbReturn();
    const [room, echo] = useStore.getState().project.tracks.filter((track) => track.type === 'bus');
    const [first, second] = store.project.tracks;
    store.setTrackSend(first!.id, room!.id, 0.4);
    store.setTrackSend(first!.id, echo!.id, 0.6);
    store.setTrackSend(second!.id, room!.id, 0.2);
    const before = useStore.getState();
    store.removeTrack(room!.id);
    const after = useStore.getState();
    expect(after.past).toHaveLength(before.past.length + 1);
    expect(after.project.tracks.some((track) => track.id === room!.id)).toBe(false);
    expect(after.project.tracks.every((track) => !Object.hasOwn(track.sends ?? {}, room!.id))).toBe(true);
    expect(after.project.tracks[0]!.sends).toEqual({ [echo!.id]: 0.6 });
    store.undo();
    expect(useStore.getState().project).toEqual(before.project);
  });

  it('refuses clip and note creation on a return without changing history', () => {
    const store = useStore.getState();
    store.addReverbReturn();
    const before = useStore.getState();
    const room = before.project.tracks.find((track) => track.type === 'bus')!;
    const clip: Clip = { id: 'invalid', trackId: room.id, type: 'midi', startBeat: 0, lengthBeats: 4, loop: false };
    expect(actions.addEmptyClipAt(room.id, 0, 8)).toBeNull();
    expect(store.applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => track.id === room.id ? { ...track, clips: [clip] } : track),
    }))).toBe(false);
    expect(store.addNote(clip.id, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 })).toBe(false);
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toBe(before.past);
  });
});
