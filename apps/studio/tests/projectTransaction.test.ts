import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';

// The store reads localStorage at module-import time, so install the stub first.
let useStore: typeof import('../src/state/store')['useStore'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
});

beforeEach(async () => {
  useStore.getState().finalizeProjectTransaction();
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('取引テスト')).toBe(true);
});

function firstTrack() {
  const track = useStore.getState().project.tracks.find((t) => t.type !== 'master');
  if (!track) throw new Error('fixture track missing');
  return track;
}

function volumeOf(trackId: string): number | undefined {
  return useStore.getState().project.tracks.find((t) => t.id === trackId)?.volume;
}

describe('project gesture transactions', () => {
  it('turns one drag of many edits into exactly one Undo step', () => {
    const track = firstTrack();
    const before = track.volume;
    const owner = {};
    const pastBefore = useStore.getState().past.length;

    expect(useStore.getState().beginProjectTransaction(owner, 1)).toBe(true);
    for (const v of [0.2, 0.3, 0.4, 0.5]) useStore.getState().setTrackVolume(track.id, v);
    expect(volumeOf(track.id)).toBe(0.5);
    expect(useStore.getState().past).toHaveLength(pastBefore);
    expect(useStore.getState().commitProjectTransaction(owner)).toBe(true);

    expect(useStore.getState().past).toHaveLength(pastBefore + 1);
    useStore.getState().undo();
    expect(volumeOf(track.id)).toBe(before);
    useStore.getState().redo();
    expect(volumeOf(track.id)).toBe(0.5);
  });

  it('cancel restores the pre-gesture project and records no history or save', () => {
    const track = firstTrack();
    const before = useStore.getState().project;
    const revision = useStore.getState().saveState.revision;
    const owner = {};

    useStore.getState().beginProjectTransaction(owner, 1);
    useStore.getState().setTrackVolume(track.id, 0.25);
    useStore.getState().setTrackVolume(track.id, 0.35);
    expect(useStore.getState().cancelProjectTransaction(owner)).toBe(true);

    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().future).toHaveLength(0);
    expect(useStore.getState().saveState.revision).toBe(revision);
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
  });

  it('a gesture with no net change adds no Undo step', () => {
    const track = firstTrack();
    const owner = {};
    useStore.getState().beginProjectTransaction(owner, 1);
    expect(useStore.getState().commitProjectTransaction(owner)).toBe(true);
    expect(useStore.getState().past).toHaveLength(0);
    expect(volumeOf(track.id)).toBe(track.volume);
  });

  it('autosave is scheduled only on commit, never mid-gesture', () => {
    const track = firstTrack();
    const revision = useStore.getState().saveState.revision;
    const owner = {};

    useStore.getState().beginProjectTransaction(owner, 1);
    useStore.getState().setTrackVolume(track.id, 0.6);
    useStore.getState().setTrackVolume(track.id, 0.7);
    expect(useStore.getState().saveState.revision).toBe(revision);

    useStore.getState().commitProjectTransaction(owner);
    expect(useStore.getState().saveState.revision).toBe(revision + 1);
    expect(useStore.getState().saveState.phase).toBe('pending');
  });

  it('an explicit save mid-gesture persists the pre-gesture project', async () => {
    const track = firstTrack();
    const before = track.volume;
    const projectId = useStore.getState().project.id;
    const owner = {};

    useStore.getState().beginProjectTransaction(owner, 1);
    useStore.getState().setTrackVolume(track.id, 0.15);
    expect(await useStore.getState().saveToLocalStorage()).toBe(true);
    expect(volumeOf(track.id)).toBe(0.15);

    // Re-opening from storage also proves the switch drops the open gesture.
    expect(await useStore.getState().loadProjectById(projectId)).toBe(true);
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(volumeOf(track.id)).toBe(before);
  });

  it('never applies a transaction left open across a project switch', async () => {
    const track = firstTrack();
    const owner = {};
    useStore.getState().beginProjectTransaction(owner, 1);
    useStore.getState().setTrackVolume(track.id, 0.05);

    expect(await useStore.getState().createNewProject('次の曲')).toBe(true);
    const switched = useStore.getState().project;
    expect(useStore.getState().commitProjectTransaction(owner)).toBe(false);
    expect(useStore.getState().cancelProjectTransaction(owner)).toBe(false);
    expect(useStore.getState().project).toBe(switched);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('Undo during a gesture commits it first, so Undo lands on a whole step', () => {
    const track = firstTrack();
    const before = track.volume;
    const owner = {};
    useStore.getState().beginProjectTransaction(owner, 1);
    useStore.getState().setTrackVolume(track.id, 0.9);
    useStore.getState().setTrackVolume(track.id, 1.1);

    useStore.getState().undo();
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(volumeOf(track.id)).toBe(before);
    expect(useStore.getState().future).toHaveLength(1);
    // The released owner can no longer close anything.
    expect(useStore.getState().commitProjectTransaction(owner)).toBe(false);
  });

  it('finalize commits whatever is open (window blur / unmount safety)', () => {
    const track = firstTrack();
    useStore.getState().beginProjectTransaction({}, 1);
    useStore.getState().setTrackVolume(track.id, 0.33);
    useStore.getState().finalizeProjectTransaction();
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(useStore.getState().past).toHaveLength(1);
    expect(volumeOf(track.id)).toBe(0.33);
  });
});

describe('recording lock with transactions', () => {
  it('refuses to open a transaction while recording, and edits stay refused', () => {
    const track = firstTrack();
    const operationId = useStore.getState().tryBeginAudioRecordingOperation();
    expect(operationId).not.toBeNull();

    expect(useStore.getState().beginProjectTransaction({}, 1)).toBe(false);
    useStore.getState().setTrackVolume(track.id, 0.4);
    expect(volumeOf(track.id)).toBe(track.volume);
    expect(useStore.getState().past).toHaveLength(0);

    useStore.getState().finishAudioRecordingOperation(operationId!);
  });

  it('starting recording commits the open gesture as one step, then locks edits', () => {
    const track = firstTrack();
    const owner = {};
    useStore.getState().beginProjectTransaction(owner, 1);
    useStore.getState().setTrackVolume(track.id, 0.4);
    useStore.getState().setTrackVolume(track.id, 0.6);

    const operationId = useStore.getState().tryBeginAudioRecordingOperation();
    expect(operationId).not.toBeNull();
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
    expect(useStore.getState().past).toHaveLength(1);
    expect(volumeOf(track.id)).toBe(0.6);

    // The drag keeps moving while recording: refused, and the owner's late
    // commit/cancel cannot touch the recording snapshot.
    useStore.getState().setTrackVolume(track.id, 0.8);
    expect(volumeOf(track.id)).toBe(0.6);
    expect(useStore.getState().cancelProjectTransaction(owner)).toBe(false);
    expect(volumeOf(track.id)).toBe(0.6);

    useStore.getState().finishAudioRecordingOperation(operationId!);
  });
});

describe('transactions around continuous controls', () => {
  it('refuses a second begin while one is open and keeps the first owner', () => {
    const first = {};
    const second = {};
    expect(useStore.getState().beginProjectTransaction(first, 1)).toBe(true);
    expect(useStore.getState().beginProjectTransaction(second, 2)).toBe(false);
    expect(useStore.getState().commitProjectTransaction(second)).toBe(false);
    expect(useStore.getState().cancelProjectTransaction(first)).toBe(true);
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
  });

  it('a mixed-field drag through applyProjectChange is one step and undo restores it', () => {
    const track = firstTrack();
    const owner = {};
    const pastBefore = useStore.getState().past.length;
    expect(useStore.getState().beginProjectTransaction(owner, 1)).toBe(true);
    for (const pan of [-0.2, 0.1, 0.5]) {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, pan } : t)),
      }));
    }
    expect(useStore.getState().commitProjectTransaction(owner)).toBe(true);
    expect(useStore.getState().past).toHaveLength(pastBefore + 1);
    useStore.getState().undo();
    const restored = useStore.getState().project.tracks.find((t) => t.id === track.id);
    expect(restored?.pan).toBe(track.pan);
  });

  it('cancel after commit by another path is a no-op, never reopening a transaction', () => {
    const owner = {};
    useStore.getState().beginProjectTransaction(owner, 1);
    useStore.getState().finalizeProjectTransaction();
    expect(useStore.getState().cancelProjectTransaction(owner)).toBe(false);
    expect(useStore.getState().isProjectTransactionOpen()).toBe(false);
  });
});
