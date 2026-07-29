import {
  isValidElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleTabKeyDown } from '../src/features/common/tabs';
import { installLocalStorage } from './localStorageStub';

let EditorArea: typeof import('../src/features/editor/EditorArea')['EditorArea'];
let InspectorPanel: typeof import('../src/features/inspector/InspectorPanel')['InspectorPanel'];
let ProjectMenuContent: typeof import('../src/features/projectMenu/ProjectMenuContent')['ProjectMenuContent'];

beforeAll(async () => {
  installLocalStorage();
  ({ EditorArea } = await import('../src/features/editor/EditorArea'));
  ({ InspectorPanel } = await import('../src/features/inspector/InspectorPanel'));
  ({ ProjectMenuContent } = await import(
    '../src/features/projectMenu/ProjectMenuContent'
  ));
});

type TabProps = {
  children?: ReactNode;
  hidden?: boolean;
  id?: string;
  ref?: unknown;
  role?: string;
  tabIndex?: number;
  'aria-controls'?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-selected'?: boolean;
  onFocusCapture?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
};

function findByRole(node: ReactNode, role: string): ReactElement<TabProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => findByRole(child, role));
  }
  if (!isValidElement<TabProps>(node)) return [];

  const matches = node.props.role === role ? [node] : [];
  return [...matches, ...findByRole(node.props.children, role)];
}

function tabTags(html: string): string[] {
  return html.match(/<button(?=[^>]*role="tab")[^>]*>/g) ?? [];
}

function tabPanelTags(html: string): string[] {
  return html.match(/<[a-z]+(?=[^>]*role="tabpanel")[^>]*>/g) ?? [];
}

function attribute(tag: string, name: string): string | null {
  return tag.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? null;
}

function expectCompleteTabRelationships(html: string): void {
  const tabs = tabTags(html);
  const panels = tabPanelTags(html);

  expect(panels).toHaveLength(tabs.length);
  for (const tab of tabs) {
    const tabId = attribute(tab, 'id');
    const panelId = attribute(tab, 'aria-controls');
    expect(tabId).not.toBeNull();
    expect(panelId).not.toBeNull();
    expect(panels).toContainEqual(expect.stringContaining(`id="${panelId}"`));
    expect(panels).toContainEqual(
      expect.stringContaining(`aria-labelledby="${tabId}"`),
    );
  }

  expect(panels.filter((panel) => panel.includes('tabindex="0"'))).toHaveLength(1);
  expect(panels.filter((panel) => panel.includes('tabindex="-1"'))).toHaveLength(
    panels.length - 1,
  );
  expect(panels.filter((panel) => panel.includes(' hidden'))).toHaveLength(
    panels.length - 1,
  );
}

