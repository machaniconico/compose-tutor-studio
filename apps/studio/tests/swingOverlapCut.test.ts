// スウィングで同じ高さの次の音に食い込む音は、次の音の鳴り始めで切る(#78 / docs/02)。
// 再生(buildScheduleEvents)・WAV・MIDI 書き出し・編集の事後確認が同じ規則で動くことを確かめる。
import { describe, expect, it } from 'vitest';
import {
  createEmptyProject,
  cutSwingOverlaps,
  PPQ,
  type Clip,
  type DrumEvent,
  type NoteEvent,
  type Project,
  type Track,
} from '@cts/project-model';
import { parseMidiFile, projectToMidiResult } from '@cts/midi-io';
import { buildScheduleEvents, type NoteScheduleEvent } from '../src/audio/events';
import { buildWavScheduleEvents } from '../src/audio/wav';
import { transposeNotesInProject } from '../src/state/noteEditActions';

type Spec = [id: string, pitch: number, startBeat: number, durationBeats: number];

function melodyProject(
  specs: readonly Spec[],
  over: { swing?: number; loop?: boolean; lengthBeats?: number; drumSwing?: number } = {},
): Project {
  const base = createEmptyProject({ key: 'C', scale: 'major' });
  const notes: NoteEvent[] = specs.map(([id, pitch, startBeat, durationBeats]) => ({
    id, pitch, startBeat, durationBeats, velocity: 90,
  }));
  const tracks = base.tracks.map((track): Track => {
    if (track.type === 'instrument' && track.role === 'learning.melody') {
      const clip: Clip = {
        id: 'mel', trackId: track.id, type: 'midi', startBeat: 0, lengthBeats: over.lengthBeats ?? 8,
        loop: over.loop ?? false, notes,
      };
      return { ...track, clips: [clip] };
    }
    if (track.type === 'drum' && over.drumSwing !== undefined) {
      const drumEvents: DrumEvent[] = [1, 2, 3].map((stepIndex) => ({
        id: `d${stepIndex}`, lane: 'closedHat', stepIndex, velocity: 100,
      }));
      const clip: Clip = {
        id: 'dr', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 4, loop: false,
        stepsPerBar: 16, drumEvents,
        drumGroove: { swing: over.drumSwing, probability: 1, humanizeVelocity: 0, seed: 1 },
      };
      return { ...track, clips: [clip] };
    }
    return { ...track, clips: [] };
  });
  return { ...base, tracks, chordTrack: [], swing: over.swing ?? 0 };
}

function melodyNotes(project: Project, pitch: number): Array<{ beat: number; durationBeats: number }> {
  return buildScheduleEvents(project)
    .filter((event) => {
      const payload = event.payload as NoteScheduleEvent;
      return payload.kind === 'note' && payload.pitch === pitch;
    })
    .map((event) => ({ beat: event.beat, durationBeats: (event.payload as NoteScheduleEvent).durationBeats }))
    .sort((a, b) => a.beat - b.beat);
}

// 16 分の奇数番目(0.25 拍)は swing 50 で 60 tick(0.125 拍)遅れる。
// A は 0.25〜0.5 → 鳴るのは 0.375〜0.625、B は 0.5 から。書いた位置では接しているだけ。
const ADJACENT: Spec[] = [['a', 60, 0.25, 0.25], ['b', 60, 0.5, 0.25]];

describe('swing overlap cut: playback (buildScheduleEvents)', () => {
  it('cuts the earlier note at the next same-pitch onset when swing makes them overlap', () => {
    const notes = melodyNotes(melodyProject(ADJACENT, { swing: 50 }), 60);
    expect(notes).toEqual([
      { beat: 0.375, durationBeats: 0.125 },
      { beat: 0.5, durationBeats: 0.25 },
    ]);
  });

  it('leaves notes alone at swing 0 and when swing makes no overlap', () => {
    expect(melodyNotes(melodyProject(ADJACENT, { swing: 0 }), 60)).toEqual([
      { beat: 0.25, durationBeats: 0.25 },
      { beat: 0.5, durationBeats: 0.25 },
    ]);
    const apart: Spec[] = [['a', 60, 0.25, 0.25], ['b', 60, 1, 0.25]];
    expect(melodyNotes(melodyProject(apart, { swing: 50 }), 60)[0]).toEqual({ beat: 0.375, durationBeats: 0.25 });
  });

  it('keeps the existing behaviour when the notes already overlap in the stored grid', () => {
    const stored: Spec[] = [['a', 60, 0.25, 0.5], ['b', 60, 0.5, 0.25]];
    expect(melodyNotes(melodyProject(stored, { swing: 50 }), 60)[0]).toEqual({ beat: 0.375, durationBeats: 0.5 });
  });

  it('does not touch a different pitch', () => {
    const other: Spec[] = [['a', 60, 0.25, 0.25], ['b', 62, 0.5, 0.25]];
    expect(melodyNotes(melodyProject(other, { swing: 50 }), 60)[0]).toEqual({ beat: 0.375, durationBeats: 0.25 });
  });

  it('applies the cut in every pass of a looping clip', () => {
    // 1 拍の周期(最後の音 c が 0.75〜1)。2 周目は 1.25 / 1.5 から。
    const loop: Spec[] = [...ADJACENT, ['c', 72, 0.75, 0.25]];
    const notes = melodyNotes(melodyProject(loop, { swing: 50, loop: true, lengthBeats: 3 }), 60);
    expect(notes).toEqual([
      { beat: 0.375, durationBeats: 0.125 },
      { beat: 0.5, durationBeats: 0.25 },
      { beat: 1.375, durationBeats: 0.125 },
      { beat: 1.5, durationBeats: 0.25 },
      { beat: 2.375, durationBeats: 0.125 },
      { beat: 2.5, durationBeats: 0.25 },
    ]);
  });

  it('WAV renders the same events as playback', () => {
    const project = melodyProject(ADJACENT, { swing: 50 });
    const wav = buildWavScheduleEvents(project)
      .filter((event) => (event.payload as NoteScheduleEvent).pitch === 60)
      .map((event) => [event.beat, (event.payload as NoteScheduleEvent).durationBeats]);
    expect(wav).toEqual([[0.375, 0.125], [0.5, 0.25]]);
  });
});

