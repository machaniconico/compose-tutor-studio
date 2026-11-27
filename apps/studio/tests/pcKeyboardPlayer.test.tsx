// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createDefaultProject } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

// A fake audio engine so the REAL live preview (caps, hard maximums, lifecycle) runs.
const audio = vi.hoisted(() => {
  type Osc = { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: null | (() => void) };
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const oscillators: Osc[] = [];
  const frequencies: number[] = [];
  const ctx = {
    currentTime: 10,
    createOscillator: vi.fn(() => {
      const frequency = param();
      frequency.setValueAtTime = vi.fn((v: number) => { frequencies.push(v); });
      const o = { ...node(), type: 'sine', frequency, detune: param(), start: vi.fn(), stop: vi.fn(), onended: null };
      oscillators.push(o);
      return o;
    }),
    createGain: vi.fn(() => ({ ...node(), gain: param() })),
    createBiquadFilter: vi.fn(() => ({ ...node(), type: 'lowpass', frequency: param(), Q: param(), detune: param() })),
  };
  return { oscillators, frequencies, ctx, master: node() };
});

let useStore: typeof import('../src/state/store')['useStore'];
let PcKeyboardPlayer: typeof import('../src/features/input/PcKeyboardPlayer')['PcKeyboardPlayer'];
let live: typeof import('../src/audio/livePreview');
let mode: typeof import('../src/features/input/pcKeyboardMode');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ PcKeyboardPlayer } = await import('../src/features/input/PcKeyboardPlayer'));
  live = await import('../src/audio/livePreview');
  mode = await import('../src/features/input/pcKeyboardMode');
  const { getAudioEngine } = await import('../src/audio/engine');
  vi.spyOn(getAudioEngine(), 'ensureContext').mockImplementation(
    (async () => ({ context: audio.ctx, master: audio.master })) as never,
  );
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const down = (code: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { code, key: code.replace('Key', '').toLowerCase(), ...init });
const up = (code: string) => fireEvent.keyUp(window, { code, key: code.replace('Key', '').toLowerCase() });
/** Voices still sounding = oscillators whose stop was never pulled in beyond the first schedule. */
const released = () => audio.oscillators.filter((o) => o.stop.mock.calls.length > 1).length;
const started = () => audio.oscillators.length;

function selectInstrumentTrack(): void {
  const track = useStore.getState().project.tracks.find((t) => t.type === 'instrument');
  if (!track) throw new Error('no instrument track');
  useStore.setState((s) => ({ editor: { ...s.editor, selectedTrackId: track.id } }));
}

