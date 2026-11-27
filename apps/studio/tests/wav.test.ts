import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  songEndBeat,
  createDefaultProject,
  createEmptyProject,
  setTimeSignature,
  type Clip,
  type InstrumentMacros,
  type Project,
  type Track,
} from '@cts/project-model';
import { exportProjectToMidi, parseMidi } from '@cts/midi-io';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { nextEventsInWindow } from '../src/audio/scheduler';
import { applyMacros } from '../src/audio/macros';
import {
  encodeWav,
  floatToInt16,
  RENDER_TAIL_SECONDS,
  renderLengthSeconds,
  renderProjectToWav,
  renderScheduleEvents,
  songTailSeconds,
} from '../src/audio/wav';

// applyMacros is wrapped in a spy (calling the real mapping) so the WAV render
// can be shown to go through it. Graph and master chain are stubbed: only the
// voices are built on the fake OfflineAudioContext below.
vi.mock('../src/audio/macros', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/macros')>();
  return { ...actual, applyMacros: vi.fn(actual.applyMacros) };
});
vi.mock('../src/audio/graph', () => ({
  buildTrackGraphs: (_ctx: unknown, _master: unknown, tracks: ReadonlyArray<{ id: string }>) =>
    new Map(tracks.map((t) => [t.id, { input: {}, dispose: () => {} }])),
}));
vi.mock('../src/audio/masterChain', () => ({ createMasterChain: () => ({ input: {} }) }));

/** Read a 4-char ASCII tag from an ArrayBuffer at an offset. */
function ascii(buffer: ArrayBuffer, offset: number, length = 4): string {
  const bytes = new Uint8Array(buffer, offset, length);
  return String.fromCharCode(...bytes);
}

describe('floatToInt16', () => {
  it('maps 0 to 0', () => {
    expect(floatToInt16(0)).toBe(0);
  });
  it('maps +1 to 0x7FFF and -1 to -0x8000', () => {
    expect(floatToInt16(1)).toBe(0x7fff);
    expect(floatToInt16(-1)).toBe(-0x8000);
  });
  it('clamps out-of-range samples', () => {
    expect(floatToInt16(2)).toBe(0x7fff);
    expect(floatToInt16(-2)).toBe(-0x8000);
  });
  it('scales mid values', () => {
    expect(floatToInt16(0.5)).toBe(Math.round(0.5 * 0x7fff));
    expect(floatToInt16(-0.5)).toBe(Math.round(-0.5 * 0x8000));
  });
});

describe('encodeWav header (stereo)', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, -1, 1, 0]);
  const buffer = encodeWav([left, right], 44100);
  const view = new DataView(buffer);

  it('writes RIFF / WAVE / fmt  / data tags', () => {
    expect(ascii(buffer, 0)).toBe('RIFF');
    expect(ascii(buffer, 8)).toBe('WAVE');
    expect(ascii(buffer, 12)).toBe('fmt ');
    expect(ascii(buffer, 36)).toBe('data');
  });

  it('has correct fmt fields for 16-bit PCM stereo', () => {
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint16(32, true)).toBe(4); // block align = 2ch * 2 bytes
    expect(view.getUint32(28, true)).toBe(44100 * 4); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('computes chunk sizes from the frame count', () => {
    const numFrames = 4;
    const blockAlign = 4;
    const dataSize = numFrames * blockAlign; // 16 bytes
    expect(view.getUint32(40, true)).toBe(dataSize); // data chunk size
    expect(view.getUint32(4, true)).toBe(36 + dataSize); // RIFF chunk size
    expect(buffer.byteLength).toBe(44 + dataSize);
  });

  it('interleaves L/R samples and clamps them', () => {
    // frame 0: L=0, R=0
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0);
    // frame 1: L=0.5, R=-1
    expect(view.getInt16(48, true)).toBe(floatToInt16(0.5));
    expect(view.getInt16(50, true)).toBe(-0x8000);
    // frame 3: L=1 (clamps to 0x7FFF), R=0
    expect(view.getInt16(56, true)).toBe(0x7fff);
    expect(view.getInt16(58, true)).toBe(0);
  });
});

describe('encodeWav (mono)', () => {
  it('produces a single-channel header', () => {
    const mono = new Float32Array([0.25, -0.25]);
    const buffer = encodeWav([mono], 22050);
    const view = new DataView(buffer);
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint16(32, true)).toBe(2); // block align = 1ch * 2 bytes
    expect(view.getUint32(40, true)).toBe(2 * 2); // 2 frames * 2 bytes
  });
});

