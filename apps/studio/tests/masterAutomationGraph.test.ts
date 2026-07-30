import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionMasterGraph,
  MasterAutomationGraph,
} from '../src/audio/masterAutomationGraph';

class TestAudioParam {
  value = 1;
  readonly setTargetAtTime = vi.fn();
  readonly setValueAtTime = vi.fn();
  readonly linearRampToValueAtTime = vi.fn();
  readonly cancelAndHoldAtTime = vi.fn();
  readonly cancelScheduledValues = vi.fn();
}

class TestGainNode {
  readonly gain = new TestAudioParam();
  readonly connect = vi.fn((destination: TestGainNode) => destination);
  readonly disconnect = vi.fn();
}

function makeGraph() {
  const gain = {
    gain: new TestAudioParam(),
  } as unknown as GainNode;
  const context = { currentTime: 0 };
  return {
    graph: new MasterAutomationGraph(context as BaseAudioContext, gain),
    param: gain.gain as unknown as TestAudioParam,
    context,
  };
}

describe('MasterAutomationGraph', () => {
  it('applies the persisted scalar and schedules clamped automation commands', () => {
    const { graph, param } = makeGraph();

    expect(graph.applyScalar(0.7, 1, 'immediate')).toBe(true);
    expect(param.cancelScheduledValues).toHaveBeenCalledWith(1);
    expect(param.setValueAtTime).toHaveBeenCalledWith(0.7, 1);

    graph.scheduleAutomation(4, 2, 'hold');
    graph.scheduleAutomation(0.25, 3, 'linear');
    expect(param.setValueAtTime).toHaveBeenLastCalledWith(2, 2);
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(0.25, 3);
  });

  it('fences lookahead while manually owned and resumes after the return ramp', () => {
    const { graph, param, context } = makeGraph();

    const generation = graph.beginAutomationOverride(0.4, 0.5);
    expect(param.cancelAndHoldAtTime).toHaveBeenCalledWith(0.5);
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(0.4, 0.51);
    expect(graph.applyScalar(0.8, 0.6, 'smoothed')).toBe(false);

    graph.scheduleAutomation(0.2, 1, 'hold');
    expect(param.setValueAtTime).not.toHaveBeenCalledWith(0.2, 1);

    expect(graph.releaseAutomationOverride(0.6, 1, 0.05, generation + 1))
      .toBe(false);
    expect(graph.releaseAutomationOverride(0.6, 1, 0.05, generation))
      .toBe(true);
    expect(param.linearRampToValueAtTime).toHaveBeenLastCalledWith(0.6, 1.05);

    graph.scheduleAutomation(0.3, 1.05, 'hold');
    expect(param.setValueAtTime).not.toHaveBeenCalledWith(0.3, 1.05);
    graph.scheduleAutomation(0.3, 1.051, 'hold');
    expect(param.setValueAtTime).toHaveBeenCalledWith(0.3, 1.051);
    expect(graph.isAutomationOverridden(1.02)).toBe(true);
    context.currentTime = 1.051;
    expect(graph.isAutomationOverridden()).toBe(false);
  });

  it('retires a completed return even when no later lane command exists', () => {
    const { graph, context } = makeGraph();
    graph.beginAutomationOverride(0.5, 1);
    graph.releaseAutomationOverride(0.75, 1, 0.05);

    context.currentTime = 1.04;
    expect(graph.applyScalar(0.9, 1.04, 'smoothed')).toBe(false);
    context.currentTime = 1.051;
    expect(graph.applyScalar(0.9, 1.051, 'smoothed')).toBe(true);
  });

  it('updates an active gesture without changing its generation', () => {
    const { graph, param } = makeGraph();
    const generation = graph.beginAutomationOverride(0.5, 2);
    const updatedGeneration = graph.updateAutomationOverride(-1, 2.1);

    expect(updatedGeneration).toBe(generation);
    expect(param.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 2.11);
    expect(graph.isAutomationOverridden(20)).toBe(true);
    graph.dispose();
    expect(graph.isAutomationOverridden(20)).toBe(false);
  });

  it('owns a disposable session path while leaving the engine stage at unity', () => {
    const gains: TestGainNode[] = [];
    const context = {
      currentTime: 0,
      createGain: vi.fn(() => {
        const gain = new TestGainNode();
        gains.push(gain);
        return gain;
      }),
    } as unknown as BaseAudioContext;
    const engineMaster = new TestGainNode() as unknown as GainNode;

    const session = buildSessionMasterGraph(context, engineMaster, 0.65, 4);

    expect(gains).toHaveLength(2);
    expect(gains[0]?.connect).toHaveBeenCalledWith(gains[1]);
    expect(gains[1]?.connect).toHaveBeenCalledWith(engineMaster);
    expect((engineMaster.gain as unknown as TestAudioParam).setValueAtTime)
      .toHaveBeenCalledWith(1, 4);
    expect(gains[1]?.gain.setValueAtTime).toHaveBeenCalledWith(0.65, 4);
    expect(gains[0]?.gain.setValueAtTime).not.toHaveBeenCalled();

    session.dispose();
    session.dispose();
    expect(gains[0]?.disconnect).toHaveBeenCalledOnce();
    expect(gains[0]?.disconnect).toHaveBeenCalledWith(gains[1]);
    expect(gains[1]?.disconnect).toHaveBeenCalledOnce();
    expect(gains[1]?.disconnect).toHaveBeenCalledWith(engineMaster);
    expect((engineMaster as unknown as TestGainNode).disconnect).not.toHaveBeenCalled();
  });
});
