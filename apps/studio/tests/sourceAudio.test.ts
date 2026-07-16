import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SOURCE_AUDIO_FILE_BYTES,
  MAX_SOURCE_AUDIO_STRUCTURE_ITEMS,
  SourceAudioFileError,
  inspectSourceAudioBlob,
  inspectSourceAudioFile,
  sourceAudioStem,
} from '../src/audio/sourceAudio';

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function validWav(): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode('RIFF'), 0);
  view.setUint32(4, 40, true);
  bytes.set(encoder.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44_100, true);
  view.setUint32(28, 176_400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  bytes.set(encoder.encode('data'), 36);
  view.setUint32(40, 4, true);
  return bytes;
}

function validMp3(withId3 = false): Uint8Array {
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz => 417-byte frame.
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  if (!withId3) return frame;
  const id3 = new Uint8Array(10);
  id3.set(encoder.encode('ID3'), 0);
  id3[3] = 4;
  return concat(id3, frame);
}

function validMp3At48Khz(): Uint8Array {
  // MPEG-1 Layer III, 128 kbps, 48 kHz => 384-byte frame.
  const frame = new Uint8Array(384);
  frame.set([0xff, 0xfb, 0x94, 0x00]);
  return frame;
}

function validMp3At32Khz32Kbps(): Uint8Array {
  const frame = new Uint8Array(144);
  frame.set([0xff, 0xfb, 0x18, 0x00]);
  return frame;
}

function validMp3WithId3Footer(): Uint8Array {
  const header = new Uint8Array(10);
  header.set(encoder.encode('ID3'), 0);
  header.set([4, 0, 0x10], 3);
  const footer = header.slice();
  footer.set(encoder.encode('3DI'), 0);
  return concat(header, footer, validMp3());
}

function withApeV2(bytes: Uint8Array, withId3v1 = false): Uint8Array {
  const value = encoder.encode('-7.00 dB');
  const item = concat(
    new Uint8Array(8),
    encoder.encode('REPLAYGAIN_TRACK_GAIN'),
    new Uint8Array([0]),
    value,
  );
  new DataView(item.buffer).setUint32(0, value.byteLength, true);
  const footer = new Uint8Array(32);
  footer.set(encoder.encode('APETAGEX'), 0);
  const footerView = new DataView(footer.buffer);
  footerView.setUint32(8, 2_000, true);
  footerView.setUint32(12, item.byteLength + footer.byteLength, true);
  footerView.setUint32(16, 1, true);
  const id3v1 = new Uint8Array(128);
  id3v1.set(encoder.encode('TAG'), 0);
  return concat(bytes, item, footer, ...(withId3v1 ? [id3v1] : []));
}

function validAac(): Uint8Array {
  const frame = new Uint8Array(8);
  frame.set([0xff, 0xf1, 0x50, 0x80, 0x01, 0x00, 0x00]);
  return frame;
}

function isoBox(kind: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength, false);
  bytes.set(encoder.encode(kind), 4);
  bytes.set(payload, 8);
  return bytes;
}

function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  if (payload.byteLength >= 128) throw new Error('test descriptor is too large');
  return concat(new Uint8Array([tag, payload.byteLength]), payload);
}

