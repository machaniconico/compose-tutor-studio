import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installLocalStorage } from './localStorageStub';
import { addTrackEffect } from '../src/state/editorActions';

const studioStyles = readFileSync(
  new URL('../src/styles.css', import.meta.url),
  'utf8',
);

let useStore: typeof import('../src/state/store')['useStore'];
let MixerStrip: typeof import('../src/features/mixer/MixerStrip')['MixerStrip'];
let addStudioTrack: typeof import('../src/state/trackActions')['addStudioTrack'];
let addStudioAudioSend: typeof import('../src/state/routingActions')['addStudioAudioSend'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ MixerStrip } = await import('../src/features/mixer/MixerStrip'));
  ({ addStudioTrack } = await import('../src/state/trackActions'));
  ({ addStudioAudioSend } = await import('../src/state/routingActions'));
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
      expect(html).toContain(`aria-label="${track.name} 音量"`);
      expect(html).toContain(`aria-label="${track.name} パン"`);
      expect(html).toContain(`aria-label="${track.name} ミュート"`);
      expect(html).toContain(`aria-label="${track.name} ソロ"`);
    }
    expect(html.match(/トラックID /g) ?? []).toHaveLength(soundTracks.length);
    expect(html).not.toContain('aria-label="Master パン"');
    expect(html).not.toContain('mixer-automation-Master');
    expect(html).not.toContain('aria-label="Master ミュート"');
    expect(html).not.toContain('aria-label="Master ソロ"');
    expect(html).toContain('aria-label="マスター レベル RMS -∞ dB / Peak -∞ dB"');
  });

  it('computes at least 44px focusable volume and pan sliders', () => {
    const html = renderToStaticMarkup(<MixerStrip />);
    const sliders = html.match(/<input[^>]*type="range"[^>]*>/g) ?? [];
    const volumeRule = studioStyles.match(
      /\.mix-ch__volume\s*\{([^}]*)\}/,
    )?.[1] ?? '';
    const panRule = studioStyles.match(
      /\.mix-ch__pan input\s*\{([^}]*)\}/,
    )?.[1] ?? '';

    expect(sliders.length).toBeGreaterThan(0);
    expect(sliders.every((slider) => (
      !slider.includes('disabled=""') && !slider.includes('tabindex="-1"')
    ))).toBe(true);
    for (const declarations of [volumeRule, panRule]) {
      expect(Number(
        declarations.match(/min-height:\s*([\d.]+)px/)?.[1] ?? 0,
      )).toBeGreaterThanOrEqual(44);
    }
    expect(studioStyles).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*(?!none)[^;}]+;/,
    );
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

  it('disambiguates controls owned by same-name tracks', () => {
    const tracks = useStore.getState().project.tracks.filter((track) => track.type !== 'master');
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

    const html = renderToStaticMarkup(<MixerStrip />);
    expect(html).toContain('aria-label="Harmony（同名 1/2） 音量"');
    expect(html).toContain('aria-label="Harmony（同名 2/2） 音量"');
    expect(html).toContain('aria-label="Harmony（同名 1/2） パン"');
    expect(html).toContain('aria-label="Harmony（同名 2/2） パン"');
    expect(html).toContain('aria-label="Harmony（同名 1/2） ミュート"');
    expect(html).toContain('aria-label="Harmony（同名 2/2） ミュート"');
    expect(html).toContain(`トラックID ${first.id}`);
    expect(html).toContain(`トラックID ${second.id}`);
  });

  it('names Bus output and pre/post-fader send controls in beginner-facing language', () => {
    const source = useStore.getState().project.tracks.find(
      (track) => track.type !== 'master' && track.type !== 'bus',
    );
    if (!source) throw new Error('source fixture missing');
    const bus = addStudioTrack({ kind: 'bus', name: 'Vocal Bus' });
    if (!bus.ok) throw new Error('Bus fixture missing');
    const send = addStudioAudioSend(source.id, bus.trackId);
    if (!send.ok) throw new Error('send fixture missing');
    Object.assign(useStore.getInitialState(), useStore.getState());

    const html = renderToStaticMarkup(<MixerStrip />);
    expect(html).toContain('Vocal Bus（Bus）');
    expect(html).toContain(`aria-label="${source.name} 出力先"`);
    expect(html).toContain(`aria-label="${source.name} Vocal Busへのセンドの送り先"`);
    expect(html).toContain(`aria-label="${source.name} Vocal Busへのセンドを有効にする"`);
    expect(html).toContain(`aria-label="${source.name} Vocal Busへのセンドの位置"`);
    expect(html).toContain(`aria-label="${source.name} Vocal Busへのセンドの送り量"`);
    expect(html).toContain(`aria-label="${source.name} Vocal Busへのセンドを削除"`);
    expect(html).toContain('フェーダー前は音量・効果の前');
    expect(html).toContain('フェーダー後は音量・効果・パンの後');
  });

  it('disambiguates same-name Bus destinations in every send control', () => {
    const source = useStore.getState().project.tracks.find(
      (track) => track.type !== 'master' && track.type !== 'bus',
    );
    if (!source) throw new Error('source fixture missing');
    const first = addStudioTrack({ kind: 'bus', name: 'FX' });
    const second = addStudioTrack({ kind: 'bus', name: 'FX' });
    if (!first.ok || !second.ok) throw new Error('Bus fixtures missing');
    expect(addStudioAudioSend(source.id, first.trackId).ok).toBe(true);
    expect(addStudioAudioSend(source.id, second.trackId).ok).toBe(true);
    Object.assign(useStore.getInitialState(), useStore.getState());

    const html = renderToStaticMarkup(<MixerStrip />);
    for (const ordinal of [1, 2]) {
      const destination = `FX（同名 ${ordinal}/2）`;
      expect(html).toContain(`${source.name} ${destination}へのセンドの送り先`);
      expect(html).toContain(`${source.name} ${destination}へのセンドを有効にする`);
      expect(html).toContain(`${source.name} ${destination}へのセンドの位置`);
      expect(html).toContain(`${source.name} ${destination}へのセンドの送り量`);
      expect(html).toContain(`${source.name} ${destination}へのセンドを削除`);
    }
  });

  it('stops offering new sends at the per-source limit', () => {
    const source = useStore.getState().project.tracks.find(
      (track) => track.type !== 'master' && track.type !== 'bus',
    );
    if (!source) throw new Error('source fixture missing');
    for (let index = 0; index < 16; index += 1) {
      const bus = addStudioTrack({ kind: 'bus', name: `Bus ${index + 1}` });
      if (!bus.ok) throw new Error(`Bus fixture ${index + 1} missing`);
      if (!addStudioAudioSend(source.id, bus.trackId).ok) {
        throw new Error(`send fixture ${index + 1} missing`);
      }
    }
    Object.assign(useStore.getInitialState(), useStore.getState());

    const html = renderToStaticMarkup(<MixerStrip />);
    expect(html).not.toContain(`aria-label="${source.name} センドを追加"`);
    expect(html).toContain('1つのトラックから追加できるセンドは最大16件です。');
  });
});
