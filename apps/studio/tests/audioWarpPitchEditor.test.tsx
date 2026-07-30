import {
  isValidElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAudioTrackClip,
  type AudioClip,
  type AudioWarp,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { createDefaultProject } from '../src/state/defaultProject';
import {
  AudioWarpPitchEditor,
  audioWarpEditErrorMessage,
  linearAudioWarp,
} from '../src/features/arranger/AudioWarpPitchEditor';
import {
  audioClipPitchTracePath,
  isAudioClipAnalysisSnapshotCurrent,
} from '../src/features/arranger/AudioPitchCorrectionEditor';
import { AudioPitchCorrectionEditor } from '../src/features/arranger/AudioPitchCorrectionEditor';
import { AudioTimingEditor } from '../src/features/arranger/AudioTimingEditor';
import type { AudioClipAnalysisResult } from '../src/audio/audioClipAnalysis';
import {
  audioWarpEditorBusyReason,
  audioWarpEditorDisabledReason,
  audioWarpEditorTransientReason,
} from '../src/features/arranger/AudioClipEditor';

const hooks = vi.hoisted(() => ({
  stateIndex: 0,
  refIndex: 0,
  id: 0,
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (initial: unknown | (() => unknown)) => {
      const index = hooks.stateIndex++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initial === 'function'
          ? (initial as () => unknown)()
          : initial;
      }
      const setState = (next: unknown | ((current: unknown) => unknown)) => {
        hooks.states[index] = typeof next === 'function'
          ? (next as (current: unknown) => unknown)(hooks.states[index])
          : next;
      };
      return [hooks.states[index], setState];
    },
    useRef: (initial: unknown) => {
      const index = hooks.refIndex++;
      const ref = hooks.refs[index] ?? { current: initial };
      hooks.refs[index] = ref;
      return ref;
    },
    useEffect: () => undefined,
    useId: () => `audio-warp-test-${hooks.id++}`,
  };
});

type ElementProps = {
  children?: ReactNode;
  role?: string;
  tabIndex?: number;
  'aria-label'?: string;
  disabled?: boolean;
  onClick?: () => void;
  onFocus?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: unknown) => void;
  onPointerMove?: (event: unknown) => void;
  onPointerUp?: (event: unknown) => void;
  onPointerCancel?: () => void;
};

function findAll(
  node: ReactNode,
  predicate: (element: ReactElement<ElementProps>) => boolean,
): Array<ReactElement<ElementProps>> {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!isValidElement<ElementProps>(node)) return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...findAll(node.props.children, predicate),
  ];
}

function keyEvent(
  key: string,
  altKey = false,
): ReactKeyboardEvent<HTMLButtonElement> {
  return {
    key,
    altKey,
    preventDefault: vi.fn(),
  } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
}

function buttonByText(tree: ReactNode, text: string): ReactElement<ElementProps> {
  const button = findAll(
    tree,
    (element) => element.type === 'button' && element.props.children === text,
  )[0];
  if (!button) throw new Error(`button missing: ${text}`);
  return button;
}

