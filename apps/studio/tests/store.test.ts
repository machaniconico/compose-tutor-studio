import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '@cts/tutorial-engine';
import {
  MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
  createAudioTrackClip,
  duplicateClip,
  findClip,
  resolveClipContent,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';
import { createDefaultProject } from '../src/state/defaultProject';
import { subscribeAppEvents } from '../src/state/appEvents';

// The store reads localStorage at module-import time, so install the stub
// BEFORE importing it. We import dynamically inside beforeAll for that reason.
let useStore: typeof import('../src/state/store')['useStore'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
});

beforeEach(async () => {
  // Reset to a clean project + history before each test.
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('テスト')).toBe(true);
});

function addAudioTrackFixture(suffix: string): string {
  const asset: ReadyAudioAsset = {
    id: `asset-arm-${suffix}`,
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: `${suffix}.wav`,
    mediaType: 'audio/wav',
    byteLength: 96_044,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 48_000,
  };
  const created = createAudioTrackClip(useStore.getState().project, asset, {
    trackName: `Audio ${suffix}`,
    idFactory: (kind) => `${kind}-arm-${suffix}`,
  });
  if (!created.ok) throw new Error(created.error.code);
  expect(useStore.getState().applyProjectChange(() => created.project)).toBe(true);
  return created.trackId;
}

function createRecordingAdditionFixture(snapshot: Project, suffix: string) {
  const asset: ReadyAudioAsset = {
    id: `asset-recording-${suffix}`,
    availability: 'ready',
    checksumSha256: 'b'.repeat(64),
    originalName: `${suffix}.wav`,
    mediaType: 'audio/wav',
    byteLength: 96_044,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 48_000,
  };
  const created = createAudioTrackClip(snapshot, asset, {
    trackName: `Recording ${suffix}`,
    idFactory: (kind) => `${kind}-recording-${suffix}`,
  });
  if (!created.ok) throw new Error(created.error.code);
  return created;
}

describe('default project', () => {
  it('builds 120bpm / C major / 4/4 / 8 bars with the expected tracks', () => {
    const project = createDefaultProject();
    expect(project.bpm).toBe(120);
    expect(project.key).toBe('C');
    expect(project.scale).toBe('major');
    expect(project.timeSignature).toEqual([4, 4]);
    expect(project.lengthBars).toBe(8);

    const names = project.tracks.map((t) => t.name);
    expect(names).toEqual(['Chords', 'Bass', 'Melody', 'Drums', 'Master']);

    // Instrument tracks each have one full-length empty midi clip.
    const chords = project.tracks[0];
    expect(chords?.clips.length).toBe(1);
    expect(chords?.clips[0]?.type).toBe('midi');
    expect(chords?.clips[0]?.lengthBeats).toBe(32);
    expect(chords?.clips[0]?.notes).toEqual([]);

    // Drum track has one drum clip with stepsPerBar 16.
    const drums = project.tracks[3];
    expect(drums?.type).toBe('drum');
    expect(drums?.clips[0]?.type).toBe('drum');
    expect(drums?.clips[0]?.stepsPerBar).toBe(16);
  });

  it('has the preset C G Am F progression with correct pitch-class notes', () => {
    const project = createDefaultProject();
    const symbols = project.chordTrack.map((c) => c.symbol);
    // 8 bars / 1 chord per bar => C G Am F repeated twice.
    expect(symbols).toEqual(['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F']);

    const bySymbol = (s: string) => project.chordTrack.find((c) => c.symbol === s);
    expect(bySymbol('C')?.notes).toEqual([0, 4, 7]); // C E G
    expect(bySymbol('G')?.notes).toEqual([7, 11, 2]); // G B D
    expect(bySymbol('Am')?.notes).toEqual([9, 0, 4]); // A C E
    expect(bySymbol('F')?.notes).toEqual([5, 9, 0]); // F A C
  });
});

