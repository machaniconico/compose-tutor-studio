// P34 root fix 12: the loop + swing refusal must look at every pass, not only the first.
import { describe, expect, it } from 'vitest';
import { createEmptyProject, type Clip, type Project, type Track } from '@cts/project-model';
import { joinNotesInProject, legatoNotesInProject } from '../src/state/noteToolActions';

type Spec = [pitch: number, startBeat: number, durationBeats: number];
function song(specs: readonly Spec[], swing: number): Project {
  const base = createEmptyProject({ key: 'C', scale: 'major' });
  const tracks = base.tracks.map((track): Track => {
    if (track.type === 'instrument' && track.role === 'learning.melody') {
      const clip: Clip = {
        id: 'mel', trackId: track.id, type: 'midi', startBeat: 0, lengthBeats: 3, loop: true,
        notes: specs.map(([pitch, startBeat, durationBeats], i) => ({ id: `n${i}`, pitch, startBeat, durationBeats, velocity: 90 })),
      };
      return { ...track, clips: [clip] };
    }
    return track.type === 'master' ? track : { ...track, clips: [] };
  });
  return { ...base, tracks, chordTrack: [], swing };
}

const REASON = 'ループしているクリップにスイングがかかっているため、この操作はできません';
const reasonOf = (o: { ok: boolean; reason?: string }) => (o.ok ? '' : o.reason);

describe('loop + swing refusal covers later passes', () => {
  // 周期 0.75 拍: 1 周目の 0 / 0.5 はスイングで動かないが、2 周目の 0.75 / 1.25 は動く。
  const specs: Spec[] = [[60, 0, 0.1], [62, 0.5, 0.1], [64, 0.5, 0.25]];

  it('refuses legato when only a later pass is swung', () => {
    expect(reasonOf(legatoNotesInProject(song(specs, 60), 'mel', ['n0', 'n1']))).toContain(REASON);
  });
  it('refuses join when only a later pass is swung', () => {
    const joinSpecs: Spec[] = [[60, 0, 0.25], [60, 0.25, 0.25], [64, 0, 0.75]];
    expect(reasonOf(joinNotesInProject(song(joinSpecs, 60), 'mel', ['n0', 'n1']))).toContain(REASON);
  });
  it('still allows the same loop without swing', () => {
    expect(legatoNotesInProject(song(specs, 0), 'mel', ['n0', 'n1']).ok).toBe(true);
  });
});
