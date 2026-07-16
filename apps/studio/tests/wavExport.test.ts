import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WavRenderLease } from '../src/audio/wav';
import {
  AudioResourceReservationError,
  MAX_HEAVY_AUDIO_RESOURCE_BYTES,
  getReservedHeavyAudioResourceBytes,
  reserveHeavyAudioResources,
} from '../src/audio/audioResourceReservation';
import { downloadBlobAndWaitForHandoff } from '../src/features/export/download';
import { saveWavRenderLease } from '../src/features/export/wavExport';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function leasedBlob(blob: Blob, bytes = 1_024): WavRenderLease {
  const reservation = reserveHeavyAudioResources(bytes);
  return {
    blob,
    get released() {
      return reservation.released;
    },
    release: () => reservation.release(),
  };
}

function expectCompetingReservationRejected(): void {
  const competingBytes =
    MAX_HEAVY_AUDIO_RESOURCE_BYTES - getReservedHeavyAudioResourceBytes() + 1;
  expect(() => reserveHeavyAudioResources(competingBytes)).toThrow(
    AudioResourceReservationError,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(getReservedHeavyAudioResourceBytes()).toBe(0);
});

describe('saveWavRenderLease', () => {
  it('holds the reservation through native Blob read and IPC settlement', async () => {
    const read = deferred<ArrayBuffer>();
    const ipc = deferred<Readonly<{ status: 'saved' }>>();
    const blob = {
      arrayBuffer: vi.fn(() => read.promise),
    } as unknown as Blob;
    const rendered = leasedBlob(blob);
    const exportNative = vi.fn(() => ipc.promise);

    try {
      const pending = saveWavRenderLease(rendered, 'song.wav', {
        runtime: 'native',
        exportNative,
        downloadWeb: vi.fn(),
      });

      expect(rendered.released).toBe(false);
      expectCompetingReservationRejected();
      read.resolve(Uint8Array.from([1, 2, 3, 4]).buffer);
      await vi.waitFor(() => expect(exportNative).toHaveBeenCalledOnce());
      expect(rendered.released).toBe(false);
      expectCompetingReservationRejected();

      ipc.resolve({ status: 'saved' });
      await expect(pending).resolves.toEqual({ status: 'saved' });
      expect(rendered.released).toBe(true);
    } finally {
      rendered.release();
    }
  });

  it('releases after a native picker cancellation', async () => {
    const rendered = leasedBlob(new Blob([Uint8Array.from([1, 2, 3, 4]).buffer]));

    try {
      await expect(saveWavRenderLease(rendered, 'song.wav', {
        runtime: 'native',
        exportNative: vi.fn(async () => ({ status: 'cancelled' as const })),
        downloadWeb: vi.fn(),
      })).resolves.toEqual({ status: 'cancelled' });
      expect(rendered.released).toBe(true);
    } finally {
      rendered.release();
    }
  });

  it('holds through browser object URL revocation, then releases', async () => {
    vi.useFakeTimers();
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
    };
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:rendered-wav'),
      revokeObjectURL,
    });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
    });
    const rendered = leasedBlob(new Blob([Uint8Array.from([1, 2, 3, 4]).buffer]));

    try {
      const pending = saveWavRenderLease(rendered, 'song.wav', {
        runtime: 'web',
        exportNative: vi.fn(),
        downloadWeb: downloadBlobAndWaitForHandoff,
      });
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(rendered.released).toBe(false);
      expectCompetingReservationRejected();

      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual({ status: 'download-started' });
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:rendered-wav');
      expect(rendered.released).toBe(true);
    } finally {
      rendered.release();
    }
  });

  it('releases when platform handoff fails', async () => {
    const rendered = leasedBlob(new Blob([Uint8Array.from([1, 2, 3, 4]).buffer]));
    const release = vi.spyOn(rendered, 'release');
    const failure = new Error('disk full');

    await expect(saveWavRenderLease(rendered, 'song.wav', {
      runtime: 'native',
      exportNative: vi.fn(async () => { throw failure; }),
      downloadWeb: vi.fn(),
    })).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
    expect(rendered.released).toBe(true);
  });

  it('releases exactly once when native Blob reading fails', async () => {
    const failure = new Error('blob read failed');
    const blob = {
      arrayBuffer: vi.fn(async () => { throw failure; }),
    } as unknown as Blob;
    const rendered = leasedBlob(blob);
    const release = vi.spyOn(rendered, 'release');

    await expect(saveWavRenderLease(rendered, 'song.wav', {
      runtime: 'native',
      exportNative: vi.fn(),
      downloadWeb: vi.fn(),
    })).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
    expect(rendered.released).toBe(true);
  });

  it('releases exactly once when browser object URL revocation fails', async () => {
    vi.useFakeTimers();
    const failure = new Error('object URL revoke failed');
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:rendered-wav-failure'),
      revokeObjectURL: vi.fn(() => { throw failure; }),
    });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({ href: '', download: '', click: vi.fn() })),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    });
    const rendered = leasedBlob(new Blob([Uint8Array.from([1, 2, 3, 4]).buffer]));
    const release = vi.spyOn(rendered, 'release');

    const pending = saveWavRenderLease(rendered, 'song.wav', {
      runtime: 'web',
      exportNative: vi.fn(),
      downloadWeb: downloadBlobAndWaitForHandoff,
    });
    const rejected = expect(pending).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await rejected;
    expect(release).toHaveBeenCalledOnce();
    expect(rendered.released).toBe(true);
  });
});
