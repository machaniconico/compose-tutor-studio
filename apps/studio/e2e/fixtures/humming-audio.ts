const SAMPLE_RATE = 44_100;

export function createTwoNoteHummingFixture(): Buffer {
  const firstFrames = Math.round(SAMPLE_RATE * 0.55);
  const silenceFrames = Math.round(SAMPLE_RATE * 0.1);
  const secondFrames = Math.round(SAMPLE_RATE * 0.55);
  const frames = firstFrames + silenceFrames + secondFrames;
  const dataBytes = frames * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const frequency =
      frame < firstFrames
        ? 440
        : frame >= firstFrames + silenceFrames
          ? 523.251
          : 0;
    const sample =
      frequency === 0
        ? 0
        : 0.55 * Math.sin((2 * Math.PI * frequency * frame) / SAMPLE_RATE);
    bytes.writeInt16LE(Math.round(sample * 0x7fff), 44 + frame * 2);
  }
  return bytes;
}