describe('renderLengthSeconds', () => {
  const base = createEmptyProject({
    bpm: 20,
    lengthBars: 1,
    timeSignature: [4, 4],
    clock: () => new Date('2026-06-11T00:00:00.000Z'),
  });
  const delayTrack = (enabled: boolean, params: Record<string, number>): Track => ({
    id: 'melody',
    name: 'Melody',
    type: 'instrument',
    clips: [],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    effects: [{ id: 'fx-delay', type: 'delay', enabled, params }],
  });

  it('renders 8 bars of 3/4 as 24 beats', () => {
    // 8 bars x 3 beats at 60 BPM = 24 s.
    const waltz = { ...base, bpm: 60, lengthBars: 8, timeSignature: [3, 4] as [number, number], tracks: [] };
    expect(renderLengthSeconds(waltz)).toBe(24 + RENDER_TAIL_SECONDS);
  });

  it('is the song plus the fixed tail when no delay is enabled', () => {
    // 1 bar of 4/4 at 20 BPM = 12 s.
    expect(renderLengthSeconds({ ...base, tracks: [] })).toBe(12 + RENDER_TAIL_SECONDS);
    expect(
      renderLengthSeconds({ ...base, tracks: [delayTrack(false, { timeSeconds: 1.5 })] }),
    ).toBe(12 + RENDER_TAIL_SECONDS);
  });

  it('extends the tail by the longest enabled delay so the last repeat is kept', () => {
    const project = {
      ...base,
      tracks: [delayTrack(true, { timeSeconds: 0.5 }), { ...delayTrack(true, { timeSeconds: 1.5 }), id: 'bass' }],
    };
    expect(renderLengthSeconds(project)).toBe(12 + 1.5 + RENDER_TAIL_SECONDS);
  });

  it('uses the clamped legacy delay time, not the raw saved value', () => {
    const project = { ...base, tracks: [delayTrack(true, { delayTime: 4 })] };
    expect(renderLengthSeconds(project)).toBe(12 + 1.5 + RENDER_TAIL_SECONDS);
  });});

describe('songTailSeconds: synth release', () => {
  const base = createEmptyProject({
    bpm: 120,
    lengthBars: 1,
    timeSignature: [4, 4],
    clock: () => new Date('2026-06-11T00:00:00.000Z'),
  });
  const synthTrack = (id: string, preset: string | undefined, macros?: InstrumentMacros, delay?: number): Track => ({
    id,
    name: id,
    type: 'instrument',
    clips: [],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    effects: delay === undefined ? [] : [{ id: `fx-${id}`, type: 'delay', enabled: true, params: { timeSeconds: delay } }],
    instrument: preset === undefined ? undefined : { type: 'synth', preset, ...(macros ? { macros } : {}) },
  });

  it('keeps the previous tail for existing songs (no macros, old preset names, release <= 1 s)', () => {
    // Existing presets and names stored in older projects (fall back to warmPad).
    const tracks = [
      synthTrack('a', 'warmPad'),
      synthTrack('b', 'roundBass'),
      synthTrack('c', 'brightLead'),
      synthTrack('d', 'subBass'),
      synthTrack('e', 'leadSine'),
      synthTrack('f', 'piano'),
      synthTrack('g', undefined),
    ];
    expect(songTailSeconds({ ...base, tracks })).toBe(RENDER_TAIL_SECONDS);
    expect(songTailSeconds({ ...base, tracks: [...tracks, synthTrack('h', 'pad', undefined, 0.75)] })).toBe(
      0.75 + RENDER_TAIL_SECONDS,
    );
    expect(songTailSeconds({ ...base, tracks: [] })).toBe(RENDER_TAIL_SECONDS);
  });

  it('extends the tail to a preset release longer than RENDER_TAIL_SECONDS', () => {
    // glassPad releases over 1.2 s even without macros.
    expect(songTailSeconds({ ...base, tracks: [synthTrack('a', 'glassPad')] })).toBeCloseTo(1.2, 9);
  });

  it('uses the release after the macros, plus the longest delay', () => {
    const macros: InstrumentMacros = { brightness: 0.5, release: 1, width: 0, attack: 0.5 };
    // warmPad release 0.5 s x4 = 2 s.
    expect(songTailSeconds({ ...base, tracks: [synthTrack('a', 'warmPad', macros)] })).toBeCloseTo(2, 9);
    expect(
      songTailSeconds({ ...base, tracks: [synthTrack('a', 'warmPad', macros), synthTrack('b', 'roundBass', undefined, 0.5)] }),
    ).toBeCloseTo(2.5, 9);
    expect(renderLengthSeconds({ ...base, tracks: [synthTrack('a', 'warmPad', macros)] })).toBeGreaterThanOrEqual(4);
  });

  it('ignores drum tracks', () => {
    const drums: Track = { ...synthTrack('d', 'glassPad'), type: 'drum' };
    expect(songTailSeconds({ ...base, tracks: [drums] })).toBe(RENDER_TAIL_SECONDS);
  });

  it('uses the warm pad fallback for a non-string preset from saved JSON', () => {
    const track = synthTrack('a', 'warmPad');
    const project = { ...base, tracks: [track] };
    const saved = JSON.stringify({
      ...project,
      tracks: [{ ...track, instrument: { type: 'synth', preset: { toString: null } } }],
    });
    const malformed = JSON.parse(saved) as Project;
    expect(renderLengthSeconds(malformed)).toBe(renderLengthSeconds(project));
  });
});

