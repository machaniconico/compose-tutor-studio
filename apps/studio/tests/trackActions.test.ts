import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMidiClip,
  createTrack,
  type Clip,
  type Project,
} from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let trackActions: typeof import('../src/state/trackActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  trackActions = await import('../src/state/trackActions');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('トラック管理検証')).toBe(true);
});

function fingerprint(project: Project): string {
  return JSON.stringify(project);
}

describe('studio track commands', () => {
  it('adds one full-song instrument track before Master and selects its clip in one history step', () => {
    const before = useStore.getState();
    const historyBefore = before.past.length;
    const revisionBefore = before.saveState.revision;
    const result = trackActions.addStudioTrack({
      kind: 'instrument',
      name: '  Hook  ',
      preset: 'brightLead',
    });

    expect(result).toMatchObject({ ok: true, changed: true, trackName: 'Hook' });
    if (!result.ok) throw new Error('track was not added');
    const state = useStore.getState();
    const track = state.project.tracks.find((candidate) => candidate.id === result.trackId);
    const masterIndex = state.project.tracks.findIndex((candidate) => candidate.type === 'master');

    expect(track).toMatchObject({
      type: 'instrument',
      instrument: { type: 'synth', preset: 'brightLead' },
    });
    expect(track?.clips).toHaveLength(1);
    expect(track?.clips[0]).toMatchObject({
      trackId: result.trackId,
      type: 'midi',
      startBeat: 0,
      lengthBeats: 32,
    });
    expect(state.project.tracks[masterIndex - 1]?.id).toBe(result.trackId);
    expect(state.editor).toMatchObject({
      selectedTrackId: result.trackId,
      selectedClipId: track?.clips[0]?.id,
      activeView: 'pianoRoll',
    });
    expect(state.past).toHaveLength(historyBefore + 1);
    expect(state.saveState.revision).toBe(revisionBefore + 1);
  });

  it('adds a drumkit with a 16-step full-song clip and opens the drum editor', () => {
    const result = trackActions.addStudioTrack({ kind: 'drum', name: 'Percussion' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('drum track was not added');
    const state = useStore.getState();
    const track = state.project.tracks.find((candidate) => candidate.id === result.trackId);

    expect(track).toMatchObject({
      type: 'drum',
      instrument: { type: 'drumkit', preset: 'acoustic' },
    });
    expect(track?.clips[0]).toMatchObject({ type: 'drum', stepsPerBar: 16, lengthBeats: 32 });
    expect(state.editor.activeView).toBe('drums');
  });

  it('rejects blank names but keeps learning roles independent from editable names', () => {
    const before = useStore.getState();
    const projectBefore = fingerprint(before.project);
    const historyBefore = before.past.length;
    const revisionBefore = before.saveState.revision;

    expect(trackActions.addStudioTrack({ kind: 'instrument', name: '   ' })).toMatchObject({
      ok: false,
      code: 'invalid-track-name',
    });
    expect(fingerprint(useStore.getState().project)).toBe(projectBefore);
    expect(useStore.getState().past).toHaveLength(historyBefore);
    expect(useStore.getState().saveState.revision).toBe(revisionBefore);

    const learningTrack = before.project.tracks.find((track) => track.role === 'learning.chords');
    if (!learningTrack) throw new Error('learning role fixture missing');
    expect(trackActions.renameStudioTrack(learningTrack.id, 'Harmony')).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(
      useStore.getState().project.tracks.find((track) => track.id === learningTrack.id),
    ).toMatchObject({ name: 'Harmony', role: 'learning.chords' });

    const created = trackActions.addStudioTrack({ kind: 'instrument', name: 'Lead' });
    if (!created.ok) throw new Error('fixture track was not added');
    expect(trackActions.renameStudioTrack(created.trackId, ' melody ')).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(
      useStore.getState().project.tracks.find((track) => track.id === created.trackId),
    ).toMatchObject({ name: 'melody', role: 'general' });
    expect(projectBefore).not.toBe(fingerprint(useStore.getState().project));
    expect(historyBefore).toBeLessThan(useStore.getState().past.length);
    expect(revisionBefore).toBeLessThan(useStore.getState().saveState.revision);
  });

  it('protects learning tracks from deletion without changing project history', () => {
    const before = useStore.getState();
    const chords = before.project.tracks.find((track) => track.name === 'Chords');
    if (!chords) throw new Error('learning track fixture missing');

    expect(trackActions.deleteStudioTrack(chords.id)).toMatchObject({
      ok: false,
      code: 'learning-track-protected',
    });
    expect(fingerprint(useStore.getState().project)).toBe(fingerprint(before.project));
    expect(useStore.getState().past).toHaveLength(before.past.length);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
  });

  it('transfers one learning role atomically and restarts stale playback topology', () => {
    const previousOwner = useStore.getState().project.tracks.find(
      (track) => track.role === 'learning.chords',
    );
    if (!previousOwner) throw new Error('learning role fixture missing');
    const created = trackActions.addStudioTrack({ kind: 'instrument', name: 'Harmony Layer' });
    if (!created.ok) throw new Error('target track fixture missing');

    useStore.getState().play();
    const requestId = useStore.getState().transport.playbackRequestId;
    useStore.getState().confirmPlaybackStarted(requestId);
    const historyBefore = useStore.getState().past.length;

    const result = trackActions.setStudioTrackRole(created.trackId, 'learning.chords');

    expect(result).toMatchObject({ ok: true, changed: true, playbackStopped: true });
    expect(useStore.getState().project.tracks.find(
      (track) => track.id === previousOwner.id,
    )?.role).toBe('general');
    expect(useStore.getState().project.tracks.find(
      (track) => track.id === created.trackId,
    )?.role).toBe('learning.chords');
    expect(useStore.getState().past).toHaveLength(historyBefore + 1);
    expect(useStore.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      playbackRequestId: requestId + 1,
    });
    expect(trackActions.deleteStudioTrack(created.trackId)).toMatchObject({
      ok: false,
      code: 'learning-track-protected',
    });
  });

  it('keeps same-name and same-preset no-ops out of history', () => {
    const created = trackActions.addStudioTrack({ kind: 'instrument', name: 'Lead' });
    if (!created.ok) throw new Error('fixture track was not added');
    const before = useStore.getState();

    expect(trackActions.renameStudioTrack(created.trackId, '  Lead  ')).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(trackActions.setStudioTrackPreset(created.trackId, 'softPad')).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toHaveLength(before.past.length);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
  });

  it('renames an added track once and restores the name with one Undo', () => {
    const created = trackActions.addStudioTrack({ kind: 'instrument', name: 'Lead' });
    if (!created.ok) throw new Error('fixture track was not added');
    const historyBefore = useStore.getState().past.length;
    const renamed = trackActions.renameStudioTrack(created.trackId, '  Lead Vox  ');

    expect(renamed).toMatchObject({ ok: true, changed: true, trackName: 'Lead Vox' });
    expect(useStore.getState().past).toHaveLength(historyBefore + 1);
    useStore.getState().undo();
    expect(
      useStore.getState().project.tracks.find((track) => track.id === created.trackId)?.name,
    ).toBe('Lead');
  });

  it('duplicates clips, aliases, notes, drum events and effects with fresh internal ids', () => {
    const source = useStore.getState().project.tracks[0];
    const canonical = source?.clips[0];
    if (!source || !canonical) throw new Error('source fixture missing');
    const linked: Clip = {
      id: 'track-action-linked-clip',
      trackId: source.id,
      type: 'midi',
      startBeat: 4,
      lengthBeats: 4,
      loop: false,
      aliasOf: canonical.id,
    };
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === source.id
          ? {
              ...track,
              clips: [
                {
                  ...canonical,
                  lengthBeats: 4,
                  notes: [
                    {
                      id: 'track-action-note',
                      pitch: 64,
                      startBeat: 0,
                      durationBeats: 1,
                      velocity: 100,
                    },
                  ],
                },
                linked,
              ],
              effects: [
                {
                  id: 'track-action-effect',
                  type: 'reverb',
                  enabled: true,
                  params: { mix: 0.3 },
                },
              ],
            }
          : track,
      ),
    }))).toBe(true);

    const historyBefore = useStore.getState().past.length;
    const result = trackActions.duplicateStudioTrack(source.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('source was not duplicated');
    const duplicate = useStore.getState().project.tracks.find((track) => track.id === result.trackId);
    if (!duplicate) throw new Error('duplicate missing');

    expect(useStore.getState().past).toHaveLength(historyBefore + 1);
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.clips.map((clip) => clip.id)).not.toEqual([canonical.id, linked.id]);
    expect(duplicate.clips[1]?.aliasOf).toBe(duplicate.clips[0]?.id);
    expect(duplicate.clips[0]?.notes?.[0]?.id).not.toBe('track-action-note');
    expect(duplicate.effects[0]?.id).not.toBe('track-action-effect');
    expect(duplicate.effects[0]?.params).not.toBe(source.effects[0]?.params);
    expect(useStore.getState().editor.selectedTrackId).toBe(duplicate.id);
  });

  it('moves within the non-master range and treats the Master boundary as a no-op', () => {
    const created = trackActions.addStudioTrack({ kind: 'instrument', name: 'Ending' });
    if (!created.ok) throw new Error('fixture track was not added');
    const historyBefore = useStore.getState().past.length;
    const down = trackActions.moveStudioTrack(created.trackId, 'down');

    expect(down).toMatchObject({ ok: true, changed: false });
    expect(useStore.getState().past).toHaveLength(historyBefore);
    expect(trackActions.moveStudioTrack(created.trackId, 'up')).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(useStore.getState().past).toHaveLength(historyBefore + 1);
  });

  it('deletes the selected track, selects its next neighbor, and restores all content with Undo', () => {
    const created = trackActions.addStudioTrack({ kind: 'instrument', name: 'Temporary' });
    if (!created.ok) throw new Error('fixture track was not added');
    const sourceSnapshot = useStore
      .getState()
      .project.tracks.find((track) => track.id === created.trackId);
    const result = trackActions.deleteStudioTrack(created.trackId);

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(useStore.getState().project.tracks.some((track) => track.id === created.trackId)).toBe(false);
    expect(useStore.getState().editor.selectedTrackId).not.toBe(created.trackId);
    expect(useStore.getState().editor.selectedTrackId).not.toBeNull();

    useStore.getState().undo();
    expect(useStore.getState().project.tracks.find((track) => track.id === created.trackId)).toEqual(
      sourceSnapshot,
    );
  });

  it('falls back to a surviving track and clip when Undo removes the selected addition', () => {
    const originalTrack = useStore.getState().project.tracks[0];
    if (!originalTrack) throw new Error('original track fixture missing');
    const created = trackActions.addStudioTrack({ kind: 'instrument', name: 'Undo Me' });
    if (!created.ok) throw new Error('fixture track was not added');

    useStore.getState().undo();

    expect(useStore.getState().editor.selectedTrackId).toBe(originalTrack.id);
    expect(useStore.getState().editor.selectedClipId).toBe(originalTrack.clips[0]?.id ?? null);
  });

  it('stops an active playback generation when a preset is adopted and keeps the playhead', () => {
    const track = useStore.getState().project.tracks[0];
    if (!track) throw new Error('track fixture missing');
    useStore.getState().setPosition(6.25);
    useStore.getState().play();
    const requestId = useStore.getState().transport.playbackRequestId;
    useStore.getState().confirmPlaybackStarted(requestId);

    expect(trackActions.setStudioTrackPreset(track.id, 'brightLead')).toMatchObject({
      ok: true,
      changed: true,
      playbackStopped: true,
    });
    expect(useStore.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      playbackRequestId: requestId + 1,
      positionBeat: 6.25,
    });
  });

  it('rejects a command while a project transition owns persistence', () => {
    const projectBefore = fingerprint(useStore.getState().project);
    const historyBefore = useStore.getState().past.length;
    useStore.setState({ projectOperationBusy: true });

    expect(trackActions.addStudioTrack({ kind: 'drum', name: 'Busy' })).toMatchObject({
      ok: false,
      code: 'commit-rejected',
    });
    expect(fingerprint(useStore.getState().project)).toBe(projectBefore);
    expect(useStore.getState().past).toHaveLength(historyBefore);
    useStore.setState({ projectOperationBusy: false });
  });

  it('rejects the 129th track atomically at the store boundary', () => {
    expect(useStore.getState().applyProjectChange((project) => {
      const master = project.tracks.find((track) => track.type === 'master');
      if (!master) return project;
      const tracks = Array.from({ length: 127 }, (_, index) => {
        const track = createTrack(`Track ${index + 1}`, 'instrument', {
          type: 'synth',
          preset: 'softPad',
        });
        track.clips.push(createMidiClip(track.id, 0, 32));
        return track;
      });
      return { ...project, tracks: [...tracks, master] };
    })).toBe(true);
    const before = useStore.getState();
    const projectBefore = fingerprint(before.project);
    const historyBefore = before.past.length;
    const revisionBefore = before.saveState.revision;

    expect(trackActions.addStudioTrack({ kind: 'instrument', name: 'Track 129' })).toMatchObject({
      ok: false,
      code: 'track-limit',
    });
    expect(fingerprint(useStore.getState().project)).toBe(projectBefore);
    expect(useStore.getState().past).toHaveLength(historyBefore);
    expect(useStore.getState().saveState.revision).toBe(revisionBefore);
  });
});
