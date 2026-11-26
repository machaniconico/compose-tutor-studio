import { describe, expect, it } from 'vitest';
import {
  KEYMAP,
  findShortcut,
  shortcutBindingId,
  shortcutHelpGroups,
  shortcutKeyLabel,
  type ShortcutEventLike,
} from '../src/state/keymap';

function press(key: string, init: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init };
}

const JAPANESE = /[぀-ヿ一-鿿]/;

describe('keymap table', () => {
  it('has no duplicate key+modifiers within a scope', () => {
    const seen = new Set<string>();
    for (const entry of KEYMAP) {
      const id = `${entry.scope}:${shortcutBindingId(entry)}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
    }
  });

  it('treats modifier order as irrelevant when detecting duplicates', () => {
    const base = { scope: 'global', key: 'z', action: 'redo', labelJa: 'x' } as const;
    expect(shortcutBindingId({ ...base, modifiers: ['mod', 'shift'] })).toBe(
      shortcutBindingId({ ...base, modifiers: ['shift', 'mod'] }),
    );
  });

  it('includes the required global shortcuts', () => {
    expect(findShortcut('global', press(' '))).toBe('togglePlayback');
    expect(findShortcut('global', press('z', { ctrlKey: true }))).toBe('undo');
    expect(findShortcut('global', press('z', { metaKey: true }))).toBe('undo');
    expect(findShortcut('global', press('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(findShortcut('global', press('Z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(findShortcut('global', press('?', { shiftKey: true }))).toBe('showShortcutHelp');
    expect(findShortcut('global', press('?'))).toBe('showShortcutHelp');
  });

  it('looks up piano-roll keys only in their scope and requires exact modifiers', () => {
    expect(findShortcut('pianoRoll', press('Q'))).toBe('quantizeSelection');
    expect(findShortcut('pianoRoll', press('Delete'))).toBe('deleteSelectedNotes');
    expect(findShortcut('pianoRoll', press('Backspace'))).toBe('deleteSelectedNotes');
    expect(findShortcut('global', press('q'))).toBeNull();
    // Ctrl+C はコピーで、C(コードの音の色分け)としては扱わない。
    expect(findShortcut('pianoRoll', press('c', { ctrlKey: true }))).toBe('copyNotes');
    expect(findShortcut('pianoRoll', press('q', { ctrlKey: true }))).toBeNull();
    expect(findShortcut('global', press('z', { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('gives every entry a Japanese label and a readable key name', () => {
    for (const entry of KEYMAP) {
      expect(entry.labelJa, entry.action).toMatch(JAPANESE);
      expect(shortcutKeyLabel(entry).length).toBeGreaterThan(0);
    }
    const undo = KEYMAP.find((entry) => entry.action === 'undo');
    expect(undo && shortcutKeyLabel(undo)).toBe('Ctrl/Cmd+Z');
  });

  it('groups all entries by scope for the help dialog', () => {
    const groups = shortcutHelpGroups();
    expect(groups.flatMap((group) => group.entries)).toHaveLength(KEYMAP.length);
    for (const group of groups) {
      expect(group.titleJa).toMatch(JAPANESE);
      expect(group.entries.length).toBeGreaterThan(0);
    }
  });
});

describe('seek shortcuts', () => {
  it('binds Home and Ctrl/Cmd+Left/Right in the global scope without clashing', () => {
    expect(findShortcut('global', press('Home'))).toBe('seekToStart');
    expect(findShortcut('global', press('ArrowLeft', { ctrlKey: true }))).toBe('seekBarBack');
    expect(findShortcut('global', press('ArrowRight', { metaKey: true }))).toBe('seekBarForward');
    expect(findShortcut('global', press('ArrowLeft'))).toBeNull();
    const ids = KEYMAP.filter((e) => e.scope === 'global').map(shortcutBindingId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('arrange shortcuts', () => {
  it('binds Ctrl/Cmd+D to duplicate and Delete to delete only in the arrange scope', () => {
    expect(findShortcut('arrange', press('d', { ctrlKey: true }))).toBe('duplicateClip');
    expect(findShortcut('arrange', press('D', { metaKey: true }))).toBe('duplicateClip');
    expect(findShortcut('arrange', press('Delete'))).toBe('deleteClip');
    expect(findShortcut('arrange', press('d'))).toBeNull();
    expect(findShortcut('global', press('d', { ctrlKey: true }))).toBeNull();
    expect(findShortcut('pianoRoll', press('d', { ctrlKey: true }))).toBeNull();
    const duplicate = KEYMAP.find((entry) => entry.action === 'duplicateClip');
    expect(duplicate && shortcutKeyLabel(duplicate)).toBe('Ctrl/Cmd+D');
  });
});

describe('piano-roll note editing shortcuts', () => {
  it('binds Ctrl/Cmd+C/X/V/A to copy, cut, paste and select all', () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(findShortcut('pianoRoll', press('c', init))).toBe('copyNotes');
      expect(findShortcut('pianoRoll', press('x', init))).toBe('cutNotes');
      expect(findShortcut('pianoRoll', press('v', init))).toBe('pasteNotes');
      expect(findShortcut('pianoRoll', press('a', init))).toBe('selectAllNotes');
    }
    expect(findShortcut('pianoRoll', press('c'))).toBe('toggleChordToneHighlight');
    expect(findShortcut('pianoRoll', press('v'))).toBeNull();
    expect(findShortcut('global', press('c', { ctrlKey: true }))).toBeNull();
  });

  it('binds ↑/↓ to a semitone and Alt+↑/↓ to a scale degree', () => {
    expect(findShortcut('pianoRoll', press('ArrowUp'))).toBe('transposeUpSemitone');
    expect(findShortcut('pianoRoll', press('ArrowDown'))).toBe('transposeDownSemitone');
    expect(findShortcut('pianoRoll', press('ArrowUp', { altKey: true }))).toBe('transposeUpDegree');
    expect(findShortcut('pianoRoll', press('ArrowDown', { altKey: true }))).toBe('transposeDownDegree');
    expect(findShortcut('pianoRoll', press('ArrowUp', { ctrlKey: true }))).toBeNull();
    const up = KEYMAP.find((entry) => entry.action === 'transposeUpDegree');
    expect(up && shortcutKeyLabel(up)).toBe('Alt+↑');
  });

  it('US-015: ↑/↓ は半音、Shift+↑/↓ はオクターブ、←/→ は時間方向、加工は L/T/J/K に重複なく割り当てる', () => {
    // ↑/↓ の半音移動は US-014 の半音移調と同じ操作(1 つのアクション)。
    expect(findShortcut('pianoRoll', press('ArrowUp'))).toBe('transposeUpSemitone');
    expect(findShortcut('pianoRoll', press('ArrowDown'))).toBe('transposeDownSemitone');
    expect(findShortcut('pianoRoll', press('ArrowUp', { shiftKey: true }))).toBe('transposeUpOctave');
    expect(findShortcut('pianoRoll', press('ArrowDown', { shiftKey: true }))).toBe('transposeDownOctave');
    expect(findShortcut('pianoRoll', press('ArrowLeft'))).toBe('nudgeLeft');
    expect(findShortcut('pianoRoll', press('ArrowRight'))).toBe('nudgeRight');
    expect(findShortcut('pianoRoll', press('l'))).toBe('legatoNotes');
    expect(findShortcut('pianoRoll', press('t'))).toBe('staccatoNotes');
    expect(findShortcut('pianoRoll', press('j'))).toBe('joinNotes');
    expect(findShortcut('pianoRoll', press('k'))).toBe('splitNotesAtPlayhead');
    // Ctrl/Cmd+←/→ は従来どおりどの画面でも小節移動で、ピアノロールの ←/→ とは別。
    expect(findShortcut('pianoRoll', press('ArrowLeft', { ctrlKey: true }))).toBeNull();
    expect(findShortcut('global', press('ArrowLeft', { ctrlKey: true }))).toBe('seekBarBack');
    expect(findShortcut('global', press('ArrowLeft'))).toBeNull();
    // 加工コマンドは 1 つのキーにだけ割り当て、↑/↓ に別名の移動アクションを作らない。
    const pianoRoll = KEYMAP.filter((e) => e.scope === 'pianoRoll');
    for (const action of ['transposeUpOctave', 'transposeDownOctave', 'nudgeLeft', 'nudgeRight', 'legatoNotes', 'staccatoNotes', 'joinNotes', 'splitNotesAtPlayhead', 'transposeUpSemitone', 'transposeDownSemitone']) {
      expect(pianoRoll.filter((e) => e.action === action), action).toHaveLength(1);
    }
    const arrowActions = pianoRoll.filter((e) => e.key.startsWith('arrow')).map((e) => e.action);
    expect(new Set(arrowActions).size).toBe(arrowActions.length);
    const octave = KEYMAP.find((entry) => entry.action === 'transposeUpOctave');
    expect(octave && shortcutKeyLabel(octave)).toBe('Shift+↑');
  });

  it('keeps every piano-roll binding unique and clear of the global ones', () => {
    const pianoRoll = KEYMAP.filter((e) => e.scope === 'pianoRoll').map(shortcutBindingId);
    expect(new Set(pianoRoll).size).toBe(pianoRoll.length);
    const global = new Set(KEYMAP.filter((e) => e.scope === 'global').map(shortcutBindingId));
    for (const id of pianoRoll) expect(global.has(id), id).toBe(false);
  });
});
