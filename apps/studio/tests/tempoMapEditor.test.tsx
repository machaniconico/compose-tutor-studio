import {
  isValidElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
  stateIndex: 0,
  refIndex: 0,
  stateOverrides: new Map<number, unknown>(),
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
}));

const storeMock = vi.hoisted(() => ({
  state: {
    project: {
      lengthBars: 4,
      lengthBeats: 14,
      tempoMap: [
        { id: 'tempo-anchor', beat: 0, bpm: 120 },
        { id: 'tempo-two', beat: 8, bpm: 96 },
      ],
      timeSignatureMap: [
        {
          id: 'signature-anchor',
          beat: 0,
          numerator: 4,
          denominator: 4,
        },
        {
          id: 'signature-two',
          beat: 8,
          numerator: 3,
          denominator: 4,
        },
      ],
    },
    transport: { positionBeat: 5.25 },
    projectOperationBusy: false,
    audioRecordingOperationId: null as number | null,
  },
}));

const actionMocks = vi.hoisted(() => ({
  addTempo: vi.fn(),
  updateTempo: vi.fn(),
  removeTempo: vi.fn(),
  addSignature: vi.fn(),
  updateSignature: vi.fn(),
  removeSignature: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      hookState.effects.push(effect);
    }),
    useMemo: vi.fn((factory: () => unknown) => factory()),
    useRef: vi.fn((initialValue: unknown) => {
      const index = hookState.refIndex++;
      const ref = hookState.refs[index] ?? { current: initialValue };
      hookState.refs[index] = ref;
      return ref;
    }),
    useState: vi.fn((initialValue: unknown) => {
      const index = hookState.stateIndex++;
      const setter = vi.fn();
      hookState.stateSetters[index] = setter;
      return [
        hookState.stateOverrides.has(index)
          ? hookState.stateOverrides.get(index)
          : initialValue,
        setter,
      ];
    }),
  };
});

vi.mock('../src/state/store', () => ({
  useStore: (selector: (state: typeof storeMock.state) => unknown) =>
    selector(storeMock.state),
}));

vi.mock('../src/state/tempoMapActions', () => ({
  addStudioTempoMapEvent: actionMocks.addTempo,
  updateStudioTempoMapEvent: actionMocks.updateTempo,
  removeStudioTempoMapEvent: actionMocks.removeTempo,
  addStudioTimeSignatureMapEvent: actionMocks.addSignature,
  updateStudioTimeSignatureMapEvent: actionMocks.updateSignature,
  removeStudioTimeSignatureMapEvent: actionMocks.removeSignature,
  studioTempoMapErrorMessage: (code: string) => `error:${code}`,
}));

import { TempoMapEditor } from '../src/features/tempoMap/TempoMapEditor';

type ElementProps = {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  max?: number;
  role?: string;
  tabIndex?: number;
  type?: string;
  value?: string | number;
  'aria-label'?: string;
  'data-horizontal-scroll'?: string;
  'data-tempo-map-kind'?: string;
  'data-tempo-map-event-id'?: string;
  onClick?: () => void;
  onChange?: (event: {
    currentTarget: { value: string };
  }) => void;
  onKeyDown?: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
};

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isValidElement<ElementProps>(node)) return null;
  if (predicate(node)) return node;
  return findElement(node.props.children, predicate);
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
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
    (element) =>
      element.type === 'button' && textContent(element) === label,
  );
  if (found === null) throw new Error(`button not found: ${label}`);
  return found;
}

function marker(
  tree: ReactNode,
  kind: string,
  eventId: string,
): ReactElement<ElementProps> {
  const found = findElement(
    tree,
    (element) =>
      element.props['data-tempo-map-kind'] === kind
      && element.props['data-tempo-map-event-id'] === eventId,
  );
  if (found === null) throw new Error(`marker not found: ${kind}/${eventId}`);
  return found;
}

function inputWithValue(
  tree: ReactNode,
  value: string,
): ReactElement<ElementProps> {
  const found = findElement(
    tree,
    (element) =>
      element.type === 'input' && element.props.value === value,
  );
  if (found === null) throw new Error(`input not found: ${value}`);
  return found;
}

