import {
  isValidElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effectDeps: [] as Array<readonly unknown[] | undefined>,
  pendingEffects: [] as Array<() => void | (() => void)>,
}));

const actionMocks = vi.hoisted(() => ({
  paint: vi.fn(),
  moveBoundary: vi.fn(),
  deleteTake: vi.fn(),
}));

const readyAsset = (
  id: string,
  originalName: string,
  checksumCharacter: string,
) => ({
  id,
  availability: 'ready' as const,
  checksumSha256: checksumCharacter.repeat(64),
  originalName,
  mediaType: 'audio/wav' as const,
  byteLength: 768_044,
  sampleRate: 48_000,
  channelCount: 1,
  frameCount: 192_000,
});

const makeProject = () => ({
  tracks: [{
    id: 'audio-track',
    type: 'audio',
    name: 'リードボーカル',
    clips: [],
  }],
  audioAssets: [
    readyAsset('asset-a', 'take-one.wav', '1'),
    readyAsset('asset-b', 'take-two.wav', '2'),
    readyAsset('asset-c', 'unused.wav', '3'),
  ],
  audioTakeFolders: [{
    id: 'folder-one',
    trackId: 'audio-track',
    startBeat: 4,
    lengthBeats: 4,
    crossfadeMs: 5,
    takes: [
      {
        id: 'take-a',
        audioAssetId: 'asset-a',
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 0,
        sourceFrameCount: 192_000,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      },
      {
        id: 'take-b',
        audioAssetId: 'asset-b',
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 0,
        sourceFrameCount: 192_000,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      },
      {
        id: 'take-c',
        audioAssetId: 'asset-c',
        offsetBeats: 0,
        lengthBeats: 4,
        sourceStartFrame: 0,
        sourceFrameCount: 192_000,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      },
    ],
    compSegments: [
      {
        id: 'segment-a',
        takeId: 'take-a',
        offsetBeats: 0,
        lengthBeats: 2,
      },
      {
        id: 'segment-b',
        takeId: 'take-b',
        offsetBeats: 2,
        lengthBeats: 2,
      },
    ],
  }],
});

const storeMock = vi.hoisted(() => ({
  state: {
    project: {} as ReturnType<typeof makeProject>,
    editor: { selectedTakeFolderId: 'folder-one' as string | null },
    selectTakeFolder: vi.fn(),
    projectOperationBusy: false,
    audioRecordingOperationId: null as number | null,
    saveState: { phase: 'idle' as 'idle' | 'pending' | 'saved' | 'error' },
    audioAssetIssues: {} as Record<
      string,
      'missing' | 'changed' | 'unavailable'
    >,
  },
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  const depsChanged = (
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
  ) => (
    previous === undefined
    || next === undefined
    || previous.length !== next.length
    || previous.some((value, index) => !Object.is(value, next[index]))
  );
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
    useEffect: (
      effect: () => void | (() => void),
      dependencies?: readonly unknown[],
    ) => {
      const index = hooks.effectIndex++;
      if (depsChanged(hooks.effectDeps[index], dependencies)) {
        hooks.effectDeps[index] = dependencies;
        hooks.pendingEffects.push(effect);
      }
    },
  };
});

vi.mock('../src/state/store', () => ({
  useStore: (selector: (state: typeof storeMock.state) => unknown) =>
    selector(storeMock.state),
}));

vi.mock('../src/state/compingActions', () => ({
  paintStudioAudioCompRange: actionMocks.paint,
  moveStudioAudioCompBoundary: actionMocks.moveBoundary,
  deleteStudioUnusedAudioTake: actionMocks.deleteTake,
  studioCompingErrorMessage: (code: string) => `error:${code}`,
}));

import {
  TakeCompEditor,
  audioTakeFolderAssetBlockReason,
  nextTakeFocusId,
} from '../src/features/comping/TakeCompEditor';

