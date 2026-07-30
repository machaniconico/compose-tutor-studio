import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAudioTrackClip, type AudioClip, type ReadyAudioAsset } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

const studioStyles = readFileSync(
  new URL('../src/styles.css', import.meta.url),
  'utf8',
);

let useStore: typeof import('../src/state/store')['useStore'];
let TrackList: typeof import('../src/features/tracklist/TrackList')['TrackList'];
let MixerStrip: typeof import('../src/features/mixer/MixerStrip')['MixerStrip'];
let focusTrackAddControl: typeof import('../src/features/tracklist/trackPresentation')['focusTrackAddControl'];
let accessibleTrackName: typeof import('../src/features/tracklist/trackPresentation')['accessibleTrackName'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ TrackList } = await import('../src/features/tracklist/TrackList'));
  ({ MixerStrip } = await import('../src/features/mixer/MixerStrip'));
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

  it('uses model ranges for every volume and non-Master pan control', () => {
    const html = renderToStaticMarkup(<TrackList />);
    const ranges = html.match(/<input[^>]*type="range"[^>]*>/g) ?? [];
    const tracks = useStore.getState().project.tracks;
    const nonMasterTracks = tracks.filter((track) => track.type !== 'master');

    expect(ranges).toHaveLength(tracks.length + nonMasterTracks.length);
    expect(
      ranges.filter((range) => range.includes(' 音量"')).every(
        (range) => range.includes('min="0"') && range.includes('max="2"'),
      ),
    ).toBe(true);
    expect(
      ranges.filter((range) => range.includes(' パン"')).every(
        (range) => range.includes('min="-1"') && range.includes('max="1"'),
      ),
    ).toBe(true);
  });

  it('computes at least 44px focusable volume and pan sliders', () => {
    const html = renderToStaticMarkup(<TrackList />);
    const sliders = html.match(/<input[^>]*type="range"[^>]*>/g) ?? [];
    const declarations = studioStyles.match(
      /\.track-row__controls input\[type='range'\]\s*\{([^}]*)\}/,
    )?.[1] ?? '';

    expect(sliders.length).toBeGreaterThan(0);
    expect(sliders.every((slider) => (
      !slider.includes('disabled=""') && !slider.includes('tabindex="-1"')
    ))).toBe(true);
    expect(Number(
      declarations.match(/min-height:\s*([\d.]+)px/)?.[1] ?? 0,
    )).toBeGreaterThanOrEqual(44);
    expect(studioStyles).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*(?!none)[^;}]+;/,
    );
  });

  it('keeps master volume while omitting misleading master mute and solo controls', () => {
    const html = renderToStaticMarkup(<TrackList />);
    const masterStart = html.indexOf('aria-label="Master トラックを選択"');
    expect(masterStart).toBeGreaterThanOrEqual(0);
    const masterRowRemainder = html.slice(masterStart);

    expect(masterRowRemainder).toContain('aria-label="Master 音量"');
    expect(masterRowRemainder).toMatch(
      /aria-label="Master 音量"[^>]*aria-describedby="track-list-automation-[^"]+"/,
    );
    expect(masterRowRemainder).toContain('Master出力音量。');
    expect(masterRowRemainder).toContain(
      '再生中のTouch、Latch、Writeではオートメーションジェスチャーとして記録します。',
    );
    expect(masterRowRemainder).not.toContain('aria-label="Master パン"');
    expect(masterRowRemainder).not.toContain('title="ミュート"');
    expect(masterRowRemainder).not.toContain('title="ソロ"');

    const nonMasterCount = useStore
      .getState()
      .project.tracks.filter((track) => track.type !== 'master').length;
    expect(html.match(/title="ミュート"/g) ?? []).toHaveLength(nonMasterCount);
    expect(html.match(/title="ソロ"/g) ?? []).toHaveLength(nonMasterCount);
  });

  it('moves the Track List Master fader with enabled Read automation', () => {
    const state = useStore.getState();
    const master = state.project.tracks.find((track) => track.type === 'master');
    if (!master) throw new Error('Master fixture missing');
    const project = {
      ...state.project,
      tracks: state.project.tracks.map((track) =>
        track.id === master.id ? { ...track, volume: 0.9 } : track),
      automationLanes: [{
        id: 'track-list-master-read-lane',
        bypassed: false,
        target: { type: 'track-volume' as const, trackId: master.id },
        points: [{
          id: 'track-list-master-read-point',
          beat: 0,
          value: 0.42,
          interpolation: 'hold' as const,
        }],
      }],
      automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    };
    useStore.setState({
      project,
      transport: {
        ...state.transport,
        phase: 'playing',
        isPlaying: true,
        positionBeat: 1,
      },
    });
    Object.assign(useStore.getInitialState(), useStore.getState());

    const html = renderToStaticMarkup(<TrackList />);
    expect(html).toMatch(
      /<input[^>]*aria-label="Master 音量"[^>]*value="0\.42"/,
    );
  });

  it.each(['touch', 'latch', 'write'] as const)(
    'shares one live Master %s value with the Track List and Mixer faders',
    (mode) => {
    const state = useStore.getState();
    const master = state.project.tracks.find((track) => track.type === 'master');
    if (!master) throw new Error('Master fixture missing');
    useStore.setState({
      project: {
        ...state.project,
        automationLanes: [{
          id: 'shared-master-gesture-lane',
          bypassed: false,
          target: { type: 'track-volume', trackId: master.id },
          points: [{
            id: 'shared-master-gesture-point',
            beat: 0,
            value: 0.35,
            interpolation: 'hold',
          }],
        }],
        automationReadState: { globalEnabled: true, disabledTrackIds: [] },
      },
    });
    expect(useStore.getState().setTrackAutomationMode(master.id, mode)).toBe(true);
    useStore.getState().play();
    const requestId = useStore.getState().transport.playbackRequestId;
    const graph = {
      beginOverride: vi.fn(),
      updateOverride: vi.fn(),
      releaseTouchOverride: vi.fn(),
      resumeOverride: vi.fn(),
    };
    expect(useStore.getState().attachAutomationPlaybackRuntime(
      requestId,
      () => 2,
      graph,
    )).toBe(true);
    useStore.getState().confirmPlaybackStarted(requestId);
    useStore.getState().updatePlaybackPosition(requestId, 2);
    expect(useStore.getState().beginAutomationGesture({
      type: 'track-volume',
      trackId: master.id,
    }, 1.25)).toBe(true);
    Object.assign(useStore.getInitialState(), useStore.getState());

    const touchedHtml = renderToStaticMarkup(
      <>
        <TrackList />
        <MixerStrip />
      </>,
    );
    const touchedMasterFaders = touchedHtml.match(
      /<input[^>]*aria-label="Master 音量"[^>]*>/g,
    ) ?? [];
    expect(touchedMasterFaders).toHaveLength(2);
    expect(touchedMasterFaders.every((fader) =>
      fader.includes('value="1.25"'))).toBe(true);

    expect(useStore.getState().updateAutomationGesture({
      type: 'track-volume',
      trackId: master.id,
    }, 1.4)).toBe(true);
    Object.assign(useStore.getInitialState(), useStore.getState());
    const updatedHtml = renderToStaticMarkup(
      <>
        <TrackList />
        <MixerStrip />
      </>,
    );
    expect(
      updatedHtml.match(/<input[^>]*aria-label="Master 音量"[^>]*value="1\.4"/g)
      ?? [],
    ).toHaveLength(2);

    expect(useStore.getState().endAutomationGesture({
      type: 'track-volume',
      trackId: master.id,
    })).toBe(true);
    Object.assign(useStore.getInitialState(), useStore.getState());
    const releasedHtml = renderToStaticMarkup(
      <>
        <TrackList />
        <MixerStrip />
      </>,
    );
    const releasedValue = mode === 'touch' ? '0\\.35' : '1\\.4';
    expect(releasedHtml.match(new RegExp(
      `<input[^>]*aria-label="Master 音量"[^>]*value="${releasedValue}"`,
      'g',
    )) ?? []).toHaveLength(2);
    useStore.getState().stop();
    },
  );

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

  it('shows a single accessible Record Arm only for Audio Tracks', () => {
    const asset: ReadyAudioAsset = {
      id: 'asset-record-arm-row',
      availability: 'ready',
      checksumSha256: '7'.repeat(64),
      originalName: 'armed.wav',
      mediaType: 'audio/wav',
      byteLength: 96_044,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 48_000,
    };
    const created = createAudioTrackClip(useStore.getState().project, asset, {
      trackName: 'Vocal Take',
      idFactory: (kind) => `${kind}-record-arm-row`,
    });
    if (!created.ok) throw new Error(created.error.code);
    useStore.setState({ project: created.project });
    expect(useStore.getState().setAudioTrackArmed(created.trackId)).toBe(true);
    Object.assign(useStore.getInitialState(), useStore.getState());

    const html = renderToStaticMarkup(<TrackList />);
    expect(html).toContain('aria-label="Vocal Take 録音待機"');
    expect(html).toMatch(
      /<button[^>]*mini-btn--record is-active[^>]*aria-pressed="true"[^>]*>R<\/button>/,
    );
    expect(html.match(/mini-btn--record/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('aria-label="Master 録音待機"');
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
    expect(html).toContain('aria-label="Harmony（同名 1/2） 音量"');
    expect(html).toContain('aria-label="Harmony（同名 2/2） パン"');
    expect(html).toContain(`トラックID ${first.id}`);
    expect(html).toContain(`トラックID ${second.id}`);
    expect(html.match(/<span class="track-row__name">Harmony<\/span>/g)).toHaveLength(2);
  });

  it('surfaces a damaged later Audio Clip asset even when the first asset is healthy', () => {
    const firstAsset: ReadyAudioAsset = {
      id: 'asset-track-row-first',
      availability: 'ready',
      checksumSha256: '1'.repeat(64),
      originalName: 'healthy.wav',
      mediaType: 'audio/wav',
      byteLength: 96_044,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 48_000,
    };
    const secondAsset: ReadyAudioAsset = {
      ...firstAsset,
      id: 'asset-track-row-second',
      checksumSha256: '2'.repeat(64),
      originalName: 'damaged-later.wav',
    };
    const created = createAudioTrackClip(useStore.getState().project, firstAsset, {
      trackName: 'Two Takes',
      idFactory: (kind) => `${kind}-track-row-audio`,
    });
    if (!created.ok) throw new Error(created.error.code);
    const track = created.project.tracks.find((candidate) => candidate.id === created.trackId);
    const firstClip = track?.clips[0];
    if (!track || !firstClip || firstClip.type !== 'audio') throw new Error('audio fixture missing');
    const secondClip: AudioClip = {
      ...(firstClip as AudioClip),
      id: 'clip-track-row-second',
      startBeat: 4,
      audioAssetId: secondAsset.id,
    };
    const project = {
      ...created.project,
      audioAssets: [...created.project.audioAssets, secondAsset],
      tracks: created.project.tracks.map((candidate) =>
        candidate.id === track.id
          ? { ...candidate, clips: [...candidate.clips, secondClip] }
          : candidate,
      ),
    };
    const nextState = {
      project,
      audioAssetIssues: { [secondAsset.id]: 'changed' as const },
    };
    useStore.setState(nextState);
    Object.assign(useStore.getInitialState(), nextState);

    const html = renderToStaticMarkup(<TrackList />);

    expect(html).toContain('damaged-later.wav・音声素材が変更または破損しています');
    expect(html).toContain('class="track-row__asset is-problem"');
    expect(html).toContain('title="音声素材が変更または破損しています"');
    expect(html).not.toContain('class="track-row__asset">healthy.wav</span>');
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
