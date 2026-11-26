// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createDefaultProject } from '../src/state/defaultProject';
import { useStore } from '../src/state/store';
import { MixerStrip } from '../src/features/mixer/MixerStrip';
import { TrackList } from '../src/features/tracklist/TrackList';
import { TransportBar } from '../src/features/transport/TransportBar';
import { Arranger } from '../src/features/arranger/Arranger';
import { ChordLane } from '../src/features/chordTrack/ChordLane';
import { PianoRoll } from '../src/features/pianoRoll/PianoRoll';
import { addSection } from '@cts/project-model';
import { KEYMAP } from '../src/state/keymap';

vi.mock('../src/audio/playback', () => ({ initAudioBridge: () => () => undefined }));

function firstTrack() {
  const track = useStore.getState().project.tracks.find((t) => t.type !== 'master');
  if (!track) throw new Error('default project has no track');
  return track;
}

function dragSlider(slider: HTMLElement, values: number[]): void {
  fireEvent.pointerDown(slider);
  for (const value of values) fireEvent.change(slider, { target: { value: String(value) } });
  fireEvent.pointerUp(slider);
}

function expectOneStepUndo(read: () => unknown, before: unknown): void {
  expect(useStore.getState().past).toHaveLength(1);
  useStore.getState().undo();
  expect(read()).toBe(before);
}

beforeEach(() => {
  useStore.getState().replaceProject(createDefaultProject('元の題名'));
  useStore.getState().setStartScreenOpen(false);
});

