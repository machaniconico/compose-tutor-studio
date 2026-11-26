// US-019: a choked open hat is silent from its closed hat on, in live playback and in the WAV render.
// The real DrumVoiceManager runs on a recording fake context; the audible window of every node is
// read back from its start/stop times and gain automation.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@cts/project-model';
import { beatTick } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';
import { mulberry32 } from '../../../packages/project-model/tests/acceptance/helpers';

type Automation = { kind: 'set' | 'exp' | 'lin'; value: number; time: number };

class FakeParam {
  events: Automation[] = [];
  setValueAtTime(value: number, time: number) { this.events.push({ kind: 'set', value, time }); return this; }
  exponentialRampToValueAtTime(value: number, time: number) { this.events.push({ kind: 'exp', value, time }); return this; }
  linearRampToValueAtTime(value: number, time: number) { this.events.push({ kind: 'lin', value, time }); return this; }
}

class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  type = '';
  connect<T>(node: T) { return node; }
  disconnect() {}
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  startAt = Number.NaN;
  stopAt = Infinity;
  start(time: number) { this.startAt = time; }
  stop(time: number) { this.stopAt = time; }
}

const recorded = vi.hoisted(() => ({ sources: [] as unknown[], gains: [] as unknown[] }));
const clock = vi.hoisted(() => ({ now: 0 }));

class FakeContext {
  sampleRate = 48000;
  get currentTime() { return clock.now; }
  createGain() { const node = new FakeNode(); recorded.gains.push(node); return node; }
  createBiquadFilter() { return new FakeNode(); }
  createOscillator() { const node = new FakeSource(); recorded.sources.push(node); return node; }
  createBufferSource() { const node = new FakeSource(); recorded.sources.push(node); return node; }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { duration: length / sampleRate, getChannelData: () => new Float32Array(length) };
  }
  async startRendering() { return { numberOfChannels: 2, getChannelData: () => new Float32Array(1) }; }
}

const fakeContext = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: true,
    now: () => clock.now,
    ensureContext: async () => ({ context: fakeContext.current, master: {} }),
    requireMaster: () => ({}),
  }),
}));
vi.mock('../src/audio/graph', () => ({
  applyMixState: vi.fn(),
  buildTrackGraphs: (_ctx: unknown, _master: unknown, tracks: ReadonlyArray<{ id: string }>) =>
    new Map(tracks.map((t) => [t.id, { input: {}, dispose: () => {} }])),
}));
vi.mock('../src/audio/masterChain', () => ({
  applyMasterVolume: vi.fn(),
  createMasterChain: () => ({ input: {} }),
}));
vi.mock('../src/audio/synth', () => ({
  SynthVoiceManager: class { noteOn = vi.fn(); releaseAll = vi.fn(); },
}));
vi.mock('../src/audio/metronome', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/metronome')>()),
  scheduleMetronomeClick: vi.fn(),
}));

let useStore: typeof import('../src/state/store')['useStore'];
let initAudioBridge: typeof import('../src/audio/playback')['initAudioBridge'];
let renderProjectToWav: typeof import('../src/audio/wav')['renderProjectToWav'];
let renderScheduleEvents: typeof import('../src/audio/wav')['renderScheduleEvents'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ initAudioBridge } = await import('../src/audio/playback'));
  ({ renderProjectToWav, renderScheduleEvents } = await import('../src/audio/wav'));
});

/** 120 BPM, 4/4, 16 steps: open hat at step 0, closed hat at step 1 (0.125 s later). */
function chokeProject(project: Project): Project {
  const track = project.tracks.find((t) => t.type === 'drum')!;
  return {
    ...project,
    bpm: 120,
    timeSignature: [4, 4],
    lengthBars: 1,
    tracks: [{
      ...track, mute: false, solo: false, effects: [],
      clips: [{
        id: 'hats', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 4, loop: false, stepsPerBar: 16,
        drumEvents: [
          { id: 'open', lane: 'openHat', stepIndex: 0, velocity: 100 },
          { id: 'closed', lane: 'closedHat', stepIndex: 1, velocity: 100 },
        ],
      }],
    }],
  };
}

