import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ParsedMidi } from '@cts/midi-io';
import { checkProjectPredicate } from '@cts/tutorial-engine';
import { expandClip } from '@cts/project-model';
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

describe('generation into a short clip (every generated note sounds)', () => {
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
    it(`${label}: a 4-beat clip is lengthened so all notes sound, and one undo restores notes and length`, () => {
      const clipId = clipIdOf();
      shortenClip(clipId);
      const before = useStore.getState().project;

      const generated = generate(clipId);

      expect(generated.some((n) => n.startBeat + n.durationBeats > 4)).toBe(true);
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