describe('swing overlap cut: MIDI export', () => {
  it('writes the cut length and exports instead of refusing the overlap', () => {
    const result = projectToMidiResult(melodyProject(ADJACENT, { swing: 50 }));
    if (!result.ok) throw new Error(result.error.message);
    const notes = parseMidiFile(result.bytes).tracks.flatMap((track) => track.notes).filter((n) => n.pitch === 60);
    expect(notes.map((n) => [n.startTick, n.durationTick])).toEqual([
      [0.375 * PPQ, 0.125 * PPQ],
      [0.5 * PPQ, 0.25 * PPQ],
    ]);
  });

  it('still refuses a stored (no-swing) same-pitch overlap', () => {
    const stored: Spec[] = [['a', 60, 0.25, 0.5], ['b', 60, 0.5, 0.25]];
    const result = projectToMidiResult(melodyProject(stored, { swing: 0 }));
    expect(result.ok).toBe(false);
  });
});

describe('swing overlap cut: drum clip swing', () => {
  it('exports a swung drum clip next to a cut melody, with no same-pitch overlap in the drums', () => {
    const project = { ...melodyProject(ADJACENT, { swing: 50, drumSwing: 60 }) };
    const result = projectToMidiResult(project);
    if (!result.ok) throw new Error(result.error.message);
    const notes = parseMidiFile(result.bytes).tracks.flatMap((track) => track.notes);
    const hats = notes.filter((n) => n.channel === 9).sort((x, y) => x.startTick - y.startTick);
    expect(hats.length).toBeGreaterThan(0);
    hats.slice(1).forEach((hat, i) => {
      expect(hat.startTick).toBeGreaterThanOrEqual(hats[i]!.startTick + hats[i]!.durationTick);
    });
    expect(notes.filter((n) => n.pitch === 60 && n.channel !== 9).map((n) => n.durationTick)).toEqual([
      0.125 * PPQ,
      0.25 * PPQ,
    ]);
  });
});

describe('swing overlap cut: edit checks (#78)', () => {
  const lowered = (project: Project) => transposeNotesInProject(project, 'mel', ['a'], { semitones: -2 });

  it('allows moving a note to the same pitch as its neighbour when only swing makes them overlap', () => {
    const outcome = transposeNotesInProject(
      melodyProject([['a', 62, 0.25, 0.25], ['b', 60, 0.5, 0.25]], { swing: 50 }),
      'mel', ['a'], { semitones: -2 },
    );
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.changed).toBe(true);
    expect(melodyNotes(outcome.project, 60)).toEqual([
      { beat: 0.375, durationBeats: 0.125 },
      { beat: 0.5, durationBeats: 0.25 },
    ]);
  });

  it('still refuses a stored overlap without swing', () => {
    const outcome = lowered(melodyProject([['a', 62, 0, 1], ['b', 60, 0.5, 1]], { swing: 0 }));
    expect(outcome.ok).toBe(false);
  });

  it('still refuses a stored overlap with swing on', () => {
    const outcome = lowered(melodyProject([['a', 62, 0.25, 0.5], ['b', 60, 0.5, 1]], { swing: 50 }));
    expect(outcome.ok).toBe(false);
  });
});

describe('cutSwingOverlaps (shared rule)', () => {
  const span = (onsetTick: number, endTick: number, sourceStartTick: number, sourceEndTick: number) =>
    ({ onsetTick, endTick, sourceStartTick, sourceEndTick });

  it('keeps the sounding length at least 1 tick', () => {
    const cut = cutSwingOverlaps([
      { group: 'p', span: span(100, 200, 0, 100) },
      { group: 'p', span: span(100, 300, 100, 300) },
    ]);
    expect(cut[0]!.endTick - cut[0]!.onsetTick).toBeGreaterThanOrEqual(1);
  });

  it('does not mix groups', () => {
    const cut = cutSwingOverlaps([
      { group: 'a', span: span(60, 180, 0, 120) },
      { group: 'b', span: span(120, 240, 120, 240) },
    ]);
    expect(cut[0]!.endTick).toBe(180);
  });
});
