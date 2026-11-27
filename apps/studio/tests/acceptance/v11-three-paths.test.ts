// P20 acceptance test (schema v11, three playback paths). Written BEFORE the implementation; do not edit.
//
// Contract: with project swing 30 and 60 the live schedule (buildScheduleEvents + resolveDrumOccurrence),
// the WAV schedule (buildWavScheduleEvents) and the exported MIDI (projectToMidi -> parseMidiFile, ppq 480)
// place every note and every drum hit at the same time, within 1 tick (1/480 beat). The MIDI export applies
// the same project swing (odd absolute 1/16 delayed by 0.25 * swing / 100 beats; see groove.ts swingBeat).
import { parseMidiFile, projectToMidi } from '@cts/midi-io';
import { describe, expect, it } from 'vitest';
import { buildScheduleEvents } from '../../src/audio/events';
import { resolveDrumOccurrence } from '../../src/audio/scheduler';
import { buildWavScheduleEvents } from '../../src/audio/wav';
import { payloadsOf, projectWith, setDrumClip, setMelodyClip } from './v11-helpers';

const PPQ = 480;

function buildProject(swing: number) {
  const project = projectWith(swing, true);
  setMelodyClip(project, 0, 8, [
    { pitch: 60, startBeat: 0, durationBeats: 0.2 },
    { pitch: 62, startBeat: 0.25, durationBeats: 0.2 }, // odd 16th
    { pitch: 64, startBeat: 0.5, durationBeats: 0.2 },
    { pitch: 65, startBeat: 0.75, durationBeats: 0.2 }, // odd 16th
    { pitch: 67, startBeat: 1 / 3 + 2, durationBeats: 0.2 }, // triplet: unmoved
    { pitch: 69, startBeat: 5.25, durationBeats: 0.2 }, // odd 16th, later bar
  ]);
  setDrumClip(project, [
    { lane: 'kick', stepIndex: 0 },
    { lane: 'snare', stepIndex: 1 },
    { lane: 'closedHat', stepIndex: 3 },
    { lane: 'closedHat', stepIndex: 6 },
    { lane: 'perc', stepIndex: 9 },
  ], { lengthBeats: 8 });
  return project;
}

const ticks = (beats: number[]) => beats.map((b) => Math.round(b * PPQ)).sort((a, b) => a - b);

describe('P20 v11 three paths', () => {
  it('threePaths_live_wav_midi_agreeWithinOneTick_withSwing30And60', () => {
    for (const swing of [30, 60]) {
      const project = buildProject(swing);
      const live = buildScheduleEvents(project).flatMap((e) => {
        const resolved = resolveDrumOccurrence(e, e.beat);
        return resolved ? [resolved] : [];
      });
      const wav = buildWavScheduleEvents(project);

      const split = (events: ReadonlyArray<{ beat: number; payload: unknown }>) => ({
        notes: ticks(payloadsOf(events).filter(({ p }) => p.kind === 'note').map(({ beat }) => beat)),
        drums: ticks(payloadsOf(events).filter(({ p }) => p.kind === 'drum').map(({ beat }) => beat)),
      });
      const liveTicks = split(live);
      const wavTicks = split(wav);

      const parsed = parseMidiFile(projectToMidi(project));
      expect(parsed.ppq).toBe(PPQ);
      const midiNotes = parsed.tracks.flatMap((t) => t.notes);
      const midiTicks = {
        notes: midiNotes.filter((n) => n.channel !== 9).map((n) => n.startTick).sort((a, b) => a - b),
        drums: midiNotes.filter((n) => n.channel === 9).map((n) => n.startTick).sort((a, b) => a - b),
      };

      for (const kind of ['notes', 'drums'] as const) {
        expect(liveTicks[kind]).toHaveLength(kind === 'notes' ? 6 : 5);
        expect(wavTicks[kind]).toHaveLength(liveTicks[kind].length);
        expect(midiTicks[kind]).toHaveLength(liveTicks[kind].length);
        liveTicks[kind].forEach((tick, i) => {
          expect(Math.abs(wavTicks[kind][i]! - tick)).toBeLessThanOrEqual(1);
          expect(Math.abs(midiTicks[kind][i]! - tick)).toBeLessThanOrEqual(1);
        });
      }
      // The swing is really applied (not three equally straight paths): odd 16th 0.25 moved by the delay.
      expect(liveTicks.notes).toContain(Math.round((0.25 + (0.25 * swing) / 100) * PPQ));
    }
  });
});