function validM4a(options: {
  mediaTimescale?: number;
  mediaDuration?: number;
  timeToSampleCount?: number;
  timeToSampleDelta?: number;
  sampleSizeCount?: number;
  chunkSampleCount?: number;
  sampleEntryRate?: number;
  codecRateIndex?: number;
  includeWaveChild?: boolean;
  appleSampleBitDepth?: 'I8' | 'I16' | 'I24' | 'I32' | 'F32' | 'F64';
  selfContainedDataReference?: boolean;
} = {}): Uint8Array {
  const mediaTimescale = options.mediaTimescale ?? 44_100;
  const mediaDuration = options.mediaDuration ?? 1_024;
  const timeToSampleCount = options.timeToSampleCount ?? 1;
  const timeToSampleDelta = options.timeToSampleDelta ?? 1_024;
  const sampleSizeCount = options.sampleSizeCount ?? 1;
  const chunkSampleCount = options.chunkSampleCount ?? 1;
  const sampleEntryRate = options.sampleEntryRate ?? 44_100;
  const codecRateIndex = options.codecRateIndex ?? 4;
  const ftypPayload = new Uint8Array(8);
  ftypPayload.set(encoder.encode('M4A '), 0);
  const ftyp = isoBox('ftyp', ftypPayload);
  const mdat = isoBox('mdat', new Uint8Array(sampleSizeCount));

  const handlerPayload = new Uint8Array(24);
  handlerPayload.set(encoder.encode('soun'), 8);
  const mediaHeader = new Uint8Array(24);
  const mediaHeaderView = new DataView(mediaHeader.buffer);
  mediaHeaderView.setUint32(12, mediaTimescale, false);
  mediaHeaderView.setUint32(16, mediaDuration, false);

  const audioSpecificConfig = new Uint8Array([
    (2 << 3) | (codecRateIndex >>> 1),
    ((codecRateIndex & 1) << 7) | (2 << 3),
  ]);
  const decoderConfig = descriptor(
    0x04,
    concat(
      new Uint8Array([0x40, 0x15]),
      new Uint8Array(11),
      descriptor(0x05, audioSpecificConfig),
    ),
  );
  const esDescriptor = descriptor(
    0x03,
    concat(new Uint8Array([0, 1, 0]), decoderConfig, descriptor(0x06, new Uint8Array([2]))),
  );
  const esds = isoBox('esds', concat(new Uint8Array(4), esDescriptor));
  const audioSampleEntry = new Uint8Array(28);
  const audioSampleEntryView = new DataView(audioSampleEntry.buffer);
  audioSampleEntryView.setUint16(6, 1, false);
  audioSampleEntryView.setUint16(16, 2, false);
  audioSampleEntryView.setUint16(18, 16, false);
  audioSampleEntryView.setUint32(24, sampleEntryRate * 65_536, false);
  const mp4a = isoBox(
    'mp4a',
    concat(
      audioSampleEntry,
      esds,
      ...(options.appleSampleBitDepth
        ? [
            isoBox(
              'sbtd',
              concat(new Uint8Array(4), encoder.encode(options.appleSampleBitDepth)),
            ),
          ]
        : []),
      ...(options.includeWaveChild ? [isoBox('wave', esds)] : []),
    ),
  );
  const actualSampleDescription = new Uint8Array(8 + mp4a.byteLength);
  new DataView(actualSampleDescription.buffer).setUint32(4, 1, false);
  actualSampleDescription.set(mp4a, 8);

  const timeToSample = new Uint8Array(16);
  const timeToSampleView = new DataView(timeToSample.buffer);
  timeToSampleView.setUint32(4, 1, false);
  timeToSampleView.setUint32(8, timeToSampleCount, false);
  timeToSampleView.setUint32(12, timeToSampleDelta, false);
  const sampleSizes = new Uint8Array(12);
  const sampleSizesView = new DataView(sampleSizes.buffer);
  sampleSizesView.setUint32(4, 1, false);
  sampleSizesView.setUint32(8, sampleSizeCount, false);
  const sampleToChunk = new Uint8Array(20);
  const sampleToChunkView = new DataView(sampleToChunk.buffer);
  sampleToChunkView.setUint32(4, 1, false);
  sampleToChunkView.setUint32(8, 1, false);
  sampleToChunkView.setUint32(12, chunkSampleCount, false);
  sampleToChunkView.setUint32(16, 1, false);
  const chunkOffsets = new Uint8Array(12);
  const chunkOffsetsView = new DataView(chunkOffsets.buffer);
  chunkOffsetsView.setUint32(4, 1, false);
  chunkOffsetsView.setUint32(8, ftyp.byteLength + 8, false);
  const dataReferenceHeader = new Uint8Array(8);
  new DataView(dataReferenceHeader.buffer).setUint32(4, 1, false);
  const dataInformation = isoBox(
    'dinf',
    isoBox(
      'dref',
      concat(
        dataReferenceHeader,
        isoBox(
          'url ',
          new Uint8Array([0, 0, 0, options.selfContainedDataReference === false ? 0 : 1]),
        ),
      ),
    ),
  );

  const moov = isoBox(
    'moov',
    isoBox(
      'trak',
      isoBox(
        'mdia',
        concat(
          isoBox('mdhd', mediaHeader),
          isoBox('hdlr', handlerPayload),
          isoBox(
            'minf',
            concat(
              dataInformation,
              isoBox(
                'stbl',
                concat(
                  isoBox('stsd', actualSampleDescription),
                  isoBox('stts', timeToSample),
                  isoBox('stsz', sampleSizes),
                  isoBox('stsc', sampleToChunk),
                  isoBox('stco', chunkOffsets),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return concat(ftyp, mdat, moov);
}

describe('source audio validation', () => {
  it('accepts matching WAV, MP3, M4A and AAC container signatures', () => {
    const wav = validWav();
    expect(inspectSourceAudioFile('song.WAV', wav, wav.length)).toMatchObject({
      format: 'wav',
      channelCount: 2,
      containerDurationSeconds: 0.000023,
      decodeDurationSeconds: 0.000023,
    });
    expect(inspectSourceAudioFile('song.mp3', validMp3(), 417)).toMatchObject({
      format: 'mp3',
      channelCount: 2,
      containerDurationSeconds: 0.026123,
      decodeDurationSeconds: 0.026123,
    });
    expect(inspectSourceAudioFile('song.mp3', validMp3(true), 427).format).toBe('mp3');
    const footerMp3 = validMp3WithId3Footer();
    expect(inspectSourceAudioFile('song.mp3', footerMp3, footerMp3.length).format).toBe('mp3');
    const m4a = validM4a();
    expect(inspectSourceAudioFile('song.m4a', m4a, m4a.length)).toMatchObject({
      format: 'm4a',
      channelCount: 2,
      containerDurationSeconds: 0.02322,
      decodeDurationSeconds: 0.02322,
    });
    const aac = validAac();
    expect(inspectSourceAudioFile('song.aac', aac, aac.length)).toMatchObject({
      format: 'aac',
      channelCount: 2,
      containerDurationSeconds: 0.02322,
      decodeDurationSeconds: 0.02322,
    });
  });

  it('rejects extension/magic mismatches, paths, unsupported formats and size overflow', () => {
    const wav = validWav();
    for (const fileName of ['song.mp3', '../song.wav', 'song.flac']) {
      expect(() => inspectSourceAudioFile(fileName, wav, wav.length)).toThrowError(
        SourceAudioFileError,
      );
    }
    expect(() => inspectSourceAudioFile('song.wav', wav, 0)).toThrowError(
      expect.objectContaining({ code: 'invalid-file' }),
    );
    expect(() =>
      inspectSourceAudioFile('song.wav', wav, MAX_SOURCE_AUDIO_FILE_BYTES + 1),
    ).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
  });

  it('rejects an oversized browser Blob before materializing its bytes', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const blob = { size: MAX_SOURCE_AUDIO_FILE_BYTES + 1, arrayBuffer };
    await expect(inspectSourceAudioBlob('huge.wav', blob)).rejects.toMatchObject({
      code: 'file-too-large',
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects truncated prefixes that only resemble a supported container', () => {
    for (const [fileName, bytes] of [
      ['song.wav', concat(encoder.encode('RIFF'), new Uint8Array(4), encoder.encode('WAVE'))],
      ['song.mp3', new Uint8Array([0xff, 0xfb])],
      ['song.m4a', concat(new Uint8Array(4), encoder.encode('ftyp'))],
      ['song.aac', new Uint8Array([0xff, 0xf1])],
    ] as const) {
      expect(() => inspectSourceAudioFile(fileName, bytes, bytes.byteLength)).toThrowError(
        expect.objectContaining({ code: 'invalid-file' }),
      );
    }
  });

  it('rejects an ID3v2.4 footer flag without the matching footer', () => {
    const invalid = validMp3WithId3Footer();
    invalid[10] = 'X'.charCodeAt(0);
    expect(() => inspectSourceAudioFile('song.mp3', invalid, invalid.length)).toThrowError(
      expect.objectContaining({ code: 'invalid-file' }),
    );
  });

  it('accepts a bounded terminal APEv2 metadata tag and rejects malformed footers', () => {
    for (const tagged of [withApeV2(validMp3()), withApeV2(validMp3(), true)]) {
      expect(inspectSourceAudioFile('tagged.mp3', tagged, tagged.length)).toMatchObject({
        channelCount: 2,
        containerDurationSeconds: 0.026123,
      });
    }
    const malformed = withApeV2(validMp3());
    const footerStart = malformed.length - 32;
    new DataView(malformed.buffer).setUint32(footerStart + 12, malformed.length, true);
    expect(() =>
      inspectSourceAudioFile('malformed-tag.mp3', malformed, malformed.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));
  });

  it('rejects MP3 garbage tails, missing M4A channel metadata and pathological frame counts', () => {
    const tailedMp3 = concat(validMp3(), new Uint8Array([1, 2, 3]));
    expect(() =>
      inspectSourceAudioFile('song.mp3', tailedMp3, tailedMp3.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));

    const m4aWithoutSampleTable = validM4a();
    const stsd = encoder.encode('stsd');
    const stsdOffset = m4aWithoutSampleTable.findIndex((_, index) =>
      stsd.every((byte, inner) => m4aWithoutSampleTable[index + inner] === byte),
    );
    m4aWithoutSampleTable[stsdOffset] = 'x'.charCodeAt(0);
    expect(() =>
      inspectSourceAudioFile('song.m4a', m4aWithoutSampleTable, m4aWithoutSampleTable.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));

    const excessiveAac = new Uint8Array((MAX_SOURCE_AUDIO_STRUCTURE_ITEMS + 1) * 8);
    const frame = validAac();
    for (let offset = 0; offset < excessiveAac.length; offset += frame.length) {
      excessiveAac.set(frame, offset);
    }
    expect(() =>
      inspectSourceAudioFile('song.aac', excessiveAac, excessiveAac.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));
  });

  it('rejects header changes between otherwise complete MP3 and AAC frames', () => {
    const mixedMp3 = concat(validMp3(), validMp3At48Khz());
    expect(() =>
      inspectSourceAudioFile('mixed.mp3', mixedMp3, mixedMp3.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));

    const changedAac = validAac();
    changedAac[2] = 0x4c; // AAC-LC, 48 kHz, stereo instead of 44.1 kHz.
    const mixedAac = concat(validAac(), changedAac);
    expect(() =>
      inspectSourceAudioFile('mixed.aac', mixedAac, mixedAac.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));
  });

  it('derives MP3 allocation duration from the full frame walk, not an Info hint', () => {
    const first = validMp3();
    first.set(encoder.encode('Info'), 36);
    const firstView = new DataView(first.buffer);
    firstView.setUint32(40, 1, false); // Frames field is present.
    firstView.setUint32(44, 1, false); // Deliberately understates the three frames.
    const bytes = concat(first, validMp3(), validMp3());
    expect(inspectSourceAudioFile('hinted.mp3', bytes, bytes.length)).toMatchObject({
      channelCount: 2,
      containerDurationSeconds: 0.078368,
      decodeDurationSeconds: 0.078369,
    });
  });

  it('does not count an isolated MPEG-like payload header as a resync stream', () => {
    const bytes = validMp3();
    bytes.set(validMp3().subarray(0, 4), 100);
    expect(inspectSourceAudioFile('payload-header.mp3', bytes, bytes.length)).toMatchObject({
      containerDurationSeconds: 0.026123,
      decodeDurationSeconds: 0.026123,
    });
  });

  it('counts decoder resynchronization candidates hidden by forged AAC/MP3 lengths', () => {
    const aacFrames = Array.from({ length: 21 }, () => validAac());
    const forgedAac = concat(...aacFrames);
    forgedAac[4] = forgedAac.length >>> 3;
    forgedAac[5] = (forgedAac.length & 0x07) << 5;
    expect(
      inspectSourceAudioFile('resync.aac', forgedAac, forgedAac.length),
    ).toMatchObject({
      channelCount: 2,
      decodeChannelCountUpperBound: 2,
      containerDurationSeconds: 0.02322,
      decodeDurationSeconds: 0.48762,
    });

    const mp3Frames = Array.from({ length: 10 }, () => validMp3At32Khz32Kbps());
    const forgedMp3 = concat(...mp3Frames);
    forgedMp3[2] = 0xe8; // 320 kbps declares one 1,440-byte outer frame.
    expect(
      inspectSourceAudioFile('resync.mp3', forgedMp3, forgedMp3.length),
    ).toMatchObject({
      channelCount: 2,
      decodeChannelCountUpperBound: 2,
      containerDurationSeconds: 0.036,
      decodeDurationSeconds: 0.324,
    });

    const truncatedCandidate = concat(validAac(), validAac().slice(0, 7));
    truncatedCandidate[4] = truncatedCandidate.length >>> 3;
    truncatedCandidate[5] = (truncatedCandidate.length & 0x07) << 5;
    expect(
      inspectSourceAudioFile(
        'truncated-candidate.aac',
        truncatedCandidate,
        truncatedCandidate.length,
      ),
    ).toMatchObject({
      containerDurationSeconds: 0.02322,
      decodeDurationSeconds: 0.04644,
    });
  });

  it('rejects WAV fmt fields that understate decoded PCM allocation', () => {
    const forged = validWav();
    const view = new DataView(forged.buffer);
    view.setUint32(28, 44_100 * 4_000, true);
    view.setUint16(32, 4_000, true);
    expect(() =>
      inspectSourceAudioFile('forged.wav', forged, forged.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));

    const nonStandardDepth = validWav();
    new DataView(nonStandardDepth.buffer).setUint16(34, 40, true);
    expect(() =>
      inspectSourceAudioFile('non-standard.wav', nonStandardDepth, nonStandardDepth.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));

    const float64 = new Uint8Array(60);
    const float64View = new DataView(float64.buffer);
    float64.set(encoder.encode('RIFF'), 0);
    float64View.setUint32(4, 52, true);
    float64.set(encoder.encode('WAVEfmt '), 8);
    float64View.setUint32(16, 16, true);
    float64View.setUint16(20, 3, true);
    float64View.setUint16(22, 2, true);
    float64View.setUint32(24, 44_100, true);
    float64View.setUint32(28, 705_600, true);
    float64View.setUint16(32, 16, true);
    float64View.setUint16(34, 64, true);
    float64.set(encoder.encode('data'), 36);
    float64View.setUint32(40, 16, true);
    expect(() =>
      inspectSourceAudioFile('float64.wav', float64, float64.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));

    const wavl = concat(
      validWav(),
      encoder.encode('LIST'),
      new Uint8Array([4, 0, 0, 0]),
      encoder.encode('wavl'),
    );
    new DataView(wavl.buffer).setUint32(4, wavl.length - 8, true);
    expect(() =>
      inspectSourceAudioFile('wavl.wav', wavl, wavl.length),
    ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));
  });

  it('rejects M4A duration, sample-count, codec-rate and fragmentation forgeries', () => {
    for (const forged of [
      validM4a({ mediaDuration: 512 }),
      validM4a({ sampleSizeCount: 45, chunkSampleCount: 45 }),
      validM4a({ mediaTimescale: 441_000 }),
      validM4a({ mediaTimescale: 65_535, sampleEntryRate: 65_535 }),
      validM4a({ includeWaveChild: true }),
      validM4a({ selfContainedDataReference: false }),
      validM4a({
        mediaDuration: 45,
        timeToSampleCount: 45,
        timeToSampleDelta: 1,
        sampleSizeCount: 45,
        chunkSampleCount: 45,
      }),
      concat(validM4a(), isoBox('moof', new Uint8Array())),
    ]) {
      expect(() =>
        inspectSourceAudioFile('forged.m4a', forged, forged.length),
      ).toThrowError(expect.objectContaining({ code: 'invalid-file' }));
    }

    const shortFinalSample = validM4a({ mediaDuration: 1, timeToSampleDelta: 1 });
    expect(
      inspectSourceAudioFile('short-final.m4a', shortFinalSample, shortFinalSample.length),
    ).toMatchObject({ decodeDurationSeconds: 0.02322 });

    for (const appleSampleBitDepth of ['I8', 'I16', 'I24', 'I32', 'F32', 'F64'] as const) {
      const appleStyle = validM4a({ appleSampleBitDepth });
      expect(inspectSourceAudioFile('apple.m4a', appleStyle, appleStyle.length)).toMatchObject({
        channelCount: 2,
        decodeDurationSeconds: 0.02322,
      });
    }
    const highRate = validM4a({
      mediaTimescale: 96_000,
      sampleEntryRate: 48_000,
      codecRateIndex: 0,
    });
    expect(inspectSourceAudioFile('96k.m4a', highRate, highRate.length)).toMatchObject({
      containerDurationSeconds: 0.010667,
      decodeDurationSeconds: 0.010667,
    });
  });

  it('removes only a supported final extension when deriving an output stem', () => {
    expect(sourceAudioStem('demo.mix.MP3')).toBe('demo.mix');
    expect(sourceAudioStem('demo')).toBe('demo');
  });
});
