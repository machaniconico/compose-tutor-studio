// P42 acceptance tests (MIDI recording, pure capture + commit). Written BEFORE the implementation; do not edit.
//
// CONTRACT (apps/studio/src/state/midiRecording.ts). No schema change; PPQ 480; all positions are
// whole ticks. Expected values below are hand-computed (see p42-helpers.ts).
//
//   startMidiRecording(project, opts) -> { ok: true, session } | { ok: false, code, message }
//   feedMidiRecordingEvent(session, event) -> session            (pure; returns a new session)
//   stopMidiRecording(project, session, { timeSec }) -> MidiRecordingStopped | refusal
//
//   opts: { clipId, mode: 'overdub' | 'replace', countInBars: 0 | 1, autoQuantize: null | gridTicks,
//           loop: null | { startBeat, endBeat }, startBeat }
//   event: { type: 'on' | 'off', pitch, velocity, timeSec }      (callers feed nondecreasing timeSec)
//   MidiRecordingStopped: { ok: true, project, changed, droppedCount,
//           droppedByReason: Partial<Record<DropReason, number>>, recordedNoteIds,
//           rangeStartTick, rangeEndTick }
//   DropReason: 'pitch-out-of-range' | 'zero-length' | 'outside-clip' | 'same-pitch-overlap' | 'invalid'
//   Refusal codes (message is Japanese, non-empty): 'clip-not-found' | 'clip-not-midi' | 'clip-is-link' |
//     'clip-start-off-tick' | 'invalid-options' | 'loop-not-integer-tick' | 'loop-shorter-than-one-beat' |
//     'start-outside-loop'  (the store adds 'audio-recording-active' | 'midi-recording-active' | 'project-busy').
//
// Semantics.
// - `startBeat` is the song position (beats, whole tick) where capture begins. `clipId` must be a MIDI clip
//   that owns its notes (not a link/alias) whose startBeat is a whole tick. The input project is never mutated.
// - TIME ORIGIN: event.timeSec = seconds since the take's clock started. The clock starts at the first
//   count-in click when countInBars = 1 (one bar of the time signature at startBeat, ending at startBeat), and
//   at startBeat when countInBars = 0. Seconds map to song beats through the project's tempo map (also
//   across tempo changes). The count-in lasts sec(startBeat) - sec(startBeat - beatsPerBar) in song seconds.
//   Any event earlier than capture start (still in the count-in) is ignored and NOT counted as dropped; a
//   note whose 'on' was ignored also ignores its later 'off'.
// - Each of a note's two edges is converted to an absolute tick independently (round to nearest tick). The
//   note's duration is endTick - startTick of the raw edges. endTick <= startTick drops it ('zero-length').
// - autoQuantize = g (positive integer ticks): the note START is snapped to the nearest multiple of g on the
//   SONG-ABSOLUTE tick grid (not relative to the clip start; ties round up). Duration is kept. null = no snap.
// - Stored note.startBeat is relative to the clip start: (absoluteStartTick - clipStartTick) / 480.
// - Drops (each counted once in droppedCount / droppedByReason, the rest of the take is kept):
//   pitch not an integer in 0..127 -> 'pitch-out-of-range'; zero length -> 'zero-length';
//   start tick outside [clipStart, clipEnd) -> 'outside-clip'; an 'on' for a pitch that is already held ->
//   'same-pitch-overlap'; a final recorded note whose [start, end) tick span intersects a same-pitch note that
//   was kept earlier (existing notes in the clip, or an earlier recorded note) -> 'same-pitch-overlap'.
//   Touching edges are not an overlap. Velocity is rounded and clamped to an integer 1..127.
// - RULINGS (Fable acceptance, accepted deviations):
//   (a) 5th drop reason 'invalid': a note rejected individually by the final validateProject, or by the
//       per-clip / schedule caps, is dropped and counted under 'invalid' (the rest of the take is kept).
//   (c) A note whose start tick is inside the clip but whose end crosses the clip end is TRUNCATED at the clip
//       end (not dropped). 'outside-clip' is still judged by the START tick only.
// - A note still held at stop ends at the stop time. Result clip.notes = surviving existing notes (original
//   order, unchanged ids) followed by recorded notes ordered by (start tick, pitch); new ids are unique.
// - mode 'overdub' keeps every existing note. mode 'replace' first removes existing notes whose START tick
//   lies in the recorded range [rangeStartTick, rangeEndTick) (notes starting before it, or exactly at its end,
//   stay untouched even if they overlap it). Without a loop the range is [startBeat, stop beat); with a loop it
//   is [loopStart, loopEnd) if the take reached a second pass, else [startBeat, stop beat).
// - LOOP: loop bounds must be whole ticks (no float fuzz) and at least one beat (480 ticks) long, and
//   startBeat must lie in [loop.startBeat, loop.endBeat). Check order: bounds whole-tick, then length, then
//   start-in-loop (so a bad loop reports its own code even when startBeat is also outside). timeSec is still elapsed time since the clock start:
//   pass 0 runs startBeat -> loopEnd, every later pass runs loopStart -> loopEnd, with tempo-map-correct
//   durations. A note held when the loop wraps is cut at loopEnd; its later 'off' is ignored (not a drop).
//   Notes of every pass are merged.
// - `changed` is false (and project deep-equals the input) when nothing was recorded or removed.
import { describe, expect, it } from 'vitest';
import { decodeProject, encodeProjectJson } from '@cts/project-model';
import { parseMidiFile, projectToMidi } from '@cts/midi-io';
import { buildScheduleEvents } from '../../src/audio/events';
import { buildWavScheduleEvents } from '../../src/audio/wav';
import { payloadsOf } from './v11-helpers';
import {
  feedMidiRecordingEvent,
  startMidiRecording,
  stopMidiRecording,
} from '../../src/state/midiRecording';
import { makeProject, melodyClip, off, on, options, runTake, ticksOf } from './p42-helpers';

