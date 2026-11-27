import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@cts/project-model';
import type { MusicalKey, Project, ScaleName } from '@cts/project-model';
import {
  MidiExportError,
  gmProgramForPreset,
  presetForGmProgram,
  keySignatureFor,
  parseMidiFile,
  projectToMidi,
  projectToMidiResult,
} from '../src/index.js';

type RawEvent = { tick: number; bytes: number[] };

/** Minimal SMF reader for our own output (explicit status bytes, no running status). */
function rawTracks(bytes: Uint8Array): RawEvent[][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tracks: RawEvent[][] = [];
  let pos = 14;
  while (pos < bytes.length) {
    const end = pos + 8 + view.getUint32(pos + 4);
    pos += 8;
    const events: RawEvent[] = [];
    let tick = 0;
    while (pos < end) {
      let delta = 0;
      let b: number;
      do { b = bytes[pos++]!; delta = delta * 128 + (b & 0x7f); } while (b & 0x80);
      tick += delta;
      const start = pos;
      const status = bytes[pos++]!;
      if (status === 0xff) {
        pos += 1;
        let len = 0;
        do { b = bytes[pos++]!; len = len * 128 + (b & 0x7f); } while (b & 0x80);
        pos += len;
      } else {
        pos += (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
      }
      events.push({ tick, bytes: [...bytes.subarray(start, pos)] });
    }
    tracks.push(events);
  }
  return tracks;
}

function withNote(project: Project): Project {
  const track = project.tracks.find((t) => t.type === 'instrument')!;
  track.clips[0] = {
    ...track.clips[0]!,
    type: 'midi',
    notes: [{ id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
  };
  return project;
}

describe('P54 key signature mapping', () => {
  // [key, scale, sf, mi]
  const cases: [MusicalKey, ScaleName, number, 0 | 1][] = [
    ['C', 'major', 0, 0], ['G', 'major', 1, 0], ['D', 'major', 2, 0], ['A', 'major', 3, 0],
    ['E', 'major', 4, 0], ['B', 'major', 5, 0], ['F#', 'major', 6, 0], ['Gb', 'major', -6, 0],
    ['C#', 'major', -5, 0], ['Db', 'major', -5, 0], ['Ab', 'major', -4, 0], ['G#', 'major', -4, 0],
    ['Eb', 'major', -3, 0], ['D#', 'major', -3, 0], ['Bb', 'major', -2, 0], ['A#', 'major', -2, 0],
    ['F', 'major', -1, 0],
    ['A', 'naturalMinor', 0, 1], ['E', 'naturalMinor', 1, 1], ['B', 'naturalMinor', 2, 1],
    ['F#', 'naturalMinor', 3, 1], ['C#', 'naturalMinor', 4, 1], ['G#', 'naturalMinor', 5, 1],
    ['D#', 'naturalMinor', 6, 1], ['Eb', 'naturalMinor', -6, 1], ['A#', 'naturalMinor', -5, 1],
    ['Bb', 'naturalMinor', -5, 1], ['F', 'naturalMinor', -4, 1], ['C', 'naturalMinor', -3, 1],
    ['G', 'naturalMinor', -2, 1], ['D', 'naturalMinor', -1, 1],
    // Scales without their own signature use the parent major / minor signature.
    ['A', 'harmonicMinor', 0, 1], ['A', 'melodicMinor', 0, 1], ['D', 'minorPentatonic', -1, 1],
    ['G', 'blues', -2, 1], ['D', 'majorPentatonic', 2, 0],
  ];

  it.each(cases)('%s %s -> sf %i mi %i', (key, scale, sf, mi) => {
    expect(keySignatureFor(key, scale)).toEqual({ sf, mi });
  });

  it('covers all 17 key spellings x 7 scales within -7..7 and uses at most 6 accidentals', () => {
    const keys = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'] as const;
    const scales = ['major', 'naturalMinor', 'harmonicMinor', 'melodicMinor', 'majorPentatonic', 'minorPentatonic', 'blues'] as const;
    for (const key of keys) {
      for (const scale of scales) {
        const { sf } = keySignatureFor(key, scale);
        expect(Math.abs(sf)).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe('P54 GM program mapping', () => {
  it('maps the 4 base presets, the 10 P22 presets and legacy aliases into 0..127', () => {
    const names = [
      'softPad', 'brightPluck', 'warmBass', 'brightLead',
      'p22:pianoLike', 'p22:bell', 'p22:organLike', 'p22:stringsLike', 'p22:brassLike',
      'p22:pluck', 'p22:deepSubBass', 'p22:softKeys', 'p22:squareLead', 'p22:glassPad',
      'warmPad', 'pad', 'roundBass', 'subBass', 'bass', 'leadSine', 'lead',
    ];
    for (const name of names) {
      const program = gmProgramForPreset(name);
      expect(Number.isInteger(program) && program >= 0 && program <= 127).toBe(true);
    }
    expect(gmProgramForPreset('p22:pianoLike')).toBe(0);
    expect(gmProgramForPreset('p22:bell')).toBe(14);
    expect(gmProgramForPreset('pad')).toBe(gmProgramForPreset('softPad'));
  });

  it('falls back to Warm Pad for unknown or non-string presets', () => {
    expect(gmProgramForPreset('nope')).toBe(89);
    expect(gmProgramForPreset('__proto__')).toBe(89);
    expect(gmProgramForPreset(undefined)).toBe(89);
  });
});

describe('P54 export with includeProgramAndKey', () => {
  it('writes one Key Signature at tick 0 of the conductor track', () => {
    const project = createEmptyProject();
    project.key = 'D';
    project.scale = 'naturalMinor';
    const tracks = rawTracks(projectToMidi(project));
    const keys = tracks[0]!.filter((e) => e.bytes[0] === 0xff && e.bytes[1] === 0x59);
    expect(keys).toEqual([{ tick: 0, bytes: [0xff, 0x59, 0x02, 0xff, 0x01] }]); // D minor: 1 flat
    expect(tracks.slice(1).flat().some((e) => e.bytes[1] === 0x59 && e.bytes[0] === 0xff)).toBe(false);
    const parsed = parseMidiFile(projectToMidi(project));
    expect(parsed.keySignatures).toMatchObject([
      { tick: 0, sharpsFlats: -1, minor: true, trackIndex: 0 },
    ]);
  });

  it('writes a Program Change at tick 0 of each instrument track before any note, none on drums', () => {
    const project = withNote(createEmptyProject());
    const instrument = project.tracks.find((t) => t.type === 'instrument')!;
    instrument.instrument = { type: 'synth', preset: 'p22:bell' };
    const bytes = projectToMidi(project);
    const tracks = rawTracks(bytes).slice(1);
    const partTracks = project.tracks.filter((t) => t.type === 'instrument' || t.type === 'drum');
    expect(tracks).toHaveLength(partTracks.length);
    partTracks.forEach((track, index) => {
      const events = tracks[index]!;
      const programs = events.filter((e) => (e.bytes[0]! & 0xf0) === 0xc0);
      if (track.type === 'drum') {
        expect(programs).toEqual([]);
        expect(events.every((e) => e.bytes[0]! === 0xff || (e.bytes[0]! & 0x0f) === 9)).toBe(true);
        return;
      }
      expect(programs).toHaveLength(1);
      expect(programs[0]!.tick).toBe(0);
      expect(programs[0]!.bytes[1]).toBeLessThanOrEqual(127);
      expect(programs[0]!.bytes[0]! & 0x0f).toBeLessThanOrEqual(15);
      const firstNote = events.findIndex((e) => (e.bytes[0]! & 0xf0) === 0x90);
      if (firstNote !== -1) expect(events.indexOf(programs[0]!)).toBeLessThan(firstNote);
    });
    const initial = parseMidiFile(bytes).tracks.flatMap((t) => t.initialChannels ?? []);
    expect(initial.some((c) => c.program === 14)).toBe(true);
  });

  it('counts the new events in eventCount and maxEvents', () => {
    const project = createEmptyProject();
    const on = projectToMidiResult(project);
    const off = projectToMidiResult(project, { includeProgramAndKey: false });
    if (!on.ok || !off.ok) throw new Error('export failed');
    const instruments = project.tracks.filter((t) => t.type === 'instrument').length;
    expect(on.eventCount - off.eventCount).toBe(1 + instruments);
    expect(on.bytes.length).toBeGreaterThan(off.bytes.length);
    const tight = projectToMidiResult(project, { maxEvents: off.eventCount });
    expect(tight.ok).toBe(false);
    expect(projectToMidiResult(project, { maxEvents: on.eventCount }).ok).toBe(true);
    expect(projectToMidiResult(project, { maxEvents: off.eventCount, includeProgramAndKey: false }).ok).toBe(true);
  });

  it('removes exactly those events when OFF (legacy bytes are the ON bytes minus program/key)', () => {
    const project = withNote(createEmptyProject());
    const strip = (bytes: Uint8Array) => rawTracks(bytes).map((track) => track.filter((e) => !(
      (e.bytes[0] === 0xff && e.bytes[1] === 0x59) || (e.bytes[0]! & 0xf0) === 0xc0
    )));
    expect(strip(projectToMidi(project))).toEqual(strip(projectToMidi(project, { includeProgramAndKey: false })));
    const off = rawTracks(projectToMidi(project, { includeProgramAndKey: false })).flat();
    expect(off.some((e) => (e.bytes[0]! & 0xf0) === 0xc0 || (e.bytes[0] === 0xff && e.bytes[1] === 0x59))).toBe(false);
  });

  it('also works in resolved mode at 480 PPQ', () => {
    const project = createEmptyProject();
    project.swing = 20;
    const result = projectToMidiResult(project);
    if (!result.ok) throw new Error('export failed');
    expect(result.effectivePpq).toBe(480);
    expect(rawTracks(result.bytes)[0]!.some((e) => e.bytes[1] === 0x59)).toBe(true);
  });

  it('rejects an unsupported key at runtime only when the option is ON', () => {
    const project = createEmptyProject();
    (project as { key: string }).key = 'H';
    expect(() => projectToMidi(project)).toThrow(MidiExportError);
    expect(() => projectToMidi(project, { includeProgramAndKey: false })).not.toThrow();
  });
});

describe('P54 GM program inverse and import flags', () => {
  it('inverts every canonical preset and rejects unknown programs and aliases', () => {
    const presets = [
      'softPad', 'brightPluck', 'warmBass', 'brightLead',
      'p22:pianoLike', 'p22:bell', 'p22:organLike', 'p22:stringsLike', 'p22:brassLike',
      'p22:pluck', 'p22:deepSubBass', 'p22:softKeys', 'p22:squareLead', 'p22:glassPad',
    ];
    expect(new Set(presets.map(gmProgramForPreset)).size).toBe(14);
    for (const preset of presets) {
      expect(presetForGmProgram(gmProgramForPreset(preset))).toBe(preset);
    }
    expect(presetForGmProgram(100)).toBeUndefined();
    expect(presetForGmProgram(-1)).toBeUndefined();
  });

  it('marks soleProgram only for one tick-0 Program Change before any note and no bank select', () => {
    const smf = (events: number[]) => {
      const body = [...events, 0x00, 0xff, 0x2f, 0x00];
      return Uint8Array.from([
        0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
        0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, body.length, ...body,
      ]);
    };
    const sole = (events: number[]) =>
      parseMidiFile(smf(events)).tracks[0]!.initialChannels?.[0]?.soleProgram === true;
    const on = [0x90, 60, 100];
    const off = [0x60, 0x80, 60, 0];
    expect(sole([0x00, 0xc0, 14, 0x00, ...on, ...off])).toBe(true);
    expect(sole([0x00, 0xc0, 14, 0x00, 0xc0, 14, 0x00, ...on, ...off])).toBe(false); // identical repeat
    expect(sole([0x00, 0xc0, 14, 0x00, 0xc0, 4, 0x00, ...on, ...off])).toBe(false);
    expect(sole([0x00, 0xb0, 0, 1, 0x00, 0xc0, 14, 0x00, ...on, ...off])).toBe(false); // bank before
    expect(sole([0x00, 0xc0, 14, 0x00, ...on, 0x60, 0xb0, 32, 1, 0x00, 0x80, 60, 0])).toBe(false); // bank later
    expect(sole([0x00, ...on, 0x00, 0xc0, 14, 0x60, 0x80, 60, 0])).toBe(false); // note first
    expect(sole([0x01, 0xc0, 14, 0x00, ...on, ...off])).toBe(false); // tick 1
  });
});
