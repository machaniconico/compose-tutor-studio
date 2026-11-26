// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';
import type { DrumScheduleEvent } from '../src/audio/events';

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
        lengthBars: 9,
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

describe('DrumGrid with a looping clip (8 beats, 4-beat period, 4/4, 16 steps)', () => {
  beforeEach(() => {
    act(() => {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((t) =>
          t.type === 'drum'
            ? {
                ...t,
                clips: t.clips.map((c) => ({
                  ...c,
                  lengthBeats: 8,
                  contentLengthBeats: 4,
                  loop: true,
                  drumEvents: [],
                })),
              }
            : t,
        ),
      }));
    });
  });

  it('saves a step turned on in the second repeat as the first-repeat step, so it sounds', async () => {
    const { buildScheduleEvents } = await import('../src/audio/events');
    render(<DrumGrid />);
    const bars = within(screen.getByRole('group', { name: '小節切替' })).getAllByRole('button');
    fireEvent.click(bars[1]!);
    fireEvent.click(screen.getByLabelText('キック ステップ 1'));

    expect(drumEvents().map((e) => [e.lane, e.stepIndex])).toEqual([['kick', 0]]);
    const drumTrack = useStore.getState().project.tracks.find((t) => t.type === 'drum')!;
    const clipStart = drumTrack.clips[0]!.startBeat;
    const kicks = buildScheduleEvents(useStore.getState().project)
      .filter((e) => {
        const payload = e.payload as DrumScheduleEvent | { kind: 'note' };
        return payload.kind === 'drum' && payload.trackId === drumTrack.id;
      })
      .map((e) => e.beat - clipStart);
    expect(kicks).toEqual([0, 4]);
    // The second repeat shows the step that sounds there as on.
    expect(screen.getByLabelText('キック ステップ 1 強さ 100').getAttribute('aria-pressed')).toBe('true');
  });

  it('disables cells of a period that does not fall on a step (3.9-beat period)', () => {
    act(() => {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((t) =>
          t.type === 'drum' ? { ...t, clips: t.clips.map((c) => ({ ...c, contentLengthBeats: 3.9 })) } : t,
        ),
      }));
    });
    render(<DrumGrid />);
    const bars = within(screen.getByRole('group', { name: '小節切替' })).getAllByRole('button');
    fireEvent.click(bars[1]!);
    const cell = screen.getByLabelText('キック ステップ 1(ループで鳴らない位置)') as HTMLButtonElement;
    expect(cell.disabled).toBe(true);
  });
});

it('shows linked drum hits and edits the source for cells and patterns in one undo step each', () => {
  const state = useStore.getState();
  const track = state.project.tracks.find((candidate) => candidate.type === 'drum')!;
  const source = {
    ...track.clips[0]!,
    lengthBeats: 4,
    stepsPerBar: 8,
    drumEvents: [{ id: 'kick', lane: 'kick' as const, stepIndex: 0, velocity: 100 }],
  };
  const linked = { ...source, id: 'linked', startBeat: 4, aliasOf: source.id, stepsPerBar: 16, drumEvents: [] };
  const clips = () => useStore.getState().project.tracks.find((candidate) => candidate.id === track.id)!.clips;
  act(() => {
    state.applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((candidate) =>
        candidate.id === track.id ? { ...candidate, clips: [source, linked] } : candidate,
      ),
    }));
    state.selectClip(linked.id);
  });

  render(<DrumGrid />);
  const kick = screen.getByRole('button', { name: 'キック ステップ 1 強さ 100' });
  expect(kick.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByLabelText('キック ステップ 9')).toBeNull();
  const historyLength = useStore.getState().past.length;

  fireEvent.click(kick);
  expect(clips()[0]!.drumEvents).toEqual([{ ...source.drumEvents[0], velocity: 70 }]);
  expect(clips()[1]).toEqual(linked);
  expect(useStore.getState().past).toHaveLength(historyLength + 1);
  act(() => state.undo());
  expect(clips()).toEqual([source, linked]);

  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    fireEvent.click(screen.getByRole('button', { name: '8ビート' }));
    expect(clips()[0]!.drumEvents!.length).toBeGreaterThan(1);
    expect(clips()[1]).toEqual(linked);
    expect(useStore.getState().past).toHaveLength(historyLength + 1);
    act(() => state.undo());
    expect(clips()).toEqual([source, linked]);
  } finally {
    confirm.mockRestore();
  }
});

