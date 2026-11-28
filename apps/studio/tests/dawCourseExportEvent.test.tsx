// @vitest-environment jsdom
// WAV 書き出しのイベントは、保存まで成功した時だけ、使った形式つきで 1 回出る(移植 P60)。
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@cts/tutorial-engine';
import { installLocalStorage } from './localStorageStub';
import { subscribeAppEvents } from '../src/state/appEvents';

const mocks = vi.hoisted(() => ({
  render: vi.fn(async () => ({ lease: true })),
  save: vi.fn(async () => ({ status: 'saved' }) as { status: string }),
}));

vi.mock('../src/audio/wav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/wav')>()),
  renderProjectToWav: mocks.render,
}));
vi.mock('../src/features/export/wavExport', () => ({ saveWavRenderLease: mocks.save }));

let useStore: typeof import('../src/state/store')['useStore'];
let ExportMenuContent: typeof import('../src/features/export/ExportMenuContent')['ExportMenuContent'];

// jsdom has no Web Locks; give the repository a serial in-process lock.
function installSerialLocks(): void {
  let tail: Promise<unknown> = Promise.resolve();
  const locks = {
    request<T>(_name: string, _options: unknown, callback: () => Promise<T> | T): Promise<T> {
      const run = tail.then(() => callback());
      tail = run.catch(() => undefined);
      return run;
    },
  };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

beforeAll(async () => {
  installSerialLocks();
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ ExportMenuContent } = await import('../src/features/export/ExportMenuContent'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
  expect(await useStore.getState().createNewProject('書き出し')).toBe(true);
  mocks.render.mockClear();
  mocks.save.mockClear();
  mocks.save.mockResolvedValue({ status: 'saved' });
});

afterEach(() => cleanup());

async function exportWithBitDepth24(): Promise<AppEvent[]> {
  const user = userEvent.setup();
  const seen: AppEvent[] = [];
  const unsubscribe = subscribeAppEvents((event) => seen.push(event));
  try {
    render(
      <ExportMenuContent
        onDone={() => undefined}
        activeOperation={null}
        beginOperation={() => true}
        finishOperation={() => undefined}
      />,
    );
    await user.selectOptions(screen.getByLabelText('ビット数'), '24');
    await user.click(screen.getByRole('button', { name: 'WAVエクスポート' }));
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    unsubscribe();
  }
  return seen.filter((event) => event.type === 'export.wav');
}

describe('export.wav event', () => {
  it('fires once with the sample rate and bit depth that were rendered', async () => {
    const events = await exportWithBitDepth24();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ format: 'wav', sampleRate: 44100, bitDepth: 24 });
    expect(mocks.render).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bitDepth: 24 }));
  });

  it('does not fire when saving is cancelled', async () => {
    mocks.save.mockResolvedValue({ status: 'cancelled' });
    expect(await exportWithBitDepth24()).toHaveLength(0);
  });
});