beforeEach(() => {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  hooks.id = 0;
  hooks.states = [];
  hooks.refs = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

const asset: ReadyAudioAsset = {
  id: 'asset-warp-editor',
  availability: 'ready',
  checksumSha256: 'e'.repeat(64),
  originalName: 'voice.wav',
  mediaType: 'audio/wav',
  byteLength: 96_044,
  sampleRate: 48_000,
  channelCount: 1,
  frameCount: 48_000,
};

function fixture() {
  const created = createAudioTrackClip(createDefaultProject('Warp editor'), asset, {
    idFactory: (kind) => `${kind}-warp-editor`,
  });
  if (!created.ok) throw new Error(created.error.code);
  const clip = created.project.tracks
    .flatMap((track) => track.clips)
    .find((candidate): candidate is AudioClip =>
      candidate.id === created.clipId && candidate.type === 'audio');
  if (!clip) throw new Error('clip missing');
  return { project: created.project, clip };
}

function analysisFixture(): AudioClipAnalysisResult {
  return {
    durationSeconds: 1,
    waveform: [
      { startSeconds: 0, endSeconds: 0.5, min: -0.5, max: 0.75 },
      { startSeconds: 0.5, endSeconds: 1, min: -0.25, max: 0.4 },
    ],
    pitchFrames: [
      { startSeconds: 0, endSeconds: 0.25, midi: 69.25, confidence: 0.9 },
      { startSeconds: 0.25, endSeconds: 0.5, midi: 69.5, confidence: 0.88 },
      { startSeconds: 0.5, endSeconds: 0.6, midi: null, confidence: 0 },
      { startSeconds: 0.6, endSeconds: 1, midi: 72.1, confidence: 0.82 },
    ],
    regions: [{
      sourceStartFrame: 0,
      sourceFrameCount: 24_000,
      sourcePitchCents: 6_925,
      targetPitchCents: 6_900,
      correctionAmount: 0.5,
      transitionFrames: 240,
      confidence: 0.88,
    }],
  };
}

describe('AudioWarpPitchEditor accessibility shell', () => {
  it('is collapsed, local-only, and exposes keyboard tabs and native controls', () => {
    const { project, clip } = fixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(
      <AudioWarpPitchEditor
        project={project}
        clip={clip}
        asset={asset}
        disabledReason={null}
      />,
    );

    expect(html).toContain('<details>');
    expect(html).not.toContain('<details open');
    expect(html).toContain('音声を整える');
    expect(html).toContain('元の音声を変更せず');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('一度に一音だけ鳴る素材向け');
    expect(html).toContain('音程をローカル解析');
    expect(html).toContain('解析をキャンセル');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('role="status"');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('shows an exact adjacent reason and does not mount editing controls when disabled', () => {
    const { project, clip } = fixture();
    const reason = 'ループ中のクリップは音声を整えられません。先にループをオフにしてください。';
    const html = renderToStaticMarkup(
      <AudioWarpPitchEditor
        project={project}
        clip={{ ...clip, loop: true }}
        asset={asset}
        disabledReason={reason}
      />,
    );

    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(reason);
    expect(html).not.toContain('role="tablist"');
  });

  it('prioritizes every structural and transient disabled reason exactly', () => {
    const ready = {
      projectOperationBusy: false,
      recordingActive: false,
      loop: false,
      issue: null,
      readyAssetAvailable: true,
    } as const;
    expect(audioWarpEditorDisabledReason({
      ...ready,
      projectOperationBusy: true,
      recordingActive: true,
      loop: true,
      issue: 'changed',
    })).toBe('プロジェクトを切り替え中のため、音声を整えられません。');
    expect(audioWarpEditorDisabledReason({
      ...ready,
      recordingActive: true,
    })).toBe('録音中または録音素材の保存中のため、音声を整えられません。');
    expect(audioWarpEditorDisabledReason({
      ...ready,
      loop: true,
    })).toBe('ループ中のクリップは音声を整えられません。先にループをオフにしてください。');
    expect(audioWarpEditorDisabledReason({
      ...ready,
      issue: 'changed',
    })).toBe('音声素材が変更または破損しているため、音声を整えられません。');
    expect(audioWarpEditorDisabledReason({
      ...ready,
      issue: 'unavailable',
    })).toBe('端末内の音声素材を利用できないため、音声を整えられません。');
    expect(audioWarpEditorDisabledReason({
      ...ready,
      issue: 'missing',
    })).toBe('音声素材が見つからないため、音声を整えられません。');
    expect(audioWarpEditorDisabledReason({
      ...ready,
      readyAssetAvailable: false,
    })).toBe('音声素材が見つからないため、音声を整えられません。');
    expect(audioWarpEditorDisabledReason(ready)).toBeNull();
    expect(audioWarpEditorBusyReason('pending')).toBe(
      'プロジェクトを保存中のため、完了後に音声を整えてください。',
    );
    expect(audioWarpEditorBusyReason('saved')).toBeNull();
    expect(audioWarpEditorTransientReason({
      projectOperationBusy: true,
      recordingActive: true,
      savePhase: 'pending',
    })).toBe('プロジェクトを切り替え中のため、音声を整えられません。');
    expect(audioWarpEditorTransientReason({
      projectOperationBusy: false,
      recordingActive: true,
      savePhase: 'pending',
    })).toBe('録音中または録音素材の保存中のため、音声を整えられません。');
    expect(audioWarpEditorTransientReason({
      projectOperationBusy: false,
      recordingActive: false,
      savePhase: 'pending',
    })).toBe('プロジェクトを保存中のため、完了後に音声を整えてください。');
  });

  it.each([
    'プロジェクトを切り替え中のため、音声を整えられません。',
    '録音中または録音素材の保存中のため、音声を整えられません。',
    'プロジェクトを保存中のため、完了後に音声を整えてください。',
  ])('keeps the open editor mounted with native controls disabled for %s', (reason) => {
    const { project, clip } = fixture();
    const html = renderToStaticMarkup(
      <AudioWarpPitchEditor
        project={project}
        clip={clip}
        asset={asset}
        disabledReason={null}
        busyReason={reason}
      />,
    );

    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(reason);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('class="audio-warp-editor__body"');
    const controls = [...html.matchAll(/<(?:button|input)\b[^>]*>/g)]
      .map((match) => match[0]);
    expect(controls.length).toBeGreaterThan(8);
    expect(controls.every((control) => control.includes('disabled=""'))).toBe(true);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>音程をローカル解析<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>点を追加<\/button>/);
  });

  it('keeps endpoint and narrow-region hit targets inside the clipped timeline', () => {
    const { project, clip } = fixture();
    const timing = renderToStaticMarkup(
      <AudioTimingEditor
        clip={clip}
        warp={linearAudioWarp(clip)}
        disabled={false}
        onCommit={() => true}
        onReject={() => undefined}
      />,
    );
    expect(timing).toContain('left:clamp(22px, 0%');
    expect(timing).toContain('left:clamp(22px, 100%');

    const pitch = renderToStaticMarkup(
      <AudioPitchCorrectionEditor
        project={project}
        clip={clip}
        asset={asset}
        warp={{
          ...linearAudioWarp(clip),
          pitchRegions: [{
            sourceStartFrame: clip.sourceStartFrame,
            sourceFrameCount: 480,
            sourcePitchCents: 6_900,
            targetPitchCents: 7_000,
            correctionAmount: 1,
            transitionFrames: 0,
          }],
        }}
        disabled={false}
        comparePitchBefore={false}
        onComparePitchBeforeChange={() => true}
        onCommit={() => true}
        onNotice={() => undefined}
      />,
    );
    expect(pitch).toContain('left:clamp(22px, 0.5%');
    expect(pitch).toContain('width:2%');
  });

  it('blocks direct timing and pitch handlers while autosave owns the editor', () => {
    const { project, clip } = fixture();
    const timingCommit = vi.fn(() => true);
    const timingReject = vi.fn();
    const timingWarp = {
      ...linearAudioWarp(clip),
      markers: [
        { sourceFrame: 0, targetBeatOffset: 0 },
        { sourceFrame: 24_000, targetBeatOffset: 1 },
        { sourceFrame: 48_000, targetBeatOffset: 2 },
      ],
    };
    const timing = AudioTimingEditor({
      clip,
      warp: timingWarp,
      disabled: true,
      onCommit: timingCommit,
      onReject: timingReject,
    });
    buttonByText(timing, '点を追加').props.onClick?.();
    const point = findAll(
      timing,
      (element) => element.props['aria-label']?.startsWith('タイミング点 2、') === true,
    )[0];
    const setPointerCapture = vi.fn();
    point?.props.onKeyDown?.(keyEvent('ArrowRight'));
    point?.props.onPointerDown?.({
      pointerId: 1,
      currentTarget: { setPointerCapture },
    });
    expect(timingCommit).not.toHaveBeenCalled();
    expect(timingReject).not.toHaveBeenCalled();
    expect(setPointerCapture).not.toHaveBeenCalled();

    const pitchCommit = vi.fn(() => true);
    const pitchNotice = vi.fn();
    const pitchReject = vi.fn();
    const compare = vi.fn(() => true);
    const pitchWarp = {
      ...linearAudioWarp(clip),
      pitchRegions: analysisFixture().regions.map(({ confidence: _confidence, ...region }) =>
        region),
    };
    hooks.stateIndex = 0;
    hooks.refIndex = 0;
    hooks.states = [];
    hooks.refs = [];
    const pitch = AudioPitchCorrectionEditor({
      project,
      clip: { ...clip, audioWarp: pitchWarp },
      asset,
      warp: pitchWarp,
      disabled: true,
      comparePitchBefore: false,
      onComparePitchBeforeChange: compare,
      onCommit: pitchCommit,
      onNotice: pitchNotice,
      onReject: pitchReject,
    });
    buttonByText(pitch, '音程をローカル解析').props.onClick?.();
    buttonByText(pitch, '区間を分割').props.onClick?.();
    buttonByText(pitch, 'ピッチ補正前').props.onClick?.();
    findAll(
      pitch,
      (element) => element.props['aria-label']?.startsWith('音程区間 1、') === true,
    )[0]?.props.onKeyDown?.(keyEvent('ArrowUp'));
    expect(pitchCommit).not.toHaveBeenCalled();
    expect(pitchNotice).not.toHaveBeenCalled();
    expect(pitchReject).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it('renders bounded local waveform and pitch trace data instead of a placeholder', () => {
    const { project, clip } = fixture();
    const analysis = analysisFixture();
    const trace = audioClipPitchTracePath(analysis);
    expect(trace.match(/\bM\b/g)).toHaveLength(2);
    expect(trace).toContain('L ');

    const pitchWarp = {
      ...linearAudioWarp(clip),
      pitchRegions: analysis.regions.map(({ confidence: _confidence, ...region }) => region),
    };
    hooks.states = [analysis, 'idle', 0, 0, 1];
    const tree = AudioPitchCorrectionEditor({
      project,
      clip: { ...clip, audioWarp: pitchWarp },
      asset,
      warp: pitchWarp,
      disabled: false,
      comparePitchBefore: false,
      onComparePitchBeforeChange: vi.fn(() => true),
      onCommit: vi.fn(() => true),
      onNotice: vi.fn(),
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain('data-analysis-waveform="true"');
    expect(html).toContain('data-analysis-pitch-trace="true"');
    expect(html).toContain('data-analysis-cursor="true"');
    expect(html).toContain(`d="${trace}"`);
    expect(html).not.toContain('M0 120 L80 105');
    expect(html.match(/<line/g)?.length).toBeGreaterThan(2);
  });

  it('removes an analysis-only candidate without creating project history', () => {
    const { project, clip } = fixture();
    const analysis = analysisFixture();
    hooks.states = [analysis, 'idle', 0, 0, 1];
    const onCommit = vi.fn(
      (_warp: AudioWarp | undefined, _message: string) => true,
    );
    const onNotice = vi.fn();
    const tree = AudioPitchCorrectionEditor({
      project,
      clip,
      asset,
      warp: linearAudioWarp(clip),
      disabled: false,
      comparePitchBefore: false,
      onComparePitchBeforeChange: vi.fn(() => true),
      onCommit,
      onNotice,
    });
    findAll(
      tree,
      (element) => element.props['aria-label']?.startsWith('音程区間 1、') === true,
    )[0]?.props.onKeyDown?.(keyEvent('Delete'));

    expect(onCommit).not.toHaveBeenCalled();
    expect((hooks.states[0] as AudioClipAnalysisResult).regions).toEqual([]);
    expect(onNotice).toHaveBeenCalledWith({
      kind: 'status',
      message: '解析候補を外しました。まだプロジェクトは変更していません。',
    });
  });

  it('persists every visible candidate canonically on the first audible correction', () => {
    const { project, clip } = fixture();
    const first = analysisFixture().regions[0]!;
    const analysis: AudioClipAnalysisResult = {
      ...analysisFixture(),
      regions: [
        first,
        {
          ...first,
          sourceStartFrame: 24_000,
          sourcePitchCents: 7_210,
          targetPitchCents: 7_200,
          confidence: 0.54,
        },
      ],
    };
    hooks.states = [analysis, 'idle', 0, 0, 1];
    const onCommit = vi.fn(
      (_warp: AudioWarp | undefined, _message: string) => true,
    );
    const tree = AudioPitchCorrectionEditor({
      project,
      clip,
      asset,
      warp: linearAudioWarp(clip),
      disabled: false,
      comparePitchBefore: false,
      onComparePitchBeforeChange: vi.fn(() => true),
      onCommit,
      onNotice: vi.fn(),
    });

    findAll(
      tree,
      (element) => element.props['aria-label']?.startsWith('音程区間 1、') === true,
    )[0]?.props.onKeyDown?.(keyEvent('ArrowUp'));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        pitchRegions: [
          {
            sourceStartFrame: 0,
            sourceFrameCount: 24_000,
            sourcePitchCents: 6_925,
            targetPitchCents: 7_000,
            correctionAmount: 0.5,
            transitionFrames: 240,
          },
          {
            sourceStartFrame: 24_000,
            sourceFrameCount: 24_000,
            sourcePitchCents: 7_210,
            targetPitchCents: 7_200,
            correctionAmount: 0.5,
            transitionFrames: 240,
          },
        ],
      }),
      '目標音程を変更しました。',
    );
    expect(onCommit.mock.calls[0]?.[0]).not.toHaveProperty(
      'pitchRegions.0.confidence',
    );
    expect((hooks.states[0] as AudioClipAnalysisResult).regions).toHaveLength(2);
  });

  it('documents the runtime-only analysis boundary next to the pitch controls', () => {
    const { project, clip } = fixture();
    const html = renderToStaticMarkup(
      <AudioPitchCorrectionEditor
        project={project}
        clip={clip}
        asset={asset}
        warp={linearAudioWarp(clip)}
        disabled={false}
        comparePitchBefore={false}
        onComparePitchBeforeChange={() => true}
        onCommit={() => true}
        onNotice={() => undefined}
      />,
    );

    expect(html).toContain(
      '解析しただけでは波形、解析候補、表示倍率、選択、A/Bを保存や元に戻す履歴へ追加しません。',
    );
    expect(html).toContain(
      '目標音程または補正量を初めて変更すると、表示中の候補を補正区間として保存します。',
    );
    expect(html).not.toContain('実際に補正した区間だけを保存します。');
  });

  it('returns focus to analyze when local analysis fails', async () => {
    const { project, clip } = fixture();
    const focus = vi.fn();
    hooks.refs = [
      { current: 0 },
      { current: false },
      { current: null },
      { current: { focus } },
      { current: new Map() },
      { current: null },
    ];
    const onNotice = vi.fn();
    const tree = AudioPitchCorrectionEditor({
      project,
      clip,
      asset,
      warp: linearAudioWarp(clip),
      disabled: false,
      comparePitchBefore: false,
      onComparePitchBeforeChange: vi.fn(() => true),
      onCommit: vi.fn(() => true),
      onNotice,
    });

    buttonByText(tree, '音程をローカル解析').props.onClick?.();

    await vi.waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
      }));
      expect(focus).toHaveBeenCalledTimes(1);
    });
  });

  it('schedules deterministic focus recovery for remove, split, merge, and rejection', () => {
    const { project, clip } = fixture();
    const baseRegion = {
      sourceStartFrame: 0,
      sourceFrameCount: 24_000,
      sourcePitchCents: 6_900,
      targetPitchCents: 6_900,
      correctionAmount: 0,
      transitionFrames: 0,
    };
    const renderWithFocusRefs = (warp: AudioWarp) => {
      const focusedRegion = { focus: vi.fn() };
      const pendingFocus = { current: null as number | 'analyze' | null };
      hooks.stateIndex = 0;
      hooks.refIndex = 0;
      hooks.states = [];
      hooks.refs = [
        { current: 0 },
        { current: false },
        { current: null },
        { current: { focus: vi.fn() } },
        { current: new Map([[0, focusedRegion]]) },
        pendingFocus,
      ];
      return {
        focusedRegion,
        pendingFocus,
        tree: AudioPitchCorrectionEditor({
          project,
          clip,
          asset,
          warp,
          disabled: false,
          comparePitchBefore: false,
          onComparePitchBeforeChange: vi.fn(() => true),
          onCommit: vi.fn(() => true),
          onNotice: vi.fn(),
          onReject: vi.fn(),
        }),
      };
    };
    const twoRegions: AudioWarp = {
      ...linearAudioWarp(clip),
      pitchRegions: [
        baseRegion,
        { ...baseRegion, sourceStartFrame: 24_000 },
      ],
    };

    let rendered = renderWithFocusRefs(twoRegions);
    buttonByText(rendered.tree, '補正を削除').props.onClick?.();
    expect(rendered.pendingFocus.current).toBe(0);

    rendered = renderWithFocusRefs(twoRegions);
    buttonByText(rendered.tree, '区間を分割').props.onClick?.();
    expect(rendered.pendingFocus.current).toBe(1);

    rendered = renderWithFocusRefs(twoRegions);
    buttonByText(rendered.tree, '次と結合').props.onClick?.();
    expect(rendered.pendingFocus.current).toBe(0);

    rendered = renderWithFocusRefs({
      ...twoRegions,
      pitchRegions: [
        baseRegion,
        {
          ...baseRegion,
          sourceStartFrame: 24_000,
          targetPitchCents: 7_200,
        },
      ],
    });
    buttonByText(rendered.tree, '次と結合').props.onClick?.();
    expect(rendered.focusedRegion.focus).toHaveBeenCalledTimes(1);
  });

  it('builds deterministic clip endpoints without persisting runtime analysis', () => {
    const { clip } = fixture();
    const warp = linearAudioWarp(clip);

    expect(warp.markers).toEqual([
      { sourceFrame: clip.sourceStartFrame, targetBeatOffset: 0 },
      {
        sourceFrame: clip.sourceStartFrame + clip.sourceFrameCount,
        targetBeatOffset: clip.lengthBeats,
      },
    ]);
    expect(warp.pitchRegions).toEqual([]);
  });

  it('rejects every stale analysis identity dimension', () => {
    const { project } = fixture();
    const replacement = { ...project };
    const current = (
      requestGeneration: number,
      currentGeneration: number,
      snapshotProject = project,
      latestProject = project,
      expectedProjectId = project.id,
      snapshotActivationId = 'activation-a',
      latestActivationId = 'activation-a',
    ) => isAudioClipAnalysisSnapshotCurrent(
      requestGeneration,
      currentGeneration,
      snapshotProject,
      latestProject,
      expectedProjectId,
      snapshotActivationId,
      latestActivationId,
    );

    expect(current(3, 3)).toBe(true);
    expect(current(3, 4)).toBe(false);
    expect(current(3, 3, project, replacement)).toBe(false);
    expect(current(3, 3, project, project, 'different-project')).toBe(false);
    expect(current(3, 3, project, project, project.id, 'activation-a', 'activation-b'))
      .toBe(false);
  });

  it('executes timing keyboard navigation, coarse/fine nudge, and point-only Delete', () => {
    const { clip } = fixture();
    const onCommit = vi.fn((_warp: AudioWarp | undefined, _message: string) => true);
    const warp = {
      ...linearAudioWarp(clip),
      markers: [
        { sourceFrame: 0, targetBeatOffset: 0 },
        { sourceFrame: 24_000, targetBeatOffset: 2 },
        { sourceFrame: 48_000, targetBeatOffset: 4 },
      ],
    };
    let tree = AudioTimingEditor({ clip, warp, onCommit, disabled: false });
    let points = findAll(
      tree,
      (element) => element.props['aria-label']?.startsWith('タイミング点 ') === true,
    );

    expect(points.map((point) => point.props.tabIndex)).toEqual([0, -1, -1]);
    points[1]?.props.onFocus?.();
    hooks.stateIndex = 0;
    hooks.refIndex = 0;
    tree = AudioTimingEditor({ clip, warp, onCommit, disabled: false });
    points = findAll(
      tree,
      (element) => element.props['aria-label']?.startsWith('タイミング点 ') === true,
    );
    expect(points.map((point) => point.props.tabIndex)).toEqual([-1, 0, -1]);
    points[1]?.props.onKeyDown?.(keyEvent('ArrowRight'));
    expect(onCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        markers: expect.arrayContaining([
          expect.objectContaining({ sourceFrame: 24_000, targetBeatOffset: 2.01 }),
        ]),
      }),
      'タイミング点を移動しました。',
    );
    points[1]?.props.onKeyDown?.(keyEvent('ArrowLeft', true));
    expect(onCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        markers: expect.arrayContaining([
          expect.objectContaining({ sourceFrame: 24_000, targetBeatOffset: 1.999 }),
        ]),
      }),
      'タイミング点を移動しました。',
    );
    const commitsBeforeNavigation = onCommit.mock.calls.length;
    points[1]?.props.onKeyDown?.(keyEvent('PageDown'));
    points[1]?.props.onKeyDown?.(keyEvent('Home'));
    points[1]?.props.onKeyDown?.(keyEvent('End'));
    expect(onCommit).toHaveBeenCalledTimes(commitsBeforeNavigation);

    points[1]?.props.onKeyDown?.(keyEvent('Delete'));
    expect(onCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({ markers: [warp.markers[0], warp.markers[2]] }),
      'タイミング点を削除しました。',
    );
  });

  it('commits one timing pointer gesture and ignores zero, Escape, and pointercancel', () => {
    const { clip } = fixture();
    const onCommit = vi.fn(() => true);
    const warp = {
      ...linearAudioWarp(clip),
      markers: [
        { sourceFrame: 0, targetBeatOffset: 0 },
        { sourceFrame: 24_000, targetBeatOffset: clip.lengthBeats / 2 },
        { sourceFrame: 48_000, targetBeatOffset: clip.lengthBeats },
      ],
    };
    const tree = AudioTimingEditor({ clip, warp, onCommit, disabled: false });
    const point = findAll(
      tree,
      (element) => element.props['aria-label']?.startsWith('タイミング点 2、') === true,
    )[0];
    if (!point) throw new Error('middle timing point missing');
    const currentTarget = {
      parentElement: {
        getBoundingClientRect: () => ({ left: 0, width: 100 }),
      },
      setPointerCapture: vi.fn(),
    };
    const pointer = (clientX: number) => ({
      clientX,
      pointerId: 1,
      currentTarget,
    });

    point.props.onPointerDown?.(pointer(50));
    point.props.onPointerUp?.(pointer(50));
    expect(onCommit).not.toHaveBeenCalled();

    point.props.onPointerDown?.(pointer(50));
    point.props.onPointerMove?.(pointer(60));
    point.props.onPointerUp?.(pointer(60));
    expect(onCommit).toHaveBeenCalledTimes(1);

    point.props.onPointerDown?.(pointer(50));
    point.props.onKeyDown?.(keyEvent('Escape'));
    point.props.onPointerUp?.(pointer(60));
    point.props.onPointerDown?.(pointer(50));
    point.props.onPointerCancel?.();
    point.props.onPointerUp?.(pointer(60));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('executes pitch keyboard navigation, semitone change, and region-only Delete', () => {
    const { project, clip } = fixture();
    const onCommit = vi.fn(() => true);
    const warp = {
      ...linearAudioWarp(clip),
      pitchRegions: [
        {
          sourceStartFrame: 0,
          sourceFrameCount: 24_000,
          sourcePitchCents: 6_900,
          targetPitchCents: 6_900,
          correctionAmount: 0,
          transitionFrames: 0,
        },
        {
          sourceStartFrame: 24_000,
          sourceFrameCount: 24_000,
          sourcePitchCents: 7_200,
          targetPitchCents: 7_200,
          correctionAmount: 0,
          transitionFrames: 0,
        },
      ],
    };
    const tree = AudioPitchCorrectionEditor({
      project,
      clip,
      asset,
      warp,
      disabled: false,
      comparePitchBefore: false,
      onComparePitchBeforeChange: vi.fn(() => true),
      onCommit,
      onNotice: vi.fn(),
    });
    const regions = findAll(
      tree,
      (element) => element.props['aria-label']?.startsWith('音程区間 ') === true,
    );

    expect(regions.map((region) => region.props.tabIndex)).toEqual([0, -1]);
    regions[0]?.props.onKeyDown?.(keyEvent('ArrowUp'));
    expect(onCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pitchRegions: expect.arrayContaining([
          expect.objectContaining({ sourceStartFrame: 0, targetPitchCents: 7_000 }),
        ]),
      }),
      '目標音程を変更しました。',
    );
    const commitsBeforeNavigation = onCommit.mock.calls.length;
    regions[0]?.props.onKeyDown?.(keyEvent('PageDown'));
    regions[0]?.props.onKeyDown?.(keyEvent('Home'));
    regions[0]?.props.onKeyDown?.(keyEvent('End'));
    expect(onCommit).toHaveBeenCalledTimes(commitsBeforeNavigation);

    regions[0]?.props.onKeyDown?.(keyEvent('Delete'));
    expect(onCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pitchRegions: [expect.objectContaining({ sourceStartFrame: 24_000 })],
      }),
      '音程補正区間を削除しました。',
    );
  });

  it('uses bounded public split/merge operations and reports an exact merge rejection', () => {
    const { project, clip } = fixture();
    const onCommit = vi.fn((_warp: AudioWarp | undefined, _message: string) => true);
    const onReject = vi.fn();
    const differentRegions = {
      ...linearAudioWarp(clip),
      pitchRegions: [
        {
          sourceStartFrame: 0,
          sourceFrameCount: 24_000,
          sourcePitchCents: 6_900,
          targetPitchCents: 6_900,
          correctionAmount: 0,
          transitionFrames: 0,
        },
        {
          sourceStartFrame: 24_000,
          sourceFrameCount: 24_000,
          sourcePitchCents: 7_200,
          targetPitchCents: 7_200,
          correctionAmount: 0,
          transitionFrames: 0,
        },
      ],
    };
    let tree = AudioPitchCorrectionEditor({
      project,
      clip,
      asset,
      warp: differentRegions,
      disabled: false,
      comparePitchBefore: false,
      onComparePitchBeforeChange: vi.fn(() => true),
      onCommit,
      onNotice: vi.fn(),
      onReject,
    });

    buttonByText(tree, '次と結合').props.onClick?.();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith('invalid-pitch-region');
    expect(audioWarpEditErrorMessage('invalid-pitch-region')).toBe(
      '隣り合い、音程と補正量が同じ区間だけを結合できます。',
    );

    buttonByText(tree, '区間を分割').props.onClick?.();
    const splitWarp = onCommit.mock.calls.at(-1)?.[0];
    expect(splitWarp).toMatchObject({
      pitchRegions: [
        expect.objectContaining({ sourceStartFrame: 0, sourceFrameCount: 12_000 }),
        expect.objectContaining({ sourceStartFrame: 12_000, sourceFrameCount: 12_000 }),
        expect.objectContaining({ sourceStartFrame: 24_000, sourceFrameCount: 24_000 }),
      ],
    });

    onCommit.mockClear();
    hooks.stateIndex = 0;
    hooks.refIndex = 0;
    hooks.states = [];
    hooks.refs = [];
    tree = AudioPitchCorrectionEditor({
      project,
      clip,
      asset,
      warp: splitWarp as AudioWarp,
      disabled: false,
      comparePitchBefore: false,
      onComparePitchBeforeChange: vi.fn(() => true),
      onCommit,
      onNotice: vi.fn(),
      onReject,
    });
    buttonByText(tree, '次と結合').props.onClick?.();
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        pitchRegions: [
          expect.objectContaining({ sourceStartFrame: 0, sourceFrameCount: 24_000 }),
          expect.objectContaining({ sourceStartFrame: 24_000, sourceFrameCount: 24_000 }),
        ],
      }),
      '次の音程補正区間と結合しました。',
    );
  });
});
