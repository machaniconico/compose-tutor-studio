import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrumClip, createMidiClip, moveClip, resizeClip, soundingEvents } from '@cts/project-model';
import type { Clip, DrumLane } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

// US-012b: clip edits while playing take effect at once. Real Scheduler on a
// hand-driven audio clock; the voice mocks record what is actually heard
// (start, end, and any release) so the test can compare it with the new
// soundingEvents from the playhead on.
const clock = vi.hoisted(() => ({ now: 0 }));
type HeardVoice = {
  kind: 'note' | 'drum';
  what: string;
  start: number;
  end: number;
  releasedAt: number | null;
};
const voices = vi.hoisted(() => [] as HeardVoice[]);
const clicks = vi.hoisted(() => [] as Array<{ time: number; cancelledAt: number | null }>);
const release = (voice: HeardVoice, when: number) => {
  voice.releasedAt = Math.min(voice.releasedAt ?? Infinity, when);
};

vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: true,
    now: () => clock.now,
    ensureContext: async () => ({ context: { currentTime: clock.now }, master: {} }),
    requireMaster: () => ({}),
  }),
}));
vi.mock('../src/audio/graph', () => ({
  applyMixState: vi.fn(),
  // Disposing a graph silences the drum hits it has not played yet.
  buildTrackGraphs: vi.fn((_ctx: unknown, _master: unknown, tracks: ReadonlyArray<{ id: string }>) =>
    new Map(tracks.map((t) => [t.id, {
      input: { trackId: t.id },
      dispose: () => {
        for (const v of voices) {
          if (v.kind === 'drum' && v.what.startsWith(`${t.id}:`) && v.start > clock.now) release(v, clock.now);
        }
      },
    }]))),
}));
vi.mock('../src/audio/masterChain', () => ({ applyMasterVolume: vi.fn() }));
vi.mock('../src/audio/synth', () => ({
  SynthVoiceManager: class {
    private readonly own: HeardVoice[] = [];
    private readonly trackId: string;
    constructor(_ctx: unknown, output: { trackId: string }) {
      this.trackId = output.trackId;
    }
    // Like the real synth: 16 voices per track, the oldest one is taken
    // when a new note needs a voice (and only then).
    noteOn = vi.fn((pitch: number, start: number, duration: number) => {
      const busy = this.own.filter((v) => Math.min(v.end, v.releasedAt ?? Infinity) > start);
      if (busy.length >= 16) release(busy[0]!, start);
      const voice: HeardVoice = { kind: 'note', what: `${this.trackId}:n${pitch}`, start, end: start + duration, releasedAt: null };
      voices.push(voice);
      this.own.push(voice);
      return {
        release: (when: number) => release(voice, when),
        setDuration: (seconds: number, when: number) => {
          voice.end = voice.start + seconds;
          if (voice.end <= when) release(voice, when);
        },
      };
    });
    releaseAll = vi.fn((when: number) => {
      for (const voice of this.own) release(voice, when);
    });
  },
}));
vi.mock('../src/audio/drums', () => ({
  DrumVoiceManager: class {
    private readonly trackId: string;
    constructor(_ctx: unknown, output: { trackId: string }) {
      this.trackId = output.trackId;
    }
    trigger = vi.fn((lane: DrumLane, time: number) => {
      const voice: HeardVoice = { kind: 'drum', what: `${this.trackId}:${lane}`, start: time, end: Infinity, releasedAt: null };
      voices.push(voice);
      return { release: (when: number) => release(voice, when) };
    });
  },
}));
vi.mock('../src/audio/metronome', async (importOriginal) => ({
  metronomeBeatEvents: (await importOriginal<typeof import('../src/audio/metronome')>()).metronomeBeatEvents,
  scheduleMetronomeClick: vi.fn((_ctx: unknown, _out: unknown, time: number) => {
    const click = { time, cancelledAt: null as number | null };
    clicks.push(click);
    return () => {
      click.cancelledAt = clock.now;
    };
  }),
}));

let useStore: typeof import('../src/state/store')['useStore'];
let activeLoopRange: typeof import('../src/state/store')['activeLoopRange'];
let initAudioBridge: typeof import('../src/audio/playback')['initAudioBridge'];
let isValidLoop: typeof import('../src/audio/scheduler')['isValidLoop'];
let graph: typeof import('../src/audio/graph');
let actions: typeof import('../src/state/editorActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore, activeLoopRange } = await import('../src/state/store'));
  ({ initAudioBridge } = await import('../src/audio/playback'));
  ({ isValidLoop } = await import('../src/audio/scheduler'));
  graph = await import('../src/audio/graph');
  actions = await import('../src/state/editorActions');
});

