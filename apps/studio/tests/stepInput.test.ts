// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PPQ, type Clip, type Project } from '@cts/project-model';
import { buildScheduleEvents } from '../src/audio/events';
import { installLocalStorage } from './localStorageStub';
import { stepInsertNoteInProject } from '../src/state/noteEditActions';

let useStore: typeof import('../src/state/store')['useStore'];
let step: typeof import('../src/state/stepInput');

beforeAll(async () => {
  const locks = { request: async (_n: string, _o: unknown, cb: () => unknown) => cb() };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  step = await import('../src/state/stepInput');
});

beforeEach(async () => {
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
  expect(await useStore.getState().createNewProject('ステップ')).toBe(true);
  step.stopStepInput();
});

afterEach(async () => {
  step.stopStepInput();
  await useStore.getState().flushPendingSave();
});

function melody(project: Project = useStore.getState().project): Clip {
  const clip = project.tracks.find((track) => track.name === 'Melody')?.clips[0];
  if (!clip) throw new Error('fixture');
  return clip;
}
const notes = () => melody().notes ?? [];

function seeded(seed: number) {
  return (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 0x1_0000_0000) * limit);
  };
}

describe('stepInsertNoteInProject', () => {
  it('places a note at the cursor with the step length', () => {
    const project = useStore.getState().project;
    const clip = melody(project);
    const out = stepInsertNoteInProject(project, clip.id, 60, PPQ, PPQ / 2);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const added = melody(out.project).notes!.find((n) => n.id === out.noteIds[0])!;
    expect(added.startBeat).toBe(1);
    expect(added.durationBeats).toBe(0.5);
  });

  it('refuses past the clip end without growing the clip', () => {
    const project = useStore.getState().project;
    const clip = melody(project);
    const end = Math.round(clip.lengthBeats * PPQ);
    const out = stepInsertNoteInProject(project, clip.id, 60, end - 10, PPQ / 2);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('クリップの終わり');
  });

  it('refuses a clip that starts on a fractional tick', () => {
    const project = useStore.getState().project;
    const clip = melody(project);
    const moved: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clip.id ? { ...c, startBeat: 0.0013 } : c)),
      })),
    };
    expect(stepInsertNoteInProject(moved, clip.id, 60, 0, PPQ).ok).toBe(false);
  });

  it('refuses a same-pitch overlap and bad pitch', () => {
    useStore.getState().addNote(melody().id, { pitch: 60, startBeat: 0, durationBeats: 2, velocity: 90 });
    const project = useStore.getState().project;
    expect(stepInsertNoteInProject(project, melody().id, 60, PPQ, PPQ).ok).toBe(false);
    expect(stepInsertNoteInProject(project, melody().id, 200, 0, PPQ).ok).toBe(false);
    expect(stepInsertNoteInProject(project, melody().id, 61, 0, PPQ).ok).toBe(true);
  });
});

describe('step input session', () => {
  it('advances by the step, rests, and each note is its own undo step', () => {
    const clipId = melody().id;
    const before = notes().length;
    expect(step.startStepInput(clipId).ok).toBe(true);
    step.setStepLength(PPQ / 2);
    expect(step.stepInputPlay(60).ok).toBe(true);
    expect(step.stepInputRest().ok).toBe(true);
    expect(step.stepInputPlay(62).ok).toBe(true);
    expect(step.useStepInput.getState().cursorTicks).toBe(PPQ / 2 * 3);
    const added = notes().slice(before);
    expect(added.map((n) => [n.pitch, n.startBeat])).toEqual([[60, 0], [62, 0.5 * 2]]);
    useStore.getState().undo();
    expect(notes().length).toBe(before + 1);
    useStore.getState().undo();
    expect(notes().length).toBe(before);
  });

  it('backspace removes the last note and steps back; rest steps back without touching notes', () => {
    step.startStepInput(melody().id);
    step.setStepLength(PPQ);
    step.stepInputPlay(60);
    step.stepInputRest();
    const count = notes().length;
    expect(step.stepInputBack().ok).toBe(true);
    expect(notes().length).toBe(count);
    expect(step.useStepInput.getState().cursorTicks).toBe(PPQ);
    expect(step.stepInputBack().ok).toBe(true);
    expect(notes().length).toBe(count - 1);
    expect(step.useStepInput.getState().cursorTicks).toBe(0);
    expect(step.stepInputBack().ok).toBe(false);
  });

  it('backspace after undo only moves the cursor back', () => {
    step.startStepInput(melody().id);
    step.stepInputPlay(60);
    useStore.getState().undo();
    expect(step.stepInputBack().ok).toBe(true);
    expect(step.useStepInput.getState().cursorTicks).toBe(0);
  });

  it('refuses while recording and stops at the clip end', () => {
    step.startStepInput(melody().id);
    useStore.setState({ audioRecordingOperationId: 1 });
    expect(step.stepInputPlay(60).ok).toBe(false);
    expect(step.stepInputRest().ok).toBe(false);
    expect(step.startStepInput(melody().id).ok).toBe(false);
    useStore.setState({ audioRecordingOperationId: null });
    const end = Math.round(melody().lengthBeats * PPQ);
    step.setStepLength(PPQ);
    useStepCursor(end - PPQ / 2);
    const r = step.stepInputRest();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('クリップの終わり');
    expect(step.useStepInput.getState().cursorTicks).toBe(end - PPQ / 2);
  });

  it('is off for a non-MIDI target and stops cleanly', () => {
    expect(step.startStepInput('nope').ok).toBe(false);
    expect(step.stepInputPlay(60).ok).toBe(false);
  });
});

