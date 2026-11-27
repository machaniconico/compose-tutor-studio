import assert from 'node:assert/strict';
import { beatTick, isWholeRecordingTick, placedNoteTicks, PPQ, songEndBeat, soundingEvents } from '@cts/project-model';
import { expect, it, vi } from 'vitest';
import { captureLastPerformance, captureLiveNote } from '../src/audio/playback';
import { createDefaultProject } from '../src/state/defaultProject';
import { prepareStepInput, writeStepInputChord } from '../src/state/editorActions';
import { activeLoopRange, useStore } from '../src/state/store';

// The component tests check toast text. Keep notification timers out of the fuzz.
vi.mock('../src/state/tutorialBridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/state/tutorialBridge')>(),
  pushToast: vi.fn(),
}));

function seededRandom(seed: number) {
  return (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 0x1_0000_0000 * limit);
  };
}

const currentClip = () => useStore.getState().project.tracks[0]!.clips[0]!;
const currentNotes = () => currentClip().notes!;

function expectEveryNoteToSound() {
  const state = useStore.getState();
  const { project } = state;
  const clip = currentClip();
  const loop = activeLoopRange(state);
  const effectiveEnd = Math.min(clip.startBeat + clip.lengthBeats, loop?.endBeat ?? Infinity, songEndBeat(project));
  const events = soundingEvents(project, { clipId: clip.id, includeMuted: true }).events;
  const notes = currentNotes();
  assert.equal(events.length, notes.length);
  const byIndex = new Map(events.map((event) => [event.sourceIndex, event]));
  for (const [index, note] of notes.entries()) {
    assert(isWholeRecordingTick(note.startBeat), 'start on a whole tick');
    assert(isWholeRecordingTick(note.durationBeats), 'length in whole ticks');
    const absolute = clip.startBeat + note.startBeat;
    assert(absolute >= (loop?.startBeat ?? clip.startBeat), 'start inside the clip and loop');
    assert(note.durationBeats >= 1 / PPQ, 'at least one tick');
    assert(absolute + note.durationBeats <= effectiveEnd + 1e-10, 'stored end inside the range');
    const placed = placedNoteTicks(clip, note, { swing: project.swing, songEnd: songEndBeat(project) });
    const sound = byIndex.get(index);
    assert(sound?.kind === 'note', 'each stored note sounds');
    assert.equal(sound.pitch, note.pitch);
    assert.equal(sound.velocity, note.velocity);
    assert.equal(beatTick(sound.startBeat), placed.startTick);
    assert.equal(beatTick(sound.startBeat + sound.durationBeats), placed.endTick);
    assert(placed.endTick > placed.startTick, 'positive sounding length');
    assert(sound.startBeat + sound.durationBeats <= effectiveEnd + 1e-10, 'sounding end inside the range');
  }
}

it('preserves placement, playback and Undo in 500 seeded step, chord and capture sequences', () => {
  const random = seededRandom(0x036);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100_000);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const store = useStore.getState();
  const base = createDefaultProject();
  const track = base.tracks[0]!;
  let totalStepNotes = 0;
  let totalCapturedNotes = 0;
  let chordCount = 0;
  let rejectedSteps = 0;
  try {
    for (let trial = 0; trial < 500; trial++) {
      const clip = {
        ...track.clips[0]!, notes: [],
        startBeat: random(900) / PPQ,
        lengthBeats: (120 + random(1900) + random(10) / 10) / PPQ,
      };
      const loopStart = clip.startBeat + random(120) / PPQ;
      const loopRange = trial % 3 === 0
        ? { startBeat: beatTick(loopStart) / PPQ, endBeat: (beatTick(loopStart) + PPQ + random(1200)) / PPQ }
        : undefined;
      store.loadProjectForPreview({
        ...base, bpm: 60 + random(181), swing: random(61), lengthBars: 1, loopRange,
        tracks: [{ ...track, mute: trial % 2 === 0, clips: [clip] }],
      });
      if (loopRange) store.toggleLoop();
      store.setPosition((beatTick(clip.startBeat) + random(900)) / PPQ);
      let cursor: number | undefined;
      for (let step = 0; step < 6; step++) {
        const snap = [1 / 6, 0.25, 1 / 3, 0.5, 1, 2][random(6)]!;
        store.setGridSnap(snap);
        const position = prepareStepInput(cursor);
        if (!position) {
          rejectedSteps++;
          continue;
        }
        const previous = currentNotes();
        const pitches = new Map<number, number>();
        const keys = random(4);
        for (let key = 0; key < keys; key++) pitches.set(40 + key * 12 + random(12), 1 + random(127));
        cursor = position.nextTick;
        assert(Number.isInteger(cursor) && cursor > position.tick, 'cursor advances in whole ticks');
        if (pitches.size) writeStepInputChord(position, pitches);
        const added = currentNotes().slice(previous.length);
        if (added.length > 1) chordCount++;
        totalStepNotes += added.length;
        assert(added.every((note) => beatTick(note.startBeat + clip.startBeat) === position.tick), 'chord shares an onset');
        assert(added.every((note) => note.durationBeats <= snap), 'length at most the current snap');
        expectEveryNoteToSound();
        for (const _ of added) store.undo();
        assert.equal(currentNotes(), previous);
        for (const _ of added) store.redo();
      }

      const beforeCapture = useStore.getState().project;
      const lengthBefore = currentNotes().length;
      const captures = 1 + random(5);
      for (let input = 0; input < captures; input++) {
        const time = 97_500 + input * 500 + random(200);
        const pitch = 80 + input;
        store.setPosition(clip.startBeat + random(1400) / PPQ);
        captureLiveNote(pitch, true, 50 + random(78), time);
        if (random(2)) captureLiveNote(pitch, false, undefined, time + 30 + random(150));
      }
      if (captureLastPerformance()) {
        totalCapturedNotes += currentNotes().length - lengthBefore;
        expectEveryNoteToSound();
        store.undo();
      }
      assert.equal(useStore.getState().project, beforeCapture);
    }
    expect(totalStepNotes).toBeGreaterThan(500);
    expect(totalCapturedNotes).toBeGreaterThan(100);
    expect(chordCount).toBeGreaterThan(100);
    expect(rejectedSteps).toBeGreaterThan(100);
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    clock.mockRestore();
  }
});
