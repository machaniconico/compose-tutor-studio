import { describe, expect, it } from 'vitest';
import { createEmptyProject, decodeProject } from '@cts/project-model';
import { parseMidiFile, projectToMidi as projectToMidiRaw } from '../src/index.js';
import type { MidiExportOptions } from '../src/index.js';
import type { Project } from '@cts/project-model';
import { v10DrumGrooveFixtures } from './fixtures/v10-drum-groove';
import goldenMidi from './fixtures/v10-drum-groove-midi.json';

// P54: these tests pin the pre-P54 bytes, so they run with the option OFF.
const projectToMidi = (project: Project, options?: MidiExportOptions) =>
  projectToMidiRaw(project, { ...options, includeProgramAndKey: false });

describe('v11 MIDI drum export', () => {
  // Full SMF bytes captured from origin/main (16607ed7) after decoding each v10 input.
  it.each(Object.entries(v10DrumGrooveFixtures))('preserves v10 MIDI bytes for %s', (name, input) => {
    const decoded = decodeProject(input);
    if (!decoded.ok) throw new Error(JSON.stringify(decoded));
    expect(decoded.project).toMatchObject({ schemaVersion: 12, swing: 0, hiHatChoke: false });
    const actual = projectToMidi(decoded.project);
    const expected = Uint8Array.from(goldenMidi[name as keyof typeof goldenMidi].match(/../g)!, (byte) => parseInt(byte, 16));
    expect(actual).toEqual(expected);
  });

  it('ends consecutive swung closed hats before the next onset on the same pitch', () => {
    const project = createEmptyProject();
    project.swing = 30;
    const clip = project.tracks.find((track) => track.type === 'drum')!.clips[0]!;
    clip.drumEvents = Array.from({ length: 16 }, (_, stepIndex) => ({
      id: `hat-${stepIndex}`, lane: 'closedHat', stepIndex, velocity: 80,
    }));

    const hats = parseMidiFile(projectToMidi(project)).tracks.flatMap((track) => track.notes);
    expect(hats.map(({ channel, pitch, startTick, durationTick }) => [
      channel, pitch, startTick, durationTick,
    ])).toEqual(Array.from({ length: 16 }, (_, step) => [
      9, 42, step * 120 + (step % 2 ? 36 : 0), step % 2 && step < 15 ? 84 : 120,
    ]));
  });

  it('ends an open hat at the resolved closed-hat onset when choke is enabled', () => {
    const project = createEmptyProject();
    project.hiHatChoke = true;
    const clip = project.tracks.find((track) => track.type === 'drum')!.clips[0]!;
    clip.stepsPerBar = 32;
    clip.drumGroove = { probability: 1, seed: 1, humanizeVelocity: 0, swing: 1 };
    clip.drumEvents = [
      { id: 'open', lane: 'openHat', stepIndex: 0, velocity: 80 },
      { id: 'closed', lane: 'closedHat', stepIndex: 1, velocity: 80 },
    ];

    const hats = parseMidiFile(projectToMidi(project)).tracks.flatMap((track) => track.notes);
    expect(hats.find((note) => note.pitch === 46)?.durationTick).toBe(90);
    expect(hats.find((note) => note.pitch === 42)?.startTick).toBe(90);
    // Resolved mode ignores a coarse requested PPQ and keeps the 480 PPQ decisions.
    const coarse = parseMidiFile(projectToMidi(project, { ppq: 1 }));
    expect(coarse.ppq).toBe(480);
    expect(coarse.tracks.flatMap((track) => track.notes).map((note) => note.pitch)).toEqual([46, 42]);

    project.hiHatChoke = false;
    const straight = parseMidiFile(projectToMidi(project)).tracks.flatMap((track) => track.notes);
    expect(straight.find((note) => note.pitch === 46)?.durationTick).toBe(120);
    expect(straight.find((note) => note.pitch === 42)?.startTick).toBe(60);
  });

  it('keeps same-pitch hits a 1/32 apart distinct because resolved mode exports at 480 PPQ', () => {
    const project = createEmptyProject();
    project.swing = 30;
    project.hiHatChoke = false;
    const clip = project.tracks.find((track) => track.type === 'drum')!.clips[0]!;
    clip.stepsPerBar = 32;
    clip.drumEvents = [
      { id: 'first', lane: 'closedHat', stepIndex: 0, velocity: 60 },
      { id: 'second', lane: 'closedHat', stepIndex: 1, velocity: 80 },
    ];

    const parsed = parseMidiFile(projectToMidi(project, { ppq: 1 }));
    expect(parsed.ppq).toBe(480);
    const hats = parsed.tracks.flatMap((track) => track.notes);
    expect(hats.map((note) => [note.pitch, note.startTick, note.durationTick, note.velocity])).toEqual([
      [42, 0, 60, 60], // ends at the next same-pitch onset
      [42, 60, 120, 80],
    ]);
  });

  it.each([
    [100, 60], [-20, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0],
  ])('exports in-memory swing %s as %s', (swing, expectedSwing) => {
    const project = createEmptyProject();
    project.hiHatChoke = false;
    project.tracks.find((track) => track.type === 'instrument')!.clips[0]!.notes = [
      { id: 'note', pitch: 60, startBeat: 0.25, durationBeats: 0.125, velocity: 80 },
    ];
    project.tracks.find((track) => track.type === 'drum')!.clips[0]!.drumEvents = [
      { id: 'hat', lane: 'closedHat', stepIndex: 1, velocity: 80 },
    ];

    expect(projectToMidi({ ...project, swing })).toEqual(projectToMidi({ ...project, swing: expectedSwing }));
  });
});
