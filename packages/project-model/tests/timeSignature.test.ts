import { describe, it, expect } from 'vitest';
import {
  addChordEvent,
  addNoteToClip,
  addSection,
  beatsPerBar,
  contentBeyondBars,
  createDefaultProject,
  setLengthBars,
  setTimeSignature,
  toggleDrumStep,
} from '../src/index';
import type { Clip, Project } from '../src/index';

const t0 = () => new Date('2026-06-11T00:00:00.000Z');
const t1 = () => new Date('2026-06-11T01:00:00.000Z');

function midiClip(project: Project): Clip {
  const clip = project.tracks.find((t) => t.type === 'instrument')?.clips[0];
  if (!clip) throw new Error('no midi clip');
  return clip;
}

function drumClip(project: Project): Clip {
  const clip = project.tracks.find((t) => t.type === 'drum')?.clips[0];
  if (!clip) throw new Error('no drum clip');
  return clip;
}

/** 8 bars of 4/4 (32 beats) with notes, chords, drum hits and sections. */
function songInFourFour(): Project {
  let project = createDefaultProject({ lengthBars: 8, timeSignature: [4, 4] });
  const clipId = midiClip(project).id;
  project = addNoteToClip(project, clipId, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }, t0);
  project = addNoteToClip(project, clipId, { pitch: 64, startBeat: 13.5, durationBeats: 0.5, velocity: 90 }, t0);
  project = addNoteToClip(project, clipId, { pitch: 67, startBeat: 31, durationBeats: 1, velocity: 80 }, t0);
  project = addChordEvent(project, { startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [60, 64, 67] }, t0);
  project = addChordEvent(project, { startBeat: 28, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [67, 71, 74] }, t0);
  const drums = drumClip(project).id;
  project = toggleDrumStep(project, drums, 'kick', 0, 100, t0);
  project = toggleDrumStep(project, drums, 'snare', 4, 100, t0);
  project = toggleDrumStep(project, drums, 'closedHat', 22, 100, t0);
  project = toggleDrumStep(project, drums, 'kick', 120, 100, t0);
  return project;
}

