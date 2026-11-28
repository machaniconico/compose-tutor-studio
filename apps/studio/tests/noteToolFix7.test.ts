// P34 review item 7: join only merges notes whose sounding spans touch.
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

describe('item 7: join only merges notes whose sounding spans touch', () => {
  it('refuses when swing opens a gap between notes that touch as authored', () => {
    const p = song([[60, 0, 0.25], [60, 0.25, 0.25]], { swing: 60 });
    expect(joinNotesInProject(p, 'mel', ['n0', 'n1']).ok).toBe(false);
  });
  it('merges when the sounding spans overlap, with length = last sounding end - first sounding start', () => {
    const p = song([[60, 0, 0.5], [60, 0.25, 0.25]], { swing: 60 });
    const before = sounding(p, 60);
    const out = ok(joinNotesInProject(p, 'mel', ['n0', 'n1']));
    expect(notesOf(out.project).map((n) => n.id)).toEqual(['n0']);
    expect(sounding(out.project, 60)).toEqual([[before[0]![0], before[1]![1]]]);
  });
  it('without swing it is unchanged: touching notes merge', () => {
    const out = ok(joinNotesInProject(song([[60, 0, 1], [60, 1, 1]]), 'mel', ['n0', 'n1']));
    expect(notesOf(out.project)[0]!.durationBeats).toBe(2);
  });
});