/** The open hat's nodes start first; every one of them must be silent from the closed hat on. */
function expectSilentAfterChoke(): void {
  const sources = recorded.sources as FakeSource[];
  const starts = [...new Set(sources.map((s) => s.startAt))].sort((a, b) => a - b);
  expect(starts.length).toBeGreaterThanOrEqual(2);
  const [openAt, closedAt] = starts as [number, number];
  expect(closedAt - openAt).toBeCloseTo(0.125, 9);
  const open = sources.filter((s) => s.startAt === openAt);
  expect(open.length).toBeGreaterThan(0);
  for (const source of open) expect(source.stopAt).toBeLessThanOrEqual(closedAt + 1e-12);
  // Its gain reaches exactly 0 at the choke (a short ramp, not only a decay towards 0.001).
  const openGains = (recorded.gains as FakeNode[]).filter((g) => g.gain.events.some((e) => e.time === openAt && e.kind === 'set' && e.value > 0));
  expect(openGains.length).toBeGreaterThan(0);
  for (const g of openGains) {
    const last = g.gain.events.at(-1)!;
    expect(last.value).toBe(0);
    expect(last.time).toBeLessThanOrEqual(closedAt + 1e-12);
  }
}

describe('hi-hat choke is silent from the closed hat on (US-019)', () => {
  let teardown: () => void;

  beforeEach(() => {
    clock.now = 0;
    recorded.sources.length = 0;
    recorded.gains.length = 0;
    fakeContext.current = new FakeContext();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    useStore.getState().createNewProject('テスト');
    useStore.getState().applyProjectChange(chokeProject);
    teardown = initAudioBridge();
  });

  afterEach(() => {
    if (useStore.getState().transport.isPlaying) useStore.getState().stop();
    teardown();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('live playback', async () => {
    useStore.getState().setPosition(0);
    useStore.getState().play();
    for (let i = 0; i < 20 && recorded.sources.length === 0; i += 1) {
      await Promise.resolve();
      vi.advanceTimersByTime(25);
    }
    clock.now = 0.5;
    vi.advanceTimersByTime(25);
    expectSilentAfterChoke();
  });

  it('WAV render', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeContext);
    await renderProjectToWav(useStore.getState().project);
    expectSilentAfterChoke();
  });
});

/** 120 BPM, 4/4, 16 steps, 2 bars; one 4-beat drum clip with the given hits; the first 4 beats looped. */
function loopProject(hits: Array<[number, 'openHat' | 'closedHat']>) {
  return (project: Project): Project => {
    const track = project.tracks.find((t) => t.type === 'drum')!;
    return {
      ...project,
      bpm: 120,
      timeSignature: [4, 4],
      lengthBars: 2,
      swing: 0,
      tracks: [{
        ...track, mute: false, solo: false, effects: [],
        clips: [{
          id: 'hats', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 8, loop: false, stepsPerBar: 16,
          drumEvents: hits.map(([stepIndex, lane], i) => ({ id: `h${i}`, lane, stepIndex, velocity: 100 })),
        }],
      }],
    };
  };
}

