// P20 acceptance tests (schema v11 scheduling). Written BEFORE the implementation; do not edit.
//
// API contract under test (apps/studio/src/audio/events.ts `buildScheduleEvents`, the single schedule
// shared by live playback and WAV; WAV adds `resolveDrumOccurrence` through `buildWavScheduleEvents`):
// - `Project.swing` (percent 0..60) delays every event that sits exactly on an ODD 1/16 grid position of
//   the absolute project timeline by 0.25 * swing / 100 beats. This is packages/project-model/src/groove.ts
//   `swingBeat(beat, swing)`: `step = round(beat / 0.25)`, delay only when step is odd AND
//   beatTick(beat) === beatTick(step * 0.25); delay = 0.25 * swing / 100. Off-grid beats (triplets, 1/32)
//   never move. Notes get the delayed `beat` in the schedule.
// - Drum clips: if `drumGroove.swing > 0` the clip's own swing (existing formula: stepBeats * 0.5 * swing,
//   swing 0..1, parity of the source step) is the ONLY swing applied. If clip swing is 0 the drum follows
//   the project swing (same delay as notes). Observable via `buildWavScheduleEvents` resolved beats.
// - A swung onset at or past the owning clip end is dropped (notes and drums).
// - Choke (only when `project.hiHatChoke`): every `openHat` drum payload that is later stopped by a
//   `closedHat` on the SAME track gets `chokedAtBeat: <beat of the stopping closed hat>` (absolute,
//   post-swing). Open hats that are never stopped have no `chokedAtBeat`. With several closed hats at the
//   same tick (rounded to 1/480 beat) the EARLIEST sounding (smallest beat) is the stop point, independent
//   of source order. With hiHatChoke=false no payload has `chokedAtBeat`.
// - The swing delay counts toward the WAV song tail (`planWavRender`).
// - Transport loop: swung events fire exactly once per loop pass (no duplicate at the loop start).
import { describe, expect, it } from 'vitest';
import { buildScheduleEvents } from '../../src/audio/events';
import { nextEventsInWindow } from '../../src/audio/scheduler';
import { buildWavScheduleEvents, planWavRender } from '../../src/audio/wav';
import {
  addDrumTrack,
  noteBeats,
  payloadsOf,
  projectWith,
  setDrumClip,
  setMelodyClip,
  trackNamed,
} from './v11-helpers';

const SWING_GRID = 0.25;
const delay = (swing: number) => (SWING_GRID * swing) / 100;

function drumBeats(events: ReadonlyArray<{ beat: number; payload: unknown }>, trackId: string) {
  return payloadsOf(events)
    .filter(({ p }) => p.kind === 'drum' && p.trackId === trackId)
    .map(({ beat, p }) => ({ beat, lane: p.lane as string, step: p.sourceStepIndex as number }))
    .sort((a, b) => a.beat - b.beat);
}