function renderEditor(
  stateOverrides: ReadonlyMap<number, unknown> = new Map(),
): ReactElement {
  hookState.stateIndex = 0;
  hookState.refIndex = 0;
  hookState.stateOverrides = new Map(stateOverrides);
  hookState.stateSetters = [];
  hookState.effects = [];
  hookState.refs = [];
  return TempoMapEditor();
}

const success = (
  map: 'tempo' | 'time-signature',
  eventId: string,
  changed = true,
) => ({
  ok: true,
  changed,
  map,
  eventId,
  playbackStopped: false,
}) as const;

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.state.project.lengthBars = 4;
  storeMock.state.project.lengthBeats = 14;
  storeMock.state.project.tempoMap = [
    { id: 'tempo-anchor', beat: 0, bpm: 120 },
    { id: 'tempo-two', beat: 8, bpm: 96 },
  ];
  storeMock.state.project.timeSignatureMap = [
    {
      id: 'signature-anchor',
      beat: 0,
      numerator: 4,
      denominator: 4,
    },
    {
      id: 'signature-two',
      beat: 8,
      numerator: 3,
      denominator: 4,
    },
  ];
  storeMock.state.transport.positionBeat = 5.25;
  storeMock.state.projectOperationBusy = false;
  storeMock.state.audioRecordingOperationId = null;
  actionMocks.addTempo.mockReturnValue(success('tempo', 'tempo-new'));
  actionMocks.updateTempo.mockReturnValue(success('tempo', 'tempo-two'));
  actionMocks.removeTempo.mockReturnValue(success('tempo', 'tempo-two'));
  actionMocks.addSignature.mockReturnValue(
    success('time-signature', 'signature-new'),
  );
  actionMocks.updateSignature.mockReturnValue(
    success('time-signature', 'signature-two'),
  );
  actionMocks.removeSignature.mockReturnValue(
    success('time-signature', 'signature-two'),
  );
});

