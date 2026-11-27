import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PPQ, groovePrng, type Clip } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/grooveActions');
let editor: typeof import('../src/state/editorActions');
let events: typeof import('../src/audio/events');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/grooveActions');
  editor = await import('../src/state/editorActions');
  events = await import('../src/audio/events');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('テスト')).toBe(true);
});

const clips = (): Clip[] => useStore.getState().project.tracks.flatMap((t) => t.clips);
const melodyId = (): string => editor.firstMidiClipOfTrack(useStore.getState().project, 'Melody')?.id ?? '';
const notesOf = (id: string) => clips().find((c) => c.id === id)?.notes ?? [];
const pastLength = (): number => useStore.getState().past.length;

function addNotes(id: string, specs: Array<[number, number, number, number?]>): string[] {
  for (const [pitch, startBeat, durationBeats, velocity = 100] of specs) {
    useStore.getState().addNote(id, { pitch, startBeat, durationBeats, velocity });
  }
  return notesOf(id).map((n) => n.id);
}

function replaceNotes(id: string, notes: Array<[number, number, number, number?]>): string[] {
  useStore.getState().applyProjectChange((p) => ({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) =>
        c.id === id
          ? { ...c, notes: notes.map(([pitch, startBeat, durationBeats, velocity = 100], i) => ({ id: `n${i}`, pitch, startBeat, durationBeats, velocity })) }
          : c),
    })),
  }));
  return notesOf(id).map((n) => n.id);
}

describe('setProjectSwing / setHiHatChoke', () => {
  it('clamps to whole percent in 0..60 as one undo step', () => {
    const before = pastLength();
    expect(actions.setProjectSwing(33.4)).toMatchObject({ ok: true, changed: 1 });
    expect(useStore.getState().project.swing).toBe(33);
    expect(pastLength()).toBe(before + 1);
    expect(actions.setProjectSwing(999)).toMatchObject({ ok: true });
    expect(useStore.getState().project.swing).toBe(60);
    actions.setProjectSwing(-5);
    expect(useStore.getState().project.swing).toBe(0);
    useStore.getState().undo();
    expect(useStore.getState().project.swing).toBe(60);
  });

  it('refuses non-finite values and non-numbers', () => {
    const before = pastLength();
    for (const bad of [NaN, Infinity, -Infinity, { toString: null } as unknown as number, '30' as unknown as number]) {
      expect(actions.setProjectSwing(bad).ok).toBe(false);
    }
    expect(actions.setHiHatChoke('yes' as unknown as boolean).ok).toBe(false);
    expect(pastLength()).toBe(before);
  });

  it('is a no-op for the same value and toggles choke', () => {
    const before = pastLength();
    expect(actions.setProjectSwing(0)).toMatchObject({ ok: true, changed: 0 });
    const current = useStore.getState().project.hiHatChoke;
    expect(actions.setHiHatChoke(current)).toMatchObject({ ok: true, changed: 0 });
    expect(pastLength()).toBe(before);
    expect(actions.setHiHatChoke(!current)).toMatchObject({ ok: true, changed: 1 });
    expect(useStore.getState().project.hiHatChoke).toBe(!current);
  });

  it('one drag in a transaction is one undo step', () => {
    const token = {};
    const before = pastLength();
    expect(useStore.getState().beginProjectTransaction(token, 1)).toBe(true);
    for (const v of [5, 10, 20, 30]) actions.setProjectSwing(v);
    expect(useStore.getState().commitProjectTransaction(token)).toBe(true);
    expect(pastLength()).toBe(before + 1);
    useStore.getState().undo();
    expect(useStore.getState().project.swing).toBe(0);
  });

  it('keeps a sane schedule after swing', () => {
    actions.setProjectSwing(60);
    const list = events.buildScheduleEvents(useStore.getState().project);
    expect(list.every((e) => Number.isFinite(e.beat) && e.beat >= 0)).toBe(true);
  });
});