describe('setTimeSignature', () => {
  it('keeps every beat position and rounds the song length up when going 4/4 -> 3/4', () => {
    const before = songInFourFour();
    const { project, warnings } = setTimeSignature(before, [3, 4], t1);

    expect(project.timeSignature).toEqual([3, 4]);
    // 32 beats / 3 beats per bar = 10.67 -> 11 bars, nothing is dropped.
    expect(project.lengthBars).toBe(11);
    expect(beatsPerBar(project.timeSignature)).toBe(3);
    expect(project.updatedAt).toBe('2026-06-11T01:00:00.000Z');

    const notesBefore = midiClip(before).notes?.map((n) => n.startBeat);
    const notesAfter = midiClip(project).notes?.map((n) => n.startBeat);
    expect(notesAfter).toEqual(notesBefore);
    expect(project.chordTrack.map((c) => c.startBeat)).toEqual(before.chordTrack.map((c) => c.startBeat));

    // Drum grid: 3 beats x 4 steps = 12 steps per bar; each hit keeps its beat.
    const drumsAfter = drumClip(project);
    expect(drumsAfter.stepsPerBar).toBe(12);
    const hitBeats = (clip: Clip, bpb: number) =>
      clip.drumEvents?.map((e) => [e.lane, e.stepIndex * (bpb / (clip.stepsPerBar ?? 16))]);
    expect(hitBeats(drumsAfter, 3)).toEqual(hitBeats(drumClip(before), 4));
    const lastKick = drumsAfter.drumEvents?.filter((e) => e.lane === 'kick').map((e) => e.stepIndex);
    // step 120 of 16 per bar = beat 30 -> step 120 of 12 per bar (4 steps per beat either way).
    expect(lastKick).toEqual([0, 120]);
    expect(warnings).toEqual([]);
  });

  it('is exact for the signatures the product supports', () => {
    expect(beatsPerBar([4, 4])).toBe(4);
    expect(beatsPerBar([3, 4])).toBe(3);
    expect(beatsPerBar([6, 8])).toBe(3);
    const { project } = setTimeSignature(songInFourFour(), [6, 8], t1);
    expect(project.lengthBars).toBe(11);
    expect(drumClip(project).stepsPerBar).toBe(12);
  });

  it('converts sections by beat and warns in Japanese when a boundary does not land on a bar', () => {
    let before = songInFourFour();
    before = addSection(before, { name: 'Aメロ', type: 'verse', startBar: 0, lengthBars: 4 }, t0);
    before = addSection(before, { name: 'サビ', type: 'chorus', startBar: 4, lengthBars: 4 }, t0);
    const { project, warnings } = setTimeSignature(before, [3, 4], t1);

    // Beat 16 is bar 5.33 in 3/4: not a bar boundary.
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => /セクション/.test(w) && /[぀-ヿ一-龯]/.test(w))).toBe(true);
    expect(project.sections.map((s) => [s.startBar, s.lengthBars])).toEqual([
      [0, 5],
      [5, 6],
    ]);
  });

  it('keeps sections exactly when the boundaries divide evenly', () => {
    let before = createDefaultProject({ lengthBars: 6, timeSignature: [4, 4] });
    before = addSection(before, { name: 'A', type: 'verse', startBar: 0, lengthBars: 3 }, t0);
    before = addSection(before, { name: 'B', type: 'chorus', startBar: 3, lengthBars: 3 }, t0);
    const { project, warnings } = setTimeSignature(before, [3, 4], t1);
    expect(warnings).toEqual([]);
    expect(project.sections.map((s) => [s.startBar, s.lengthBars])).toEqual([
      [0, 4],
      [4, 4],
    ]);
    expect(project.lengthBars).toBe(8);
  });

  it('snaps hits that do not fit the new grid and counts them in a warning', () => {
    let before = createDefaultProject({ lengthBars: 1, timeSignature: [4, 4] });
    const drums = drumClip(before).id;
    before = {
      ...before,
      tracks: before.tracks.map((t) =>
        t.type === 'drum' ? { ...t, clips: t.clips.map((c) => ({ ...c, stepsPerBar: 12 })) } : t,
      ),
    };
    // 12 steps in 4/4 = triplet grid; step 1 is beat 1/3, which has no 16th position.
    before = toggleDrumStep(before, drums, 'kick', 0, 100, t0);
    before = toggleDrumStep(before, drums, 'kick', 1, 100, t0);
    before = toggleDrumStep(before, drums, 'snare', 6, 100, t0);
    const { project, warnings } = setTimeSignature(before, [3, 4], t1);
    expect(drumClip(project).stepsPerBar).toBe(12);
    const steps = drumClip(project).drumEvents?.map((e) => [e.lane, e.stepIndex]);
    expect(steps).toEqual([
      ['kick', 0],
      ['kick', 1],
      ['snare', 8],
    ]);
    expect(warnings.some((w) => w.includes('1') && w.includes('ドラム'))).toBe(true);
  });

  describe('hits that collide on the coarser grid', () => {
    /** 4/4, one bar, kick hits on a finer grid than the 16 steps per bar the change goes to. */
    function fineKit(stepsPerBar: number, hits: Array<[step: number, velocity: number]>): Project {
      let before = createDefaultProject({ lengthBars: 1, timeSignature: [4, 4] });
      const drums = drumClip(before).id;
      before = {
        ...before,
        tracks: before.tracks.map((t) =>
          t.type === 'drum' ? { ...t, clips: t.clips.map((c) => ({ ...c, stepsPerBar })) } : t,
        ),
      };
      for (const [step, velocity] of hits) before = toggleDrumStep(before, drums, 'kick', step, velocity, t0);
      return before;
    }

    it('keeps the hit that was on the beat over the one that had to move, counts the drop and warns', () => {
      // 32 steps per bar: step 1 = beat 1/8 (off the 16th grid), step 2 = beat 1/4 (on it); both round to new step 1.
      const { project, warnings, droppedHits } = setTimeSignature(fineKit(32, [[1, 20], [2, 127]]), [3, 4], t1);
      expect(drumClip(project).drumEvents?.map((e) => [e.stepIndex, e.velocity])).toEqual([[1, 127]]);
      expect(droppedHits).toBe(1);
      expect(warnings.some((w) => w.includes('1') && w.includes('重なる'))).toBe(true);
      // The surviving hit did not move, so no "moved" warning.
      expect(warnings.some((w) => w.includes('動かしました'))).toBe(false);
    });

    it('does not depend on the order the events are stored in', () => {
      const { project: a } = setTimeSignature(fineKit(32, [[1, 20], [2, 127]]), [3, 4], t1);
      const { project: b } = setTimeSignature(fineKit(32, [[2, 127], [1, 20]]), [3, 4], t1);
      const hits = (p: Project) => drumClip(p).drumEvents?.map((e) => [e.stepIndex, e.velocity]);
      expect(hits(a)).toEqual([[1, 127]]);
      expect(hits(b)).toEqual([[1, 127]]);
    });

    it('keeps the louder hit when both had to move, whichever comes first', () => {
      // 48 steps per bar: steps 2 and 4 = beats 1/6 and 1/3, both off the 16th grid, both round to new step 1.
      const hits = (p: Project) => drumClip(p).drumEvents?.map((e) => [e.stepIndex, e.velocity]);
      const { project, droppedHits, warnings } = setTimeSignature(fineKit(48, [[2, 40], [4, 90]]), [3, 4], t1);
      expect(hits(project)).toEqual([[1, 90]]);
      expect(droppedHits).toBe(1);
      expect(warnings.some((w) => w.includes('1') && w.includes('動かしました'))).toBe(true);
      expect(hits(setTimeSignature(fineKit(48, [[4, 90], [2, 40]]), [3, 4], t1).project)).toEqual([[1, 90]]);
    });

    it('keeps the earlier hit when both moved and are equally loud', () => {
      const before = fineKit(48, [[4, 90], [2, 90]]);
      const earlierId = drumClip(before).drumEvents?.[1]?.id;
      const { project } = setTimeSignature(before, [3, 4], t1);
      expect(drumClip(project).drumEvents?.map((e) => [e.id, e.stepIndex])).toEqual([[earlierId, 1]]);
    });

    it('reports no drop when every hit lands on its own step', () => {
      const { droppedHits, warnings } = setTimeSignature(songInFourFour(), [3, 4], t1);
      expect(droppedHits).toBe(0);
      expect(warnings.some((w) => w.includes('重なる'))).toBe(false);
    });
  });

  it('grows clips that ended with the song to the rounded-up end, so lengthening later still extends them', () => {
    const { project } = setTimeSignature(songInFourFour(), [3, 4], t1);
    // 8 bars of 4/4 (32 beats) -> 11 bars of 3/4 (33 beats): the full-length clips follow.
    expect(drumClip(project).lengthBeats).toBe(33);
    expect(midiClip(project).lengthBeats).toBe(33);

    const longer = setLengthBars(project, 16, t1);
    expect(drumClip(longer).lengthBeats).toBe(48);
    expect(midiClip(longer).lengthBeats).toBe(48);
  });

  it('leaves a clip that ended before the song alone', () => {
    let before = songInFourFour();
    before = {
      ...before,
      tracks: before.tracks.map((t) =>
        t.type === 'drum' ? { ...t, clips: t.clips.map((c) => ({ ...c, lengthBeats: 8 })) } : t,
      ),
    };
    const { project } = setTimeSignature(before, [3, 4], t1);
    expect(drumClip(project).lengthBeats).toBe(8);
  });

  it('covers every rounded-up bar when 11 bars of 3/4 become 9 bars of 4/4', () => {
    const before = createDefaultProject({ lengthBars: 11, timeSignature: [3, 4] });
    expect(drumClip(before).lengthBeats).toBe(33);
    const { project } = setTimeSignature(before, [4, 4], t1);
    expect(project.lengthBars).toBe(9);
    expect(drumClip(project).lengthBeats).toBe(36);
  });

  it('returns the same lengthBars when going back and forth between equal bar lengths', () => {
    const { project } = setTimeSignature(songInFourFour(), [2, 2], t1);
    expect(project.lengthBars).toBe(8);
    expect(drumClip(project).stepsPerBar).toBe(16);
  });

  it('counts a drum hit that rounds onto the new song end as dropped and removes it', () => {
    // 8 bars of 3/4 (24 beats), 32 steps per bar: step 255 sits at beat 23.906.
    let before = createDefaultProject({ lengthBars: 8, timeSignature: [3, 4] });
    const drums = drumClip(before).id;
    before = {
      ...before,
      tracks: before.tracks.map((t) =>
        t.type === 'drum'
          ? { ...t, clips: t.clips.map((c) => ({ ...c, stepsPerBar: 32, drumEvents: [] })) }
          : t,
      ),
    };
    before = toggleDrumStep(before, drums, 'kick', 255, 100, t0);
    before = toggleDrumStep(before, drums, 'kick', 0, 100, t0);

    const { project, warnings, droppedHits } = setTimeSignature(before, [4, 4], t1);

    // 24 beats in 4/4 = 6 bars; the 16-step grid rounds beat 23.906 to step 96 = beat 24 = the end.
    expect(project.lengthBars).toBe(6);
    expect(droppedHits).toBe(1);
    const clip = drumClip(project);
    expect(clip.drumEvents?.map((e) => e.stepIndex)).toEqual([0]);
    const endStep = (project.lengthBars * 4 * (clip.stepsPerBar ?? 16)) / 4;
    expect(clip.drumEvents?.every((e) => e.stepIndex < endStep)).toBe(true);
    expect(warnings.some((w) => /ドラム/.test(w) && /曲の終わり/.test(w))).toBe(true);
  });

  it('keeps every section inside the song when a section would start at or after the new end', () => {
    // 8 bars of 2/4 = 16 beats -> 4 bars of 4/4. The last section (bar 7, beats 14-16)
    // snaps to bar 4 (= the new end) without a clamp.
    let before = createDefaultProject({ lengthBars: 8, timeSignature: [2, 4] });
    before = addSection(before, { name: 'Aメロ', type: 'verse', startBar: 0, lengthBars: 7 }, t0);
    before = addSection(before, { name: 'おわり', type: 'outro', startBar: 7, lengthBars: 1 }, t0);
    const { project, warnings } = setTimeSignature(before, [4, 4], t1);

    expect(project.lengthBars).toBe(4);
    for (const s of project.sections) {
      expect(s.startBar).toBeGreaterThanOrEqual(0);
      expect(s.lengthBars).toBeGreaterThanOrEqual(1);
      expect(s.startBar + s.lengthBars).toBeLessThanOrEqual(project.lengthBars);
    }
    // The section that no longer fits is merged into the one before it, which runs to the end.
    expect(project.sections.map((s) => [s.name, s.startBar, s.lengthBars])).toEqual([['Aメロ', 0, 4]]);
    expect(warnings.some((w) => /セクション「おわり」/.test(w) && /曲の終わり/.test(w) && /「Aメロ」/.test(w))).toBe(true);
  });

  it('keeps a lone section that would start past the new end on the last bar', () => {
    let before = createDefaultProject({ lengthBars: 8, timeSignature: [2, 4] });
    before = addSection(before, { name: 'おわり', type: 'outro', startBar: 7, lengthBars: 1 }, t0);
    const { project, warnings } = setTimeSignature(before, [4, 4], t1);

    expect(project.sections.map((s) => [s.name, s.startBar, s.lengthBars])).toEqual([['おわり', 3, 1]]);
    expect(warnings.some((w) => /セクション「おわり」/.test(w) && /曲の終わり/.test(w))).toBe(true);
  });
});

