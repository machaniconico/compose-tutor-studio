import { describe, it, expect } from 'vitest';
import { writeVarLen, midiNoteName, PPQ } from '../src/smf.js';
import { projectToMidi, volumeToCc, panToCc } from '../src/export.js';
import { createEmptyProject } from '@cts/project-model';
import type { Project } from '@cts/project-model';

// ---------------------------------------------------------------------------
// Minimal SMF parser (test-only). Parses MThd + MTrk chunks into structured
// events so we can verify round-trips of note on/off without trusting the
// encoder's own helpers.
// ---------------------------------------------------------------------------

type ParsedEvent =
  | { type: 'noteOn'; tick: number; channel: number; pitch: number; velocity: number }
  | { type: 'noteOff'; tick: number; channel: number; pitch: number; velocity: number }
  | { type: 'controller'; tick: number; channel: number; controller: number; value: number }
  | { type: 'meta'; tick: number; metaType: number; data: number[] };

type ParsedTrack = { events: ParsedEvent[] };

type ParsedFile = {
  format: number;
  numTracks: number;
  division: number;
  tracks: ParsedTrack[];
};

function parseSmf(bytes: Uint8Array): ParsedFile {
  const ascii = (off: number, len: number): string =>
    String.fromCharCode(...bytes.slice(off, off + len));
  const u16 = (off: number): number => (bytes[off]! << 8) | bytes[off + 1]!;
  const u32 = (off: number): number =>
    (bytes[off]! << 24) | (bytes[off + 1]! << 16) | (bytes[off + 2]! << 8) | bytes[off + 3]!;

  if (ascii(0, 4) !== 'MThd') throw new Error('missing MThd');
  const format = u16(8);
  const numTracks = u16(10);
  const division = u16(12);

  const tracks: ParsedTrack[] = [];
  let pos = 14;
  while (pos < bytes.length) {
    if (ascii(pos, 4) !== 'MTrk') throw new Error(`expected MTrk at ${pos}`);
    const len = u32(pos + 4);
    const start = pos + 8;
    const end = start + len;
    tracks.push(parseTrack(bytes, start, end));
    pos = end;
  }

  return { format, numTracks, division, tracks };
}

