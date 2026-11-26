// ops.quantize / ops.undo through the studio store (editor actions), per the plan.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from '../localStorageStub';
import { soundingEvents } from '../../../../packages/project-model/src/sounding';
import { drumClip, makeProject, makeTrack, midiClip } from '../../../../packages/project-model/tests/acceptance/helpers';
import type { Clip, Project } from '@cts/project-model';

let useStore: typeof import('../../src/state/store')['useStore'];
let actions: typeof import('../../src/state/editorActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../../src/state/store'));
  actions = await import('../../src/state/editorActions');
});

const clipOf = (p: Project, id: string): Clip => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id) as Clip;
const load = (p: Project): void => useStore.getState().replaceProject(p);
const count = (p: Project): number => soundingEvents(p).events.length;

describe('ops.quantize', () => {
  it('ops.quantize: 発音数が減らず、クリップ長が不変(ループ: 1 周目の最後のグリッドに留める)', () => {
    // The note at 1.9 would round to 2.0, the loop period end, where it would vanish.
    load(makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 8, [[0.1, 0.5, 60], [1.9, 0.5, 62]], { loop: true, contentLengthBeats: 2 })])]));
    const before = useStore.getState().project;
    actions.quantizeNotes('a', ['a-n0', 'a-n1'], 1);
    const after = useStore.getState().project;
    expect(count(after)).toBeGreaterThanOrEqual(count(before));
    expect(clipOf(after, 'a').lengthBeats).toBe(8);
    expect(clipOf(after, 'a').contentLengthBeats).toBe(2);
    expect(clipOf(after, 'a').notes?.find((n) => n.id === 'a-n1')?.startBeat).toBe(1);
  });

  it('ops.quantize: 発音数が減らず、クリップ長が不変(通常クリップ: 終端を越える丸めは最後のグリッドに留める)', () => {
    load(makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[3.9, 0.5, 60]])])]));
    const before = useStore.getState().project;
    actions.quantizeNotes('a', ['a-n0'], 1);
    const after = useStore.getState().project;
    expect(count(after)).toBeGreaterThanOrEqual(count(before));
    expect(clipOf(after, 'a').lengthBeats).toBe(4);
    expect(clipOf(after, 'a').notes?.[0]?.startBeat).toBe(3);
  });
});

describe('ops.undo', () => {
  beforeEach(() => {
    load(
      makeProject([
        makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0.1, 1, 60], [2, 1, 62]]), midiClip('b', 't', 8, 4, [[0, 1, 64]])]),
        makeTrack('d', 'drum', [drumClip('x', 'd', 0, 4, [[0, 'kick']])]),
      ]),
    );
  });

  const operations: Array<[string, () => void]> = [
    ['duplicate(copy)', () => void actions.duplicateClipInSong('a', 'copy', 64)],
    ['duplicate(link)', () => void actions.duplicateClipInSong('a', 'link', 64)],
    ['remove', () => actions.removeClipFromSong('a')],
    ['split', () => void actions.splitClipAtBeat('a', 2)],
    ['quantize', () => actions.quantizeNotes('a', ['a-n0'], 1)],
  ];

  for (const [name, run] of operations) {
    it(`ops.undo: ${name} は past が 1 増え、undo 後は deepEqual`, () => {
      const before = useStore.getState().project;
      const pastBefore = useStore.getState().past.length;
      run();
      expect(useStore.getState().project).not.toEqual(before);
      expect(useStore.getState().past.length).toBe(pastBefore + 1);
      useStore.getState().undo();
      expect(useStore.getState().project).toEqual(before);
    });
  }
});
