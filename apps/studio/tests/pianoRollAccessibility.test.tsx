import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('キーボード検証')).toBe(true);
});

describe('PianoRoll accessibility rendering', () => {
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