describe('store metadata actions', () => {
  it('mutates bpm/key/scale/title and bumps updatedAt', () => {
    const before = useStore.getState().project.updatedAt;
    useStore.getState().setBpm(140);
    expect(useStore.getState().project.bpm).toBe(140);

    useStore.getState().setKey('G');
    expect(useStore.getState().project.key).toBe('G');

    useStore.getState().setScale('minorPentatonic');
    expect(useStore.getState().project.scale).toBe('minorPentatonic');

    useStore.getState().setTitle('新タイトル');
    expect(useStore.getState().project.title).toBe('新タイトル');

    expect(useStore.getState().project.updatedAt >= before).toBe(true);
  });
});

describe('microphone recording lifecycle fence', () => {
  it('owns one exact token and blocks project switching and native close until released', async () => {
    const originalProject = useStore.getState().project;
    const operationId = useStore.getState().tryBeginAudioRecordingOperation();
    expect(operationId).not.toBeNull();
    if (operationId === null) throw new Error('recording token missing');
    expect(useStore.getState().audioRecordingOperationId).toBe(operationId);
    expect(useStore.getState().tryBeginAudioRecordingOperation()).toBeNull();

    await expect(useStore.getState().createNewProject('切替不可')).resolves.toBe(false);
    expect(useStore.getState().project).toBe(originalProject);
    expect(useStore.getState().tryBeginNativeClose()).toBe(false);
    expect(useStore.getState().persistenceNotice?.message).toContain('マイク録音');

    useStore.getState().finishAudioRecordingOperation(operationId + 1);
    expect(useStore.getState().audioRecordingOperationId).toBe(operationId);
    useStore.getState().finishAudioRecordingOperation(operationId);
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
    expect(useStore.getState().persistenceNotice).toBeNull();

    expect(useStore.getState().tryBeginNativeClose()).toBe(true);
    useStore.getState().cancelNativeClose();
    expect(useStore.getState().projectOperationBusy).toBe(false);
  });

  it('uses an operation-owned transport start and rejects normal or looped playback', () => {
    const state = useStore.getState();
    const operationId = state.tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording token missing');

    state.play();
    expect(useStore.getState().transport.phase).toBe('stopped');
    expect(state.startAudioRecordingPlayback(operationId + 1, 4)).toBeNull();

    const requestId = state.startAudioRecordingPlayback(operationId, 4);
    expect(requestId).not.toBeNull();
    expect(useStore.getState().transport).toMatchObject({
      phase: 'starting',
      playbackRequestId: requestId,
      positionBeat: 4,
    });
    useStore.getState().stop();
    state.finishAudioRecordingOperation(operationId);

    useStore.getState().toggleLoop();
    const loopedOperationId = useStore.getState().tryBeginAudioRecordingOperation();
    if (loopedOperationId === null) throw new Error('looped recording token missing');
    expect(useStore.getState().startAudioRecordingPlayback(loopedOperationId, 4)).toBeNull();
    useStore.getState().finishAudioRecordingOperation(loopedOperationId);
    useStore.getState().toggleLoop();
  });

  it('fences Project mutations, history, loop, and metronome for the whole take', () => {
    useStore.getState().setTitle('録音前');
    const before = useStore.getState();
    const operationId = before.tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording token missing');

    useStore.getState().setTitle('反映しない');
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      bpm: 160,
    }))).toBe(false);
    useStore.getState().undo();
    useStore.getState().redo();
    useStore.getState().toggleLoop();
    useStore.getState().toggleMetronome();

    const during = useStore.getState();
    expect(during.project).toBe(before.project);
    expect(during.past).toBe(before.past);
    expect(during.future).toBe(before.future);
    expect(during.saveState).toBe(before.saveState);
    expect(during.transport.loopEnabled).toBe(before.transport.loopEnabled);
    expect(during.transport.metronome).toBe(before.transport.metronome);
    expect(during.canUndo()).toBe(false);
    expect(during.canRedo()).toBe(false);

    during.finishAudioRecordingOperation(operationId);
    useStore.getState().setTitle('録音後');
    expect(useStore.getState().project.title).toBe('録音後');
  });

  it('does not let the generic verified-asset API bypass an active recording fence', () => {
    const snapshot = useStore.getState().project;
    const operationId = useStore.getState().tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording token missing');
    const addition = createRecordingAdditionFixture(snapshot, 'generic-fence');

    try {
      expect(useStore.getState().applyVerifiedAudioAssetAddition(
        () => addition.project,
        addition.audioAssetId,
      )).toBe(false);
      expect(useStore.getState().project).toBe(snapshot);
    } finally {
      useStore.getState().finishAudioRecordingOperation(operationId);
    }
  });

  it('requires the exact recording operation and frozen Project snapshot', () => {
    const snapshot = useStore.getState().project;
    const operationId = useStore.getState().tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording token missing');
    const addition = createRecordingAdditionFixture(snapshot, 'exact-owner');

    try {
      expect(useStore.getState().applyVerifiedRecordingAudioAssetAddition({
        operationId: operationId + 1,
        expectedSnapshot: snapshot,
        verifiedAudioAssetId: addition.audioAssetId,
        nextProject: addition.project,
      })).toBe(false);
      expect(useStore.getState().applyVerifiedRecordingAudioAssetAddition({
        operationId,
        expectedSnapshot: { ...snapshot },
        verifiedAudioAssetId: addition.audioAssetId,
        nextProject: addition.project,
      })).toBe(false);
      expect(useStore.getState().project).toBe(snapshot);
    } finally {
      useStore.getState().finishAudioRecordingOperation(operationId);
    }
  });

  it('rejects unrelated Project changes bundled with a recording addition', () => {
    const snapshot = useStore.getState().project;
    const operationId = useStore.getState().tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording token missing');
    const addition = createRecordingAdditionFixture(snapshot, 'bundled-change');

    try {
      expect(useStore.getState().applyVerifiedRecordingAudioAssetAddition({
        operationId,
        expectedSnapshot: snapshot,
        verifiedAudioAssetId: addition.audioAssetId,
        nextProject: { ...addition.project, bpm: snapshot.bpm + 1 },
      })).toBe(false);
      expect(useStore.getState().project).toBe(snapshot);
    } finally {
      useStore.getState().finishAudioRecordingOperation(operationId);
    }
  });

  it('commits one exact recording addition as one revision and one Undo step', () => {
    const before = useStore.getState();
    const operationId = before.tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording token missing');
    const addition = createRecordingAdditionFixture(before.project, 'exact-commit');

    expect(useStore.getState().applyVerifiedRecordingAudioAssetAddition({
      operationId,
      expectedSnapshot: before.project,
      verifiedAudioAssetId: addition.audioAssetId,
      nextProject: addition.project,
    })).toBe(true);
    const committed = useStore.getState();
    expect(committed.project.audioAssets.at(-1)?.id).toBe(addition.audioAssetId);
    expect(committed.past).toHaveLength(before.past.length + 1);
    expect(committed.saveState.revision).toBe(before.saveState.revision + 1);

    committed.finishAudioRecordingOperation(operationId);
    useStore.getState().undo();
    const undone = useStore.getState().project;
    expect({ ...undone, updatedAt: before.project.updatedAt }).toEqual(before.project);
  });
});

