// The one table of keyboard shortcuts. Listeners look keys up here and the
// shortcut help dialog lists it, so what the app does and what it says stay in
// step. Whether a shortcut may fire at all (typing in an input, open dialog) is
// each listener's check.

export type ShortcutScope = 'global' | 'pianoRoll' | 'arrange' | 'liveInput';

export type ShortcutAction =
  | 'save'
  | 'togglePlayback'
  | 'undo'
  | 'redo'
  | 'showShortcutHelp'
  | 'seekToStart'
  | 'seekBarBack'
  | 'seekBarForward'
  | 'deleteSelectedNotes'
  | 'quantizeSelection'
  | 'toggleScaleSnap'
  | 'toggleChordToneHighlight'
  | 'duplicateClip'
  | 'deleteClip';

/** `mod` is Ctrl on Windows/Linux and Cmd on macOS; either one matches. */
export type ShortcutModifier = 'mod' | 'shift' | 'alt';

export type ShortcutEntry = {
  scope: ShortcutScope;
  /** Lower-case `KeyboardEvent.key`, with `space` standing for the space bar. */
  key: string;
  modifiers: readonly ShortcutModifier[];
  action: ShortcutAction;
  labelJa: string;
};

export type ShortcutEventLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
> &
  Partial<Pick<KeyboardEvent, 'code'>>;

export const KEYMAP: readonly ShortcutEntry[] = [
  { scope: 'global', key: 'space', modifiers: [], action: 'togglePlayback', labelJa: '再生/停止' },
  { scope: 'global', key: 'z', modifiers: ['mod'], action: 'undo', labelJa: '元に戻す' },
  { scope: 'global', key: 'z', modifiers: ['mod', 'shift'], action: 'redo', labelJa: 'やり直す' },
  { scope: 'global', key: 'y', modifiers: ['mod'], action: 'redo', labelJa: 'やり直す' },
  { scope: 'global', key: 's', modifiers: ['mod'], action: 'save', labelJa: '保存する' },
  { scope: 'global', key: 'home', modifiers: [], action: 'seekToStart', labelJa: '曲の先頭へ戻る' },
  {
    scope: 'global',
    key: 'arrowleft',
    modifiers: ['mod'],
    action: 'seekBarBack',
    labelJa: '1小節前へ戻る',
  },
  {
    scope: 'global',
    key: 'arrowright',
    modifiers: ['mod'],
    action: 'seekBarForward',
    labelJa: '1小節先へ進む',
  },
  { scope: 'global', key: '?', modifiers: [], action: 'showShortcutHelp', labelJa: 'この一覧を開く' },
  {
    scope: 'pianoRoll',
    key: 'delete',
    modifiers: [],
    action: 'deleteSelectedNotes',
    labelJa: '選んだ音を消す',
  },
  {
    scope: 'pianoRoll',
    key: 'backspace',
    modifiers: [],
    action: 'deleteSelectedNotes',
    labelJa: '選んだ音を消す',
  },
  {
    scope: 'pianoRoll',
    key: 'q',
    modifiers: [],
    action: 'quantizeSelection',
    labelJa: '選んだ音のタイミングをマス目にそろえる',
  },
  {
    scope: 'pianoRoll',
    key: 's',
    modifiers: [],
    action: 'toggleScaleSnap',
    labelJa: 'スケールの音だけに吸着する機能の切り替え',
  },
  {
    scope: 'pianoRoll',
    key: 'c',
    modifiers: [],
    action: 'toggleChordToneHighlight',
    labelJa: 'コードの音を色で示す機能の切り替え',
  },
  {
    scope: 'arrange',
    key: 'd',
    modifiers: ['mod'],
    action: 'duplicateClip',
    labelJa: '選んだクリップをすぐ後ろに複製する',
  },
  { scope: 'arrange', key: 'delete', modifiers: [], action: 'deleteClip', labelJa: '選んだクリップを消す' },
];

const SCOPE_TITLES_JA: Record<ShortcutScope, string> = {
  global: 'どの画面でも',
  pianoRoll: 'ピアノロールを開いているとき',
  arrange: '曲全体ビューを開いているとき',
  liveInput: 'キーボードで演奏しているとき',
};

const SPACE_KEYS = new Set([' ', 'space', 'spacebar']);

function eventKey(event: ShortcutEventLike): string {
  const key = event.key.toLowerCase();
  return SPACE_KEYS.has(key) || event.code === 'Space' ? 'space' : key;
}

/** Find the action bound to a key press in one scope. */
export function findShortcut(
  scope: ShortcutScope,
  event: ShortcutEventLike,
): ShortcutAction | null {
  const key = eventKey(event);
  const mod = event.ctrlKey || event.metaKey;
  // `?` needs Shift on most layouts, so Shift is part of the character there.
  const shift = key !== '?' && event.shiftKey;
  const entry = KEYMAP.find(
    (candidate) =>
      candidate.scope === scope &&
      candidate.key === key &&
      candidate.modifiers.includes('mod') === mod &&
      candidate.modifiers.includes('shift') === shift &&
      candidate.modifiers.includes('alt') === event.altKey,
  );
  return entry?.action ?? null;
}

/** Identity of a key combination, independent of modifier order. */
export function shortcutBindingId(entry: ShortcutEntry): string {
  return [...[...entry.modifiers].sort(), entry.key].join('+');
}

const MODIFIER_LABELS: Record<ShortcutModifier, string> = {
  mod: 'Ctrl/Cmd',
  shift: 'Shift',
  alt: 'Alt',
};

const KEY_LABELS: Record<string, string> = {
  space: 'Space',
  delete: 'Delete',
  backspace: 'Backspace',
  home: 'Home',
  arrowleft: '←',
  arrowright: '→',
};

/** Key combination as shown to the user, e.g. `Ctrl/Cmd+Shift+Z`. */
export function shortcutKeyLabel(entry: ShortcutEntry): string {
  const key = KEY_LABELS[entry.key] ?? entry.key.toUpperCase();
  return [...entry.modifiers.map((modifier) => MODIFIER_LABELS[modifier]), key].join('+');
}

export type ShortcutHelpGroup = {
  scope: ShortcutScope;
  titleJa: string;
  entries: ShortcutEntry[];
};

/** Keymap grouped by scope for display; scopes without shortcuts are left out. */
export function shortcutHelpGroups(): ShortcutHelpGroup[] {
  return (Object.keys(SCOPE_TITLES_JA) as ShortcutScope[])
    .map((scope) => ({
      scope,
      titleJa: SCOPE_TITLES_JA[scope],
      entries: KEYMAP.filter((entry) => entry.scope === scope),
    }))
    .filter((group) => group.entries.length > 0);
}
