// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { createDefaultProject } from '../src/state/defaultProject';
import { useStore } from '../src/state/store';
import { TrackList } from '../src/features/tracklist/TrackList';

vi.mock('../src/audio/playback', () => ({ initAudioBridge: () => () => undefined }));

const names = () => useStore.getState().project.tracks.map((t) => t.name);

beforeEach(() => {
  useStore.getState().replaceProject(createDefaultProject('トラック管理'));
  useStore.getState().setStartScreenOpen(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TrackList track management', () => {
  it('asks in Japanese before deleting a track that has clips', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(createElement(TrackList));

    fireEvent.click(screen.getByRole('button', { name: 'Bass を削除' }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toBe(
      '「Bass」には 1 個のクリップ(音を入れる枠)があります。トラックごと削除しますか？(「元に戻す」で取り消せます)',
    );
    // Declined: nothing is removed.
    expect(names()).toEqual(['Chords', 'Bass', 'Melody', 'Drums', 'Master']);
  });

  it('deletes the track once the user agrees, as one undo step', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(createElement(TrackList));

    fireEvent.click(screen.getByRole('button', { name: 'Bass を削除' }));

    expect(names()).toEqual(['Chords', 'Melody', 'Drums', 'Master']);
    expect(screen.queryByText('Bass')).toBeNull();
    useStore.getState().undo();
    expect(names()).toEqual(['Chords', 'Bass', 'Melody', 'Drums', 'Master']);
  });

  it('deletes a track without clips without asking', () => {
    const confirm = vi.spyOn(window, 'confirm');
    const project = useStore.getState().project;
    useStore.getState().replaceProject({
      ...project,
      tracks: project.tracks.map((t) => (t.name === 'Bass' ? { ...t, clips: [] } : t)),
    });
    render(createElement(TrackList));

    fireEvent.click(screen.getByRole('button', { name: 'Bass を削除' }));

    expect(confirm).not.toHaveBeenCalled();
    expect(names()).toEqual(['Chords', 'Melody', 'Drums', 'Master']);
  });

  it('adds, duplicates, moves and renames tracks from the buttons', () => {
    render(createElement(TrackList));

    fireEvent.click(screen.getByRole('button', { name: '楽器トラックを追加' }));
    fireEvent.click(screen.getByRole('button', { name: 'ドラムトラックを追加' }));
    expect(names()).toEqual(['Chords', 'Bass', 'Melody', 'Drums', '楽器 4', 'ドラム 2', 'Master']);

    fireEvent.click(screen.getByRole('button', { name: 'Melody を複製' }));
    expect(names()[3]).toBe('Melody のコピー');

    fireEvent.click(screen.getByRole('button', { name: 'Bass を上へ' }));
    expect(names().slice(0, 2)).toEqual(['Bass', 'Chords']);
    expect((screen.getByRole('button', { name: 'Bass を上へ' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Chords の名前の変更' }));
    const input = screen.getByRole('textbox', { name: 'Chords の新しい名前' });
    fireEvent.change(input, { target: { value: 'コード' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(names()[1]).toBe('コード');

    // Renaming was one undo step.
    useStore.getState().undo();
    expect(names()[1]).toBe('Chords');
  });

  it('offers no delete, move or duplicate for the master track', () => {
    render(createElement(TrackList));
    expect(screen.queryByRole('button', { name: 'Master を削除' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Master を複製' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Master を上へ' })).toBeNull();
  });

  it('sets and clears the role from the select', () => {
    render(createElement(TrackList));
    const select = screen.getByRole('combobox', { name: 'Bass の役割' });
    fireEvent.change(select, { target: { value: 'melody' } });
    expect(useStore.getState().project.tracks[1]?.role).toBe('melody');
    fireEvent.change(select, { target: { value: '' } });
    expect(useStore.getState().project.tracks[1]?.role).toBeUndefined();
  });

  it('offers only the roles that suit the track type', () => {
    render(createElement(TrackList));
    const values = (name: string) =>
      Array.from(
        (screen.getByRole('combobox', { name }) as HTMLSelectElement).options,
        (o) => o.value,
      );
    expect(values('Drums の役割')).toEqual(['', 'drums']);
    expect(values('Bass の役割')).toEqual(['', 'chords', 'bass', 'melody']);
  });
});
