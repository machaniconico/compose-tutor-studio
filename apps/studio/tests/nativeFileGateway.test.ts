import { describe, expect, it, vi } from 'vitest';
import headerCases from '../../../packages/project-bundle/fixtures/header-v1-cases.json';
import {
  NATIVE_FILE_COMMANDS,
  NATIVE_AUDIO_FILE_MAX_BYTES,
  NATIVE_MIDI_FILE_MAX_BYTES,
  NATIVE_PROJECT_FILE_MAX_BYTES,
  NATIVE_PROJECT_BUNDLE_MANIFEST_MAX_BYTES,
  NATIVE_PROJECT_BUNDLE_RESERVATION_BYTES,
  NATIVE_PROJECT_BUNDLE_MAX_BYTES,
  MAX_SUGGESTED_FILENAME_UTF8_BYTES,
  NativeFileGateway,
  NativeFileGatewayError,
  SUGGESTED_FILENAME_HEADER,
  decodeNativeProjectBundleOpenEnvelope,
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

function mp3Bytes(): Uint8Array {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x00]);
  return bytes;
}

function bundleBytes(): Uint8Array {
  const project = encoder.encode('{}');
  const manifest = encoder.encode(JSON.stringify({
    format: 'ctsbundle',
    version: 1,
    project: { byteLength: project.byteLength, checksumSha256: '0'.repeat(64) },
    assets: [],
  }));
  const bytes = new Uint8Array(32 + manifest.byteLength + project.byteLength);
  bytes.set(encoder.encode('CTSBNDL1'));
  const header = new DataView(bytes.buffer);
  header.setUint16(8, 1, true);
  header.setUint32(12, manifest.byteLength, true);
  header.setUint32(16, project.byteLength, true);
  header.setUint32(24, bytes.byteLength, true);
  bytes.set(manifest, 32);
  bytes.set(project, 32 + manifest.byteLength);
  return bytes;
}

function bundleWithDeclaredManifestLength(manifestLength: number): Uint8Array {
  const bytes = new Uint8Array(32 + manifestLength);
  bytes.set(encoder.encode('CTSBNDL1'));
  const header = new DataView(bytes.buffer);
  header.setUint16(8, 1, true);
  header.setUint32(12, manifestLength, true);
  header.setUint32(24, bytes.byteLength, true);
  return bytes;
}

