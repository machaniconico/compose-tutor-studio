// P20 regressions for resolved mode (swing > 0 || hiHatChoke): live, WAV and MIDI share one
// 480 PPQ resolver, and loop scheduling work stays bounded.
import { parseMidiFile, projectToMidi } from '@cts/midi-io';
import { createDrumClip, createEmptyProject, type Project } from '@cts/project-model';
import { describe, expect, it } from 'vitest';
import { buildScheduleEvents } from '../src/audio/events';
import {
  createScheduleEventIndex,
  nextIndexedEventsInWindow,
  queryScheduleEventIndex,
  resolveDrumOccurrence,
} from '../src/audio/scheduler';
import { buildWavScheduleEvents } from '../src/audio/wav';

const clock = () => new Date('2026-01-01T00:00:00.000Z');

function project(options: { swing: number; hiHatChoke: boolean; timeSignature?: [number, number]; lengthBars?: number }): Project {
  const created = createEmptyProject({
    clock,
    timeSignature: options.timeSignature ?? [4, 4],
    lengthBars: options.lengthBars ?? 8,
  });
  return Object.assign(created, { swing: options.swing, hiHatChoke: options.hiHatChoke });
}

function track(p: Project, name: string) {
  return p.tracks.find((t) => t.name === name)!;
}

type Payload = { kind: string; trackId: string; pitch?: number; lane?: string };

/** Onsets per path for one track: live (raw schedule, first pass), WAV, and MIDI note starts. */
function threePaths(p: Project, trackId: string, ppq = 480) {
  const ofTrack = (events: ReadonlyArray<{ beat: number; payload: unknown }>) =>
    events.filter((e) => (e.payload as Payload).trackId === trackId).map((e) => e.beat);
  const live = ofTrack(buildScheduleEvents(p).flatMap((e) => {
    const r = resolveDrumOccurrence(e, e.beat);
    return r ? [r] : [];
  }));
  const wav = ofTrack(buildWavScheduleEvents(p));
  const trackIndex = p.tracks.filter((t) => t.type !== 'master').findIndex((t) => t.id === trackId);
  // MIDI track 0 is the tempo track; instrument and drum tracks follow in project order.
  const midi = parseMidiFile(projectToMidi(p, { ppq })).tracks[trackIndex + 1]!.notes.map((n) => n.startTick);
  return { live, wav, midi };
}

describe('P20 resolved mode: shared drop rule', () => {
  it('resolved_chordSwungPastSongEnd_isOmittedByLiveWavAndMidi', () => {
    // 1 bar of 3/16 is 0.75 beats. The chord at 0.75 - 1/960 rounds onto tick 360, an odd
    // 16th, so swing 60 moves it to ~0.899: past the song end (and its own end).
    const p = project({ swing: 60, hiHatChoke: true, timeSignature: [3, 16], lengthBars: 1 });
    p.chordTrack = [{
      id: 'late-chord',
      startBeat: 0.75 - 1 / 960,
      durationBeats: 1 / 960,
      symbol: 'C',
      root: 'C',
      quality: 'major',
      notes: [0, 4, 7],
    }];
    expect(threePaths(p, track(p, 'Chords').id)).toEqual({ live: [], wav: [], midi: [] });
  });

  it('resolved_straightNoteRoundingOntoClipEnd_isDroppedAtEveryOutputPpq', () => {
    // swing 0 + choke on is resolved mode. 0.999 and the 1.00005 clip end both round to tick 480.
    const p = project({ swing: 0, hiHatChoke: true });
    const melody = track(p, 'Melody');
    melody.clips[0]!.startBeat = 0;
    melody.clips[0]!.lengthBeats = 1.00005;
    melody.clips[0]!.notes = [{ id: 'edge', pitch: 72, startBeat: 0.999, durationBeats: 1 / 960, velocity: 90 }];
    for (const ppq of [480, 960, 96]) {
      expect(threePaths(p, melody.id, ppq)).toEqual({ live: [], wav: [], midi: [] });
    }
  });

  it('resolved_noteInsideClipEndTick_isKeptAtTheSameTickInEveryPath', () => {
    const p = project({ swing: 0, hiHatChoke: true });
    const melody = track(p, 'Melody');
    melody.clips[0]!.lengthBeats = 1.003;
    melody.clips[0]!.notes = [{ id: 'edge', pitch: 72, startBeat: 0.999, durationBeats: 0.003, velocity: 90 }];
    // Resolved mode writes MIDI at the resolver's 480 PPQ even when 960 is requested.
    const paths = threePaths(p, melody.id, 960);
    expect(paths).toEqual({ live: [1], wav: [1], midi: [480] });
  });
});

describe('P20 resolved mode: choke de-duplication', () => {
  it('resolved_overlappingClipsSameLaneSameTick_soundOnceInWavAndMidi', () => {
    const p = project({ swing: 0, hiHatChoke: true });
    const drums = track(p, 'Drums');
    const first = drums.clips[0]!;
    first.startBeat = 0;
    first.lengthBeats = 4;
    first.drumEvents = [{ id: 'a', lane: 'closedHat', stepIndex: 4, velocity: 100 }];
    const second = createDrumClip(drums.id, 0, 4);
    second.drumEvents = [{ id: 'b', lane: 'closedHat', stepIndex: 4, velocity: 100 }];
    drums.clips.push(second);
    const paths = threePaths(p, drums.id);
    expect(paths.wav).toEqual([1]);
    expect(paths.live).toEqual([1]);
    expect(paths.midi).toEqual([480]);
  });
});

describe('P20 resolved mode: bounded loop scheduling', () => {
  it('loopWithoutAnyPostSwingOnset_scansNoRangesPerWindow', () => {
    // The only note (0.25, an odd 16th) swings to 0.4, outside the 2^-18-beat loop.
    const p = project({ swing: 60, hiHatChoke: false });
    const melody = track(p, 'Melody');
    melody.clips[0]!.notes = [{ id: 'n', pitch: 60, startBeat: 0.25, durationBeats: 0.1, velocity: 90 }];
    for (const t of p.tracks) if (t.type === 'drum') t.clips[0]!.drumEvents = [];
    const loop = { startBeat: 0.25, endBeat: 0.25 + 2 ** -18 };
    const index = createScheduleEventIndex(buildScheduleEvents(p), loop);
    const { events, stats } = queryScheduleEventIndex(index, 0.25, 0.25 + 0.24, 120, 0.25, 0);
    expect(events).toEqual([]);
    expect(stats.rangeCount).toBe(0);
    expect(stats.lowerBoundComparisons).toBe(0);
    expect(nextIndexedEventsInWindow(index, 0.25, 0.49, 120, 0.25, 0)).toEqual([]);
  });
});
