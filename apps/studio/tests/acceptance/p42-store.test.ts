// P42 acceptance tests (MIDI recording, store integration). Written BEFORE the implementation; do not edit.
//
// CONTRACT, store part (apps/studio/src/state/store.ts; the pure part and the shared vocabulary are in
// p42-capture.test.ts and src/state/midiRecording.ts).
//   state   midiRecordingActive: boolean            (runtime only, never serialized into the Project)
//   startMidiRecording(opts) -> { ok: true, session } | { ok: false, code, message }
//       Same options and refusal codes as the pure startMidiRecording on the CURRENT project, plus the lock
//       refusals 'audio-recording-active' (audioRecordingOperationId !== null), 'midi-recording-active'
//       and 'project-busy' (projectOperationBusy or a local-data erase). On success it first commits any
//       open project transaction (like tryBeginAudioRecordingOperation) and takes the recording lock.
//   feedMidiRecording(event) -> void                (ignored when no take is active)
//   stopMidiRecording({ timeSec }) -> MidiRecordingStopped | null   (null when no take is active)
//       Releases the lock and, when `changed`, commits the resulting project as exactly ONE undo step
//       (one `past` entry, future cleared, one autosave). When not `changed` there is no undo step.
// While the lock is held: every project edit (e.g. setTitle), undo, redo, beginProjectTransaction and
//   tryBeginAudioRecordingOperation are rejected without changing project/past/future (same as during an
//   audio recording). Project replacement (replaceProject / loadProjectById / createNewProject) does not
//   fail: the take is committed FIRST into the project that was recorded on, as one undo step, with stop time
//   = timeSec of the last event fed (the start of the take if none), then the lock is released and the
//   replacement proceeds. The incoming project never receives the take.
// RULINGS (Fable acceptance, accepted deviations):
//   (b) After a FAILED stop (commit refused) the take and the lock remain. The user may choose an explicit,
//       confirmed action 「このテイクを捨てて録音を終える」, which discards only the take and releases the lock.
//   (d) Replacing with the SAME project id during a take is refused with the message
//       「録音中のテイクを先に止めてください」 and the take is kept (lock still held).
//   (e) A forced finalize (replace, load, new, save-retry, pagehide) stops at the last fed event's timeSec.
import { MemoryProjectRepository } from '@cts/project-persistence';
import { describe, expect, it } from 'vitest';
import { createStudioStore } from '../../src/state/store';
import { clock, makeProject, melodyClip, off, on, options, ticksOf } from './p42-helpers';

async function readyStore(spec: Parameters<typeof makeProject>[0] = {}) {
  const repository = new MemoryProjectRepository(clock);
  const store = createStudioStore(repository);
  expect(await store.getState().replaceProject(makeProject(spec))).toBe(true);
  const project = store.getState().project;
  return { repository, store, project, clipId: melodyClip(project).id };
}

