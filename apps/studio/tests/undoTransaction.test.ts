import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';
import { createDefaultProject } from '../src/state/defaultProject';

// The store reads localStorage at import time, so install the stub first.
let useStore: typeof import('../src/state/store')['useStore'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
});

beforeEach(() => {
  useStore.getState().replaceProject(createDefaultProject('トランザクション'));
});

describe('undo transactions', () => {
  it('turns 50 commits into a single undo step', () => {
    const store = useStore.getState();
    const before = store.project;

    store.beginTransaction();
    for (let i = 0; i < 50; i += 1) store.setBpm(100 + i);
    expect(useStore.getState().project.bpm).toBe(149);
    expect(useStore.getState().past).toHaveLength(0);
    store.commitTransaction();

    expect(useStore.getState().past).toEqual([before]);
    store.undo();
    expect(useStore.getState().project).toBe(before);
  });

  it('adds only one past entry for 150 commits, keeping earlier history', () => {
    const store = useStore.getState();
    for (let i = 0; i < 99; i += 1) store.setBpm(60 + i);
    const beforeTransaction = useStore.getState().project;
    expect(useStore.getState().past).toHaveLength(99);

    store.beginTransaction();
    for (let i = 0; i < 150; i += 1) store.setBpm(200 + (i % 50));
    store.commitTransaction();

    const { past } = useStore.getState();
    expect(past).toHaveLength(100);
    expect(past[99]).toBe(beforeTransaction);
    expect(past[98]?.bpm).toBe(157);
  });

  it('cancelTransaction restores the state from before the transaction', () => {
    const store = useStore.getState();
    store.setBpm(90);
    store.undo();
    const before = useStore.getState().project;
    const { past, future } = useStore.getState();

    store.beginTransaction();
    store.setBpm(140);
    store.setTitle('途中');
    store.cancelTransaction();

    const after = useStore.getState();
    expect(after.project).toBe(before);
    expect(after.past).toEqual(past);
    expect(after.future).toEqual(future);
    expect(after.transactionBase).toBeNull();
  });

  it('undo during a transaction restores the start state and then undoes one more step', () => {
    const store = useStore.getState();
    const first = store.project;
    store.setBpm(90);
    const second = useStore.getState().project;

    store.beginTransaction();
    store.setBpm(140);
    store.undo();

    const after = useStore.getState();
    expect(after.project).toBe(first);
    expect(after.past).toHaveLength(0);
    expect(after.future[0]).toBe(second);
    expect(after.transactionBase).toBeNull();
  });

  it('undo during a transaction with no history only restores the start state', () => {
    const store = useStore.getState();
    const before = store.project;

    store.beginTransaction();
    store.setBpm(140);
    store.undo();

    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().transactionBase).toBeNull();
  });

  it('redo during a transaction also abandons it first', () => {
    const store = useStore.getState();
    store.setBpm(90);
    const edited = useStore.getState().project;
    store.undo();

    store.beginTransaction();
    store.setBpm(140);
    store.redo();

    expect(useStore.getState().project).toBe(edited);
    expect(useStore.getState().transactionBase).toBeNull();
  });

  it('keeps the outer start state when begin is called again', () => {
    const store = useStore.getState();
    const before = store.project;

    store.beginTransaction();
    store.setBpm(140);
    store.beginTransaction();
    store.setBpm(141);
    store.commitTransaction();

    expect(useStore.getState().past).toEqual([before]);
  });

  it('adds no undo step when nothing actually changed', () => {
    const store = useStore.getState();
    const before = store.project;
    store.setBpm(90);
    store.undo();

    store.beginTransaction();
    store.commitTransaction();
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().future).toHaveLength(1);

    store.beginTransaction();
    store.setBpm(140);
    store.setBpm(before.bpm);
    store.commitTransaction();
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().future).toHaveLength(1);
    expect(useStore.getState().project).toBe(before);
  });

  it('commits outside a transaction keep pushing history one by one', () => {
    const store = useStore.getState();
    store.beginTransaction();
    store.setBpm(140);
    store.commitTransaction();
    store.setBpm(141);
    store.setBpm(142);
    expect(useStore.getState().past).toHaveLength(3);
  });

  it('commit and cancel without an open transaction do nothing', () => {
    const store = useStore.getState();
    const before = store.project;
    store.commitTransaction();
    store.cancelTransaction();
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('drops an open transaction when another project is loaded', () => {
    const store = useStore.getState();
    store.beginTransaction();
    store.setBpm(140);
    const replacement = createDefaultProject('別の曲');
    store.replaceProject(replacement);

    expect(useStore.getState().transactionBase).toBeNull();
    store.commitTransaction();
    expect(useStore.getState().project).toBe(replacement);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('an owner only closes the transaction it opened', () => {
    const before = useStore.getState().project.title;
    useStore.getState().beginTransaction('first');
    useStore.getState().setTitle('途中');

    useStore.getState().commitTransaction('other');
    useStore.getState().cancelTransaction('other');
    expect(useStore.getState().ownsTransaction('first')).toBe(true);
    expect(useStore.getState().ownsTransaction('other')).toBe(false);

    useStore.getState().cancelTransaction('first');
    expect(useStore.getState().project.title).toBe(before);
    expect(useStore.getState().ownsTransaction('first')).toBe(false);
  });

  it('a new owner commits the open transaction and starts its own', () => {
    useStore.getState().beginTransaction('first');
    useStore.getState().setTitle('途中');
    useStore.getState().beginTransaction('second');

    expect(useStore.getState().past).toHaveLength(1);
    expect(useStore.getState().ownsTransaction('second')).toBe(true);
  });

  it('reports undo as available while a transaction is open', () => {
    const store = useStore.getState();
    expect(store.canUndo()).toBe(false);
    store.beginTransaction();
    expect(store.canUndo()).toBe(true);
    store.cancelTransaction();
    expect(store.canUndo()).toBe(false);
  });
});