describe('hi-hat choke across the loop wrap in live playback (US-019)', () => {
  let teardown: () => void;

  beforeEach(() => {
    clock.now = 0;
    recorded.sources.length = 0;
    recorded.gains.length = 0;
    fakeContext.current = new FakeContext();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    useStore.getState().createNewProject('テスト');
  });

  afterEach(() => {
    if (useStore.getState().transport.isPlaying) useStore.getState().stop();
    teardown();
    vi.useRealTimers();
  });

  /** Play the 4-beat loop until `seconds` and return the noise sources by start time. */
  async function playLoop(hits: Array<[number, 'openHat' | 'closedHat']>, seconds: number): Promise<FakeSource[]> {
    useStore.getState().applyProjectChange(loopProject(hits));
    useStore.getState().loopRangeOn({ startBeat: 0, endBeat: 4 });
    teardown = initAudioBridge();
    useStore.getState().setPosition(0);
    useStore.getState().play();
    for (let i = 0; i < 20 && recorded.sources.length === 0; i += 1) {
      await Promise.resolve();
      vi.advanceTimersByTime(25);
    }
    for (let t = 0; t <= seconds; t += 0.05) {
      clock.now = t;
      vi.advanceTimersByTime(25);
    }
    return (recorded.sources as FakeSource[]).slice().sort((a, b) => a.startAt - b.startAt);
  }

  it('an open hat at step 15 is choked by the next pass\'s closed hat at step 0, in the first and later passes', async () => {
    const sources = await playLoop([[0, 'closedHat'], [15, 'openHat']], 7);
    const t0 = sources[0]!.startAt; // the first closed hat
    const opens = sources.filter((s) => Math.abs(((s.startAt - t0) % 2) - 1.875) < 1e-9);
    expect(opens.length).toBeGreaterThanOrEqual(3);
    opens.forEach((open, pass) => {
      // 0.125 s later the next pass starts with its closed hat.
      expect(open.stopAt, `pass ${pass}`).toBeLessThanOrEqual(open.startAt + 0.125 + 1e-9);
    });
  });

  it('keeps the loop choke after a live edit and after a tempo change restarts playback', async () => {
    useStore.getState().applyProjectChange(loopProject([[0, 'closedHat'], [15, 'openHat']]));
    useStore.getState().loopRangeOn({ startBeat: 0, endBeat: 4 });
    teardown = initAudioBridge();
    useStore.getState().setPosition(0);
    useStore.getState().play();
    for (let i = 0; i < 20 && recorded.sources.length === 0; i += 1) {
      await Promise.resolve();
      vi.advanceTimersByTime(25);
    }
    const run = (from: number, to: number) => {
      for (let t = from; t <= to; t += 0.05) {
        clock.now = t;
        vi.advanceTimersByTime(25);
      }
    };
    run(0, 0.5);
    // A live edit (a kick added at step 8) re-schedules without restarting.
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((t) => (t.type === 'drum'
        ? { ...t, clips: t.clips.map((c) => ({ ...c, drumEvents: [...c.drumEvents!, { id: 'k', lane: 'kick' as const, stepIndex: 8, velocity: 100 }] })) }
        : t)),
    }));
    run(0.55, 4.5);
    // A tempo change restarts playback at the playhead: 60 BPM, a 16th is 0.25 s.
    useStore.getState().setBpm(60);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    const restartAt = clock.now;
    run(restartAt + 0.05, restartAt + 12);
    const hats = (recorded.sources as FakeSource[])
      // Noise sources only (the kick's body is an oscillator): closed hats ring 0.095 s, open hats longer.
      .filter((s) => s.buffer !== null && s.stopAt - s.startAt < 0.4 + 1e-9 && s.stopAt - s.startAt > 0.1);
    // Every open hat (the long hats) after the wrap stops when the next pass's closed hat starts.
    const closedStarts = (recorded.sources as FakeSource[])
      .filter((s) => s.buffer !== null && Math.abs(s.stopAt - s.startAt - 0.095) < 1e-9).map((s) => s.startAt);
    const opens = hats.filter((s) => !closedStarts.includes(s.startAt));
    expect(opens.filter((s) => s.startAt < restartAt).length).toBeGreaterThanOrEqual(2);
    expect(opens.filter((s) => s.startAt > restartAt).length).toBeGreaterThanOrEqual(2);
    for (const open of opens) {
      const next = closedStarts.filter((t) => t > open.startAt + 1e-9).sort((a, b) => a - b)[0];
      expect(next, `open at ${open.startAt}`).toBeDefined();
      expect(open.stopAt, `open at ${open.startAt}`).toBeCloseTo(next!, 9);
    }
  });

  it('does not stop the open hat when the loop holds no closed hat (a closed hat past the loop end never plays)', async () => {
    // Step 17 (beat 4.25) is outside the 4-beat loop: on the song timeline it would choke the open hat.
    const sources = await playLoop([[15, 'openHat'], [17, 'closedHat']], 5);
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const open of sources) expect(open.stopAt - open.startAt).toBeCloseTo(0.37, 9);
  });
});

