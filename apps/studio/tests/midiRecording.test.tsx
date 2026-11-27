// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveClip } from '@cts/project-model';
import { MAX_RECORDING_EVENTS, recordingPhase } from '../src/audio/recorder';
import { captureLiveNote } from '../src/audio/playback';
import { subscribeAppEvents } from '../src/state/appEvents';
import { importMidiTracks } from '../src/state/editorActions';
import { createDefaultProject } from '../src/state/defaultProject';
import { loadProject, saveProject } from '../src/state/persistence';
import { getBridgeSnapshot, lessonStatus, startLesson, stopLesson } from '../src/state/tutorialBridge';
import { LiveInputPanel } from '../src/features/input/LiveInputPanel';
import { TransportBar } from '../src/features/transport/TransportBar';
import { useStore } from '../src/state/store';
import { MockMidiAccess, MockMidiInput } from './mockWebMidi';

const audio = vi.hoisted(() => ({
  time: 0,
  sound: new Set<number>(),
  click: vi.fn(),
  cancel: vi.fn(),
  playSongNote: vi.fn(),
  instruments: [] as (string | undefined)[], // preset names heard by the live monitor
}));
vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    now: () => audio.time,
    ensureContext: async () => ({ context: { currentTime: audio.time }, master: {} }),
  }),
}));
vi.mock('../src/audio/livePreview', () => ({
  noteOn: async (pitch: number, instrument?: { preset: string }) => {
    audio.sound.add(pitch);
    audio.instruments.push(instrument?.preset);
  },
  noteOff: (pitch: number) => audio.sound.delete(pitch),
  allNotesOff: () => audio.sound.clear(),
}));
vi.mock('../src/audio/graph', () => ({
  buildTrackGraphs: (_context: unknown, _master: unknown, tracks: readonly { id: string }[]) =>
    new Map(tracks.map((track) => [track.id, { input: {}, dispose() {} }])),
  applyMixState: vi.fn(),
}));
vi.mock('../src/audio/masterChain', () => ({ applyMasterVolume: vi.fn() }));
vi.mock('../src/audio/synth', () => ({
  SynthVoiceManager: class {
    noteOn = audio.playSongNote;
    latestReleaseEndTime = 0;
    releaseAll() {}
  },
}));
vi.mock('../src/audio/metronome', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/metronome')>()),
  scheduleMetronomeClick: audio.click,
}));

const LOOP_DOMAIN_MESSAGE = 'ループしながら録音するには、ループを 1 拍以上の長さにして、始まりと終わりを目盛りにそろえてください。';
const EDIT_BLOCKED_MESSAGE = '録音中は曲を編集できません。録音を止めてから操作してください。';

function keyEvent(type: 'keydown' | 'keyup', code: string, timing = { timeStamp: performance.now() } as { timeStamp: number | undefined }) {
  const event = new KeyboardEvent(type, { code, key: code.slice(-1).toLowerCase(), cancelable: true });
  Object.defineProperty(event, 'timeStamp', { value: timing.timeStamp });
  return fireEvent(window, event);
}
const keyDown = (code: string) => keyEvent('keydown', code);
const keyUp = (code: string) => keyEvent('keyup', code);
const stopButton = () => screen.getByRole('button', { name: '■ 録音を止める' });

function tickAt(time: number) {
  audio.time = time;
  act(() => vi.advanceTimersByTime(33));
}

async function begin() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '● 録音' })));
}

function destinationNotes() {
  return useStore.getState().project.tracks[0]!.clips[0]!.notes!;
}

beforeEach(() => {
  audio.time = 0;
  audio.sound.clear();
  audio.instruments = [];
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(performance, 'now').mockImplementation(() => 50_000 + audio.time * 1000);
  audio.click.mockReturnValue(audio.cancel);

  const store = useStore.getState();
  store.createNewProject('録音');
  const project = useStore.getState().project;
  const track = project.tracks[0]!;
  store.loadProjectForPreview({
    ...project, lengthBars: 1, tracks: [{
      ...track, clips: [{
        ...track.clips[0]!, startBeat: 0, lengthBeats: 4,
        notes: [{ id: 'song-note', pitch: 55, startBeat: 0, durationBeats: 0.25, velocity: 100 }],
      }],
    }],
  });
  store.setStartScreenOpen(false);
});