function expectRovingTabIndex(tags: readonly string[]): void {
  expect(tags.filter((tag) => tag.includes('aria-selected="true"'))).toHaveLength(1);
  expect(tags.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(1);
  expect(tags.filter((tag) => tag.includes('tabindex="-1"'))).toHaveLength(
    tags.length - 1,
  );
}

function keyboardEvent(
  key: string,
  focusById: Readonly<Record<string, ReturnType<typeof vi.fn>>>,
): {
  event: ReactKeyboardEvent<HTMLButtonElement>;
  preventDefault: ReturnType<typeof vi.fn>;
  getElementById: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  const getElementById = vi.fn((id: string) => {
    const focus = focusById[id];
    return focus ? { focus } : null;
  });
  const event = {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault,
    currentTarget: { ownerDocument: { getElementById } },
  } as unknown as ReactKeyboardEvent<HTMLButtonElement>;

  return { event, preventDefault, getElementById };
}

describe('accessible tab components', () => {
  it('keeps every editor tab linked to its labelled panel with roving tab stops', () => {
    const html = renderToStaticMarkup(<EditorArea />);
    const tags = tabTags(html);

    expect(tags).toHaveLength(6);
    expectRovingTabIndex(tags);
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.stringContaining('id="editor-tab-pianoRoll"'),
        expect.stringContaining('aria-controls="editor-tabpanel-pianoRoll"'),
        expect.stringContaining('id="editor-tab-drums"'),
        expect.stringContaining('aria-controls="editor-tabpanel-drums"'),
        expect.stringContaining('id="editor-tab-arranger"'),
        expect.stringContaining('aria-controls="editor-tabpanel-arranger"'),
        expect.stringContaining('id="editor-tab-automation"'),
        expect.stringContaining('aria-controls="editor-tabpanel-automation"'),
        expect.stringContaining('id="editor-tab-tempoMap"'),
        expect.stringContaining('aria-controls="editor-tabpanel-tempoMap"'),
        expect.stringContaining('id="editor-tab-comping"'),
        expect.stringContaining('aria-controls="editor-tabpanel-comping"'),
      ]),
    );
    expect(html).toContain('>テンポ / 拍子</button>');
    expect(html).toContain('>テイク編集</button>');
    expect(html).toContain('role="tablist" aria-label="エディタ切替"');
    expectCompleteTabRelationships(html);
  });

  it('keeps the controlled inspector tabs and onboarding ref on the ARIA pattern', () => {
    const tutorialTabRef = { current: null };
    const onTabChange = vi.fn();
    const tree = InspectorPanel({
      activeTab: 'tutorial',
      onTabChange,
      tutorialTabRef,
    });
    const tabs = findByRole(tree, 'tab');
    const tablist = findByRole(tree, 'tablist')[0];
    const tabpanels = findByRole(tree, 'tabpanel');

    expect(tablist?.props['aria-label']).toBe('右パネル切替');
    expect(tabs.map((tab) => tab.props.id)).toEqual([
      'right-tab-inspector',
      'right-tab-assistant',
      'right-tab-tutorial',
    ]);
    expect(tabs.map((tab) => tab.props['aria-controls'])).toEqual([
      'right-tabpanel-inspector',
      'right-tabpanel-assistant',
      'right-tabpanel-tutorial',
    ]);
    expect(tabs.map((tab) => tab.props.tabIndex)).toEqual([-1, -1, 0]);
    expect(tabs.map((tab) => tab.props['aria-selected'])).toEqual([
      false,
      false,
      true,
    ]);
    expect(tabs[2]?.props.ref).toBe(tutorialTabRef);
    expect(typeof tablist?.props.onFocusCapture).toBe('function');
    expect(tabpanels.map((panel) => panel.props.id)).toEqual([
      'right-tabpanel-inspector',
      'right-tabpanel-assistant',
      'right-tabpanel-tutorial',
    ]);
    expect(tabpanels.map((panel) => panel.props['aria-labelledby'])).toEqual([
      'right-tab-inspector',
      'right-tab-assistant',
      'right-tab-tutorial',
    ]);
    expect(tabpanels.map((panel) => panel.props.hidden)).toEqual([
      true,
      true,
      false,
    ]);
    expect(tabpanels.map((panel) => panel.props.tabIndex)).toEqual([-1, -1, 0]);

    const focusInspector = vi.fn();
    const { event, preventDefault } = keyboardEvent('ArrowRight', {
      'right-tab-inspector': focusInspector,
    });
    tabs[2]?.props.onKeyDown?.(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onTabChange).toHaveBeenCalledWith('inspector');
    expect(focusInspector).toHaveBeenCalledOnce();

    const html = renderToStaticMarkup(tree);
    expectCompleteTabRelationships(html);
  });

  it('labels every project-menu panel and keeps inactive targets in the DOM', () => {
    const html = renderToStaticMarkup(
      <ProjectMenuContent onDone={() => undefined} />,
    );
    const tags = tabTags(html);

    expect(tags).toHaveLength(2);
    expectRovingTabIndex(tags);
    expect(tags[0]).toContain('id="project-menu-tab-new"');
    expect(tags[0]).toContain('aria-controls="project-menu-tabpanel-new"');
    expect(tags[1]).toContain('id="project-menu-tab-saved"');
    expect(tags[1]).toContain('aria-controls="project-menu-tabpanel-saved"');
    expect(html).toContain(
      'role="tablist" aria-label="プロジェクト表示切替"',
    );
    expectCompleteTabRelationships(html);
  });
});

describe('tab keyboard navigation', () => {
  const tabs = ['first', 'middle', 'last'] as const;
  const tabId = (tab: (typeof tabs)[number]): string => `tab-${tab}`;

  it.each([
    ['ArrowLeft', 'first', 'last'],
    ['ArrowRight', 'last', 'first'],
    ['Home', 'last', 'first'],
    ['End', 'first', 'last'],
  ] as const)('%s selects and focuses %s -> %s', (key, current, destination) => {
    const focus = vi.fn();
    const onSelect = vi.fn();
    const { event, preventDefault, getElementById } = keyboardEvent(key, {
      [tabId(destination)]: focus,
    });

    handleTabKeyDown(event, tabs, current, onSelect, tabId);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(destination);
    expect(getElementById).toHaveBeenCalledWith(tabId(destination));
    expect(focus).toHaveBeenCalledOnce();
  });

  it('leaves unrelated keys and modified browser navigation alone', () => {
    const onSelect = vi.fn();
    const plain = keyboardEvent('Enter', {});
    handleTabKeyDown(plain.event, tabs, 'first', onSelect, tabId);

    const modified = keyboardEvent('ArrowLeft', {});
    Object.assign(modified.event, { altKey: true });
    handleTabKeyDown(modified.event, tabs, 'first', onSelect, tabId);

    expect(plain.preventDefault).not.toHaveBeenCalled();
    expect(modified.preventDefault).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
