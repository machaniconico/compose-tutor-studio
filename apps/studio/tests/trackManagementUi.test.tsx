import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAudioTrackClip, type ReadyAudioAsset } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let TrackInspector: typeof import('../src/features/tracklist/TrackInspector')['TrackInspector'];
let AddTrackDialog: typeof import('../src/features/tracklist/AddTrackDialog')['AddTrackDialog'];
let ExportMenuContent: typeof import('../src/features/export/ExportMenuContent')['ExportMenuContent'];
let addStudioTrack: typeof import('../src/state/trackActions')['addStudioTrack'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ TrackInspector } = await import('../src/features/tracklist/TrackInspector'));
  ({ AddTrackDialog } = await import('../src/features/tracklist/AddTrackDialog'));
  ({ ExportMenuContent } = await import('../src/features/export/ExportMenuContent'));
  ({ addStudioTrack } = await import('../src/state/trackActions'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('トラックUI検証')).toBe(true);
  Object.assign(useStore.getInitialState(), useStore.getState());
});

describe('track management UI', () => {
  it('offers immediately usable instrument, drum and local Audio Track choices', () => {
    const html = renderToStaticMarkup(
      <AddTrackDialog onClose={() => undefined} onCreated={() => undefined} />,
    );

    expect(html).toContain('楽器トラック');
    expect(html).toContain('ドラムトラック');
    expect(html).toContain('オーディオトラック');
    expect(html).toContain('WAV、MP3、M4A、AAC');
    expect(html).toContain('48 kHz・PCM16');
    expect(html).toContain('プロジェクトJSONには音声本体を含まない');
    expect(html).toContain('accept=".wav,.mp3,.m4a,.aac,audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/aac"');
    expect(html).toContain('やわらかいパッド');
    expect(html).toContain('明るいリード');
    expect(html).toContain('バストラックはルーティングの実装後');
    expect(html).not.toContain('オーディオトラックは音声素材管理');
    expect(html).toContain('data-modal-initial-focus="true"');
    expect(html).not.toContain('maxLength=');
    expect(html).not.toContain('maxlength=');
  });

  it('warns that project JSON needs the same local Audio Track asset store', () => {
    const html = renderToStaticMarkup(
      <ExportMenuContent
        onDone={() => undefined}
        activeOperation={null}
        beginOperation={() => true}
        finishOperation={() => undefined}
      />,
    );

    expect(html).toContain('.ctsproj.jsonには編集情報だけを書き出し');
    expect(html).toContain('Audio Trackの音声本体は含みません');
    expect(html).toContain('同じ端末の素材保存領域');
  });

  it('shows source identity and a changed warning for a selected Audio Track', () => {
    const asset: ReadyAudioAsset = {
      id: 'asset-ui-audio',
      availability: 'ready',
      checksumSha256: 'a'.repeat(64),
      originalName: 'lead vocal take.wav',
      mediaType: 'audio/wav',
      byteLength: 96_044,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 48_000,
    };
    const outcome = createAudioTrackClip(useStore.getState().project, asset, {
      trackName: 'Lead Vocal',
      idFactory: (kind) => `${kind}-ui-audio`,
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    const nextState = {
      project: outcome.project,
      editor: {
        ...useStore.getState().editor,
        selectedTrackId: outcome.trackId,
        selectedClipId: outcome.clipId,
        activeView: 'arranger' as const,
      },
      audioAssetIssues: { [asset.id]: 'changed' as const },
    };
    useStore.setState(nextState);
    Object.assign(useStore.getInitialState(), nextState);

    const html = renderToStaticMarkup(<TrackInspector />);

    expect(html).toContain('aria-label="Lead Vocal 音声素材"');
    expect(html).toContain('lead vocal take.wav');
    expect(html).toContain('48.0 kHz');
    expect(html).toContain('モノラル');
    expect(html).toContain('音声素材が変更または破損しています');
    expect(html).toContain('アレンジャーでクリップを選んで編集');
  });

  it('keeps the Chords learning role while allowing an independent display name', () => {
    const html = renderToStaticMarkup(<TrackInspector />);

    expect(html).toContain('Chords');
    expect(html).toContain('名前を変更しても学習用の役割は保持されます');
    expect(html).toContain('名前を変更');
    expect(html).toContain('aria-label="Chords 学習での役割"');
    expect(html).toContain('value="learning.chords" selected=""');
    expect(html).toContain('aria-label="Chords 音色"');
    expect(html).toContain('value="softPad" selected=""');
    expect(html).toContain('やわらかいパッド');
    expect(html).toContain('複製');
    expect(html).not.toContain('class="track-inspector__delete"');
  });

  it('shows rename and management controls for a user track, but never for Master', () => {
    const created = addStudioTrack({ kind: 'instrument', name: 'Counterline' });
    if (!created.ok) throw new Error('fixture track was not added');
    Object.assign(useStore.getInitialState(), useStore.getState());
    const userHtml = renderToStaticMarkup(<TrackInspector />);

    expect(userHtml).toContain('value="Counterline"');
    expect(userHtml).toContain('名前を変更');
    expect(userHtml).toContain('aria-label="Counterline 管理"');

    const master = useStore.getState().project.tracks.find((track) => track.type === 'master');
    useStore.getState().selectTrack(master?.id ?? null);
    Object.assign(useStore.getInitialState(), useStore.getState());
    const masterHtml = renderToStaticMarkup(<TrackInspector />);
    expect(masterHtml).toContain('マスタートラックは名前・順序・複製・削除を変更できません');
    expect(masterHtml).not.toContain('名前を変更');
    expect(masterHtml).not.toContain('aria-label="Master 管理"');
  });

  it.each([
    ['future-preset', '現在の互換音色（future-preset）'],
    ['__proto__', '現在の互換音色（__proto__）'],
    ['', '現在の互換音色（未設定）'],
  ])('shows a repairable compatibility option for saved preset %j', (savedPreset, label) => {
    const track = useStore.getState().project.tracks[0];
    if (!track) throw new Error('fixture track missing');
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((candidate) =>
        candidate.id === track.id && candidate.instrument?.type === 'synth'
          ? {
              ...candidate,
              instrument: { ...candidate.instrument, preset: savedPreset },
            }
          : candidate,
      ),
    }))).toBe(true);
    Object.assign(useStore.getInitialState(), useStore.getState());

    const html = renderToStaticMarkup(<TrackInspector />);
    expect(html).toContain(label);
    expect(html).toContain('保存済みの音色を保持しています');
  });
});