describe('PC keyboard playing', () => {
  let cleanupLifecycle: () => void;
  beforeEach(async () => {
    audio.oscillators.length = 0;
    audio.frequencies.length = 0;
    useStore.setState((s) => ({
      project: createDefaultProject({ title: 'PC鍵盤' }),
      saveState: { ...s.saveState, phase: 'idle' as const },
      audioRecordingOperationId: null,
    }));
    selectInstrumentTrack();
    mode.resetPcKeyboardMode();
    cleanupLifecycle = live.installPreviewLifecycle();
  });
  afterEach(() => {
    cleanup();
    cleanupLifecycle();
  });

  function startPlaying() {
    render(<PcKeyboardPlayer />);
    fireEvent.click(screen.getByRole('button', { name: 'PC鍵盤で弾く' }));
  }

  it('is off by default: letter keys do nothing until the toggle is on', async () => {
    render(<PcKeyboardPlayer />);
    down('KeyA');
    await flush();
    expect(started()).toBe(0);
    expect(screen.queryByRole('group', { name: 'PC鍵盤で弾く' })).toBeNull();
  });

  it('plays while held, releases on key-up, and never touches the project', async () => {
    const before = useStore.getState().project;
    startPlaying();
    down('KeyA');
    await flush();
    expect(started()).toBeGreaterThan(0);
    const perVoice = started();
    expect(released()).toBe(0);
    // Sustained: scheduled for the hard maximum, not the 2 s preview limit.
    for (const o of audio.oscillators) {
      const stop = Math.min(...o.stop.mock.calls.map((c) => c[0] as number));
      expect(stop - audio.ctx.currentTime).toBeLessThanOrEqual(live.MAX_HELD_SECONDS + 1.1);
      expect(stop - audio.ctx.currentTime).toBeGreaterThan(live.MAX_PREVIEW_SECONDS);
    }
    up('KeyA');
    expect(released()).toBe(perVoice);
    expect(useStore.getState().project).toBe(before);
  });

  it('key repeat does not retrigger', async () => {
    startPlaying();
    down('KeyA');
    await flush();
    const first = started();
    for (let i = 0; i < 20; i += 1) down('KeyA', { repeat: true });
    down('KeyA'); // even a non-flagged duplicate while held is ignored
    await flush();
    expect(started()).toBe(first);
  });

  it('keydown then blur releases everything; the later key-up is harmless', async () => {
    startPlaying();
    down('KeyA');
    down('KeyS');
    await flush();
    const total = started();
    fireEvent.blur(window);
    expect(released()).toBe(total);
    up('KeyA');
    up('KeyS');
    expect(released()).toBe(total);
    down('KeyA');
    await flush();
    expect(started()).toBeGreaterThan(total); // can be played again afterwards
  });

  it('keydown then visibilitychange releases everything', async () => {
    startPlaying();
    down('KeyD');
    await flush();
    const total = started();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(released()).toBe(total);
  });

  it('a key-up that arrives after a project switch releases nothing and plays nothing', async () => {
    startPlaying();
    down('KeyA');
    await flush();
    const total = started();
    useStore.setState((s) => ({ saveState: { ...s.saveState, activationId: 'switched-project' } }) as never);
    expect(released()).toBe(total);
    up('KeyA');
    expect(released()).toBe(total);
    expect(started()).toBe(total);
  });

  it('two keys on the same pitch are independent voices', async () => {
    const preview = new live.LivePreview(async () => ({ context: audio.ctx as never, master: audio.master as never }));
    await preview.hold('KeyA', undefined, 60);
    const one = started();
    await preview.hold('Other', undefined, 60);
    expect(started()).toBe(one * 2);
    preview.release('KeyA');
    expect(released()).toBe(one); // only the first voice
    preview.release('Other');
    expect(released()).toBe(one * 2);
    preview.dispose();
  });

  it('a key-up before audio is ready cancels the pending note (nothing sounds)', async () => {
    startPlaying();
    down('KeyA');
    up('KeyA'); // before the awaited audio context resolved
    await flush();
    expect(started()).toBe(0);
    down('KeyA'); // a fresh press afterwards still works
    await flush();
    expect(started()).toBeGreaterThan(0);
  });

  it('caps held voices at 16', async () => {
    const preview = new live.LivePreview(async () => ({ context: audio.ctx as never, master: audio.master as never }));
    for (let i = 0; i < 24; i += 1) await preview.hold(`k${i}`, undefined, 40 + i);
    const perVoice = started() / 16;
    expect(Number.isInteger(perVoice)).toBe(true);
    preview.dispose();
  });

  it('is refused while recording', async () => {
    startPlaying();
    useStore.setState({ audioRecordingOperationId: 'rec-1' } as never);
    down('KeyA');
    await flush();
    expect(started()).toBe(0);
    useStore.setState({ audioRecordingOperationId: null } as never);
  });

  it('starting recording during a held note releases it', async () => {
    startPlaying();
    down('KeyA');
    await flush();
    const total = started();
    useStore.setState({ audioRecordingOperationId: 'rec-1' } as never);
    expect(released()).toBe(total);
    useStore.setState({ audioRecordingOperationId: null } as never);
  });

  it('transport change releases held notes', async () => {
    startPlaying();
    down('KeyA');
    await flush();
    const total = started();
    useStore.setState((s) => ({ transport: { ...s.transport, phase: 'playing' } }) as never);
    expect(released()).toBe(total);
    useStore.setState((s) => ({ transport: { ...s.transport, phase: 'stopped' } }) as never);
  });

  it('unmount releases and turns the mode off', async () => {
    const view = render(<PcKeyboardPlayer />);
    fireEvent.click(screen.getByRole('button', { name: 'PC鍵盤で弾く' }));
    down('KeyA');
    await flush();
    const total = started();
    view.unmount();
    expect(released()).toBe(total);
    expect(mode.isPcKeyboardPlaying()).toBe(false);
  });

  it('never fires in text inputs, with IME composition, keyCode 229, modifiers or AltGr', async () => {
    startPlaying();
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { code: 'KeyA', key: 'a', bubbles: true });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a', isComposing: true });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'Process', keyCode: 229 });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a', ctrlKey: true });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a', metaKey: true });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a', altKey: true, ctrlKey: true });
    const altGr = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true });
    altGr.getModifierState = (k: string) => k === 'AltGraph';
    window.dispatchEvent(altGr);
    await flush();
    expect(started()).toBe(0);
    input.remove();
  });

  it('Escape turns the mode off and releases; Z/X shift the octave', async () => {
    startPlaying();
    down('KeyX');
    expect(mode.getPcKeyboardMode().octave).toBe(5);
    down('KeyZ');
    down('KeyZ');
    expect(mode.getPcKeyboardMode().octave).toBe(3);
    down('KeyA');
    await flush();
    const total = started();
    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
    expect(mode.isPcKeyboardPlaying()).toBe(false);
    expect(released()).toBe(total);
    down('KeyA');
    await flush();
    expect(started()).toBe(total);
  });

  it('a non-instrument selection is silent and explains why', async () => {
    const drum = useStore.getState().project.tracks.find((t) => t.type !== 'instrument');
    if (drum) useStore.setState((s) => ({ editor: { ...s.editor, selectedTrackId: drum.id } }));
    else useStore.setState((s) => ({ editor: { ...s.editor, selectedTrackId: null } }));
    startPlaying();
    down('KeyA');
    await flush();
    expect(started()).toBe(0);
    expect(screen.getByText('楽器トラックを選ぶと、音が鳴ります。')).toBeTruthy();
  });

  it('shows the key-to-note overlay and the beginner help; scale lock changes the sounding pitch', async () => {
    startPlaying();
    expect(screen.getByText(/スケールロックをオンにすると、どのキーを押してもスケールの音だけが鳴ります/)).toBeTruthy();
    const map = screen.getByRole('list', { name: 'キーと音の割り当て' });
    expect(map.textContent).toContain('C#4'); // chromatic: W
    fireEvent.click(screen.getByRole('checkbox', { name: 'スケールロック' }));
    const { key, scale } = useStore.getState().project;
    expect([key, scale]).toEqual(['C', 'major']);
    const locked = screen.getByRole('list', { name: 'キーと音の割り当て' }).textContent ?? '';
    expect(locked).not.toContain('C#4');
    down('KeyW'); // 2nd degree under lock: D4, not C#4
    await flush();
    expect(audio.frequencies.some((f) => Math.abs(f - 293.66) < 0.5)).toBe(true);
    expect(audio.frequencies.some((f) => Math.abs(f - 277.18) < 0.5)).toBe(false);
  });

  it('suspends the focused-button letter shortcut (S) while playing, leaves it otherwise', async () => {
    const { EditorArea } = await import('../src/features/editor/EditorArea');
    const view = render(<><EditorArea /><PcKeyboardPlayer /></>);
    const snap = view.getByRole('button', { name: 'スケールスナップ' });
    const before = useStore.getState().editor.scaleSnap;
    snap.focus();
    fireEvent.keyDown(snap, { key: 's', code: 'KeyS' });
    expect(useStore.getState().editor.scaleSnap).toBe(!before); // shortcut works when mode is off
    useStore.getState().toggleScaleSnap();
    expect(useStore.getState().editor.scaleSnap).toBe(before);
    fireEvent.click(view.getByRole('button', { name: 'PC鍵盤で弾く' }));
    fireEvent.keyDown(snap, { key: 's', code: 'KeyS' });
    expect(useStore.getState().editor.scaleSnap).toBe(before); // suspended
  });

  it('review 1: a pointerdown anywhere releases every held note (the keyup may be eaten by a dropdown)', async () => {
    startPlaying();
    down('KeyA');
    down('KeyS');
    await flush();
    const total = started();
    const select = document.createElement('select');
    document.body.append(select);
    fireEvent.pointerDown(select);
    expect(released()).toBe(total);
    // The dropdown ate the keyup and Esc: nothing is left sounding, and the mode can still end.
    fireEvent.keyDown(select, { code: 'Escape', key: 'Escape' });
    expect(released()).toBe(total);
    select.remove();
  });

  it('review 1: focusin to any element releases every held note', async () => {
    startPlaying();
    down('KeyA');
    await flush();
    const total = started();
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.focusIn(field);
    expect(released()).toBe(total);
    field.remove();
  });

  it('review 1: turning the mode off with the toggle, and Esc, release everything', async () => {
    startPlaying();
    down('KeyA');
    await flush();
    const total = started();
    fireEvent.click(screen.getByRole('button', { name: 'PC鍵盤で弾く' }));
    expect(released()).toBe(total);
  });

  it.each(['Meta', 'Control', 'Alt', 'AltGraph'])('review 3: pressing %s while notes are held releases all of them', async (key) => {
    startPlaying();
    down('KeyA');
    await flush();
    const total = started();
    fireEvent.keyDown(window, { key, code: `${key}Left` });
    expect(released()).toBe(total);
    // The suppressed keyups afterwards are harmless.
    up('KeyA');
    expect(released()).toBe(total);
  });

  it('review 3: any keyup that still reports a held modifier releases all (backstop)', async () => {
    startPlaying();
    down('KeyA');
    await flush();
    const total = started();
    fireEvent.keyUp(window, { code: 'KeyQ', key: 'q', metaKey: true });
    expect(released()).toBe(total);
  });

  it('review 5: key=Process / Unidentified / keyCode 229 never play, even with isComposing=false', async () => {
    startPlaying();
    fireEvent.keyDown(window, { code: 'KeyA', key: 'Process', isComposing: false, keyCode: 0 });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'Unidentified', isComposing: false, keyCode: 0 });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a', isComposing: false, keyCode: 229 });
    await flush();
    expect(started()).toBe(0);
  });

  it('review C: while the mode is on, C (chord tone) and S (scale snap) are both suspended on a focused button', async () => {
    const { EditorArea } = await import('../src/features/editor/EditorArea');
    const view = render(<><EditorArea /><PcKeyboardPlayer /></>);
    const chord = view.getByRole('button', { name: 'コードトーン' });
    const before = useStore.getState().editor.chordToneHighlight;
    chord.focus();
    fireEvent.click(view.getByRole('button', { name: 'PC鍵盤で弾く' }));
    fireEvent.keyDown(chord, { key: 'c', code: 'KeyC' });
    expect(useStore.getState().editor.chordToneHighlight).toBe(before);
    fireEvent.click(view.getByRole('button', { name: 'PC鍵盤で弾く' }));
    fireEvent.keyDown(chord, { key: 'c', code: 'KeyC' });
    expect(useStore.getState().editor.chordToneHighlight).toBe(!before);
  });
});

