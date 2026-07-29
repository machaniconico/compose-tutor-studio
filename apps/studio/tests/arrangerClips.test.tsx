import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendAudioTrackClip,
  duplicateClip,
  createAudioTrackClip,
  compileMusicalTime,
  findClip,
  groupAudioClipsIntoTakeFolder,
  resizeClip,
  setMidiClipLoop,
  unlinkClip,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { createDefaultProject } from '../src/state/defaultProject';
import { installLocalStorage } from './localStorageStub';

let Arranger: typeof import('../src/features/arranger/Arranger')['Arranger'];
let clipOperationMessage: typeof import('../src/features/arranger/Arranger')['clipOperationMessage'];
let isClipNoticeCurrent: typeof import('../src/features/arranger/Arranger')['isClipNoticeCurrent'];
let audioBarNumberToBeat: typeof import('../src/features/arranger/AudioClipEditor')['audioBarNumberToBeat'];
let parseAudioNumericDraft: typeof import('../src/features/arranger/AudioClipEditor')['parseAudioNumericDraft'];
let useStore: typeof import('../src/state/store')['useStore'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ Arranger, clipOperationMessage, isClipNoticeCurrent } = await import(
    '../src/features/arranger/Arranger'
  ));
  ({ audioBarNumberToBeat, parseAudioNumericDraft } = await import(
    '../src/features/arranger/AudioClipEditor'
  ));
});

function fourBarSource(): { project: Project; clipId: string } {
  const project = createDefaultProject('Arranger test');
  const clip = project.tracks[0]?.clips[0];
  if (!clip) throw new Error('clip fixture missing');
  return {
    clipId: clip.id,
    project: {
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((candidate) =>
          candidate.id === clip.id
            ? { ...candidate, lengthBeats: 16 }
            : candidate,
        ),
      })),
    },
  };
}

function activate(project: Project, clipId: string): void {
  const current = useStore.getState();
  const track = project.tracks.find((candidate) =>
    candidate.clips.some((clip) => clip.id === clipId),
  );
  const nextState = {
    project,
    editor: {
      ...current.editor,
      activeView: 'arranger' as const,
      selectedTrackId: track?.id ?? null,
      selectedClipId: clipId,
    },
  };
  useStore.setState(nextState);
  // React's server renderer reads useSyncExternalStore's initial snapshot.
  // Keep that test-only snapshot aligned with the active store state.
  Object.assign(useStore.getInitialState(), nextState);
}

beforeEach(() => {
  const fixture = fourBarSource();
  activate(fixture.project, fixture.clipId);
});