describe('runtime Audio Track Record Arm', () => {
  it('arms only one Audio Track, toggles the same Track off, and explicitly disarms', () => {
    const firstAudioTrackId = addAudioTrackFixture('first');
    const secondAudioTrackId = addAudioTrackFixture('second');
    const instrumentTrack = useStore.getState().project.tracks.find(
      (track) => track.type === 'instrument',
    );
    const masterTrack = useStore.getState().project.tracks.find(
      (track) => track.type === 'master',
    );

    expect(useStore.getState().setAudioTrackArmed(firstAudioTrackId)).toBe(true);
    expect(useStore.getState().armedAudioTrackId).toBe(firstAudioTrackId);

    expect(useStore.getState().setAudioTrackArmed(secondAudioTrackId)).toBe(true);
    expect(useStore.getState().armedAudioTrackId).toBe(secondAudioTrackId);

    expect(useStore.getState().setAudioTrackArmed(instrumentTrack?.id ?? '')).toBe(false);
    expect(useStore.getState().setAudioTrackArmed(masterTrack?.id ?? '')).toBe(false);
    expect(useStore.getState().setAudioTrackArmed('missing-audio-track')).toBe(false);
    expect(useStore.getState().armedAudioTrackId).toBe(secondAudioTrackId);

    expect(useStore.getState().setAudioTrackArmed(secondAudioTrackId)).toBe(true);
    expect(useStore.getState().armedAudioTrackId).toBeNull();
    expect(useStore.getState().setAudioTrackArmed(firstAudioTrackId)).toBe(true);
    expect(useStore.getState().setAudioTrackArmed(null)).toBe(true);
    expect(useStore.getState().armedAudioTrackId).toBeNull();
  });

  it('does not change the Project, history, save revision, or autosave state', () => {
    const audioTrackId = addAudioTrackFixture('runtime-only');
    const before = useStore.getState();

    expect(before.setAudioTrackArmed(audioTrackId)).toBe(true);

    const after = useStore.getState();
    expect(after.armedAudioTrackId).toBe(audioTrackId);
    expect(after.project).toBe(before.project);
    expect(after.project.updatedAt).toBe(before.project.updatedAt);
    expect(after.past).toBe(before.past);
    expect(after.future).toBe(before.future);
    expect(after.saveState).toBe(before.saveState);
    expect(after.saveState.revision).toBe(before.saveState.revision);
  });

  it('rejects Arm changes while recording or a Project operation owns the store', () => {
    const firstAudioTrackId = addAudioTrackFixture('busy-first');
    const secondAudioTrackId = addAudioTrackFixture('busy-second');
    expect(useStore.getState().setAudioTrackArmed(firstAudioTrackId)).toBe(true);

    const operationId = useStore.getState().tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording token missing');
    expect(useStore.getState().setAudioTrackArmed(secondAudioTrackId)).toBe(false);
    expect(useStore.getState().setAudioTrackArmed(firstAudioTrackId)).toBe(false);
    expect(useStore.getState().setAudioTrackArmed(null)).toBe(false);
    expect(useStore.getState().armedAudioTrackId).toBe(firstAudioTrackId);
    useStore.getState().finishAudioRecordingOperation(operationId);

    useStore.setState({ projectOperationBusy: true });
    try {
      expect(useStore.getState().setAudioTrackArmed(secondAudioTrackId)).toBe(false);
      expect(useStore.getState().armedAudioTrackId).toBe(firstAudioTrackId);
    } finally {
      useStore.setState({ projectOperationBusy: false });
    }
  });

  it('preserves a valid Arm across edits and clears it when Undo removes the target', () => {
    const audioTrackId = addAudioTrackFixture('reconcile');
    expect(useStore.getState().setAudioTrackArmed(audioTrackId)).toBe(true);

    useStore.getState().setTitle('Armを保持する編集');
    expect(useStore.getState().armedAudioTrackId).toBe(audioTrackId);

    useStore.getState().undo();
    expect(useStore.getState().armedAudioTrackId).toBe(audioTrackId);
    useStore.getState().undo();
    expect(useStore.getState().project.tracks.some((track) => track.id === audioTrackId)).toBe(false);
    expect(useStore.getState().armedAudioTrackId).toBeNull();

    useStore.getState().redo();
    expect(useStore.getState().project.tracks.some((track) => track.id === audioTrackId)).toBe(true);
    expect(useStore.getState().armedAudioTrackId).toBeNull();
  });

  it('clears Record Arm whenever a different Project is activated', async () => {
    const audioTrackId = addAudioTrackFixture('activation');
    expect(useStore.getState().setAudioTrackArmed(audioTrackId)).toBe(true);

    await expect(useStore.getState().createNewProject('別のプロジェクト')).resolves.toBe(true);

    expect(useStore.getState().armedAudioTrackId).toBeNull();
    expect(useStore.getState().project.tracks.some((track) => track.id === audioTrackId)).toBe(false);
  });

  it('keeps the preferred microphone input runtime-only and across Project activation', async () => {
    const before = useStore.getState();
    expect(before.setPreferredMicrophoneInputDeviceId('usb-microphone')).toBe(true);

    const selected = useStore.getState();
    expect(selected.preferredMicrophoneInputDeviceId).toBe('usb-microphone');
    expect(selected.project).toBe(before.project);
    expect(selected.past).toBe(before.past);
    expect(selected.future).toBe(before.future);
    expect(selected.saveState).toBe(before.saveState);
    expect(selected.setPreferredMicrophoneInputDeviceId('')).toBe(false);
    expect(useStore.getState().preferredMicrophoneInputDeviceId).toBe('usb-microphone');

    await expect(useStore.getState().createNewProject('入力設定を保持')).resolves.toBe(true);
    expect(useStore.getState().preferredMicrophoneInputDeviceId).toBe('usb-microphone');
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId(null)).toBe(true);
    expect(useStore.getState().preferredMicrophoneInputDeviceId).toBeNull();
  });

  it('rejects microphone input changes while recording owns the lifecycle', () => {
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId('built-in-microphone')).toBe(true);
    const operationId = useStore.getState().tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording token missing');

    expect(useStore.getState().setPreferredMicrophoneInputDeviceId('usb-microphone')).toBe(false);
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId(null)).toBe(false);
    expect(useStore.getState().preferredMicrophoneInputDeviceId).toBe('built-in-microphone');

    useStore.getState().finishAudioRecordingOperation(operationId);
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId('usb-microphone')).toBe(true);
    expect(useStore.getState().preferredMicrophoneInputDeviceId).toBe('usb-microphone');
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId(null)).toBe(true);
  });

  it('keeps latency compensation preferences runtime-only, bounded, and frozen per take', () => {
    const before = useStore.getState();
    expect(before.setRecordingLatencyCompensationMode('off')).toBe(true);
    expect(before.setRecordingLatencyAdjustmentMs(125)).toBe(true);

    const selected = useStore.getState();
    expect(selected.recordingLatencyCompensationMode).toBe('off');
    expect(selected.recordingLatencyAdjustmentMs).toBe(125);
    expect(selected.project).toBe(before.project);
    expect(selected.past).toBe(before.past);
    expect(selected.saveState).toBe(before.saveState);
    expect(selected.setRecordingLatencyAdjustmentMs(-501)).toBe(false);
    expect(selected.setRecordingLatencyAdjustmentMs(501)).toBe(false);
    expect(selected.setRecordingLatencyAdjustmentMs(1.5)).toBe(false);

    const operationId = selected.tryBeginAudioRecordingOperation();
    if (operationId === null) throw new Error('recording token missing');
    expect(useStore.getState().setRecordingLatencyCompensationMode('estimated')).toBe(false);
    expect(useStore.getState().setRecordingLatencyAdjustmentMs(0)).toBe(false);
    expect(useStore.getState().recordingLatencyCompensationMode).toBe('off');
    expect(useStore.getState().recordingLatencyAdjustmentMs).toBe(125);

    useStore.getState().finishAudioRecordingOperation(operationId);
    expect(useStore.getState().setRecordingLatencyCompensationMode('estimated')).toBe(true);
    expect(useStore.getState().setRecordingLatencyAdjustmentMs(0)).toBe(true);
  });
});