describe('P42 MIDI recording (store)', () => {
  it('record_start_takesRecordingLock_editsAndUndoRejected', async () => {
    const { store, project, clipId } = await readyStore();
    store.getState().setTitle('録音前の編集'); // gives undo something to undo
    const beforeProject = store.getState().project;
    const beforePast = store.getState().past;
    expect(beforePast.length).toBeGreaterThan(0);

    const started = store.getState().startMidiRecording(options(project, { clipId }));
    expect(started.ok).toBe(true);
    expect(store.getState().midiRecordingActive).toBe(true);

    store.getState().setTitle('録音中の編集');
    store.getState().undo();
    store.getState().redo();
    expect(store.getState().beginProjectTransaction({}, 1)).toBe(false);
    expect(store.getState().tryBeginAudioRecordingOperation()).toBeNull();
    expect(store.getState().project).toBe(beforeProject);
    expect(store.getState().past).toBe(beforePast);

    expect(store.getState().stopMidiRecording({ timeSec: 0 })).not.toBeNull();
    expect(store.getState().midiRecordingActive).toBe(false);
    store.getState().setTitle('録音後の編集');
    expect(store.getState().project.title).toBe('録音後の編集');
  });

  it('record_whileAudioRecordingActive_isRejected', async () => {
    const { store, project, clipId } = await readyStore();
    const operationId = store.getState().tryBeginAudioRecordingOperation();
    expect(operationId).not.toBeNull();

    const refused = store.getState().startMidiRecording(options(project, { clipId }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('audio-recording-active');
      expect(refused.message).toMatch(/[぀-ヿ一-鿿]/);
    }
    expect(store.getState().midiRecordingActive).toBe(false);

    store.getState().finishAudioRecordingOperation(operationId!);
    expect(store.getState().startMidiRecording(options(project, { clipId })).ok).toBe(true);
  });

  it('record_midiTakeActive_audioRecordingAndSecondTakeAreRejected', async () => {
    // The reverse direction of record_whileAudioRecordingActive_isRejected.
    const { store, project, clipId } = await readyStore();
    expect(store.getState().startMidiRecording(options(project, { clipId })).ok).toBe(true);
    expect(store.getState().tryBeginAudioRecordingOperation()).toBeNull();
    expect(store.getState().audioRecordingOperationId).toBeNull();
    const second = store.getState().startMidiRecording(options(project, { clipId }));
    expect(second.ok ? 'ok' : second.code).toBe('midi-recording-active');
  });

  it('record_stop_commitsOneUndoStep', async () => {
    const { store, project, clipId } = await readyStore({ notes: [{ pitch: 48, startBeat: 8, durationBeats: 1 }] });
    const originalNotes = structuredClone(melodyClip(project).notes);
    const pastBefore = store.getState().past.length;

    expect(store.getState().startMidiRecording(options(project, { clipId })).ok).toBe(true);
    for (const event of [on(60, 0.5), off(60, 1.0), on(64, 1.0), off(64, 1.5), on(67, 1.5), off(67, 2.0)]) {
      store.getState().feedMidiRecording(event);
    }
    const stopped = store.getState().stopMidiRecording({ timeSec: 2.0 });
    expect(stopped?.ok).toBe(true);

    expect(store.getState().past).toHaveLength(pastBefore + 1);
    expect(ticksOf(melodyClip(store.getState().project))).toEqual([
      { pitch: 60, startTick: 480, durTick: 480 },
      { pitch: 64, startTick: 960, durTick: 480 },
      { pitch: 67, startTick: 1440, durTick: 480 },
      { pitch: 48, startTick: 3840, durTick: 480 },
    ]);

    store.getState().undo();
    expect(store.getState().past).toHaveLength(pastBefore);
    expect(melodyClip(store.getState().project).notes).toEqual(originalNotes);
    expect(store.getState().canRedo()).toBe(true);
    store.getState().redo();
    expect(melodyClip(store.getState().project).notes).toHaveLength(4);
  });

  it('record_projectReplacedDuringTake_commitsTakeFirst', async () => {
    const { repository, store, project, clipId } = await readyStore();
    const recordedProjectId = project.id;
    expect(store.getState().startMidiRecording(options(project, { clipId })).ok).toBe(true);
    for (const event of [on(60, 0.5), off(60, 1.0)]) store.getState().feedMidiRecording(event); // ticks 480, len 480

    const incoming = makeProject();
    incoming.id = 'p42-incoming-project';
    incoming.title = '次の曲';
    expect(await store.getState().replaceProject(incoming)).toBe(true);

    expect(store.getState().midiRecordingActive).toBe(false);
    expect(store.getState().project.id).toBe(incoming.id);
    expect(melodyClip(store.getState().project).notes).toEqual([]); // the take did not leak into the new song

    await store.getState().flushPendingSave();
    const saved = await repository.load(recordedProjectId);
    expect(saved.ok).toBe(true);
    if (!saved.ok || !saved.value) throw new Error('the recorded project was not saved');
    expect(ticksOf(melodyClip(saved.value.project))).toEqual([{ pitch: 60, startTick: 480, durTick: 480 }]);
  });

  it('record_extra_emptyTake_addsNoUndoStep', async () => {
    const { store, project, clipId } = await readyStore();
    const pastBefore = store.getState().past.length;
    expect(store.getState().startMidiRecording(options(project, { clipId })).ok).toBe(true);
    const stopped = store.getState().stopMidiRecording({ timeSec: 1.0 });
    expect(stopped?.ok && stopped.changed).toBe(false);
    expect(store.getState().past).toHaveLength(pastBefore);
    expect(store.getState().midiRecordingActive).toBe(false);
  });

  it('record_extra_stopWithoutTake_returnsNull', async () => {
    const { store } = await readyStore();
    expect(store.getState().stopMidiRecording({ timeSec: 0 })).toBeNull();
  });
});
