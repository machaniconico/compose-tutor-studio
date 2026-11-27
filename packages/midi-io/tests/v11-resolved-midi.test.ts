// P20 round 3: resolved-mode MIDI keeps the shared 480 PPQ decisions exactly.
import {
  createDrumClip,
  createEmptyProject,
  MAX_RUNTIME_SCHEDULE_EVENTS,
  preflightScheduleEventBudget,
  type Project,
} from '@cts/project-model';
import { describe, expect, it } from 'vitest';
import { parseMidiFile, projectToMidi, projectToMidiResult } from '../src';

const clock = () => new Date('2026-01-01T00:00:00.000Z');

function drumProject(hiHatChoke: boolean, swing = 0): { project: Project; drumsIndex: number } {
  const project = Object.assign(createEmptyProject({ clock }), { swing, hiHatChoke }) as Project;
  const drumsIndex = project.tracks.filter((t) => t.type !== 'master').findIndex((t) => t.type === 'drum');
  return { project, drumsIndex };
}

function drumNotes(project: Project, drumsIndex: number, ppq?: number) {
  const parsed = parseMidiFile(projectToMidi(project, ppq === undefined ? undefined : { ppq }));
  return { ppq: parsed.ppq, notes: parsed.tracks[drumsIndex + 1]!.notes };
}

describe('P20 resolved-mode MIDI', () => {
  it('resolvedMode_exportsAt480Ppq_soHitsTwoTicksApartBothSurviveChoke', () => {
    const { project, drumsIndex } = drumProject(true);
    const drums = project.tracks[drumsIndex]!;
    drums.clips[0]!.drumEvents = [{ id: 'open', lane: 'openHat', stepIndex: 0, velocity: 100 }];
    const closed = createDrumClip(drums.id, 2 / 480, 4);
    closed.drumEvents = [{ id: 'closed', lane: 'closedHat', stepIndex: 0, velocity: 100 }];
    drums.clips.push(closed);
    // A coarse requested PPQ would collapse ticks 0 and 2; resolved mode keeps 480.
    const { ppq, notes } = drumNotes(project, drumsIndex, 96);
    expect(ppq).toBe(480);
    expect(notes.map((n) => [n.pitch, n.startTick, n.startTick + n.durationTick])).toEqual([
      [46, 0, 2], // open hat, choked at the closed hat
      [42, 2, 122],
    ]);
  });

  it('legacyMode_keepsTheRequestedPpq', () => {
    const { project, drumsIndex } = drumProject(false);
    project.tracks[drumsIndex]!.clips[0]!.drumEvents = [{ id: 'k', lane: 'kick', stepIndex: 1, velocity: 100 }];
    const { ppq, notes } = drumNotes(project, drumsIndex, 96);
    expect(ppq).toBe(96);
    expect(notes.map((n) => n.startTick)).toEqual([24]);
  });

  it('resolvedDrumNoteOff_isTheEarliestOfFixedLengthNextSamePitchOnsetAndChoke', () => {
    const { project, drumsIndex } = drumProject(true);
    const drums = project.tracks[drumsIndex]!;
    drums.clips[0]!.drumEvents = [
      // Open hat at 0; the closed hat at beat 0.5 (tick 240) is after the 120-tick fixed length,
      // so the note-off is at 120, earlier than the choke point. This is by design.
      { id: 'open', lane: 'openHat', stepIndex: 0, velocity: 100 },
      { id: 'closed', lane: 'closedHat', stepIndex: 2, velocity: 100 },
      // Two kicks a 1/32 apart (ticks 960 and 1020): the first ends at the second's onset.
      { id: 'k1', lane: 'kick', stepIndex: 8, velocity: 100 },
    ];
    const extra = createDrumClip(drums.id, 2 + 1 / 8, 4);
    extra.drumEvents = [{ id: 'k2', lane: 'kick', stepIndex: 0, velocity: 100 }];
    drums.clips.push(extra);
    const { notes } = drumNotes(project, drumsIndex);
    const byPitch = (pitch: number) => notes.filter((n) => n.pitch === pitch).map((n) => [n.startTick, n.startTick + n.durationTick]);
    expect(byPitch(46)).toEqual([[0, 120]]); // fixed length wins over the later choke at 240
    expect(byPitch(42)).toEqual([[240, 360]]);
    expect(byPitch(36)).toEqual([[960, 1020], [1020, 1140]]); // next same-pitch onset wins
  });

  it('maxEvents_countsPotentialDrumHitsBeforeProbability_likeLiveAndWav', () => {
    // By design: a probability-0 kick never sounds, yet it is still counted, in MIDI's
    // maxEvents and in the live/WAV schedule preflight alike, so all 3 paths agree.
    const withProbability = (probability: number) => {
      const { project, drumsIndex } = drumProject(true);
      project.tracks[drumsIndex]!.clips[0]!.drumEvents = Array.from({ length: 8 }, (_, i) => ({
        id: `k${i}`, lane: 'kick' as const, stepIndex: i * 2, velocity: 100, probability,
      }));
      return { project, drumsIndex };
    };
    const sounding = withProbability(1);
    const silent = withProbability(0);
    expect(drumNotes(silent.project, silent.drumsIndex).notes).toEqual([]);

    const preflight = (project: Project) =>
      preflightScheduleEventBudget(project, { limit: MAX_RUNTIME_SCHEDULE_EVENTS, projection: 'audible' });
    expect(preflight(silent.project)).toEqual(preflight(sounding.project));

    const needed = projectToMidiResult(sounding.project);
    if (!needed.ok) throw new Error('export failed');
    for (const { project } of [sounding, silent]) {
      expect(projectToMidiResult(project, { maxEvents: needed.eventCount }).ok).toBe(true);
      expect(projectToMidiResult(project, { maxEvents: needed.eventCount - 1 })).toMatchObject({
        ok: false,
        error: { code: 'event-limit-exceeded' },
      });
    }
  });

  it('exportResult_reportsTheEffectivePpq_480InResolvedModeAndTheRequestInLegacy', () => {
    const resolved = drumProject(true).project;
    const legacy = drumProject(false).project;
    expect(projectToMidiResult(resolved, { ppq: 96 })).toMatchObject({ ok: true, effectivePpq: 480 });
    expect(projectToMidiResult(legacy, { ppq: 96 })).toMatchObject({ ok: true, effectivePpq: 96 });
    expect(projectToMidiResult(legacy)).toMatchObject({ ok: true, effectivePpq: 480 });
  });
});