describe('slider undo steps', () => {
  it('MixerStrip volume drag is one undo step', () => {
    const track = firstTrack();
    render(<MixerStrip />);
    const slider = screen.getByLabelText(`${track.name} 音量`);

    dragSlider(slider, [0.2, 0.3, 0.4, 0.5]);

    expect(firstTrack().volume).toBe(0.5);
    expectOneStepUndo(() => firstTrack().volume, track.volume);
  });

  it('TrackList volume drag is one undo step', () => {
    const track = firstTrack();
    render(<TrackList />);
    const slider = screen.getByLabelText(`${track.name} 音量`);

    dragSlider(slider, [0.2, 0.3, 0.4, 0.5]);

    expect(firstTrack().volume).toBe(0.5);
    expectOneStepUndo(() => firstTrack().volume, track.volume);
  });

  it('MixerStrip pan drag is one undo step', () => {
    const track = firstTrack();
    render(<MixerStrip />);

    dragSlider(screen.getByLabelText(`${track.name} パン`), [0.1, 0.2, 0.3]);

    expectOneStepUndo(() => firstTrack().pan, track.pan);
  });

  it('MixerStrip effect slider drag is one undo step', () => {
    const track = firstTrack();
    render(<MixerStrip />);
    fireEvent.click(screen.getByLabelText(`${track.name} リバーブ`));
    const enabled = firstTrack().effects;
    useStore.setState({ past: [] });

    dragSlider(screen.getByLabelText(`${track.name} リバーブ mix`), [0.1, 0.2, 0.3]);

    expectOneStepUndo(() => firstTrack().effects, enabled);
  });

  it('keyboard steps end at keyup', () => {
    const track = firstTrack();
    render(<MixerStrip />);
    const slider = screen.getByLabelText(`${track.name} 音量`);

    fireEvent.change(slider, { target: { value: '0.2' } });
    fireEvent.change(slider, { target: { value: '0.3' } });
    expect(useStore.getState().past).toHaveLength(0);
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(useStore.getState().past).toHaveLength(1);

    fireEvent.change(slider, { target: { value: '0.4' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(useStore.getState().past).toHaveLength(2);
  });

  it('releasing Shift during a drag does not split the undo step', () => {
    const track = firstTrack();
    render(<MixerStrip />);
    const slider = screen.getByLabelText(`${track.name} 音量`);

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.2' } });
    fireEvent.keyUp(slider, { key: 'Shift' });
    fireEvent.change(slider, { target: { value: '0.3' } });
    fireEvent.pointerUp(window);

    expectOneStepUndo(() => firstTrack().volume, track.volume);
  });

  it('pointercancel restores the value from before the drag', () => {
    const track = firstTrack();
    render(<TrackList />);
    const slider = screen.getByLabelText(`${track.name} 音量`);

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.2' } });
    fireEvent.pointerCancel(slider);

    expect(firstTrack().volume).toBe(track.volume);
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().transactionBase).toBeNull();
  });

  it('window blur cancels a drag in progress', () => {
    const track = firstTrack();
    render(
      <>
        <TransportBar />
        <MixerStrip />
      </>,
    );
    const slider = screen.getByLabelText(`${track.name} 音量`);

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.2' } });
    fireEvent.blur(window);

    expect(firstTrack().volume).toBe(track.volume);
    expect(useStore.getState().transactionBase).toBeNull();
  });

  it('a stale pointerup after a cancelled drag leaves the next edit open', () => {
    const track = firstTrack();
    render(
      <>
        <TransportBar />
        <MixerStrip />
      </>,
    );
    const slider = screen.getByLabelText(`${track.name} 音量`);
    const bpmInput = screen.getByLabelText('BPM');
    const beforeBpm = useStore.getState().project.bpm;

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.2' } });
    fireEvent.blur(window);
    fireEvent.change(bpmInput, { target: { value: '140' } });
    fireEvent.pointerUp(window);
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().transactionBase).not.toBeNull();

    fireEvent.change(bpmInput, { target: { value: '150' } });
    fireEvent.blur(bpmInput);

    expect(useStore.getState().project.bpm).toBe(150);
    expectOneStepUndo(() => useStore.getState().project.bpm, beforeBpm);
  });

  it('a stale pointerup after Undo leaves the next edit open', () => {
    const track = firstTrack();
    render(
      <>
        <TransportBar />
        <MixerStrip />
      </>,
    );
    const slider = screen.getByLabelText(`${track.name} 音量`);
    const bpmInput = screen.getByLabelText('BPM');

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.2' } });
    useStore.getState().undo();
    fireEvent.change(bpmInput, { target: { value: '140' } });
    fireEvent.pointerUp(window);

    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().transactionBase).not.toBeNull();
  });

  it('changes after Undo do not revive the drag', () => {
    const track = firstTrack();
    render(<TrackList />);
    const slider = screen.getByLabelText(`${track.name} 音量`);

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.2' } });
    useStore.getState().undo();
    fireEvent.change(slider, { target: { value: '0.3' } });
    fireEvent.pointerUp(window);

    expect(firstTrack().volume).toBe(track.volume);
    expect((slider as HTMLInputElement).value).toBe(String(track.volume));
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().transactionBase).toBeNull();

    dragSlider(slider, [0.4]);
    expect(firstTrack().volume).toBe(0.4);
    expectOneStepUndo(() => firstTrack().volume, track.volume);
  });

  it('the keyboard works again after a drag ended by Undo', () => {
    const track = firstTrack();
    render(<TrackList />);
    const slider = screen.getByLabelText(`${track.name} 音量`);

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.2' } });
    useStore.getState().undo();
    fireEvent.pointerUp(window);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.change(slider, { target: { value: '0.3' } });
    fireEvent.keyUp(slider, { key: 'ArrowLeft' });

    expect(firstTrack().volume).toBe(0.3);
    expectOneStepUndo(() => firstTrack().volume, track.volume);
  });

  it('removes its window listeners as soon as the drag is cancelled', () => {
    const track = firstTrack();
    render(<MixerStrip />);
    const slider = screen.getByLabelText(`${track.name} 音量`);
    const remove = vi.spyOn(window, 'removeEventListener');

    fireEvent.pointerDown(slider);
    useStore.getState().cancelTransaction();

    const removed = remove.mock.calls.map(([type]) => type);
    remove.mockRestore();
    expect(removed).toEqual(expect.arrayContaining(['pointerup', 'pointercancel']));
  });

  it('a different pointer does not end the drag', () => {
    const track = firstTrack();
    render(<MixerStrip />);
    const slider = screen.getByLabelText(`${track.name} 音量`);

    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: '0.2' } });
    fireEvent.pointerUp(window, { pointerId: 2 });
    fireEvent.pointerCancel(window, { pointerId: 2 });
    expect(useStore.getState().past).toHaveLength(0);
    fireEvent.change(slider, { target: { value: '0.3' } });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(firstTrack().volume).toBe(0.3);
    expectOneStepUndo(() => firstTrack().volume, track.volume);
  });

  it('a drag survives the blur of the input edited just before it', () => {
    const track = firstTrack();
    render(
      <>
        <TransportBar />
        <MixerStrip />
      </>,
    );
    const slider = screen.getByLabelText(`${track.name} 音量`);
    const bpmInput = screen.getByLabelText('BPM');

    fireEvent.change(bpmInput, { target: { value: '140' } });
    fireEvent.pointerDown(slider);
    fireEvent.blur(bpmInput);
    fireEvent.change(slider, { target: { value: '0.2' } });
    fireEvent.change(slider, { target: { value: '0.3' } });
    expect(useStore.getState().past).toHaveLength(1);
    fireEvent.pointerUp(window);

    expect(useStore.getState().past).toHaveLength(2);
    expect(useStore.getState().transactionBase).toBeNull();
  });

  it('finishes the step when the slider unmounts during a drag', () => {
    const track = firstTrack();
    const { unmount } = render(<MixerStrip />);
    const slider = screen.getByLabelText(`${track.name} 音量`);

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '0.2' } });
    unmount();
    fireEvent.pointerUp(window);

    expect(useStore.getState().transactionBase).toBeNull();
    expectOneStepUndo(() => firstTrack().volume, track.volume);
  });
});

