// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { KEYMAP, matchShortcut, type ShortcutEventLike } from '../src/features/common/keymap';
import { PLAYING_CODES } from '../src/features/input/keyboardMap';
import { buildPlayingLayout } from '../src/features/input/pcKeyboardLayout';

const chromatic = (octave = 4) => buildPlayingLayout({ octave, scaleLock: false, key: 'C', scale: 'major' });

describe('buildPlayingLayout', () => {
  it('chromatic: keys map to consecutive semitones (with the L gap), A = C of the octave', () => {
    const layout = chromatic(4);
    expect(layout.map((k) => k.keyLabel).join('')).toBe('AWSEDFTGYHUJKL');
    expect(layout[0]).toMatchObject({ pitch: 60, noteName: 'C4' });
    expect(layout.at(-1)?.pitch).toBe(74);
  });

  it('scale lock: consecutive scale degrees of the project key, not semitones', () => {
    const layout = buildPlayingLayout({ octave: 4, scaleLock: true, key: 'C', scale: 'major' });
    expect(layout.map((k) => k.pitch)).toEqual([60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83]);
    expect(layout.slice(0, 7).map((k) => k.noteName)).toEqual(['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4']);
  });

  it('scale lock follows the key: A natural minor starts on A and only uses its tones', () => {
    const layout = buildPlayingLayout({ octave: 4, scaleLock: true, key: 'A', scale: 'naturalMinor' });
    expect(layout[0]).toMatchObject({ pitch: 69, noteName: 'A4' });
    const allowed = new Set([9, 11, 0, 2, 4, 5, 7]);
    for (const k of layout) if (k.pitch !== null) expect(allowed.has(k.pitch % 12)).toBe(true);
  });

  it('scale lock wraps pentatonic scales by degree (5 tones -> octave every 5 keys)', () => {
    const layout = buildPlayingLayout({ octave: 4, scaleLock: true, key: 'C', scale: 'majorPentatonic' });
    expect(layout.slice(0, 6).map((k) => k.pitch)).toEqual([60, 62, 64, 67, 69, 72]);
  });

  it('review 4: the label octave follows the spelled note (Cb is next octave, B# previous), for every key/scale/octave', () => {
    const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const keys = ['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
    const scales = ['major', 'naturalMinor', 'harmonicMinor', 'melodicMinor', 'majorPentatonic', 'minorPentatonic', 'blues'] as const;
    for (const key of keys) for (const scale of scales) for (const octave of [0, 3, 4, 7]) {
      for (const k of buildPlayingLayout({ octave, scaleLock: true, key, scale })) {
        if (k.pitch === null) continue;
        const m = /^([A-G])(x|#|b|bb)?(-?\d+)$/.exec(k.noteName);
        expect(m, k.noteName).not.toBeNull();
        const shift = { '': 0, '#': 1, x: 2, b: -1, bb: -2 }[m![2] ?? ''] as number;
        expect((Number(m![3]) + 1) * 12 + (LETTER[m![1] as string] as number) + shift, `${key} ${scale} ${octave} ${k.noteName}`).toBe(k.pitch);
      }
    }
    const eb = buildPlayingLayout({ octave: 4, scaleLock: true, key: 'Eb', scale: 'naturalMinor' });
    expect(eb.find((k) => k.keyLabel === 'F')).toMatchObject({ pitch: 71, noteName: 'Cb5' });
  });

  it('a spelled name uses the project spelling (F major has Bb)', () => {
    const layout = buildPlayingLayout({ octave: 4, scaleLock: true, key: 'F', scale: 'major' });
    expect(layout[3]?.noteName).toBe('Bb4');
  });

  it('keys past MIDI 127 are silent, never wrapped', () => {
    for (const scaleLock of [false, true]) {
      const layout = buildPlayingLayout({ octave: 9, scaleLock, key: 'B', scale: 'major' });
      for (const k of layout) {
        if (k.pitch === null) expect(k.noteName).toBe('—');
        else expect(k.pitch).toBeLessThanOrEqual(127);
      }
      if (scaleLock) expect(layout.some((k) => k.pitch === null)).toBe(true);
    }
  });

  it('seeded fuzz: every pitch is an integer 0-127 in scale when locked; never throws', () => {
    let seed = 20261128;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const keys = ['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
    const scales = ['major', 'naturalMinor', 'harmonicMinor', 'melodicMinor', 'majorPentatonic', 'minorPentatonic', 'blues'] as const;
    for (let i = 0; i < 400; i += 1) {
      const key = keys[Math.floor(rand() * keys.length)] as (typeof keys)[number];
      const scale = scales[Math.floor(rand() * scales.length)] as (typeof scales)[number];
      const octave = [-5, -1, 0, 3, 4, 8, 9, 99, NaN, 2.7][Math.floor(rand() * 10)] as number;
      const scaleLock = rand() < 0.5;
      const layout = buildPlayingLayout({ octave, scaleLock, key, scale } as never);
      expect(layout).toHaveLength(PLAYING_CODES.length);
      for (const k of layout) {
        if (k.pitch === null) continue;
        expect(Number.isInteger(k.pitch) && k.pitch >= 0 && k.pitch <= 127).toBe(true);
      }
    }
  });

  it('tolerates hostile project values without throwing', () => {
    const layout = buildPlayingLayout({
      octave: 4,
      scaleLock: true,
      key: { toString: null } as never,
      scale: { toString: null } as never,
    });
    expect(layout).toHaveLength(PLAYING_CODES.length);
  });
});

describe("keymap 'playing' scope", () => {
  const ev = (over: Partial<ShortcutEventLike>): ShortcutEventLike => ({
    key: 'a', code: 'KeyA', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over,
  });

  it('plain letters play, matched by physical key even on another layout', () => {
    expect(matchShortcut(ev({}), 'playing')).toBe('playNote');
    expect(matchShortcut(ev({ key: 'ち', code: 'KeyA' }), 'playing')).toBe('playNote');
    expect(matchShortcut(ev({ key: 'z', code: 'KeyZ' }), 'playing')).toBe('octaveDown');
    expect(matchShortcut(ev({ key: 'x', code: 'KeyX' }), 'playing')).toBe('octaveUp');
    expect(matchShortcut(ev({ key: 'Escape', code: 'Escape' }), 'playing')).toBe('exitPlayingMode');
  });

  it('refuses modifiers, AltGr (Ctrl+Alt), IME composition and keyCode 229', () => {
    expect(matchShortcut(ev({ ctrlKey: true }), 'playing', false)).toBeNull();
    expect(matchShortcut(ev({ metaKey: true }), 'playing', true)).toBeNull();
    expect(matchShortcut(ev({ shiftKey: true }), 'playing')).toBeNull();
    expect(matchShortcut(ev({ altKey: true, ctrlKey: true }), 'playing')).toBeNull();
    expect(matchShortcut(ev({ isComposing: true }), 'playing')).toBeNull();
    expect(matchShortcut(ev({ keyCode: 229 }), 'playing')).toBeNull();
  });

  it('review 5: Process / Unidentified / keyCode 229 count as IME in every scope', () => {
    for (const scope of ['playing', 'global', 'pianoRoll', 'control', 'gesture'] as const) {
      expect(matchShortcut(ev({ key: 'Process', code: 'KeyS', ctrlKey: true, isComposing: false, keyCode: 0 }), scope, false), scope).toBeNull();
      expect(matchShortcut(ev({ key: 'Unidentified', code: 'KeyS', ctrlKey: true }), scope, false), scope).toBeNull();
    }
    expect(matchShortcut(ev({ key: 'Process' }), 'playing')).toBeNull();
    expect(matchShortcut(ev({ key: 'Unidentified' }), 'playing')).toBeNull();
  });

  it('refuses text fields and selects but not a focused checkbox', () => {
    const host = document.createElement('div');
    host.innerHTML = '<input id="t" type="text"><textarea id="a"></textarea><select id="s"></select><input id="c" type="checkbox"><div id="e" contenteditable="true"></div>';
    document.body.append(host);
    const target = (id: string) => host.querySelector(`#${id}`) as Element;
    for (const id of ['t', 'a', 's', 'e']) expect(matchShortcut(ev({ target: target(id) }), 'playing'), id).toBeNull();
    expect(matchShortcut(ev({ target: target('c') }), 'playing')).toBe('playNote');
    host.remove();
  });

  it('is a separate scope: existing bindings and other scopes are unchanged', () => {
    expect(matchShortcut(ev({ key: 'a', code: 'KeyA' }), 'global')).toBeNull();
    expect(matchShortcut(ev({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'global', false)).toBe('undo');
    expect(KEYMAP.filter((e) => e.scope !== 'playing')).toHaveLength(13);
  });
});
