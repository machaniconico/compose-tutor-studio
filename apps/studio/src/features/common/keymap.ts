// The one table of window-level keyboard shortcuts. Listeners resolve keys
// through `matchShortcut`, so the bindings live here and nowhere else.
// Focused controls can reuse these bindings for their local actions.

/** `gesture` is consulted only while a drag is active. */
export type ShortcutScope = 'global' | 'pianoRoll' | 'gesture' | 'control';

export type ShortcutAction =
  | 'togglePlayback'
  | 'save'
  | 'undo'
  | 'redo'
  | 'deleteSelectedNotes'
  | 'cancelGesture';

/**
 * `mod` is Cmd on macOS and Ctrl elsewhere, and the other modifiers must match
 * exactly. The two legacy values keep the bindings that predate this table
 * byte-for-byte: `ctrlOrMeta` accepts Ctrl or Cmd on every platform and
 * ignores Shift/Alt (Save); `any` ignores every modifier (Space, Delete).
 */
export type ShortcutModifier = 'mod' | 'shift' | 'ctrlOrMeta' | 'ctrlOrMetaNoAlt' | 'any';

export type ShortcutEntry = Readonly<{
  scope: ShortcutScope;
  /** Lower-case `KeyboardEvent.key`; `space` stands for the space bar. */
  key: string;
  modifiers: readonly ShortcutModifier[];
  action: ShortcutAction;
  labelJa: string;
}>;

export type ShortcutEventLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
> &
  Partial<Pick<KeyboardEvent, 'code' | 'defaultPrevented' | 'isComposing' | 'keyCode' | 'target'>>;

export const KEYMAP: readonly ShortcutEntry[] = [
  { scope: 'global', key: 'space', modifiers: ['any'], action: 'togglePlayback', labelJa: '再生/停止' },
  { scope: 'global', key: 's', modifiers: ['ctrlOrMeta'], action: 'save', labelJa: '保存する' },
  { scope: 'global', key: 'z', modifiers: ['mod'], action: 'undo', labelJa: '元に戻す' },
  { scope: 'global', key: 'z', modifiers: ['mod', 'shift'], action: 'redo', labelJa: 'やり直す' },
  { scope: 'pianoRoll', key: 'delete', modifiers: ['any'], action: 'deleteSelectedNotes', labelJa: '選んだ音を消す' },
  { scope: 'pianoRoll', key: 'backspace', modifiers: ['any'], action: 'deleteSelectedNotes', labelJa: '選んだ音を消す' },
  // 点やハミングの区間にフォーカスがあるときの Undo / Redo。従来どおり Ctrl と Cmd のどちらでも効く(Alt 付き = AltGr は除く)。
  { scope: 'control', key: 'z', modifiers: ['ctrlOrMetaNoAlt'], action: 'undo', labelJa: '元に戻す' },
  { scope: 'control', key: 'z', modifiers: ['ctrlOrMetaNoAlt', 'shift'], action: 'redo', labelJa: 'やり直す' },
  { scope: 'gesture', key: 'escape', modifiers: ['any'], action: 'cancelGesture', labelJa: 'ドラッグを取り消す' },
];

export function isMacPlatform(
  nav: Pick<Navigator, 'platform' | 'userAgent'> | undefined =
    typeof navigator === 'undefined' ? undefined : navigator,
): boolean {
  if (!nav) return false;
  const platform = (nav as { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? nav.platform
    ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform || nav.userAgent);
}

/** IME composition owns every key until it ends (keyCode 229 covers older engines). */
export function isImeComposing(event: ShortcutEventLike): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

function normalizedKey(event: ShortcutEventLike): string {
  if (event.key === ' ' || event.code === 'Space') return 'space';
  return event.key.toLowerCase();
}

function modifiersMatch(
  entry: ShortcutEntry,
  event: ShortcutEventLike,
  mac: boolean,
): boolean {
  if (entry.modifiers.includes('any')) return true;
  if (entry.modifiers.includes('ctrlOrMeta')) return event.ctrlKey || event.metaKey;
  const wantsShift = entry.modifiers.includes('shift');
  if (event.shiftKey !== wantsShift || event.altKey) return false;
  if (entry.modifiers.includes('ctrlOrMetaNoAlt')) return event.ctrlKey || event.metaKey;
  if (entry.modifiers.includes('mod')) {
    return mac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
  }
  return !event.ctrlKey && !event.metaKey;
}

/** Shared guard for both window shortcuts and control-local shortcuts. */
export function canHandleShortcut(event: ShortcutEventLike): boolean {
  return !event.defaultPrevented && !isImeComposing(event) && !isTypingTarget(event.target ?? null);
}

/** The action bound to this key event in `scope`, or null. */
export function matchShortcut(
  event: ShortcutEventLike,
  scope: ShortcutScope,
  mac: boolean = isMacPlatform(),
): ShortcutAction | null {
  if (scope === 'gesture') {
    if (event.defaultPrevented || isImeComposing(event)) return null;
    const target = event.target ?? null;
    if (typeof Element !== 'undefined' && target instanceof Element
      && (isTextEntryField(target.closest('input, textarea, select')) || isEditableTarget(target))) return null;
  } else if (!canHandleShortcut(event)) return null;
  const key = normalizedKey(event);
  const entry = KEYMAP.find(
    (candidate) =>
      candidate.scope === scope
      && candidate.key === key
      && modifiersMatch(candidate, event, mac),
  );
  return entry?.action ?? null;
}

/**
 * True inside editable content. Uses `isContentEditable` and, where the DOM
 * does not implement it (jsdom), the nearest `contenteditable` ancestor:
 * any value but "false" (``, "true", "plaintext-only") makes it editable.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (target instanceof HTMLElement && typeof target.isContentEditable === 'boolean') {
    return target.isContentEditable;
  }
  const host = target.closest('[contenteditable]');
  return host !== null
    && host.getAttribute('contenteditable')?.toLowerCase() !== 'false';
}

/** True when focus is in a text-entry field, where shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined'
    && target instanceof Element
    && (target.closest('input, textarea, select') !== null || isEditableTarget(target));
}

// ドラッグ取り消し(gesture)だけは、フォーカス中のスライダー等を文字入力とみなさない。
// Space などの全体ショートカットは従来どおりフォーカス中の input すべてで止める。
const NON_TEXT_INPUT_TYPES = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

function isTextEntryField(field: Element | null): boolean {
  if (field === null) return false;
  if (field.tagName !== 'INPUT') return true;
  return !NON_TEXT_INPUT_TYPES.has((field.getAttribute('type') ?? 'text').toLowerCase());
}