describe('chord actions', () => {
  it('adds and removes chords', () => {
    const initialCount = useStore.getState().project.chordTrack.length;
    useStore.getState().addChord('Dm', 0, 4);
    const added = useStore.getState().project.chordTrack;
    expect(added.length).toBe(initialCount + 1);
    const newChord = added[added.length - 1];
    expect(newChord?.symbol).toBe('Dm');
    expect(newChord?.quality).toBe('minor');

    const id = newChord?.id ?? '';
    useStore.getState().removeChord(id);
    expect(useStore.getState().project.chordTrack.length).toBe(initialCount);
  });

  it('updates a chord', () => {
    useStore.getState().addChord('C', 0, 4);
    const id = useStore.getState().project.chordTrack[0]?.id ?? '';
    useStore.getState().updateChord(id, { symbol: 'Cmaj7' });
    expect(useStore.getState().project.chordTrack[0]?.symbol).toBe('Cmaj7');
  });
});

describe('note actions', () => {
  it('adds, updates, and removes notes on a clip', () => {
    const clipId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 });

    const clip = () => useStore.getState().project.tracks[0]?.clips[0];
    expect(clip()?.notes?.length).toBe(1);

    const noteId = clip()?.notes?.[0]?.id ?? '';
    useStore.getState().updateNote(clipId, noteId, { pitch: 64 });
    expect(clip()?.notes?.[0]?.pitch).toBe(64);

    useStore.getState().removeNote(clipId, noteId);
    expect(clip()?.notes?.length).toBe(0);
  });

  it('edits the canonical payload when a linked clip is selected', () => {
    const sourceId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    expect(
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === sourceId ? { ...clip, lengthBeats: 4 } : clip,
          ),
        })),
      })),
    ).toBe(true);
    expect(
      useStore.getState().applyProjectChange((project) => {
        const result = duplicateClip(project, sourceId, {
          id: 'linked-store-clip',
          startBeat: 4,
          linked: true,
        });
        return result.ok ? result.project : project;
      }),
    ).toBe(true);

    useStore.getState().addNote('linked-store-clip', {
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 100,
    });

    const project = useStore.getState().project;
    const source = findClip(project, sourceId)?.clip;
    const alias = findClip(project, 'linked-store-clip')?.clip;
    expect(source?.notes).toHaveLength(1);
    expect(alias?.notes).toBeUndefined();
    expect(alias && resolveClipContent(project, alias)?.notes).toEqual(source?.notes);
  });
});