describe('Arranger clip workflow', () => {
  it('explains an effective-event duplicate refusal in plain language', () => {
    expect(clipOperationMessage('event-limit')).toContain('再生イベントが多くなりすぎる');
    expect(clipOperationMessage('event-limit')).toContain('コピーを減らしてください');
  });

  it('rejects empty and hostile numeric drafts before timeline APIs or mutations run', () => {
    const musicalTime = compileMusicalTime(createDefaultProject('Numeric guard'));

    expect(parseAudioNumericDraft('')).toBeNull();
    expect(parseAudioNumericDraft('   ')).toBeNull();
    expect(parseAudioNumericDraft('1.25')).toBe(1.25);
    expect(parseAudioNumericDraft('1e309')).toBeNull();
    expect(audioBarNumberToBeat(musicalTime, 1e308)).toBeNull();
    expect(audioBarNumberToBeat(musicalTime, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(audioBarNumberToBeat(musicalTime, 0.5)).toBe(2);
  });

  it('renders track lanes and enables both copy modes when the pattern fits', () => {
    const html = renderToStaticMarkup(<Arranger />);

    expect(html).toContain('aria-label="トラック別クリップ配置"');
    expect(html).toContain('aria-label="Chordsのクリップ"');
    expect(html).toContain('aria-label="選択クリップの編集"');
    expect(html).toContain('素材をクリップ末尾まで繰り返す');
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toMatch(/<button[^>]*>独立コピーを右へ<\/button>/);
    expect(html).toMatch(/<button[^>]*>連動コピーを右へ<\/button>/);
  });

  it('keeps a valid partial-bar clip editable as a fractional bar range', () => {
    const fixture = fourBarSource();
    const partialProject = {
      ...fixture.project,
      tracks: fixture.project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === fixture.clipId
            ? { ...clip, startBeat: 2, lengthBeats: 2 }
            : clip,
        ),
      })),
    };
    activate(partialProject, fixture.clipId);

    const html = renderToStaticMarkup(<Arranger />);

    expect(html.match(/value="0\.5"/g)).toHaveLength(2);
    expect(html.match(/step="any"/g)).toHaveLength(2);
  });

  it('shows a linked badge and unlink action without duplicating payload', () => {
    const fixture = fourBarSource();
    const linked = duplicateClip(fixture.project, fixture.clipId, {
      id: 'arranger-linked',
      startBeat: 16,
      linked: true,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    activate(linked.project, linked.clipId);

    const html = renderToStaticMarkup(<Arranger />);
    const alias = findClip(linked.project, linked.clipId)?.clip;

    expect(alias?.notes).toBeUndefined();
    expect(html).toContain('連動コピー');
    expect(html).toContain('連動を解除');
    expect(html).toContain('aria-pressed="true"');
  });

  it('renders non-destructive Audio Clip controls, source name and runtime damage status', () => {
    const asset: ReadyAudioAsset = {
      id: 'asset-arranger-audio',
      availability: 'ready',
      checksumSha256: 'b'.repeat(64),
      originalName: 'reference mix.wav',
      mediaType: 'audio/wav',
      byteLength: 384_044,
      sampleRate: 48_000,
      channelCount: 2,
      frameCount: 96_000,
    };
    const created = createAudioTrackClip(createDefaultProject('Audio Arranger'), asset, {
      trackName: 'Reference',
      idFactory: (kind) => `${kind}-arranger-audio`,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    activate(created.project, created.clipId);
    const issueState = { [asset.id]: 'changed' as const };
    useStore.setState({ audioAssetIssues: issueState });
    Object.assign(useStore.getInitialState(), { audioAssetIssues: issueState });

    const html = renderToStaticMarkup(<Arranger />);

    expect(html).toContain('class="arranger__clip is-audio is-selected has-asset-issue"');
    expect(html).toContain('reference mix.wav');
    expect(html).toContain('aria-label="選択オーディオクリップの編集"');
    expect(html).toContain('音声素材が変更または破損しています');
    expect(html).toContain('正常な音声素材が残っている元の端末・プロファイルで開き直してください');
    expect(html).toContain('プロジェクトJSONだけには音声本体が含まれず');
    expect(html).toContain('配置と編集情報は保持されています');
    expect(html).toContain('配置開始（小節・0から）');
    expect(html).toContain('左端トリム（小節）');
    expect(html).toContain('右端トリム（小節）');
    expect(html).toContain('クリップゲイン（dB）');
    expect(html).toContain('フェードイン（ms）');
    expect(html).toContain('フェードアウト（ms）');
    expect(html).toContain('素材範囲をクリップ末尾まで繰り返す');
    expect(html).toContain('この位置で分割');
    expect(html).toMatch(/<span>配置開始（小節・0から）<\/span><input[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*>クリップを削除<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>連動コピーは利用不可<\/button>/);
    expect(html).toContain('クリップを削除');
    expect(html).toContain('同じ区間をテイク化');
    expect(html).toContain('音声素材を確認できないため、テイクを変更できません。');
  });

  it('renders one selectable Arranger object for a grouped Audio take folder', () => {
    const firstAsset: ReadyAudioAsset = {
      id: 'asset-arranger-take-a',
      availability: 'ready',
      checksumSha256: 'c'.repeat(64),
      originalName: 'take a.wav',
      mediaType: 'audio/wav',
      byteLength: 384_044,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 96_000,
    };
    const secondAsset: ReadyAudioAsset = {
      ...firstAsset,
      id: 'asset-arranger-take-b',
      checksumSha256: 'd'.repeat(64),
      originalName: 'take b.wav',
    };
    const first = createAudioTrackClip(createDefaultProject('Take Arranger'), firstAsset, {
      trackName: 'Vocals',
      idFactory: (kind) => `${kind}-arranger-take-a`,
    });
    if (!first.ok) throw new Error(first.error.code);
    const second = appendAudioTrackClip(first.project, first.trackId, secondAsset, {
      startBeat: 0,
      idFactory: (kind) => `${kind}-arranger-take-b`,
    });
    if (!second.ok) throw new Error(second.error.code);
    let sequence = 0;
    const grouped = groupAudioClipsIntoTakeFolder(
      second.project,
      [first.clipId, second.clipId],
      { idFactory: (kind) => `${kind}-arranger-${++sequence}` },
    );
    if (!grouped.ok) throw new Error(grouped.error.code);
    activate(grouped.project, '');
    useStore.getState().selectTakeFolder(grouped.folderId);
    const state = useStore.getState();
    Object.assign(useStore.getInitialState(), {
      project: state.project,
      editor: state.editor,
    });

    const html = renderToStaticMarkup(<Arranger />);

    expect(html).toContain(`data-take-folder-id="${grouped.folderId}"`);
    expect(html).toContain('Comp · 2テイク');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="選択テイクフォルダ"');
    expect(html).toContain('テイク編集を開く');
    expect(html).not.toContain(firstAsset.originalName);
    expect(html).not.toContain(secondAsset.originalName);
  });

  it('invalidates success notices when undo restores the prior clip state', () => {
    const fixture = fourBarSource();
    const duplicated = duplicateClip(fixture.project, fixture.clipId, {
      id: 'notice-linked',
      startBeat: 16,
      linked: true,
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;

    const duplicateNotice = {
      kind: 'status' as const,
      message: 'copied',
      expected: { operation: 'duplicate' as const, clipId: duplicated.clipId },
    };
    expect(isClipNoticeCurrent(duplicated.project, duplicateNotice)).toBe(true);
    expect(isClipNoticeCurrent(fixture.project, duplicateNotice)).toBe(false);

    const unlinked = unlinkClip(duplicated.project, duplicated.clipId);
    expect(unlinked.ok).toBe(true);
    if (!unlinked.ok) return;
    const unlinkNotice = {
      kind: 'status' as const,
      message: 'unlinked',
      expected: { operation: 'unlink' as const, clipId: duplicated.clipId },
    };
    expect(isClipNoticeCurrent(unlinked.project, unlinkNotice)).toBe(true);
    expect(isClipNoticeCurrent(duplicated.project, unlinkNotice)).toBe(false);

    const resized = resizeClip(fixture.project, fixture.clipId, {
      startBeat: 4,
      lengthBeats: 12,
    });
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    const resizeNotice = {
      kind: 'status' as const,
      message: 'resized',
      expected: {
        operation: 'resize' as const,
        clipId: fixture.clipId,
        startBeat: 4,
        lengthBeats: 12,
      },
    };
    expect(isClipNoticeCurrent(resized.project, resizeNotice)).toBe(true);
    expect(isClipNoticeCurrent(fixture.project, resizeNotice)).toBe(false);

    const looped = setMidiClipLoop(fixture.project, fixture.clipId, true);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;
    const loopNotice = {
      kind: 'status' as const,
      message: 'looped',
      expected: { operation: 'loop' as const, clipId: fixture.clipId, loop: true },
    };
    expect(isClipNoticeCurrent(looped.project, loopNotice)).toBe(true);
    expect(isClipNoticeCurrent(fixture.project, loopNotice)).toBe(false);
  });
});