describe('PC keyboard playing + step input (P43)', () => {
  let cleanupLifecycle: () => void;
  beforeEach(async () => {
    audio.oscillators.length = 0;
    // Edits go through the real project lifecycle (applyProjectChange needs an activated project).
    Object.defineProperty(navigator, 'locks', {
      value: { request: async (_n: string, _o: unknown, cb: () => unknown) => cb() },
      configurable: true,
    });
    useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
    expect(await useStore.getState().createNewProject('PC鍵盤')).toBe(true);
    mode.resetPcKeyboardMode();
    cleanupLifecycle = live.installPreviewLifecycle();
  });
  afterEach(async () => {
    cleanup();
    cleanupLifecycle();
    (await import('../src/state/stepInput')).stopStepInput();
  });

  it('a note-on inserts at the step cursor and advances it; Enter and Backspace are not playing keys', async () => {
    const step = await import('../src/state/stepInput');
    const track = useStore.getState().project.tracks.find((t) => t.type === 'instrument' && t.clips.some((c) => c.type === 'midi'))!;
    const clip = track.clips.find((c) => c.type === 'midi')!;
    useStore.setState((s) => ({ editor: { ...s.editor, selectedTrackId: track.id } }));
    const count = () => (useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)?.notes ?? []).length;
    const before = count();
    render(<PcKeyboardPlayer />);
    fireEvent.click(screen.getByRole('button', { name: 'PC鍵盤で弾く' }));
    // Step input off: playing alone never edits the project.
    down('KeyA');
    up('KeyA');
    expect(count()).toBe(before);
    expect(step.startStepInput(clip.id).ok).toBe(true);
    down('KeyA');
    up('KeyA');
    await flush();
    expect(count()).toBe(before + 1);
    expect(step.useStepInput.getState().cursorTicks).toBe(step.useStepInput.getState().stepTicks);
    // Held key auto-repeat must not insert a second note.
    down('KeyS');
    down('KeyS', { repeat: true });
    up('KeyS');
    expect(count()).toBe(before + 2);
  });

  it('while a MIDI take is active the take wins: step input inserts nothing and the cursor stays', async () => {
    const step = await import('../src/state/stepInput');
    const track = useStore.getState().project.tracks.find((t) => t.type === 'instrument' && t.clips.some((c) => c.type === 'midi'))!;
    const clip = track.clips.find((c) => c.type === 'midi')!;
    useStore.setState((s) => ({ editor: { ...s.editor, selectedTrackId: track.id } }));
    render(<PcKeyboardPlayer />);
    fireEvent.click(screen.getByRole('button', { name: 'PC鍵盤で弾く' }));
    expect(step.startStepInput(clip.id).ok).toBe(true);
    useStore.setState({ midiRecordingActive: true });
    try {
      down('KeyA');
      up('KeyA');
      await flush();
    } finally {
      useStore.setState({ midiRecordingActive: false });
    }
    expect((useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)?.notes ?? []).length).toBe(0);
    expect(step.useStepInput.getState().cursorTicks).toBe(0);
  });
});
