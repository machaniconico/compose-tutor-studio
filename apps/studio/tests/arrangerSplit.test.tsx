// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Arranger } from '../src/features/arranger/Arranger';
import { useStore } from '../src/state/store';

it('announces a refused split, focuses the new clip on success and clears the notice on Undo', () => {
  const state = useStore.getState();
  const { project } = state;
  const track = project.tracks.find((candidate) => candidate.name === 'Melody')!;
  const clip = track.clips[0]!;
  state.selectTrack(track.id);
  state.selectClip(clip.id);
  render(<Arranger />);

  const position = screen.getByRole('spinbutton', { name: '分割位置（小節）' });
  const split = screen.getByRole('button', { name: '分割' });
  fireEvent.change(position, { target: { value: '0.001' } });
  fireEvent.click(split);
  expect(screen.getByRole('alert').textContent).toContain('1拍は480目盛り');
  expect(useStore.getState().project).toBe(project);
  expect(useStore.getState().past).toBe(state.past);

  fireEvent.change(position, { target: { value: '0.5' } });
  fireEvent.click(split);
  expect(screen.getByRole('status').textContent).toBe('クリップを分割しました。');
  const right = screen.getByRole('button', { name: /Melody、クリップ2/ });
  expect(document.activeElement).toBe(right);
  expect(right.getAttribute('aria-pressed')).toBe('true');
  expect(useStore.getState().past).toHaveLength(state.past.length + 1);

  act(() => useStore.getState().undo());
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('button', { name: /Melody、クリップ2/ })).toBeNull();
  act(() => useStore.getState().redo());
  expect(screen.getByRole('button', { name: /Melody、クリップ2/ })).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});
