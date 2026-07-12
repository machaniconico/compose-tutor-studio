import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installLocalStorage } from './localStorageStub';
import { addTrackEffect } from '../src/state/editorActions';

let useStore: typeof import('../src/state/store')['useStore'];
let MixerStrip: typeof import('../src/features/mixer/MixerStrip')['MixerStrip'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ MixerStrip } = await import('../src/features/mixer/MixerStrip'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('ミキサー読み上げ検証')).toBe(true);
});

describe('Mixer mute/solo accessibility', () => {
  it('exposes a named disclosure for the mixer controls', () => {
    const html = renderToStaticMarkup(<MixerStrip />);
    const controlsId = html.match(/aria-controls="([^"]+)"/)?.[1];

    expect(controlsId).toBeDefined();
    expect(html).toContain('aria-label="ミキサーをたたむ"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`id="${controlsId}"`);
  });

  it('names every control with its owning track and omits Master toggles', () => {
    const html = renderToStaticMarkup(<MixerStrip />);
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

  it('gives repeated effects unique track-scoped groups and control names', () => {
    const chords = useStore.getState().project.tracks.find((track) => track.name === 'Chords');
    expect(chords).toBeDefined();
    expect(addTrackEffect(chords?.id ?? '', 'filter')).not.toBeNull();
    expect(addTrackEffect(chords?.id ?? '', 'filter')).not.toBeNull();
    Object.assign(useStore.getInitialState(), useStore.getState());

    const html = renderToStaticMarkup(<MixerStrip />);
    for (const ordinal of [1, 2]) {
      expect(html).toContain(`aria-label="Chords フィルター ${ordinal}"`);
      expect(html).toContain(`aria-label="Chords フィルター ${ordinal}を削除"`);
      expect(html).toContain(`aria-label="Chords フィルター ${ordinal} 明るさ"`);
      expect(html).toContain(`aria-label="Chords フィルター ${ordinal} くせ"`);
    }
  });
});
