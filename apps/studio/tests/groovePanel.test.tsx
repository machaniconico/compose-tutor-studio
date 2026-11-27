// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let GroovePanel: typeof import('../src/features/inspector/GroovePanel')['GroovePanel'];
let NoteGroovePopover: typeof import('../src/features/pianoRoll/NoteGroovePopover')['NoteGroovePopover'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ GroovePanel } = await import('../src/features/inspector/GroovePanel'));
  ({ NoteGroovePopover } = await import('../src/features/pianoRoll/NoteGroovePopover'));
  expect(await useStore.getState().createNewProject('テスト')).toBe(true);
});

afterEach(cleanup);

describe('GroovePanel', () => {
  it('edits swing and choke, with beginner help text', () => {
    render(<GroovePanel />);
    expect(screen.getByText(/裏の16分音符が少し後ろにずれて/)).toBeTruthy();
    const slider = screen.getByLabelText('スウィング') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '40' } });
    expect(useStore.getState().project.swing).toBe(40);
    expect(screen.getByText(/1ティック/)).toBeTruthy();
    const choke = screen.getByRole('checkbox') as HTMLInputElement;
    const initial = choke.checked;
    fireEvent.click(choke);
    expect(useStore.getState().project.hiHatChoke).toBe(!initial);
  });

  it('one pointer drag is one undo step', () => {
    render(<GroovePanel />);
    const slider = screen.getByLabelText('スウィング');
    const before = useStore.getState().past.length;
    fireEvent.pointerDown(slider, { pointerId: 1 });
    for (const v of ['11', '21', '31']) fireEvent.change(slider, { target: { value: v } });
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(useStore.getState().project.swing).toBe(31);
    expect(useStore.getState().past.length).toBe(before + 1);
  });

  it('keeps the drag local: the project is untouched until release, which commits once', () => {
    render(<GroovePanel />);
    const slider = screen.getByLabelText('スウィング') as HTMLInputElement;
    const start = useStore.getState().project.swing;
    const target = start === 50 ? 40 : 50;
    const before = useStore.getState().past.length;
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: String(target) } });
    expect(slider.value).toBe(String(target));
    expect(useStore.getState().project.swing).toBe(start);
    expect(useStore.getState().committedProject().swing).toBe(start);
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(useStore.getState().project.swing).toBe(target);
    expect(useStore.getState().past.length).toBe(before + 1);
  });

  it.each([
    ['Escape', (slider: HTMLElement) => fireEvent.keyDown(slider, { key: 'Escape' })],
    ['blur', (slider: HTMLElement) => fireEvent.blur(slider)],
    ['visibilitychange', () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }],
    ['unmount', (_slider: HTMLElement, unmount: () => void) => unmount()],
  ])('cancels the drag on %s without writing anything', (_name, cancel) => {
    const { unmount } = render(<GroovePanel />);
    const slider = screen.getByLabelText('スウィング') as HTMLInputElement;
    const start = useStore.getState().project.swing;
    const before = useStore.getState().past.length;
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: start === 55 ? '45' : '55' } });
    cancel(slider, unmount);
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(useStore.getState().project.swing).toBe(start);
    expect(useStore.getState().committedProject().swing).toBe(start);
    expect(useStore.getState().past.length).toBe(before);
    if (_name !== 'unmount') expect(slider.value).toBe(String(start));
  });

  it('keyboard steps commit one by one', () => {
    render(<GroovePanel />);
    const slider = screen.getByLabelText('スウィング');
    const before = useStore.getState().past.length;
    const start = useStore.getState().project.swing;
    fireEvent.change(slider, { target: { value: String(start === 20 ? 21 : 20) } });
    expect(useStore.getState().past.length).toBe(before + 1);
  });

  it('is disabled while recording', () => {
    useStore.setState({ audioRecordingOperationId: 1 });
    try {
      render(<GroovePanel />);
      expect((screen.getByLabelText('スウィング') as HTMLInputElement).disabled).toBe(true);
    } finally {
      useStore.setState({ audioRecordingOperationId: null });
    }
  });
});

describe('NoteGroovePopover', () => {
  it('disables the actions without a selection and reports refusals', () => {
    const messages: string[] = [];
    render(<NoteGroovePopover clipId="missing" noteIds={[]} gridSnap={1} onAnnounce={(m) => messages.push(m)} />);
    fireEvent.click(screen.getByText('ゆらぎ…'));
    expect((screen.getByText('選択ノートをヒューマナイズ') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<NoteGroovePopover clipId="missing" noteIds={['x']} gridSnap={1} onAnnounce={(m) => messages.push(m)} />);
    fireEvent.click(screen.getByText('ゆらぎ…'));
    fireEvent.click(screen.getByText('選択ノートを強さつきで寄せる'));
    expect(messages.at(-1)).toMatch(/MIDI クリップ/);
  });
});
