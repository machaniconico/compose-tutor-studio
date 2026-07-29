import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  MAX_PROJECT_STRING_LENGTH,
  MAX_PROJECT_TIMELINE_BEATS,
  MAX_PROJECT_TOTAL_ITEMS,
  MIN_EVENT_DURATION_BEATS,
  validateProject,
  type AudioClip,
  type AudioTakeFolder,
  type Project,
  type ReadyAudioAsset,
  type Track,
} from '@cts/project-model';
import {
  DEFAULT_MIDI_PARSE_LIMITS,
  MAX_MIDI_EXPORT_EVENTS,
  MidiExportError,
  MidiImportError,
  buildHeaderChunk,
  concatChunks,
  exportNotesToMidi,
  parseMidiFile,
  projectToMidi,
  projectToMidiResult,
} from '../src/index.js';

function rawTrack(data: readonly number[]): Uint8Array {
  const result = new Uint8Array(8 + data.length);
  result.set([
    0x4d, 0x54, 0x72, 0x6b,
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
  ]);
  result.set(data, 8);
  return result;
}

function formatZeroMidi(data: readonly number[]): Uint8Array {
  return concatChunks(buildHeaderChunk(0, 1, 480), rawTrack(data));
}

function projectWithLoop(lengthBeats: number): Project {
  return {
    id: 'bounded-export',
    schemaVersion: 1,
    title: 'Bounded export',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    lengthBeats: Math.max(32, lengthBeats),
    tempoMap: [{ id: 'bounded-tempo-0', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'bounded-meter-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    audioTakeFolders: [],
    automationLanes: [],
    audioRouting: {
      outputs: [{ sourceTrackId: 'lead', destination: { type: 'master' } }],
      sends: [],
    },
    tracks: [
      {
        id: 'lead',
        name: 'Lead',
        type: 'instrument',
        role: 'general',
        clips: [
          {
            id: 'loop',
            trackId: 'lead',
            type: 'midi',
            startBeat: 0,
            lengthBeats,
            loop: true,
            notes: [
              { id: 'note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
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
    chordTrack: [],
    sections: [],
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
}

type ReadyAudioFixture = Readonly<{
  track: Track;
  clip: AudioClip;
  asset: ReadyAudioAsset;
}>;

function addReadyAudioFixture(project: Project): ReadyAudioFixture {
  project.schemaVersion = CURRENT_SCHEMA_VERSION;
  const asset: ReadyAudioAsset = {
    id: 'asset-1',
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: 'reference.wav',
    mediaType: 'audio/wav',
    byteLength: 384_000,
    sampleRate: 48_000,
    channelCount: 2,
    frameCount: 96_000,
  };
  const clip: AudioClip = {
    id: 'audio-clip',
    trackId: 'audio-track',
    type: 'audio',
    startBeat: 0,
    lengthBeats: 4,
    loop: false,
    audioAssetId: asset.id,
    sourceStartFrame: 4_800,
    sourceFrameCount: 48_000,
    fadeInFrames: 480,
    fadeOutFrames: 960,
    gainDb: -3,
  };
  const track: Track = {
    id: 'audio-track',
    name: 'Audio',
    type: 'audio',
    role: 'general',
    clips: [clip],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
  project.audioAssets.push(asset);
  project.tracks.push(track);
  project.audioRouting.outputs.push({
    sourceTrackId: track.id,
    destination: { type: 'master' },
  });
  return { track, clip, asset };
}

type ReadyAudioTakeFolderFixture = Readonly<{
  project: Project;
  track: Track;
  asset: ReadyAudioAsset;
  folder: AudioTakeFolder;
}>;

function addReadyAudioTakeFolderFixture(project: Project): ReadyAudioTakeFolderFixture {
  const { track, asset } = addReadyAudioFixture(project);
  track.clips = [];
  const folder: AudioTakeFolder = {
    id: 'take-folder-1',
    trackId: track.id,
    startBeat: 0,
    lengthBeats: 4,
    crossfadeMs: 5,
    takes: [
      {
        id: 'take-1',
        audioAssetId: asset.id,
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 0,
        sourceFrameCount: 96_000,
        fadeInFrames: 480,
        fadeOutFrames: 960,
        gainDb: -3,
      },
      {
        id: 'take-2',
        audioAssetId: asset.id,
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 0,
        sourceFrameCount: 96_000,
        fadeInFrames: 240,
        fadeOutFrames: 480,
        gainDb: 0,
      },
    ],
    compSegments: [
      {
        id: 'comp-segment-1',
        takeId: 'take-1',
        offsetBeats: 0,
        lengthBeats: 2,
      },
      {
        id: 'comp-segment-2',
        takeId: 'take-2',
        offsetBeats: 2,
        lengthBeats: 2,
      },
    ],
  };
  project.audioTakeFolders.push(folder);
  return { project, track, asset, folder };
}

type MidiTextField = 'project title' | 'track name' | 'chord marker';

function setMidiText(project: Project, field: MidiTextField, text: string): void {
  if (field === 'project title') {
    project.title = text;
    return;
  }
  if (field === 'track name') {
    project.tracks[0]!.name = text;
    return;
  }
  project.chordTrack = [
    {
      id: 'bounded-marker',
      startBeat: 0,
      durationBeats: 4,
      symbol: text,
      root: 'C',
      quality: 'major',
      notes: [0, 4, 7],
    },
  ];
}

describe('bounded MIDI parsing', () => {
  it('pairs overlapping same-key notes FIFO without Array.shift semantics', () => {
    const parsed = parseMidiFile(formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x0a, 60, 80,
      0x0a, 60, 0,
      0x0a, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]));

    expect(parsed.tracks[0]!.notes).toEqual([
      expect.objectContaining({ startTick: 0, durationTick: 20, velocity: 100 }),
      expect.objectContaining({ startTick: 10, durationTick: 20, velocity: 80 }),
    ]);
  });

  it('stops at the event budget with a structured error', () => {
    const midi = formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x01, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const parse = () => parseMidiFile(midi, { limits: { maxEvents: 2 } });
    expect(parse).toThrowError(MidiImportError);
    expect(parse).toThrowError(
      expect.objectContaining({ code: 'event-limit-exceeded', limit: 2 }),
    );
  });

  it('stops while producing notes rather than normalizing an oversized array', () => {
    const midi = formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x01, 60, 0,
      0x00, 0x90, 62, 100,
      0x01, 62, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    expect(() => parseMidiFile(midi, { limits: { maxNotes: 1 } })).toThrowError(
      expect.objectContaining({ code: 'note-limit-exceeded', limit: 1 }),
    );
  });

  it('bounds overlapping active-note depth before queue growth', () => {
    const midi = formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x00, 60, 90,
      0x00, 60, 0,
      0x00, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    expect(() =>
      parseMidiFile(midi, { limits: { maxActiveNotesPerKey: 1 } }),
    ).toThrowError(
      expect.objectContaining({
        code: 'active-note-limit-exceeded',
        limit: 1,
      }),
    );
  });

  it('bounds tempo events before building the prefix timeline', () => {
    const midi = formatZeroMidi([
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
      0x00, 0xff, 0x2f, 0x00,
    ]);
    expect(() => parseMidiFile(midi, { limits: { maxTempoEvents: 1 } })).toThrowError(
      expect.objectContaining({ code: 'tempo-event-limit-exceeded', limit: 1 }),
    );
  });

  it('uses a tempo prefix timeline across multiple tempo regions', () => {
    const parsed = parseMidiFile(formatZeroMidi([
      0x00, 0x90, 60, 100,
      0x78, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
      0x78, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x78, 0x80, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]));

    // 120 ticks at 120 BPM + 120 at 60 BPM + 120 at 120 BPM, PPQ 480.
    expect(parsed.tracks[0]!.notes[0]!.durationSeconds).toBeCloseTo(0.5);
  });

  it('does not allow callers to raise hard parser ceilings', () => {
    const midi = formatZeroMidi([0x00, 0xff, 0x2f, 0x00]);
    expect(() =>
      parseMidiFile(midi, {
        limits: { maxNotes: DEFAULT_MIDI_PARSE_LIMITS.maxNotes + 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-options' }));
  });
});

describe('bounded MIDI project export', () => {
  it('returns bytes and an exact event count for a normal project', () => {
    const result = projectToMidiResult(projectWithLoop(4));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eventCount).toBe(17); // Includes MIDI Port and both end-of-track events.
    expect(result.bytes).toEqual(projectToMidi(projectWithLoop(4)));
  });

  it('returns a structured limit failure before a huge loop expands', () => {
    const result = projectToMidiResult(projectWithLoop(100_000), { maxEvents: 64 });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'event-limit-exceeded', limit: 64 }),
    });
  });

  it('turns the compatibility API failure into MidiExportError, not RangeError', () => {
    const exportMidi = () => projectToMidi(projectWithLoop(100_000), { maxEvents: 64 });
    expect(exportMidi).toThrowError(MidiExportError);
    expect(exportMidi).toThrowError(
      expect.objectContaining({ code: 'event-limit-exceeded', limit: 64 }),
    );
  });

  it('exports a large bounded loop without spread-call stack overflow', () => {
    const result = projectToMidiResult(projectWithLoop(90_000));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eventCount).toBe(180_009);
    expect(result.bytes.byteLength).toBeGreaterThan(500_000);
  });

  it('rejects subnormal loop patterns before iterating', () => {
    const project = projectWithLoop(32);
    project.tracks[0]!.clips[0]!.notes![0]!.durationBeats = Number.MIN_VALUE;
    const result = projectToMidiResult(project);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'event-limit-exceeded' }),
    });
  });

  it.each([
    { field: 'pitch' as const, value: 128 },
    { field: 'velocity' as const, value: 0 },
  ])('rejects invalid $field even when a low-PPQ occurrence would be omitted', ({
    field,
    value,
  }) => {
    const project = projectWithLoop(0.25);
    const note = project.tracks[0]!.clips[0]!.notes![0]!;
    note.durationBeats = 0.25;
    note[field] = value;

    expect(projectToMidiResult(project, { ppq: 1 })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('bounds cumulative note-projection work across many fully omitted clips', () => {
    const build = (clipCount: number) => {
      const project = projectWithLoop(0.499);
      const source = project.tracks[0]!.clips[0]!;
      project.tracks[0]!.clips = Array.from({ length: clipCount }, (_, index) => ({
        ...source,
        id: `omitted-loop-${index}`,
        notes: [{
          id: `omitted-note-${index}`,
          pitch: 60,
          startBeat: 0,
          durationBeats: 1 / 960,
          velocity: 100,
        }],
      }));
      return project;
    };

    const below = projectToMidiResult(build(208), { ppq: 1 });
    expect(below).toMatchObject({ ok: true, eventCount: 9 });
    expect(projectToMidiResult(build(209), { ppq: 1 })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'event-limit-exceeded',
        limit: MAX_MIDI_EXPORT_EVENTS,
      }),
    });
  });

  it('returns structured option errors', () => {
    expect(projectToMidiResult(projectWithLoop(4), { ppq: 0 })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-options' }),
    });
  });

  it.each([
    { label: 'negative', value: -1 },
    { label: 'above 127', value: 128 },
    { label: 'fractional', value: 60.5 },
    { label: 'NaN', value: Number.NaN },
  ])('rejects a $label authored note pitch before serializing', ({ value }) => {
    const project = projectWithLoop(4);
    project.tracks[0]!.clips[0]!.notes![0]!.pitch = value;

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
    expect(() => exportNotesToMidi(project.tracks[0]!.clips[0]!.notes!, 120)).toThrowError(
      expect.objectContaining({ code: 'invalid-project' }),
    );
  });

  it.each([
    { label: 'zero', value: 0 },
    { label: 'negative', value: -1 },
    { label: 'above 127', value: 128 },
    { label: 'fractional', value: 100.5 },
    { label: 'NaN', value: Number.NaN },
  ])('rejects a $label authored note velocity before serializing', ({ value }) => {
    const project = projectWithLoop(4);
    project.tracks[0]!.clips[0]!.notes![0]!.velocity = value;

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
    expect(() => exportNotesToMidi(project.tracks[0]!.clips[0]!.notes!, 120)).toThrowError(
      expect.objectContaining({ code: 'invalid-project' }),
    );
  });

  it.each([
    { label: 'zero', value: 0 },
    { label: 'above 127', value: 128 },
    { label: 'fractional', value: 80.5 },
    { label: 'NaN', value: Number.NaN },
  ])('rejects a $label drum velocity before serializing', ({ value }) => {
    const project = projectWithLoop(4);
    const track = project.tracks[0]!;
    track.type = 'drum';
    track.clips = [
      {
        id: 'drum-clip',
        trackId: track.id,
        type: 'drum',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        stepsPerBar: 16,
        drumEvents: [{ id: 'drum-hit', lane: 'kick', stepIndex: 0, velocity: value }],
      },
    ];

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects drum stepIndex %s instead of projecting it at the clip start',
    (stepIndex) => {
      const project = projectWithLoop(4);
      const track = project.tracks[0]!;
      track.type = 'drum';
      track.clips = [{
        id: 'invalid-step-clip',
        trackId: track.id,
        type: 'drum',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        stepsPerBar: 16,
        drumEvents: [{ id: 'invalid-step', lane: 'kick', stepIndex, velocity: 100 }],
      }];

      expect(projectToMidiResult(project)).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'invalid-project' }),
      });
    },
  );

  it.each([0, 16.5, 129, Number.MAX_SAFE_INTEGER + 1])(
    'rejects drum stepsPerBar %s outside the project-model bound',
    (stepsPerBar) => {
      const project = projectWithLoop(4);
      const track = project.tracks[0]!;
      track.type = 'drum';
      track.clips = [{
        id: 'invalid-resolution-clip',
        trackId: track.id,
        type: 'drum',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        stepsPerBar,
        drumEvents: [{ id: 'kick', lane: 'kick', stepIndex: 0, velocity: 100 }],
      }];

      expect(projectToMidiResult(project)).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'invalid-project' }),
      });
    },
  );

  it('rejects an unknown runtime drum lane instead of writing an undefined pitch byte', () => {
    const project = projectWithLoop(4);
    const track = project.tracks[0]!;
    track.type = 'drum';
    track.clips = [
      {
        id: 'drum-clip',
        trackId: track.id,
        type: 'drum',
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        stepsPerBar: 16,
        drumEvents: [
          {
            id: 'drum-hit',
            lane: 'unknown' as never,
            stepIndex: 0,
            velocity: 100,
          },
        ],
      },
    ];

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects a drum clip on an instrument track before destinations can collide', () => {
    const project = projectWithLoop(4);
    const track = project.tracks[0]!;
    track.clips = [{
      id: 'wrong-drum-clip',
      trackId: track.id,
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'kick', lane: 'kick', stepIndex: 0, velocity: 100 }],
    }];

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects a MIDI clip on a drum track instead of reinterpreting pitches as percussion', () => {
    const project = projectWithLoop(4);
    project.tracks[0]!.type = 'drum';

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects conflicting clip payloads and containing-track references', () => {
    const conflicting = projectWithLoop(4);
    conflicting.tracks[0]!.clips[0]!.drumEvents = [
      { id: 'kick', lane: 'kick', stepIndex: 0, velocity: 100 },
    ];
    expect(projectToMidiResult(conflicting)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });

    const mismatchedTrack = projectWithLoop(4);
    mismatchedTrack.tracks[0]!.clips[0]!.trackId = 'another-track';
    expect(projectToMidiResult(mismatchedTrack)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it.each([60.5, -1, 128, Number.NaN])(
    'rejects invalid source chord pitch %s before chord realization',
    (pitch) => {
      const project = projectWithLoop(4);
      project.chordTrack = [{
        id: 'invalid-chord',
        startBeat: 0,
        durationBeats: 4,
        symbol: 'C',
        root: 'C',
        quality: 'major',
        notes: [pitch],
      }];

      expect(projectToMidiResult(project)).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'invalid-project' }),
      });
    },
  );

  it('deliberately omits valid automation and audio clips from the MIDI projection', () => {
    const project = projectWithLoop(4);
    const instrument = project.tracks[0]!;
    instrument.clips.push({
      id: 'automation',
      trackId: instrument.id,
      type: 'automation',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
    });
    addReadyAudioFixture(project);

    expect(validateProject(project).ok).toBe(true);
    const result = projectToMidiResult(project);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.bytes).toEqual(projectToMidi(projectWithLoop(4)));
    const parsed = parseMidiFile(result.bytes);
    expect(parsed.tracks.some((track) => track.name === 'Audio')).toBe(false);
    expect(parsed.tracks.filter((track) => track.notes.length > 0)).toHaveLength(1);
  });

  it('strictly validates but deliberately omits a valid Audio take folder', () => {
    const project = projectWithLoop(4);
    addReadyAudioTakeFolderFixture(project);

    expect(validateProject(project).ok).toBe(true);
    const result = projectToMidiResult(project);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.bytes).toEqual(projectToMidi(projectWithLoop(4)));
    const parsed = parseMidiFile(result.bytes);
    expect(parsed.tracks.some((track) => track.name === 'Audio')).toBe(false);
    expect(parsed.tracks.filter((track) => track.notes.length > 0)).toHaveLength(1);
  });

  it.each([
    {
      label: 'a dangling take asset',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.takes[0]!.audioAssetId = 'missing-asset';
      },
    },
    {
      label: 'a dangling comp-segment take',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.compSegments[0]!.takeId = 'missing-take';
      },
    },
    {
      label: 'a gap between comp segments',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.compSegments[1]!.offsetBeats = 2.25;
        folder.compSegments[1]!.lengthBeats = 1.75;
      },
    },
    {
      label: 'overlapping comp segments',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.compSegments[0]!.lengthBeats = 2.25;
      },
    },
    {
      label: 'a source range beyond its asset',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.takes[0]!.sourceStartFrame = 1;
      },
    },
    {
      label: 'duplicate Audio take data ids',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.compSegments[0]!.id = folder.takes[0]!.id;
      },
    },
    {
      label: 'an id colliding with another project domain',
      mutate: ({ folder, track }: ReadyAudioTakeFolderFixture) => {
        folder.id = track.id;
      },
    },
    {
      label: 'adjacent segments selecting the same take',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.compSegments[1]!.takeId = folder.compSegments[0]!.takeId;
      },
    },
    {
      label: 'an instrument-track folder reference',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.trackId = 'lead';
      },
    },
    {
      label: 'a folder duration below one tick',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.lengthBeats = MIN_EVENT_DURATION_BEATS / 2;
      },
    },
    {
      label: 'a take duration below one tick',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.takes[0]!.lengthBeats = MIN_EVENT_DURATION_BEATS / 2;
      },
    },
    {
      label: 'a comp duration below one tick',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.compSegments[0]!.lengthBeats = MIN_EVENT_DURATION_BEATS / 2;
        folder.compSegments[1]!.offsetBeats = MIN_EVENT_DURATION_BEATS / 2;
        folder.compSegments[1]!.lengthBeats =
          folder.lengthBeats - MIN_EVENT_DURATION_BEATS / 2;
      },
    },
    {
      label: 'a folder duration above the project timeline limit',
      mutate: ({ project, folder }: ReadyAudioTakeFolderFixture) => {
        project.lengthBeats = MAX_PROJECT_TIMELINE_BEATS + 1;
        folder.lengthBeats = MAX_PROJECT_TIMELINE_BEATS + 1;
      },
    },
    {
      label: 'an overlong take id',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.takes[0]!.id = 't'.repeat(MAX_PROJECT_STRING_LENGTH + 1);
      },
    },
    {
      label: 'an overlong asset reference',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        folder.takes[0]!.audioAssetId =
          'a'.repeat(MAX_PROJECT_STRING_LENGTH + 1);
      },
    },
    {
      label: 'a missing nested required field',
      mutate: ({ folder }: ReadyAudioTakeFolderFixture) => {
        delete (
          folder.takes[0] as unknown as Partial<Record<'gainDb', unknown>>
        ).gainDb;
      },
    },
  ])('rejects Audio take folder data with $label', ({ mutate }) => {
    const project = projectWithLoop(4);
    const fixture = addReadyAudioTakeFolderFixture(project);
    mutate(fixture);

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('requires audioTakeFolders on a current-schema export payload', () => {
    const project = projectWithLoop(4);
    project.schemaVersion = CURRENT_SCHEMA_VERSION;
    delete (
      project as unknown as Partial<Record<'audioTakeFolders', unknown>>
    ).audioTakeFolders;

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects an Audio take folder start beyond the shared timeline bound', () => {
    const project = projectWithLoop(4);
    const { folder } = addReadyAudioTakeFolderFixture(project);
    project.lengthBeats = MAX_PROJECT_TIMELINE_BEATS + 2;
    folder.startBeat = MAX_PROJECT_TIMELINE_BEATS + 1;
    folder.lengthBeats = 1;
    for (const take of folder.takes) take.lengthBeats = 1;
    folder.compSegments = [{
      id: folder.compSegments[0]!.id,
      takeId: folder.takes[0]!.id,
      offsetBeats: 0,
      lengthBeats: 1,
    }];

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-project',
        message: expect.stringContaining(
          `startBeat must be in 0..${MAX_PROJECT_TIMELINE_BEATS}`,
        ),
      }),
    });
  });

  it('rejects duplicate Audio take folders on the same track and window', () => {
    const project = projectWithLoop(4);
    const { folder } = addReadyAudioTakeFolderFixture(project);
    const duplicate = structuredClone(folder);
    duplicate.id = 'take-folder-duplicate-window';
    duplicate.takes = duplicate.takes.map((take, index) => ({
      ...take,
      id: `duplicate-window-take-${index}`,
    }));
    duplicate.compSegments = duplicate.compSegments.map((segment, index) => ({
      ...segment,
      id: `duplicate-window-segment-${index}`,
      takeId: `duplicate-window-take-${index}`,
    }));
    project.audioTakeFolders.push(duplicate);

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-project',
        message: expect.stringContaining(
          'same track and timeline window',
        ),
      }),
    });
  });

  it('preflights the aggregate Audio take subtree at the codec nested-item boundary', () => {
    const sparseTakeProject = (segmentTotal: number): Project => {
      const project = projectWithLoop(4);
      const { track } = addReadyAudioFixture(project);
      track.clips = [];
      const folderCount = 49;
      const segmentCounts = Array.from(
        { length: folderCount },
        (_, index) => (
          index < folderCount - 1
            ? 4_096
            : segmentTotal - (folderCount - 1) * 4_096
        ),
      );
      project.audioTakeFolders = segmentCounts.map((segmentCount, index) => ({
        id: `budget-folder-${index}`,
        trackId: track.id,
        startBeat: 0,
        lengthBeats: 4,
        crossfadeMs: 0,
        takes: Array(2),
        compSegments: Array(segmentCount),
      })) as unknown as Project['audioTakeFolders'];
      return project;
    };
    const folderAndTakeItems = 49 + 49 * 2;
    const exactSegmentItems = MAX_PROJECT_TOTAL_ITEMS - folderAndTakeItems;

    const exactBoundary = projectToMidiResult(
      sparseTakeProject(exactSegmentItems),
    );
    expect(exactBoundary).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-project',
        message: expect.not.stringContaining('nested items'),
      },
    });

    const overBoundary = projectToMidiResult(
      sparseTakeProject(exactSegmentItems + 1),
    );
    expect(overBoundary).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-project',
        message: expect.stringContaining(
          `exceeds ${MAX_PROJECT_TOTAL_ITEMS} nested items`,
        ),
        limit: MAX_PROJECT_TOTAL_ITEMS,
        observed: MAX_PROJECT_TOTAL_ITEMS + 1,
      }),
    });
  });

  it('accepts a zero-range unresolved audio clip on a legacy instrument track', () => {
    const project = projectWithLoop(4);
    const { track, clip } = addReadyAudioFixture(project);
    track.type = 'instrument';
    clip.sourceStartFrame = 0;
    clip.sourceFrameCount = 0;
    clip.fadeInFrames = 0;
    clip.fadeOutFrames = 0;
    clip.gainDb = 0;
    project.audioAssets = [{
      id: clip.audioAssetId,
      availability: 'unresolved',
      legacyAssetId: 'legacy-reference.wav',
      reason: 'legacy-reference',
    }];

    expect(validateProject(project).ok).toBe(true);
    expect(projectToMidiResult(project)).toMatchObject({ ok: true });
  });

  it.each([
    'audioAssetId',
    'sourceStartFrame',
    'sourceFrameCount',
    'fadeInFrames',
    'fadeOutFrames',
    'gainDb',
  ] as const)('rejects an audio clip missing required field %s', (field) => {
    const project = projectWithLoop(4);
    const { clip } = addReadyAudioFixture(project);
    delete (clip as Partial<AudioClip>)[field];

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it.each([
    'audioAssetId',
    'sourceStartFrame',
    'sourceFrameCount',
    'fadeInFrames',
    'fadeOutFrames',
    'gainDb',
  ] as const)('rejects audio-only field %s on a MIDI clip', (field) => {
    const project = projectWithLoop(4);
    const clip = project.tracks[0]!.clips[0]! as unknown as Record<string, unknown>;
    clip[field] = field === 'audioAssetId' ? 'asset-1' : 0;

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects dangling audio assets and ready audio on a legacy instrument track', () => {
    const dangling = projectWithLoop(4);
    const { clip: danglingClip } = addReadyAudioFixture(dangling);
    danglingClip.audioAssetId = 'missing-asset';
    expect(projectToMidiResult(dangling)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });

    const wrongTrack = projectWithLoop(4);
    const { track } = addReadyAudioFixture(wrongTrack);
    track.type = 'instrument';
    expect(projectToMidiResult(wrongTrack)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it.each([
    {
      label: 'negative source start',
      mutate: ({ clip }: ReadyAudioFixture) => { clip.sourceStartFrame = -1; },
    },
    {
      label: 'zero ready source length',
      mutate: ({ clip }: ReadyAudioFixture) => { clip.sourceFrameCount = 0; },
    },
    {
      label: 'out-of-asset source range',
      mutate: ({ clip }: ReadyAudioFixture) => { clip.sourceStartFrame = 80_000; },
    },
    {
      label: 'negative fade',
      mutate: ({ clip }: ReadyAudioFixture) => { clip.fadeInFrames = -1; },
    },
    {
      label: 'combined fades beyond source range',
      mutate: ({ clip }: ReadyAudioFixture) => {
        clip.fadeInFrames = 30_000;
        clip.fadeOutFrames = 30_000;
      },
    },
    {
      label: 'gain below the project bound',
      mutate: ({ clip }: ReadyAudioFixture) => { clip.gainDb = -97; },
    },
    {
      label: 'non-finite gain',
      mutate: ({ clip }: ReadyAudioFixture) => { clip.gainDb = Number.NaN; },
    },
  ])('rejects $label in a ready audio clip', ({ mutate }) => {
    const project = projectWithLoop(4);
    const fixture = addReadyAudioFixture(project);
    mutate(fixture);

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it.each(['sourceStartFrame', 'sourceFrameCount', 'fadeInFrames', 'fadeOutFrames'] as const)(
    'rejects non-zero %s on an unresolved audio clip',
    (field) => {
      const project = projectWithLoop(4);
      const { track, clip } = addReadyAudioFixture(project);
      track.type = 'instrument';
      project.audioAssets = [{
        id: clip.audioAssetId,
        availability: 'unresolved',
        reason: 'missing-reference',
      }];
      clip.sourceStartFrame = 0;
      clip.sourceFrameCount = 0;
      clip.fadeInFrames = 0;
      clip.fadeOutFrames = 0;
      clip[field] = 1;

      expect(projectToMidiResult(project)).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'invalid-project' }),
      });
    },
  );

  it.each([
    {
      label: 'missing ready frameCount',
      mutate: (asset: Record<string, unknown>) => { delete asset.frameCount; },
    },
    {
      label: 'uppercase checksum',
      mutate: (asset: Record<string, unknown>) => { asset.checksumSha256 = 'A'.repeat(64); },
    },
    {
      label: 'unsupported media type',
      mutate: (asset: Record<string, unknown>) => { asset.mediaType = 'audio/ogg'; },
    },
    {
      label: 'out-of-range sample rate',
      mutate: (asset: Record<string, unknown>) => { asset.sampleRate = 7_999; },
    },
    {
      label: 'fractional channel count',
      mutate: (asset: Record<string, unknown>) => { asset.channelCount = 1.5; },
    },
    {
      label: 'unsupported availability',
      mutate: (asset: Record<string, unknown>) => { asset.availability = 'cached'; },
    },
  ])('rejects audio asset metadata with $label', ({ mutate }) => {
    const project = projectWithLoop(4);
    const { asset } = addReadyAudioFixture(project);
    mutate(asset as unknown as Record<string, unknown>);

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it('rejects a 129th independent drum port instead of wrapping the port byte', () => {
    const project = projectWithLoop(4);
    const source = project.tracks[0]!;
    project.tracks = Array.from({ length: 129 }, (_, index) => ({
      ...source,
      id: `drum-${index}`,
      name: `Drums ${index + 1}`,
      type: 'drum' as const,
      clips: [],
    }));

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-project',
        limit: 127,
        observed: 128,
      }),
    });
  });

  it.each([
    { field: 'volume' as const, value: Number.NaN },
    { field: 'volume' as const, value: Number.POSITIVE_INFINITY },
    { field: 'volume' as const, value: 2.01 },
    { field: 'pan' as const, value: Number.NaN },
    { field: 'pan' as const, value: Number.NEGATIVE_INFINITY },
    { field: 'pan' as const, value: 1.01 },
  ])('rejects invalid track $field=$value before writing CC data', ({ field, value }) => {
    const project = projectWithLoop(4);
    project.tracks[0]![field] = value;

    expect(projectToMidiResult(project)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-project' }),
    });
  });

  it.each<MidiTextField>(['project title', 'track name', 'chord marker'])(
    'accepts a %s whose UTF-8 encoding is exactly 4096 bytes',
    (field) => {
      const project = projectWithLoop(4);
      setMidiText(project, field, `${'界'.repeat(1_365)}a`);

      expect(projectToMidiResult(project)).toMatchObject({ ok: true });
    },
  );

  it.each<MidiTextField>(['project title', 'track name', 'chord marker'])(
    'rejects a %s whose UTF-8 encoding exceeds 4096 bytes',
    (field) => {
      const project = projectWithLoop(4);
      setMidiText(project, field, `${'界'.repeat(1_365)}ab`);

      expect(projectToMidiResult(project)).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: 'invalid-project',
          limit: 4_096,
          observed: 4_097,
        }),
      });
    },
  );

  it('preserves the one-byte ASCII boundary', () => {
    const accepted = projectWithLoop(4);
    accepted.title = 'a'.repeat(4_096);
    const rejected = projectWithLoop(4);
    rejected.title = 'a'.repeat(4_097);

    expect(projectToMidiResult(accepted)).toMatchObject({ ok: true });
    expect(projectToMidiResult(rejected)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-project',
        limit: 4_096,
        observed: 4_097,
      }),
    });
  });
});