describe('renderScheduleEvents (WAV) matches live playback', () => {
  const drumHits = (events: readonly { payload: unknown }[]) =>
    events.filter((e) => (e.payload as SchedulePayload).kind === 'drum').length;
  /** What live playback (loop off, from the start) sounds: the scheduler's song window. */
  const liveDrumHits = (project: Project) =>
    drumHits(
      nextEventsInWindow(
        buildScheduleEvents(project),
        0,
        songEndBeat(project),
        project.bpm,
        0,
        0,
        null,
      ),
    );

  /** 8 bars of 3/4 with a 32-step drum grid and kicks on the given steps. */
  const threeFour = (steps: number[]): Project => {
    const project = createDefaultProject({ lengthBars: 8, timeSignature: [3, 4] });
    return {
      ...project,
      tracks: project.tracks.map((t) =>
        t.type === 'drum'
          ? {
              ...t,
              clips: t.clips.map((c) => ({
                ...c,
                stepsPerBar: 32,
                drumEvents: steps.map((stepIndex) => ({ id: `k${stepIndex}`, lane: 'kick' as const, stepIndex, velocity: 100 })),
              })),
            }
          : t,
      ),
    };
  };

  it('leaves out a drum hit placed exactly on the song end, as live playback does', () => {
    // Step 256 of a 32-step 3/4 grid is beat 24 = the end of 8 bars.
    const project = threeFour([0, 256]);
    expect(liveDrumHits(project)).toBe(1);
    expect(drumHits(renderScheduleEvents(project))).toBe(1);
  });

  it('agrees with live playback after 3/4 -> 4/4 moves the last hit onto the end', () => {
    const { project, droppedHits } = setTimeSignature(threeFour([0, 255]), [4, 4]);
    expect(droppedHits).toBe(1);
    expect(liveDrumHits(project)).toBe(1);
    expect(drumHits(renderScheduleEvents(project))).toBe(liveDrumHits(project));
  });
});

