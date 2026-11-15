// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let DrumGrid: typeof import('../src/features/drums/DrumGrid')['DrumGrid'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ DrumGrid } = await import('../src/features/drums/DrumGrid'));
});

beforeEach(() => {
  act(() => {
    useStore.getState().createNewProject('テスト');
  });
});

function drumEvents() {
  return useStore.getState().project.tracks.find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [];
}

describe('DrumGrid with a clip that ends part-way through a bar', () => {
  beforeEach(() => {
    // 33 beats of 4/4: the 9th bar holds one beat (4 steps) of the clip.
    act(() => {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((t) =>
          t.type === 'drum' ? { ...t, clips: t.clips.map((c) => ({ ...c, lengthBeats: 33 })) } : t,
        ),
      }));
    });
  });

  it('shows the partial bar and lets only its steps inside the clip be edited', () => {
    render(<DrumGrid />);
    const bars = within(screen.getByRole('group', { name: '小節切替' })).getAllByRole('button');
    expect(bars.map((b) => b.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);

    fireEvent.click(bars[8]!);
    const inside = screen.getByLabelText('キック ステップ 4') as HTMLButtonElement;
    const outside = screen.getByLabelText('キック ステップ 5(クリップの外)') as HTMLButtonElement;
    expect(inside.disabled).toBe(false);
    expect(outside.disabled).toBe(true);
    expect(screen.getAllByLabelText(/\(クリップの外\)$/).length).toBe(6 * 12);

    fireEvent.click(inside);
    expect(drumEvents().map((e) => [e.lane, e.stepIndex])).toEqual([['kick', 131]]);

    fireEvent.click(outside);
    expect(drumEvents().length).toBe(1);
  });

  it('shows no partial bar for a clip that ends on a bar line', () => {
    act(() => {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((t) =>
          t.type === 'drum' ? { ...t, clips: t.clips.map((c) => ({ ...c, lengthBeats: 32 })) } : t,
        ),
      }));
    });
    render(<DrumGrid />);
    const bars = within(screen.getByRole('group', { name: '小節切替' })).getAllByRole('button');
    expect(bars.length).toBe(8);
    expect(screen.queryAllByLabelText(/\(クリップの外\)$/).length).toBe(0);
  });
});