const JAPANESE = /[぀-ヿ一-鿿]/;

describe('P42 MIDI recording (pure capture)', () => {
  it('record_countIn_oneBar_noNotesCapturedBeforeDownbeat', () => {
    // 120 bpm 4/4: the count-in bar is 4 beats = 2.0 s, so timeSec 2.0 is the downbeat (beat 0).
    const project = makeProject();
    const take = runTake(
      project,
      options(project, { countInBars: 1 }),
      [
        on(60, 1.0), off(60, 1.5), // fully inside the count-in
        on(62, 1.75), off(62, 2.25), // starts in the count-in, ends after the downbeat: ignored whole
        on(64, 2.5), // 0.5 s after the downbeat = beat 1 = tick 480
        off(64, 3.0), // beat 2 = tick 960
      ],
      4.0,
    );
    expect(ticksOf(melodyClip(take.project))).toEqual([{ pitch: 64, startTick: 480, durTick: 480 }]);
    expect(take.droppedCount).toBe(0);
  });

  it('record_timestamps_convertViaTempoMap_acrossTempoChange', () => {
    // 120 bpm until beat 4 (2.0 s), then 60 bpm (1 s per beat).
    const project = makeProject({
      tempoMap: [{ id: 't0', beat: 0, bpm: 120 }, { id: 't1', beat: 4, bpm: 60 }],
    });
    const take = runTake(
      project,
      options(project),
      [
        on(60, 1.0), // beat 2 -> tick 960
        off(60, 1.5), // beat 3 -> tick 1440
        on(67, 1.75), // beat 3.5 -> tick 1680
        on(64, 3.0), // 2.0 s to beat 4, then 1 s = 1 beat -> beat 5 -> tick 2400
        off(67, 3.5), // beat 5.5 -> tick 2640
        off(64, 4.0), // beat 6 -> tick 2880
      ],
      5.0,
    );
    expect(ticksOf(melodyClip(take.project))).toEqual([
      { pitch: 60, startTick: 960, durTick: 480 },
      { pitch: 67, startTick: 1680, durTick: 960 },
      { pitch: 64, startTick: 2400, durTick: 480 },
    ]);
  });

  it('record_overdub_keepsExistingNotes', () => {
    const existing = [
      { pitch: 60, startBeat: 0, durationBeats: 1 },
      { pitch: 72, startBeat: 2.5, durationBeats: 2 }, // starts inside the recorded range
      { pitch: 64, startBeat: 4, durationBeats: 2 },
    ];
    const project = makeProject({ notes: existing });
    const before = structuredClone(melodyClip(project).notes);
    const take = runTake(project, options(project), [on(67, 1.0), off(67, 1.5)], 2.0); // beats 2 -> 3
    const notes = melodyClip(take.project).notes ?? [];
    expect(notes.slice(0, 3)).toEqual(before);
    expect(ticksOf(melodyClip(take.project))).toContainEqual({ pitch: 67, startTick: 960, durTick: 480 });
    expect(notes).toHaveLength(4);
  });

  it('record_replace_removesOnlyNotesInsideRecordedRange', () => {
    // Capture from beat 2, stop at beat 4: range = ticks [960, 1920).
    const project = makeProject({
      notes: [
        { pitch: 60, startBeat: 1, durationBeats: 2 }, // starts before the range (tick 480): kept although it overlaps
        { pitch: 62, startBeat: 2, durationBeats: 1 }, // starts exactly at range start (960): removed
        { pitch: 64, startBeat: 3.5, durationBeats: 1 }, // starts inside (1680), ends after the range: removed
        { pitch: 65, startBeat: 4, durationBeats: 1 }, // starts exactly at range end (1920): kept
        { pitch: 67, startBeat: 6, durationBeats: 1 }, // far after: kept
      ],
    });
    const take = runTake(
      project,
      options(project, { mode: 'replace', startBeat: 2 }),
      [on(69, 0.25), off(69, 0.5)], // beat 2.5 -> 1200, beat 3 -> 1440
      1.0, // beat 4
    );
    expect(take.rangeStartTick).toBe(960);
    expect(take.rangeEndTick).toBe(1920);
    expect(ticksOf(melodyClip(take.project))).toEqual([
      { pitch: 60, startTick: 480, durTick: 960 },
      { pitch: 69, startTick: 1200, durTick: 240 },
      { pitch: 65, startTick: 1920, durTick: 480 },
      { pitch: 67, startTick: 2880, durTick: 480 },
    ]);
  });

  it('record_autoQuantize_usesSongAbsoluteGrid', () => {
    // Clip starts at tick 60 (beat 0.125), off the 240-tick grid. Grid is 240 ticks (eighth note).
    const project = makeProject({ clipStartBeat: 0.125, clipLengthBeats: 8 });
    const take = runTake(
      project,
      options(project, { autoQuantize: 240 }),
      [
        on(60, 0.6), // beat 1.2 -> absolute tick 576 -> nearest 240 multiple 480 -> clip-relative 420
        off(60, 0.9), // beat 1.8 -> 864; raw length 288 is kept
        on(64, 1.1), // beat 2.2 -> 1056 -> 960 -> relative 900
        off(64, 1.4), // beat 2.8 -> 1344; length 288
      ],
      2.0,
    );
    // A clip-relative grid would have produced relative 480 and 960 (absolute 540 / 1020) instead.
    expect(ticksOf(melodyClip(take.project))).toEqual([
      { pitch: 60, startTick: 420, durTick: 288 },
      { pitch: 64, startTick: 900, durTick: 288 },
    ]);
  });

  it('record_loop_requiresIntegerTickBounds_andAtLeastOneBeat', () => {
    const project = makeProject();
    const refusalFor = (loop: { startBeat: number; endBeat: number }, startBeat = 0) => {
      const result = startMidiRecording(project, options(project, { loop, startBeat }));
      return result.ok ? null : result;
    };
    const fractional = refusalFor({ startBeat: 1 / 7, endBeat: 4 }, 2);
    expect(fractional?.code).toBe('loop-not-integer-tick');
    expect(fractional?.message).toMatch(JAPANESE);
    const short = refusalFor({ startBeat: 0, endBeat: 0.75 }); // 360 ticks < 480
    expect(short?.code).toBe('loop-shorter-than-one-beat');
    expect(short?.message).toMatch(JAPANESE);
    expect(refusalFor({ startBeat: 2, endBeat: 2 }, 2)?.code).toBe('loop-shorter-than-one-beat');
    // Exactly one beat and an ordinary loop are fine.
    expect(startMidiRecording(project, options(project, { loop: { startBeat: 0, endBeat: 1 } })).ok).toBe(true);
    expect(startMidiRecording(project, options(project, { loop: { startBeat: 2, endBeat: 6 }, startBeat: 2 })).ok).toBe(true);
  });

  it('record_noteHeldAcrossLoopEnd_isCutAtLoopEnd', () => {
    // Loop beats [4, 8); capture starts at beat 4. Pass 0 lasts 4 beats = 2.0 s, every pass after is 2.0 s.
    const project = makeProject();
    const take = runTake(
      project,
      options(project, { loop: { startBeat: 4, endBeat: 8 }, startBeat: 4 }),
      [
        on(60, 1.5), // beat 7 -> tick 3360, still held at the wrap
        off(60, 2.25), // pass 1, 0.25 s in = beat 4.5: ignored, the note was already cut at beat 8
        on(62, 2.5), // pass 1, 0.5 s in = beat 5 -> 2400
        off(62, 3.0), // beat 6 -> 2880
      ],
      3.5,
    );
    expect(ticksOf(melodyClip(take.project))).toEqual([
      { pitch: 62, startTick: 2400, durTick: 480 },
      { pitch: 60, startTick: 3360, durTick: 480 }, // cut at tick 3840 (beat 8), not 4.5 beats
    ]);
    expect(take.droppedCount).toBe(0);
  });

  it('record_droppedNotes_areCounted_notWholeTakeDiscarded', () => {
    // Clip is beats [0, 4) = ticks [0, 1920). One existing 66 spans ticks [480, 1440).
    const project = makeProject({
      clipLengthBeats: 4,
      notes: [{ pitch: 66, startBeat: 1, durationBeats: 2 }],
    });
    const take = runTake(
      project,
      options(project),
      [
        on(128, 0.0), on(-1, 0.0), on(67, 0.0), // two out-of-range pitches, one good note
        off(128, 0.05), off(-1, 0.05),
        on(64, 0.25), off(67, 0.25), // 67: ticks 0 -> 240; 64 starts at tick 240
        on(61, 0.3), off(61, 0.3), // zero length
        on(64, 0.5), // pitch 64 is already held: same-pitch overlap
        off(64, 0.75), // closes the first 64: tick 720, length 480
        on(66, 0.75), off(66, 1.0), // ticks [720, 960) intersects the existing 66
        on(62, 3.0), off(62, 3.5), // beat 6 is past the clip end (tick 1920)
      ],
      4.0,
    );
    expect(take.droppedCount).toBe(6);
    expect(take.droppedByReason).toEqual({
      'pitch-out-of-range': 2,
      'zero-length': 1,
      'outside-clip': 1,
      'same-pitch-overlap': 2,
    });
    expect(ticksOf(melodyClip(take.project))).toEqual([
      { pitch: 67, startTick: 0, durTick: 240 },
      { pitch: 64, startTick: 240, durTick: 480 },
      { pitch: 66, startTick: 480, durTick: 960 },
    ]);
  });

  it('record_result_liveWavMidiPathsAgree', () => {
    // Same rule as P20 (v11-three-paths): live schedule, WAV schedule and exported MIDI place every note at the
    // same start tick within 1 tick. Take: tempo 120 -> 60 at beat 4, clip start 0.125 (tick 60), quantize 120.
    const project = makeProject({
      clipStartBeat: 0.125,
      clipLengthBeats: 8, // clip ends at beat 8.125 = tick 3900
      tempoMap: [{ id: 't0', beat: 0, bpm: 120 }, { id: 't1', beat: 4, bpm: 60 }],
    });
    const take = runTake(
      project,
      options(project, { autoQuantize: 120 }),
      [
        on(60, 0.6), off(60, 0.9), // beat 1.2 -> tick 576 -> 600
        on(64, 3.0), off(64, 3.5), // beat 5 -> 2400 (kept), beat 5.5
        on(67, 6.0), off(67, 7.0), // beat 8 -> 3840; off beat 9 = 4320 crosses the clip end (3900)
      ],
      8.0,
    );
    const clip = melodyClip(take.project);
    // Hand check that the take itself is right, so "all three paths agree" cannot be three equal mistakes.
    const expectedStarts = [600, 2400, 3840];
    const clipStartTick = 60;
    expect(ticksOf(clip).map((tick) => tick.startTick + clipStartTick)).toEqual(expectedStarts);
    const last = ticksOf(clip)[2]!;
    expect(last.startTick + clipStartTick + last.durTick).toBe(3900); // truncated at the clip end

    const startTicks = (events: ReadonlyArray<{ beat: number; payload: unknown }>) =>
      payloadsOf(events)
        .filter(({ p }) => p.kind === 'note')
        .map(({ beat }) => Math.round(beat * 480))
        .sort((a, b) => a - b);
    const live = startTicks(buildScheduleEvents(take.project));
    const wav = startTicks(buildWavScheduleEvents(take.project));
    const parsed = parseMidiFile(projectToMidi(take.project));
    expect(parsed.ppq).toBe(480);
    const midi = parsed.tracks
      .flatMap((track) => track.notes)
      .filter((note) => note.channel !== 9)
      .map((note) => note.startTick)
      .sort((a, b) => a - b);

    expect(live).toHaveLength(3);
    expect(wav).toHaveLength(3);
    expect(midi).toHaveLength(3);
    expectedStarts.forEach((tick, i) => {
      expect(Math.abs(live[i]! - tick)).toBeLessThanOrEqual(1);
      expect(Math.abs(wav[i]! - tick)).toBeLessThanOrEqual(1);
      expect(Math.abs(midi[i]! - tick)).toBeLessThanOrEqual(1);
    });
  });

  it('record_resultPassesEncodeProjectJson', () => {
    const project = makeProject({
      clipStartBeat: 0.125,
      clipLengthBeats: 8,
      notes: [{ pitch: 55, startBeat: 0.5, durationBeats: 1 }],
    });
    const take = runTake(
      project,
      options(project, { mode: 'replace', autoQuantize: 120 }),
      [
        on(60, 0.6, 100.4), off(60, 0.9), // velocity rounds to 100
        on(130, 1.0), // dropped, take survives
        on(64, 1.1, 200), off(130, 1.2),
        off(64, 1.4), // velocity clamps to 127
        on(67, 1.5, 0), off(67, 1.9), // clamps up to 1
      ],
      2.0,
    );
    const notes = melodyClip(take.project).notes ?? [];
    expect(notes.map((note) => note.velocity).sort((a, b) => a - b)).toEqual([1, 100, 127]);
    expect(new Set(notes.map((note) => note.id)).size).toBe(notes.length);
    const encoded = encodeProjectJson(take.project);
    expect(encoded.ok).toBe(true);
    expect(decodeProject(JSON.parse(JSON.stringify(take.project))).ok).toBe(true);
  });
});

