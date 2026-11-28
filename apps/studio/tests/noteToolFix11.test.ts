// P34 review item 11: legato / join refuse on a looping clip when swing moves the selected notes.
import { describe, expect, it } from 'vitest';
import { createEmptyProject, type Clip, type Project, type Track } from '@cts/project-model';
import { joinNotesInProject, legatoNotesInProject } from '../src/state/noteToolActions';

type Spec = [pitch: number, startBeat: number, durationBeats: number];
function song(specs: readonly Spec[], over: { loop: boolean; swing: number }): Project {
  const base = createEmptyProject({ key: 'C', scale: 'major' });
  const tracks = base.tracks.map((track): Track => {
    if (track.type === 'instrument' && track.role === 'learning.melody') {
      const clip: Clip = {
        id: 'mel', trackId: track.id, type: 'midi', startBeat: 0, lengthBeats: 8, loop: over.loop,
        notes: specs.map(([pitch, startBeat, durationBeats], i) => ({ id: `n${i}`, pitch, startBeat, durationBeats, velocity: 90 })),
      };
      return { ...track, clips: [clip] };
    }
    return track.type === 'master' ? track : { ...track, clips: [] };
  });
  return { ...base, tracks, chordTrack: [], swing: over.swing };
}

const REASON = 'ループしているクリップにスイングがかかっているため、この操作はできません';
const reasonOf = (o: { ok: boolean; reason?: string }) => (o.ok ? '' : o.reason);

describe('looping clip with swing', () => {
  const legatoSpecs: Spec[] = [[60, 0, 0.1], [61, 0.25, 0.1], [62, 1.25, 0.1]];
  const joinSpecs: Spec[] = [[60, 0, 0.5], [60, 0.25, 0.25]];

  it('refuses legato and join with the Japanese reason', () => {
    expect(reasonOf(legatoNotesInProject(song(legatoSpecs, { loop: true, swing: 60 }), 'mel', ['n0', 'n1', 'n2']))).toContain(REASON);
    expect(reasonOf(joinNotesInProject(song(joinSpecs, { loop: true, swing: 60 }), 'mel', ['n0', 'n1']))).toContain(REASON);
  });
  it('keeps the current behaviour for single-pass clips and for loops without swing', () => {
    expect(legatoNotesInProject(song(legatoSpecs, { loop: false, swing: 60 }), 'mel', ['n0', 'n1', 'n2']).ok).toBe(true);
    expect(joinNotesInProject(song(joinSpecs, { loop: false, swing: 60 }), 'mel', ['n0', 'n1']).ok).toBe(true);
    expect(legatoNotesInProject(song(legatoSpecs, { loop: true, swing: 0 }), 'mel', ['n0', 'n1', 'n2']).ok).toBe(true);
    expect(joinNotesInProject(song([[60, 0, 1], [60, 1, 1]], { loop: true, swing: 0 }), 'mel', ['n0', 'n1']).ok).toBe(true);
  });
  it('allows a loop with swing when the selected notes sit on unswung positions', () => {
    const out = legatoNotesInProject(song([[60, 0, 0.1], [61, 1, 0.1], [62, 2, 0.1]], { loop: true, swing: 60 }), 'mel', ['n0', 'n1']);
    expect(out.ok).toBe(true);
  });
});
