import { projectToMidi } from '@cts/midi-io';
import {
  isDrumPayload,
  PPQ,
  type Clip,
  type Project,
  validateProject,
} from '@cts/project-model';
import { beforeAll, expect, it, vi } from 'vitest';
import { checkSplitParity } from '../src/audio/clipSplitParity';
import { buildScheduleEvents } from '../src/audio/events';
import { createProjectMusicalTime } from '../src/audio/musicalTime';
import { nextEventsInWindow } from '../src/audio/scheduler';
import { installLocalStorage } from './localStorageStub';

let createStudioStore: typeof import('../src/state/store')['createStudioStore'];

beforeAll(async () => {
  installLocalStorage();
  ({ createStudioStore } = await import('../src/state/store'));
});

function fixture(base: Project, round: number, random: () => number) {
  const mode = round % 9;
  const startBeat = random() < 0.5 ? 0 : 1;
  const triplet = mode === 0;
  const cut = triplet ? 2 / 3 : 2 + (random() < 0.5 ? 0 : 0.5);
  const velocity = () => 70 + Math.floor(random() * 40);
  const melody = base.tracks.find((track) => track.name === 'Melody')!;
  const drums = base.tracks.find((track) => track.type === 'drum')!;
  const source: Clip = {
    id: 'split-midi', trackId: melody.id, type: 'midi', startBeat, lengthBeats: 6,
    loop: mode === 3,
    notes: triplet ? [{ id: 'early', pitch: 60, startBeat: 0, durationBeats: 0.25, velocity: velocity() }] : [
      { id: 'early', pitch: 60, startBeat: cut - 0.5, durationBeats: mode === 2 ? 1 : 0.25, velocity: velocity() },
      { id: 'late', pitch: 64, startBeat: cut + 0.5, durationBeats: 0.5, velocity: velocity() },
    ],
  };
  const alias: Clip = {
    id: 'alias', trackId: melody.id, type: 'midi', startBeat: 10, lengthBeats: 6,
    loop: random() < 0.5, aliasOf: 'other',
  };
  const other: Clip = {
    ...source, id: 'other', startBeat: 4, loop: false,
    notes: [{ id: 'loop-note', pitch: 65, startBeat: 0, durationBeats: 1.5, velocity: velocity() }],
  };
  const drum: Clip = {
    id: 'split-drums', trackId: drums.id, type: 'drum', startBeat, lengthBeats: 6, loop: false,
    drumGroove: { probability: 0.75, humanizeVelocity: 5, seed: 42, swing: random() < 0.5 ? 0 : 0.3 },
    drumEvents: [
      { id: 'hat', lane: 'openHat', stepIndex: 1, velocity: velocity() },
      { id: 'closed', lane: 'closedHat', stepIndex: mode === 7 ? 14 : 3, velocity: velocity() },
    ],
  };
  const project: Project = {
    ...base,
    swing: random() < 0.5 ? 0 : 50,
    hiHatChoke: random() < 0.5,
    tempoMap: [
      ...base.tempoMap,
      { id: 'fuzz-tempo-early', beat: 160 / PPQ, bpm: round % 2 === 0 ? 90 : 112.5 },
      { id: 'fuzz-tempo-late', beat: 3200 / PPQ, bpm: round % 2 === 0 ? 140 : 100 },
    ],
    tracks: base.tracks.map((track) => {
      if (track === melody) return { ...track, clips: [source, other, alias] };
      if (track === drums) return { ...track, clips: [drum, {
        ...drum, id: 'drums-extra', startBeat: 8,
        drumEvents: [{ id: 'kick', lane: 'kick', stepIndex: 0, velocity: velocity() }],
      }] };
      return track;
    }),
  };
  if (mode === 4) return { project, clipId: other.id, at: 5.5 };
  if (mode === 5) return { project, clipId: alias.id, at: 12 };
  if (mode === 6 || mode === 7) return { project, clipId: drum.id, at: startBeat + cut };
  return { project, clipId: source.id, at: mode === 8 ? startBeat + cut + 1 / 960 : startBeat + cut };
}