describe('TempoMapEditor', () => {
  it('renders both native lanes on one internally scrollable timeline', () => {
    const tree = renderEditor();
    const html = renderToStaticMarkup(tree);

    expect(html).toContain(
      'data-horizontal-scroll="timeline-only"',
    );
    expect(html).toContain('style="width:720px"');
    expect(html).toContain('aria-label="テンポと拍子のタイムライン"');
    expect(html).toContain('aria-label="テンポレーン"');
    expect(html).toContain('aria-label="拍子レーン"');
    expect(html).toContain('data-tempo-map-anchor="true"');
    expect(html).toContain(
      'aria-label="テンポ 1件目、1小節 1拍、120 BPM、曲の先頭に固定"',
    );
    expect(html).toContain(
      'aria-label="拍子 1件目、1小節 1拍、4分の4、曲の先頭に固定"',
    );
    expect(html).toContain('data-tempo-map-playhead-beat="5.25"');
  });

  it('keeps both protected controls understandable in an anchor-only project', () => {
    storeMock.state.project.lengthBars = 4;
    storeMock.state.project.lengthBeats = 16;
    storeMock.state.project.tempoMap = [
      { id: 'tempo-anchor', beat: 0, bpm: 120 },
    ];
    storeMock.state.project.timeSignatureMap = [
      {
        id: 'signature-anchor',
        beat: 0,
        numerator: 4,
        denominator: 4,
      },
    ];

    const html = renderToStaticMarkup(renderEditor());
    expect(html).toContain('data-tempo-total-events="2"');
    expect(html).toContain('data-tempo-rendered-events="2"');
    expect(html).toContain('data-tempo-map-event-id="tempo-anchor"');
    expect(html).toContain('data-tempo-map-event-id="signature-anchor"');
    expect(html).toContain(
      '曲の先頭の2項目は固定ですが、BPMと拍子の値は変更できます。',
    );
  });

  it('keeps each lane keyboard-reachable after horizontal virtualization hides beat zero', () => {
    const tree = renderEditor(new Map<number, unknown>([
      [4, { scrollLeft: 300, width: 200 }],
    ]));

    expect(marker(tree, 'tempo', 'tempo-two').props.tabIndex).toBe(0);
    expect(
      marker(tree, 'time-signature', 'signature-two').props.tabIndex,
    ).toBe(0);
    expect(findElement(
      tree,
      (element) =>
        element.props['data-tempo-map-event-id'] === 'tempo-anchor',
    )).toBeNull();
    expect(findElement(
      tree,
      (element) =>
        element.props['data-tempo-map-event-id'] === 'signature-anchor',
    )).toBeNull();
  });

  it('adds a tempo at the exact playhead but snaps a signature to the containing bar start', () => {
    const tree = renderEditor();

    button(tree, '再生位置にテンポを追加').props.onClick?.();
    button(tree, '再生位置に拍子を追加').props.onClick?.();

    expect(actionMocks.addTempo).toHaveBeenCalledOnce();
    expect(actionMocks.addTempo).toHaveBeenCalledWith({
      beat: 5.25,
      bpm: 120,
    });
    expect(actionMocks.addSignature).toHaveBeenCalledOnce();
    expect(actionMocks.addSignature).toHaveBeenCalledWith({
      beat: 4,
      numerator: 4,
      denominator: 4,
    });
  });

  it('announces when an accepted edit stops playback but preserves the position', () => {
    actionMocks.addTempo.mockReturnValue({
      ...success('tempo', 'tempo-new'),
      playbackStopped: true,
    });
    const tree = renderEditor();

    button(tree, '再生位置にテンポを追加').props.onClick?.();

    expect(hookState.stateSetters[2]).toHaveBeenCalledWith({
      kind: 'status',
      message:
        '再生位置にテンポを追加しました。 安全に更新するため再生を停止し、再生位置は保持しました。',
    });
  });

  it('keeps drafts local and commits one combined tempo update per accepted edit', () => {
    const selection = { map: 'tempo', eventId: 'tempo-two' } as const;
    const draft = {
      map: 'tempo',
      eventId: 'tempo-two',
      beat: '12',
      bpm: '140',
    } as const;
    const tree = renderEditor(new Map([
      [0, selection],
      [1, draft],
    ]));

    inputWithValue(tree, '140').props.onChange?.({
      currentTarget: { value: '141' },
    });
    expect(actionMocks.updateTempo).not.toHaveBeenCalled();

    button(tree, '変更を反映').props.onClick?.();
    expect(actionMocks.updateTempo).toHaveBeenCalledOnce();
    expect(actionMocks.updateTempo).toHaveBeenCalledWith('tempo-two', {
      beat: 12,
      bpm: 140,
    });
  });

  it('preserves imported off-grid tempo scalars exactly unless that field is edited', () => {
    storeMock.state.project.tempoMap = [
      { id: 'tempo-anchor', beat: 0, bpm: 120 },
      {
        id: 'tempo-two',
        beat: 1.234567,
        bpm: 123.456789,
      },
    ];
    actionMocks.updateTempo.mockReturnValue(
      success('tempo', 'tempo-two', false),
    );
    const selection = { map: 'tempo', eventId: 'tempo-two' } as const;

    renderEditor(new Map([[0, selection]]));
    hookState.effects[1]?.();
    expect(hookState.stateSetters[1]).toHaveBeenCalledWith({
      map: 'tempo',
      eventId: 'tempo-two',
      beat: '1.234567',
      bpm: '123.456789',
    });

    const unchanged = renderEditor(new Map<number, unknown>([
      [0, selection],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-two',
          beat: '1.234567',
          bpm: '123.456789',
        },
      ],
    ]));
    button(unchanged, '変更を反映').props.onClick?.();

    const bpmOnly = renderEditor(new Map<number, unknown>([
      [0, selection],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-two',
          beat: '1.234567',
          bpm: '130',
        },
      ],
    ]));
    button(bpmOnly, '変更を反映').props.onClick?.();

    const beatOnly = renderEditor(new Map<number, unknown>([
      [0, selection],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-two',
          beat: '2.345678',
          bpm: '123.456789',
        },
      ],
    ]));
    button(beatOnly, '変更を反映').props.onClick?.();

    expect(actionMocks.updateTempo.mock.calls).toEqual([
      [
        'tempo-two',
        { beat: 1.234567, bpm: 123.456789 },
      ],
      [
        'tempo-two',
        { beat: 1.234567, bpm: 130 },
      ],
      [
        'tempo-two',
        { beat: 2.345678, bpm: 123.456789 },
      ],
    ]);
  });

  it('rejects invalid drafts before history actions and commits a signature as one action', () => {
    const invalidTempoTree = renderEditor(new Map([
      [0, { map: 'tempo', eventId: 'tempo-two' }],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-two',
          beat: '12',
          bpm: '301',
        },
      ],
    ]));
    button(invalidTempoTree, '変更を反映').props.onClick?.();
    expect(actionMocks.updateTempo).not.toHaveBeenCalled();
    expect(hookState.stateSetters[2]).toHaveBeenCalledWith({
      kind: 'error',
      message:
        'テンポは20〜300 BPMの範囲で入力してください。変更は反映されていません。',
    });

    const signatureTree = renderEditor(new Map([
      [0, { map: 'time-signature', eventId: 'signature-two' }],
      [
        1,
        {
          map: 'time-signature',
          eventId: 'signature-two',
          beat: '4',
          numerator: '5',
          denominator: '4',
        },
      ],
    ]));
    button(signatureTree, '変更を反映').props.onClick?.();
    expect(actionMocks.updateSignature).toHaveBeenCalledOnce();
    expect(actionMocks.updateSignature).toHaveBeenCalledWith(
      'signature-two',
      { beat: 4, numerator: 5, denominator: 4 },
    );
  });

  it('allows canonical endpoint events to keep their beat for value edits but not as a new move target', () => {
    const moveToEndTree = renderEditor(new Map<number, unknown>([
      [0, { map: 'tempo', eventId: 'tempo-two' }],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-two',
          beat: '14',
          bpm: '96',
        },
      ],
    ]));
    button(moveToEndTree, '変更を反映').props.onClick?.();
    expect(actionMocks.updateTempo).not.toHaveBeenCalled();

    storeMock.state.project.tempoMap = [
      ...storeMock.state.project.tempoMap,
      { id: 'tempo-end', beat: 14, bpm: 90 },
    ];
    const endpointNoOpTree = renderEditor(new Map<number, unknown>([
      [0, { map: 'tempo', eventId: 'tempo-end' }],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-end',
          beat: '14',
          bpm: '90',
        },
      ],
    ]));
    expect(inputWithValue(endpointNoOpTree, '14').props.max).toBe(14);
    button(endpointNoOpTree, '変更を反映').props.onClick?.();

    const endpointValueTree = renderEditor(new Map<number, unknown>([
      [0, { map: 'tempo', eventId: 'tempo-end' }],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-end',
          beat: '14',
          bpm: '95',
        },
      ],
    ]));
    button(endpointValueTree, '変更を反映').props.onClick?.();

    const endpointMoveTree = renderEditor(new Map<number, unknown>([
      [0, { map: 'tempo', eventId: 'tempo-end' }],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-end',
          beat: '12',
          bpm: '90',
        },
      ],
    ]));
    button(endpointMoveTree, '変更を反映').props.onClick?.();
    button(endpointMoveTree, 'このテンポを削除').props.onClick?.();

    expect(actionMocks.updateTempo.mock.calls).toEqual([
      ['tempo-end', { beat: 14, bpm: 90 }],
      ['tempo-end', { beat: 14, bpm: 95 }],
      ['tempo-end', { beat: 12, bpm: 90 }],
    ]);
    expect(actionMocks.removeTempo).toHaveBeenCalledWith('tempo-end');
  });

  it('accepts a near-end interior beat without allowing an exact-end move', () => {
    storeMock.state.project.lengthBars = 10;
    storeMock.state.project.lengthBeats = 32;
    const selection = { map: 'tempo', eventId: 'tempo-two' } as const;
    const nearEndTree = renderEditor(new Map<number, unknown>([
      [0, selection],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-two',
          beat: '31.9995',
          bpm: '96',
        },
      ],
    ]));
    const nearEndInput = inputWithValue(nearEndTree, '31.9995');
    expect(nearEndInput.props.max).toBeLessThan(32);
    expect(nearEndInput.props.max).toBeGreaterThan(31.9995);
    button(nearEndTree, '変更を反映').props.onClick?.();
    expect(actionMocks.updateTempo).toHaveBeenCalledWith('tempo-two', {
      beat: 31.9995,
      bpm: 96,
    });

    const exactEndTree = renderEditor(new Map<number, unknown>([
      [0, selection],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-two',
          beat: '32',
          bpm: '96',
        },
      ],
    ]));
    button(exactEndTree, '変更を反映').props.onClick?.();
    expect(actionMocks.updateTempo).toHaveBeenCalledOnce();
  });

  it('allows a canonical endpoint signature to keep its beat, move inward, or delete', () => {
    storeMock.state.project.timeSignatureMap = [
      ...storeMock.state.project.timeSignatureMap,
      {
        id: 'signature-end',
        beat: 14,
        numerator: 5,
        denominator: 8,
      },
    ];
    const valueTree = renderEditor(new Map<number, unknown>([
      [0, { map: 'time-signature', eventId: 'signature-end' }],
      [
        1,
        {
          map: 'time-signature',
          eventId: 'signature-end',
          beat: '14',
          numerator: '7',
          denominator: '8',
        },
      ],
    ]));
    expect(inputWithValue(valueTree, '14').props.max).toBe(14);
    button(valueTree, '変更を反映').props.onClick?.();

    const moveTree = renderEditor(new Map<number, unknown>([
      [0, { map: 'time-signature', eventId: 'signature-end' }],
      [
        1,
        {
          map: 'time-signature',
          eventId: 'signature-end',
          beat: '11',
          numerator: '3',
          denominator: '4',
        },
      ],
    ]));
    button(moveTree, '変更を反映').props.onClick?.();
    button(moveTree, 'この拍子を削除').props.onClick?.();

    expect(actionMocks.updateSignature.mock.calls).toEqual([
      [
        'signature-end',
        { beat: 14, numerator: 7, denominator: 8 },
      ],
      [
        'signature-end',
        { beat: 11, numerator: 3, denominator: 4 },
      ],
    ]);
    expect(actionMocks.removeSignature).toHaveBeenCalledWith('signature-end');
  });

  it('protects beat-zero positions and deletion while allowing anchor values to change', () => {
    const tempoTree = renderEditor(new Map([
      [0, { map: 'tempo', eventId: 'tempo-anchor' }],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-anchor',
          beat: '0',
          bpm: '130',
        },
      ],
    ]));

    expect(inputWithValue(tempoTree, '0').props.disabled).toBe(true);
    expect(button(tempoTree, 'このテンポを削除').props.disabled).toBe(true);
    button(tempoTree, '変更を反映').props.onClick?.();
    expect(actionMocks.updateTempo).toHaveBeenCalledWith('tempo-anchor', {
      bpm: 130,
    });

    const signatureTree = renderEditor(new Map([
      [0, { map: 'time-signature', eventId: 'signature-anchor' }],
      [
        1,
        {
          map: 'time-signature',
          eventId: 'signature-anchor',
          beat: '0',
          numerator: '3',
          denominator: '4',
        },
      ],
    ]));
    expect(button(signatureTree, 'この拍子を削除').props.disabled).toBe(true);
    button(signatureTree, '変更を反映').props.onClick?.();
    expect(actionMocks.updateSignature).toHaveBeenCalledWith(
      'signature-anchor',
      { numerator: 3, denominator: 4 },
    );
  });

  it('deletes one eligible event from the keyboard and selects a deterministic neighbor', () => {
    const tree = renderEditor();
    const preventDefault = vi.fn();
    marker(tree, 'tempo', 'tempo-two').props.onKeyDown?.({
      key: 'Delete',
      repeat: false,
      preventDefault,
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(actionMocks.removeTempo).toHaveBeenCalledOnce();
    expect(actionMocks.removeTempo).toHaveBeenCalledWith('tempo-two');
    expect(hookState.stateSetters[0]).toHaveBeenCalledWith({
      map: 'tempo',
      eventId: 'tempo-anchor',
    });
    expect(hookState.stateSetters[3]).toHaveBeenCalledWith({
      map: 'tempo',
      eventId: 'tempo-anchor',
    });
  });

  it('disables every mutation affordance while recording', () => {
    storeMock.state.audioRecordingOperationId = 77;
    const tree = renderEditor(new Map([
      [0, { map: 'tempo', eventId: 'tempo-two' }],
      [
        1,
        {
          map: 'tempo',
          eventId: 'tempo-two',
          beat: '8',
          bpm: '96',
        },
      ],
    ]));

    expect(button(tree, '再生位置にテンポを追加').props.disabled).toBe(true);
    expect(button(tree, '再生位置に拍子を追加').props.disabled).toBe(true);
    expect(button(tree, '変更を反映').props.disabled).toBe(true);
    expect(button(tree, 'このテンポを削除').props.disabled).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain(
      '録音中はテンポと拍子を編集できません。',
    );
  });
});