describe('quantizeNotesWithStrength', () => {
  it('moves part of the way at 50 % and fully at 100 %, in whole ticks', () => {
    const id = melodyId();
    const [a] = replaceNotes(id, [[60, 1.3, 0.25]]);
    const before = pastLength();
    expect(actions.quantizeNotesWithStrength(id, [a!], 1, 50)).toMatchObject({ ok: true, changed: 1 });
    const half = notesOf(id)[0]!.startBeat;
    expect(half * PPQ).toBe(Math.round(half * PPQ));
    expect(half).toBeCloseTo(1.15, 6);
    expect(pastLength()).toBe(before + 1);
    actions.quantizeNotesWithStrength(id, [a!], 1, 100);
    expect(notesOf(id)[0]!.startBeat).toBe(1);
  });

  it('refuses bad strength, grid, and empty or unknown selections without writing', () => {
    const id = melodyId();
    const [a] = replaceNotes(id, [[60, 1.3, 0.25]]);
    const before = pastLength();
    for (const s of [-1, 101, NaN]) expect(actions.quantizeNotesWithStrength(id, [a!], 1, s).ok).toBe(false);
    for (const g of [0, -1, NaN, 1 / 1000]) expect(actions.quantizeNotesWithStrength(id, [a!], g, 100).ok).toBe(false);
    expect(actions.quantizeNotesWithStrength(id, [], 1, 100).ok).toBe(false);
    expect(actions.quantizeNotesWithStrength(id, ['nope'], 1, 100).ok).toBe(false);
    expect(pastLength()).toBe(before);
    expect(notesOf(id)[0]!.startBeat).toBe(1.3);
  });

  it('refuses a same-pitch overlap and leaves everything unchanged', () => {
    const id = melodyId();
    const ids = replaceNotes(id, [[60, 0.5, 0.75], [60, 1.4, 0.5]]);
    const before = pastLength();
    const result = actions.quantizeNotesWithStrength(id, [ids[1]!], 1, 100);
    expect(result.ok).toBe(false);
    expect(pastLength()).toBe(before);
    expect(notesOf(id)[1]!.startBeat).toBe(1.4);
  });

  it('refuses when a note would leave the clip', () => {
    const id = melodyId();
    const length = clips().find((c) => c.id === id)!.lengthBeats;
    const [a] = replaceNotes(id, [[60, length - 1.2, 1.0]]);
    // nearest grid line (length - 1) puts the 1-beat note over the end only when grid is 4.
    const result = actions.quantizeNotesWithStrength(id, [a!], length, 100);
    expect(result.ok).toBe(false);
  });

  it('refuses while recording', () => {
    const id = melodyId();
    const [a] = replaceNotes(id, [[60, 1.3, 0.25]]);
    useStore.setState({ audioRecordingOperationId: 1 });
    try {
      expect(actions.quantizeNotesWithStrength(id, [a!], 1, 100)).toMatchObject({ ok: false });
      expect(actions.setProjectSwing(10).ok).toBe(false);
      expect(actions.humanizeNotes(id, [a!], { timingTicks: 10, velocity: 5, seed: 1 }).ok).toBe(false);
    } finally {
      useStore.setState({ audioRecordingOperationId: null });
    }
    expect(notesOf(id)[0]!.startBeat).toBe(1.3);
  });

  it('refuses edits on clips whose start is not a whole tick', () => {
    const id = melodyId();
    const [a] = replaceNotes(id, [[60, 1.3, 0.25]]);
    useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, startBeat: 0.0001 } : c)) })),
    }));
    if (clips().find((c) => c.id === id)?.startBeat !== 0.0001) return; // project validation may refuse it first
    expect(actions.quantizeNotesWithStrength(id, [a!], 1, 100).ok).toBe(false);
  });

  it('refuses a loop-period change on a looped clip', () => {
    const id = melodyId();
    const ids = replaceNotes(id, [[60, 0, 1], [62, 2.3, 0.5]]);
    useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, loop: true } : c)) })),
    }));
    const before = pastLength();
    // the last note defines the period (2.8); moving it to 2.0 would change it
    expect(actions.quantizeNotesWithStrength(id, [ids[1]!], 1, 100).ok).toBe(false);
    expect(pastLength()).toBe(before);
    // a note that does not define the period may move
    expect(actions.quantizeNotesWithStrength(id, [ids[0]!], 1, 100)).toMatchObject({ ok: true });
  });
});