describe('loop choke uses the scheduler\'s own placement (US-019 review 7)', () => {
  let teardown: (() => void) | undefined;
  type Tagged = { lane: string; source: FakeSource };
  let tagged: Tagged[] = [];
  let restoreTrigger: (() => void) | undefined;

  beforeEach(async () => {
    clock.now = 0;
    recorded.sources.length = 0;
    recorded.gains.length = 0;
    fakeContext.current = new FakeContext();
    tagged = [];
    // Tag the noise source each drum hit creates with its lane.
    const { DrumVoiceManager } = await import('../src/audio/drums');
    const original = DrumVoiceManager.prototype.trigger;
    DrumVoiceManager.prototype.trigger = function (this: InstanceType<typeof DrumVoiceManager>, ...args: Parameters<typeof original>) {
      const before = recorded.sources.length;
      const handle = original.apply(this, args);
      for (const source of (recorded.sources as FakeSource[]).slice(before)) {
        if (source.buffer !== null && source.startAt === args[1]) tagged.push({ lane: args[0], source });
      }
      return handle;
    };
    restoreTrigger = () => { DrumVoiceManager.prototype.trigger = original; };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    useStore.getState().createNewProject('テスト');
  });

  afterEach(() => {
    if (useStore.getState().transport.isPlaying) useStore.getState().stop();
    teardown?.();
    teardown = undefined;
    restoreTrigger?.();
    vi.useRealTimers();
  });

  async function playLoopRange(
    hits: Array<[number, 'openHat' | 'closedHat' | 'kick']>,
    startBeat: number,
    endBeat: number,
    seconds: number,
    { swing = 0, stepsPerBar = 16, loop = true }: { swing?: number; stepsPerBar?: number; loop?: boolean } = {},
  ) {
    useStore.getState().applyProjectChange((project) => {
      const track = project.tracks.find((t) => t.type === 'drum')!;
      return {
        ...project, bpm: 120, timeSignature: [4, 4], lengthBars: 2, swing,
        tracks: [{
          ...track, mute: false, solo: false, effects: [],
          clips: [{
            id: 'hats', trackId: track.id, type: 'drum', startBeat: 0, lengthBeats: 8, loop: false, stepsPerBar,
            drumEvents: hits.map(([stepIndex, lane], i) => ({ id: `h${i}`, lane, stepIndex, velocity: 100 })),
          }],
        }],
      };
    });
    if (loop) useStore.getState().loopRangeOn({ startBeat, endBeat });
    teardown = initAudioBridge();
    useStore.getState().setPosition(0);
    useStore.getState().play();
    for (let i = 0; i < 20 && recorded.sources.length === 0; i += 1) {
      await Promise.resolve();
      vi.advanceTimersByTime(25);
    }
    for (let t = 0; t <= seconds; t += 0.05) {
      clock.now = t;
      vi.advanceTimersByTime(25);
    }
  }

  /**
   * Every open hat stops at the first closed hat the scheduler played after it whose
   * sounding tick is later (the song-timeline rule: song ticks, plus one loop's ticks
   * per pass), if that comes before its own end; else it rings out. 120 BPM from
   * audio time 0: a playhead beat is time × 2, and the song beat of each source is
   * found among the song's own sounding beats.
   */
  function expectChokedByScheduledClosedHats(label: string, loop: { startBeat: number; endBeat: number } | null = null): number {
    const songBeats = renderScheduleEvents(useStore.getState().project)
      .map((e) => ({ beat: e.beat, lane: (e.payload as { lane?: string }).lane }));
    const length = loop ? loop.endBeat - loop.startBeat : Infinity;
    const place = (lane: string, time: number) => {
      const playhead = time * 2;
      for (const { beat, lane: l } of songBeats) {
        if (l !== lane) continue;
        const pass = loop ? Math.round((playhead - beat) / length) : 0;
        if (pass >= 0 && Math.abs(beat + (pass === 0 ? 0 : pass * length) - playhead) < 1e-9) return { tick: beatTick(beat), pass };
      }
      throw new Error(`${label}: no song beat for ${lane} at ${time}`);
    };
    const loopTicks = loop ? beatTick(length) : 0;
    const closed = tagged.filter((t) => t.lane === 'closedHat')
      .map((t) => ({ time: t.source.startAt, ...place('closedHat', t.source.startAt) }))
      .sort((a, b) => a.time - b.time);
    const opens = tagged.filter((t) => t.lane === 'openHat').map((t) => t.source);
    let choked = 0;
    // Only judge open hats whose whole ring-out lies before the last recorded hit (later ones may be unscheduled yet).
    const horizon = Math.max(...tagged.map((t) => t.source.startAt));
    for (const open of opens) {
      if (open.startAt + 0.37 > horizon) continue;
      const o = place('openHat', open.startAt);
      const next = closed.find((c) => c.time > open.startAt && c.tick + (c.pass - o.pass) * loopTicks > o.tick)?.time;
      if (next !== undefined && next < open.startAt + 0.32 + 0.05) {
        choked++;
        expect(open.stopAt, `${label}: open at ${open.startAt}`).toBeCloseTo(next, 9);
      } else {
        expect(open.stopAt - open.startAt, `${label}: open at ${open.startAt}`).toBeCloseTo(0.37, 9);
      }
    }
    return choked;
  }

  it('a closed hat at beat 4 inside the 0〜4.0005 loop chokes the open hat at beat 3.75 (same tick as the loop end)', async () => {
    await playLoopRange([[15, 'openHat'], [16, 'closedHat']], 0, 4.0005, 5);
    const opens = tagged.filter((t) => t.lane === 'openHat');
    const closed = tagged.filter((t) => t.lane === 'closedHat');
    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect(closed.length).toBeGreaterThanOrEqual(2);
    expect(closed[0]!.source.startAt - opens[0]!.source.startAt).toBeCloseTo(0.125, 9);
    const horizon = Math.max(...tagged.map((t) => t.source.startAt));
    const judged = opens.filter((o) => o.source.startAt + 0.37 <= horizon).length;
    expect(judged).toBeGreaterThanOrEqual(1);
    expect(expectChokedByScheduledClosedHats('repro', { startBeat: 0, endBeat: 4.0005 })).toBe(judged);
    // Every open hat, the last one included, stops at the closed hat 0.125 s later.
    for (const { source } of opens) expect(source.stopAt).toBeCloseTo(source.startAt + 0.125, 9);
  });

  it('a closed hat on the same tick as the open hat (32 steps, swing 50.1%: 0.375 and 0.37525 beats, both tick 180) does not choke it in the loop, as in the WAV events', async () => {
    await playLoopRange([[3, 'openHat'], [2, 'closedHat']], 0, 4, 5, { swing: 50.1, stepsPerBar: 32 });
    const wavOpen = renderScheduleEvents(useStore.getState().project)
      .map((e) => e.payload as { lane?: string; durationBeats?: number })
      .find((p) => p.lane === 'openHat')!;
    expect(wavOpen).not.toHaveProperty('durationBeats');
    const opens = tagged.filter((t) => t.lane === 'openHat');
    expect(opens.length).toBeGreaterThanOrEqual(2);
    for (const { source } of opens) expect(source.stopAt - source.startAt).toBeCloseTo(0.37, 9);
    expect(expectChokedByScheduledClosedHats('same tick', { startBeat: 0, endBeat: 4 })).toBe(0);
  });

  it('seed-fixed fuzz: random loop ranges (fractional ends) and random hits — open hats stop at the scheduled closed hat right after them, and only then', async () => {
    const r = mulberry32(7007);
    let choked = 0;
    let opens = 0;
    for (let trial = 0; trial < 40; trial++) {
      if (trial > 0) {
        // Fresh run for each trial.
        if (useStore.getState().transport.isPlaying) useStore.getState().stop();
        teardown?.();
        teardown = undefined;
        recorded.sources.length = 0;
        tagged = [];
        clock.now = 0;
        fakeContext.current = new FakeContext();
        useStore.getState().createNewProject('テスト');
      }
      const startBeat = [0, 0, 0.5, 1, 1 / 3, 0.0004][Math.floor(r() * 6)]!;
      const endBeat = startBeat + [1, 2, 4, 4.0005, 3.9995, 2.25, 1.0001, 3 + 1 / 3][Math.floor(r() * 8)]!;
      const lanes = ['openHat', 'closedHat', 'closedHat', 'kick'] as const;
      const stepsPerBar = trial % 2 === 0 ? 16 : 32;
      const swing = trial % 3 === 0 ? 0 : 50 + r();
      const hits = Array.from({ length: 3 + Math.floor(r() * 8) }, () => [Math.floor(r() * 2 * stepsPerBar), lanes[Math.floor(r() * 4)]!] as [number, typeof lanes[number]])
        .filter((h, i, all) => all.findIndex((o) => o[0] === h[0] && o[1] === h[1]) === i);
      // An open hat right after a swung closed hat: the two land on the same tick at swing ≈ 50%.
      if (stepsPerBar === 32 && trial % 4 === 1) hits.push([2, 'closedHat'], [3, 'openHat']);
      await playLoopRange(hits, startBeat, endBeat, 6, { swing, stepsPerBar });
      choked += expectChokedByScheduledClosedHats(`trial ${trial} loop ${startBeat}〜${endBeat} swing ${swing}`, { startBeat, endBeat });
      opens += tagged.filter((t) => t.lane === 'openHat').length;
    }
    expect(opens).toBeGreaterThan(60);
    expect(choked).toBeGreaterThan(20);
  });

  it('seed-fixed fuzz without a loop: whether live playback chokes an open hat matches the WAV events (swing 50〜51%, 32 steps)', async () => {
    const r = mulberry32(5051);
    let compared = 0;
    let chokedInWav = 0;
    for (let trial = 0; trial < 30; trial++) {
      if (trial > 0) {
        if (useStore.getState().transport.isPlaying) useStore.getState().stop();
        teardown?.();
        teardown = undefined;
        recorded.sources.length = 0;
        tagged = [];
        clock.now = 0;
        fakeContext.current = new FakeContext();
        useStore.getState().createNewProject('テスト');
      }
      const lanes = ['openHat', 'closedHat', 'closedHat'] as const;
      const hits = Array.from({ length: 4 + Math.floor(r() * 8) }, () => [Math.floor(r() * 64), lanes[Math.floor(r() * 3)]!] as [number, typeof lanes[number]])
        .filter((h, i, all) => all.findIndex((o) => o[0] === h[0] && o[1] === h[1]) === i);
      hits.push([2 + 8 * (trial % 4), 'closedHat'], [3 + 8 * (trial % 4), 'openHat']);
      await playLoopRange(hits, 0, 0, 4.5, { swing: 50 + r(), stepsPerBar: 32, loop: false });
      const wav = renderScheduleEvents(useStore.getState().project)
        .filter((e) => (e.payload as { lane?: string }).lane === 'openHat');
      for (const { source } of tagged.filter((t) => t.lane === 'openHat')) {
        const event = wav.find((e) => Math.abs(e.time - source.startAt) < 1e-9)!;
        const choke = (event.payload as { durationBeats?: number }).durationBeats;
        const wavChoked = choke !== undefined && choke * 0.5 < 0.37;
        expect(source.stopAt - source.startAt < 0.37 - 1e-9, `trial ${trial} open at ${source.startAt}`).toBe(wavChoked);
        if (wavChoked) expect(source.stopAt - source.startAt).toBeCloseTo(choke! * 0.5, 9);
        compared++;
        chokedInWav += Number(wavChoked);
      }
      expect(expectChokedByScheduledClosedHats(`no loop ${trial}`)).toBeGreaterThanOrEqual(0);
    }
    expect(compared).toBeGreaterThan(60);
    expect(chokedInWav).toBeGreaterThan(10);
  });
});
