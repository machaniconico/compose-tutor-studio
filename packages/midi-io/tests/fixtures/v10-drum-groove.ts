import type { DrumGrooveSettings } from '@cts/project-model';
import drumLoopAlias from '../../../project-model/tests/golden/fixtures/v10-drum-loop-alias.json';

function singleHitFixture(setting: Partial<DrumGrooveSettings>) {
  const project = structuredClone(drumLoopAlias);
  const drums = project.tracks.find((track) => track.type === 'drum')!;
  const clip = {
    ...drums.clips[0]!,
    drumEvents: [{ id: 'hat', lane: 'closedHat', stepIndex: 1, velocity: 70 }],
    drumGroove: { probability: 1, humanizeVelocity: 0, swing: 0, seed: 42, ...setting },
  };
  return {
    ...project,
    tracks: [{ ...drums, clips: [clip] }],
    audioRouting: {
      outputs: [{ sourceTrackId: drums.id, destination: { type: 'master' } }],
      sends: [],
    },
  };
}

export const v10DrumGrooveFixtures = {
  'drum-loop-alias': drumLoopAlias,
  probability: singleHitFixture({ probability: 0 }),
  humanize: singleHitFixture({ humanizeVelocity: 40 }),
  'clip-swing': singleHitFixture({ swing: 1 }),
};