describe('contentBeyondBars / setLengthBars', () => {
  it('counts notes, chords, drum hits and sections that start past the new end', () => {
    let project = songInFourFour();
    project = addSection(project, { name: 'A', type: 'verse', startBar: 0, lengthBars: 4 }, t0);
    project = addSection(project, { name: 'B', type: 'chorus', startBar: 4, lengthBars: 4 }, t0);
    const none = { notes: 0, chords: 0, drumHits: 0, sections: 0, truncatedNotes: 0, truncatedChords: 0 };
    expect(contentBeyondBars(project, 4)).toEqual({ ...none, notes: 1, chords: 1, drumHits: 1, sections: 1 });
    expect(contentBeyondBars(project, 5)).toEqual({ ...none, notes: 1, chords: 1, drumHits: 1, sections: 0 });
    expect(contentBeyondBars(project, 8)).toEqual(none);
    expect(contentBeyondBars(project, 16)).toEqual(none);
  });

  /** songInFourFour plus a note (beat 15, 8 beats) and a chord (beat 14, 4 beats) that cross the 4-bar line. */
  function songWithCrossingContent(): Project {
    let project = songInFourFour();
    const clipId = midiClip(project).id;
    project = addNoteToClip(project, clipId, { pitch: 62, startBeat: 15, durationBeats: 8, velocity: 100 }, t0);
    project = addChordEvent(project, { startBeat: 14, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [65, 69, 72] }, t0);
    return project;
  }

  it('counts notes and chords that start before the new end but run past it as truncated', () => {
    const project = songWithCrossingContent();
    expect(contentBeyondBars(project, 4)).toEqual({
      notes: 1,
      chords: 1,
      drumHits: 1,
      sections: 0,
      truncatedNotes: 1,
      truncatedChords: 1,
    });
    // At 6 bars (24 beats) the note ends exactly at the line: nothing crosses.
    expect(contentBeyondBars(project, 6).truncatedNotes).toBe(0);
    expect(contentBeyondBars(project, 6).truncatedChords).toBe(0);
  });

  it('cuts crossing notes and chords at the new end so they agree with the clip and song length', () => {
    const project = setLengthBars(songWithCrossingContent(), 4, t1);
    const clip = midiClip(project);
    const crossing = clip.notes?.find((n) => n.startBeat === 15);
    expect(crossing?.durationBeats).toBe(1);
    expect(clip.lengthBeats).toBe(16);
    // Every note (what MIDI export writes as note-off) ends by the song end.
    const songEnd = project.lengthBars * beatsPerBar(project.timeSignature);
    for (const note of clip.notes ?? []) {
      expect(clip.startBeat + note.startBeat + note.durationBeats).toBeLessThanOrEqual(songEnd);
    }
    const chordF = project.chordTrack.find((c) => c.symbol === 'F');
    expect(chordF?.durationBeats).toBe(2);
    // Content that already fit is untouched.
    expect(clip.notes?.find((n) => n.startBeat === 13.5)?.durationBeats).toBe(0.5);
    expect(project.chordTrack.find((c) => c.symbol === 'C')?.durationBeats).toBe(4);
  });

  it('cuts a crossing note at the song end even when its clip starts later', () => {
    let before = createDefaultProject({ lengthBars: 8, timeSignature: [4, 4] });
    const clipId = midiClip(before).id;
    before = {
      ...before,
      tracks: before.tracks.map((t) =>
        t.type === 'instrument'
          ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, startBeat: 8, lengthBeats: 24 } : c)) }
          : t,
      ),
    };
    before = addNoteToClip(before, clipId, { pitch: 60, startBeat: 6, durationBeats: 4, velocity: 100 }, t0);
    expect(contentBeyondBars(before, 4).truncatedNotes).toBe(1);
    const project = setLengthBars(before, 4, t1);
    // Absolute start 14, song end 16: 2 beats remain.
    expect(midiClip(project).notes?.[0]?.durationBeats).toBe(2);
    expect(midiClip(project).lengthBeats).toBe(8);
  });

  it('shortening removes content past the end and trims clips and sections', () => {
    let before = songInFourFour();
    before = addSection(before, { name: 'A', type: 'verse', startBar: 0, lengthBars: 6 }, t0);
    before = addSection(before, { name: 'B', type: 'chorus', startBar: 6, lengthBars: 2 }, t0);
    const project = setLengthBars(before, 4, t1);

    expect(project.lengthBars).toBe(4);
    expect(midiClip(project).notes?.map((n) => n.startBeat)).toEqual([0, 13.5]);
    expect(midiClip(project).lengthBeats).toBe(16);
    expect(project.chordTrack.map((c) => c.symbol)).toEqual(['C']);
    expect(drumClip(project).drumEvents?.map((e) => e.stepIndex)).toEqual([0, 4, 22]);
    expect(drumClip(project).lengthBeats).toBe(16);
    expect(project.sections.map((s) => [s.startBar, s.lengthBars])).toEqual([[0, 4]]);
    expect(project.updatedAt).toBe('2026-06-11T01:00:00.000Z');
  });

  it('lengthening keeps everything and grows clips that ended with the song', () => {
    const before = songInFourFour();
    const project = setLengthBars(before, 16, t1);
    expect(project.lengthBars).toBe(16);
    expect(midiClip(project).notes?.length).toBe(3);
    expect(midiClip(project).lengthBeats).toBe(64);
    expect(drumClip(project).lengthBeats).toBe(64);
    expect(project.chordTrack.length).toBe(2);
  });

  it('leaves a shorter clip alone when the song grows', () => {
    let before = songInFourFour();
    before = {
      ...before,
      tracks: before.tracks.map((t) =>
        t.type === 'instrument' ? { ...t, clips: t.clips.map((c) => ({ ...c, lengthBeats: 8 })) } : t,
      ),
    };
    const project = setLengthBars(before, 16, t1);
    expect(midiClip(project).lengthBeats).toBe(8);
  });
});
