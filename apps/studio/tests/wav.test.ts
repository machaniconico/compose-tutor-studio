import { describe, expect, it } from 'vitest';
import {
  beatsPerBar,
  createDefaultProject,
  createEmptyProject,
  setTimeSignature,
  type Clip,
  type Project,
  type Track,
} from '@cts/project-model';
import { exportProjectToMidi, parseMidi } from '@cts/midi-io';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { nextEventsInWindow, projectLengthBeats } from '../src/audio/scheduler';
import {
  encodeWav,
  floatToInt16,
  RENDER_TAIL_SECONDS,
  renderLengthSeconds,
  renderScheduleEvents,
} from '../src/audio/wav';

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
        projectLengthBeats(project.lengthBars, beatsPerBar(project.timeSignature)),
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
    nextEventsInWindow(buildScheduleEvents(project), 0, projectLengthBeats(project.lengthBars, 4), project.bpm, 0, 0, null)
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

  it('a note starting inside the song and ending past it sounds its full length on every path, and the WAV lasts until it ends', () => {
    // 1 bar of 4/4: song end at beat 4. The 4-beat note at beat 3 ends at beat 7.
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

    expect(durations(renderScheduleEvents(project))).toEqual([4]);
    expect(parseMidi(exportProjectToMidi(project)).tracks.flatMap((t) => t.notes).map((n) => n.durationBeats)).toEqual([4]);
    expect(renderLengthSeconds(project)).toBeCloseTo(7 * spb + RENDER_TAIL_SECONDS, 9);
  });
});