function portableReservation(released = false) {
  return {
    bytes: released ? 0 : NATIVE_PROJECT_BUNDLE_RESERVATION_BYTES,
    released,
    resize: vi.fn(),
    release: vi.fn(),
  };
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

  it('opens bounded source audio with matching filename and container magic', async () => {
    const bytes = mp3Bytes();
    const envelope = openedEnvelope('reference.mp3', bytes);
    const invoke: NativeRawInvoke = vi.fn(async () => envelope);
    const gateway = new NativeFileGateway(invoke);

    await expect(gateway.openAudio()).resolves.toEqual({
      status: 'opened',
      fileName: 'reference.mp3',
      bytes,
      descriptor: {
        format: 'mp3',
        mimeType: 'audio/mpeg',
        sampleRate: 44_100,
        channelCount: 2,
        decodeChannelCountUpperBound: 2,
        containerDurationSeconds: 0.026123,
        decodeDurationSeconds: 0.026123,
      },
    });
    expect(invoke).toHaveBeenCalledWith(NATIVE_FILE_COMMANDS.openAudio);
    expect(NATIVE_AUDIO_FILE_MAX_BYTES).toBe(128 * 1024 * 1024);
  });

  it('rejects source-audio extension and magic mismatches at the renderer boundary', () => {
    expect(() =>
      decodeNativeOpenEnvelope(openedEnvelope('reference.wav', mp3Bytes()), 'audio'),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));
    expect(() =>
      decodeNativeOpenEnvelope(openedEnvelope('reference.flac', mp3Bytes()), 'audio'),
    ).toThrowError(expect.objectContaining({ code: 'invalid-filename' }));
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

    const unsupportedVersion: NativeRawInvoke = vi.fn(async () => {
      throw { code: 'unsupported-version' };
    });
    await expect(
      new NativeFileGateway(unsupportedVersion).openProjectBundle(portableReservation()),
    ).rejects.toMatchObject({ code: 'unsupported-version' });

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

  it('requires a live portable reservation before bundle open or export IPC', async () => {
    const invoke: NativeRawInvoke = vi.fn(async () => ({ status: 'saved' }));
    const gateway = new NativeFileGateway(invoke);
    const missing = undefined as never;

    await expect(gateway.openProjectBundle(missing)).rejects.toMatchObject({
      code: 'invalid-request',
    });
    await expect(
      gateway.exportProjectBundle(bundleBytes(), 'song.ctsbundle', portableReservation(true)),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses dedicated binary bundle commands only while the same lease is live', async () => {
    const bundle = bundleBytes();
    const envelope = openedEnvelope('song.ctsbundle', bundle);
    const invoke: NativeRawInvoke = vi.fn()
      .mockResolvedValueOnce(envelope)
      .mockResolvedValueOnce({ status: 'saved' })
      .mockResolvedValueOnce({ status: 'cancelled' });
    const gateway = new NativeFileGateway(invoke);
    const reservation = portableReservation();

    const opened = await gateway.openProjectBundle(reservation);
    expect(opened).toMatchObject({ status: 'opened', fileName: 'song.ctsbundle' });
    if (opened.status === 'opened') expect(opened.bytes.buffer).toBe(envelope);
    expect(invoke).toHaveBeenNthCalledWith(1, NATIVE_FILE_COMMANDS.openProjectBundle);

    await expect(
      gateway.exportProjectBundle(bundle, 'song.ctsbundle', reservation),
    ).resolves.toEqual({ status: 'saved' });
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      NATIVE_FILE_COMMANDS.exportProjectBundle,
      bundle,
      { headers: { [SUGGESTED_FILENAME_HEADER]: 'song.ctsbundle' } },
    );
    await expect(
      gateway.exportProjectBundle(bundle, 'song.ctsbundle', reservation),
    ).resolves.toEqual({ status: 'cancelled' });
  });

  it('accepts only exact bundle cancellation/open envelopes and binary responses', () => {
    expect(decodeNativeProjectBundleOpenEnvelope(Uint8Array.of(0).buffer)).toEqual({
      status: 'cancelled',
    });
    for (const invalid of [
      Uint8Array.of(),
      Uint8Array.of(0, 0),
      Uint8Array.of(2),
      Uint8Array.of(1, 0, 0, 0),
    ]) {
      expect(() => decodeNativeProjectBundleOpenEnvelope(invalid.buffer)).toThrowError(
        expect.objectContaining({ code: 'invalid-envelope' }),
      );
    }
    expect(() => decodeNativeProjectBundleOpenEnvelope([0])).toThrowError(
      expect.objectContaining({ code: 'invalid-envelope' }),
    );

    const invalidLength = new Uint8Array(openedEnvelope('song.ctsbundle', bundleBytes()));
    new DataView(invalidLength.buffer).setUint32(1, 1_025, true);
    expect(() => decodeNativeProjectBundleOpenEnvelope(invalidLength)).toThrowError(
      expect.objectContaining({ code: 'invalid-envelope' }),
    );
    expect(() =>
      decodeNativeProjectBundleOpenEnvelope(openedEnvelope('song.json', bundleBytes())),
    ).toThrowError(expect.objectContaining({ code: 'invalid-filename' }));
    expect(() =>
      decodeNativeProjectBundleOpenEnvelope(
        new ArrayBuffer(NATIVE_PROJECT_BUNDLE_MAX_BYTES + 1_030),
      ),
    ).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
  });

  it('validates bundle magic, version, flags, reserved, and exact total before invoke', async () => {
    const invoke: NativeRawInvoke = vi.fn(async () => ({ status: 'saved' }));
    const gateway = new NativeFileGateway(invoke);
    const reservation = portableReservation();
    const invalidMutations: Array<(bytes: Uint8Array) => void> = [
      (bytes) => { bytes[0] = 0; },
      (bytes) => { new DataView(bytes.buffer).setUint16(10, 1, true); },
      (bytes) => { new DataView(bytes.buffer).setUint32(24, bytes.byteLength - 1, true); },
      (bytes) => { new DataView(bytes.buffer).setUint32(28, 1, true); },
    ];
    for (const mutate of invalidMutations) {
      const bytes = bundleBytes();
      mutate(bytes);
      await expect(
        gateway.exportProjectBundle(bytes, 'song.ctsbundle', reservation),
      ).rejects.toMatchObject({ code: 'invalid-file' });
    }

    const unsupported = bundleBytes();
    new DataView(unsupported.buffer).setUint16(8, 2, true);
    await expect(
      gateway.exportProjectBundle(unsupported, 'song.ctsbundle', reservation),
    ).rejects.toMatchObject({ code: 'unsupported-version' });

    const oversizedManifest = bundleWithDeclaredManifestLength(
      NATIVE_PROJECT_BUNDLE_MANIFEST_MAX_BYTES + 1,
    );
    await expect(
      gateway.exportProjectBundle(oversizedManifest, 'song.ctsbundle', reservation),
    ).rejects.toMatchObject({ code: 'file-too-large' });

    const oversizedProject = bundleBytes();
    new DataView(oversizedProject.buffer).setUint32(
      16,
      NATIVE_PROJECT_FILE_MAX_BYTES + 1,
      true,
    );
    await expect(
      gateway.exportProjectBundle(oversizedProject, 'song.ctsbundle', reservation),
    ).rejects.toMatchObject({ code: 'file-too-large' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(headerCases)(
    'rejects the shared portable header fixture $name',
    async ({ offset, kind, value, code }) => {
      const bytes = bundleBytes();
      const header = new DataView(bytes.buffer);
      if (kind === 'uint16') header.setUint16(offset, value, true);
      else header.setUint32(offset, value, true);
      const invoke: NativeRawInvoke = vi.fn(async () => ({ status: 'saved' }));
      await expect(
        new NativeFileGateway(invoke).exportProjectBundle(
          bytes,
          'song.ctsbundle',
          portableReservation(),
        ),
      ).rejects.toMatchObject({
        code: code === 'unsupported-version' ? 'unsupported-version' : 'invalid-file',
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});
