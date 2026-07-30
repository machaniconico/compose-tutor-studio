const SAMPLE_RATE = 48_000;
const FIRST_NOTE_SECONDS = 2;
const SILENCE_SECONDS = 0.08;
const SECOND_NOTE_SECONDS = 2;

/**
 * Generates a deterministic, local-only voiced signal with several stable
 * resonance peaks. It is intentionally not a recording or bundled binary.
 */
function voicedFormantPcm(
  sampleRate: number,
  frequency: number,
  durationSeconds: number,
): Float32Array {
  const frameCount = Math.round(sampleRate * durationSeconds);
  const samples = new Float32Array(frameCount);
  const formants = [
    { centerHz: 700, bandwidthHz: 90, gain: 1.4 },
    { centerHz: 1_200, bandwidthHz: 120, gain: 1.1 },
    { centerHz: 2_450, bandwidthHz: 190, gain: 1.3 },
    { centerHz: 3_400, bandwidthHz: 260, gain: 0.8 },
  ];
  const edgeFrames = Math.round(sampleRate * 0.02);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / sampleRate;
    let sample = 0;
    for (let harmonic = 1; harmonic <= 32; harmonic += 1) {
      const harmonicHz = harmonic * frequency;
      if (harmonicHz >= sampleRate / 2) break;
      const resonance = formants.reduce((total, formant) => {
        const distance = (harmonicHz - formant.centerHz) / formant.bandwidthHz;
        return total + formant.gain * Math.exp(-0.5 * distance * distance);
      }, 0.18);
      sample += resonance * Math.sin(2 * Math.PI * harmonicHz * time) / harmonic;
    }
    const edge = Math.min(
      1,
      frame / edgeFrames,
      (frameCount - 1 - frame) / edgeFrames,
    );
    samples[frame] = Math.max(-0.92, Math.min(0.92, sample * edge * 0.32));
  }
  return samples;
}

/** Canonical local-only mono fixture with two separated, stable voiced notes. */
export function createAudioWarpPitchFixture(): Buffer {
  const first = voicedFormantPcm(SAMPLE_RATE, 110, FIRST_NOTE_SECONDS);
  const silenceFrames = Math.round(SAMPLE_RATE * SILENCE_SECONDS);
  const second = voicedFormantPcm(SAMPLE_RATE, 130.813, SECOND_NOTE_SECONDS);
  const frames = first.length + silenceFrames + second.length;
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
    const sample = frame < first.length
      ? first[frame]!
      : frame < first.length + silenceFrames
        ? 0
        : second[frame - first.length - silenceFrames]!;
    bytes.writeInt16LE(Math.round(sample * 0x7fff), 44 + frame * 2);
  }
  return bytes;
}