describe('drum actions', () => {
  it('toggles a drum step on and off', () => {
    const drumTrack = useStore.getState().project.tracks.find((t) => t.type === 'drum');
    const clipId = drumTrack?.clips[0]?.id ?? '';

    expect(useStore.getState().toggleDrumStep(clipId, 'kick', 0)).toBe(true);
    const drumClip = () =>
      useStore.getState().project.tracks.find((t) => t.type === 'drum')?.clips[0];
    expect(drumClip()?.drumEvents?.length).toBe(1);
    expect(drumClip()?.drumEvents?.[0]?.lane).toBe('kick');

    expect(useStore.getState().toggleDrumStep(clipId, 'kick', 0)).toBe(true);
    expect(drumClip()?.drumEvents?.length).toBe(0);
  });

  it('does not publish success when a linked-source edit exceeds the persisted schedule budget', () => {
    const linkedInstanceCount = 1_000;
    const eventsPerSource = MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS / linkedInstanceCount;
    expect(Number.isSafeInteger(eventsPerSource)).toBe(true);

    const setupCommitted = useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => {
        if (track.type !== 'drum') return track;
        const source = track.clips[0];
        if (!source) return track;
        const drumEvents = Array.from({ length: eventsPerSource }, (_, index) => ({
          id: `budget-drum-${index}`,
          lane: 'closedHat' as const,
          stepIndex: 0,
          velocity: 100,
        }));
        const aliases = Array.from({ length: linkedInstanceCount - 1 }, (_, index) => ({
          id: `budget-alias-${index}`,
          trackId: track.id,
          type: 'drum' as const,
          startBeat: 0,
          lengthBeats: source.lengthBeats,
          loop: source.loop,
          aliasOf: source.id,
        }));
        return {
          ...track,
          clips: [{ ...source, drumEvents }, ...aliases],
        };
      }),
    }));
    expect(setupCommitted).toBe(true);

    const projectBeforeRejectedEdit = useStore.getState().project;
    const source = projectBeforeRejectedEdit.tracks.find((track) => track.type === 'drum')?.clips[0];
    if (!source) throw new Error('drum source fixture missing');
    const events: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => events.push(event));
    let committed = true;
    try {
      committed = useStore.getState().toggleDrumStep(source.id, 'kick', 1);
    } finally {
      unsubscribe();
    }

    expect(committed).toBe(false);
    expect(useStore.getState().project).toBe(projectBeforeRejectedEdit);
    expect(source.drumEvents).toHaveLength(eventsPerSource);
    expect(events).toEqual([]);
    expect(useStore.getState().persistenceNotice?.kind).toBe('warning');
  });

  it('accepts groove and per-step probability as durable project data', () => {
    const drumClip = useStore.getState().project.tracks.find((track) => track.type === 'drum')?.clips[0];
    if (!drumClip) throw new Error('drum fixture missing');
    useStore.getState().toggleDrumStep(drumClip.id, 'kick', 0);
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === drumClip.id
            ? {
                ...clip,
                drumGroove: {
                  swing: 0.4,
                  probability: 0.8,
                  humanizeVelocity: 10,
                  seed: 7,
                },
                drumEvents: clip.drumEvents?.map((event) => ({
                  ...event,
                  probability: 0.65,
                })),
              }
            : clip,
        ),
      })),
    }));

    const updated = useStore
      .getState()
      .project.tracks.find((track) => track.type === 'drum')?.clips[0];
    expect(updated?.drumGroove?.swing).toBe(0.4);
    expect(updated?.drumEvents?.[0]?.probability).toBe(0.65);
    expect(useStore.getState().saveState.phase).not.toBe('error');
  });
});