// ---- Extra edge cases (beyond the 13 required names) ---------------------------------------------
describe('P42 MIDI recording (extra edge cases)', () => {
  it('record_extra_countInZero_originIsStartBeat_soSameEventsAreCaptured', () => {
    const project = makeProject();
    const take = runTake(project, options(project), [on(60, 1.0), off(60, 1.5)], 4.0); // beats 2 -> 3
    expect(ticksOf(melodyClip(take.project))).toEqual([{ pitch: 60, startTick: 960, durTick: 480 }]);
  });

  it('record_extra_unknownClip_isRefusedWithJapaneseMessage', () => {
    const project = makeProject();
    const result = startMidiRecording(project, options(project, { clipId: 'no-such-clip' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('clip-not-found');
      expect(result.message).toMatch(JAPANESE);
    }
  });

  it('record_extra_invalidOptions_areRefused', () => {
    const project = makeProject();
    const bad = [
      options(project, { autoQuantize: 0 }),
      options(project, { autoQuantize: 1.5 }),
      options(project, { countInBars: 2 as 0 | 1 }),
      options(project, { mode: 'append' as 'overdub' }),
    ];
    for (const opts of bad) {
      const result = startMidiRecording(project, opts);
      expect(result.ok ? 'ok' : result.code).toBe('invalid-options');
    }
  });

  it('record_extra_startOutsideLoop_isRefused', () => {
    const project = makeProject();
    const result = startMidiRecording(project, options(project, { loop: { startBeat: 4, endBeat: 8 }, startBeat: 8 }));
    expect(result.ok ? 'ok' : result.code).toBe('start-outside-loop');
  });

  it('record_extra_clipStartOffTick_isRefused', () => {
    const project = makeProject({ clipStartBeat: 1 / 7 });
    const result = startMidiRecording(project, options(project));
    expect(result.ok ? 'ok' : result.code).toBe('clip-start-off-tick');
  });

  it('record_extra_emptyTake_isUnchanged_andDoesNotMutateInput', () => {
    const project = makeProject({ notes: [{ pitch: 60, startBeat: 1, durationBeats: 1 }] });
    const snapshot = structuredClone(project);
    const started = startMidiRecording(project, options(project));
    if (!started.ok) throw new Error('start refused');
    const session = feedMidiRecordingEvent(started.session, on(64, 0.5));
    const stopped = stopMidiRecording(project, session, { timeSec: 0.5 }); // held note has zero length -> dropped
    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      expect(stopped.changed).toBe(false);
      expect(stopped.droppedCount).toBe(1);
      expect(stopped.project).toEqual(snapshot);
    }
    expect(project).toEqual(snapshot);
  });

  it('record_extra_noteHeldAtStop_endsAtStopTime', () => {
    const project = makeProject();
    const take = runTake(project, options(project), [on(60, 1.0)], 1.5); // beat 2 -> stop beat 3
    expect(ticksOf(melodyClip(take.project))).toEqual([{ pitch: 60, startTick: 960, durTick: 480 }]);
  });
});
