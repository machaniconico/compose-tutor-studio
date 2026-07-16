import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { compileMusicalTime } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];
let pianoRollBarGuideBeats: typeof import('../src/features/pianoRoll/PianoRoll')['pianoRollBarGuideBeats'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ PianoRoll, pianoRollBarGuideBeats } = await import('../src/features/pianoRoll/PianoRoll'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('キーボード検証')).toBe(true);
});

describe('PianoRoll accessibility rendering', () => {
  it('places bar guides at the actual boundaries of a time-signature map', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 14,
      tempoMap: [{ id: 'tempo', beat: 0, bpm: 120 }],
      timeSignatureMap: [
        { id: 'signature-four-four', beat: 0, numerator: 4, denominator: 4 },
        { id: 'signature-three-four', beat: 8, numerator: 3, denominator: 4 },
      ],
    });

    expect(pianoRollBarGuideBeats(musicalTime, 0, 14)).toEqual([0, 4, 8, 11, 14]);
  });

  it('converts project bar boundaries into a moved clip local coordinates', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 16,
      tempoMap: [{ id: 'tempo', beat: 0, bpm: 120 }],
      timeSignatureMap: [
        { id: 'signature-three-four', beat: 0, numerator: 3, denominator: 4 },
        { id: 'signature-five-four', beat: 6, numerator: 5, denominator: 4 },
      ],
    });

    expect(pianoRollBarGuideBeats(musicalTime, 6, 10)).toEqual([0, 5, 10]);
    expect(pianoRollBarGuideBeats(musicalTime, 5, 7)).toEqual([1, 6]);
  });

  it('keeps the grid reachable when a valid imported note is outside the visible pitch range', () => {
    const clip = useStore
      .getState()
      .project.tracks.find((track) => track.name === 'Melody')
      ?.clips.find((candidate) => candidate.type === 'midi');
    expect(clip).toBeDefined();
    useStore.getState().selectClip(clip?.id ?? null);
    useStore.getState().addNote(clip?.id ?? '', {
      pitch: 20,
      startBeat: 0,
      durationBeats: 1,
      velocity: 90,
    });
    const hiddenNoteId = useStore
      .getState()
      .project.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clip?.id)?.notes?.[0]?.id;
    useStore.getState().selectNotes(hiddenNoteId ? [hiddenNoteId] : []);

    const html = renderToStaticMarkup(<PianoRoll />);

    expect(html).toMatch(/class="pr__grid"[^>]*tabindex="0"/);
    expect(html).not.toContain('class="pr__note"');
    expect(html).toMatch(/選択ノートをクオンタイズ<\/button>/);
    expect(html).toMatch(/disabled=""[^>]*>選択ノートをクオンタイズ/);
  });
});