const r = (x: number) => Math.round(x * 1e4) / 1e4;
const store = () => useStore.getState();

function trackId(name: string): string {
  const track = store().project.tracks.find((t) => t.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track.id;
}

function midi(id: string, start: number, length: number, notes: Array<[number, number, number]>): Clip {
  return {
    ...createMidiClip('melody', start, length, id),
    notes: notes.map(([pitch, startBeat, durationBeats], i) => ({ id: `${id}-n${i}`, pitch, startBeat, durationBeats, velocity: 100 })),
  };
}

function drums(id: string, start: number, length: number, hits: Array<[DrumLane, number]>): Clip {
  return {
    ...createDrumClip('drums', start, length, 16, id),
    drumEvents: hits.map(([lane, stepIndex], i) => ({ id: `${id}-d${i}`, lane, stepIndex, velocity: 100 })),
  };
}

/** Put the clips on Melody and Drums, empty the other tracks, and clear the history. */
function setup(melodyClips: Clip[], drumClips: Clip[] = []): void {
  const melody = trackId('Melody');
  const drum = trackId('Drums');
  store().applyProjectChange((project) => ({
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.id === melody
        ? melodyClips.map((c) => ({ ...c, trackId: melody }))
        : track.id === drum
          ? drumClips.map((c) => ({ ...c, trackId: drum }))
          : [],
    })),
  }));
  useStore.setState({ past: [], future: [] });
}

async function playFrom(beat: number): Promise<void> {
  store().setPosition(beat);
  store().play();
  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
}

/** Walk the audio clock to `time` in small steps, ticking the scheduler on each. */
function runTo(time: number): void {
  while (clock.now < time - 1e-9) {
    clock.now = Math.min(time, clock.now + 0.05);
    vi.advanceTimersByTime(25);
  }
}

/** What sounds from `from` on (seconds): notes clipped to `from`, drum hits not cancelled. */
function heard(from: number, until: number): string[] {
  return voices.flatMap((v) => {
    const stop = Math.min(v.end, v.releasedAt ?? Infinity);
    if (v.kind === 'drum') return v.start >= from - 1e-9 && v.start < until && stop > v.start ? [`${v.what}@${r(v.start)}`] : [];
    if (v.start >= until || stop <= Math.max(v.start, from) + 1e-9) return [];
    return [`${v.what}@${r(Math.max(v.start, from))}-${r(stop)}`];
  }).sort();
}

/**
 * The new soundingEvents walked forward from playhead beat `beat` at audio time
 * `from`: what should sound from then on. Inside a loop, a note from the
 * previous pass may still ring across the wrap. A note that started before
 * `from` is expected only when a voice for it was sounding at the edit: same
 * sound, and the same start (or, for a voice resumed by a restart, the same
 * end). Nothing else is started part-way.
 */
function expected(beat: number, from: number, until: number, spb = 0.5): string[] {
  const live = voices
    .filter((v) => v.kind === 'note' && v.start < from - 1e-9 && v.end > from + 1e-9 && (v.releasedAt ?? Infinity) >= from - 1e-9)
    .map((v) => ({ what: v.what, start: r(v.start), end: r(v.end) }));
  const s = store();
  const range = activeLoopRange(s);
  const loop = range && isValidLoop(range) ? range : null;
  const out: string[] = [];
  for (const e of soundingEvents(s.project).events) {
    const what = `${e.trackId}:${e.kind === 'note' ? `n${e.pitch}` : e.lane}`;
    const offsets: number[] = [];
    if (!loop) offsets.push(e.startBeat - beat);
    else if (e.startBeat < loop.startBeat) {
      if (beat < loop.startBeat) offsets.push(e.startBeat - beat);
    } else if (e.startBeat < loop.endBeat) {
      const length = loop.endBeat - loop.startBeat;
      if (beat >= loop.startBeat) offsets.push(e.startBeat - beat - length);
      offsets.push(e.startBeat - beat);
      for (let k = 1; from + (loop.endBeat - beat + (k - 1) * length) * spb < until; k += 1) {
        offsets.push(loop.endBeat - beat + (k - 1) * length + (e.startBeat - loop.startBeat));
      }
    }
    for (const offset of offsets) {
      const start = from + offset * spb;
      if (start >= until) continue;
      if (e.kind === 'note') {
        const end = start + e.durationBeats * spb;
        if (end <= from + 1e-9) continue;
        if (start < from - 1e-9) {
          const index = live.findIndex((v) => v.what === what && (v.start === r(start) || v.end === r(end)));
          if (index < 0) continue;
          live.splice(index, 1);
        }
        out.push(`${what}@${r(Math.max(start, from))}-${r(end)}`);
      } else if (start >= from - 1e-9) {
        out.push(`${what}@${r(start)}`);
      }
    }
  }
  return out.sort();
}

