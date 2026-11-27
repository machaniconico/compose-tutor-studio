// Loop-range MIDI export (P53).
import { describe, expect, it } from 'vitest';
import {
  createDefaultProject,
  createDrumClip,
  createDrumTrack,
  createInstrumentTrack,
  createMidiClip,
  createNoteEvent,
  resolveExportRange,
  type Project,
} from '@cts/project-model';
import { parseMidiFile, projectToMidi, projectToMidiResult } from '../src/index.js';

/** 8 bars, tempo 120 -> 90 at beat 12, 4/4 -> 3/4 at beat 12, one chord per 4 beats. */
function songProject(): Project {
  const project = createDefaultProject({ bpm: 120, lengthBars: 8 });
  project.tracks = project.tracks.filter((track) => track.type === 'master');
  const lead = createInstrumentTrack('Lead');
  const clip = createMidiClip(lead.id, 0, 32);
  if (clip.type !== 'midi') throw new Error('midi clip expected');
  clip.notes = [
    createNoteEvent(60, 0, 2, 100), // ends before the range
    createNoteEvent(62, 3, 4, 90), // crosses the range start (beats 3..7)
    createNoteEvent(64, 8, 1, 80), // inside
    createNoteEvent(65, 15, 4, 70), // crosses the range end (beats 15..19)
    createNoteEvent(67, 16, 1, 60), // starts at the range end
    createNoteEvent(69, 20, 1, 50), // after the range
  ];
  lead.clips = [clip];
  project.tracks.push(lead);
  project.chordTrack = [];
  project.tempoMap = [
    { id: 't0', beat: 0, bpm: 120 },
    { id: 't1', beat: 6, bpm: 100 },
    { id: 't2', beat: 12, bpm: 90 },
  ];
  project.timeSignatureMap = [
    { id: 'm0', beat: 0, numerator: 4, denominator: 4 },
    { id: 'm1', beat: 12, numerator: 3, denominator: 4 },
  ];
  project.audioRouting = {
    outputs: project.tracks
      .filter((track) => track.type !== 'master')
      .map((track) => ({ sourceTrackId: track.id, destination: { type: 'master' as const } })),
    sends: [],
  };
  return project;
}

function rangeOf(startBeat: number, endBeat: number, lengthBeats = 32) {
  const resolved = resolveExportRange({ enabled: true, startBeat, endBeat }, lengthBeats);
  if (!resolved.ok) throw new Error(resolved.message);
  return { startTick: resolved.range.startTick, endTick: resolved.range.endTick };
}

describe('loop-range MIDI export', () => {
  it('writes the whole song unchanged when no range is given, and for a range covering it', () => {
    const project = songProject();
    const full = projectToMidi(project);
    expect(projectToMidi(project, {})).toEqual(full);
    expect(projectToMidi(project, { range: rangeOf(0, 32) })).toEqual(full);
  });

  it('clips notes to the range and shifts the start to tick 0', () => {
    const bytes = projectToMidi(songProject(), { range: rangeOf(4, 16) });
    const parsed = parseMidiFile(bytes);
    const lead = parsed.tracks.find((track) => track.name === 'Lead')!;
    expect(parsed.ppq).toBe(480);
    expect(lead.notes.map((n) => [n.pitch, n.startTick, n.durationTick, n.velocity])).toEqual([
      [62, 0, 3 * 480, 90], // beats 3..7 keeps only 4..7
      [64, 4 * 480, 480, 80],
      [65, 11 * 480, 1 * 480, 70], // beats 15..19 is cut at 16
    ]);
  });

  it('writes the tempo and meter in effect at the start at tick 0, plus changes inside', () => {
    const parsed = parseMidiFile(projectToMidi(songProject(), { range: rangeOf(8, 16) }));
    expect(parsed.tempoEvents?.map((e) => [e.tick, Math.round(e.bpm)])).toEqual([
      [0, 100], // t1 (beat 6) is in effect at beat 8
      [4 * 480, 90], // t2 at beat 12
    ]);
    expect(parsed.timeSignatures?.map((e) => [e.tick, e.numerator])).toEqual([
      [0, 4],
      [4 * 480, 3],
    ]);
  });

  it('puts a tempo change exactly on the range start at tick 0 only once', () => {
    const parsed = parseMidiFile(projectToMidi(songProject(), { range: rangeOf(12, 20) }));
    expect(parsed.tempoEvents?.map((e) => [e.tick, Math.round(e.bpm)])).toEqual([[0, 90]]);
  });

  it('keeps the chord sounding at the start at tick 0 and shifts later chords', () => {
    const project = songProject();
    project.chordTrack = [
      { id: 'c1', startBeat: 0, durationBeats: 8, symbol: 'C', root: 'C', quality: 'major', notes: [60] },
      { id: 'c2', startBeat: 8, durationBeats: 8, symbol: 'F', root: 'F', quality: 'major', notes: [65] },
    ];
    const parsed = parseMidiFile(projectToMidi(project, { range: rangeOf(4, 12) }));
    expect(parsed.markers?.map((m) => [m.tick, m.text])).toEqual([
      [0, 'C'],
      [4 * 480, 'F'],
    ]);
  });

  it('keeps a note that is cut to zero length out of the file', () => {
    // 8.0 touches the start of note 64 but not any earlier note; range 7..8 has only note 62 left.
    const parsed = parseMidiFile(projectToMidi(songProject(), { range: rangeOf(7, 8) }));
    const lead = parsed.tracks.find((track) => track.name === 'Lead')!;
    expect(lead.notes.map((n) => n.pitch)).toEqual([]);
  });

  it('rejects an invalid range as invalid options', () => {
    const result = projectToMidiResult(songProject(), { range: { startTick: 10, endTick: 10 } });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-options' } });
  });

  it('refuses a range at any PPQ other than 480 instead of mixing in later events', () => {
    const project = songProject();
    project.swing = 0; // legacy mode: the requested ppq is honoured
    project.hiHatChoke = false;
    project.tempoMap = [
      { id: 't0', beat: 0, bpm: 120 },
      { id: 't1', beat: 4.25, bpm: 90 },
    ];
    const result = projectToMidiResult(project, { ppq: 1, range: rangeOf(4, 4.125) });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-options' } });
    expect(projectToMidiResult(project, { ppq: 480, range: rangeOf(4, 4.125) }).ok).toBe(true);
  });

  it('drops a drum hit that began before the range instead of retriggering it, but clips melodic notes', () => {
    const project = songProject();
    const drums = createDrumTrack('Drums');
    const drumClip = createDrumClip(drums.id, 0, 32);
    drumClip.drumEvents = [
      { id: 'h1', lane: 'closedHat', stepIndex: 15, velocity: 100 }, // beat 3.75
      { id: 'h2', lane: 'closedHat', stepIndex: 18, velocity: 100 }, // beat 4.5
    ];
    drums.clips = [drumClip];
    project.tracks.push(drums);
    project.audioRouting.outputs.push({ sourceTrackId: drums.id, destination: { type: 'master' } });
    // The 3.75-beat hat lasts a quarter beat, so it is still sounding at 3.9.
    const parsed = parseMidiFile(projectToMidi(project, { range: rangeOf(3.9, 8) }));
    const hits = parsed.tracks.find((track) => track.name === 'Drums')!.notes;
    expect(hits.map((hit) => hit.startTick)).toEqual([288]);
    const lead = parsed.tracks.find((track) => track.name === 'Lead')!;
    expect(lead.notes[0]).toMatchObject({ pitch: 62, startTick: 0 });
    expect(lead.notes[0]!.durationTick).toBe(Math.round(3.1 * 480));
  });
});
