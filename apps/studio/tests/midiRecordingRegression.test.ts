import { DEFAULT_MAX_PROJECT_JSON_BYTES, encodeProjectJson, validateProject } from '@cts/project-model';
import { MemoryProjectRepository } from '@cts/project-persistence';
import { describe, expect, it, vi } from 'vitest';
import { createStudioStore } from '../src/state/store';
import { feedMidiRecordingEvent, startMidiRecording } from '../src/state/midiRecording';
import { clock, makeProject, melodyClip, off, on, options, runTake, ticksOf } from './acceptance/p42-helpers';

const replacementWarning = '録音中のテイクを先に止めてください';

async function readyStore(clipLengthBeats = 4) {
  const repository = new MemoryProjectRepository(clock);
  const store = createStudioStore(repository);
  expect(await store.getState().replaceProject(makeProject({ clipLengthBeats }))).toBe(true);
  return { repository, store, project: store.getState().project };
}

function captureNote(store: ReturnType<typeof createStudioStore>) {
  const state = store.getState();
  expect(state.startMidiRecording(options(state.project)).ok).toBe(true);
  state.feedMidiRecording(on(60, 0));
  state.feedMidiRecording(off(60, 0.25));
}

describe('MIDI recording recovery', () => {
  it.each(['released', 'held'])('truncates a %s note at the clip end', async (ending) => {
    const { store } = await readyStore();
    captureNote(store);
    store.getState().feedMidiRecording(on(62, 1.75));
    if (ending === 'released') store.getState().feedMidiRecording(off(62, 2.25));
    expect(store.getState().stopMidiRecording({ timeSec: 2.25 })).toMatchObject({ ok: true, droppedCount: 0 });
    const { project } = store.getState();
    expect(validateProject(project).ok).toBe(true);
    expect(ticksOf(melodyClip(project))).toEqual([
      { pitch: 60, startTick: 0, durTick: 240 },
      { pitch: 62, startTick: 1680, durTick: 240 },
    ]);
  });

  it('counts a note with no remaining clip length as outside the clip', () => {
    const project = makeProject({ clipLengthBeats: 4 });
    const result = runTake(project, options(project), [on(60, 2)], 2);
    expect(result.droppedByReason).toEqual({ 'outside-clip': 1 });
  });

  it('drops only the note that fails project validation after truncation', () => {
    const project = makeProject({ clipLengthBeats: 5 / 1920 });
    const result = runTake(project, options(project), [
      on(60, 0), off(60, 1 / 960), on(62, 1 / 960), off(62, 2 / 960),
    ], 2 / 960);
    expect(validateProject(result.project).ok).toBe(true);
    expect(result.droppedByReason).toEqual({ invalid: 1 });
    expect(ticksOf(melodyClip(result.project))).toEqual([{ pitch: 60, startTick: 0, durTick: 1 }]);
  });

  it('keeps the notes that fit the project budget, including linked clip placements', () => {
    const project = makeProject({ clipLengthBeats: 4 });
    const melody = project.tracks.find((track) => track.name === 'Melody')!;
    const clip = melodyClip(project);
    clip.notes = Array.from({ length: 1_999 }, (_, index) => ({
      id: `existing-${index}`, pitch: 48, velocity: 90, startBeat: 0, durationBeats: 0.25,
    }));
    melody.clips.push(...Array.from({ length: 99 }, (_, index) => ({
      ...clip, id: `linked-${index}`, aliasOf: clip.id, notes: undefined,
    })));
    expect(validateProject(project).ok).toBe(true);
    const result = runTake(project, options(project), [
      on(60, 0), off(60, 0.25), on(62, 0.25), off(62, 0.5),
    ], 0.5);
    expect(validateProject(result.project).ok).toBe(true);
    expect(result.droppedByReason).toEqual({ invalid: 1 });
    expect(melodyClip(result.project).notes?.slice(1_999).map((note) => note.pitch)).toEqual([60]);
  });

  it('keeps the take active when stop predates the latest event', async () => {
    const { store } = await readyStore();
    captureNote(store);
    expect(store.getState().stopMidiRecording({ timeSec: 0 })).toMatchObject({
      ok: false, message: expect.stringMatching(/[ぁ-ん]/),
    });
    expect(store.getState().midiRecordingActive).toBe(true);
    expect(store.getState().stopMidiRecording({ timeSec: 0.5 })).toMatchObject({
      ok: true, changed: true,
    });
    expect(ticksOf(melodyClip(store.getState().project))).toHaveLength(1);
  });

  it('keeps the events for retry when commit fails', async () => {
    const { store } = await readyStore();
    captureNote(store);
    store.setState({ projectOperationBusy: true });
    expect(store.getState().stopMidiRecording({ timeSec: 0.5 })).toMatchObject({ ok: false });
    expect(store.getState().midiRecordingActive).toBe(true);
    store.setState({ projectOperationBusy: false });
    expect(store.getState().stopMidiRecording({ timeSec: 0.5 })).toMatchObject({ ok: true, changed: true });
    expect(ticksOf(melodyClip(store.getState().project))).toHaveLength(1);
  });

  it('explains a size-limit failure and discards only the take after a refused switch', async () => {
    const { store } = await readyStore();
    const project = makeProject();
    const melody = project.tracks.find((track) => track.name === 'Melody')!;
    const clip = melodyClip(project);
    const fillers = Array.from({ length: 3 }, (_, group) => ({
      ...clip, id: `filler-${group}`,
      notes: Array.from({ length: 1400 }, (_, index) => ({
        id: `filler-${group}-${index}`, pitch: 48, velocity: 90, startBeat: 0, durationBeats: 0.25,
      })),
    }));
    melody.clips.push(...fillers);
    const base = encodeProjectJson(project);
    if (!base.ok) throw new Error('Invalid size-limit fixture');
    let padding = DEFAULT_MAX_PROJECT_JSON_BYTES - 1 - base.bytes;
    for (const { notes } of fillers) {
      for (const note of notes) {
        const length = Math.min(4000, padding);
        note.id += 'x'.repeat(length);
        padding -= length;
      }
    }
    expect(encodeProjectJson(project)).toMatchObject({ ok: true, bytes: 16_777_215 });
    store.setState({ project });
    const before = store.getState();
    captureNote(store);
    const stopped = before.stopMidiRecording({ timeSec: 0.5 });
    expect(stopped).toMatchObject({ ok: false, message: expect.stringContaining('保存上限') });
    expect(store.getState().midiRecordingActive).toBe(true);
    expect(await before.createNewProject()).toBe(false);
    expect(store.getState().persistenceNotice?.message).toBe(stopped?.ok === false && stopped.message);
    expect(store.getState().persistenceNotice?.message).toContain('このテイクを捨てて録音を終える');
    store.getState().discardMidiRecording();
    expect(store.getState()).toMatchObject({ midiRecordingActive: false });
    for (const key of ['project', 'past', 'future', 'saveState', 'transport'] as const) {
      expect(store.getState()[key]).toBe(before[key]);
    }
    expect(store.getState().setLoopRange(0, 4)).toBe(true);
  });

  it.each(['replace', 'load', 'create'] as const)('saves the outgoing take before %s', async (switchType) => {
    const { store, project, repository } = await readyStore();
    const incoming = makeProject();
    await repository.save({ project: incoming, activationId: 'fixture', revision: 1, writeId: 'seed', expectedHeadVersion: null });
    captureNote(store);
    store.getState().feedMidiRecording(on(62, 1.75));
    store.getState().feedMidiRecording(off(62, 2.25));
    const state = store.getState();
    const switchProject = {
      replace: () => state.replaceProject(incoming),
      load: () => state.loadProjectById(incoming.id),
      create: () => state.createNewProject(),
    }[switchType];
    expect(await switchProject()).toBe(true);
    expect(store.getState().project.id).not.toBe(project.id);
    expect(store.getState().midiRecordingActive).toBe(false);
    const saved = await repository.load(project.id);
    expect(saved.ok && saved.value && ticksOf(melodyClip(saved.value.project))).toEqual([
      { pitch: 60, startTick: 0, durTick: 240 },
      { pitch: 62, startTick: 1680, durTick: 240 },
    ]);
  });

  it('refuses a same-id snapshot while the take is active', async () => {
    const { store, project, repository } = await readyStore();
    captureNote(store);
    expect(await store.getState().replaceProject({ ...project, title: '古いスナップショット' })).toBe(false);
    expect(store.getState().persistenceNotice?.message).toBe(replacementWarning);
    expect(store.getState().midiRecordingActive).toBe(true);
    expect(store.getState().stopMidiRecording({ timeSec: 0.5 })?.ok).toBe(true);
    expect(await store.getState().flushPendingSave()).toBe(true);
    const saved = await repository.load(project.id);
    expect(saved.ok && saved.value && ticksOf(melodyClip(saved.value.project))).toHaveLength(1);
  });

  it.each(['replace', 'load', 'create'] as const)('stops replacement at the last event before %s', async (switchType) => {
    const { store, repository } = await readyStore();
    const project = makeProject({ notes: [{ pitch: 62, startBeat: 2, durationBeats: 0.25 }] });
    const incoming = makeProject();
    expect(await store.getState().replaceProject(project)).toBe(true);
    await repository.save({ project: incoming, activationId: 'fixture', revision: 1, writeId: 'seed', expectedHeadVersion: null });
    const state = store.getState();
    expect(state.startMidiRecording(options(project, { mode: 'replace' }), () => 2).ok).toBe(true);
    state.feedMidiRecording(on(60, 0));
    state.feedMidiRecording(off(60, 0.25));
    const switchProject = {
      replace: () => state.replaceProject(incoming),
      load: () => state.loadProjectById(incoming.id),
      create: () => state.createNewProject(),
    }[switchType];
    expect(await switchProject()).toBe(true);
    const saved = await repository.load(project.id);
    expect(saved.ok && saved.value && ticksOf(melodyClip(saved.value.project))).toEqual([
      { pitch: 60, startTick: 0, durTick: 240 }, { pitch: 62, startTick: 960, durTick: 120 },
    ]);
  });

  it('refuses replacement and keeps the take if its project commit is rejected', async () => {
    const { store, project } = await readyStore();
    captureNote(store);
    const stop = vi.spyOn(store.getState(), 'stopMidiRecording').mockReturnValueOnce({
      ok: false, code: 'invalid-options', message: '録音を反映できませんでした。',
    });
    expect(await store.getState().replaceProject(makeProject())).toBe(false);
    stop.mockRestore();
    expect(store.getState().project).toBe(project);
    expect(store.getState().persistenceNotice?.message).toBe(replacementWarning);
    expect(store.getState().midiRecordingActive).toBe(true);
    expect(store.getState().stopMidiRecording({ timeSec: 0.5 })).toMatchObject({ ok: true, changed: true });
  });

  it('saves the outgoing take before a save retry restores a project', async () => {
    const repository = new MemoryProjectRepository(clock);
    vi.spyOn(repository, 'initialize').mockResolvedValueOnce({
      ok: false, error: { operation: 'initialize', code: 'read-failed', retry: 'manual' },
    });
    const incoming = makeProject();
    await repository.save({ project: incoming, activationId: 'fixture', revision: 1, writeId: 'seed', expectedHeadVersion: null });
    const store = createStudioStore(repository);
    await store.getState().initializePersistence();
    const state = store.getState();
    const outgoing = makeProject({ notes: [{ pitch: 62, startBeat: 2, durationBeats: 0.25 }] });
    outgoing.id = state.project.id;
    store.setState({ project: outgoing });
    expect(state.startMidiRecording(options(outgoing, { mode: 'replace' }), () => 2).ok).toBe(true);
    state.feedMidiRecording(on(60, 0));
    state.feedMidiRecording(off(60, 0.25));
    expect(await store.getState().saveToLocalStorage()).toBe(true);
    expect(store.getState().project.id).toBe(incoming.id);
    expect(store.getState().midiRecordingActive).toBe(false);
    const saved = await repository.load(outgoing.id);
    expect(saved.ok && saved.value && ticksOf(melodyClip(saved.value.project))).toEqual([
      { pitch: 60, startTick: 0, durTick: 240 }, { pitch: 62, startTick: 960, durTick: 120 },
    ]);
  });

  it('allocates note ids beyond ids used by other project entities', () => {
    const project = makeProject();
    project.id = 'midi-recording-1';
    project.tempoMap[0]!.id = 'midi-recording-2';
    const result = runTake(project, options(project), [on(60, 0), off(60, 0.25)], 0.5);
    expect(result.recordedNoteIds).toEqual(['midi-recording-3']);
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('locks loop, punch, and tempo settings until stop', async () => {
    const { store } = await readyStore();
    captureNote(store);
    const state = store.getState();
    expect.soft(state.setLoopRange(0, 4)).toBe(false);
    state.toggleLoop();
    expect.soft(state.setPunchRange(1, 4)).toBe(false);
    expect.soft(state.setPunchRoll(1, 2)).toBe(false);
    state.togglePunch();
    state.setBpm(100);
    expect.soft(store.getState().transport).toBe(state.transport);
    expect(store.getState().project.bpm).toBe(120);

    expect(state.stopMidiRecording({ timeSec: 0.5 })?.ok).toBe(true);
    expect(state.setLoopRange(0, 4)).toBe(true);
    expect(state.setPunchRange(1, 4)).toBe(true);
    state.setBpm(100);
    expect(store.getState().project.bpm).toBe(100);
  });

  it.each([
    { press: 0.59875, tick: 1919, duration: 1 },
    { press: 0.6, tick: 0, duration: 200 },
    { press: 0.60125, tick: 1, duration: 199 },
  ])('assigns a press at $press s to the correct loop pass', ({ press, tick, duration }) => {
    const project = makeProject({ tempoMap: [{ id: 'tempo', beat: 0, bpm: 100 }] });
    project.bpm = 100;
    const result = runTake(project, options(project, {
      startBeat: 3, loop: { startBeat: 0, endBeat: 4 },
    }), [on(60, press), off(60, 0.85)], 0.85);
    expect(ticksOf(melodyClip(result.project))).toEqual([{ pitch: 60, startTick: tick, durTick: duration }]);
  });

  it('includes each tempo segment in the time to the first wrap', () => {
    const project = makeProject({ tempoMap: [
      { id: 'tempo', beat: 0, bpm: 100 },
      { id: 'tempo-change', beat: 3.5, bpm: 75 },
    ] });
    project.bpm = 100;
    const result = runTake(project, options(project, {
      startBeat: 3, loop: { startBeat: 0, endBeat: 4 },
    }), [on(60, 0.7), off(60, 0.82)], 0.82);
    expect(ticksOf(melodyClip(result.project))).toEqual([{ pitch: 60, startTick: 0, durTick: 96 }]);
  });

  it.each([75, 90, 100, 120, 140])('records a press exactly on the first wrap at %i BPM', (bpm) => {
    const project = makeProject({ tempoMap: [{ id: 'tempo', beat: 0, bpm }] });
    project.bpm = bpm;
    const press = 3 * 60 / bpm;
    const release = 3.5 * 60 / bpm;
    const result = runTake(project, options(project, {
      startBeat: 1, loop: { startBeat: 0, endBeat: 4 },
    }), [on(60, press), off(60, release)], release);
    expect(result.droppedCount).toBe(0);
    expect(ticksOf(melodyClip(result.project))).toEqual([{ pitch: 60, startTick: 0, durTick: 240 }]);
  });

  it('folds exact boundary ticks to the next pass across 200 seeded rounds', () => {
    let seed = 0x42;
    const randomInt = (range: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor(seed / 2 ** 32 * range);
    };
    for (let round = 0; round < 200; round += 1) {
      const bpm = 45 + randomInt(156);
      const loopStartTick = randomInt(1920);
      const length = 480 + randomInt(1920);
      const loopEndTick = loopStartTick + length;
      const startTick = loopStartTick + randomInt(length);
      const pass = 1 + randomInt(8);
      const project = makeProject({ tempoMap: [{ id: 'tempo', beat: 0, bpm }] });
      project.bpm = bpm;
      const take = startMidiRecording(project, options(project, {
        startBeat: startTick / 480, loop: { startBeat: loopStartTick / 480, endBeat: loopEndTick / 480 },
      }));
      if (!take.ok) throw new Error(take.message);
      const boundaryTick = loopEndTick - startTick + (pass - 1) * length;
      const fed = feedMidiRecordingEvent(take.session, on(60, boundaryTick * 60 / (480 * bpm)));
      expect({ pass: fed.pass, tick: fed.held.get(60)?.startTick }, `round ${round} at ${bpm} BPM`).toEqual({
        pass, tick: loopStartTick,
      });
    }
  });
});
