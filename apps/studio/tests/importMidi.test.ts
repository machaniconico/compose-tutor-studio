import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIDI_PARSE_LIMITS,
  buildHeaderChunk,
  concatChunks,
  exportNotesToMidi,
  parseMidiFile,
  panToCc,
  projectToMidi,
  volumeToCc,
  type ImportedMidiNote,
  type ParsedMidiFile,
} from '@cts/midi-io';
import { MAX_PROJECT_TRACKS, validateProject, type Project, type Track } from '@cts/project-model';
import { buildScheduleEvents } from '../src/audio/events';
import { createDefaultProject } from '../src/state/defaultProject';
import {
  appendImportedMidiTrack,
  importMidiBytes,
  importMidiFile,
  MAX_MIDI_IMPORT_BYTES,
  mapParsedMidiToTrack,
  mapParsedMidiToTracks,
  midiTrackName,
  type ImportMidiIdFactory,
  type MidiImportStoreController,
} from '../src/state/importMidi';

function makeIdFactory(): ImportMidiIdFactory {
  const counts = new Map<string, number>();
  return (prefix) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function note(partial: Partial<ImportedMidiNote>): ImportedMidiNote {
  return {
    pitch: 60,
    startTick: 0,
    durationTick: 480,
    velocity: 90,
    channel: 0,
    startBeat: 0,
    durationBeat: 1,
    startSeconds: 0,
    durationSeconds: 0.5,
    ...partial,
  };
}

function parsedMidi(notes: ImportedMidiNote[]): ParsedMidiFile {
  return {
    ppq: 480,
    tempoBpm: 120,
    tracks: [
      { name: 'Lead', notes: [notes[1] ?? note({})] },
      { name: 'Bass', notes: [notes[0] ?? note({ pitch: 48 })] },
    ],
  };
}

function stackedNoteOnMidi(noteOnCount: number): Uint8Array {
  const data = new Uint8Array(4 + (noteOnCount - 1) * 3 + 4);
  let offset = 0;
  data[offset++] = 0;
  data[offset++] = 0x90;
  data[offset++] = 60;
  data[offset++] = 100;
  for (let index = 1; index < noteOnCount; index += 1) {
    data[offset++] = 0;
    data[offset++] = 60;
    data[offset++] = 100;
  }
  data[offset++] = 0;
  data[offset++] = 0xff;
  data[offset++] = 0x2f;
  data[offset++] = 0;

  const track = new Uint8Array(8 + data.length);
  track.set([
    0x4d, 0x54, 0x72, 0x6b,
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
  ]);
  track.set(data, 8);
  return concatChunks(buildHeaderChunk(0, 1, 480), track);
}

function hasTrackId(payload: unknown, trackId: string): boolean {
  return (
    typeof payload === 'object'
    && payload !== null
    && 'trackId' in payload
    && (payload as { trackId: unknown }).trackId === trackId
  );
}

describe('MIDI import mapping', () => {
  it('keeps source MTrk boundaries, names, order, and note values', () => {
    const parsed = parsedMidi([
      note({ pitch: 48, startBeat: 0, durationBeat: 2, velocity: 80 }),
      note({ pitch: 64, startBeat: 1.5, durationBeat: 0.5, velocity: 100 }),
    ]);

    const mapped = mapParsedMidiToTrack(parsed, {
      makeId: makeIdFactory(),
      trackName: midiTrackName('lesson.mid'),
    });

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    expect(mapped.importedTrackCount).toBe(2);
    expect(mapped.tracks.map((track) => track.name)).toEqual(['Lead', 'Bass']);
    expect(mapped.tracks.map((track) => track.type)).toEqual(['instrument', 'instrument']);
    expect(mapped.tracks[0]?.instrument?.preset).toBe('brightPluck');
    expect(mapped.clips[0]?.type).toBe('midi');
    expect(mapped.clips[0]?.trackId).toBe(mapped.tracks[0]?.id);
    expect(mapped.clips[0]?.notes).toEqual([
      {
        id: 'note_1',
        pitch: 64,
        startBeat: 1.5,
        durationBeats: 0.5,
        velocity: 100,
      },
    ]);
    expect(mapped.clips[1]?.notes).toEqual([
      {
        id: 'note_2',
        pitch: 48,
        startBeat: 0,
        durationBeats: 2,
        velocity: 80,
      },
    ]);
    expect(mapped.tracks.map((track) => track.volume)).toEqual([1, 1]);
    expect(mapped.lengthBeats).toBe(2);
  });

  it('splits a format-0 track by channel and restores tick-zero CC7/CC10', () => {
    const mapped = mapParsedMidiToTracks(
      {
        format: 0,
        ppq: 480,
        tempoBpm: 120,
        tracks: [
          {
            name: 'Combo',
            initialChannels: [
              { channel: 0, volumeCc: 127, panCc: 0 },
              { channel: 1, volumeCc: 0, panCc: 127 },
            ],
            notes: [
              note({ channel: 1, pitch: 48, startBeat: 1 }),
              note({ channel: 0, pitch: 72, startBeat: 0 }),
            ],
          },
        ],
      },
      { makeId: makeIdFactory(), trackName: 'MIDI: combo' },
    );

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.tracks.map((track) => track.name)).toEqual([
      'Combo · Ch 1',
      'Combo · Ch 2',
    ]);
    expect(mapped.tracks.map((track) => track.volume)).toEqual([2, 0]);
    expect(mapped.tracks.map((track) => track.pan)).toEqual([-1, 1]);
    expect(mapped.clips.map((clip) => clip.notes?.[0]?.pitch)).toEqual([72, 48]);
  });

  it('round-trips every static CC7/CC10 value through project mix ranges', () => {
    for (let cc = 0; cc <= 127; cc += 1) {
      const mapped = mapParsedMidiToTracks(
        {
          ppq: 480,
          tempoBpm: 120,
          tracks: [
            {
              name: 'Mix',
              initialChannels: [{ channel: 0, volumeCc: cc, panCc: cc }],
              notes: [note({})],
            },
          ],
        },
        { makeId: makeIdFactory() },
      );
      expect(mapped.ok).toBe(true);
      if (!mapped.ok) continue;
      expect(volumeToCc(mapped.track.volume)).toBe(cc);
      expect(panToCc(mapped.track.pan)).toBe(cc);
    }
  });

  it('maps exact supported Channel 10 hits to the beginner drum grid', () => {
    const mapped = mapParsedMidiToTracks(
      {
        format: 1,
        ppq: 480,
        tempoBpm: 120,
        tracks: [
          {
            name: 'Drums',
            notes: [
              note({ channel: 9, pitch: 36, durationTick: 120, durationBeat: 0.25 }),
              note({
                channel: 9,
                pitch: 38,
                startTick: 480,
                startBeat: 1,
                durationTick: 120,
                durationBeat: 0.25,
              }),
            ],
          },
        ],
      },
      {
        makeId: makeIdFactory(),
        trackName: 'MIDI: drums',
        targetTimeSignature: [4, 4],
      },
    );

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.track.type).toBe('drum');
    expect(mapped.clip).toMatchObject({ type: 'drum', stepsPerBar: 16 });
    expect(mapped.clip.drumEvents).toEqual([
      { id: 'drum_1', lane: 'kick', stepIndex: 0, velocity: 90 },
      { id: 'drum_2', lane: 'snare', stepIndex: 4, velocity: 90 },
    ]);
    expect(mapped.warnings).toEqual([]);
  });

  it.each([
    {
      label: 'inside the half-tick tolerance',
      startTick: 16,
      startBeat: 0.16,
      expectedType: 'drum',
    },
    {
      label: 'outside the half-tick tolerance',
      startTick: 15,
      startBeat: 0.15,
      expectedType: 'instrument',
    },
  ] as const)(
    'treats a Channel 10 hit $label as an exact step or whole-group fallback',
    ({ startTick, startBeat, expectedType }) => {
      // In 5/8 at PPQ 100, step 1 is tick 15.625. Tick 16 is within
      // half a source tick; tick 15 is outside it.
      const mapped = mapParsedMidiToTracks(
        {
          ppq: 100,
          tempoBpm: 120,
          tracks: [
            {
              name: 'Boundary drums',
              notes: [
                note({
                  channel: 9,
                  pitch: 36,
                  startTick,
                  startBeat,
                  durationTick: 25,
                  durationBeat: 0.25,
                }),
              ],
            },
          ],
        },
        {
          makeId: makeIdFactory(),
          targetTimeSignature: [5, 8],
        },
      );

      expect(mapped.ok).toBe(true);
      if (!mapped.ok) return;
      expect(mapped.track.type).toBe(expectedType);
      if (expectedType === 'drum') {
        expect(mapped.clip.drumEvents?.[0]?.stepIndex).toBe(1);
        expect(mapped.warnings).toEqual([]);
      } else {
        expect(mapped.clip.notes?.[0]?.startBeat).toBe(startBeat);
        expect(mapped.warnings).toEqual([
          expect.stringContaining('音程を保つMIDIトラック'),
        ]);
      }
    },
  );

  it.each([
    {
      label: 'unsupported pitch',
      notes: [note({ channel: 9, pitch: 40, durationTick: 120, durationBeat: 0.25 })],
    },
    {
      label: 'non-drum duration',
      notes: [note({ channel: 9, pitch: 36, durationTick: 480, durationBeat: 1 })],
    },
    {
      label: 'duplicate lane and step',
      notes: [
        note({ channel: 9, pitch: 36, durationTick: 120, durationBeat: 0.25 }),
        note({ channel: 9, pitch: 36, durationTick: 120, durationBeat: 0.25 }),
      ],
    },
  ])('preserves $label as pitched notes and warns instead of silently reducing it', ({ notes }) => {
    const mapped = mapParsedMidiToTracks(
      {
        ppq: 480,
        tempoBpm: 120,
        tracks: [{ name: 'Channel 10', notes }],
      },
      { makeId: makeIdFactory(), trackName: 'MIDI: fallback' },
    );

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.track.type).toBe('instrument');
    expect(mapped.clip.notes).toHaveLength(notes.length);
    expect(mapped.warnings).toEqual([
      expect.stringContaining('音程を保つMIDIトラック'),
    ]);
  });

  it('round-trips app-exported part names, channels, mix values, notes, and GM drums', () => {
    const source = createDefaultProject('日本語Roundtrip');
    source.bpm = 90;
    source.timeSignature = [3, 4];
    source.chordTrack = [];
    const melody = source.tracks.find((track) => track.name === 'Melody');
    const bass = source.tracks.find((track) => track.name === 'Bass');
    const drums = source.tracks.find((track) => track.type === 'drum');
    const master = source.tracks.find((track) => track.type === 'master');
    if (!melody || !bass || !drums || !master) throw new Error('roundtrip fixture missing');
    melody.name = 'メロディ';
    melody.volume = 1.5;
    melody.pan = -0.5;
    melody.clips[0]!.notes = [
      { id: 'melody-note', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 100 },
    ];
    bass.clips[0]!.notes = [
      { id: 'bass-note', pitch: 36, startBeat: 1, durationBeats: 1, velocity: 90 },
    ];
    drums.clips[0]!.stepsPerBar = 16;
    drums.clips[0]!.drumEvents = [
      { id: 'kick', lane: 'kick', stepIndex: 0, velocity: 110 },
      { id: 'snare', lane: 'snare', stepIndex: 4, velocity: 100 },
    ];
    source.tracks = [melody, bass, drums, master];

    const parsed = parseMidiFile(projectToMidi(source));
    const mapped = mapParsedMidiToTracks(parsed, {
      makeId: makeIdFactory(),
      trackName: 'MIDI: roundtrip',
      targetBpm: 90,
      targetTimeSignature: [3, 4],
    });

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.tracks.map((track) => [track.name, track.type])).toEqual([
      ['メロディ', 'instrument'],
      ['Bass', 'instrument'],
      ['Drums', 'drum'],
    ]);
    expect(mapped.tracks[0]?.volume).toBeCloseTo(1.5, 2);
    expect(mapped.tracks[0]?.pan).toBeCloseTo(-0.5, 2);
    expect(mapped.clips[0]?.notes?.[0]).toMatchObject({
      pitch: 72,
      startBeat: 0,
      durationBeats: 1,
      velocity: 100,
    });
    expect(mapped.clips[2]?.drumEvents?.map((event) => [event.lane, event.stepIndex])).toEqual([
      ['kick', 0],
      ['snare', 4],
    ]);
  });

  it('preserves an app-authored Track 1 name but falls back for synthesized names', () => {
    const source = createDefaultProject('Name provenance');
    const namedTrack = source.tracks.find((track) => track.type === 'instrument');
    const master = source.tracks.find((track) => track.type === 'master');
    if (!namedTrack || !master) throw new Error('name provenance fixture missing');
    namedTrack.name = 'Track 1';
    namedTrack.clips[0]!.notes = [
      { id: 'named-note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
    ];
    source.chordTrack = [];
    source.tracks = [namedTrack, master];

    const parsedExplicit = parseMidiFile(projectToMidi(source));
    const explicitSourceTrack = parsedExplicit.tracks.find((track) => track.notes.length > 0);
    expect(explicitSourceTrack).toMatchObject({ name: 'Track 1', hasExplicitName: true });
    const mappedExplicit = mapParsedMidiToTracks(parsedExplicit, {
      makeId: makeIdFactory(),
      trackName: 'MIDI: should-not-replace',
    });
    expect(mappedExplicit.ok).toBe(true);
    if (!mappedExplicit.ok) return;
    expect(mappedExplicit.track.name).toBe('Track 1');

    const parsedSynthesized = parseMidiFile(exportNotesToMidi([
      { id: 'unnamed-note', pitch: 64, startBeat: 0, durationBeats: 1, velocity: 90 },
    ], 120));
    expect(parsedSynthesized.tracks[0]).toMatchObject({
      name: 'Track 1',
      hasExplicitName: false,
    });
    const mappedSynthesized = mapParsedMidiToTracks(parsedSynthesized, {
      makeId: makeIdFactory(),
      trackName: 'MIDI: unnamed',
    });
    expect(mappedSynthesized.ok).toBe(true);
    if (!mappedSynthesized.ok) return;
    expect(mappedSynthesized.track.name).toBe('MIDI: unnamed');

    const mappedVerbatim = mapParsedMidiToTracks({
      ppq: 480,
      tempoBpm: 120,
      tracks: [{ name: '  Padded source  ', hasExplicitName: true, notes: [note({})] }],
    }, {
      makeId: makeIdFactory(),
      trackName: 'MIDI: should-not-trim',
    });
    expect(mappedVerbatim.ok).toBe(true);
    if (!mappedVerbatim.ok) return;
    expect(mappedVerbatim.track.name).toBe('  Padded source  ');

    const mappedBlank = mapParsedMidiToTracks({
      ppq: 480,
      tempoBpm: 120,
      tracks: [{ name: '   ', hasExplicitName: true, notes: [note({})] }],
    }, {
      makeId: makeIdFactory(),
      trackName: 'MIDI: blank',
    });
    expect(mappedBlank.ok).toBe(true);
    if (!mappedBlank.ok) return;
    expect(mappedBlank.track.name).toBe('MIDI: blank');
  });

  it('reports source tempo, meter, markers, and program loss without changing note beats', () => {
    const mapped = mapParsedMidiToTracks(
      {
        format: 1,
        ppq: 480,
        tempoBpm: 137,
        tempoEvents: [{ tick: 0, bpm: 137 }, { tick: 960, bpm: 90 }],
        timeSignatures: [{ tick: 0, numerator: 3, denominator: 4 }],
        markers: [{ tick: 0, text: 'Intro', trackIndex: 0 }],
        keySignatures: [{ tick: 0, sharpsFlats: 2, minor: false, trackIndex: 0 }],
        textEncodingFallbackCount: 1,
        noteIssues: { unmatchedNoteOns: 1, orphanNoteOffs: 2 },
        tracks: [
          {
            name: 'Lead',
            initialChannels: [{ channel: 0, program: 81 }],
            hasChannelAutomation: true,
            notes: [note({ startBeat: 2 })],
          },
        ],
      },
      {
        makeId: makeIdFactory(),
        targetBpm: 120,
        targetTimeSignature: [4, 4],
      },
    );

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.clip.notes?.[0]?.startBeat).toBe(2);
    expect(mapped.warnings).toEqual([
      expect.stringContaining('テンポイベント2件'),
      expect.stringContaining('3/4拍子'),
      expect.stringContaining('マーカー'),
      expect.stringContaining('キー指定'),
      expect.stringContaining('途中の音量'),
      expect.stringContaining('UTF-8'),
      expect.stringContaining('Note On 1件'),
      expect.stringContaining('音色・バンク指定'),
    ]);
  });

  it('rejects a multi-track import before allocating ids when no project track slots remain', () => {
    let idCalls = 0;
    const mapped = mapParsedMidiToTracks(parsedMidi([note({}), note({ pitch: 48 })]), {
      makeId: (prefix) => {
        idCalls += 1;
        return `${prefix}_${idCalls}`;
      },
      maxTracks: 0,
    });

    expect(mapped).toEqual({
      ok: false,
      message: expect.stringContaining('追加可能0トラック'),
    });
    expect(idCalls).toBe(0);
  });

  it('does not change selection or report success when the atomic project commit is rejected', async () => {
    const bytes = projectToMidi(createDefaultProject('Atomic source'));
    const project = createDefaultProject('Atomic destination');
    let applyCalls = 0;
    let selectionCalls = 0;
    const controller: MidiImportStoreController = {
      project,
      saveState: { activationId: 'atomic-activation' },
      projectOperationBusy: false,
      applyProjectChange: () => {
        applyCalls += 1;
        return false;
      },
      selectTrack: () => {
        selectionCalls += 1;
      },
      selectClip: () => {
        selectionCalls += 1;
      },
      selectNotes: () => {
        selectionCalls += 1;
      },
      setActiveView: () => {
        selectionCalls += 1;
      },
    };

    await expect(importMidiBytes('atomic.mid', bytes, () => controller)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('反映しませんでした'),
    });
    expect(applyCalls).toBe(1);
    expect(selectionCalls).toBe(0);
    expect(controller.project).toBe(project);
  });

  it('rejects atomically when the destination already uses all project track slots', async () => {
    const base = createDefaultProject('Full destination');
    const template = base.tracks.find((track) => track.type === 'instrument');
    if (!template) throw new Error('full-project fixture missing');
    const tracks: Track[] = Array.from({ length: MAX_PROJECT_TRACKS }, (_, index) => ({
      ...template,
      id: `existing-${index}`,
      name: `Existing ${index + 1}`,
      clips: [],
      effects: [],
    }));
    const project: Project = { ...base, tracks, chordTrack: [] };
    let applyCalls = 0;
    const controller: MidiImportStoreController = {
      project,
      saveState: { activationId: 'full-activation' },
      projectOperationBusy: false,
      applyProjectChange: () => {
        applyCalls += 1;
        return true;
      },
      selectTrack: () => undefined,
      selectClip: () => undefined,
      selectNotes: () => undefined,
      setActiveView: () => undefined,
    };

    const result = await importMidiBytes(
      'overflow.mid',
      projectToMidi(createDefaultProject('Overflow source')),
      () => controller,
    );

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('追加可能0トラック'),
    });
    expect(applyCalls).toBe(0);
  });

  it('warns about zero-duration and piano-roll-hidden notes while preserving usable data', () => {
    const mapped = mapParsedMidiToTracks(
      {
        ppq: 480,
        tempoBpm: 120,
        tracks: [
          {
            name: 'Wide range',
            notes: [
              note({ pitch: 20 }),
              note({ pitch: 100, startBeat: 1 }),
              note({ pitch: 60, startBeat: 2, durationTick: 0, durationBeat: 0 }),
            ],
          },
        ],
      },
      { makeId: makeIdFactory() },
    );

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.noteCount).toBe(2);
    expect(mapped.clip.notes?.map((event) => event.pitch)).toEqual([20, 100]);
    expect(mapped.warnings).toEqual([
      expect.stringContaining('長さ0の音符1件'),
      expect.stringContaining('C2〜C6'),
    ]);
  });

  it('rejects an unrepresentable note without clamping or allocating ids', () => {
    let idCalls = 0;
    const mapped = mapParsedMidiToTracks(
      {
        ppq: 480,
        tempoBpm: 120,
        tracks: [{ name: 'Invalid', notes: [note({ pitch: 200 })] }],
      },
      {
        makeId: () => {
          idCalls += 1;
          return `id_${idCalls}`;
        },
      },
    );

    expect(mapped).toEqual({
      ok: false,
      message: expect.stringContaining('安全に追加できない範囲'),
    });
    expect(idCalls).toBe(0);
  });

  it('keeps imported names unique and within the project codec string limit', () => {
    const longName = 'a'.repeat(4_096);
    const mapped = mapParsedMidiToTracks(
      {
        ppq: 480,
        tempoBpm: 120,
        tracks: [{ name: longName, notes: [note({})] }],
      },
      {
        makeId: makeIdFactory(),
        reservedTrackNames: [longName],
      },
    );

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.track.name.endsWith(' (2)')).toBe(true);
    expect(mapped.track.name.length).toBe(4_096);

    const split = mapParsedMidiToTracks(
      {
        ppq: 480,
        tempoBpm: 120,
        tracks: [
          {
            name: longName,
            notes: [note({ channel: 0 }), note({ channel: 1, pitch: 64 })],
          },
        ],
      },
      { makeId: makeIdFactory() },
    );
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.tracks.map((track) => track.name.endsWith(' · Ch 1') || track.name.endsWith(' · Ch 2')))
      .toEqual([true, true]);
    expect(split.tracks.every((track) => track.name.length === 4_096)).toBe(true);
  });

  it('aborts an async file import when the active project activation changes', async () => {
    const bytes = projectToMidi(createDefaultProject('MIDI source'));
    let resolveBuffer!: (buffer: ArrayBuffer) => void;
    const buffer = new Promise<ArrayBuffer>((resolve) => {
      resolveBuffer = resolve;
    });
    const file = {
      name: 'delayed.mid',
      size: bytes.byteLength,
      arrayBuffer: () => buffer,
    } as File;
    let applied = 0;
    const controller = (
      project: ReturnType<typeof createDefaultProject>,
      activationId: string,
    ): MidiImportStoreController => ({
      project,
      saveState: { activationId },
      projectOperationBusy: false,
      applyProjectChange: (change) => {
        applied += 1;
        active.project = change(active.project);
        return true;
      },
      selectTrack: () => undefined,
      selectClip: () => undefined,
      selectNotes: () => undefined,
      setActiveView: () => undefined,
    });
    let active = controller(createDefaultProject('Project A'), 'activation-a');

    const importing = importMidiFile(file, () => active);
    active = controller(createDefaultProject('Project B'), 'activation-b');
    resolveBuffer(Uint8Array.from(bytes).buffer);

    await expect(importing).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('プロジェクトが切り替わった'),
    });
    expect(applied).toBe(0);
    expect(active.project.title).toBe('Project B');
    expect(active.project.tracks.some((track) => track.name === 'MIDI: delayed')).toBe(false);
  });

  it('imports native gateway bytes without constructing a DOM File', async () => {
    const bytes = projectToMidi(createDefaultProject('Native MIDI source'));
    let project = createDefaultProject('Native destination');
    const controller: MidiImportStoreController = {
      project,
      saveState: { activationId: 'native-activation' },
      projectOperationBusy: false,
      applyProjectChange: (change) => {
        project = change(project);
        controller.project = project;
        return true;
      },
      selectTrack: () => undefined,
      selectClip: () => undefined,
      selectNotes: () => undefined,
      setActiveView: () => undefined,
    };

    const result = await importMidiBytes('native-song.mid', bytes, () => controller);
    expect(result).toMatchObject({ ok: true, trackCount: 1 });
    if (!result.ok) return;
    expect(project.tracks.some((track) => track.id === result.trackIds[0])).toBe(true);
  });

  it('rejects MIDI that contains no usable notes with a beginner-friendly message', () => {
    const mapped = mapParsedMidiToTrack(
      {
        ppq: 480,
        tempoBpm: 120,
        tracks: [{ name: 'Empty', notes: [note({ durationBeat: 0 })] }],
      },
      { makeId: makeIdFactory(), trackName: 'MIDI: empty' },
    );

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.message).toContain('読み込めるノート');
  });

  it('rejects an oversized MIDI before allocating its file buffer', async () => {
    let read = false;
    const file = {
      name: 'huge.mid',
      size: MAX_MIDI_IMPORT_BYTES + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as File;

    await expect(importMidiFile(file)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('上限8MB'),
    });
    expect(read).toBe(false);
  });

  it('surfaces parser complexity limits without mutating the project', async () => {
    const bytes = stackedNoteOnMidi(DEFAULT_MIDI_PARSE_LIMITS.maxActiveNotesPerKey + 1);
    const project = createDefaultProject('複雑すぎるMIDI');
    let applied = 0;
    const controller: MidiImportStoreController = {
      project,
      saveState: { activationId: 'active' },
      projectOperationBusy: false,
      applyProjectChange: () => {
        applied += 1;
        return true;
      },
      selectTrack: () => undefined,
      selectClip: () => undefined,
      selectNotes: () => undefined,
      setActiveView: () => undefined,
    };
    const file = {
      name: 'stacked.mid',
      size: bytes.byteLength,
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    } as File;

    await expect(importMidiFile(file, () => controller)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('同時発音数が多すぎます'),
    });
    expect(applied).toBe(0);
    expect(controller.project).toBe(project);
  });

  it('appends the imported track before master and makes notes part of playback scheduling', () => {
    const mapped = mapParsedMidiToTrack(
      {
        ppq: 480,
        tempoBpm: 120,
        tracks: [{ name: 'Long', notes: [note({ startBeat: 7, durationBeat: 2 })] }],
      },
      { makeId: makeIdFactory(), trackName: 'MIDI: long' },
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    const source = createDefaultProject('読み込みテスト');
    const project = {
      ...source,
      lengthBars: 1,
      tracks: source.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, lengthBeats: 4 })),
      })),
      chordTrack: source.chordTrack.slice(0, 1),
      sections: source.sections.map((section) => ({ ...section, lengthBars: 1 })),
    };
    const next = appendImportedMidiTrack(project, mapped.track);
    const masterIndex = next.tracks.findIndex((track) => track.type === 'master');
    const importedIndex = next.tracks.findIndex((track) => track.id === mapped.track.id);

    expect(importedIndex).toBe(masterIndex - 1);
    expect(next.tracks.filter((track) => track.id === mapped.track.id)).toHaveLength(1);
    expect(next.tracks).toHaveLength(project.tracks.length + 1);
    expect(next.lengthBars).toBe(3);
    expect(validateProject(next).ok).toBe(true);
    expect(
      buildScheduleEvents(next).some(
        (event) => event.beat === 7 && hasTrackId(event.payload, mapped.track.id),
      ),
    ).toBe(true);
  });
});
