// P34 review item 4: no tool shares an open transaction's undo step.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PPQ, createEmptyProject, type Clip, type NoteEvent, type Project, type Track } from '@cts/project-model';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { installLocalStorage } from './localStorageStub';
import {
  joinNotesInProject,
  legatoNotesInProject,
  staccatoNotesInProject,
} from '../src/state/noteToolActions';
import type { NoteEditOutcome } from '../src/state/noteEditActions';

let useStore: typeof import('../src/state/store')['useStore'];
let tools: typeof import('../src/state/noteToolActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  tools = await import('../src/state/noteToolActions');
});

type Spec = [pitch: number, startBeat: number, durationBeats?: number];
function song(specs: readonly Spec[], over: { loop?: boolean; swing?: number } = {}): Project {
  const base = createEmptyProject({ key: 'C', scale: 'major' });
  const tracks = base.tracks.map((track): Track => {
    if (track.type === 'instrument' && track.role === 'learning.melody') {
      const clip: Clip = {
        id: 'mel', trackId: track.id, type: 'midi', startBeat: 0, lengthBeats: 8, loop: over.loop ?? false,
        notes: specs.map(([pitch, startBeat, durationBeats = 1], i) => ({ id: `n${i}`, pitch, startBeat, durationBeats, velocity: 90 })),
      };
      return { ...track, clips: [clip] };
    }
    return track.type === 'master' ? track : { ...track, clips: [] };
  });
  return { ...base, tracks, chordTrack: [], swing: over.swing ?? 0 };
}
const notesOf = (p: Project): NoteEvent[] => p.tracks.flatMap((t) => t.clips).find((c) => c.id === 'mel')!.notes ?? [];
function ok(o: NoteEditOutcome): Extract<NoteEditOutcome, { ok: true }> {
  if (!o.ok) throw new Error(o.reason);
  return o;
}
/** Sounding spans (tick) of the notes with the given pitches, in time order. */
function sounding(p: Project, pitch: number): Array<[number, number]> {
  return buildScheduleEvents(p)
    .filter((e) => (e.payload as SchedulePayload).kind === 'note' && (e.payload as { pitch: number }).pitch === pitch)
    .map((e) => [Math.round(e.beat * PPQ), Math.round((e.beat + (e.payload as { durationBeats: number }).durationBeats) * PPQ)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

describe('item 4: no tool shares an open transaction', () => {
  beforeEach(() => {
    useStore.setState({
      project: { ...song([[60, 0, 0.5], [62, 1, 0.5]]), id: useStore.getState().project.id },
      past: [], future: [], audioRecordingOperationId: null, midiRecordingActive: false, projectOperationBusy: false,
    });
  });
  it('refuses every tool with a Japanese reason while a transaction is open', () => {
    const token = {};
    expect(useStore.getState().beginProjectTransaction(token)).toBe(true);
    const before = useStore.getState().project;
    for (const result of [
      tools.legatoSelectedNotes('mel', ['n0', 'n1']),
      tools.staccatoSelectedNotes('mel', ['n0']),
      tools.joinSelectedNotes('mel', ['n0']),
      tools.splitSelectedNotesAtPlayhead('mel', ['n0']),
      tools.nudgeSelectedNotes('mel', ['n0'], 1, 0.25),
      tools.rampSelectedVelocity('mel', ['n0', 'n1'], 10, 20),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toBe('ほかの操作が終わってから試してください。');
    }
    expect(useStore.getState().project).toBe(before);
    useStore.getState().cancelProjectTransaction(token);
    expect(tools.legatoSelectedNotes('mel', ['n0', 'n1']).ok).toBe(true);
  });
});