describe('text input undo steps', () => {
  const bpm = () => useStore.getState().project.bpm;
  const title = () => useStore.getState().project.title;

  it('BPM changes end in one step on blur', () => {
    const before = bpm();
    render(<TransportBar />);
    const input = screen.getByLabelText('BPM');
    for (const value of ['1', '14', '140']) fireEvent.change(input, { target: { value } });
    expect(useStore.getState().past).toHaveLength(0);
    fireEvent.blur(input);

    expect(bpm()).toBe(140);
    expectOneStepUndo(bpm, before);
  });

  it('BPM changes end in one step on Enter', () => {
    const before = bpm();
    render(<TransportBar />);
    const input = screen.getByLabelText('BPM');
    for (const value of ['1', '14', '140']) fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expectOneStepUndo(bpm, before);
  });

  it('title changes end in one step on blur', () => {
    render(<TransportBar />);
    const input = screen.getByLabelText('プロジェクト名');
    for (const value of ['新', '新し', '新しい']) fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);

    expect(title()).toBe('新しい');
    expectOneStepUndo(title, '元の題名');
  });

  it('title changes end in one step on Enter', () => {
    render(<TransportBar />);
    const input = screen.getByLabelText('プロジェクト名');
    for (const value of ['新', '新し', '新しい']) fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expectOneStepUndo(title, '元の題名');
  });

  it('Enter that confirms Japanese conversion does not end the step', () => {
    render(<TransportBar />);
    const input = screen.getByLabelText('プロジェクト名');

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'あたらしい' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: '新しい' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(useStore.getState().past).toHaveLength(0);
    fireEvent.change(input, { target: { value: '新しい曲' } });
    fireEvent.blur(input);

    expectOneStepUndo(title, '元の題名');
  });

  it('Arranger section name edits are one step', () => {
    useStore.getState().applyProjectChange((project) =>
      addSection(project, { name: 'はじめ', type: 'verse', startBar: 0, lengthBars: 2 }),
    );
    useStore.setState({ past: [] });
    const sectionName = () => useStore.getState().project.sections.at(-1)?.name;
    render(<Arranger />);
    fireEvent.click(screen.getAllByTitle(/はじめ/)[0] as HTMLElement);
    // The click also loops the section (its own undo step); count only the name edits.
    useStore.setState({ past: [] });
    const input = screen.getByLabelText('セクション名');

    for (const value of ['は', 'はし', 'はしり']) fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);

    expectOneStepUndo(sectionName, 'はじめ');
  });
});

