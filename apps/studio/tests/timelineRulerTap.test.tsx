// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let TimelineRuler: typeof import('../src/features/transport/TimelineRuler')['TimelineRuler'];
let TapTempoButton: typeof import('../src/features/transport/TapTempoButton')['TapTempoButton'];
let buildScheduleEvents: typeof import('../src/audio/events')['buildScheduleEvents'];

function installSerialLocks(): void {
  let tail: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    value: {
      request<T>(_n: string, _o: unknown, cb: () => Promise<T> | T): Promise<T> {
        const run = tail.then(() => cb());
        tail = run.catch(() => undefined);
        return run;
      },
    },
    configurable: true,
  });
}

let nowMs = 0;
let realSetBpm: ((bpm: number) => void) | undefined;

beforeAll(async () => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(window, 'PointerEvent', { value: TestPointerEvent, configurable: true });
  installSerialLocks();
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ TimelineRuler } = await import('../src/features/transport/TimelineRuler'));
  ({ TapTempoButton } = await import('../src/features/transport/TapTempoButton'));
  ({ buildScheduleEvents } = await import('../src/audio/events'));
});

beforeEach(async () => {
  realSetBpm ??= useStore.getState().setBpm;
  useStore.setState({ setBpm: realSetBpm });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  nowMs = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('ルーラー')).toBe(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tap(count: number, gapMs: number): void {
  const button = screen.getByRole('button', { name: 'タップテンポ' });
  for (let i = 0; i < count; i += 1) {
    nowMs += gapMs;
    fireEvent.click(button);
  }
}

describe('TimelineRuler', () => {
  it('click seeks to the nearest beat and is not an undo step', () => {
    render(<TimelineRuler />);
    const past = useStore.getState().past.length;
    const ruler = screen.getByTestId('timeline-ruler');
    const ppb = 28 * useStore.getState().editor.zoomX;
    fireEvent.pointerDown(ruler, { button: 0, clientX: ppb * 3 + 2, pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: ppb * 3 + 2, pointerId: 1 });
    expect(useStore.getState().transport.positionBeat).toBe(3);
    expect(useStore.getState().past.length).toBe(past);
  });

  it('drag sets the runtime loop range without touching project or history', () => {
    render(<TimelineRuler />);
    const projectBefore = useStore.getState().project;
    const past = useStore.getState().past.length;
    const ruler = screen.getByTestId('timeline-ruler');
    const ppb = 28 * useStore.getState().editor.zoomX;
    fireEvent.pointerDown(ruler, { button: 0, clientX: ppb * 4, pointerId: 1 });
    fireEvent.pointerMove(ruler, { clientX: ppb * 8, pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: ppb * 8, pointerId: 1 });
    const t = useStore.getState().transport;
    expect([t.loopEnabled, t.loopStartBeat, t.loopEndBeat]).toEqual([true, 4, 8]);
    expect(useStore.getState().project).toBe(projectBefore);
    expect(useStore.getState().past.length).toBe(past);
  });

  it('refuses a seek while recording', () => {
    useStore.setState({ audioRecordingOperationId: 7 });
    render(<TimelineRuler />);
    const ruler = screen.getByTestId('timeline-ruler');
    fireEvent.pointerDown(ruler, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: 100, pointerId: 1 });
    expect(useStore.getState().transport.positionBeat).toBe(0);
    expect(screen.getByRole('status').textContent).toContain('録音中');
    useStore.setState({ audioRecordingOperationId: null });
  });
});

describe('TapTempoButton', () => {
  it('a tap run is exactly 1 undo step and stays within BPM limits', () => {
    render(<TapTempoButton />);
    const before = useStore.getState().project.bpm;
    const past = useStore.getState().past.length;
    tap(4, 600);
    expect(useStore.getState().past.length).toBe(past);
    act(() => vi.advanceTimersByTime(2500));
    const project = useStore.getState().project;
    expect(project.bpm).toBe(100);
    expect(project.tempoMap[0]?.bpm).toBe(100);
    expect(useStore.getState().past.length).toBe(past + 1);
    act(() => useStore.getState().undo());
    expect(useStore.getState().project.bpm).toBe(before);
    expect(buildScheduleEvents(useStore.getState().project).every((e) => Number.isFinite(e.beat) && e.beat >= 0)).toBe(true);
  });

  it('very fast taps clamp to 300 BPM and a single tap changes nothing', () => {
    render(<TapTempoButton />);
    tap(1, 100);
    act(() => vi.advanceTimersByTime(2500));
    expect(useStore.getState().project.bpm).toBe(120);
    tap(4, 50);
    act(() => vi.advanceTimersByTime(2500));
    expect(useStore.getState().project.bpm).toBe(300);
    const events = buildScheduleEvents(useStore.getState().project);
    const length = useStore.getState().project.lengthBeats;
    expect(events.every((e) => Number.isFinite(e.beat) && e.beat >= 0 && e.beat <= length)).toBe(true);
  });
});

describe('runtime loop / punch follow the song length', () => {
  function withLength(beats: number) {
    const p = useStore.getState().project;
    return { ...p, lengthBeats: beats, lengthBars: beats / 4 };
  }

  it('undoing a length extension disables a loop that now lies outside the song', () => {
    const base = useStore.getState().project;
    const long = withLength(base.lengthBeats + 4);
    useStore.setState({ past: [base], project: long });
    expect(useStore.getState().setLoopRange(base.lengthBeats, long.lengthBeats)).toBe(true);
    act(() => useStore.getState().undo());
    const t = useStore.getState().transport;
    expect(useStore.getState().project.lengthBeats).toBe(base.lengthBeats);
    expect(t.loopEnabled).toBe(false);
    expect(t.loopEndBeat).toBeLessThanOrEqual(base.lengthBeats);
    act(() => useStore.getState().redo());
    expect(useStore.getState().transport.loopEnabled).toBe(false);
  });

  it('any project replacement clamps loop and punch; in-range ranges are kept', () => {
    const base = useStore.getState().project;
    expect(useStore.getState().setLoopRange(4, 8)).toBe(true);
    useStore.setState({ project: withLength(base.lengthBeats + 4) });
    expect(useStore.getState().transport.loopEnabled).toBe(true);
    useStore.setState({
      transport: { ...useStore.getState().transport, punchEnabled: true, punchInBeat: 30, punchOutBeat: 34 },
      project: withLength(base.lengthBeats + 8),
    });
    useStore.setState({ project: withLength(8) });
    const t = useStore.getState().transport;
    expect(t.punchEnabled).toBe(false);
    expect(t.punchOutBeat).toBeLessThanOrEqual(8);
    expect(t.loopEnabled).toBe(true);
    useStore.setState({ project: withLength(6) });
    expect(useStore.getState().transport.loopEnabled).toBe(false);
  });
});

describe('tap runs are bound to their project', () => {
  it('switching project discards the pending run', () => {
    const setBpm = vi.fn();
    useStore.setState({ setBpm });
    render(<TapTempoButton />);
    tap(3, 600);
    const other = { ...useStore.getState().project, id: 'other-project' };
    act(() => useStore.setState({ project: other, past: [] }));
    act(() => vi.advanceTimersByTime(2500));
    expect(setBpm).not.toHaveBeenCalled();
  });

  it('unmount discards the pending run', () => {
    const { unmount } = render(<TapTempoButton />);
    const before = useStore.getState().project.bpm;
    tap(3, 600);
    unmount();
    act(() => vi.advanceTimersByTime(2500));
    expect(useStore.getState().project.bpm).toBe(before);
  });
});

describe('automation pass active', () => {
  function startPass(): () => void {
    const track = useStore.getState().project.tracks.find((t) => t.type !== 'master');
    if (!track) throw new Error('track fixture missing');
    expect(useStore.getState().setTrackAutomationMode(track.id, 'write')).toBe(true);
    useStore.getState().play();
    const requestId = useStore.getState().transport.playbackRequestId;
    expect(useStore.getState().attachAutomationPlaybackRuntime(requestId, () => 1, {
      beginOverride: vi.fn(),
      updateOverride: vi.fn(),
      releaseTouchOverride: vi.fn(),
      resumeOverride: vi.fn(),
    })).toBe(true);
    expect(useStore.getState().automationRecording.passActive).toBe(true);
    const ownership = useStore.getState().automationRecording.ownership;
    return () => {
      if (ownership) useStore.getState().detachAutomationPlaybackRuntime(ownership);
    };
  }

  it('refuses seek and loop drag without ending the pass or committing points', () => {
    const detach = startPass();
    render(<TimelineRuler />);
    const before = useStore.getState();
    const ruler = screen.getByTestId('timeline-ruler');
    const ppb = 28 * before.editor.zoomX;
    fireEvent.pointerDown(ruler, { button: 0, clientX: ppb * 4, pointerId: 1 });
    fireEvent.pointerMove(ruler, { clientX: ppb * 8, pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: ppb * 8, pointerId: 1 });
    fireEvent.pointerDown(ruler, { button: 0, clientX: ppb * 2, pointerId: 2 });
    fireEvent.pointerUp(ruler, { clientX: ppb * 2, pointerId: 2 });
    const after = useStore.getState();
    expect(after.automationRecording.passActive).toBe(true);
    expect(after.project).toBe(before.project);
    expect(after.past.length).toBe(before.past.length);
    expect(after.transport.loopEnabled).toBe(before.transport.loopEnabled);
    expect(after.transport.loopEndBeat).toBe(before.transport.loopEndBeat);
    expect(after.transport.phase).toBe(before.transport.phase);
    expect(after.transport.playbackRequestId).toBe(before.transport.playbackRequestId);
    expect(screen.getByRole('status').textContent).toContain('オートメーションを記録中');
    detach();
  });
});

describe('fractional loops from main', () => {
  it('the ruler draws a 2-2.5 loop at the right place, and a new drag is whole beats', () => {
    act(() => {
      useStore.setState({
        transport: { ...useStore.getState().transport, loopEnabled: true, loopStartBeat: 2, loopEndBeat: 2.5 },
      });
    });
    render(<TimelineRuler />);
    const ppb = 28 * useStore.getState().editor.zoomX;
    const band = screen.getByTestId('loop-range-band');
    expect(band.style.left).toBe(`${2 * ppb}px`);
    expect(band.style.width).toBe(`${0.5 * ppb}px`);
    const ruler = screen.getByTestId('timeline-ruler');
    fireEvent.pointerDown(ruler, { button: 0, clientX: ppb * 2.3, pointerId: 1 });
    fireEvent.pointerMove(ruler, { clientX: ppb * 4.4, pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: ppb * 4.4, pointerId: 1 });
    const t = useStore.getState().transport;
    expect([t.loopStartBeat, t.loopEndBeat]).toEqual([2, 4]);
  });
});
