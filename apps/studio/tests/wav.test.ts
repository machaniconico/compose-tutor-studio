import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  songEndBeat,
  createDefaultProject,
  createEmptyProject,
  createTrack,
  PPQ,
  setTimeSignature,
  type Clip,
  type InstrumentMacros,
  type Project,
  type Track,
} from '@cts/project-model';
import { exportProjectToMidi, parseMidi } from '@cts/midi-io';
import { buildParamSchedule } from '../src/audio/automationSchedule';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { nextEventsInWindow } from '../src/audio/scheduler';
import { integratedLoudness, truePeak } from '../src/audio/loudness';
import { applyMacros } from '../src/audio/macros';
import { PRESET_LIST } from '../src/audio/presets';
import {
  assertWavRenderFits,
  encodeWav,
  floatToInt16,
  normalizePeak,
  normalizePeakInChunks,
  RENDER_TAIL_SECONDS,
  renderLengthSeconds,
  renderProjectToWav,
  renderScheduleEvents,
  songTailSeconds,
  wavLoopWindow,
  WavSizeLimitError,
  type WavSampleRate,
} from '../src/audio/wav';

// applyMacros is wrapped in a spy (calling the real mapping) so the WAV render
// can be shown to go through it. Graph and master chain are stubbed: only the
// voices are built on the fake OfflineAudioContext below.
vi.mock('../src/audio/macros', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/macros')>();
  return { ...actual, applyMacros: vi.fn(actual.applyMacros) };
});
const { scheduleAutomation } = vi.hoisted(() => ({ scheduleAutomation: vi.fn() }));
vi.mock('../src/audio/graph', () => ({
  buildTrackGraphs: (_ctx: unknown, _master: unknown, tracks: ReadonlyArray<{ id: string }>) =>
    new Map(tracks.map((t) => [t.id, { input: {}, dispose: () => {}, scheduleAutomation }])),
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
    const buffer = encodeWav([mono], 48000);
    const view = new DataView(buffer);
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(48000);
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

describe('renderProjectToWav', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(applyMacros).mockClear();
    scheduleAutomation.mockClear();
  });

  /** Records synth automation and writes an impulse at each oscillator onset. */
  function stubOfflineContext(cutoffs: number[], timing?: { starts: number[]; releaseEnds: number[] }): void {
    const param = (record?: number[]) => ({
      setValueAtTime: vi.fn((v: number) => record?.push(v)),
      linearRampToValueAtTime: vi.fn(),
    });
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        currentTime = 0;
        private readonly starts: number[] = [];

        constructor(
          private readonly channels: number,
          private readonly frames: number,
          private readonly sampleRate: number,
        ) {}
        createOscillator() {
          return {
            type: 'sine', frequency: param(), detune: param(), connect: vi.fn(),
            start: (time: number) => {
              this.starts.push(time);
              timing?.starts.push(time);
            },
            stop: vi.fn(),
          };
        }
        createBiquadFilter() {
          return { type: 'lowpass', frequency: param(cutoffs), Q: param(), connect: vi.fn() };
        }
        createGain() {
          return {
            gain: {
              ...param(),
              linearRampToValueAtTime: (value: number, time: number) => {
                if (value === 0) timing?.releaseEnds.push(time);
              },
            },
            connect: vi.fn(),
          };
        }
        createStereoPanner() {
          return { pan: param(), connect: vi.fn() };
        }
        async startRendering() {
          return {
            numberOfChannels: this.channels,
            sampleRate: this.sampleRate,
            getChannelData: (channel: number) => {
              const data = new Float32Array(this.frames);
              for (const time of this.starts) data[Math.round(time * this.sampleRate)] = channel ? -0.25 : 0.5;
              return data;
            },
          };
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

  // Captured using the unmodified renderer at HEAD (227d8fb) at a fractional-frame tempo.
  it.each([
    [44100, 'full', '8b4937feb17ba5c0abd6617b3650151257106ecb5799475f37ac0e23f09ad0e7'],
    [44100, 'loop', '67d9f40f4a2f7b804eb55dd695200c8ba2a115e8b7db77c105f42a6c48e0d245'],
    [48000, 'full', 'e31324f9026d1707755156fd0e92e27687824bb445c7f857221b6302a7768764'],
    [48000, 'loop', '32e06162358319275d165b9cc7fa84bb4320df2babafbff778dcef46c52dcc5c'],
  ] as const)('preserves HEAD WAV bytes at %i Hz (%s)', async (sampleRate, range, digest) => {
    stubOfflineContext([]);
    const project = { ...keysProject(), bpm: 137, loopRange: { startBeat: 0, endBeat: 1.25 } };
    const wav = await renderProjectToWav(project, { sampleRate, range, bitDepth: 16, dither: false });
    expect(createHash('sha256').update(new Uint8Array(await wav.arrayBuffer())).digest('hex')).toBe(digest);
    expect(await (await renderProjectToWav(project, { sampleRate, range })).arrayBuffer())
      .toEqual(await wav.arrayBuffer());
    expect(scheduleAutomation).not.toHaveBeenCalled();
  });

  it('checks the outer RIFF size and the 4 GiB data limit', () => {
    const firstRiffOverflow = (2 ** 32 - 36) / 4;
    expect(() => assertWavRenderFits(firstRiffOverflow - 1, 16)).not.toThrow();
    expect(() => assertWavRenderFits(firstRiffOverflow, 16)).toThrow(WavSizeLimitError);
    expect(() => assertWavRenderFits(2 ** 32 / 4, 16)).toThrow(WavSizeLimitError);
  });

  it('refuses an oversized 24-bit WAV before constructing an offline context', async () => {
    const project = { ...createEmptyProject({ bpm: 120, lengthBars: 7500 }), tracks: [] };
    const context = vi.fn();
    vi.stubGlobal('OfflineAudioContext', context);
    await expect(renderProjectToWav(project, { sampleRate: 48000, bitDepth: 24 })).rejects.toThrow(/WAV ファイル.*約 4 GB/);
    expect(context).not.toHaveBeenCalled();
  });

  it('uses the shared volume schedule from the loop export start through its end', async () => {
    stubOfflineContext([]);
    const project = { ...keysProject(), bpm: 120, loopRange: { startBeat: 1, endBeat: 3 } };
    const lane = { points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] };
    project.tracks[0]!.automation = { volume: lane };
    await renderProjectToWav(project, { range: 'loop' });

    expect(scheduleAutomation).toHaveBeenCalledExactlyOnceWith({
      bpm: 120, startBeat: 1, endBeat: 3, loop: null, startTime: 0,
    });
    const { startBeat, loop, bpm, ...options } = scheduleAutomation.mock.lastCall![0];
    expect(buildParamSchedule(lane, startBeat, loop, bpm, options)).toEqual([
      { method: 'setValueAtTime', value: 0.25, time: 0 },
      { method: 'linearRampToValueAtTime', value: 0.75, time: 1 },
    ]);
  });

  it('writes 48 kHz stereo PCM with the rounded song length plus a one-second tail', async () => {
    stubOfflineContext([]);
    const project = { ...keysProject(), lengthBars: 4, bpm: 137 };
    const wav = await renderProjectToWav(project, { sampleRate: 48000 });
    const view = new DataView(await wav.arrayBuffer());
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe((Math.round(16 * 60 / 137 * 48000) + 48000) * 2 * 2);
  });

  it('writes the eight beats in [4, 12) and keeps the echo and release tail', async () => {
    stubOfflineContext([]);
    const project = { ...keysProject(), bpm: 137, lengthBars: 4, loopRange: { startBeat: 4, endBeat: 12 } };
    const track = project.tracks[0]!;
    track.effects = [{ id: 'echo', type: 'delay', enabled: true, params: { timeSeconds: 0.5 } }];
    const clip = track.clips[0]!;
    clip.lengthBeats = 16;
    clip.notes = [
      { id: 'before', startBeat: 3, durationBeats: 3, pitch: 60, velocity: 100 },
      { id: 'start', startBeat: 4, durationBeats: 2, pitch: 61, velocity: 100 },
      { id: 'cross', startBeat: 11, durationBeats: 2, pitch: 62, velocity: 100 },
      { id: 'end', startBeat: 12, durationBeats: 1, pitch: 63, velocity: 100 },
    ];
    const loop = wavLoopWindow(project);
    if ('reason' in loop) throw new Error(loop.reason);
    const schedule = renderScheduleEvents(project, loop.window);
    expect(schedule).toMatchObject([
      { beat: 4, time: 0, payload: { pitch: 61, durationBeats: 2 } },
      { beat: 11, time: 7 * (60 / 137), payload: { pitch: 62, durationBeats: 1, cut: true } },
    ]);
    const wav = await renderProjectToWav(project, { sampleRate: 48000, range: 'loop' });
    const view = new DataView(await wav.arrayBuffer());
    expect(view.getUint32(40, true)).toBe((Math.round(8 * 60 / 137 * 48000) + 72000) * 2 * 2);
  });

  it('clamps the loop to the song end and uses integer-tick boundaries', async () => {
    stubOfflineContext([]);
    const project = { ...keysProject(), bpm: 120, loopRange: { startBeat: 3.003, endBeat: 12 } };
    expect(wavLoopWindow(project)).toEqual({ window: { startBeat: 1441 / PPQ, endBeat: 4 } });
    const wav = await renderProjectToWav(project, { range: 'loop' });
    expect(new DataView(await wav.arrayBuffer()).getUint32(40, true))
      .toBe((Math.round(479 / PPQ * 60 / 120 * 44100) + 44100) * 4);
  });

  it('rejects invalid sample rates with a Japanese reason', async () => {
    await expect(renderProjectToWav(keysProject(), { sampleRate: 96000 as WavSampleRate })).rejects.toThrow('44.1 kHzか48 kHz');
    expect(() => encodeWav([], 22050)).toThrow('44.1 kHzか48 kHz');
  });

  it('rejects missing or empty loop ranges with a Japanese reason', async () => {
    const project = keysProject();
    await expect(renderProjectToWav(project, { range: 'loop' })).rejects.toThrow('ループ範囲がありません');
    for (const loopRange of [
      { startBeat: 2, endBeat: 2 + 0.25 / PPQ },
      { startBeat: 4, endBeat: 8 },
    ]) {
      await expect(renderProjectToWav({ ...project, loopRange }, { range: 'loop' })).rejects.toThrow('書き出せるループ範囲がありません');
    }
  });

  it('preserves loop envelopes and MIDI metadata in 300 cases (seed 0x028)', async () => {
    let seed = 0x028;
    const randomInt = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor(seed / 2 ** 32 * max);
    };
    // Expected GM programs and MIDI spellings are independent of the writer's tables.
    const programs = [
      ['warmPad', 89], ['roundBass', 38], ['subBass', 38], ['deepSubBass', 39],
      ['brightLead', 81], ['leadSine', 81], ['squareLead', 80], ['pianoLike', 0],
      ['softKeys', 4], ['bell', 14], ['organLike', 16], ['stringsLike', 48],
      ['brassLike', 61], ['pluck', 45], ['glassPad', 92], ['constructor', 89], [undefined, 89],
    ] as const;
    expect(programs.map(([preset]) => preset)).toEqual(expect.arrayContaining(PRESET_LIST.map(({ id }) => id)));
    const keys = [
      ['G', 'G', 'G'], ['C#', 'C#', 'C#'], ['Gb', 'Gb', 'F#'], ['D#', 'Eb', 'D#'],
      ['Ab', 'Ab', 'Ab'], ['Bb', 'Bb', 'Bb'], ['A#', 'Bb', 'A#'], ['F', 'F', 'F'],
      ['Db', 'Db', 'C#'], ['E', 'E', 'E'], ['B', 'B', 'B'], ['G#', 'Ab', 'G#'],
      ['A', 'A', 'A'], ['C', 'C', 'C'], ['D', 'D', 'D'], ['F#', 'F#', 'F#'], ['Eb', 'Eb', 'Eb'],
    ] as const;
    const scales = ['major', 'naturalMinor', 'harmonicMinor', 'melodicMinor'] as const;
    const timing = { starts: [] as number[], releaseEnds: [] as number[] };
    stubOfflineContext([], timing);
    for (let i = 0; i < 300; i++) {
      timing.starts.length = 0;
      timing.releaseEnds.length = 0;
      const [preset, program] = programs[randomInt(programs.length)]!;
      const [key, major, minor] = keys[randomInt(keys.length)]!;
      const scale = scales[randomInt(scales.length)]!;
      const bpm = 55 + randomInt(200);
      const sampleRate = randomInt(2) === 0 ? 44100 : 48000;
      const start = 1 + randomInt(4 * PPQ - 2);
      const end = start + 1 + randomInt(4 * PPQ - start);
      const loopRange = { startBeat: (start + 0.2) / PPQ, endBeat: (end + 0.3) / PPQ };
      const project: Project = { ...keysProject(), bpm, key, scale, loopRange };
      const track = project.tracks[0]!;
      track.instrument = preset === undefined ? undefined : {
        type: 'synth', preset,
        macros: { brightness: 0.5, release: randomInt(101) / 100, width: 0, attack: randomInt(101) / 100 },
      };
      const noteTicks = [start - 1, start, start + randomInt(end - start), end - 1, end]
        .map((tick, index) => ({ tick, pitch: 60 + index, duration: 1 + randomInt(2 * PPQ) }));
      track.clips[0]!.notes = noteTicks.map(({ tick, pitch, duration }) => ({
        id: `n${pitch}`, pitch, startBeat: tick / PPQ, durationBeats: duration / PPQ, velocity: 100,
      }));
      const wav = await renderProjectToWav(project, { range: 'loop', sampleRate });
      const actualStarts = timing.starts.filter((_, index) => index % 2 === 0);
      const expectedStarts = noteTicks.filter(({ tick }) => tick >= start && tick < end)
        .map(({ tick }) => (tick - start) / PPQ * (60 / bpm))
        .sort((a, b) => a - b);
      expect(actualStarts, `case ${i}`).toHaveLength(expectedStarts.length);
      expect(Math.min(...actualStarts), `case ${i}`).toBe(0);
      actualStarts.forEach((time, index) => expect(time, `case ${i}`).toBeCloseTo(expectedStarts[index]!, 10));
      expect(timing.releaseEnds, `case ${i}`).toHaveLength(expectedStarts.length);
      const frames = (wav.size - 44) / 4;
      expect(frames / sampleRate, `case ${i}`).toBeGreaterThanOrEqual(Math.max(...timing.releaseEnds));
      const midi = parseMidi(exportProjectToMidi(project));
      expect(midi.key, `case ${i}`).toBe(scale === 'major' ? `${major} major` : `${minor} minor`);
      expect(midi.tracks[1]?.program, `case ${i}`).toBe(program);
    }
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

describe('songTailSeconds: shared returns', () => {
  const project = createEmptyProject();
  const source = project.tracks[0]!;
  const room: Track = {
    ...createTrack('Room', 'bus', undefined, undefined, undefined, 'room'),
    effects: [{ id: 'reverb', type: 'reverb', enabled: true, params: { mix: 1 } }],
  };
  const echo: Track = {
    ...createTrack('Echo', 'bus', undefined, undefined, undefined, 'echo'),
    effects: [{ id: 'delay', type: 'delay', enabled: true, params: { timeSeconds: 0.5, feedback: 0.5, mix: 1 } }],
  };
  const tail = (tracks: Track[]) => songTailSeconds({ ...project, tracks }, { liveReleaseOverhang: 0 });
  const sends = { room: 0.5, echo: 0.5 };

  it('includes reachable reverb and delay feedback and preserves the legacy tail for silent sends', () => {
    expect(tail([{ ...source, solo: true, sends }, room])).toBeCloseTo(2.4);
    expect(tail([{ ...source, sends }, room, echo])).toBeCloseTo(6);
    expect(tail([{ ...source, sends }, room, { ...echo, mute: true }])).toBeCloseTo(2.4);
    expect(tail([{ ...source, sends, mute: true }, room, echo])).toBe(1.5);
    expect(tail([{ ...source, sends: { room: 0, echo: 0 } }, room, echo])).toBe(tail([source, room, echo]));
  });

  it('includes the full tail of serial effects on a reachable return', () => {
    expect(tail([{ ...source, sends }, { ...room, effects: [...echo.effects, ...room.effects] }])).toBeCloseTo(7.4);
  });
});

function pcm24(view: DataView, offset: number): number {
  return (view.getInt8(offset + 2) << 16) | view.getUint16(offset, true);
}

describe('WAV encoding options', () => {
  it('writes interleaved little-endian 24-bit PCM with asymmetric clamping', () => {
    const view = new DataView(encodeWav([
      Float32Array.of(-2, 0.5, -0.5),
      Float32Array.of(2, 1, -1),
    ], 48000, { bitDepth: 24 }));
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint16(32, true)).toBe(6);
    expect(view.getUint32(28, true)).toBe(48000 * 6);
    expect(view.getUint32(40, true)).toBe(18);
    expect(view.byteLength).toBe(62);
    expect(Array.from({ length: 6 }, (_, i) => pcm24(view, 44 + i * 3)))
      .toEqual([-8388608, 8388607, 4194304, 8388607, -4194304, -8388608]);
    expect([...new Uint8Array(view.buffer, 44, 6)]).toEqual([0, 0, 128, 255, 255, 127]);
  });

  it('pads an odd 24-bit mono data chunk without changing its size field', () => {
    const view = new DataView(encodeWav([Float32Array.of(0.5)], 44100, { bitDepth: 24 }));
    expect(view.getUint32(40, true)).toBe(3);
    expect(view.getUint32(4, true)).toBe(40);
    expect(view.byteLength).toBe(48);
    expect(view.getUint8(47)).toBe(0);
  });

  it('adds deterministic 16-bit TPDF dither, with no effect in 24-bit mode', () => {
    const silence = [new Float32Array(4096)];
    const dithered = encodeWav(silence, 44100, { dither: true });
    expect(dithered).toEqual(encodeWav(silence, 44100, { dither: true }));
    const samples = new Int16Array(dithered, 44);
    expect([...new Set(samples)].sort()).toEqual([-1, 0, 1]);
    expect(encodeWav(silence, 44100, { bitDepth: 24, dither: true }))
      .toEqual(encodeWav(silence, 44100, { bitDepth: 24 }));
  });

  it('leaves silence untouched and adjusts both channels to one unclipped peak before dither', () => {
    const silence = [new Float32Array(8)];
    expect(normalizePeak(silence)).toBe(silence);
    expect(encodeWav(silence, 44100, { normalize: true })).toEqual(encodeWav(silence, 44100));
    const signal = [Float32Array.of(-2, 0.5), Float32Array.of(1, 0.25)];
    const normalized = normalizePeak(signal);
    const target = 10 ** (-1 / 20);
    expect(normalized[0]![0]).toBeCloseTo(-target, 7);
    expect(normalized[1]![0]).toBeCloseTo(target / 2, 7);
    expect(signal[0]![0]).toBe(-2);
    const settings = { normalize: true, dither: true };
    expect(encodeWav(signal, 44100, settings)).toEqual(encodeWav(normalized, 44100, { dither: true }));
    expect(new DataView(encodeWav(signal, 44100, settings)).getInt16(44, true)).toBeGreaterThan(-32768);
  });

  it('preserves exact Float32 normalization across sample chunks', async () => {
    const left = new Float32Array(20_000).fill(0.123);
    const right = new Float32Array(18_000).fill(-0.456);
    right[right.length - 1] = -2;
    const gain = 10 ** (-1 / 20) / 2;
    const channels = [left, right];
    expect(await normalizePeakInChunks(channels, {}))
      .toEqual(channels.map((channel) => channel.map((sample) => sample * gain)));
  });

  it('round-trips PCM within 1 LSB and produces defined meter values for 200 signals (seed 0x035)', () => {
    let state = 0x035;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    for (let i = 0; i < 200; i += 1) {
      const rate = i % 2 === 0 ? 44100 : 48000;
      const frames = i % 20 === 0 ? Math.round(rate * 0.55) : Math.floor(random() * 512);
      const amplitude = i % 11 === 0 ? 0 : 1.25 * 10 ** (-6 * random());
      const channel = () => Float32Array.from({ length: frames }, () => (2 * random() - 1) * amplitude);
      const channels = i % 3 === 0 ? [channel()] : [channel(), channel()];
      for (const bitDepth of [16, 24] as const) {
        const wav = new DataView(encodeWav(channels, rate, { bitDepth }));
        const negativeScale = 2 ** (bitDepth - 1);
        for (let index = 0; index < frames * channels.length; index += 1) {
          const sample = channels[index % channels.length]![Math.floor(index / channels.length)]!;
          const offset = 44 + index * bitDepth / 8;
          const pcm = bitDepth === 16 ? wav.getInt16(offset, true) : pcm24(wav, offset);
          const scale = pcm < 0 ? negativeScale : negativeScale - 1;
          const expected = Math.max(-1, Math.min(1, sample));
          if (Math.abs(pcm / scale - expected) > 1 / (negativeScale - 1)) {
            throw new Error(`signal ${i}, ${bitDepth}-bit sample ${index} exceeds 1 LSB`);
          }
        }
      }
      for (const value of [integratedLoudness(channels, rate), truePeak(channels)]) {
        expect(Number.isFinite(value) || value === -Infinity).toBe(true);
      }
    }
  });
});