function noteVoices(pitch: number): HeardVoice[] {
  return voices.filter((v) => v.kind === 'note' && v.what.endsWith(`:n${pitch}`));
}

describe('clip edits during playback (US-012b)', () => {
  let teardown: () => void;

  beforeEach(() => {
    clock.now = 0;
    voices.length = 0;
    clicks.length = 0;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    store().createNewProject('テスト');
    teardown = initAudioBridge();
    vi.mocked(graph.buildTrackGraphs).mockClear();
  });

  afterEach(() => {
    if (store().transport.isPlaying) store().stop();
    teardown();
    vi.useRealTimers();
  });

  const m1 = () => midi('m1', 0, 4, [[60, 0, 2], [62, 2, 1], [64, 3, 1]]);
  const m2 = () => midi('m2', 8, 4, [[67, 0, 2]]);
  const d1 = () => drums('d1', 0, 4, [['kick', 0], ['snare', 8]]);

  describe('heard events match the new soundingEvents', () => {
    // Edits land at beat 1.9: the note at 0 is sounding, and the note and the
    // snare at beat 2 are already queued in the lookahead window.
    const EDIT_TIME = 0.95;
    const EDIT_BEAT = 1.9;
    const SONG_END = 16;

    it.each([
      ['moving the sounding clip', () => store().applyProjectChange((p) => moveClip(p, 'm1', 1))],
      ['moving another clip', () => store().applyProjectChange((p) => moveClip(p, 'm2', 4))],
      ['duplicating the sounding clip', (): void => void actions.duplicateClipInSong('m1', 'copy', 64)],
      ['removing the sounding clip', (): void => actions.removeClipFromSong('m1')],
      ['removing the drum clip with a queued hit', (): void => actions.removeClipFromSong('d1')],
      ['shortening the sounding clip to end after the playhead', () => store().applyProjectChange((p) => resizeClip(p, 'm1', 2.5))],
      ['shortening the sounding clip to end before the playhead', () => store().applyProjectChange((p) => resizeClip(p, 'm1', 1.5))],
      ['splitting the sounding clip', (): void => {
        expect(actions.splitClipAtBeat('m1', 3)).toBe(true);
      }],
    ] as const)('after %s', async (_name, edit) => {
      setup([m1(), m2()], [d1()]);
      await playFrom(0);
      runTo(EDIT_TIME);
      edit();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
      runTo(SONG_END + 0.5);
      expect(heard(EDIT_TIME, SONG_END)).toEqual(expected(EDIT_BEAT, EDIT_TIME, SONG_END));
    });

    it('does not restart a note an edit cancelled when the edit is undone', async () => {
      setup([m1(), m2()], [d1()]);
      await playFrom(0);
      runTo(EDIT_TIME);
      store().applyProjectChange((p) => moveClip(p, 'm1', 1));
      store().undo();
      runTo(SONG_END + 0.5);
      // The 60 at beat 0 was cut at the move and is not started part-way.
      expect(noteVoices(60).filter((v) => v.start >= EDIT_TIME - 1e-9 && v.start < 2)).toEqual([]);
    });

    it('starts a note that a longer clip no longer cuts, from the playhead', async () => {
      setup([midi('m1', 0, 1, [[60, 0, 2]])]);
      await playFrom(0);
      runTo(0.25);
      store().applyProjectChange((p) => resizeClip(p, 'm1', 4));
      runTo(SONG_END + 0.5);
      expect(heard(0.25, SONG_END)).toEqual([`${trackId('Melody')}:n60@0.25-1`]);
      expect(heard(0.25, SONG_END)).toEqual(expected(0.5, 0.25, SONG_END));
    });
  });

  describe('sounding notes are not played twice or restarted', () => {
    it.each([
      ['moving another clip', () => store().applyProjectChange((p) => moveClip(p, 'm2', 4))],
      ['duplicating the sounding clip', (): void => void actions.duplicateClipInSong('m1', 'copy', 64)],
      ['removing a drum clip', (): void => actions.removeClipFromSong('d1')],
    ] as const)('keeps the note sounding across the playhead as one voice after %s', async (_name, edit) => {
      setup([m1(), m2()], [d1()]);
      await playFrom(0);
      runTo(0.5);
      edit();
      runTo(2);
      const held = noteVoices(60).filter((v) => v.start === 0);
      expect(held).toHaveLength(1);
      expect(held[0]?.releasedAt).toBeNull();
      // Only the duplicate adds a later 60 (beat 4); nothing restarts at the playhead.
      expect(noteVoices(60).filter((v) => v.start > 0 && v.start < 2)).toEqual([]);
    });

    it('releases a sounding note at the new clip end instead of restarting it', async () => {
      setup([m1()]);
      await playFrom(0);
      runTo(0.5);
      store().applyProjectChange((p) => resizeClip(p, 'm1', 1.5));
      runTo(2);
      // Its end moves to the new clip end; the voice is not rebuilt.
      expect(noteVoices(60).map((v) => [v.end, v.releasedAt])).toEqual([[0.75, null]]);
    });

    it('does not rebuild the voices or move the playhead', async () => {
      setup([m1(), m2()], [d1()]);
      await playFrom(0);
      runTo(0.95);
      vi.advanceTimersByTime(33);
      const before = store().transport.positionBeat;
      expect(before).toBeCloseTo(1.9);
      store().applyProjectChange((p) => moveClip(p, 'm2', 4));
      actions.removeClipFromSong('m1');
      store().applyProjectChange((p) => resizeClip(p, 'm2', 2));
      void actions.duplicateClipInSong('m2', 'copy', 64);
      expect(store().transport.positionBeat).toBe(before);
      expect(graph.buildTrackGraphs).toHaveBeenCalledTimes(1);
      runTo(1.5);
      vi.advanceTimersByTime(33);
      expect(store().transport.positionBeat).toBeCloseTo(3);
    });
  });

  describe('unedited notes keep their voice (US-012b review round 3)', () => {
    it.each([1, 3])('keeps the queued %i-beat note when adding a same-key note with a different end', async (duration) => {
      setup([midi('m1', 0, 8, [[60, 2, duration]])]);
      await playFrom(0);
      runTo(0.95); // Beat 1.9 at 120 BPM, with the beat 2 note queued.
      const [original] = noteVoices(60);
      expect(original).toMatchObject({ start: 1, end: 1 + duration * 0.5 });

      setup([midi('m1', 0, 8, [[60, 2, duration], [60, 2, 4 - duration]])]);
      runTo(3);

      expect(heard(0.95, 3)).toEqual([`${trackId('Melody')}:n60@1-1.5`, `${trackId('Melody')}:n60@1-2.5`]);
      expect(original).toMatchObject({ end: 1 + duration * 0.5, releasedAt: null });
    });

    it('keeps the linked copy sounding when its source clip is deleted', async () => {
      setup([midi('src', 0, 4, [[60, 0, 4]])]);
      expect(actions.duplicateClipInSong('src', 'link', 64)).not.toBeNull();
      useStore.setState({ past: [], future: [] });
      await playFrom(4);
      runTo(0.5); // beat 5
      actions.removeClipFromSong('src');
      runTo(2.5);
      expect(noteVoices(60).map((v) => [v.start, v.releasedAt === null || v.releasedAt >= 2 - 1e-9])).toEqual([[0, true]]);
      expect(heard(0.5, 2.5)).toEqual([`${trackId('Melody')}:n60@0.5-2`]);
    });

    it('keeps a later note sounding when an earlier note of the clip is deleted', async () => {
      setup([midi('m1', 0, 4, [[60, 0, 1], [64, 1, 3]])]);
      await playFrom(0);
      runTo(1); // beat 2
      actions.removeNotes('m1', ['m1-n0']);
      runTo(2.5);
      expect(noteVoices(64).map((v) => [v.start, v.end, v.releasedAt])).toEqual([[0.5, 2, null]]);
    });

    it('lengthens a cut note in place without taking another note\'s voice', async () => {
      const notes: Array<[number, number, number]> = [];
      for (let pitch = 60; pitch <= 74; pitch += 1) notes.push([pitch, 0, 2]);
      notes.push([75, 0, 4]);
      setup([midi('m1', 0, 3, notes)]);
      await playFrom(0);
      runTo(0.5); // beat 1, all 16 voices sounding
      store().applyProjectChange((p) => resizeClip(p, 'm1', 4));
      runTo(2.5);
      expect(noteVoices(60).map((v) => [v.end, v.releasedAt])).toEqual([[1, null]]);
      expect(noteVoices(75).map((v) => [v.start, v.end, v.releasedAt])).toEqual([[0, 2, null]]);
    });
  });

  describe('history', () => {
    it.each([
      ['a dragged move (one transaction)', () => {
        store().beginTransaction('drag');
        store().applyProjectChange((p) => moveClip(p, 'm2', 12));
        store().applyProjectChange((p) => moveClip(p, 'm2', 16));
        store().commitTransaction('drag');
      }],
      ['a duplicate', (): void => void actions.duplicateClipInSong('m1', 'copy', 64)],
      ['a delete', (): void => actions.removeClipFromSong('m1')],
      ['a resize', () => store().applyProjectChange((p) => resizeClip(p, 'm1', 2))],
    ] as const)('adds one undo step for %s while playing', async (_name, edit) => {
      setup([m1(), m2()]);
      await playFrom(0);
      runTo(0.5);
      edit();
      expect(store().past).toHaveLength(1);
      runTo(1);
      expect(store().past).toHaveLength(1);
      expect(store().transport.isPlaying).toBe(true);
    });
  });

  describe('song end', () => {
    it('keeps a note cut at the song end sounding through an edit and stops at the end', async () => {
      setup([m1(), midi('m3', 28, 4, [[72, 3, 4]])]);
      await playFrom(28);
      runTo(1.75); // beat 31.5: the last note (cut to 31..32) is sounding
      store().applyProjectChange((p) => moveClip(p, 'm1', 4));
      runTo(3);
      expect(noteVoices(72)).toHaveLength(1);
      expect(heard(1.75, 2)).toEqual(expected(31.5, 1.75, 2));
      expect(store().transport.isPlaying).toBe(false);
    });

    it('plays on into the bar a duplicate adds at the song end', async () => {
      setup([midi('m3', 28, 4, [[72, 3, 4]])]);
      await playFrom(28);
      runTo(1.75);
      expect(actions.duplicateClipInSong('m3', 'copy', 64)).not.toBeNull();
      expect(store().project.lengthBars).toBe(9);
      runTo(2.5);
      expect(store().transport.isPlaying).toBe(true);
      runTo(4.5);
      expect(heard(1.75, 4)).toEqual(expected(31.5, 1.75, 4));
      expect(store().transport.isPlaying).toBe(false);
    });

    it('stops and rewinds when an edit shortens the song to before the playhead', async () => {
      setup([midi('m3', 28, 4, [[72, 3, 4]])]);
      await playFrom(28);
      runTo(0.5);
      expect(store().setLengthBars(4, true)).toBeNull();
      await vi.waitFor(() => expect(store().transport.isPlaying).toBe(false));
      expect(store().transport.positionBeat).toBe(0);
    });
  });

  describe('loop playback', () => {
    // Loop over beats 0..8. m4 runs past the loop end, so its note at 7.5
    // rings across the wrap into the next pass.
    const LOOP_UNTIL = 20;
    const m4 = () => midi('m4', 4, 8, [[71, 3.5, 1]]);

    async function playLoop(): Promise<void> {
      store().setLoopRange({ startBeat: 0, endBeat: 8 });
      store().toggleLoop();
      useStore.setState({ past: [], future: [] });
      await playFrom(0);
    }

    it('keeps the note ringing across the wrap through an edit', async () => {
      setup([m1(), m4()], [d1()]);
      await playLoop();
      runTo(8.125); // unwrapped beat 16.25, wrapped 0.25
      actions.removeClipFromSong('m1');
      runTo(LOOP_UNTIL);
      expect(heard(8.125, LOOP_UNTIL)).toEqual(expected(0.25, 8.125, LOOP_UNTIL));
      expect(noteVoices(71).filter((v) => v.start === 7.75)).toHaveLength(1);
    });

    it('does not play a note of a pass not yet played on an edit in the first pass', async () => {
      setup([m1(), m4()], [d1()]);
      await playLoop();
      runTo(0.125); // beat 0.25 of the first pass: the 71 at 7.5 has never played
      actions.removeClipFromSong('d1');
      runTo(4.5);
      // Only the first pass's own 71 at 3.75 s, nothing started at the edit.
      expect(noteVoices(71).map((v) => v.start)).toEqual([3.75]);
    });

    it('keeps the note ringing across the first wrap on the same edit in the second pass', async () => {
      setup([m1(), m4()], [d1()]);
      await playLoop();
      runTo(4.125); // unwrapped 8.25: the 71 from 3.75 s rings until 4.25 s
      actions.removeClipFromSong('d1');
      runTo(4.5);
      const ringing = noteVoices(71).filter((v) => v.start < 4.125);
      expect(ringing.map((v) => [v.start, v.releasedAt])).toEqual([[3.75, null]]);
      expect(noteVoices(71).filter((v) => v.start >= 4.125)).toEqual([]);
    });

    it('does not play the note of a loop just turned on when a clip is then deleted (review a)', async () => {
      setup([m1(), m4()], [d1()]);
      await playFrom(0);
      runTo(2.125); // beat 4.25
      store().setLoopRange({ startBeat: 4, endBeat: 8 });
      store().toggleLoop();
      await vi.waitFor(() => expect(graph.buildTrackGraphs).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
      actions.removeClipFromSong('d1');
      runTo(4.5);
      // Only the loop's own pass at 7.5 (3.75 s); nothing at 2.125..2.25 s.
      expect(noteVoices(71).map((v) => r(v.start))).toEqual([3.75]);
    });

    it('does not play a note skipped at the start when a clip is deleted (review b)', async () => {
      setup([m1(), m4()], [d1()]);
      store().setLoopRange({ startBeat: 0, endBeat: 8 });
      store().toggleLoop();
      useStore.setState({ past: [], future: [] });
      await playFrom(7.5005);
      runTo(0.125);
      actions.removeClipFromSong('d1');
      runTo(4.5);
      // The first 71 is the next pass at unwrapped 15.5.
      expect(noteVoices(71).map((v) => r(v.start))).toEqual([r((15.5 - 7.5005) * 0.5)]);
    });

    it('cancels the next pass already queued at the loop end', async () => {
      setup([m1(), m4()], [d1()]);
      await playLoop();
      runTo(7.95); // wrapped 7.9: the downbeat of the next pass is queued
      store().applyProjectChange((p) => moveClip(p, 'm1', 0.5));
      store().applyProjectChange((p) => moveClip(p, 'd1', 1));
      runTo(LOOP_UNTIL);
      expect(heard(7.95, LOOP_UNTIL)).toEqual(expected(7.9, 7.95, LOOP_UNTIL));
    });

    it('resumes the note ringing across the wrap after a tempo change, then follows an edit', async () => {
      setup([m1(), m4()], [d1()]);
      await playLoop();
      runTo(8.125);
      store().setBpm(60);
      await vi.waitFor(() => expect(graph.buildTrackGraphs).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
      // Remaining 0.25 beat of the 71 at 1 s per beat.
      const resumed = noteVoices(71).filter((v) => v.start === 8.125);
      expect(resumed.map((v) => r(v.end))).toEqual([8.375]);
      runTo(9.125); // wrapped 1.25 at 60 bpm
      actions.removeClipFromSong('d1');
      runTo(LOOP_UNTIL);
      expect(heard(9.125, LOOP_UNTIL)).toEqual(expected(1.25, 9.125, LOOP_UNTIL, 1));
    });

    it('resumes both overlapping passes of the same note after a tempo change', async () => {
      setup([midi('m1', 0, 4, [[60, 0, 4]])]);
      store().setLoopRange({ startBeat: 0, endBeat: 1 });
      store().toggleLoop();
      await playFrom(0);
      const changeTime = 0.625; // Beat 0.25 of the second pass at 120 BPM.
      runTo(changeTime);
      expect(noteVoices(60).map((v) => v.start)).toEqual([0, 0.5]);

      store().setBpm(60);
      await vi.waitFor(() => expect(graph.buildTrackGraphs).toHaveBeenCalledTimes(2));

      const remaining = noteVoices(60)
        .filter((v) => v.start === changeTime)
        .map((v) => v.end - changeTime)
        .sort((a, b) => a - b);
      expect(remaining).toEqual([2.75, 3.75]);
    });

    it('treats a loop range shorter than the shortest period as no loop', async () => {
      setup([m1(), m2()], [d1()]);
      store().setLoopRange({ startBeat: 4, endBeat: 4 + 1 / 128 });
      store().toggleLoop();
      useStore.setState({ past: [], future: [] });
      await playFrom(0);
      runTo(0.95);
      store().applyProjectChange((p) => moveClip(p, 'm1', 1));
      runTo(16.5);
      expect(heard(0.95, 16)).toEqual(expected(1.9, 0.95, 16));
      expect(store().transport.isPlaying).toBe(false);
    });
  });

  describe('metronome (US-006 follow-up)', () => {
    it('does not double the queued click when the tempo changes', async () => {
      setup([m1()]);
      store().toggleMetronome();
      await playFrom(0);
      runTo(0.95); // beat 1.9: the click on beat 2 is queued at 1.0 s
      store().setBpm(90);
      await vi.waitFor(() => expect(graph.buildTrackGraphs).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
      runTo(3);
      const heardClicks = clicks
        .filter((c) => c.time >= 0.95 && c.time < 3 && (c.cancelledAt === null || c.cancelledAt > c.time))
        .map((c) => r(c.time));
      const spb = 60 / 90;
      expect(heardClicks).toEqual([2, 3, 4].map((beat) => r(0.95 + (beat - 1.9) * spb)));
    });

    it('does not double a queued click due exactly when the tempo changes', async () => {
      setup([m1()]);
      store().toggleMetronome();
      await playFrom(0);
      runTo(1); // the click on beat 2 is due now, at 1.000 s
      store().setBpm(90);
      await vi.waitFor(() => expect(graph.buildTrackGraphs).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
      runTo(1.2);
      const atOne = clicks.filter((c) => r(c.time) === 1 && (c.cancelledAt === null || c.cancelledAt > c.time));
      expect(atOne).toHaveLength(1);
    });

    it('does not reschedule clicks for a clip edit', async () => {
      setup([m1(), m2()]);
      store().toggleMetronome();
      await playFrom(0);
      runTo(0.95);
      store().applyProjectChange((p) => moveClip(p, 'm2', 4));
      runTo(3);
      const times = clicks.filter((c) => c.cancelledAt === null).map((c) => r(c.time));
      expect(times).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
    });
  });
});

// Property: an edit or a restart never starts a sound at once unless that
// sound already had a live voice (it then continues for its remaining length).
// Seeded random edit sequences; edit times avoid the beat grid so a genuine
// event start never coincides with an edit.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('no instant sound without a live voice (property, US-012b review)', () => {
  let teardown: () => void;

  beforeEach(() => {
    clock.now = 0;
    voices.length = 0;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    store().createNewProject('テスト');
    teardown = initAudioBridge();
  });

  afterEach(() => {
    if (store().transport.isPlaying) store().stop();
    teardown();
    vi.useRealTimers();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  it('holds over 100 seeded edit sequences', async () => {
    const random = mulberry32(20261127);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const grid = (max: number) => Math.floor(random() * max * 4) / 4;
    const violations: string[] = [];

    for (let run = 0; run < 100; run += 1) {
      if (store().transport.isPlaying) store().stop();
      await settle();
      clock.now = 0;
      voices.length = 0;
      store().createNewProject('テスト');
      setup(
        [
          midi('m1', 0, 4, [[60, 0, 2], [62, 2, 1], [64, 3.5, 3]]),
          midi('m2', 8, 4, [[67, 0, 4], [69, 1.75, 0.5]]),
          midi('m4', 16, 8, [[71, 3.5, 1], [72, 6, 6]]),
        ],
        [drums('d1', 0, 4, [['kick', 0], ['snare', 8]]), drums('d2', 8, 8, [['closedHat', 2], ['kick', 16]])],
      );
      if (random() < 0.6) {
        const start = grid(16);
        store().setLoopRange({ startBeat: start, endBeat: start + 1 + grid(8) });
        store().toggleLoop();
      }
      useStore.setState({ past: [], future: [] });
      const startBeat = grid(20) + 0.0137;
      store().setPosition(startBeat);
      store().play();
      await settle();
      // The run's timeline as the test models it: playhead beat `beat` at
      // audio time `time`; rebuilt when playback restarts.
      const loopNow = () => {
        const range = activeLoopRange(store());
        return range && isValidLoop(range) ? range : null;
      };
      let anchor = { beat: startBeat, time: 0, spb: 60 / store().project.bpm, loop: loopNow() };
      const songBeatAt = (time: number) => {
        const unwrapped = anchor.beat + (time - anchor.time) / anchor.spb;
        const { loop } = anchor;
        if (!loop || unwrapped < loop.startBeat) return unwrapped;
        return loop.startBeat + ((unwrapped - loop.startBeat) % (loop.endBeat - loop.startBeat));
      };

      for (let step = 0; step < 6; step += 1) {
        runTo(clock.now + 0.1 + random() * 1.5 + 0.00731);
        if (!store().transport.isPlaying) break;
        const now = clock.now;
        const live = voices
          .filter((v) => v.kind === 'note' && v.start < now - 1e-9 && Math.min(v.end, v.releasedAt ?? Infinity) > now + 1e-9)
          .map((v) => v.what);
        const from = voices.length;
        const builds = vi.mocked(graph.buildTrackGraphs).mock.calls.length;
        // Voices started in this run (not resumed at a restart) and sounding now.
        const sounding = voices.filter((v) =>
          v.kind === 'note' && v.start > anchor.time + 1e-6 && v.start < now - 1e-9 &&
          Math.min(v.end, v.releasedAt ?? Infinity) > now + 1e-9);
        const clipIds = store().project.tracks.flatMap((t) => t.clips.map((c) => c.id));
        const op = pick(['move', 'resize', 'duplicate', 'link', 'remove', 'removeNote', 'split', 'undo', 'bpm', 'loop'] as const);
        const clipId = clipIds.length > 0 ? pick(clipIds) : '';
        if (op === 'move') store().applyProjectChange((p) => moveClip(p, clipId, grid(24)));
        else if (op === 'resize') store().applyProjectChange((p) => resizeClip(p, clipId, 1 + grid(6)));
        else if (op === 'duplicate') actions.duplicateClipInSong(clipId, 'copy', 64);
        else if (op === 'link') actions.duplicateClipInSong(clipId, 'link', 64);
        else if (op === 'removeNote') {
          const clip = store().project.tracks.flatMap((t) => t.clips).find((c) => (c.notes?.length ?? 0) > 0);
          if (clip?.notes) actions.removeNotes(clip.id, [pick(clip.notes).id]);
        }
        else if (op === 'remove') actions.removeClipFromSong(clipId);
        else if (op === 'split') actions.splitClipAtBeat(clipId, grid(24));
        else if (op === 'undo') store().undo();
        else if (op === 'bpm') store().setBpm(pick([90, 100, 120, 140]));
        else store().toggleLoop();
        await settle();
        if (vi.mocked(graph.buildTrackGraphs).mock.calls.length !== builds) {
          // Playback restarted (tempo, loop, or an undo of either): new timeline.
          anchor = { beat: songBeatAt(now), time: now, spb: 60 / store().project.bpm, loop: loopNow() };
        } else {
          // Same sound (track, pitch, start) before and after, still sounding:
          // its voice must not stop before the new end.
          const events = soundingEvents(store().project).events;
          for (const v of sounding) {
            const beat = songBeatAt(v.start);
            const next = events.find((e) =>
              e.kind === 'note' && `${e.trackId}:n${e.pitch}` === v.what && Math.abs(e.startBeat - beat) < 1e-6);
            if (next?.kind !== 'note') continue;
            const end = v.start + next.durationBeats * anchor.spb;
            if (end <= now + 1e-9) continue;
            const stop = Math.min(v.end, v.releasedAt ?? Infinity);
            if (stop < end - 1e-6) {
              violations.push(`run ${run} step ${step} ${op}: ${v.what} stopped at ${r(stop)} s before its end ${r(end)} s`);
            }
          }
        }
        for (const v of voices.slice(from)) {
          if (v.start > now + 1e-9) continue; // a lookahead start at its own time
          const index = v.kind === 'note' ? live.indexOf(v.what) : -1;
          if (index < 0) violations.push(`run ${run} step ${step} ${op}: ${v.what} started at once (${r(now)} s)`);
          else live.splice(index, 1);
        }
      }
    }
    expect(violations).toEqual([]);
  }, 60_000);
});