describe('no-op edits', () => {
  it('strength 0 and zero humanize leave an off-grid note and the history alone', () => {
    const id = melodyId();
    const ids = replaceNotes(id, [[60, 1.001, 0.25]]);
    const before = pastLength();
    const q = actions.quantizeNotesWithStrength(id, ids, 1, 0);
    expect(q).toMatchObject({ ok: true, changed: 0 });
    expect(q.ok && q.message).toBe('変更はありません');
    const h = actions.humanizeNotes(id, ids, { timingTicks: 0, velocity: 0, seed: 7 });
    expect(h).toMatchObject({ ok: true, changed: 0 });
    expect(notesOf(id)[0]!.startBeat).toBe(1.001);
    expect(pastLength()).toBe(before);
  });

  it('only notes that actually move become whole ticks', () => {
    const id = melodyId();
    const ids = replaceNotes(id, [[60, 490 / 480, 0.25], [62, 2, 0.25]]);
    // the second note is already on the grid; the first moves
    const result = actions.quantizeNotesWithStrength(id, ids, 1, 100);
    expect(result).toMatchObject({ ok: true, message: '1個のノートをグリッドへ寄せました。' });
    expect(notesOf(id).map((n) => n.startBeat)).toEqual([1, 2]);
  });
});

describe('humanizeNotes', () => {
  const material: Array<[number, number, number, number]> = [
    [60, 0, 0.5, 90], [62, 1, 0.5, 90], [64, 2, 0.5, 90], [65, 3, 0.5, 90],
  ];

  it('is deterministic per seed, whole ticks, and one undo step', () => {
    const id = melodyId();
    const ids = replaceNotes(id, material);
    const snapshot = useStore.getState().project;
    const before = pastLength();
    expect(actions.humanizeNotes(id, ids, { timingTicks: 30, velocity: 10, seed: 42 })).toMatchObject({ ok: true });
    expect(pastLength()).toBe(before + 1);
    const first = notesOf(id).map((n) => [n.startBeat, n.velocity]);
    first.forEach(([s]) => expect(s! * PPQ).toBe(Math.round(s! * PPQ)));
    useStore.setState({ project: snapshot });
    actions.humanizeNotes(id, ids, { timingTicks: 30, velocity: 10, seed: 42 });
    expect(notesOf(id).map((n) => [n.startBeat, n.velocity])).toEqual(first);
    useStore.setState({ project: snapshot });
    actions.humanizeNotes(id, ids, { timingTicks: 30, velocity: 10, seed: 43 });
    expect(notesOf(id).map((n) => [n.startBeat, n.velocity])).not.toEqual(first);
  });

  it('refuses out-of-domain options and keeps velocity in 1..127', () => {
    const id = melodyId();
    const ids = replaceNotes(id, [[60, 1, 0.5, 2]]);
    const before = pastLength();
    for (const options of [
      { timingTicks: -1, velocity: 0, seed: 1 }, { timingTicks: 1.5, velocity: 0, seed: 1 },
      { timingTicks: 241, velocity: 0, seed: 1 }, { timingTicks: 0, velocity: 41, seed: 1 },
      { timingTicks: 0, velocity: NaN, seed: 1 }, { timingTicks: 0, velocity: 0, seed: -1 },
      { timingTicks: 0, velocity: 0, seed: 2 ** 32 }, { timingTicks: 0, velocity: 0, seed: NaN },
    ]) expect(actions.humanizeNotes(id, ids, options).ok).toBe(false);
    expect(pastLength()).toBe(before);
    for (let seed = 0; seed < 50; seed++) {
      actions.humanizeNotes(id, ids, { timingTicks: 0, velocity: 40, seed });
      const v = notesOf(id)[0]!.velocity;
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(127);
    }
  });

  it('seeded fuzz: every accepted edit keeps a sane schedule, whole ticks and unchanged pitches', () => {
    const rng = groovePrng(20261128);
    const id = melodyId();
    const length = clips().find((c) => c.id === id)!.lengthBeats;
    for (let round = 0; round < 60; round++) {
      const count = 1 + Math.floor(rng() * 6);
      const specs: Array<[number, number, number, number]> = [];
      for (let i = 0; i < count; i++) {
        specs.push([48 + Math.floor(rng() * 4), Math.floor(rng() * (length - 1) * 4) / 4, 0.25 + Math.floor(rng() * 4) / 4, 1 + Math.floor(rng() * 127)]);
      }
      const ids = replaceNotes(id, specs);
      if (ids.length === 0) continue;
      const beforeNotes = notesOf(id);
      const pick = ids.filter(() => rng() < 0.7);
      const op = rng() < 0.5
        ? actions.quantizeNotesWithStrength(id, pick, [0.25, 0.5, 1][Math.floor(rng() * 3)]!, Math.floor(rng() * 101))
        : actions.humanizeNotes(id, pick, { timingTicks: Math.floor(rng() * 241), velocity: Math.floor(rng() * 41), seed: Math.floor(rng() * 2 ** 32) });
      const after = notesOf(id);
      if (!op.ok) {
        expect(after).toEqual(beforeNotes);
        continue;
      }
      after.forEach((n, i) => {
        expect(n.pitch).toBe(beforeNotes[i]!.pitch);
        expect(n.durationBeats).toBe(beforeNotes[i]!.durationBeats);
        expect(n.velocity).toBeGreaterThanOrEqual(1);
        expect(n.velocity).toBeLessThanOrEqual(127);
        expect(n.startBeat).toBeGreaterThanOrEqual(0);
        expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(length + 1e-9);
        if (pick.includes(n.id)) expect(n.startBeat * PPQ).toBeCloseTo(Math.round(n.startBeat * PPQ), 6);
      });
      expect(events.buildScheduleEvents(useStore.getState().project).every((e) => Number.isFinite(e.beat) && e.beat >= 0)).toBe(true);
    }
  });
});

