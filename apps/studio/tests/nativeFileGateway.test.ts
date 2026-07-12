import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_FILE_COMMANDS,
  NATIVE_MIDI_FILE_MAX_BYTES,
  MAX_SUGGESTED_FILENAME_UTF8_BYTES,
  NativeFileGateway,
  NativeFileGatewayError,
  SUGGESTED_FILENAME_HEADER,
  decodeNativeOpenEnvelope,
  type NativeRawInvoke,
} from '../src/platform/nativeFileGateway';

const encoder = new TextEncoder();

function openedEnvelope(fileName: string, bytes: Uint8Array): ArrayBuffer {
  const name = encoder.encode(fileName);
  const envelope = new Uint8Array(5 + name.byteLength + bytes.byteLength);
  envelope[0] = 1;
  new DataView(envelope.buffer).setUint32(1, name.byteLength, true);
  envelope.set(name, 5);
  envelope.set(bytes, 5 + name.byteLength);
  return envelope.buffer;
}

function midiBytes(size = 14): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(encoder.encode('MThd'), 0);
  if (size >= 14) {
    new DataView(bytes.buffer).setUint32(4, 6, false);
    new DataView(bytes.buffer).setUint16(10, 1, false);
    new DataView(bytes.buffer).setUint16(12, 480, false);
  }
  return bytes;
}

function wavBytes(): Uint8Array {
  const bytes = new Uint8Array(44);
  bytes.set(encoder.encode('RIFF'), 0);
  bytes.set(encoder.encode('WAVE'), 8);
  return bytes;
}