function parseTrack(bytes: Uint8Array, start: number, end: number): ParsedTrack {
  const events: ParsedEvent[] = [];
  let pos = start;
  let tick = 0;
  let runningStatus = 0;

  const readVlq = (): number => {
    let value = 0;
    while (true) {
      const b = bytes[pos++]!;
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return value;
  };

  while (pos < end) {
    tick += readVlq();
    let status = bytes[pos]!;
    if (status & 0x80) {
      pos++;
      runningStatus = status;
    } else {
      status = runningStatus; // running status (data byte without new status)
    }

    if (status === 0xff) {
      // meta event
      const metaType = bytes[pos++]!;
      const len = readVlq();
      const data = Array.from(bytes.slice(pos, pos + len));
      pos += len;
      events.push({ type: 'meta', tick, metaType, data });
      continue;
    }

    const channel = status & 0x0f;
    const hi = status & 0xf0;
    if (hi === 0x90) {
      const pitch = bytes[pos++]!;
      const velocity = bytes[pos++]!;
      events.push(
        velocity === 0
          ? { type: 'noteOff', tick, channel, pitch, velocity }
          : { type: 'noteOn', tick, channel, pitch, velocity },
      );
    } else if (hi === 0x80) {
      const pitch = bytes[pos++]!;
      const velocity = bytes[pos++]!;
      events.push({ type: 'noteOff', tick, channel, pitch, velocity });
    } else if (hi === 0xb0) {
      const controller = bytes[pos++]!;
      const value = bytes[pos++]!;
      events.push({ type: 'controller', tick, channel, controller, value });
    } else {
      throw new Error(`unhandled status 0x${status.toString(16)} at ${pos}`);
    }
  }
  return { events };
}

// ---------------------------------------------------------------------------
// VLQ edge cases
// ---------------------------------------------------------------------------
describe('writeVarLen edge cases', () => {
  it('encodes the spec edge values', () => {
    expect(writeVarLen(0)).toEqual([0x00]);
    expect(writeVarLen(127)).toEqual([0x7f]);
    expect(writeVarLen(128)).toEqual([0x81, 0x00]);
    expect(writeVarLen(16383)).toEqual([0xff, 0x7f]);
    expect(writeVarLen(16384)).toEqual([0x81, 0x80, 0x00]);
  });
});

// ---------------------------------------------------------------------------
// midiNoteName
// ---------------------------------------------------------------------------
describe('midiNoteName', () => {
  it('names common pitches', () => {
    expect(midiNoteName(60)).toBe('C4');
    expect(midiNoteName(69)).toBe('A4');
    expect(midiNoteName(0)).toBe('C-1');
    expect(midiNoteName(127)).toBe('G9');
    expect(midiNoteName(61)).toBe('C#4');
  });
  it('rejects out-of-range pitches', () => {
    expect(() => midiNoteName(-1)).toThrow();
    expect(() => midiNoteName(128)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CC mapping
// ---------------------------------------------------------------------------
describe('volume/pan CC mapping', () => {
  it('maps volume 0..2 to CC 0..127', () => {
    expect(volumeToCc(0)).toBe(0);
    expect(volumeToCc(1)).toBe(64); // half of 2 -> 0.5 -> 63.5 -> round 64
    expect(volumeToCc(2)).toBe(127);
    expect(volumeToCc(5)).toBe(127); // clamped
  });
  it('maps pan -1..1 to CC 0..127 (center 64)', () => {
    expect(panToCc(-1)).toBe(0);
    expect(panToCc(0)).toBe(64);
    expect(panToCc(1)).toBe(127);
    expect(panToCc(-2)).toBe(0); // clamped
  });
});

// ---------------------------------------------------------------------------
// Header + tiny project hand-computed deltas, parsed via the minimal parser
// ---------------------------------------------------------------------------
function tinyProject(): Project {
  // One instrument track, one drum track, one chord, deterministic ids.
  const project: Project = {
    id: 'p',
    schemaVersion: 1,
    title: 'Tiny',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    tracks: [
      {
        id: 'inst',
        name: 'Lead',
        type: 'instrument',
        clips: [
          {
            id: 'c1',
            trackId: 'inst',
            type: 'midi',
            startBeat: 1, // clip offset applied
            lengthBeats: 4,
            loop: false,
            notes: [
              { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
              { id: 'n2', pitch: 67, startBeat: 1, durationBeats: 2, velocity: 80 },
            ],
          },
        ],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
      {
        id: 'drm',
        name: 'Drums',
        type: 'drum',
        clips: [
          {
            id: 'd1',
            trackId: 'drm',
            type: 'drum',
            startBeat: 0,
            lengthBeats: 4,
            loop: false,
            stepsPerBar: 16,
            drumEvents: [
              { id: 'k', lane: 'kick', stepIndex: 0, velocity: 110 },
              { id: 's', lane: 'snare', stepIndex: 4, velocity: 110 },
              { id: 'h', lane: 'closedHat', stepIndex: 2, velocity: 90 },
            ],
          },
        ],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
    ],
    chordTrack: [
      { id: 'ch1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] },
    ],
    sections: [],
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
  };
  return project;
}

describe('projectToMidi header', () => {
  it('emits MThd, format 1, PPQ 480, and 3 tracks (tempo + 2)', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    expect(parsed.format).toBe(1);
    expect(parsed.division).toBe(PPQ);
    expect(parsed.numTracks).toBe(3);
    expect(parsed.tracks).toHaveLength(3);
  });
});

describe('projectToMidi note timing (hand-computed)', () => {
  it('applies clip.startBeat offset and exact tick positions', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    const instTrack = parsed.tracks[1]!; // tempo=0, inst=1, drum=2
    const noteOns = instTrack.events.filter((e) => e.type === 'noteOn');
    const noteOffs = instTrack.events.filter((e) => e.type === 'noteOff');

    // n1: clip start 1 + note start 0 = beat 1 -> tick 480; off at beat 2 -> 960
    // n2: beat 1+1 = 2 -> tick 960; off at beat 2+2 = 4 -> 1920
    const on60 = noteOns.find((e) => e.type === 'noteOn' && e.pitch === 60)!;
    const on67 = noteOns.find((e) => e.type === 'noteOn' && e.pitch === 67)!;
    expect(on60.tick).toBe(480);
    expect(on67.tick).toBe(960);
    expect(on60.channel).toBe(0); // first non-drum channel

    const off60 = noteOffs.find((e) => e.pitch === 60)!;
    const off67 = noteOffs.find((e) => e.pitch === 67)!;
    expect(off60.tick).toBe(960);
    expect(off67.tick).toBe(1920);
  });

  it('emits CC7/CC10 at tick 0 on the instrument track', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    const instTrack = parsed.tracks[1]!;
    const cc7 = instTrack.events.find((e) => e.type === 'controller' && e.controller === 7);
    const cc10 = instTrack.events.find((e) => e.type === 'controller' && e.controller === 10);
    expect(cc7).toBeDefined();
    expect(cc10).toBeDefined();
    expect((cc7 as { value: number }).value).toBe(64); // volume 1 -> 64
    expect((cc10 as { value: number }).value).toBe(64); // pan 0 -> 64
  });
});

describe('projectToMidi drum mapping', () => {
  it('maps lanes to GM notes on channel 9 with 1/4-beat duration', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    const drumTrack = parsed.tracks[2]!;
    const ons = drumTrack.events.filter((e) => e.type === 'noteOn');

    const kick = ons.find((e) => e.type === 'noteOn' && e.pitch === 36)!;
    const snare = ons.find((e) => e.type === 'noteOn' && e.pitch === 38)!;
    const hat = ons.find((e) => e.type === 'noteOn' && e.pitch === 42)!;
    expect(kick).toBeDefined();
    expect(snare).toBeDefined();
    expect(hat).toBeDefined();
    expect(kick.channel).toBe(9);

    // stepsPerBar=16 -> beatsPerStep = 0.25.
    // kick step 0 -> beat 0 -> tick 0
    // snare step 4 -> beat 1 -> tick 480
    // hat step 2 -> beat 0.5 -> tick 240
    expect(kick.tick).toBe(0);
    expect(snare.tick).toBe(480);
    expect(hat.tick).toBe(240);

    // 1/4-beat duration: kick off at beat 0.25 -> tick 120
    const kickOff = drumTrack.events.find((e) => e.type === 'noteOff' && e.pitch === 36)!;
    expect(kickOff.tick).toBe(120);
  });
});

describe('projectToMidi chord markers', () => {
  it('emits FF 06 markers on the tempo track at chord start', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    const tempoTrack = parsed.tracks[0]!;
    const markers = tempoTrack.events.filter((e) => e.type === 'meta' && e.metaType === 0x06);
    expect(markers).toHaveLength(1);
    const marker = markers[0] as { tick: number; data: number[] };
    expect(marker.tick).toBe(0);
    expect(String.fromCharCode(...marker.data)).toBe('C');
  });

  it('emits tempo (FF 51) and time signature (FF 58) on the tempo track', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    const tempoTrack = parsed.tracks[0]!;
    expect(tempoTrack.events.some((e) => e.type === 'meta' && e.metaType === 0x51)).toBe(true);
    expect(tempoTrack.events.some((e) => e.type === 'meta' && e.metaType === 0x58)).toBe(true);
  });

  it('ends every track with an end-of-track meta (FF 2F)', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    for (const track of parsed.tracks) {
      const last = track.events[track.events.length - 1]!;
      expect(last.type).toBe('meta');
      expect((last as { metaType: number }).metaType).toBe(0x2f);
    }
  });
});

describe('projectToMidi channel allocation', () => {
  it('assigns non-drum channels sequentially skipping 9', () => {
    const project = createEmptyProject({ clock: () => new Date('2026-06-11T00:00:00.000Z') });
    // Give each instrument clip a note so the tracks emit channel events.
    for (const track of project.tracks) {
      if (track.type === 'instrument') {
        track.clips[0]!.notes = [
          { id: `${track.id}-n`, pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
        ];
      }
    }
    const parsed = parseSmf(projectToMidi(project));
    const channelsUsed = new Set<number>();
    for (const track of parsed.tracks) {
      for (const e of track.events) {
        if (e.type === 'noteOn' || e.type === 'noteOff' || e.type === 'controller') {
          channelsUsed.add(e.channel);
        }
      }
    }
    // Default project: 3 instrument tracks -> channels 0,1,2; drums -> 9.
    expect(channelsUsed.has(9)).toBe(true); // drums
    expect([...channelsUsed].filter((c) => c !== 9).every((c) => c < 9)).toBe(true);
  });
});

describe('projectToMidi loop unrolling', () => {
  it('repeats a looped clip across its length', () => {
    const project = tinyProject();
    // Replace the instrument clip with a 1-beat looped pattern over 4 beats.
    project.tracks[0]!.clips = [
      {
        id: 'loop',
        trackId: 'inst',
        type: 'midi',
        startBeat: 0,
        lengthBeats: 4,
        loop: true,
        notes: [{ id: 'lp', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
      },
    ];
    const parsed = parseSmf(projectToMidi(project));
    const ons = parsed.tracks[1]!.events.filter((e) => e.type === 'noteOn' && e.pitch === 60);
    // Pattern length 1 beat, clip length 4 -> 4 repetitions at ticks 0,480,960,1440
    expect(ons.map((e) => e.tick)).toEqual([0, 480, 960, 1440]);
  });
});