describe('mixer actions', () => {
  it('sets volume/pan and toggles mute/solo', () => {
    const trackId = useStore.getState().project.tracks[0]?.id ?? '';
    useStore.getState().setTrackVolume(trackId, 0.5);
    useStore.getState().setTrackPan(trackId, -0.3);
    useStore.getState().toggleMute(trackId);
    useStore.getState().toggleSolo(trackId);

    const track = useStore.getState().project.tracks[0];
    expect(track?.volume).toBe(0.5);
    expect(track?.pan).toBe(-0.3);
    expect(track?.mute).toBe(true);
    expect(track?.solo).toBe(true);
  });

  it('publishes one volume event with the adopted committed value', () => {
    const track = useStore.getState().project.tracks[0];
    if (!track) throw new Error('mixer track fixture missing');
    const events: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => events.push(event));

    try {
      useStore.getState().setTrackVolume(track.id, 1.5);
    } finally {
      unsubscribe();
    }

    expect(useStore.getState().project.tracks[0]?.volume).toBe(1.5);
    expect(events).toEqual([
      {
        type: 'track.volumeChanged',
        payload: {
          trackId: track.id,
          trackName: track.name,
          volume: 1.5,
        },
      },
    ]);
  });

  it('does not publish or create history for missing, invalid, or unchanged volumes', () => {
    const track = useStore.getState().project.tracks[0];
    if (!track) throw new Error('mixer track fixture missing');
    const before = useStore.getState();
    const events: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => events.push(event));

    try {
      useStore.getState().setTrackVolume(track.id, track.volume);
      useStore.getState().setTrackVolume('missing-track', 0.5);
      useStore.getState().setTrackVolume(track.id, Number.NaN);
      useStore.getState().setTrackVolume(track.id, Number.POSITIVE_INFINITY);
      useStore.getState().setTrackVolume(track.id, -0.01);
      useStore.getState().setTrackVolume(track.id, 2.01);
    } finally {
      unsubscribe();
    }

    const after = useStore.getState();
    expect(after.project).toBe(before.project);
    expect(after.saveState.revision).toBe(before.saveState.revision);
    expect(after.past).toBe(before.past);
    expect(events).toEqual([]);
  });

  it('does not publish when a valid volume cannot be committed', () => {
    const track = useStore.getState().project.tracks[0];
    if (!track) throw new Error('mixer track fixture missing');
    const events: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => events.push(event));
    useStore.setState({ projectOperationBusy: true });

    try {
      useStore.getState().setTrackVolume(track.id, 1.5);
    } finally {
      useStore.setState({ projectOperationBusy: false });
      unsubscribe();
    }

    expect(useStore.getState().project.tracks[0]?.volume).toBe(track.volume);
    expect(events).toEqual([]);
  });
});