describe('P20 v11 schedule: swing', () => {
  it('schedule_swing_delaysOnlyOddSixteenthsOnGrid_forMidiNotes', () => {
    const project = projectWith(50, true);
    const triplet = 1 / 3;
    setMelodyClip(project, 0, 8, [
      { pitch: 60, startBeat: 0, durationBeats: 0.1 }, // step 0: even
      { pitch: 61, startBeat: 0.25, durationBeats: 0.1 }, // step 1: odd -> +0.125
      { pitch: 62, startBeat: 0.5, durationBeats: 0.1 }, // step 2: even
      { pitch: 63, startBeat: 0.75, durationBeats: 0.1 }, // step 3: odd -> +0.125
      { pitch: 64, startBeat: triplet, durationBeats: 0.1 }, // triplet: does not move
      { pitch: 65, startBeat: 0.125, durationBeats: 0.05 }, // 1/32 off-grid: does not move
      { pitch: 66, startBeat: 1, durationBeats: 0.1 }, // beat: even
    ]);
    const melody = trackNamed(project, 'Melody');
    const beats = noteBeats(buildScheduleEvents(project), melody.id);
    expect(beats.get(60)).toBeCloseTo(0, 9);
    expect(beats.get(61)).toBeCloseTo(0.25 + delay(50), 9);
    expect(beats.get(62)).toBeCloseTo(0.5, 9);
    expect(beats.get(63)).toBeCloseTo(0.75 + delay(50), 9);
    expect(beats.get(64)).toBeCloseTo(triplet, 9);
    expect(beats.get(65)).toBeCloseTo(0.125, 9);
    expect(beats.get(66)).toBeCloseTo(1, 9);

    // Parity is absolute: a clip that starts on an odd 1/16 (beat 4.25) has its first note swung.
    const shifted = projectWith(50, true);
    setMelodyClip(shifted, 4.25, 3, [{ pitch: 60, startBeat: 0, durationBeats: 0.1 }]);
    const shiftedBeats = noteBeats(buildScheduleEvents(shifted), trackNamed(shifted, 'Melody').id);
    expect(shiftedBeats.get(60)).toBeCloseTo(4.25 + delay(50), 9);
  });

  it('schedule_swing_drumClipWithOwnSwing_usesClipSwingOnly', () => {
    const project = projectWith(60, true);
    setDrumClip(project, [{ lane: 'kick', stepIndex: 0 }, { lane: 'snare', stepIndex: 1 }], { clipSwing: 0.5 });
    const drums = trackNamed(project, 'Drums');
    // A second drum clip without its own swing in the same project does follow the project swing.
    const follower = addDrumTrack(project, 'Drums2', [{ lane: 'snare', stepIndex: 1 }]);
    const events = buildWavScheduleEvents(project);
    expect(drumBeats(events, follower.id)[0]!.beat).toBeCloseTo(0.25 + delay(60), 9);
    const hits = drumBeats(events, drums.id);
    // Clip swing 0.5 => 0.25 * 0.5 * 0.5 = 0.0625 on the odd step. Project swing 60 (0.15) must not be added.
    expect(hits.find((h) => h.step === 1)!.beat).toBeCloseTo(0.25 + 0.0625, 9);
    expect(hits.find((h) => h.step === 0)!.beat).toBeCloseTo(0, 9);
  });

  it('schedule_swing_drumClipWithoutOwnSwing_followsProjectSwing', () => {
    const project = projectWith(60, true);
    setDrumClip(project, [
      { lane: 'kick', stepIndex: 0 },
      { lane: 'snare', stepIndex: 1 },
      { lane: 'closedHat', stepIndex: 2 },
      { lane: 'perc', stepIndex: 3 },
    ]);
    const drums = trackNamed(project, 'Drums');
    const hits = drumBeats(buildWavScheduleEvents(project), drums.id);
    expect(hits.find((h) => h.step === 0)!.beat).toBeCloseTo(0, 9);
    expect(hits.find((h) => h.step === 1)!.beat).toBeCloseTo(0.25 + delay(60), 9);
    expect(hits.find((h) => h.step === 2)!.beat).toBeCloseTo(0.5, 9);
    expect(hits.find((h) => h.step === 3)!.beat).toBeCloseTo(0.75 + delay(60), 9);
  });

  it('schedule_swungOnsetAtOrPastClipEnd_isDropped', () => {
    const drumsIn = (clipLength: number, swing: number) => {
      const project = projectWith(swing, true);
      setMelodyClip(project, 0, clipLength, [
        { pitch: 60, startBeat: 0, durationBeats: 0.1 },
        { pitch: 61, startBeat: 3.75, durationBeats: 0.05 }, // step 15, odd
      ]);
      setDrumClip(project, [{ lane: 'kick', stepIndex: 0 }, { lane: 'snare', stepIndex: 15 }], { lengthBeats: clipLength });
      const events = buildWavScheduleEvents(project);
      return {
        notes: [...noteBeats(events, trackNamed(project, 'Melody').id).keys()].sort(),
        steps: drumBeats(events, trackNamed(project, 'Drums').id).map((h) => h.step),
      };
    };
    // Control: without swing the raw onset 3.75 is inside the clip, so both survive.
    expect(drumsIn(3.8, 0)).toEqual({ notes: [60, 61], steps: [0, 15] });
    // Swing 50 delays 3.75 to 3.875: past a 3.8 clip end -> dropped; exactly at a 3.875 clip end -> dropped.
    expect(drumsIn(3.8, 50)).toEqual({ notes: [60], steps: [0] });
    expect(drumsIn(3.875, 50)).toEqual({ notes: [60], steps: [0] });
    // One tick-ish inside the clip end it still sounds.
    expect(drumsIn(3.9, 50)).toEqual({ notes: [60, 61], steps: [0, 15] });
  });
});

