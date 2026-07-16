import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  type Project,
  type TempoMapEvent,
  type TimeSignatureMapEvent,
} from '@cts/project-model';
import { metronomeMapEvents } from '../src/audio/metronome';
import {
  beatDurationSeconds,
  createProjectMusicalTime,
  mappedBeatDurationSeconds,
} from '../src/audio/musicalTime';
import {
  nextEventsInWindow,
  loopBeatTimeMapping,
  type LoopRegion,
  type ScheduledEvent,
} from '../src/audio/scheduler';
import type { NoteScheduleEvent } from '../src/audio/events';
import { MASTER_LIMITER_LOOKAHEAD_SECONDS } from '../src/audio/masterBus';
import { SYNTH_OSCILLATOR_STOP_PAD_SECONDS } from '../src/audio/voiceTiming';
import { planWavRender } from '../src/audio/wav';

const TEMPO_MAP: TempoMapEvent[] = [
  { id: 'tempo-120', beat: 0, bpm: 120 },
  { id: 'tempo-60', beat: 4, bpm: 60 },
];

function projectWithTimeline(
  tempoMap: TempoMapEvent[] = TEMPO_MAP,
  timeSignatureMap: TimeSignatureMapEvent[] = [
    { id: 'meter-4-4', beat: 0, numerator: 4, denominator: 4 },
  ],
  lengthBeats = 8,
): Project {
  return {
    id: 'tempo-map-integration',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Tempo map integration',
    bpm: tempoMap[0]?.bpm ?? 120,
    timeSignature: [
      timeSignatureMap[0]?.numerator ?? 4,
      timeSignatureMap[0]?.denominator ?? 4,
    ],
    key: 'C',
    scale: 'major',
    lengthBars: 2,
    lengthBeats,
    tempoMap,
    timeSignatureMap,
    audioAssets: [],
    automationLanes: [],
    audioRouting: {
      outputs: [{ sourceTrackId: 'lead', destination: { type: 'master' } }],
      sends: [],
    },
    tracks: [{
      id: 'lead',
      name: 'Lead',
      type: 'instrument',
      role: 'general',
      clips: [],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      instrument: { type: 'synth', preset: 'softPad' },
      effects: [],
    }],
    chordTrack: [],
    sections: [],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

function note(beat: number, durationBeats: number): ScheduledEvent {
  return {
    beat,
    payload: {
      kind: 'note',
      trackId: 'lead',
      preset: 'softPad',
      pitch: 60,
      durationBeats,
      velocity: 100,
    } satisfies NoteScheduleEvent,
  };
}

describe('schema-v3 musical-time integration', () => {
  it('maps live due times and note durations across a tempo change', () => {
    const { index, tempo } = createProjectMusicalTime(projectWithTimeline());
    const events = [note(3, 3), note(5, 1)];

    const due = nextEventsInWindow(events, 2.5, 5.5, tempo, 2, 10, null);

    expect(due.map((event) => event.time)).toEqual([10.5, 12]);
    const crossing = due[0]?.payload as NoteScheduleEvent | undefined;
    expect(crossing).toBeDefined();
    expect(beatDurationSeconds(
      index,
      due[0]?.beat ?? 0,
      crossing?.durationBeats ?? 0,
    )).toBe(2.5);
  });

  it('repeats a non-zero-start loop tempo contour on every pass', () => {
    const { tempo } = createProjectMusicalTime(projectWithTimeline());
    const loop: LoopRegion = { startBeat: 2, endBeat: 6 };

    const due = nextEventsInWindow(
      [note(3, 0.5), note(5, 0.5)],
      2,
      10,
      tempo,
      0,
      0,
      loop,
    );

    expect(due.map((event) => event.beat)).toEqual([3, 5, 3, 5]);
    expect(due.map((event) => event.time)).toEqual([1.5, 3, 4.5, 6]);
    expect(mappedBeatDurationSeconds(
      loopBeatTimeMapping(tempo, loop),
      5,
      2,
    )).toBe(1.5);
  });

  it('uses the tempo map for both WAV song length and a post-song note tail', () => {
    const project = projectWithTimeline();
    const plan = planWavRender(project, [note(7, 2)]);
    const expectedTail =
      1
      + 0.8
      + SYNTH_OSCILLATOR_STOP_PAD_SECONDS
      + MASTER_LIMITER_LOOKAHEAD_SECONDS;

    expect(plan.lengthBeats).toBe(8);
    expect(plan.songSeconds).toBe(6);
    expect(plan.uncappedTailSeconds).toBeCloseTo(expectedTail, 10);
    expect(plan.tailSeconds).toBeCloseTo(expectedTail, 10);
    expect(plan.totalSeconds).toBeCloseTo(6 + expectedTail, 10);
  });

  it('subdivides 6/8 by eighth notes, accents each bar, and loops them', () => {
    const project = projectWithTimeline(
      [{ id: 'steady-tempo', beat: 0, bpm: 120 }],
      [
        { id: 'meter-4-4', beat: 0, numerator: 4, denominator: 4 },
        { id: 'meter-6-8', beat: 8, numerator: 6, denominator: 8 },
      ],
      14,
    );
    project.lengthBars = 4;
    const { index } = createProjectMusicalTime(project);
    const loop: LoopRegion = { startBeat: 8, endBeat: 14 };

    const firstPass = metronomeMapEvents(index, 0, 14);
    expect(firstPass.filter((click) => click.accent).map((click) => click.beat))
      .toEqual([0, 4, 8, 11]);
    expect(firstPass.filter((click) => click.beat >= 8).map((click) => click.beat))
      .toEqual([8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5]);

    const looped = metronomeMapEvents(index, 8, 20, loop);
    expect(looped.filter((click) => click.accent).map((click) => click.beat))
      .toEqual([8, 11, 14, 17]);
    expect(looped.map((click) => click.beat)).toEqual(
      Array.from({ length: 24 }, (_, index) => 8 + index * 0.5),
    );
  });
});