describe('live playback, WAV and MIDI sound the same events', () => {
  const sounding = (type: Track['type'], id: string, clips: Clip[]): Track => ({
    id,
    name: id,
    type,
    clips,
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  });
  const noteClip = (id: string, trackId: string, startBeat: number, extra: Partial<Clip> = {}): Clip => ({
    id,
    trackId,
    type: 'midi',
    startBeat,
    lengthBeats: 4,
    loop: false,
    notes: [{ id: `${id}-n`, pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    ...extra,
  });
  const songOf = (lengthBars: number, tracks: Track[]): Project => ({
    ...createEmptyProject({ lengthBars }),
    tracks,
  });
  /** [beat, kind] of everything each path sounds, in beat order. */
  const live = (project: Project) =>
    nextEventsInWindow(buildScheduleEvents(project), 0, songEndBeat(project), project.bpm, 0, 0, null)
      .map((e) => [e.beat, (e.payload as SchedulePayload).kind])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
  const wav = (project: Project) =>
    renderScheduleEvents(project)
      .map((e) => [e.beat, (e.payload as SchedulePayload).kind])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
  const midi = (project: Project) =>
    parseMidi(exportProjectToMidi(project))
      .tracks.flatMap((t) => t.notes)
      .map((n) => [n.startBeat, n.channel === 9 ? 'drum' : 'note'])
      .sort((a, b) => Number(a[0]) - Number(b[0]));

  it('a link to a note clip placed on a drum track sounds on no path', () => {
    const project = songOf(2, [
      sounding('instrument', 'keys', [noteClip('src', 'keys', 0)]),
      sounding('drum', 'drums', [noteClip('link', 'drums', 4, { aliasOf: 'src', notes: [] })]),
    ]);
    const expected = [[0, 'note']];
    expect(live(project)).toEqual(expected);
    expect(wav(project)).toEqual(expected);
    expect(midi(project)).toEqual(expected);
  });

  it('a drum clip on an instrument track sounds on no path', () => {
    const drumClip: Clip = {
      id: 'beat',
      trackId: 'keys',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [{ id: 'k', lane: 'kick', stepIndex: 0, velocity: 100 }],
    };
    const project = songOf(1, [sounding('instrument', 'keys', [drumClip])]);
    expect(live(project)).toEqual([]);
    expect(wav(project)).toEqual([]);
    expect(midi(project)).toEqual([]);
  });

  it('a note starting on the song end (beat 4 of a 1-bar 4/4 song) sounds on no path', () => {
    const project = songOf(1, [sounding('instrument', 'keys', [noteClip('end', 'keys', 4)])]);
    expect(live(project)).toEqual([]);
    expect(wav(project)).toEqual([]);
    expect(midi(project)).toEqual([]);
  });

  it('a note crossing the song end is cut on every path and WAV retains the tail', () => {
    // 1 bar of 4/4: song end at beat 4. The 4-beat note at beat 3 is cut at beat 4.
    const project = songOf(1, [
      sounding('instrument', 'keys', [
        noteClip('cross', 'keys', 0, {
          lengthBeats: 8,
          notes: [{ id: 'x', pitch: 60, startBeat: 3, durationBeats: 4, velocity: 100 }],
        }),
      ]),
    ]);
    const durations = (events: ReadonlyArray<{ payload: unknown }>) =>
      events.map((e) => (e.payload as Extract<SchedulePayload, { kind: 'note' }>).durationBeats);
    const spb = 60 / project.bpm;

    expect(durations(buildScheduleEvents(project))).toEqual([1]);
    expect(durations(renderScheduleEvents(project))).toEqual([1]);
    expect(parseMidi(exportProjectToMidi(project)).tracks.flatMap((t) => t.notes).map((n) => n.durationBeats)).toEqual([1]);
    expect(renderLengthSeconds(project)).toBeCloseTo(4 * spb + RENDER_TAIL_SECONDS, 9);
  });
});

describe('renderProjectToWav applies the track macros', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(applyMacros).mockClear();
  });

  /** Minimal OfflineAudioContext: records the filter cutoffs the voices set. */
  function stubOfflineContext(cutoffs: number[]): void {
    const param = (record?: number[]) => ({
      setValueAtTime: vi.fn((v: number) => record?.push(v)),
      linearRampToValueAtTime: vi.fn(),
    });
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        currentTime = 0;
        createOscillator() {
          return { type: 'sine', frequency: param(), detune: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
        }
        createBiquadFilter() {
          return { type: 'lowpass', frequency: param(cutoffs), Q: param(), connect: vi.fn() };
        }
        createGain() {
          return { gain: param(), connect: vi.fn() };
        }
        createStereoPanner() {
          return { pan: param(), connect: vi.fn() };
        }
        async startRendering() {
          return { numberOfChannels: 2, getChannelData: () => new Float32Array(1) };
        }
      },
    );
  }

  const keysProject = (macros?: InstrumentMacros): Project => ({
    ...createEmptyProject({ lengthBars: 1 }),
    tracks: [
      {
        id: 'keys',
        name: 'keys',
        type: 'instrument',
        instrument: macros ? { type: 'synth', preset: 'warmPad', macros } : { type: 'synth', preset: 'warmPad' },
        clips: [
          {
            id: 'c1',
            trackId: 'keys',
            type: 'midi',
            startBeat: 0,
            lengthBeats: 4,
            loop: false,
            notes: [{ id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
          },
        ],
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
    ],
  });

  it('calls applyMacros with the track macros and renders the shaped cutoff', async () => {
    const macros = { brightness: 1, release: 0.5, width: 0, attack: 0.5 };
    const cutoffs: number[] = [];
    stubOfflineContext(cutoffs);
    await renderProjectToWav(keysProject(macros));
    expect(vi.mocked(applyMacros)).toHaveBeenCalledWith(expect.objectContaining({ cutoffHz: 1400 }), macros);
    // warmPad 1400 Hz, brightness 1 = 4x.
    expect(cutoffs).toEqual([5600]);
  });

  it('renders a track without macros at the preset cutoff', async () => {
    const cutoffs: number[] = [];
    stubOfflineContext(cutoffs);
    await renderProjectToWav(keysProject());
    expect(cutoffs).toEqual([1400]);
  });
});