function useStepCursor(ticks: number): void {
  step.useStepInput.setState({ cursorTicks: ticks });
}

describe('MIDI take (P42)', () => {
  it('refuses to start, insert, rest and step back while a MIDI take is active', () => {
    const clipId = melody().id;
    step.startStepInput(clipId);
    step.stepInputPlay(60);
    const count = notes().length;
    useStore.setState({ midiRecordingActive: true });
    try {
      expect(step.startStepInput(clipId).ok).toBe(false);
      for (const r of [step.stepInputPlay(62), step.stepInputRest(), step.stepInputBack()]) {
        expect(r.ok).toBe(false);
        expect(r.message).toContain('録音');
      }
      expect(notes().length).toBe(count);
      expect(step.useStepInput.getState().cursorTicks).toBe(step.useStepInput.getState().stepTicks);
    } finally {
      useStore.setState({ midiRecordingActive: false });
    }
  });
});

describe('Backspace identity', () => {
  const patchNotes = (fn: (list: NonNullable<Clip['notes']>) => NonNullable<Clip['notes']>): void => {
    const id = melody().id;
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === id ? { ...c, notes: fn(c.notes ?? []) } : c)),
      })),
    }));
  };

  it('does not delete a step-input note that was moved afterwards', () => {
    step.startStepInput(melody().id);
    step.stepInputPlay(60);
    const inserted = notes().at(-1)!;
    patchNotes((list) => list.map((n) => (n.id === inserted.id ? { ...n, startBeat: n.startBeat + 2 } : n)));
    const count = notes().length;
    const r = step.stepInputBack();
    expect(notes().length).toBe(count);
    expect(r.message).toContain('入力したあとに変わった音なので消しません');
    expect(step.useStepInput.getState().cursorTicks).toBe(0);
  });

  it('does not delete a different note that reuses the undone note id', () => {
    step.startStepInput(melody().id);
    step.stepInputPlay(60);
    const inserted = notes().at(-1)!;
    useStore.getState().undo();
    patchNotes((list) => [...list, { ...inserted, pitch: 62 }]);
    const count = notes().length;
    const r = step.stepInputBack();
    expect(notes().length).toBe(count);
    expect(r.message).toContain('入力したあとに変わった音なので消しません');
  });
});

describe('seeded fuzz', () => {
  it('keeps the schedule sane and every undo exact over 200 sequences', () => {
    const random = seeded(0x43);
    const clipId = melody().id;
    for (let round = 0; round < 200; round++) {
      step.startStepInput(clipId);
      const baseCount = notes().length;
      const lengths = step.STEP_LENGTHS;
      let applied = 0;
      for (let i = 0; i < 12; i++) {
        step.setStepLength(lengths[random(lengths.length)]!.ticks);
        const r = random(5);
        if (r === 0) step.stepInputRest();
        else if (r === 1) { const b = step.stepInputBack(); void b; }
        else {
          const before = notes().length;
          if (step.stepInputPlay(48 + random(24)).ok) applied++;
          expect(notes().length).toBeLessThanOrEqual(before + 1);
        }
        const cursor = step.useStepInput.getState().cursorTicks;
        expect(Number.isInteger(cursor) && cursor >= 0).toBe(true);
        const events = buildScheduleEvents(useStore.getState().project);
        expect(events.every((e) => Number.isFinite(e.beat) && e.beat >= 0)).toBe(true);
      }
      for (const n of notes()) {
        expect(Number.isInteger(Math.round(n.startBeat * PPQ)) && Math.round(n.startBeat * PPQ) / PPQ === n.startBeat).toBe(true);
        expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(melody().lengthBeats + 1e-9);
      }
      void applied;
      step.stopStepInput();
      for (let g = 0; g < 40; g++) {
        if (notes().length === baseCount) break;
        useStore.getState().undo();
      }
      expect(notes().length).toBe(baseCount);
    }
  });
});