describe('P20 v11 schedule: hi-hat choke', () => {
  const chokedAt = (events: ReadonlyArray<{ beat: number; payload: unknown }>, trackId: string) =>
    payloadsOf(events)
      .filter(({ p }) => p.kind === 'drum' && p.trackId === trackId && p.lane === 'openHat')
      .map(({ p }) => p.chokedAtBeat as number | undefined);

  it('schedule_choke_closedHatStopsEarlierOpenHat_sameTrackOnly', () => {
    const project = projectWith(0, true);
    setDrumClip(project, [
      { lane: 'openHat', stepIndex: 0 }, // beat 0
      { lane: 'closedHat', stepIndex: 4 }, // beat 1 -> chokes the open hat above
    ]);
    const drums = trackNamed(project, 'Drums');
    const other = addDrumTrack(project, 'Drums2', [
      { lane: 'openHat', stepIndex: 0 },
      { lane: 'closedHat', stepIndex: 2 }, // beat 0.5, only for Drums2's own open hat
    ]);
    const lonely = addDrumTrack(project, 'Drums3', [{ lane: 'openHat', stepIndex: 0 }]); // no closed hat at all
    for (const events of [buildScheduleEvents(project), buildWavScheduleEvents(project)]) {
      expect(chokedAt(events, drums.id)).toEqual([1]); // not 0.5: Drums2's closed hat is another track
      expect(chokedAt(events, other.id)).toEqual([0.5]);
      expect(chokedAt(events, lonely.id)).toEqual([undefined]); // another track's closed hats never choke it
    }
  });

  it('schedule_choke_sameTickClosedHats_picksEarliestSounding', () => {
    const project = projectWith(0, true);
    const drums = trackNamed(project, 'Drums');
    // Clip B is listed first, so source order would pick its hat (beat 1.0001); both land on tick 480.
    setDrumClip(project, [{ lane: 'openHat', stepIndex: 0 }, { lane: 'closedHat', stepIndex: 4 }]); // beat 1
    const clipA = drums.clips[0]!;
    const clipB = {
      ...clipA,
      id: 'clip-b',
      startBeat: 0.0001,
      lengthBeats: 16,
      drumEvents: [{ id: 'b-closed', lane: 'closedHat' as const, stepIndex: 4, velocity: 100 }], // beat 1.0001
    };
    drums.clips = [clipB, clipA];
    for (const events of [buildScheduleEvents(project), buildWavScheduleEvents(project)]) {
      const [choke] = chokedAt(events, drums.id);
      expect(choke).toBeDefined();
      expect(choke!).toBeCloseTo(1, 6); // the earliest sounding closed hat, not 1.0001
    }
  });
});

describe('P20 v11 schedule: tail budget and transport loop', () => {
  it('budget_swingDelay_isCountedInSongTail', () => {
    const build = (swing: number) => {
      const project = projectWith(swing, true);
      // The last odd 16th of the song (31.75), swung to 31.9 at swing 60: its sound ends later than straight.
      setMelodyClip(project, 28, 4, [{ pitch: 60, startBeat: 3.75, durationBeats: 0.25 }]);
      setDrumClip(project, [{ lane: 'perc', stepIndex: 15 }], { startBeat: 28, lengthBeats: 4 });
      return planWavRender(project);
    };
    const straight = build(0);
    const swung = build(60);
    expect(swung.totalSeconds).toBeGreaterThan(straight.totalSeconds);
    expect(swung.totalSeconds - straight.totalSeconds).toBeLessThanOrEqual(delay(60) * 0.5 + 1e-6); // 120 bpm
  });

  it('transportLoop_withSwing_doesNotDoubleTriggerAtLoopStart', () => {
    const project = projectWith(60, true);
    setMelodyClip(project, 0, 4, [
      { pitch: 60, startBeat: 0, durationBeats: 0.1 },
      { pitch: 62, startBeat: 3.75, durationBeats: 0.05 }, // swung to 3.9, still inside the loop
    ]);
    setDrumClip(project, [{ lane: 'snare', stepIndex: 15 }], { lengthBeats: 4 });
    const events = buildWavScheduleEvents(project);
    const loop = { startBeat: 0, endBeat: 4 };
    // 3 passes at 120 bpm (0.5 s per beat): playhead 0..12.
    const due = nextEventsInWindow(events, 0, 12, 120, 0, 0, loop);
    const timesOf = (match: (p: Record<string, unknown>) => boolean) =>
      due.filter((d) => match(d.payload as Record<string, unknown>)).map((d) => d.time).sort((a, b) => a - b);
    const loopStart = timesOf((p) => p.kind === 'note' && p.pitch === 60);
    const swungNote = timesOf((p) => p.kind === 'note' && p.pitch === 62);
    const swungDrum = timesOf((p) => p.kind === 'drum');
    expect(loopStart).toHaveLength(3);
    expect(loopStart[0]).toBeCloseTo(0, 6);
    expect(loopStart[1]).toBeCloseTo(2, 6);
    expect(loopStart[2]).toBeCloseTo(4, 6);
    expect(swungNote).toHaveLength(3);
    expect(swungNote[0]).toBeCloseTo(3.9 * 0.5, 6);
    expect(swungNote[1]).toBeCloseTo((3.9 + 4) * 0.5, 6);
    expect(swungNote[2]).toBeCloseTo((3.9 + 8) * 0.5, 6);
    expect(swungDrum).toHaveLength(3);
    expect(swungDrum[0]).toBeCloseTo(3.9 * 0.5, 6);
  });
});
