import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio/engine';

type TestAudioContextState = AudioContextState | 'interrupted';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function audioParam(): AudioParam {
  return { value: 0 } as AudioParam;
}

function connectableNode<T extends object>(shape: T): T & Pick<AudioNode, 'connect' | 'disconnect'> {
  return Object.assign(shape, {
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
}

class FakeAudioContext {
  state: TestAudioContextState;
  currentTime = 0;
  readonly destination = {} as AudioDestinationNode;
  readonly gain = connectableNode({ gain: audioParam() });
  readonly limiter = connectableNode({
    threshold: audioParam(),
    knee: audioParam(),
    ratio: audioParam(),
    attack: audioParam(),
    release: audioParam(),
  });
  readonly createGain = vi.fn(() => this.gain as unknown as GainNode);
  readonly createDynamicsCompressor = vi.fn(
    () => this.limiter as unknown as DynamicsCompressorNode,
  );
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  readonly resume = vi.fn(async () => {
    this.state = 'running';
  });
  readonly close = vi.fn(async () => {
    this.state = 'closed';
  });
  readonly addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (type === 'statechange' && listener) this.listeners.add(listener);
    },
  );
  readonly removeEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (type === 'statechange' && listener) this.listeners.delete(listener);
    },
  );

  private readonly listeners = new Set<EventListenerOrEventListenerObject>();

  constructor(state: TestAudioContextState = 'running') {
    this.state = state;
  }

  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }

  transitionTo(state: TestAudioContextState): void {
    this.state = state;
    const event = { currentTarget: this.asAudioContext() } as unknown as Event;
    for (const listener of [...this.listeners]) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

describe('AudioEngine', () => {
  it('constructs synchronously, shares one resume flight, and returns only after running', async () => {
    const resumeFlight = deferred<void>();
    const context = new FakeAudioContext('suspended');
    context.resume.mockImplementation(() => resumeFlight.promise);
    const factory = vi.fn(() => context.asAudioContext());
    const engine = new AudioEngine(factory);

    const first = engine.ensureContext();
    const second = engine.ensureContext();

    // Both construction and resume happen before ensureContext yields, preserving
    // the initiating browser gesture while concurrent callers share one attempt.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(context.resume).toHaveBeenCalledTimes(1);

    context.state = 'running';
    resumeFlight.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.context).toBe(context.asAudioContext());
    expect(secondResult.context).toBe(context.asAudioContext());
    expect(firstResult.master).toBe(context.gain);
    expect(firstResult.contextGeneration).toBe(1);
    expect(secondResult.contextGeneration).toBe(1);
    expect(engine.contextGeneration).toBe(1);
  });

  it('does not expose a partial graph and can retry after graph construction fails', async () => {
    const failedContext = new FakeAudioContext();
    failedContext.createDynamicsCompressor.mockImplementation(() => {
      throw new Error('limiter unavailable');
    });
    const recoveredContext = new FakeAudioContext();
    const factory = vi
      .fn<() => AudioContext>()
      .mockReturnValueOnce(failedContext.asAudioContext())
      .mockReturnValueOnce(recoveredContext.asAudioContext());
    const engine = new AudioEngine(factory);

    await expect(engine.ensureContext()).rejects.toThrow('limiter unavailable');
    expect(engine.isInitialized).toBe(false);
    expect(engine.contextGeneration).toBe(0);
    expect(failedContext.gain.disconnect).toHaveBeenCalledTimes(1);
    expect(failedContext.close).toHaveBeenCalledTimes(1);

    const result = await engine.ensureContext();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(result.context).toBe(recoveredContext.asAudioContext());
    expect(result.contextGeneration).toBe(1);
    expect(engine.isInitialized).toBe(true);
  });

  it('rejects a resolved resume when the browser remains interrupted', async () => {
    const context = new FakeAudioContext('interrupted');
    context.resume.mockResolvedValue(undefined);
    const engine = new AudioEngine(() => context.asAudioContext());

    await expect(engine.ensureContext()).rejects.toThrow(
      'audio context did not enter running state (interrupted)',
    );
    await expect(engine.ensureContext()).rejects.toThrow(
      'audio context did not enter running state (interrupted)',
    );
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it('keeps a suspended context retryable after resume rejects', async () => {
    const context = new FakeAudioContext('suspended');
    context.resume
      .mockRejectedValueOnce(new Error('output permission denied'))
      .mockImplementationOnce(async () => {
        context.state = 'running';
      });
    const engine = new AudioEngine(() => context.asAudioContext());

    await expect(engine.ensureContext()).rejects.toThrow('output permission denied');
    expect(engine.isInitialized).toBe(true);

    await expect(engine.ensureContext()).resolves.toMatchObject({
      context: context.asAudioContext(),
    });
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it('keeps state subscriptions across replacement contexts and supports unsubscribe', async () => {
    const firstContext = new FakeAudioContext();
    const secondContext = new FakeAudioContext();
    const factory = vi
      .fn<() => AudioContext>()
      .mockReturnValueOnce(firstContext.asAudioContext())
      .mockReturnValueOnce(secondContext.asAudioContext());
    const engine = new AudioEngine(factory);
    const states: string[] = [];
    const unsubscribe = engine.subscribeStateChange((state) => states.push(state));

    const first = await engine.ensureContext();
    firstContext.transitionTo('interrupted');
    firstContext.transitionTo('closed');
    const second = await engine.ensureContext();
    secondContext.transitionTo('suspended');

    expect(factory).toHaveBeenCalledTimes(2);
    expect(firstContext.removeEventListener).toHaveBeenCalledWith(
      'statechange',
      expect.any(Function),
    );
    expect(states).toEqual(['interrupted', 'closed', 'suspended']);
    expect(first.contextGeneration).toBe(1);
    expect(second.contextGeneration).toBe(2);
    expect(engine.contextGeneration).toBe(2);

    unsubscribe();
    secondContext.transitionTo('running');
    expect(states).toEqual(['interrupted', 'closed', 'suspended']);
  });

  it('disconnects the committed master graph before closing the context', async () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(() => context.asAudioContext());
    await engine.ensureContext();

    await engine.dispose();

    expect(context.gain.disconnect).toHaveBeenCalledTimes(1);
    expect(context.limiter.disconnect).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(engine.isInitialized).toBe(false);
  });
});
