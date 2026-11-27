import { describe, expect, it } from 'vitest';
import { isMacPlatform, matchShortcut, type ShortcutEventLike } from '../src/features/common/keymap';

function key(
  keyName: string,
  mods: Partial<Omit<ShortcutEventLike, 'key'>> = {},
): ShortcutEventLike {
  return {
    key: keyName,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  };
}

describe('central keymap', () => {
  it('binds Undo/Redo to Cmd on macOS and Ctrl elsewhere', () => {
    expect(matchShortcut(key('z', { metaKey: true }), 'global', true)).toBe('undo');
    expect(matchShortcut(key('z', { ctrlKey: true }), 'global', true)).toBeNull();
    expect(matchShortcut(key('Z', { metaKey: true, shiftKey: true }), 'global', true)).toBe('redo');

    expect(matchShortcut(key('z', { ctrlKey: true }), 'global', false)).toBe('undo');
    expect(matchShortcut(key('z', { metaKey: true }), 'global', false)).toBeNull();
    expect(matchShortcut(key('Z', { ctrlKey: true, shiftKey: true }), 'global', false)).toBe('redo');
    expect(matchShortcut(key('z', { ctrlKey: true, altKey: true }), 'global', false)).toBeNull();
    expect(matchShortcut(key('z'), 'global', false)).toBeNull();
  });

  it('keeps the pre-existing Save, Space, and Delete bindings unchanged', () => {
    for (const mac of [true, false]) {
      expect(matchShortcut(key('s', { ctrlKey: true }), 'global', mac)).toBe('save');
      expect(matchShortcut(key('S', { metaKey: true, shiftKey: true }), 'global', mac)).toBe('save');
      expect(matchShortcut(key('s'), 'global', mac)).toBeNull();
      expect(matchShortcut(key(' '), 'global', mac)).toBe('togglePlayback');
      expect(matchShortcut(key('x', { code: 'Space' }), 'global', mac)).toBe('togglePlayback');
      expect(matchShortcut(key(' ', { shiftKey: true }), 'global', mac)).toBe('togglePlayback');
      expect(matchShortcut(key('Delete'), 'pianoRoll', mac)).toBe('deleteSelectedNotes');
      expect(matchShortcut(key('Backspace'), 'pianoRoll', mac)).toBe('deleteSelectedNotes');
      expect(matchShortcut(key('Delete'), 'global', mac)).toBeNull();
    }
  });

  it('never fires during IME composition', () => {
    expect(matchShortcut(key('z', { ctrlKey: true, isComposing: true }), 'global', false)).toBeNull();
    expect(matchShortcut(key('Process', { keyCode: 229 }), 'global', false)).toBeNull();
    expect(matchShortcut(key(' ', { keyCode: 229 }), 'global', false)).toBeNull();
    expect(matchShortcut(key('Delete', { isComposing: true }), 'pianoRoll', false)).toBeNull();
  });

  it('cancels a gesture with Escape except during IME composition', () => {
    expect(matchShortcut(key('Escape'), 'gesture', false)).toBe('cancelGesture');
    expect(matchShortcut(key('Escape', { shiftKey: true }), 'gesture', true)).toBe('cancelGesture');
    expect(matchShortcut(key('Escape', { isComposing: true }), 'gesture', false)).toBeNull();
    expect(matchShortcut(key('Escape', { keyCode: 229 }), 'gesture', false)).toBeNull();
    expect(matchShortcut(key('Escape'), 'global', false)).toBeNull();
  });

  it('detects macOS from the navigator platform', () => {
    expect(isMacPlatform({ platform: 'MacIntel', userAgent: '' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32', userAgent: '' })).toBe(false);
    expect(isMacPlatform({ platform: 'Linux x86_64', userAgent: '' })).toBe(false);
    expect(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })).toBe(true);
  });
});

describe('P03 レビュー 3 回目の修正', () => {
  it('点・ハミング区間の Undo は Mac でも Ctrl+Z と Cmd+Z の両方で効き、AltGr では効かない', () => {
    expect(matchShortcut({ key: 'z', shiftKey: false, altKey: false, metaKey: false, ctrlKey: true } as never, 'control', true)).toBe('undo');
    expect(matchShortcut({ key: 'z', shiftKey: false, altKey: false, ctrlKey: false, metaKey: true } as never, 'control', true)).toBe('undo');
    expect(matchShortcut({ key: 'z', altKey: false, metaKey: false, ctrlKey: true, shiftKey: true } as never, 'control', true)).toBe('redo');
    expect(matchShortcut({ key: 'z', shiftKey: false, metaKey: false, ctrlKey: true, altKey: true } as never, 'control', false)).toBeNull();
    expect(matchShortcut({ key: 'z', shiftKey: false, altKey: false, metaKey: false, ctrlKey: true, keyCode: 229 } as never, 'control', false)).toBeNull();
  });
});

describe('note clipboard keys (P33)', () => {
  it('binds Copy/Cut/Paste to Cmd on macOS and Ctrl elsewhere, piano roll only', () => {
    expect(matchShortcut(key('c', { metaKey: true }), 'pianoRoll', true)).toBe('copyNotes');
    expect(matchShortcut(key('x', { metaKey: true }), 'pianoRoll', true)).toBe('cutNotes');
    expect(matchShortcut(key('v', { metaKey: true }), 'pianoRoll', true)).toBe('pasteNotes');
    expect(matchShortcut(key('V', { metaKey: true, shiftKey: true }), 'pianoRoll', true)).toBe('pasteNotesAtOriginal');
    expect(matchShortcut(key('c', { ctrlKey: true }), 'pianoRoll', true)).toBeNull();

    expect(matchShortcut(key('c', { ctrlKey: true }), 'pianoRoll', false)).toBe('copyNotes');
    expect(matchShortcut(key('x', { ctrlKey: true }), 'pianoRoll', false)).toBe('cutNotes');
    expect(matchShortcut(key('v', { ctrlKey: true }), 'pianoRoll', false)).toBe('pasteNotes');
    expect(matchShortcut(key('V', { ctrlKey: true, shiftKey: true }), 'pianoRoll', false)).toBe('pasteNotesAtOriginal');
    expect(matchShortcut(key('v', { ctrlKey: true, altKey: true }), 'pianoRoll', false)).toBeNull();
    expect(matchShortcut(key('c'), 'pianoRoll', false)).toBeNull();
    expect(matchShortcut(key('c', { ctrlKey: true }), 'global', false)).toBeNull();
  });

  it('does not fire during IME composition', () => {
    expect(matchShortcut(key('c', { ctrlKey: true, isComposing: true }), 'pianoRoll', false)).toBeNull();
    expect(matchShortcut(key('v', { ctrlKey: true, keyCode: 229 }), 'pianoRoll', false)).toBeNull();
  });
});
