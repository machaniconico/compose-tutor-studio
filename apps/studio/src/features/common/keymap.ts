// The one table of window-level keyboard shortcuts. Listeners resolve keys
// through `matchShortcut`, so the bindings live here and nowhere else.
// Focused controls can reuse these bindings for their local actions.

/**
 * `gesture` is consulted only while a drag is active. `playing` is consulted
 * only while PC-keyboard playing mode is on; its letters are matched by
 * physical key (`code`) so they stay put on any keyboard layout. `stepInput`
 * (Enter = rest, Backspace = step back) is consulted only while piano-roll
 * step input is on; it shares no key with `playing`.
 */
export type ShortcutScope = 'global' | 'pianoRoll' | 'stepInput' | 'gesture' | 'control' | 'playing';

export type ShortcutAction =
  | 'togglePlayback'
  | 'save'
  | 'undo'
  | 'redo'
  | 'deleteSelectedNotes'
  | 'copyNotes'
  | 'cutNotes'
  | 'pasteNotes'
  | 'pasteNotesAtOriginal'
  | 'nudgeLeft'
  | 'nudgeRight'
  | 'transposeUpSemitone'
  | 'transposeDownSemitone'
  | 'transposeUpOctave'
  | 'transposeDownOctave'
  | 'stepRest'
  | 'stepBack'
  | 'cancelGesture'
  | 'playNote'
  | 'octaveDown'
  | 'octaveUp'
  | 'exitPlayingMode';

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
  // ノートのクリップボード(アプリ内だけ。OS のクリップボードは使わない)。
  { scope: 'pianoRoll', key: 'c', modifiers: ['mod'], action: 'copyNotes', labelJa: '選んだ音をコピー' },
  { scope: 'pianoRoll', key: 'x', modifiers: ['mod'], action: 'cutNotes', labelJa: '選んだ音を切り取り' },
  { scope: 'pianoRoll', key: 'v', modifiers: ['mod'], action: 'pasteNotes', labelJa: '貼り付け(再生ヘッドがクリップ内ならその位置、外ならコピーした位置)' },
  { scope: 'pianoRoll', key: 'v', modifiers: ['mod', 'shift'], action: 'pasteNotesAtOriginal', labelJa: 'コピーした時と同じ位置に貼り付け' },
  // 矢印で選んだ音を動かす(P34)。←→ はグリッド 1 つ分、↑↓ は半音、Shift+↑↓ は 1 オクターブ。
  // 修飾キーはちょうど一致したときだけ(Ctrl・Cmd・Alt 付きは対象外)。PC 鍵盤・ステップ入力のキーとは重ならない。
  { scope: 'pianoRoll', key: 'arrowleft', modifiers: [], action: 'nudgeLeft', labelJa: '選んだ音をグリッド 1 つ分、前へ' },
  { scope: 'pianoRoll', key: 'arrowright', modifiers: [], action: 'nudgeRight', labelJa: '選んだ音をグリッド 1 つ分、後ろへ' },
  { scope: 'pianoRoll', key: 'arrowup', modifiers: [], action: 'transposeUpSemitone', labelJa: '選んだ音を半音上げる' },
  { scope: 'pianoRoll', key: 'arrowdown', modifiers: [], action: 'transposeDownSemitone', labelJa: '選んだ音を半音下げる' },
  { scope: 'pianoRoll', key: 'arrowup', modifiers: ['shift'], action: 'transposeUpOctave', labelJa: '選んだ音を 1 オクターブ上げる' },
  { scope: 'pianoRoll', key: 'arrowdown', modifiers: ['shift'], action: 'transposeDownOctave', labelJa: '選んだ音を 1 オクターブ下げる' },
  // ステップ入力(ピアノロールのステップ入力がオンの間だけ参照する。修飾キーなし = AltGr・Ctrl・Cmd 付きは対象外)。
  { scope: 'stepInput', key: 'enter', modifiers: [], action: 'stepRest', labelJa: 'ステップ入力: 休符(カーソルだけ進める)' },
  { scope: 'stepInput', key: 'backspace', modifiers: [], action: 'stepBack', labelJa: 'ステップ入力: 最後の入力を消して戻る' },
  // 点やハミングの区間にフォーカスがあるときの Undo / Redo。従来どおり Ctrl と Cmd のどちらでも効く(Alt 付き = AltGr は除く)。
  { scope: 'control', key: 'z', modifiers: ['ctrlOrMetaNoAlt'], action: 'undo', labelJa: '元に戻す' },
  { scope: 'control', key: 'z', modifiers: ['ctrlOrMetaNoAlt', 'shift'], action: 'redo', labelJa: 'やり直す' },
  { scope: 'gesture', key: 'escape', modifiers: ['any'], action: 'cancelGesture', labelJa: 'ドラッグを取り消す' },
  // PC 鍵盤で弾くモード(オンの間だけ)。装飾キー無しの文字キーだけ。
  ...[...'awsedftgyhujkl'].map((key): ShortcutEntry => (
    { scope: 'playing', key, modifiers: [], action: 'playNote', labelJa: '音を鳴らす' }
  )),
  { scope: 'playing', key: 'z', modifiers: [], action: 'octaveDown', labelJa: 'オクターブを下げる' },
  { scope: 'playing', key: 'x', modifiers: [], action: 'octaveUp', labelJa: 'オクターブを上げる' },
  { scope: 'playing', key: 'escape', modifiers: ['any'], action: 'exitPlayingMode', labelJa: 'PC鍵盤で弾くをやめる' },
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

/**
 * IME composition owns every key until it ends. keyCode 229 covers older
 * engines; key "Process" / "Unidentified" mark IME keydowns that report
 * isComposing=false and keyCode 0.
 */
export function isImeComposing(event: ShortcutEventLike): boolean {
  return event.isComposing === true
    || event.keyCode === 229
    || event.key === 'Process'
    || event.key === 'Unidentified';
}

function normalizedKey(event: ShortcutEventLike, scope: ShortcutScope): string {
  if (scope === 'playing' && typeof event.code === 'string' && /^Key[A-Z]$/.test(event.code)) {
    return event.code.slice(3).toLowerCase();
  }
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
  // gesture / playing: a focused checkbox or slider is not a text field (the lock checkbox keeps Esc and the keys working).
  if (scope === 'gesture' || scope === 'playing') {
    if (event.defaultPrevented || isImeComposing(event)) return null;
    const target = event.target ?? null;
    if (typeof Element !== 'undefined' && target instanceof Element
      && (isTextEntryField(target.closest('input, textarea, select')) || isEditableTarget(target))) return null;
  } else if (!canHandleShortcut(event)) return null;
  const key = normalizedKey(event, scope);
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
