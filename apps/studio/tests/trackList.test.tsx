import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let TrackList: typeof import('../src/features/tracklist/TrackList')['TrackList'];
let focusTrackAddControl: typeof import('../src/features/tracklist/trackPresentation')['focusTrackAddControl'];
let accessibleTrackName: typeof import('../src/features/tracklist/trackPresentation')['accessibleTrackName'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ TrackList } = await import('../src/features/tracklist/TrackList'));
  ({ accessibleTrackName, focusTrackAddControl } = await import('../src/features/tracklist/trackPresentation'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('トラック一覧検証')).toBe(true);
});

describe('TrackList mixer controls', () => {
  it('exposes an ordered track list and a named add control', () => {
    const html = renderToStaticMarkup(<TrackList />);
    expect(html).toContain('<nav class="track-list" aria-label="トラック一覧">');
    expect(html).toContain('<ol class="track-list__items">');
    expect(html).toContain('>＋ 追加</button>');
    expect(html).toContain('id="track-selection:');
  });

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

  it('disambiguates same-name track controls without changing visible names', () => {
    const tracks = useStore.getState().project.tracks;
    const first = tracks[0];
    const second = tracks[1];
    if (!first || !second) throw new Error('track fixtures missing');
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === first.id || track.id === second.id
          ? { ...track, name: 'Harmony' }
          : track,
      ),
    }))).toBe(true);
    Object.assign(useStore.getInitialState(), useStore.getState());

    const html = renderToStaticMarkup(<TrackList />);
    expect(html).toContain('aria-label="Harmony（同名 1/2） トラックを選択"');
    expect(html).toContain('aria-label="Harmony（同名 2/2） トラックを選択"');
    expect(html.match(/<span class="track-row__name">Harmony<\/span>/g)).toHaveLength(2);
  });

  it('can restore focus to Add when a valid legacy project has no remaining row', () => {
    const focus = vi.fn();
    vi.useFakeTimers();
    vi.stubGlobal('document', {
      getElementById: (id: string) => (id === 'track-add-control' ? { focus } : null),
    });

    try {
      focusTrackAddControl();
      vi.runOnlyPendingTimers();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('normalizes visually equivalent whitespace and blank imported names for assistive labels', () => {
    const tracks = useStore.getState().project.tracks;
    const first = tracks[0];
    const second = tracks[1];
    if (!first || !second) throw new Error('track fixtures missing');
    const whitespaceTracks = [
      { ...first, name: 'Harmony X' },
      { ...second, name: '  Harmony   X  ' },
    ];
    expect(accessibleTrackName(whitespaceTracks, whitespaceTracks[0]!)).toBe(
      'Harmony X（同名 1/2）',
    );
    expect(accessibleTrackName(whitespaceTracks, whitespaceTracks[1]!)).toBe(
      'Harmony X（同名 2/2）',
    );

    const blankTracks = [
      { ...first, name: '' },
      { ...second, name: '   ' },
    ];
    expect(accessibleTrackName(blankTracks, blankTracks[0]!)).toBe('名前なし（同名 1/2）');
    expect(accessibleTrackName(blankTracks, blankTracks[1]!)).toBe('名前なし（同名 2/2）');
  });
});
