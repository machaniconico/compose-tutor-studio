// P34 review item 6: legato is defined in sounding time.
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

describe('item 6: legato is defined in sounding time', () => {
  it('leaves no gap and no overlap between swung notes', () => {
    for (const swing of [0, 33, 60]) {
      const p = song([[60, 0, 0.1], [61, 0.25, 0.1], [62, 0.5, 0.1], [63, 0.75, 0.1], [64, 1.25, 0.1]], { swing });
      const out = ok(legatoNotesInProject(p, 'mel', ['n0', 'n1', 'n2', 'n3', 'n4']));
      const spans = [60, 61, 62, 63, 64].map((pitch) => sounding(out.project, pitch)[0]!);
      for (let i = 0; i < 4; i += 1) expect(spans[i]![1]).toBe(spans[i + 1]![0]);
    }
  });
  it('under swing the authored length is not the authored gap', () => {
    const p = song([[60, 0, 0.1], [61, 0.25, 0.1]], { swing: 60 });
    const out = ok(legatoNotesInProject(p, 'mel', ['n0', 'n1']));
    expect(notesOf(out.project)[0]!.durationBeats * PPQ).toBe(192); // 0.25 + 0.15 swing delay = 0.4 beat
  });
});