describe('NativeFileGateway', () => {
  it('decodes the bounded filename/data envelope without copying its payload', async () => {
    const original = encoder.encode('{"schemaVersion":1}');
    const envelope = openedEnvelope('曲.ctsproj.json', original);
    const invoke: NativeRawInvoke = vi.fn(async () => envelope);
    const gateway = new NativeFileGateway(invoke);

    const result = await gateway.openProject();

    expect(result).toEqual({
      status: 'opened',
      fileName: '曲.ctsproj.json',
      bytes: original,
    });
    expect(invoke).toHaveBeenCalledWith(NATIVE_FILE_COMMANDS.openProject);
    if (result.status === 'opened') expect(result.bytes.buffer).toBe(envelope);
  });

  it('treats only the exact cancellation envelope as a silent cancellation', async () => {
    const invoke: NativeRawInvoke = vi.fn(async () => new Uint8Array([0]).buffer);
    await expect(new NativeFileGateway(invoke).openMidi()).resolves.toEqual({
      status: 'cancelled',
    });

    expect(() =>
      decodeNativeOpenEnvelope(new Uint8Array([0, 0]).buffer, 'midi'),
    ).toThrowError(NativeFileGatewayError);
  });

  it('normalizes Tauri fallback arrays and typed views while keeping strict bytes', () => {
    const envelope = new Uint8Array(openedEnvelope('song.mid', midiBytes()));
    expect(decodeNativeOpenEnvelope([...envelope], 'midi')).toMatchObject({
      status: 'opened',
      fileName: 'song.mid',
    });
    expect(decodeNativeOpenEnvelope(envelope.subarray(0), 'midi')).toMatchObject({
      status: 'opened',
      fileName: 'song.mid',
    });
    const invalid = [...envelope];
    invalid[0] = 256;
    expect(() => decodeNativeOpenEnvelope(invalid, 'midi')).toThrowError(
      expect.objectContaining({ code: 'invalid-envelope' }),
    );
  });

  it('rejects malformed envelopes, paths, invalid UTF-8, magic, and oversize files', () => {
    expect(() => decodeNativeOpenEnvelope(new Uint8Array([2]).buffer, 'project')).toThrowError(
      expect.objectContaining({ code: 'invalid-envelope' }),
    );
    expect(() =>
      decodeNativeOpenEnvelope(openedEnvelope('../song.mid', midiBytes()), 'midi'),
    ).toThrowError(expect.objectContaining({ code: 'invalid-filename' }));

    const invalidName = new Uint8Array(5 + 2 + 14);
    invalidName[0] = 1;
    new DataView(invalidName.buffer).setUint32(1, 2, true);
    invalidName.set([0xc0, 0xaf], 5);
    invalidName.set(midiBytes(), 7);
    expect(() => decodeNativeOpenEnvelope(invalidName.buffer, 'midi')).toThrowError(
      expect.objectContaining({ code: 'invalid-filename' }),
    );

    expect(() =>
      decodeNativeOpenEnvelope(openedEnvelope('song.mid', encoder.encode('not midi')), 'midi'),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));

    const oversized = midiBytes(NATIVE_MIDI_FILE_MAX_BYTES + 1);
    expect(() =>
      decodeNativeOpenEnvelope(openedEnvelope('song.mid', oversized), 'midi'),
    ).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
  });

  it('sends the raw payload with the agreed encoded filename header', async () => {
    const invoke: NativeRawInvoke = vi.fn(async () => ({ status: 'saved' }));
    const gateway = new NativeFileGateway(invoke);
    const bytes = midiBytes();

    await expect(gateway.exportMidi(bytes, '曲 名.mid')).resolves.toEqual({ status: 'saved' });
    const payload = (invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Uint8Array;
    expect(payload).toEqual(bytes);
    expect(payload).toBe(bytes);
    expect(invoke).toHaveBeenCalledWith(
      NATIVE_FILE_COMMANDS.exportMidi,
      expect.any(Uint8Array),
      {
        headers: {
          [SUGGESTED_FILENAME_HEADER]: encodeURIComponent('曲 名.mid'),
        },
      },
    );
  });

  it('bounds suggested names by UTF-8 bytes and preserves the complete suffix', async () => {
    const invoke: NativeRawInvoke = vi.fn(async () => ({ status: 'saved' }));
    const gateway = new NativeFileGateway(invoke);
    await gateway.exportProject(
      encoder.encode('{"schemaVersion":1}'),
      `${'長'.repeat(1_000)}.ctsproj.json`,
    );
    const header = (invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]?.headers?.[
      SUGGESTED_FILENAME_HEADER
    ] as string;
    const decoded = decodeURIComponent(header);
    expect(decoded).toMatch(/\.ctsproj\.json$/);
    expect(encoder.encode(decoded).byteLength).toBeLessThanOrEqual(
      MAX_SUGGESTED_FILENAME_UTF8_BYTES,
    );

    await gateway.exportMidi(midiBytes(), `song\ud800.mid`);
    const surrogateHeader = (invoke as ReturnType<typeof vi.fn>).mock.calls[1]?.[2]?.headers?.[
      SUGGESTED_FILENAME_HEADER
    ] as string;
    expect(decodeURIComponent(surrogateHeader)).toBe('song_.mid');
  });

  it('returns export cancellation and rejects non-exact native responses', async () => {
    const cancelled: NativeRawInvoke = vi.fn(async () => ({ status: 'cancelled' }));
    await expect(
      new NativeFileGateway(cancelled).exportWav(wavBytes(), 'song.wav'),
    ).resolves.toEqual({ status: 'cancelled' });

    const malformed: NativeRawInvoke = vi.fn(async () => ({
      status: 'saved',
      path: '/should/not/be/exposed',
    }));
    await expect(
      new NativeFileGateway(malformed).exportProject(
        encoder.encode('{"schemaVersion":1}'),
        'song.ctsproj.json',
      ),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('maps only exact native rejection DTOs and never forwards extra path details', async () => {
    const tooLarge: NativeRawInvoke = vi.fn(async () => {
      throw { code: 'file-too-large' };
    });
    await expect(new NativeFileGateway(tooLarge).openProject()).rejects.toMatchObject({
      code: 'file-too-large',
    });

    const writeFailed: NativeRawInvoke = vi.fn(async () => {
      throw { code: 'write-failed' };
    });
    await expect(
      new NativeFileGateway(writeFailed).exportMidi(midiBytes(), 'song.mid'),
    ).rejects.toMatchObject({ code: 'write-failed' });

    const leakedPath: NativeRawInvoke = vi.fn(async () => {
      throw { code: 'read-failed', path: '/private/song.mid' };
    });
    await expect(new NativeFileGateway(leakedPath).openMidi()).rejects.toMatchObject({
      code: 'invalid-response',
    });

    const unknown: NativeRawInvoke = vi.fn(async () => {
      throw new Error('unexpected native failure');
    });
    await expect(new NativeFileGateway(unknown).openMidi()).rejects.toMatchObject({
      code: 'invalid-response',
    });
  });

  it('validates export name, magic, and size before invoking native code', async () => {
    const invoke: NativeRawInvoke = vi.fn(async () => ({ status: 'saved' }));
    const gateway = new NativeFileGateway(invoke);

    await expect(gateway.exportMidi(midiBytes(), '../song.mid')).rejects.toMatchObject({
      code: 'invalid-filename',
    });
    await expect(
      gateway.exportProject(encoder.encode('[]'), 'song.ctsproj.json'),
    ).rejects.toMatchObject({ code: 'invalid-file' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