type ElementProps = {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  value?: string | number;
  'aria-label'?: string;
  'data-take-id'?: string;
  'data-comp-state'?: string;
  'data-boundary-after'?: string;
  'data-preview-start'?: string;
  'data-preview-end'?: string;
  'data-horizontal-scroll'?: string;
  ref?: (node: { focus: () => void } | null) => void;
  onClick?: (event?: { detail?: number }) => void;
  onChange?: (event: { currentTarget: { value: string } }) => void;
  onKeyDown?: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  onPointerDown?: (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onPointerMove?: (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onPointerUp?: (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onPointerCancel?: (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
};

function resetHooks(): void {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  hooks.effectIndex = 0;
  hooks.states = [];
  hooks.refs = [];
  hooks.effectDeps = [];
  hooks.pendingEffects = [];
}

function renderEditor(): ReactElement {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  hooks.effectIndex = 0;
  return TakeCompEditor();
}

function flushEffects(): void {
  const effects = hooks.pendingEffects.splice(0);
  effects.forEach((effect) => effect());
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<ElementProps>(node)) return null;
  if (predicate(node)) return node;
  return findElement(node.props.children, predicate);
}

function findAll(
  node: ReactNode,
  predicate: (element: ReactElement<ElementProps>) => boolean,
): Array<ReactElement<ElementProps>> {
  if (Array.isArray(node)) {
    return node.flatMap((child) => findAll(child, predicate));
  }
  if (!isValidElement<ElementProps>(node)) return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...findAll(node.props.children, predicate),
  ];
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (!isValidElement<ElementProps>(node)) return '';
  return textContent(node.props.children);
}

function button(
  tree: ReactNode,
  label: string,
): ReactElement<ElementProps> {
  const found = findElement(
    tree,
    (element) => element.type === 'button' && textContent(element) === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function takeLane(
  tree: ReactNode,
  takeId: string,
): ReactElement<ElementProps> {
  const found = findElement(
    tree,
    (element) => element.props['data-take-id'] === takeId,
  );
  if (!found) throw new Error(`take lane not found: ${takeId}`);
  return found;
}

function pointerEvent(
  clientX: number,
  pointerId = 7,
): ReactPointerEvent<HTMLButtonElement> {
  const currentTarget = {
    getBoundingClientRect: () => ({
      left: 0,
      width: 100,
    }),
    focus: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
  };
  return {
    button: 0,
    clientX,
    pointerId,
    currentTarget,
    preventDefault: vi.fn(),
  } as unknown as ReactPointerEvent<HTMLButtonElement>;
}

const success = {
  ok: true,
  changed: true,
  folderId: 'folder-one',
  playbackStopped: false,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetHooks();
  storeMock.state.project = makeProject();
  storeMock.state.editor.selectedTakeFolderId = 'folder-one';
  storeMock.state.projectOperationBusy = false;
  storeMock.state.audioRecordingOperationId = null;
  storeMock.state.saveState.phase = 'idle';
  storeMock.state.audioAssetIssues = {};
  actionMocks.paint.mockReturnValue(success);
  actionMocks.moveBoundary.mockReturnValue(success);
  actionMocks.deleteTake.mockReturnValue(success);
});

describe('TakeCompEditor', () => {
  it('renders the finish row, take lanes, exact form, and boundary controls without claiming cycle recording', () => {
    const tree = renderEditor();
    const html = renderToStaticMarkup(tree);
    const deleteButtons = findAll(
      tree,
      (element) =>
        element.type === 'button'
        && element.props['aria-label']?.endsWith('を削除') === true,
    );

    expect(html).toContain('リードボーカルのテイク編集');
    expect(html).toContain('仕上がり');
    expect(html).toContain('take-one.wav');
    expect(html).toContain('take-two.wav');
    expect(html).toContain('unused.wav');
    expect(html).toContain('data-horizontal-scroll="timeline-only"');
    expect(html).toContain('>この範囲を採用</button>');
    expect(html).toContain('>つなぎ目を反映</button>');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).not.toContain('サイクル録音');
    expect(deleteButtons).toHaveLength(3);
    expect(deleteButtons[0]?.props.disabled).toBe(true);
    expect(deleteButtons[1]?.props.disabled).toBe(true);
    expect(deleteButtons[2]?.props.disabled).toBe(false);
    expect(takeLane(tree, 'take-a').props['data-comp-state']).toBe('used');
    expect(takeLane(tree, 'take-a').props['aria-label']).toContain('採用中');
    expect(takeLane(tree, 'take-c').props['data-comp-state']).toBe('unused');
    expect(takeLane(tree, 'take-c').props['aria-label']).toContain('未採用');
  });

  it('previews only in the finish row and commits exactly once on pointer up', () => {
    let tree = renderEditor();
    takeLane(tree, 'take-b').props.onPointerDown?.(pointerEvent(25));
    expect(actionMocks.paint).not.toHaveBeenCalled();

    tree = renderEditor();
    takeLane(tree, 'take-b').props.onPointerMove?.(pointerEvent(75));
    expect(actionMocks.paint).not.toHaveBeenCalled();

    tree = renderEditor();
    const preview = findElement(
      tree,
      (element) => element.props['data-preview-start'] === '1',
    );
    expect(preview?.props['data-preview-end']).toBe('3');
    const finishRow = findElement(
      tree,
      (element) => element.props.className === 'take-comp__finish-row',
    );
    expect(findElement(
      finishRow?.props.children,
      (element) => element.props['data-preview-start'] === '1',
    )).toBe(preview);
    expect(findElement(
      takeLane(tree, 'take-b').props.children,
      (element) => element.props['data-preview-start'] !== undefined,
    )).toBeNull();
    expect(finishRow?.props['aria-label']).toContain('未確定プレビュー');

    const lane = takeLane(tree, 'take-b');
    lane.props.onPointerUp?.(pointerEvent(75));
    lane.props.onPointerUp?.(pointerEvent(75));
    lane.props.onClick?.({ detail: 1 });

    expect(actionMocks.paint).toHaveBeenCalledOnce();
    expect(actionMocks.paint).toHaveBeenCalledWith(
      'folder-one',
      'take-b',
      1,
      2,
    );
    tree = renderEditor();
    const rangeValues = findAll(
      tree,
      (element) =>
        element.type === 'input'
        && element.props['data-boundary-after'] === undefined,
    ).map((element) => element.props.value);
    expect(rangeValues).toEqual(['1', '3']);
  });

  it('discards a stale pointer gesture when the Project changes', () => {
    let tree = renderEditor();
    flushEffects();
    tree = renderEditor();
    takeLane(tree, 'take-b').props.onPointerDown?.(pointerEvent(25, 21));
    tree = renderEditor();
    takeLane(tree, 'take-b').props.onPointerMove?.(pointerEvent(75, 21));
    expect(findElement(
      tree,
      (element) => element.props['data-preview-start'] === '1',
    )).not.toBeNull();

    storeMock.state.project = structuredClone(storeMock.state.project);
    tree = renderEditor();
    flushEffects();
    tree = renderEditor();

    expect(findElement(
      tree,
      (element) => element.props['data-preview-start'] !== undefined,
    )).toBeNull();
    expect(actionMocks.paint).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(tree)).toContain(
      '編集中にプロジェクトが変わったため、範囲選択を破棄しました',
    );
  });

  it('cancels pointer work without a mutation on pointercancel and Escape', () => {
    let tree = renderEditor();
    takeLane(tree, 'take-b').props.onPointerDown?.(pointerEvent(10, 11));
    tree = renderEditor();
    takeLane(tree, 'take-b').props.onPointerMove?.(pointerEvent(80, 11));
    tree = renderEditor();
    takeLane(tree, 'take-b').props.onPointerCancel?.(pointerEvent(80, 11));
    expect(actionMocks.paint).not.toHaveBeenCalled();
    tree = renderEditor();
    expect(renderToStaticMarkup(tree)).toContain(
      '範囲選択をキャンセルしました',
    );

    takeLane(tree, 'take-b').props.onPointerDown?.(pointerEvent(20, 12));
    tree = renderEditor();
    takeLane(tree, 'take-b').props.onKeyDown?.({
      key: 'Escape',
      preventDefault: vi.fn(),
      currentTarget: {
        hasPointerCapture: vi.fn(() => true),
        releasePointerCapture: vi.fn(),
      },
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>);

    expect(actionMocks.paint).not.toHaveBeenCalled();
    tree = renderEditor();
    expect(renderToStaticMarkup(tree)).toContain(
      '範囲選択をキャンセルしました',
    );
  });

  it('commits the exact take/start/end form and one numeric boundary edit', () => {
    let tree = renderEditor();
    const select = findElement(
      tree,
      (element) =>
        element.type === 'select'
        && element.props['aria-label'] === '採用するテイク',
    );
    select?.props.onChange?.({ currentTarget: { value: 'take-b' } });

    tree = renderEditor();
    const numericInputs = findAll(
      tree,
      (element) =>
        element.type === 'input'
        && element.props['data-boundary-after'] === undefined,
    );
    numericInputs[0]?.props.onChange?.({ currentTarget: { value: '1' } });
    tree = renderEditor();
    const updatedInputs = findAll(
      tree,
      (element) =>
        element.type === 'input'
        && element.props['data-boundary-after'] === undefined,
    );
    updatedInputs[1]?.props.onChange?.({ currentTarget: { value: '3' } });
    tree = renderEditor();
    button(tree, 'この範囲を採用').props.onClick?.();

    expect(actionMocks.paint).toHaveBeenCalledWith(
      'folder-one',
      'take-b',
      1,
      2,
    );

    tree = renderEditor();
    const boundaryInput = findElement(
      tree,
      (element) => element.props['data-boundary-after'] === 'segment-a',
    );
    boundaryInput?.props.onChange?.({ currentTarget: { value: '2.5' } });
    tree = renderEditor();
    button(tree, 'つなぎ目を反映').props.onClick?.();

    expect(actionMocks.moveBoundary).toHaveBeenCalledOnce();
    expect(actionMocks.moveBoundary).toHaveBeenCalledWith(
      'folder-one',
      'segment-a',
      2.5,
    );
  });

  it('deletes only an unused take and restores focus to a deterministic neighbor', () => {
    let tree = renderEditor();
    const focus = vi.fn();
    takeLane(tree, 'take-b').props.ref?.({ focus });

    const deleteUnused = findElement(
      tree,
      (element) =>
        element.type === 'button'
        && element.props['aria-label'] === 'テイク 3：unused.wavを削除',
    );
    deleteUnused?.props.onClick?.();

    expect(actionMocks.deleteTake).toHaveBeenCalledOnce();
    expect(actionMocks.deleteTake).toHaveBeenCalledWith(
      'folder-one',
      'take-c',
    );

    tree = renderEditor();
    flushEffects();
    expect(focus).toHaveBeenCalledOnce();
    expect(nextTakeFocusId(
      storeMock.state.project.audioTakeFolders[0]!.takes,
      'take-c',
    )).toBe('take-b');
  });

  it('disables mutations with a visible reason for every busy or unsafe asset state', () => {
    const cases: Array<{
      configure: () => void;
      message: string;
    }> = [
      {
        configure: () => {
          storeMock.state.projectOperationBusy = true;
        },
        message: 'プロジェクトを切り替えています。',
      },
      {
        configure: () => {
          storeMock.state.audioRecordingOperationId = 41;
        },
        message: '録音中はテイクを編集できません。',
      },
      {
        configure: () => {
          storeMock.state.saveState.phase = 'pending';
        },
        message: 'プロジェクトを保存しています。',
      },
      {
        configure: () => {
          storeMock.state.audioAssetIssues = { 'asset-b': 'changed' };
        },
        message: '音声素材が変更または破損しています。',
      },
      {
        configure: () => {
          storeMock.state.project.audioAssets[0] = {
            id: 'asset-a',
            availability: 'unresolved',
            reason: 'missing-reference',
          } as never;
        },
        message: '未解決の音声素材があります。',
      },
      {
        configure: () => {
          storeMock.state.project.audioAssets =
            storeMock.state.project.audioAssets.filter(
              (asset) => asset.id !== 'asset-c',
            );
        },
        message: '音声素材がプロジェクト内にありません。',
      },
    ];

    for (const fixture of cases) {
      resetHooks();
      storeMock.state.project = makeProject();
      storeMock.state.projectOperationBusy = false;
      storeMock.state.audioRecordingOperationId = null;
      storeMock.state.saveState.phase = 'idle';
      storeMock.state.audioAssetIssues = {};
      fixture.configure();

      const tree = renderEditor();
      const html = renderToStaticMarkup(tree);
      expect(html).toContain(fixture.message);
      expect(button(tree, 'この範囲を採用').props.disabled).toBe(true);
      expect(button(tree, 'つなぎ目を反映').props.disabled).toBe(true);
      expect(takeLane(tree, 'take-a').props.disabled).toBe(true);
    }
  });

  it('renders actionable empty and stale-selection states', () => {
    storeMock.state.editor.selectedTakeFolderId = null;
    let tree = renderEditor();
    expect(renderToStaticMarkup(tree)).toContain(
      '編集するテイクフォルダーを選んでください。',
    );
    const folderButton = findElement(
      tree,
      (element) =>
        element.type === 'button'
        && textContent(element).includes('リードボーカル'),
    );
    folderButton?.props.onClick?.();
    expect(storeMock.state.selectTakeFolder).toHaveBeenCalledWith('folder-one');

    resetHooks();
    storeMock.state.editor.selectedTakeFolderId = 'stale-folder';
    tree = renderEditor();
    expect(renderToStaticMarkup(tree)).toContain(
      '選択したテイクフォルダーを読み込めませんでした。',
    );
    button(tree, '選択を解除').props.onClick?.();
    expect(storeMock.state.selectTakeFolder).toHaveBeenCalledWith(null);
  });

  it('reports runtime asset issues through the folder safety gate', () => {
    const project = makeProject();
    const folder = project.audioTakeFolders[0]!;
    expect(audioTakeFolderAssetBlockReason(project as never, folder, {})).toBeNull();
    expect(
      audioTakeFolderAssetBlockReason(
        project as never,
        folder,
        { 'asset-a': 'unavailable' },
      ),
    ).toContain('現在読み込めません');
  });
});
