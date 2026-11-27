// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { soundingEvents, validateProject, type TrackRole } from '@cts/project-model';
import * as theory from '@cts/theory-engine';
import { AssistantPanel } from '../src/features/assistant/AssistantPanel';
import { createDefaultProject } from '../src/state/defaultProject';
import { writeAccompaniment } from '../src/state/editorActions';
import { useStore } from '../src/state/store';

const options = { seed: 15, mood: 'bouncy', complexity: 0.5, intensity: 0.5 } as const;
const roles = ['chords', 'bass', 'drums'] as const;
const current = () => useStore.getState().project;
const past = () => useStore.getState().past.length;
const clipOf = (role: TrackRole) => current().tracks.find((track) => track.role === role)!.clips[0]!;

beforeEach(() => {
  useStore.getState().replaceProject(createDefaultProject());
});

afterEach(() => vi.restoreAllMocks());

describe('writeAccompaniment', () => {
  it('targets the three roles after renaming, asks once, regenerates, and undoes each write in one step', () => {
    const project = createDefaultProject();
    project.tracks.forEach((track, i) => { track.name = `Track ${i}`; });
    const chords = project.tracks.find((track) => track.role === 'chords')!;
    chords.clips[0]!.notes = [{ id: 'old', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }];
    useStore.getState().replaceProject(project);
    const before = current();
    const previous = past();
    const cancel = vi.fn(() => false);
    expect(writeAccompaniment(options, cancel).ok).toBe(false);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(chords.name));
    expect(current()).toBe(before);
    expect(past()).toBe(previous);

    const confirm = vi.fn(() => true);
    expect(writeAccompaniment(options, confirm)).toEqual({ ok: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(past()).toBe(previous + 1);
    const first = current();
    expect(validateProject(first).valid).toBe(true);
    for (const role of roles) {
      const clip = clipOf(role);
      const played = soundingEvents(first, { clipId: clip.id }).events;
      expect(played.length).toBeGreaterThan(0);
      expect(played.map((event) => event.velocity)).toEqual((clip.notes ?? clip.drumEvents)!.map((note) => note.velocity));
    }
    const velocity = () => roles.map((role) => soundingEvents(current(), { clipId: clipOf(role).id }).events.map((event) => event.velocity));
    const firstVelocity = velocity();
    expect(writeAccompaniment({ ...options, seed: options.seed + 1 }, confirm).ok).toBe(true);
    expect(past()).toBe(previous + 2);
    expect(velocity()).not.toEqual(firstVelocity);
    useStore.getState().undo();
    expect(current()).toBe(first);
    useStore.getState().undo();
    expect(current()).toBe(before);
  });

  it('detaches linked and looping clips on acceptance and preserves their source clips', () => {
    const project = createDefaultProject();
    const melody = project.tracks.find((track) => track.role === 'melody')!.clips[0]!;
    melody.notes = [{ id: 'source', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }];
    const bass = project.tracks.find((track) => track.role === 'bass')!.clips[0]!;
    bass.aliasOf = melody.id;
    bass.loop = true;
    bass.contentLengthBeats = 4;
    useStore.getState().replaceProject(project);
    const originalSource = clipOf('melody');
    const confirm = vi.fn(() => true);
    expect(writeAccompaniment(options, confirm).ok).toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/リンク.*繰り返し/));
    expect(clipOf('bass').aliasOf).toBeUndefined();
    expect(clipOf('bass').loop).toBe(false);
    expect(clipOf('bass').notes!.some((note) => note.startBeat >= 4)).toBe(true);
    expect(clipOf('melody')).toBe(originalSource);
  });

  it('clips all three parts at the song end before expanding long chords', () => {
    const project = createDefaultProject();
    for (const track of project.tracks.filter((track) => roles.some((role) => role === track.role))) {
      Object.assign(track.clips[0]!, { startBeat: 28, lengthBeats: 12 });
    }
    project.chordTrack = [{ ...project.chordTrack[0]!, startBeat: 29.5, durationBeats: 2e6 }];
    useStore.getState().replaceProject(project);
    expect(writeAccompaniment({ ...options, complexity: 1 }).ok).toBe(true);
    for (const role of roles) {
      const { events } = soundingEvents(current(), { clipId: clipOf(role).id });
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.startBeat >= 29.5 && event.startBeat < 32 &&
        event.startBeat + (event.durationBeats ?? 1 / 480) <= 32 + 1e-9)).toBe(true);
    }
  });

  it('refuses a 2-million-beat clip even if the song is short, before invoking generation', () => {
    const project = createDefaultProject();
    project.tracks.find((track) => track.role === 'bass')!.clips[0]!.lengthBeats = 2e6;
    useStore.getState().replaceProject(project);
    const before = current();
    const confirm = vi.fn(() => true);
    const generate = vi.spyOn(theory, 'generateAccompaniment');
    expect(writeAccompaniment(options, confirm)).toEqual({ ok: false, reason: expect.stringContaining('クリップの終わりが上限') });
    expect(generate).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(current()).toBe(before);
    expect(past()).toBe(0);
  });

  it('refuses the entire write when a generated hit would shift or drop in playback', () => {
    const project = createDefaultProject();
    project.swing = 60;
    useStore.getState().replaceProject(project);
    const before = current();
    const confirm = vi.fn(() => true);
    expect(writeAccompaniment(options, confirm)).toEqual({ ok: false, reason: expect.stringContaining('位置や長さで鳴りません') });
    expect(confirm).not.toHaveBeenCalled();
    expect(current()).toBe(before);
    expect(past()).toBe(0);
  });

  it('explains missing roles without creating any tracks or undo entry', () => {
    const project = createDefaultProject();
    delete project.tracks.find((track) => track.role === 'bass')!.role;
    useStore.getState().replaceProject(project);
    const before = current();
    expect(writeAccompaniment(options)).toEqual({ ok: false, reason: expect.stringContaining('「ベース」の役割') });
    expect(current()).toBe(before);
    expect(past()).toBe(0);
  });

  it('creates whole-song clips on existing empty role tracks', () => {
    const project = createDefaultProject();
    project.tracks.filter((track) => roles.some((role) => role === track.role)).forEach((track) => { track.clips = []; });
    useStore.getState().replaceProject(project);
    expect(writeAccompaniment(options).ok).toBe(true);
    expect(current().tracks).toHaveLength(project.tracks.length);
    for (const role of roles) expect(clipOf(role)).toMatchObject({ startBeat: 0, lengthBeats: 32 });
    expect(past()).toBe(1);
  });

  it('does not write a stale arrangement after a change inside confirmation', () => {
    expect(writeAccompaniment(options).ok).toBe(true);
    const first = current().tracks;
    expect(writeAccompaniment({ ...options, seed: 16 }, () => {
      useStore.getState().setTitle('確認中に変更した曲');
      return true;
    })).toEqual({ ok: false, reason: expect.stringContaining('確認中に曲が変更') });
    expect(current().title).toBe('確認中に変更した曲');
    expect(current().tracks).toBe(first);
    expect(past()).toBe(2);
  });
});

describe('AssistantPanel accompaniment', () => {
  it('shows four fixed moods, generates and regenerates, and simplifies the part explanations', () => {
    useStore.getState().setDifficulty('beginner');
    const { container } = render(createElement(AssistantPanel));
    expect(screen.getByText('伴奏をおまかせ')).toBeTruthy();
    expect(container.querySelector('input, textarea')).toBeNull();
    const mood = screen.getByRole('combobox', { name: '雰囲気' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'やわらかい', 'はずむ', 'まっすぐ', 'かけぬける',
    ]);
    fireEvent.change(mood, { target: { value: 'soft' } });
    fireEvent.click(screen.getByRole('button', { name: '伴奏を作る' }));
    expect(screen.getByRole('status').textContent).toContain('伴奏を作りました');
    expect(screen.getByText(/くり返すリズム/)).toBeTruthy();
    expect(screen.getByText(/コードの土台になる音/)).toBeTruthy();
    expect(screen.getByText(/となり合うコード/)).toBeTruthy();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '伴奏を作り直す' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(past()).toBe(2);
  });
});