describe('drag undo steps', () => {
  function setupNote() {
    const track = firstTrack();
    const clip = track.clips[0];
    if (!clip) throw new Error('default track has no clip');
    useStore.getState().addNote(clip.id, {
      id: 'drag-note',
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 100,
    });
    useStore.setState({ past: [] });
    useStore.getState().selectClip(clip.id);
    useStore.getState().setActiveView('pianoRoll');
    const read = () =>
      useStore
        .getState()
        .project.tracks.flatMap((t) => t.clips)
        .find((c) => c.id === clip.id)
        ?.notes?.find((n) => n.id === 'drag-note')?.startBeat;
    return { read };
  }

  function noteElement(): HTMLElement {
    const element = document.querySelector('.pr__note');
    if (!(element instanceof HTMLElement)) throw new Error('note not rendered');
    return element;
  }

  it('moving a note across many pointermoves is one step', () => {
    const { read } = setupNote();
    render(<PianoRoll />);
    const note = noteElement();

    fireEvent.pointerDown(note, { clientX: 5, clientY: 0, button: 0 });
    for (const clientX of [100, 200, 300, 400]) fireEvent.pointerMove(note, { clientX, clientY: 0 });
    fireEvent.pointerUp(note);

    expect(read()).not.toBe(0);
    expectOneStepUndo(read, 0);
  });

  it('pointercancel during a note drag restores the note', () => {
    const { read } = setupNote();
    render(<PianoRoll />);
    const note = noteElement();

    fireEvent.pointerDown(note, { clientX: 5, clientY: 0, button: 0 });
    fireEvent.pointerMove(note, { clientX: 300, clientY: 0 });
    fireEvent.pointerCancel(note);

    expect(read()).toBe(0);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('undo during a note drag ends the drag', () => {
    const { read } = setupNote();
    render(<PianoRoll />);
    const note = noteElement();

    fireEvent.pointerDown(note, { clientX: 5, clientY: 0, button: 0 });
    fireEvent.pointerMove(note, { clientX: 300, clientY: 0 });
    useStore.getState().undo();
    fireEvent.pointerMove(note, { clientX: 400, clientY: 0 });
    fireEvent.pointerUp(note);

    expect(read()).toBe(0);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('a stale pointerup after a cancelled note drag leaves the next edit open', () => {
    const { read } = setupNote();
    render(
      <>
        <TransportBar />
        <PianoRoll />
      </>,
    );
    const note = noteElement();
    const bpmInput = screen.getByLabelText('BPM');

    fireEvent.pointerDown(note, { clientX: 5, clientY: 0, button: 0 });
    fireEvent.pointerMove(note, { clientX: 300, clientY: 0 });
    fireEvent.blur(window);
    fireEvent.change(bpmInput, { target: { value: '140' } });
    fireEvent.pointerMove(note, { clientX: 400, clientY: 0 });
    fireEvent.pointerUp(note);

    expect(read()).toBe(0);
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().transactionBase).not.toBeNull();
  });

  it('a note drag survives the blur of the input edited just before it', () => {
    const { read } = setupNote();
    render(
      <>
        <TransportBar />
        <PianoRoll />
      </>,
    );
    const note = noteElement();
    const bpmInput = screen.getByLabelText('BPM');

    fireEvent.change(bpmInput, { target: { value: '140' } });
    fireEvent.pointerDown(note, { clientX: 5, clientY: 0, button: 0 });
    fireEvent.blur(bpmInput);
    for (const clientX of [200, 300]) fireEvent.pointerMove(note, { clientX, clientY: 0 });
    fireEvent.pointerUp(note);

    expect(read()).not.toBe(0);
    expect(useStore.getState().past).toHaveLength(2);
  });

  it('a stale pointerup after a cancelled chord drag leaves the next edit open', () => {
    useStore.getState().addChord('C', 0, 4);
    useStore.setState({ past: [] });
    const { container } = render(
      <>
        <TransportBar />
        <ChordLane />
      </>,
    );
    const chip = container.querySelector('.chord-chip');
    if (!(chip instanceof HTMLElement)) throw new Error('chord not rendered');

    fireEvent.pointerDown(chip, { clientX: 0 });
    fireEvent.blur(window);
    fireEvent.change(screen.getByLabelText('BPM'), { target: { value: '140' } });
    fireEvent.pointerUp(chip);

    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().transactionBase).not.toBeNull();
  });

  it('deleting the dragged note ends the drag, so the next edit is its own step', () => {
    const { read } = setupNote();
    render(
      <>
        <TransportBar />
        <PianoRoll />
      </>,
    );
    const note = noteElement();
    const bpmInput = screen.getByLabelText('BPM');
    const bpm = useStore.getState().project.bpm;

    fireEvent.pointerDown(note, { clientX: 5, clientY: 0, button: 0 });
    fireEvent.pointerMove(note, { clientX: 300, clientY: 0 });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(read()).toBeUndefined();
    expect(useStore.getState().transactionBase).toBeNull();
    expect(useStore.getState().past).toHaveLength(1);

    fireEvent.pointerUp(window);
    fireEvent.change(bpmInput, { target: { value: '140' } });
    fireEvent.blur(bpmInput);
    expect(useStore.getState().past).toHaveLength(2);

    useStore.getState().undo();
    expect(useStore.getState().project.bpm).toBe(bpm);
    expect(read()).toBeUndefined();
    useStore.getState().undo();
    expect(read()).toBe(0);
  });

  it('deleting the copies of an Alt drag leaves no empty undo step', () => {
    setupNote();
    render(<PianoRoll />);

    fireEvent.pointerDown(noteElement(), { clientX: 5, clientY: 0, button: 0, altKey: true });
    fireEvent.pointerMove(noteElement(), { clientX: 300, clientY: 0 });
    fireEvent.keyDown(window, { key: 'Delete' });

    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().transactionBase).toBeNull();
  });

  it('a note drag released away from the grid still ends its step', () => {
    const { read } = setupNote();
    render(<PianoRoll />);
    const note = noteElement();

    fireEvent.pointerDown(note, { clientX: 5, clientY: 0, button: 0 });
    fireEvent.pointerMove(note, { clientX: 300, clientY: 0 });
    fireEvent.pointerUp(window);

    expect(useStore.getState().transactionBase).toBeNull();
    expectOneStepUndo(read, 0);
  });

  it('a note drag ends its step when the piano roll unmounts', () => {
    const { read } = setupNote();
    const { unmount } = render(<PianoRoll />);
    const note = noteElement();

    fireEvent.pointerDown(note, { clientX: 5, clientY: 0, button: 0 });
    fireEvent.pointerMove(note, { clientX: 300, clientY: 0 });
    unmount();
    fireEvent.pointerUp(window);

    expect(useStore.getState().transactionBase).toBeNull();
    expectOneStepUndo(read, 0);
  });

  it('a chord drag ends its step when the chord lane unmounts', () => {
    useStore.getState().addChord('C', 0, 4);
    useStore.setState({ past: [] });
    const read = () => useStore.getState().project.chordTrack[0]?.startBeat;
    const { container, unmount } = render(<ChordLane />);
    const chip = container.querySelector('.chord-chip');
    if (!(chip instanceof HTMLElement)) throw new Error('chord not rendered');

    fireEvent.pointerDown(chip, { clientX: 0 });
    fireEvent.pointerMove(chip, { clientX: 1200 });
    unmount();
    fireEvent.pointerUp(window);

    expect(useStore.getState().transactionBase).toBeNull();
    expectOneStepUndo(read, 0);
  });

  it('moving a chord across many pointermoves is one step', () => {
    useStore.getState().addChord('C', 0, 4);
    useStore.setState({ past: [] });
    const read = () => useStore.getState().project.chordTrack[0]?.startBeat;
    const { container } = render(<ChordLane />);
    const chip = container.querySelector('.chord-chip');
    if (!(chip instanceof HTMLElement)) throw new Error('chord not rendered');

    fireEvent.pointerDown(chip, { clientX: 0 });
    for (const clientX of [400, 800, 1200]) fireEvent.pointerMove(chip, { clientX });
    fireEvent.pointerUp(chip);

    expect(read()).not.toBe(0);
    expectOneStepUndo(read, 0);
  });
});

describe('chord lane conversion', () => {
  it('explains why conversion is disabled until a chord overlaps the target clip', () => {
    const project = createDefaultProject();
    const clip = project.tracks.find((track) => track.role === 'chords')?.clips[0];
    if (!clip) throw new Error('default project has no chord clip');
    clip.startBeat = 4;
    project.chordTrack = [];
    useStore.getState().replaceProject(project);
    useStore.getState().addChord('C', 0, 4);
    render(<ChordLane />);

    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'コードをノートにする' });
    expect(button.disabled).toBe(true);
    const hint = screen.getByText('書き込み先のクリップに重なるコードがありません。');
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);

    act(() => useStore.getState().addChord('G', 4, 4));
    expect(button.disabled).toBe(false);
    expect(screen.queryByText('書き込み先のクリップに重なるコードがありません。')).toBeNull();
  });
});

