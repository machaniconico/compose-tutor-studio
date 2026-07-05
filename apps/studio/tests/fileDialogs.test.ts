import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canUseNativeFileDialogs,
  openBinaryFileFromDialog,
  openTextFileFromDialog,
  saveBlob,
  withDefaultExtension,
} from '../src/platform/fileDialogs';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop file dialog helpers', () => {
  it('adds the first filter extension when a desktop save path has none', () => {
    expect(withDefaultExtension('C:\\Users\\me\\song', [{ name: 'MIDI', extensions: ['mid', 'midi'] }])).toBe(
      'C:\\Users\\me\\song.mid',
    );
  });

  it('keeps an explicit save extension unchanged', () => {
    expect(withDefaultExtension('C:\\Users\\me\\song.midi', [{ name: 'MIDI', extensions: ['mid', 'midi'] }])).toBe(
      'C:\\Users\\me\\song.midi',
    );
  });

  it('normalizes a trailing dot before adding the default extension', () => {
    expect(withDefaultExtension('C:\\Users\\me\\song.', [{ name: 'WAV audio', extensions: ['wav'] }])).toBe(
      'C:\\Users\\me\\song.wav',
    );
  });

  it('reports native dialogs as unavailable outside Tauri', () => {
    expect(canUseNativeFileDialogs()).toBe(false);
  });

  it('does not try to open native files outside Tauri', async () => {
    const filters = [{ name: 'Project', extensions: ['json'] }];

    await expect(openTextFileFromDialog(filters)).resolves.toBeNull();
    await expect(openBinaryFileFromDialog(filters)).resolves.toBeNull();
  });

  it('falls back to a browser download outside Tauri', async () => {
    vi.useFakeTimers();
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
    };
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const objectUrl = 'blob:cts-export';

    vi.stubGlobal('document', {
      body: { appendChild, removeChild },
      createElement: vi.fn(() => anchor),
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(objectUrl);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const result = await saveBlob(
      new Blob(['project']),
      'song.ctsproj.json',
      [{ name: 'Project', extensions: ['json'] }],
    );

    expect(result).toBe('downloaded');
    expect(anchor.href).toBe(objectUrl);
    expect(anchor.download).toBe('song.ctsproj.json');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(removeChild).toHaveBeenCalledWith(anchor);

    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith(objectUrl);
  });
});