function heardOnPasses(project: Project, looping: boolean): string[] {
  const events = buildScheduleEvents(project);
  return nextEventsInWindow(
    events, 0, looping ? 64 : 16, createProjectMusicalTime(project).tempo, 0, 0, looping ? { startBeat: 0, endBeat: 16 } : null,
  ).map(({ beat, time, payload }) => {
    if (isDrumPayload(payload)) {
      const { trackId, lane, velocity, voiceSeed } = payload;
      const choke = 'chokedAtBeat' in payload ? payload.chokedAtBeat : undefined;
      return JSON.stringify([beat, time, trackId, lane, velocity, voiceSeed, choke]);
    }
    return JSON.stringify([beat, time, payload]);
  }).sort();
}

it('keeps exact scheduled sounds and MIDI bytes or leaves the project and both history stacks intact (300 seeded rounds)', () => {
  vi.useFakeTimers();
  try {
    const store = createStudioStore();
    const base = store.getState().project;
    let seed = 0x320011;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const accepted = new Map<string, number>();
    const refused = new Set<string>();
    for (let round = 0; round < 300; round += 1) {
      const { project, clipId, at } = fixture(base, round, random);
      expect(validateProject(project).ok, `round ${round}`).toBe(true);
      const past = [base];
      const future = [base];
      store.setState({ project, past, future });
      const before = store.getState();
      const result = before.splitClipAtBeat(clipId, at);
      const after = store.getState();
      if (round % 9 === 0) expect(result.ok, `triplet round ${round}`).toBe(true);
      expect(after.isProjectTransactionOpen()).toBe(false);
      if (result.ok) {
        accepted.set(clipId, (accepted.get(clipId) ?? 0) + 1);
        expect(heardOnPasses(after.project, false)).toEqual(heardOnPasses(project, false));
        expect(heardOnPasses(after.project, true)).toEqual(heardOnPasses(project, true));
        expect(projectToMidi(after.project)).toEqual(projectToMidi(project));
        expect(after.past).toEqual([base, project]);
        expect(after.future).toEqual([]);
        expect(after.saveState.revision).toBe(before.saveState.revision + 1);
      } else {
        refused.add(result.code);
        expect(result.project).toBe(project);
        expect(after.project).toBe(project);
        expect(after.past).toBe(past);
        expect(after.future).toBe(future);
        expect(after.saveState).toBe(before.saveState);
      }
    }
    expect(accepted.get('split-midi')).toBeGreaterThan(30);
    expect(accepted.get('split-drums')).toBeGreaterThan(20);
    expect(refused).toEqual(new Set([
      'split-crossing-note', 'split-linked-clip', 'split-looping-clip',
      'split-invalid-position', 'split-sound-changed',
    ]));
  } finally {
    vi.useRealTimers();
  }
});

it('uses the same recording lock and refuses to join another undo transaction', () => {
  const store = createStudioStore();
  const { project } = store.getState();
  const target = project.tracks.find((track) => track.name === 'Melody')!.clips[0]!;
  const operation = store.getState().tryBeginAudioRecordingOperation();
  expect(operation).not.toBeNull();
  const locked = store.getState();
  expect(locked.splitClipAtBeat(target.id, 4)).toMatchObject({ ok: false, code: 'split-recording' });
  expect(store.getState()).toBe(locked);
  locked.finishAudioRecordingOperation(operation!);

  const token = {};
  expect(store.getState().beginProjectTransaction(token, 3)).toBe(true);
  const editing = store.getState();
  expect(editing.splitClipAtBeat(target.id, 4)).toMatchObject({ ok: false, code: 'split-project-unavailable' });
  expect(store.getState()).toBe(editing);
  expect(editing.ownsProjectTransaction(token, 3)).toBe(true);
  editing.cancelProjectTransaction(token);
});

it('checks the MIDI bytes even when the schedule is identical', () => {
  const { project } = createStudioStore().getState();
  const { id } = project.tracks.find((track) => track.name === 'Melody')!.clips[0]!;
  expect(checkSplitParity(project, { ...project, title: 'different MIDI metadata' }, {
    clipId: id, rightClipId: 'right-clip',
  })).toBe('split-midi-changed');
});