describe('shortcut help dialog', () => {
  it('opens with ? and lists every keymap entry', () => {
    render(<TransportBar />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(window, { key: '?', shiftKey: true });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('row')).toHaveLength(KEYMAP.length);
    for (const entry of KEYMAP) {
      expect(within(dialog).getAllByText(entry.labelJa).length).toBeGreaterThan(0);
    }
  });

  it('opens from the help button and closes with Escape', () => {
    render(<TransportBar />);
    fireEvent.click(screen.getByRole('button', { name: 'キーボード操作の一覧を見る' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not open on top of another dialog or while typing', () => {
    render(<TransportBar />);
    const before = useStore.getState().transport.isPlaying;
    fireEvent.keyDown(screen.getByLabelText('プロジェクト名'), { key: '?', shiftKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(window, { key: '?', shiftKey: true });
    fireEvent.keyDown(window, { key: ' ' });
    expect(useStore.getState().transport.isPlaying).toBe(before);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});

describe('delay time slider', () => {
  const delayTimeOf = (trackId: string) =>
    useStore
      .getState()
      .project.tracks.find((t) => t.id === trackId)
      ?.effects?.find((e) => e.type === 'delay')?.params?.timeSeconds;

  it('keeps the legacy 1.5 s maximum', () => {
    const track = firstTrack();
    render(<MixerStrip />);
    const slider = screen.getByLabelText(`${track.name} ディレイ time`);

    expect(slider.getAttribute('max')).toBe('1.5');
  });

  it('stores the tempo-synced time, clamped to the maximum at slow tempos', () => {
    const track = firstTrack();
    useStore.getState().setBpm(120);
    render(<MixerStrip />);
    fireEvent.click(screen.getByLabelText(`${track.name} ディレイ`));
    const select = screen.getByLabelText(`${track.name} ディレイを曲のテンポに合わせる`);

    fireEvent.change(select, { target: { value: '1/4' } });
    expect(delayTimeOf(track.id)).toBe(0.5);

    act(() => useStore.getState().setBpm(20));
    fireEvent.change(select, { target: { value: '1/4' } });
    expect(delayTimeOf(track.id)).toBe(1.5);
  });
});

describe('master fader', () => {
  it('double-click resets the master volume to 1', () => {
    const master = useStore.getState().project.tracks.find((t) => t.type === 'master');
    if (!master) throw new Error('default project has no master track');
    render(<MixerStrip />);
    const slider = screen.getByLabelText(`${master.name} 音量`);

    fireEvent.change(slider, { target: { value: '0.4' } });
    expect(useStore.getState().project.tracks.find((t) => t.type === 'master')?.volume).toBe(0.4);

    fireEvent.doubleClick(slider);
    expect(useStore.getState().project.tracks.find((t) => t.type === 'master')?.volume).toBe(1);
  });
});
