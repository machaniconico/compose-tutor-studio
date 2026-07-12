import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let TrackList: typeof import('../src/features/tracklist/TrackList')['TrackList'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ TrackList } = await import('../src/features/tracklist/TrackList'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('トラック一覧検証')).toBe(true);
});

describe('TrackList mixer controls', () => {
  it('uses the project-model 0..2 volume range for every track', () => {
    const html = renderToStaticMarkup(<TrackList />);
    const ranges = html.match(/<input[^>]*type="range"[^>]*>/g) ?? [];

    expect(ranges).toHaveLength(useStore.getState().project.tracks.length);
    expect(ranges.every((range) => range.includes('min="0"') && range.includes('max="2"'))).toBe(
      true,
    );
  });

  it('keeps master volume while omitting misleading master mute and solo controls', () => {
    const html = renderToStaticMarkup(<TrackList />);
    const masterStart = html.indexOf('aria-label="Master トラックを選択"');
    expect(masterStart).toBeGreaterThanOrEqual(0);
    const masterRowRemainder = html.slice(masterStart);

    expect(masterRowRemainder).toContain('aria-label="Master 音量"');
    expect(masterRowRemainder).not.toContain('title="ミュート"');
    expect(masterRowRemainder).not.toContain('title="ソロ"');

    const nonMasterCount = useStore
      .getState()
      .project.tracks.filter((track) => track.type !== 'master').length;
    expect(html.match(/title="ミュート"/g) ?? []).toHaveLength(nonMasterCount);
    expect(html.match(/title="ソロ"/g) ?? []).toHaveLength(nonMasterCount);
  });

  it('names every mute and solo control with its owning track', () => {
    const html = renderToStaticMarkup(<TrackList />);
    const soundTracks = useStore.getState().project.tracks.filter(
      (track) => track.type !== 'master',
    );

    for (const track of soundTracks) {
      expect(html).toContain(`aria-label="${track.name} ミュート"`);
      expect(html).toContain(`aria-label="${track.name} ソロ"`);
    }
    expect(html).not.toContain('aria-label="Master ミュート"');
    expect(html).not.toContain('aria-label="Master ソロ"');
  });

  it('exposes the currently selected track as a pressed selection button', () => {
    const html = renderToStaticMarkup(<TrackList />);
    expect(html).toMatch(
      /<button[^>]*aria-label="Chords トラックを選択"[^>]*aria-pressed="true"/,
    );
    expect(html).toMatch(
      /<button[^>]*aria-label="Bass トラックを選択"[^>]*aria-pressed="false"/,
    );
  });
});
