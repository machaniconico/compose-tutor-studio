import { createEmptyProject } from '@cts/project-model';
import { describe, expect, it, vi } from 'vitest';
import {
  automationDisplayValue,
  createAutomationGestureAdapter,
  resolveAutomationGestureDisplayValue,
  shouldFollowAutomationRead,
  type AutomationGestureAdapterOptions,
  type GestureToken,
} from '../src/features/automation/useAutomationGesture';

function fixture(capturing = true) {
  let shouldCapture = capturing;
  const calls = {
    scalar: vi.fn(),
    begin: vi.fn(() => true),
    update: vi.fn(() => true),
    end: vi.fn(() => true),
  };
  let pointer: GestureToken | null = null;
  const options: AutomationGestureAdapterOptions = {
    shouldCapture: () => shouldCapture,
    setScalar: calls.scalar,
    beginCapture: calls.begin,
    updateCapture: calls.update,
    endCapture: calls.end,
    transaction: {
      begin: (token) => {
        if (shouldCapture || pointer !== null) return false;
        pointer = token;
        return true;
      },
      owns: (token) => pointer === token,
      anyActive: () => pointer !== null,
      commit: () => { pointer = null; },
      cancel: () => { pointer = null; },
    },
  };
  return {
    adapter: createAutomationGestureAdapter(options),
    calls,
    setCapturing: (next: boolean) => {
      shouldCapture = next;
    },
  };
}