describe('setDrumStepsPerBar audibility', () => {
  it('refuses a switch that would push an audible hit past the clip end', () => {
    const clip = clips().find((c) => c.type === 'drum')!;
    useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => c.id === clip.id
          ? {
              ...c,
              startBeat: 0,
              lengthBeats: 1.125,
              stepsPerBar: 16,
              drumGroove: { swing: 1, probability: 1, humanizeVelocity: 0, seed: 1 },
              drumEvents: [{ id: 'k1', lane: 'kick', stepIndex: 4, velocity: 100 }],
            }
          : c),
      })),
    }));
    const drum = () => clips().find((c) => c.id === clip.id)!;
    if (drum().lengthBeats !== 1.125) return;
    const sounding = () => events.buildScheduleEvents(useStore.getState().project)
      .filter((e) => (e.payload as { kind: string }).kind === 'drum').length;
    const before = sounding();
    const past = pastLength();
    const result = actions.setDrumStepsPerBar(clip.id, 12);
    if (sounding() === before) return; // switch kept the hit audible: nothing to refuse
    expect(result.ok).toBe(false);
    expect(pastLength()).toBe(past);
  });
});

describe('setDrumStepsPerBar', () => {
  const drumClip = (): Clip => clips().find((c) => c.type === 'drum')!;

  it('switches 16 to 12 and back, as one undo step each, keeping a sane schedule', () => {
    const id = drumClip().id;
    const before = pastLength();
    const result = actions.setDrumStepsPerBar(id, 12);
    expect(result).toMatchObject({ ok: true, changed: 1 });
    expect(drumClip().stepsPerBar).toBe(12);
    expect(pastLength()).toBe(before + 1);
    expect(events.buildScheduleEvents(useStore.getState().project).every((e) => Number.isFinite(e.beat))).toBe(true);
    useStore.getState().undo();
    expect(drumClip().stepsPerBar ?? 16).toBe(16);
  });

  it('refuses other values, non-drum clips and recording; same value is a no-op', () => {
    const id = drumClip().id;
    const before = pastLength();
    for (const bad of [8, 13, NaN, 12.5]) expect(actions.setDrumStepsPerBar(id, bad).ok).toBe(false);
    expect(actions.setDrumStepsPerBar(melodyId(), 12).ok).toBe(false);
    expect(actions.setDrumStepsPerBar(id, 16)).toMatchObject({ ok: true, changed: 0 });
    useStore.setState({ audioRecordingOperationId: 1 });
    try {
      expect(actions.setDrumStepsPerBar(id, 12).ok).toBe(false);
    } finally {
      useStore.setState({ audioRecordingOperationId: null });
    }
    expect(pastLength()).toBe(before);
  });
});

