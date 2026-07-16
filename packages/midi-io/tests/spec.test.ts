import { describe, it, expect } from 'vitest';
import { writeVarLen, midiNoteName, PPQ } from '../src/smf.js';
import {
  projectToMidi,
  projectToMidiResult,
  volumeToCc,
  panToCc,
} from '../src/export.js';
import { CURRENT_SCHEMA_VERSION, createEmptyProject } from '@cts/project-model';
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
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Tiny',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [{ id: 'tempo-0', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'time-signature-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    automationLanes: [],
    audioRouting: {
      outputs: [
        { sourceTrackId: 'inst', destination: { type: 'master' } },
        { sourceTrackId: 'drm', destination: { type: 'master' } },
      ],
      sends: [],
    },
    tracks: [
      {
        id: 'inst',
        name: 'Lead',
        type: 'instrument',
        role: 'general',
        clips: [
          {
            id: 'c1',
            trackId: 'inst',
            type: 'midi',
            startBeat: 1, // clip offset applied
            lengthBeats: 3,
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
        role: 'general',
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

const MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15] as const;

function projectWithMelodicTracks(trackCount: number): Project {
  const tracks = Array.from({ length: trackCount }, (_, index) => ({
    id: `instrument-${index}`,
    name: `Instrument ${index + 1}`,
    type: 'instrument' as const,
    role: 'general' as const,
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  }));
  return {
    ...tinyProject(),
    title: `${trackCount} melodic tracks`,
    tracks,
    audioRouting: {
      outputs: tracks.map((track) => ({
        sourceTrackId: track.id,
        destination: { type: 'master' as const },
      })),
      sends: [],
    },
    chordTrack: [],
  };
}

function controllerChannel(track: ParsedTrack): number {
  const controller = track.events.find((event) => event.type === 'controller');
  if (!controller || controller.type !== 'controller') {
    throw new Error('expected a controller event for the exported track');
  }
  return controller.channel;
}

function midiPort(track: ParsedTrack): number {
  const ports = track.events.filter(
    (event) => event.type === 'meta' && event.metaType === 0x21,
  );
  expect(ports).toHaveLength(1);
  const port = ports[0];
  if (!port || port.type !== 'meta') throw new Error('expected a MIDI Port meta event');
  expect(port.tick).toBe(0);
  expect(port.data).toHaveLength(1);
  return port.data[0]!;
}

describe('projectToMidi header', () => {
  it('emits MThd, format 1, PPQ 480, and 3 tracks (tempo + 2)', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    expect(parsed.format).toBe(1);
    expect(parsed.division).toBe(PPQ);
    expect(parsed.numTracks).toBe(3);
    expect(parsed.tracks).toHaveLength(3);
  });

  it.each([1, 15, 16, 128])(
    'keeps %i melodic tracks separate while reusing only non-drum channels',
    (trackCount) => {
      const parsed = parseSmf(projectToMidi(projectWithMelodicTracks(trackCount)));
      const expectedChannels = Array.from(
        { length: trackCount },
        (_, index) => MELODIC_CHANNELS[index % MELODIC_CHANNELS.length],
      );
      const expectedPorts = Array.from(
        { length: trackCount },
        (_, index) => Math.floor(index / MELODIC_CHANNELS.length),
      );

      expect(parsed.format).toBe(1);
      expect(parsed.numTracks).toBe(trackCount + 1);
      expect(parsed.tracks).toHaveLength(trackCount + 1);
      expect(parsed.tracks.slice(1).map(controllerChannel)).toEqual(expectedChannels);
      expect(parsed.tracks.slice(1).map(midiPort)).toEqual(expectedPorts);
      expect(expectedChannels).not.toContain(9);

      const destinations = parsed.tracks.slice(1).map(
        (track) => `${midiPort(track)}:${controllerChannel(track)}`,
      );
      expect(new Set(destinations).size).toBe(trackCount);
    },
  );

  it('keeps conflicting CC7/CC10 values isolated when channel numbers repeat', () => {
    const project = projectWithMelodicTracks(16);
    project.tracks[0]!.volume = 0;
    project.tracks[0]!.pan = -1;
    project.tracks[15]!.volume = 2;
    project.tracks[15]!.pan = 1;

    const parsed = parseSmf(projectToMidi(project));
    const first = parsed.tracks[1]!;
    const sixteenth = parsed.tracks[16]!;
    const controllers = (track: ParsedTrack): Array<[number, number]> =>
      track.events.flatMap((event) =>
        event.type === 'controller'
          ? [[event.controller, event.value] as [number, number]]
          : [],
      );

    expect(controllerChannel(first)).toBe(0);
    expect(controllerChannel(sixteenth)).toBe(0);
    expect(midiPort(first)).toBe(0);
    expect(midiPort(sixteenth)).toBe(1);
    expect(controllers(first)).toEqual([[7, 0], [10, 0]]);
    expect(controllers(sixteenth)).toEqual([[7, 127], [10, 127]]);
  });

  it('isolates multiple drum tracks on channel 9 by assigning distinct ports', () => {
    const project = tinyProject();
    const source = project.tracks.find((track) => track.type === 'drum');
    if (!source) throw new Error('expected a drum-track fixture');
    project.chordTrack = [];
    project.tracks = Array.from({ length: 4 }, (_, index) => ({
      ...source,
      id: `drum-${index}`,
      name: `Drums ${index + 1}`,
      clips: [],
      volume: 0.5 + index * 0.25,
      pan: -0.75 + index * 0.5,
    }));

    const parsed = parseSmf(projectToMidi(project));
    const tracks = parsed.tracks.slice(1);
    expect(tracks.map(controllerChannel)).toEqual([9, 9, 9, 9]);
    expect(tracks.map(midiPort)).toEqual([0, 1, 2, 3]);
    expect(
      tracks.map((track) => `${midiPort(track)}:${controllerChannel(track)}`),
    ).toEqual(['0:9', '1:9', '2:9', '3:9']);
  });

  it('uses the bounded 0..127 MIDI Port range for 128 drum tracks', () => {
    const project = tinyProject();
    const source = project.tracks.find((track) => track.type === 'drum');
    if (!source) throw new Error('expected a drum-track fixture');
    project.chordTrack = [];
    project.tracks = Array.from({ length: 128 }, (_, index) => ({
      ...source,
      id: `drum-${index}`,
      name: `Drums ${index + 1}`,
      clips: [],
      volume: 1,
      pan: 0,
    }));

    const parsed = parseSmf(projectToMidi(project));
    const tracks = parsed.tracks.slice(1);
    expect(tracks).toHaveLength(128);
    expect(tracks.map(controllerChannel)).toEqual(Array.from({ length: 128 }, () => 9));
    expect(tracks.map(midiPort)).toEqual(Array.from({ length: 128 }, (_, index) => index));
  });

  it('keeps all destinations unique in a 128-track mixed melodic/drum project', () => {
    const project = tinyProject();
    const instrument = project.tracks.find((track) => track.type === 'instrument');
    const drum = project.tracks.find((track) => track.type === 'drum');
    if (!instrument || !drum) throw new Error('expected mixed-track fixtures');
    project.chordTrack = [];
    project.tracks = Array.from({ length: 128 }, (_, index) => {
      const source = index % 2 === 0 ? instrument : drum;
      return {
        ...source,
        id: `mixed-${index}`,
        name: `Mixed ${index + 1}`,
        clips: [],
      };
    });

    const parsed = parseSmf(projectToMidi(project));
    const tracks = parsed.tracks.slice(1);
    const destinations = tracks.map(
      (track) => `${midiPort(track)}:${controllerChannel(track)}`,
    );
    expect(tracks).toHaveLength(128);
    expect(new Set(destinations).size).toBe(128);
    expect(tracks.filter((track) => controllerChannel(track) === 9)).toHaveLength(64);
    expect(tracks.filter((track) => controllerChannel(track) !== 9)).toHaveLength(64);
  });

  it('writes the MIDI Port event before channel events at the track start', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    for (const track of parsed.tracks.slice(1)) {
      const portIndex = track.events.findIndex(
        (event) => event.type === 'meta' && event.metaType === 0x21,
      );
      const firstChannelIndex = track.events.findIndex(
        (event) => event.type === 'controller'
          || event.type === 'noteOn'
          || event.type === 'noteOff',
      );
      expect(portIndex).toBeGreaterThanOrEqual(0);
      expect(firstChannelIndex).toBeGreaterThan(portIndex);
    }
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

  it('projects linked clip content at both instance positions', () => {
    const project = tinyProject();
    const instrument = project.tracks[0]!;
    const source = {
      ...instrument.clips[0]!,
      id: 'source-pattern',
      startBeat: 0,
      lengthBeats: 4,
      notes: [
        { id: 'shared-note', pitch: 65, startBeat: 0, durationBeats: 1, velocity: 100 },
      ],
    };
    const linked = {
      id: 'linked-pattern',
      trackId: instrument.id,
      type: 'midi' as const,
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      aliasOf: source.id,
    };
    project.lengthBars = 2;
    project.chordTrack = [];
    project.tracks = [{ ...instrument, clips: [source, linked] }];

    const parsed = parseSmf(projectToMidi(project));
    const noteOns = parsed.tracks[1]!.events.filter(
      (event) => event.type === 'noteOn' && event.pitch === 65,
    );

    expect(noteOns.map((event) => event.tick)).toEqual([0, 4 * PPQ]);
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

describe('projectToMidi tempo track', () => {
  it('emits FF 06 markers on the tempo track at chord start', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    const tempoTrack = parsed.tracks[0]!;
    const markers = tempoTrack.events.filter((e) => e.type === 'meta' && e.metaType === 0x06);
    expect(markers).toHaveLength(1);
    const marker = markers[0] as { tick: number; data: number[] };
    expect(marker.tick).toBe(0);
    expect(String.fromCharCode(...marker.data)).toBe('C');
  });

  it('writes project, track, and chord marker text as raw UTF-8 bytes', () => {
    const project = tinyProject();
    project.title = '日本語の曲🎵';
    project.tracks[0]!.name = 'メロディ🎹';
    project.chordTrack[0]!.symbol = '雪Dm♭';

    const parsed = parseSmf(projectToMidi(project));
    const projectName = parsed.tracks[0]!.events.find(
      (event) => event.type === 'meta' && event.metaType === 0x03,
    );
    const trackName = parsed.tracks[1]!.events.find(
      (event) => event.type === 'meta' && event.metaType === 0x03,
    );
    const marker = parsed.tracks[0]!.events.find(
      (event) => event.type === 'meta' && event.metaType === 0x06,
    );

    expect(projectName).toMatchObject({
      type: 'meta',
      data: Array.from(new TextEncoder().encode(project.title)),
    });
    expect(trackName).toMatchObject({
      type: 'meta',
      data: Array.from(new TextEncoder().encode(project.tracks[0]!.name)),
    });
    expect(marker).toMatchObject({
      type: 'meta',
      data: Array.from(new TextEncoder().encode(project.chordTrack[0]!.symbol)),
    });
  });

  it('emits the single canonical tempo and time-signature map points at tick zero', () => {
    const parsed = parseSmf(projectToMidi(tinyProject()));
    const tempoTrack = parsed.tracks[0]!;
    expect(tempoTrack.events.filter(
      (event) => event.type === 'meta' && event.metaType === 0x51,
    )).toEqual([{
      type: 'meta',
      tick: 0,
      metaType: 0x51,
      data: [0x07, 0xa1, 0x20],
    }]);
    expect(tempoTrack.events.filter(
      (event) => event.type === 'meta' && event.metaType === 0x58,
    )).toEqual([{
      type: 'meta',
      tick: 0,
      metaType: 0x58,
      data: [4, 2, 24, 8],
    }]);
  });

  it('keeps the pre-v3 scalar fallback when timeline maps are absent', () => {
    const legacy = structuredClone(tinyProject()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 2;
    legacy.bpm = 90;
    legacy.timeSignature = [3, 4];
    delete legacy.tempoMap;
    delete legacy.timeSignatureMap;

    const tempoTrack = parseSmf(projectToMidi(legacy as unknown as Project)).tracks[0]!;
    expect(tempoTrack.events.filter(
      (event) => event.type === 'meta' && event.metaType === 0x51,
    )).toEqual([{
      type: 'meta',
      tick: 0,
      metaType: 0x51,
      data: [0x0a, 0x2c, 0x2b],
    }]);
    expect(tempoTrack.events.filter(
      (event) => event.type === 'meta' && event.metaType === 0x58,
    )).toEqual([{
      type: 'meta',
      tick: 0,
      metaType: 0x58,
      data: [3, 2, 24, 8],
    }]);
  });

  it('exports every map point, ignores scalar mirrors, and orders quantized duplicate ticks', () => {
    const project = tinyProject();
    project.bpm = 33;
    project.timeSignature = [7, 8];
    project.lengthBars = 2;
    project.lengthBeats = 8;
    project.tempoMap = [
      { id: 'tempo-start', beat: 0, bpm: 120 },
      { id: 'tempo-slow', beat: 4, bpm: 60 },
      { id: 'tempo-fast', beat: 4.004, bpm: 240 },
    ];
    project.timeSignatureMap = [
      { id: 'meter-start', beat: 0, numerator: 4, denominator: 4 },
      { id: 'meter-three', beat: 4, numerator: 3, denominator: 4 },
      { id: 'meter-five', beat: 4.004, numerator: 5, denominator: 8 },
    ];

    const first = projectToMidi(project, { ppq: 100 });
    const second = projectToMidi(project, { ppq: 100 });
    const tempoTrack = parseSmf(first).tracks[0]!;

    expect(second).toEqual(first);
    expect(tempoTrack.events.filter(
      (event) => event.type === 'meta' && event.metaType === 0x51,
    )).toEqual([
      { type: 'meta', tick: 0, metaType: 0x51, data: [0x07, 0xa1, 0x20] },
      { type: 'meta', tick: 400, metaType: 0x51, data: [0x0f, 0x42, 0x40] },
      { type: 'meta', tick: 400, metaType: 0x51, data: [0x03, 0xd0, 0x90] },
    ]);
    expect(tempoTrack.events.filter(
      (event) => event.type === 'meta' && event.metaType === 0x58,
    )).toEqual([
      { type: 'meta', tick: 0, metaType: 0x58, data: [4, 2, 24, 8] },
      { type: 'meta', tick: 400, metaType: 0x58, data: [3, 2, 24, 8] },
      { type: 'meta', tick: 400, metaType: 0x58, data: [5, 3, 24, 8] },
    ]);
  });

  it.each([
    ['tempoMap', []],
    ['timeSignatureMap', []],
    ['tempoMap', [
      { id: 'tempo-a', beat: 0, bpm: 120 },
      { id: 'tempo-b', beat: 0, bpm: 90 },
    ]],
  ] as const)('rejects a non-canonical %s instead of falling back to scalars', (field, value) => {
    const project = tinyProject();
    Object.assign(project, { [field]: value });

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
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

// ---------------------------------------------------------------------------
// Project chord realization — audible harmony on the dedicated Chords track
// ---------------------------------------------------------------------------
function chordPlaybackProject(): Project {
  const project = createEmptyProject({
    lengthBars: 1,
    clock: () => new Date('2026-07-10T00:00:00.000Z'),
  });
  project.chordTrack = [
    {
      id: 'c-major',
      startBeat: 1,
      durationBeats: 2,
      symbol: 'C',
      root: 'C',
      quality: 'major',
      notes: [0, 4, 7],
    },
    {
      id: 'g-major',
      startBeat: 3,
      durationBeats: 1,
      symbol: 'G',
      root: 'G',
      quality: 'major',
      notes: [7, 11, 2],
    },
  ];
  return project;
}

describe('projectToMidi chord playback', () => {
  it('writes realized chord note-on/off events at exact source ticks', () => {
    const parsed = parseSmf(projectToMidi(chordPlaybackProject()));
    const chordsTrack = parsed.tracks[1]!; // tempo=0, Chords=1
    const noteOns = chordsTrack.events.filter((event) => event.type === 'noteOn');
    const noteOffs = chordsTrack.events.filter((event) => event.type === 'noteOff');

    expect(
      noteOns.map((event) =>
        event.type === 'noteOn'
          ? { tick: event.tick, pitch: event.pitch, velocity: event.velocity, channel: event.channel }
          : null,
      ),
    ).toEqual([
      { tick: 1 * PPQ, pitch: 48, velocity: 80, channel: 0 },
      { tick: 1 * PPQ, pitch: 52, velocity: 80, channel: 0 },
      { tick: 1 * PPQ, pitch: 55, velocity: 80, channel: 0 },
      { tick: 3 * PPQ, pitch: 55, velocity: 80, channel: 0 },
      { tick: 3 * PPQ, pitch: 59, velocity: 80, channel: 0 },
      { tick: 3 * PPQ, pitch: 62, velocity: 80, channel: 0 },
    ]);
    expect(
      noteOffs.map((event) =>
        event.type === 'noteOff' ? { tick: event.tick, pitch: event.pitch } : null,
      ),
    ).toEqual([
      { tick: 3 * PPQ, pitch: 48 },
      { tick: 3 * PPQ, pitch: 52 },
      { tick: 3 * PPQ, pitch: 55 },
      { tick: 4 * PPQ, pitch: 55 },
      { tick: 4 * PPQ, pitch: 59 },
      { tick: 4 * PPQ, pitch: 62 },
    ]);
  });

  it('keeps explicit Chords notes and suppresses generated harmony', () => {
    const project = chordPlaybackProject();
    const chordsTrack = project.tracks.find((track) => track.name === 'Chords');
    const clip = chordsTrack?.clips[0];
    if (!clip) throw new Error('test project is missing its Chords clip');
    clip.notes = [
      { id: 'authored', pitch: 72, startBeat: 0.5, durationBeats: 0.5, velocity: 101 },
    ];

    const parsed = parseSmf(projectToMidi(project));
    const noteOns = parsed.tracks[1]!.events.filter((event) => event.type === 'noteOn');

    expect(noteOns).toEqual([
      { type: 'noteOn', tick: 0.5 * PPQ, channel: 0, pitch: 72, velocity: 101 },
    ]);
  });

  it('does not add playable notes when the project Chord Track is empty', () => {
    const project = chordPlaybackProject();
    project.chordTrack = [];

    const parsed = parseSmf(projectToMidi(project));
    const noteOns = parsed.tracks[1]!.events.filter((event) => event.type === 'noteOn');

    expect(noteOns).toEqual([]);
  });

  it('orders note-off before note-on for a shared pitch even when chords are unsorted', () => {
    const project = chordPlaybackProject();
    project.chordTrack = [
      {
        id: 'g-major',
        startBeat: 4,
        durationBeats: 4,
        symbol: 'G',
        root: 'G',
        quality: 'major',
        notes: [7, 11, 2],
      },
      {
        id: 'c-major',
        startBeat: 0,
        durationBeats: 4,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [0, 4, 7],
      },
    ];

    const parsed = parseSmf(projectToMidi(project));
    const boundary = parsed.tracks[1]!.events.filter(
      (event) =>
        event.tick === 4 * PPQ &&
        (event.type === 'noteOn' || event.type === 'noteOff') &&
        event.pitch === 55,
    );

    expect(boundary.map((event) => event.type)).toEqual(['noteOff', 'noteOn']);
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

  it('clips a final partial loop note at the clip end tick', () => {
    const project = tinyProject();
    project.tracks[0]!.clips = [
      {
        id: 'partial-loop',
        trackId: 'inst',
        type: 'midi',
        startBeat: 2,
        lengthBeats: 3.5,
        loop: true,
        notes: [{ id: 'pulse', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
      },
    ];

    const events = parseSmf(projectToMidi(project)).tracks[1]!.events;
    const ons = events.filter((event) => event.type === 'noteOn' && event.pitch === 60);
    const offs = events.filter((event) => event.type === 'noteOff' && event.pitch === 60);

    expect(ons.map((event) => event.tick)).toEqual([960, 1440, 1920, 2400]);
    expect(offs.map((event) => event.tick)).toEqual([1440, 1920, 2400, 2640]);
  });

  it('does not emit a decimal ghost occurrence at the half-open clip end', () => {
    const project = tinyProject();
    project.tracks[0]!.clips = [
      {
        id: 'decimal-loop',
        trackId: 'inst',
        type: 'midi',
        startBeat: 0,
        lengthBeats: 0.9,
        loop: true,
        notes: [{ id: 'decimal', pitch: 60, startBeat: 0, durationBeats: 0.3, velocity: 100 }],
      },
    ];

    const events = parseSmf(projectToMidi(project)).tracks[1]!.events;
    const ons = events.filter((event) => event.type === 'noteOn' && event.pitch === 60);
    const offs = events.filter((event) => event.type === 'noteOff' && event.pitch === 60);

    expect(ons.map((event) => event.tick)).toEqual([0, 144, 288]);
    expect(offs.map((event) => event.tick)).toEqual([144, 288, 432]);
  });

  it('uses a linked instance loop setting independently from its source', () => {
    const project = tinyProject();
    const source = {
      id: 'source-loop-setting',
      trackId: 'inst',
      type: 'midi' as const,
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      notes: [{ id: 'shared', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    project.schemaVersion = CURRENT_SCHEMA_VERSION;
    project.tracks[0]!.clips = [
      source,
      {
        id: 'linked-loop-setting',
        trackId: 'inst',
        type: 'midi',
        startBeat: 4,
        lengthBeats: 4,
        loop: true,
        aliasOf: source.id,
      },
    ];

    const events = parseSmf(projectToMidi(project)).tracks[1]!.events;
    const ons = events.filter((event) => event.type === 'noteOn' && event.pitch === 60);

    expect(source.loop).toBe(false);
    expect(ons.map((event) => event.tick)).toEqual([0, 1920, 2400, 2880, 3360]);

    source.loop = true;
    project.tracks[0]!.clips[1]!.loop = false;
    const inverse = parseSmf(projectToMidi(project)).tracks[1]!.events.filter(
      (event) => event.type === 'noteOn' && event.pitch === 60,
    );
    expect(inverse.map((event) => event.tick)).toEqual([0, 480, 960, 1440, 1920]);
  });

  it('drops a sub-tick partial instead of extending it past the clip', () => {
    const project = tinyProject();
    project.tracks[0]!.clips = [
      {
        id: 'sub-tick-partial',
        trackId: 'inst',
        type: 'midi',
        startBeat: 0,
        lengthBeats: 1.001,
        loop: true,
        notes: [{ id: 'pulse', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
      },
    ];

    const events = parseSmf(projectToMidi(project)).tracks[1]!.events;
    const ons = events.filter((event) => event.type === 'noteOn' && event.pitch === 60);
    const offs = events.filter((event) => event.type === 'noteOff' && event.pitch === 60);

    expect(ons.map((event) => event.tick)).toEqual([0]);
    expect(offs.map((event) => event.tick)).toEqual([480]);

    const once = structuredClone(project);
    once.tracks[0]!.clips[0]!.loop = false;
    const onceResult = projectToMidiResult(once);
    const loopResult = projectToMidiResult(project);
    expect(onceResult.ok).toBe(true);
    expect(loopResult.ok).toBe(true);
    if (!onceResult.ok || !loopResult.ok) return;
    expect(loopResult.eventCount).toBe(onceResult.eventCount);
    expect(projectToMidiResult(project, { maxEvents: onceResult.eventCount }).ok).toBe(true);
  });
});