describe('DrumGrid の 12/16 ステップ切替 (US-019)', () => {
  const setHits = (hits: Array<[number, 'kick' | 'closedHat']>, timeSignature: [number, number] = [4, 4]) => {
    act(() => {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        timeSignature,
        tracks: project.tracks.map((t) => t.type === 'drum'
          ? {
              ...t,
              clips: t.clips.map((c, ci) => ci === 0
                ? {
                    ...c, lengthBeats: timeSignature[0], stepsPerBar: 4 * timeSignature[0],
                    drumEvents: hits.map(([stepIndex, lane], i) => ({ id: `x${i}`, lane, stepIndex, velocity: 100 })),
                  }
                : c),
            }
          : t),
      }));
    });
  };
  const drumClip0 = () => useStore.getState().project.tracks.find((t) => t.type === 'drum')!.clips[0]!;
  const stepsGroup = () => within(screen.getByRole('group', { name: '1 小節のマスの数' }));

  it('切替時に件数入りの日本語の確認文言を出し、確認後に動かす。Undo 1 段で戻る', () => {
    setHits([[0, 'kick'], [1, 'closedHat'], [2, 'closedHat']]);
    const before = drumClip0();
    const depth = useStore.getState().past.length;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<DrumGrid />);
      expect(stepsGroup().getByRole('button', { name: '16 マス' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(stepsGroup().getByRole('button', { name: '12 マス' }));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0]![0]).toBe(
        '12 マスのグリッドに合わない音が 2 個あります。最も近い位置へ動かします。よろしいですか？',
      );
      expect(drumClip0().stepsPerBar).toBe(12);
      expect(drumClip0().drumEvents!.map((e) => e.stepIndex)).toEqual([0, 1, 2]);
      expect(useStore.getState().past.length).toBe(depth + 1);
      expect(screen.getAllByLabelText(/^キック ステップ \d+/)).toHaveLength(12);
      act(() => useStore.getState().undo());
      expect(drumClip0()).toEqual(before);
    } finally {
      confirm.mockRestore();
    }
  });

  it('重なってまとめる音があるときはその数も示す', () => {
    setHits([[2, 'closedHat'], [3, 'closedHat']]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<DrumGrid />);
      fireEvent.click(stepsGroup().getByRole('button', { name: '12 マス' }));
      expect(confirm.mock.calls[0]![0]).toBe(
        '12 マスのグリッドに合わない音が 1 個あります。最も近い位置へ動かします。同じ位置に重なる 1 個の音は 1 つにまとめます。よろしいですか？',
      );
      expect(drumClip0().drumEvents).toHaveLength(1);
    } finally {
      confirm.mockRestore();
    }
  });

  it('確認でキャンセルしたら何も変えない', () => {
    setHits([[1, 'closedHat']]);
    const before = useStore.getState().project;
    const depth = useStore.getState().past.length;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      render(<DrumGrid />);
      fireEvent.click(stepsGroup().getByRole('button', { name: '12 マス' }));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(useStore.getState().project).toBe(before);
      expect(useStore.getState().past.length).toBe(depth);
    } finally {
      confirm.mockRestore();
    }
  });

  it('ずれる音が無ければ確認を出さずに切り替える(3/4 の 12→16、3 の倍数のステップだけ)', () => {
    setHits([[0, 'kick'], [3, 'kick'], [9, 'closedHat']], [3, 4]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      render(<DrumGrid />);
      expect(stepsGroup().getByRole('button', { name: '12 マス' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(stepsGroup().getByRole('button', { name: '16 マス' }));
      expect(confirm).not.toHaveBeenCalled();
      expect(drumClip0().stepsPerBar).toBe(16);
      expect(drumClip0().drumEvents!.map((e) => e.stepIndex)).toEqual([0, 4, 12]);
    } finally {
      confirm.mockRestore();
    }
  });

  it('切り替えられないときは確認を出さず、何も変えず、理由をトーストで出す', async () => {
    const { getBridgeSnapshot } = await import('../src/state/tutorialBridge');
    act(() => {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((t) => t.type === 'drum'
          ? {
              ...t,
              clips: t.clips.map((c, ci) => ci === 0
                ? { ...c, stepsPerBar: 12, drumEvents: [{ id: 'far', lane: 'kick' as const, stepIndex: 1.7e308, velocity: 100 }] }
                : c),
            }
          : t),
      }));
    });
    const before = useStore.getState().project;
    const toasts = getBridgeSnapshot().toasts.length;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<DrumGrid />);
      fireEvent.click(stepsGroup().getByRole('button', { name: '16 マス' }));
      expect(confirm).not.toHaveBeenCalled();
      expect(useStore.getState().project).toBe(before);
      expect(getBridgeSnapshot().toasts).toHaveLength(toasts + 1);
      expect(getBridgeSnapshot().toasts.at(-1)?.message).toBe('このクリップは細かさの設定が特殊なため、マス数を切り替えられません。');
    } finally {
      confirm.mockRestore();
    }
  });

  it('4/4 の 12 マスでは 3 マスごとに拍の区切りを示す', () => {
    setHits([]);
    act(() => { setDrumSteps12(); });
    render(<DrumGrid />);
    const cells = screen.getAllByLabelText(/^キック ステップ \d+$/);
    expect(cells.map((c) => c.classList.contains('is-beat-start'))).toEqual(
      Array.from({ length: 12 }, (_, i) => i % 3 === 0),
    );
  });

  function setDrumSteps12() {
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((t) => t.type === 'drum'
        ? { ...t, clips: t.clips.map((c, ci) => (ci === 0 ? { ...c, stepsPerBar: 12 } : c)) }
        : t),
    }));
  }
});