describe('shared automation gesture adapter', () => {
  it('resolves the enabled Master Read curve and every Read gate', () => {
    const project = createEmptyProject();
    const master = project.tracks.find((track) => track.type === 'master');
    if (!master) throw new Error('Master fixture missing');
    master.volume = 0.8;
    project.automationLanes = [{
      id: 'master-display-lane',
      bypassed: false,
      target: { type: 'track-volume', trackId: master.id },
      points: [
        { id: 'display-0', beat: 0, value: 0.5, interpolation: 'linear' },
        { id: 'display-1', beat: 4, value: 1.5, interpolation: 'hold' },
      ],
    }];
    const target = { type: 'track-volume', trackId: master.id } as const;

    expect(automationDisplayValue(project, target, 'playing', 2, true)).toBe(1);
    expect(automationDisplayValue(project, target, 'stopped', 2, true)).toBe(0.8);
    expect(automationDisplayValue(project, target, 'playing', 2, false)).toBe(0.8);

    project.automationReadState = { globalEnabled: false, disabledTrackIds: [] };
    expect(automationDisplayValue(project, target, 'playing', 2, true)).toBe(0.8);
    project.automationReadState = {
      globalEnabled: true,
      disabledTrackIds: [master.id],
    };
    expect(automationDisplayValue(project, target, 'playing', 2, true)).toBe(0.8);
    project.automationReadState = { globalEnabled: true, disabledTrackIds: [] };
    project.automationLanes[0] = {
      ...project.automationLanes[0]!,
      bypassed: true,
    };
    expect(automationDisplayValue(project, target, 'playing', 2, true)).toBe(0.8);
  });

  it('keeps a live manual gesture preview ahead of a moving Read curve', () => {
    expect(resolveAutomationGestureDisplayValue(1.25, 0.8, 0.4, true)).toBe(1.25);
    expect(resolveAutomationGestureDisplayValue(null, 0.8, 0.4, true)).toBe(0.4);
    expect(resolveAutomationGestureDisplayValue(null, 0.8, 0.4, false)).toBe(0.8);
  });

  it('shows the scalar while Write owns output and lets Touch/Latch read before touch', () => {
    expect(shouldFollowAutomationRead(true, 'playing', 'write')).toBe(false);
    expect(shouldFollowAutomationRead(true, 'playing', 'touch')).toBe(true);
    expect(shouldFollowAutomationRead(true, 'playing', 'latch')).toBe(true);
    expect(shouldFollowAutomationRead(true, 'playing', 'read')).toBe(true);
    expect(shouldFollowAutomationRead(true, 'stopped', 'write')).toBe(true);
  });

  it('drops retired tokens, including events with a recycled pointer ID', () => {
    const { adapter, calls } = fixture(false);
    const first = { kind: 'pointer', pointerId: 7 } as const;
    const second = { kind: 'pointer', pointerId: 7 } as const;

    expect(adapter.begin(first, 1)).toBe(true);
    expect(adapter.change(first, 1.25)).toBe(true);
    expect(adapter.finish(first)).toBe(true);
    expect(adapter.begin(second, 1.25)).toBe(true);
    expect(adapter.change(first, 0.5)).toBe(false);
    expect(adapter.finish(first, 'cancel')).toBe(false);
    expect(adapter.change(second, 1.5)).toBe(true);
    expect(adapter.finish(second)).toBe(true);
    expect(adapter.begin(first, 1)).toBe(false);
    expect(calls.scalar.mock.calls).toEqual([[1.25], [1.5]]);
  });

  it('keeps the owning pointer while a second pointer tries to edit or cancel', () => {
    const { adapter, calls } = fixture(false);
    const first = { kind: 'pointer', pointerId: 7 } as const;
    const second = { kind: 'pointer', pointerId: 8 } as const;
    expect(adapter.begin(first, 1)).toBe(true);
    expect(adapter.begin(second, 1)).toBe(false);
    expect(adapter.change(second, 0.5)).toBe(false);
    expect(adapter.finish(second, 'cancel')).toBe(false);
    expect(adapter.change(first, 1.5)).toBe(true);
    expect(adapter.finish(first)).toBe(true);
    expect(calls.scalar.mock.calls).toEqual([[1.5]]);
  });

  it('ends keyboard capture once and ignores repeated terminal events', () => {
    const { adapter, calls } = fixture();
    const token = { kind: 'keyboard' } as const;
    expect(adapter.begin(token, 0.5)).toBe(true);
    expect(adapter.change(token, 0.51)).toBe(true);
    expect(adapter.finish(token)).toBe(true);
    expect(adapter.finish(token)).toBe(false);
    expect(adapter.change(token, 0.52)).toBe(false);

    expect(calls.begin.mock.calls).toEqual([[0.5]]);
    expect(calls.update.mock.calls).toEqual([[0.51]]);
    expect(calls.end).toHaveBeenCalledOnce();
  });

  it('retries a rejected keyboard capture begin with the same token', () => {
    const { adapter, calls } = fixture();
    calls.begin.mockReturnValueOnce(false);
    const token = { kind: 'keyboard' } as const;
    expect(adapter.begin(token, 0.5)).toBe(true);
    expect(adapter.change(token, 0.51)).toBe(true);
    expect(adapter.finish(token)).toBe(true);
    expect(calls.begin.mock.calls).toEqual([[0.5], [0.51]]);
    expect(calls.end).toHaveBeenCalledOnce();
  });

  it('never calls end if keyboard capture never began', () => {
    const { adapter, calls } = fixture();
    calls.begin.mockReturnValue(false);
    const token = { kind: 'keyboard' } as const;
    expect(adapter.begin(token, 1)).toBe(true);
    expect(adapter.finish(token)).toBe(true);
    expect(calls.end).not.toHaveBeenCalled();
  });

  it('blocks pointer capture while recording and accepts a fresh pointer after recording', () => {
    const { adapter, calls, setCapturing } = fixture();
    const refused = { kind: 'pointer', pointerId: 7 } as const;
    expect(adapter.begin(refused, 1)).toBe(false);
    setCapturing(false);
    expect(adapter.change(refused, 1.25)).toBe(false);
    expect(adapter.begin(refused, 1)).toBe(false);
    expect(calls.begin).not.toHaveBeenCalled();

    const fresh = { kind: 'pointer', pointerId: 7 } as const;
    expect(adapter.begin(fresh, 1)).toBe(true);
    expect(adapter.change(fresh, 1.25)).toBe(true);
    expect(calls.scalar.mock.calls).toEqual([[1.25]]);
  });
});