afterEach(async () => {
  await act(async () => cleanup());
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MIDI recording from the transport and live inputs', () => {
  it.each([false, true])('refuses an overlapping new clip before count-in (loop: %s)', async (loop) => {
    const store = useStore.getState();
    store.applyProjectChange((project) => ({
      ...project, tracks: project.tracks.map((track, index) => index === 0 ? {
        ...track, clips: track.clips.map((clip) => ({ ...clip, startBeat: 2, lengthBeats: 2 })),
      } : track),
    }));
    store.selectClip(null);
    if (loop) store.loopRangeOn({ startBeat: 0, endBeat: 4 });
    else store.setPosition(2.5);
    render(<TransportBar />);
    await begin();
    expect(recordingPhase()).toBe('idle');
    expect(useStore.getState().transport.isPlaying).toBe(false);
    expect(audio.click).not.toHaveBeenCalled();
    expect(getBridgeSnapshot().toasts.some((toast) => toast.message.includes('ほかのクリップと重なる'))).toBe(true);
  });

  it('plays a count-in before the song and records the sounded PC and MIDI pitches', async () => {
    const access = new MockMidiAccess();
    const input = new MockMidiInput('keys');
    access.connect(input);
    vi.stubGlobal('navigator', { requestMIDIAccess: access.request });
    render(<><TransportBar /><LiveInputPanel /></>);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'MIDI 鍵盤を使う' })));
    await begin();
    fireEvent.click(screen.getByRole('button', { name: 'スケールロック' }));
    expect(recordingPhase()).toBe('count-in');
    for (const time of [0.4, 0.9, 1.4]) tickAt(time);
    expect(audio.click.mock.calls.map((call) => call.slice(2))).toEqual([
      [0, true], [0.5, false], [1, false], [1.5, false],
    ]);
    tickAt(1.6);
    keyDown('KeyW');
    expect(audio.sound).toEqual(new Set([60]));
    expect(audio.playSongNote).not.toHaveBeenCalled();

    tickAt(2.125);
    expect(recordingPhase()).toBe('recording');
    keyUp('KeyW');
    expect(destinationNotes()).toHaveLength(1);
    expect(audio.playSongNote).toHaveBeenCalledWith(55, 2, 0.125, 100, { cutAtEnd: undefined });
    keyDown('KeyW');
    tickAt(2.25);
    keyUp('KeyW');
    input.send([0x90, 63, 92], { timeStamp: performance.now() });
    tickAt(2.5);
    input.send([0x80, 63, 0], { timeStamp: performance.now() });
    await act(async () => fireEvent.click(stopButton()));

    expect(destinationNotes().slice(1)).toEqual([
      expect.objectContaining({ pitch: 60, startBeat: 0.25, durationBeats: 0.25, velocity: 100 }),
      expect.objectContaining({ pitch: 62, startBeat: 0.5, durationBeats: 0.5, velocity: 92 }),
    ]);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it.each(['stop button', 'blur', 'unmount', 'song end'])('closes held notes and releases live voices on %s', async (ending) => {
    const panel = render(<><TransportBar /><LiveInputPanel /></>);
    await begin();
    tickAt(3.75);
    keyDown('KeyS');
    expect(audio.sound).toEqual(new Set([62]));

    if (ending === 'song end') {
      tickAt(4.03);
      await act(async () => {});
    } else {
      tickAt(3.875);
      await act(async () => {
        if (ending === 'blur') fireEvent.blur(window);
        else if (ending === 'unmount') panel.unmount();
        else fireEvent.click(stopButton());
      });
    }
    expect(useStore.getState().transport.isPlaying).toBe(false);
    expect(recordingPhase()).toBe('idle');
    expect(audio.sound.size).toBe(0);
    expect(destinationNotes().slice(1)).toEqual([
      expect.objectContaining({ pitch: 62, startBeat: 3.5, durationBeats: ending === 'song end' ? 0.5 : 0.25 }),
    ]);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('cancels future count-in clicks and keeps the old notes when stopped before playing', async () => {
    render(<><TransportBar /><LiveInputPanel /></>);
    fireEvent.change(screen.getByRole('combobox', { name: '録り方' }), { target: { value: 'replace' } });
    await begin();
    tickAt(0.45);
    await act(async () => fireEvent.click(stopButton()));
    expect(audio.cancel).toHaveBeenCalledTimes(1);
    expect(destinationNotes().map((note) => note.id)).toEqual(['song-note']);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('stops at the input limit, saves the take and shows a Japanese message', async () => {
    render(<><TransportBar /><LiveInputPanel /></>);
    await begin();
    tickAt(2.25);
    keyDown('KeyA');
    tickAt(2.5);
    await act(async () => {
      for (let i = 1; i < MAX_RECORDING_EVENTS; i++) captureLiveNote(60, true);
    });
    expect(recordingPhase()).toBe('idle');
    expect(audio.sound.size).toBe(0);
    expect(destinationNotes().slice(1)).toEqual([
      expect.objectContaining({ pitch: 60, startBeat: 0.5, durationBeats: 0.5 }),
    ]);
    expect(getBridgeSnapshot().toasts.some((toast) => toast.message.includes('録音できる入力の上限'))).toBe(true);
  });

  it.each([
    { startBeat: 0, endBeat: 1.001 }, { startBeat: 0, endBeat: 0.375 }, { startBeat: 0.0001, endBeat: 2 },
  ])('refuses to loop-record over %j before count-in with a beginner-friendly reason', async (loop) => {
    render(<TransportBar />);
    act(() => useStore.getState().loopRangeOn(loop));
    const before = useStore.getState().project;
    await begin();
    expect(recordingPhase()).toBe('idle');
    expect(audio.click).not.toHaveBeenCalled();
    expect(useStore.getState().project).toBe(before);
    expect(getBridgeSnapshot().toasts.some((toast) => toast.message === LOOP_DOMAIN_MESSAGE)).toBe(true);
  });

  it('refuses an off-tick destination clip before count-in', async () => {
    const store = useStore.getState();
    const track = store.project.tracks[0]!;
    store.applyProjectChange((project) => ({
      ...project, tracks: [{ ...track, clips: [{ ...track.clips[0]!, startBeat: 0.002 }] }],
    }));
    store.loopRangeOn({ startBeat: 1, endBeat: 3 });
    store.setPosition(1.03);
    render(<TransportBar />);
    fireEvent.change(screen.getByRole('combobox', { name: '音の位置を自動でそろえる' }), { target: { value: '0.5' } });
    await begin();
    expect(recordingPhase()).toBe('idle');
    expect(useStore.getState().transport.isPlaying).toBe(false);
    expect(audio.click).not.toHaveBeenCalled();
    expect(getBridgeSnapshot().toasts.at(-1)?.message).toMatch(/クリップの始まり.*目盛り/);
  });

  it('completes the recording lesson using just the PC keyboard', async () => {
    vi.stubGlobal('navigator', {});
    render(<><TransportBar /><LiveInputPanel /></>);
    startLesson('daw-record');
    try {
      fireEvent.click(screen.getByRole('button', { name: 'PC で演奏' }));
      await begin();
      tickAt(2.25);
      keyDown('KeyA');
      tickAt(2.5);
      keyUp('KeyA');
      await act(async () => fireEvent.click(stopButton()));
      expect(destinationNotes().at(-1)).toMatchObject({ pitch: 60, startBeat: 0.5 });
      expect(lessonStatus('daw-record')).toBe('completed');
    } finally {
      stopLesson();
    }
  });

  it.each(['PC', 'MIDI'])('records %s event times even when delivery is late', async (source) => {
    const access = new MockMidiAccess();
    const input = new MockMidiInput('keys');
    access.connect(input);
    vi.stubGlobal('navigator', { requestMIDIAccess: access.request });
    render(<><TransportBar /><LiveInputPanel /></>);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'MIDI 鍵盤を使う' })));
    await begin();
    const press = (on: boolean, timeStamp: number | undefined) => source === 'PC'
      ? keyEvent(on ? 'keydown' : 'keyup', 'KeyA', { timeStamp })
      : input.send([on ? 0x90 : 0x80, 60, on ? 100 : 0], { timeStamp });
    tickAt(2.03);
    press(true, 51_980); // During the count-in, delivered 50 ms late.
    tickAt(2.1);
    press(false, 52_070);
    tickAt(2.2);
    press(true, 52_125);
    tickAt(2.45);
    press(false, 52_375);
    tickAt(2.5);
    press(true, undefined);
    tickAt(2.625);
    press(false, NaN);
    await act(async () => fireEvent.click(stopButton()));
    expect(destinationNotes().slice(1)).toEqual([
      expect.objectContaining({ pitch: 60, startBeat: 0.25, durationBeats: 0.5 }),
      expect.objectContaining({ pitch: 60, startBeat: 1, durationBeats: 0.25 }),
    ]);
  });

  it('blocks clip drags and other project edits from count-in through stop, then undoes the take once', async () => {
    render(<><TransportBar /><LiveInputPanel /></>);
    const store = useStore.getState();
    store.setTitle('編集中の曲');
    const before = useStore.getState();
    await begin();
    act(() => store.setTitle('録音中の編集'));
    expect(getBridgeSnapshot().toasts.at(-1)?.message).toBe(EDIT_BLOCKED_MESSAGE);
    act(() => store.undo());
    expect(useStore.getState().project).toBe(before.project);
    tickAt(2.25);
    keyDown('KeyA');
    const clipId = before.project.tracks[0]!.clips[0]!.id;
    act(() => {
      store.beginTransaction('drag');
      expect(store.applyProjectChange((project) => moveClip(project, clipId, 4))).toBe(false);
      store.commitTransaction('drag');
      store.setLiveInputOctave(5);
    });
    expect(useStore.getState().editor.liveInputOctave).toBe(5);
    expect(getBridgeSnapshot().toasts.at(-1)?.message).toBe(EDIT_BLOCKED_MESSAGE);
    tickAt(2.5);
    await act(async () => fireEvent.click(stopButton()));
    expect(destinationNotes().at(-1)).toMatchObject({ pitch: 60, startBeat: 0.5, durationBeats: 0.5 });
    expect(useStore.getState().past).toHaveLength(before.past.length + 1);
    act(() => store.undo());
    expect(useStore.getState().project).toBe(before.project);
  });

  it('refuses to delete the current song during a take', async () => {
    render(<TransportBar />);
    const before = useStore.getState();
    await begin();
    act(() => before.deleteProject(before.project.id));
    expect(useStore.getState().project).toBe(before.project);
    expect(loadProject(before.project.id)?.id).toBe(before.project.id);
    expect(recordingPhase()).toBe('count-in');
    expect(getBridgeSnapshot().toasts.at(-1)?.message).toBe(EDIT_BLOCKED_MESSAGE);
  });

  it.each(['open', 'reopen', 'create', 'import bundle'])('saves the take in its own Undo step before %s', async (action) => {
    render(<><TransportBar /><LiveInputPanel /></>);
    const before = useStore.getState();
    const other = createDefaultProject('別の曲');
    expect(saveProject(other)).toBe(true);
    await begin();
    tickAt(2.25);
    keyDown('KeyA');
    tickAt(2.5);
    const committed = vi.fn();
    const recordingFinished = vi.fn();
    const unsubscribeEvents = subscribeAppEvents((event) => {
      if (event.type === 'recording.finished') {
        const current = useStore.getState();
        recordingFinished(event.payload, current.project.id, current.projectOpenVersion, destinationNotes().length);
      }
    });
    const unsubscribe = useStore.subscribe((next) => {
      if (next.projectOpenVersion === before.projectOpenVersion && next.project !== before.project) committed(next.past.at(-1));
    });
    try {
      await act(async () => {
        if (action === 'open' || action === 'reopen') expect(before.loadProjectById(action === 'open' ? other.id : before.project.id)).toBe(true);
        else if (action === 'create') before.createNewProject('新しい曲');
        else before.replaceProject(other);
      });
      expect(recordingPhase()).toBe('idle');
      expect(committed).toHaveBeenCalledWith(before.project);
      expect(recordingFinished).toHaveBeenCalledExactlyOnceWith({
        trackId: before.project.tracks[0]!.id, clipId: before.project.tracks[0]!.clips[0]!.id, notesWritten: 1,
      }, before.project.id, before.projectOpenVersion, 2);
      const saved = loadProject(before.project.id)!;
      expect(saved.tracks[0]!.clips[0]!.notes!.at(-1)).toMatchObject({ pitch: 60, startBeat: 0.5, durationBeats: 0.5 });
      if (action === 'reopen') expect(destinationNotes()).toEqual(saved.tracks[0]!.clips[0]!.notes);
      else expect(useStore.getState().project.title).toBe(action === 'create' ? '新しい曲' : other.title);
    } finally {
      unsubscribe();
      unsubscribeEvents();
    }
  });

  it('saves the take before importing MIDI tracks and gives each change its own Undo step', async () => {
    render(<><TransportBar /><LiveInputPanel /></>);
    const before = useStore.getState();
    await begin();
    tickAt(2.25);
    keyDown('KeyA');
    tickAt(2.5);
    await act(async () => {
      expect(importMidiTracks({
        format: 0, ppq: 480, bpm: 100, timeSignature: [4, 4], tempos: [], timeSignatures: [],
        tracks: [{ index: 0, name: 'MIDI', notes: [{ pitch: 64, startBeat: 0, durationBeats: 1, channel: 0, velocity: 100 }] }],
      }).importedTrackCount).toBe(1);
    });
    expect(recordingPhase()).toBe('idle');
    expect(useStore.getState().past).toHaveLength(before.past.length + 2);
    act(() => before.undo());
    expect(useStore.getState().project.tracks).toHaveLength(before.project.tracks.length);
    expect(destinationNotes().at(-1)).toMatchObject({ pitch: 60, startBeat: 0.5, durationBeats: 0.5 });
    act(() => before.undo());
    expect(useStore.getState().project).toBe(before.project);
  });

  it('keeps monitoring with the recording track instrument when another track is selected mid-take', async () => {
    const store = useStore.getState();
    const project = store.project;
    const chords = project.tracks[0]!;
    store.loadProjectForPreview({
      ...project, tracks: [
        { ...chords, name: 'Chords', instrument: { type: 'synth', preset: 'warmPad' } },
        { ...chords, id: 'bass-track', name: 'Bass', instrument: { type: 'synth', preset: 'subBass' }, clips: [] },
      ],
    });
    store.selectTrack(chords.id);
    store.selectClip(chords.clips[0]!.id);
    render(<><TransportBar /><LiveInputPanel /></>);
    await begin();
    tickAt(2.25);
    act(() => useStore.getState().selectTrack('bass-track'));
    keyDown('KeyA');
    tickAt(2.5);
    keyUp('KeyA');
    expect(audio.instruments).toEqual(['warmPad']);
    await act(async () => fireEvent.click(stopButton()));
    expect(destinationNotes().slice(1)).toEqual([expect.objectContaining({ pitch: 60 })]);
    // Outside a take the selected track decides again.
    keyDown('KeyS');
    keyUp('KeyS');
    expect(audio.instruments.at(-1)).toBe('subBass');
  });

  it('folds the second pass into the first and clamps a held note at the loop end', async () => {
    render(<><TransportBar /><LiveInputPanel /></>);
    act(() => useStore.getState().loopRangeOn({ startBeat: 1, endBeat: 3 }));
    await begin();
    tickAt(2.875);
    keyDown('KeyA');
    tickAt(3.125);
    keyUp('KeyA');
    keyDown('KeyS');
    tickAt(3.375);
    await act(async () => fireEvent.click(stopButton()));
    expect(destinationNotes().slice(1)).toEqual([
      expect.objectContaining({ pitch: 62, startBeat: 1.25, durationBeats: 0.5 }),
      expect.objectContaining({ pitch: 60, startBeat: 2.75, durationBeats: 0.25 }),
    ]);
  });
});

it('keeps notes played during recording out of the recent performance', async () => {
  render(<><TransportBar /><LiveInputPanel /></>);
  const store = useStore.getState();
  const capture = screen.getByRole('button', { name: '今の演奏を拾う' });
  fireEvent.click(screen.getByRole('button', { name: 'PC で演奏' }));
  act(() => store.setPosition(2));
  keyDown('KeyA');
  audio.time = 0.125;

  await begin();
  expect((capture as HTMLButtonElement).disabled).toBe(true);
  tickAt(2.375);
  keyUp('KeyA');
  keyDown('KeyS');
  tickAt(2.5);
  keyUp('KeyS');
  await act(async () => fireEvent.click(stopButton()));

  expect(destinationNotes().map((note) => note.pitch)).toEqual([55, 62]);
  fireEvent.click(capture);
  expect(destinationNotes().map((note) => note.pitch)).toEqual([55, 62, 60]);
  expect(destinationNotes().at(-1)).toMatchObject({ startBeat: 2, durationBeats: 0.25 });
});