describe('undo / redo', () => {
  it('does not create history or a save revision for a referential no-op', () => {
    const before = useStore.getState();

    expect(useStore.getState().applyProjectChange((project) => project)).toBe(true);

    const after = useStore.getState();
    expect(after.project).toBe(before.project);
    expect(after.project.updatedAt).toBe(before.project.updatedAt);
    expect(after.past).toEqual([]);
    expect(after.saveState.revision).toBe(before.saveState.revision);
  });

  it('rejects a claimed verified asset addition when no asset was appended', () => {
    const before = useStore.getState();

    expect(useStore.getState().applyVerifiedAudioAssetAddition(
      (project) => project,
      'missing-verified-asset',
    )).toBe(false);

    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toBe(before.past);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
  });

  it('undoes and redoes a project mutation', () => {
    expect(useStore.getState().canUndo()).toBe(false);

    useStore.getState().setBpm(150);
    expect(useStore.getState().project.bpm).toBe(150);
    expect(useStore.getState().canUndo()).toBe(true);

    useStore.getState().undo();
    expect(useStore.getState().project.bpm).toBe(120);
    expect(useStore.getState().canRedo()).toBe(true);

    useStore.getState().redo();
    expect(useStore.getState().project.bpm).toBe(150);
  });

  it('clears redo history on a new mutation', () => {
    useStore.getState().setBpm(150);
    useStore.getState().undo();
    expect(useStore.getState().canRedo()).toBe(true);

    useStore.getState().setBpm(99);
    expect(useStore.getState().canRedo()).toBe(false);
    expect(useStore.getState().project.bpm).toBe(99);
  });

  it('caps history at 100 snapshots', () => {
    for (let i = 0; i < 120; i += 1) {
      useStore.getState().setBpm(100 + i);
    }
    expect(useStore.getState().past.length).toBeLessThanOrEqual(100);
  });

  it('clears a duplicated clip selection when undo removes that clip', () => {
    const sourceId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    expect(
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === sourceId ? { ...clip, lengthBeats: 4 } : clip,
          ),
        })),
      })),
    ).toBe(true);
    expect(
      useStore.getState().applyProjectChange((project) => {
        const result = duplicateClip(project, sourceId, {
          id: 'undo-linked-clip',
          startBeat: 4,
          linked: true,
        });
        return result.ok ? result.project : project;
      }),
    ).toBe(true);
    useStore.getState().selectClip('undo-linked-clip');

    useStore.getState().undo();

    expect(findClip(useStore.getState().project, 'undo-linked-clip')).toBeNull();
    expect(useStore.getState().editor.selectedClipId).toBeNull();
    expect(useStore.getState().editor.selectedNoteIds).toEqual([]);
  });
});

