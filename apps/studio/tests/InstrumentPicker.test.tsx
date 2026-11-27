// @vitest-environment jsdom
import { createDefaultProject } from '@cts/project-model';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TrackList } from '../src/features/tracklist/TrackList';
import { useStore } from '../src/state/store';

vi.mock('../src/audio/livePreview', () => ({ previewChord: vi.fn(), previewNote: vi.fn() }));

it.each(['preset', 'macro'] as const)('shows the fallback sound and saves the first %s edit', (control) => {
  const project = createDefaultProject();
  const track = project.tracks.find((candidate) => candidate.type === 'instrument')!;
  const drum = project.tracks.find((candidate) => candidate.type === 'drum')!;
  expect(track.instrument).toBeUndefined();
  useStore.getState().replaceProject(project);
  const instrument = () => useStore.getState().project.tracks.find((candidate) => candidate.id === track.id)?.instrument;

  render(<TrackList />);
  const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: `${track.name} の音色` });
  expect(picker.value).toBe('warmPad');
  expect(screen.queryByRole('combobox', { name: `${drum.name} の音色` })).toBeNull();
  expect(instrument()).toBeUndefined();

  if (control === 'preset') {
    fireEvent.change(picker, { target: { value: 'bell' } });
    expect(instrument()).toEqual({ type: 'synth', preset: 'bell' });
  } else {
    fireEvent.click(screen.getByText('かんたん調整'));
    const brightness = screen.getByRole<HTMLInputElement>('slider', { name: `${track.name} の明るさ` });
    expect(brightness.value).toBe('0.5');
    fireEvent.change(brightness, { target: { value: '0.75' } });
    expect(instrument()).toEqual({
      type: 'synth', preset: 'warmPad', macros: { brightness: 0.75, release: 0.5, width: 0, attack: 0.5 },
    });
  }
  act(() => useStore.getState().undo());
  expect(instrument()).toBeUndefined();
  expect(picker.value).toBe('warmPad');
});