describe('selection (no history)', () => {
  it('selecting does not push history', () => {
    const trackId = useStore.getState().project.tracks[1]?.id ?? '';
    useStore.getState().selectTrack(trackId);
    expect(useStore.getState().editor.selectedTrackId).toBe(trackId);
    expect(useStore.getState().canUndo()).toBe(false);
  });
});

describe('persistence integration', () => {
  it('creates a genuinely blank project instead of silently adding a progression', async () => {
    await useStore.getState().createNewProject('まっさら');
    const project = useStore.getState().project;

    expect(project.title).toBe('まっさら');
    expect(project.chordTrack).toEqual([]);
    expect(project.sections).toEqual([]);
    expect(project.tracks.flatMap((track) => track.clips).flatMap((clip) => clip.notes ?? []))
      .toEqual([]);
    expect(
      project.tracks.flatMap((track) => track.clips).flatMap((clip) => clip.drumEvents ?? []),
    ).toEqual([]);
  });

  it('createNewProject persists and is listable', async () => {
    await useStore.getState().createNewProject('保存テスト');
    const id = useStore.getState().project.id;
    const list = useStore.getState().listSavedProjects();
    expect(list.some((p) => p.id === id)).toBe(true);
  });

  it('saveToLocalStorage writes and refreshes the cached project list', async () => {
    useStore.getState().setTitle('永続化');
    await useStore.getState().saveToLocalStorage();
    const id = useStore.getState().project.id;
    const list = useStore.getState().listSavedProjects();
    const found = list.find((p) => p.id === id);
    expect(found?.status === 'ready' ? found.title : undefined).toBe('永続化');
  });
});
